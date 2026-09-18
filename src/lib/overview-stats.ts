import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isOnHold } from "@/components/ops";
import type { ReportingRange } from "@/lib/period-range";
import type { Database } from "@/integrations/supabase/types";

/** One row of each aggregate, taken from the generated types rather than
 *  restated — a column added to either function turns up here on `npm run
 *  types` instead of drifting quietly. */
export type OverviewTotalsRow =
  Database["public"]["Functions"]["submission_totals_range"]["Returns"][number];
export type CenterTotalsRow =
  Database["public"]["Functions"]["submission_totals_by_center_range"]["Returns"][number];

/**
 * Every figure both reporting dashboards are built out of, fetched once.
 *
 * Moved out of `ReportingStats` when the admin Overview became its own
 * component: the two screens draw the same numbers very differently, and the
 * one thing that must not differ is where the numbers come from. Query keys are
 * unchanged from when this lived in `reporting.tsx`, so the two share a single
 * cache entry and neither refetches what the other already has.
 *
 * Counts are aggregated server-side by the `_range` RPCs; the client never
 * recounts them.
 */

export const TOTALS_KEY = ["reporting", "totals"];
export const VALIDATOR_STATS_KEY = ["reporting", "validator-stats"];
export const CENTER_TOTALS_KEY = ["reporting", "center-totals"];
export const ON_HOLD_KEY = ["reporting", "on-hold"];

export function useOverviewStats({
  range,
  days,
  startKey,
  endKey,
  /**
   * Its own channel name per mount point: two Supabase subscriptions may not
   * share one name, and this hook can in principle be mounted from either
   * dashboard.
   */
  channel: channelName = "reporting-stats",
  /**
   * Off for any screen that does not draw the per-validator table.
   *
   * Not an optimisation. `validator_stats_range` returns every validator's
   * name, staff id and performance, and its `timed_out`/`rejected`/`holds`
   * columns are counted from `form_events`, which is NOT scoped the way
   * `submissions` is — so those three come back whole-business whatever the
   * caller's centre. Fetching it on a screen that never renders it would put
   * all of that in the reader's browser for nothing. The Closing Desk's
   * Overview is exactly that screen.
   *
   * This closes the app's own door, not the database's: the RPC is executable
   * by any authenticated caller today, so the underlying exposure is still
   * open to anyone who calls it directly. That is a server-side fix needing a
   * migration — see `docs/TODO.md`.
   */
  includeValidatorStats = true,
}: {
  range: ReportingRange;
  days: number | null;
  startKey: string | null;
  endKey: string | null;
  channel?: string;
  includeValidatorStats?: boolean;
}) {
  const queryClient = useQueryClient();

  const validatorStats = useQuery({
    queryKey: [...VALIDATOR_STATS_KEY, days, startKey, endKey],
    enabled: includeValidatorStats,
    queryFn: async () => {
      // Ordered again here as well as in the function body: PostgREST makes no
      // promise about preserving a function's own ORDER BY, and this table is
      // meant to read alphabetically however it was fetched.
      const { data, error } = await supabase
        .rpc("validator_stats_range", range)
        .order("validator_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  /**
   * The same volume, split by centre.
   *
   * One row per ACTIVE centre, including the ones with nothing on them yet —
   * the view left-joins from `centers`, so a centre that has taken no leads
   * reports zeroes rather than dropping out of the table. Nothing here names a
   * centre; adding one in Settings is all it takes to appear.
   *
   * `sort_order` is restated as an explicit order rather than trusted from the
   * view: PostgREST makes no promise about the order rows come back in without
   * one, and this table is meant to read in the same sequence as the Center
   * picker.
   */
  const centerTotals = useQuery({
    queryKey: [...CENTER_TOTALS_KEY, days, startKey, endKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .rpc("submission_totals_by_center_range", range)
        .order("sort_order", { ascending: true })
        .order("center_name", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const totals = useQuery({
    queryKey: [...TOTALS_KEY, days, startKey, endKey],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("submission_totals_range", range).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  /**
   * The two open stages `submission_totals` cannot publish, in one read.
   *
   * Being on hold is a SHAPE across four columns, and its last condition —
   * `last_held_at` newer than `assigned_at` — is a column-to-column comparison
   * PostgREST has no filter for. So the query narrows to the statuses it can
   * express and the shape is applied here, over the open rows only.
   *
   * Held leads sit in `assigned`, so the two are separated rather than summed:
   * a lead is counted once, in the stage it is actually in, and the flow strip
   * never adds up to more than the work that exists.
   *
   * `awaiting_manager` and `in_review` are NOT recomputed here — those the view
   * publishes, and they are read from it. The open rows are still fetched, but
   * only for the age of the oldest lead in each stage, which no view carries.
   *
   * Unkeyed by period, deliberately: this is where work is standing right now,
   * and scoping it to a past week would answer a question nobody asked.
   */
  const openQueue = useQuery({
    queryKey: ON_HOLD_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("status, created_at, claimed_at, assigned_at, last_held_at")
        .in("status", ["pending_manager", "assigned", "in_review", "returned_timeout"])
        .is("archived_at", null);
      if (error) throw error;
      const rows = data ?? [];
      const held = rows.filter((row) => row.status === "assigned" && isOnHold(row));

      /** The submission date of the oldest lead among these, or null. */
      const oldest = (of: typeof rows) =>
        of.reduce<string | null>(
          (first, row) => (!first || row.created_at < first ? row.created_at : first),
          null,
        );

      const byStatus = (status: string) => rows.filter((row) => row.status === status);
      const assigned = byStatus("assigned").filter((row) => !isOnHold(row));

      return {
        // COUNTS for the two stages the view publishes are not taken from here
        // — see the note above. These rows exist for the ages, and for the
        // three counts submission_totals cannot express.
        onHold: held.length,
        assigned: assigned.length,
        returned: byStatus("returned_timeout").length,
        oldest: {
          unassigned: oldest(byStatus("pending_manager")),
          assigned: oldest(assigned),
          inReview: oldest(byStatus("in_review")),
          onHold: oldest(held),
          returned: oldest(byStatus("returned_timeout")),
        },
      };
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, () => {
        queryClient.invalidateQueries({ queryKey: TOTALS_KEY });
        queryClient.invalidateQueries({ queryKey: VALIDATOR_STATS_KEY });
        queryClient.invalidateQueries({ queryKey: CENTER_TOTALS_KEY });
        queryClient.invalidateQueries({ queryKey: ON_HOLD_KEY });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient, channelName]);

  return { validatorStats, centerTotals, totals, openQueue };
}
