import { useMemo } from "react";
import { PeriodPicker } from "@/components/period-picker";
import { OverviewPanels } from "@/components/overview-panels";
import { useAuth } from "@/lib/auth";
import { usePeriod } from "@/lib/period-range";
import { useOverviewStats } from "@/lib/overview-stats";

/**
 * The same three panels the admin and the manager read, on the Closing Desk.
 *
 * **Nothing here decides what anybody may see.** The `_range` RPCs behind
 * `useOverviewStats` are SECURITY INVOKER over `submissions`, so each caller
 * gets their own slice from the one `submissions read scoped` policy: a general
 * manager every centre and both closer- and validator-originated leads, a
 * closing manager their own centre's closer leads and nothing else. The figures
 * are already correct for whoever is reading before this file sees them.
 *
 * What this file does decide is what is worth DRAWING. For a closing manager
 * two things on the shared panel would be permanently dead:
 *
 *   - the other centres, which their policy leaves at zero for good. The RPC
 *     left-joins from `centers`, so those rows come back present and empty
 *     rather than absent, and drawing them would suggest a scope they do not
 *     have and cannot get.
 *   - the Validator row, which their policy excludes by role outright. That
 *     figure is not low, it is structurally zero.
 *
 * Both are dropped for them and kept for everyone else. Uploaded is NOT
 * dropped: a sheet-imported lead is written `submitted_by_role = 'closer'`, so
 * it is genuinely inside a closing manager's scope when it carries their
 * centre.
 */
export function ClosingOverview() {
  const { profile } = useAuth();
  const period = usePeriod();
  // Its own channel: `reporting-stats` belongs to the other two dashboards, and
  // two Supabase subscriptions may not share one name.
  const stats = useOverviewStats({
    ...period,
    channel: "closing-overview",
    // This screen has no validators table, and that RPC hands back every
    // validator's name and performance with three of its columns counted from
    // `form_events` rather than from `submissions` — so they arrive
    // whole-business regardless of centre. Nothing draws it here, so nothing
    // fetches it. See the note on the option itself.
    includeValidatorStats: false,
  });

  const isClosingManager = profile?.role === "closing_manager";

  const centers = useMemo(() => {
    const rows = stats.centerTotals.data ?? [];
    if (!isClosingManager) return rows;
    // Matched on the reader's own centre rather than on "has any leads": a
    // closing manager whose centre has taken nothing today must still see their
    // centre sitting at zero, which is a real and useful fact, and must still
    // not see anybody else's.
    return rows.filter((row) => row.center_id === profile?.center_id);
  }, [stats.centerTotals.data, isClosingManager, profile?.center_id]);

  return (
    <>
      <PeriodPicker
        period={period}
        note={
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            Live · the window applies to the two panels, not to Operations
          </span>
        }
      />

      <OverviewPanels
        period={period}
        stats={stats}
        centers={centers}
        showValidatorRow={!isClosingManager}
      />
    </>
  );
}
