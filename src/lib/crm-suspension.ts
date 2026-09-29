import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * The CRM-wide maintenance switch. `my_role()` already enforces this
 * server-side for every read and write (see the `crm_suspension` migration),
 * so this query and the realtime subscription below exist only to drive the
 * UI — the forced sign-out and the blocking message — not as the real gate.
 */
export type CrmSuspension = {
  suspended: boolean;
  resumes_at: string | null;
  message: string | null;
};

export const CRM_SUSPENSION_KEY = ["crm-suspension"] as const;

/** Shared by every beforeLoad guard and the realtime kick — one query shape. */
export async function fetchCrmSuspension(): Promise<CrmSuspension | null> {
  const { data } = await supabase
    .from("crm_suspension")
    .select("suspended, resumes_at, message")
    .eq("id", true)
    .single();
  return data;
}

/** True right now — `resumes_at` in the past means a timed suspension has lapsed. */
export function isActiveSuspension(row: CrmSuspension | null | undefined) {
  if (!row?.suspended) return false;
  if (!row.resumes_at) return true;
  return new Date(row.resumes_at).getTime() > Date.now();
}

export function useCrmSuspension(enabled = true) {
  return useQuery({
    queryKey: CRM_SUSPENSION_KEY,
    enabled,
    queryFn: async () => {
      const data = await fetchCrmSuspension();
      if (!data) throw new Error("Could not read suspension state.");
      return data;
    },
    // A suspension that just lifted has to be noticed within the minute the
    // cron sweep would otherwise take, so the blocking page doesn't strand
    // someone after `resumes_at` has already passed.
    refetchInterval: 10_000,
  });
}

/**
 * One realtime subscription for the whole app, mirroring the
 * `postgres_changes` pattern already used in `manager.tsx`/`validator.tsx`.
 * `onChange` fires with the fresh row on every insert/update.
 */
export function subscribeToCrmSuspension(
  queryClient: QueryClient,
  onChange: (row: CrmSuspension) => void,
) {
  const channel = supabase
    .channel("crm-suspension")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "crm_suspension" },
      (payload) => {
        const row = payload.new as CrmSuspension;
        queryClient.setQueryData(CRM_SUSPENSION_KEY, row);
        onChange(row);
      },
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Convenience wrapper for components that only need to react, not read. */
export function useCrmSuspensionListener(onChange: (row: CrmSuspension) => void) {
  const queryClient = useQueryClient();
  useEffect(() => subscribeToCrmSuspension(queryClient, onChange), [queryClient, onChange]);
}

/**
 * Admin-only server-side; see `set_crm_suspension` in the migration.
 *
 * `exactOptionalPropertyTypes` rejects an explicit `null` for an optional
 * RPC arg (`p_duration_minutes?: number`), so a `null` here is omitted
 * entirely rather than passed through, letting the SQL default apply — same
 * pattern `reject_assignment`'s `p_reason` already uses (see `CLAUDE.md`).
 */
export async function setCrmSuspension(args: {
  suspended: boolean;
  durationMinutes: number | null;
  message: string | null;
}) {
  const { error } = await supabase.rpc("set_crm_suspension", {
    p_suspended: args.suspended,
    ...(args.durationMinutes !== null ? { p_duration_minutes: args.durationMinutes } : {}),
    ...(args.message !== null ? { p_message: args.message } : {}),
  });
  if (error) throw new Error(error.message);
}
