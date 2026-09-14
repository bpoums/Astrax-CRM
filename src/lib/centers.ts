import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/lib/auth";

/**
 * Centres — the call centres leads are taken in.
 *
 * A centre is vocabulary, not workflow: `centers` is written directly under
 * RLS (admin only), the same way `carriers` is, and there is no RPC because
 * nothing about naming a centre needs the ordering guarantees the submission
 * RPCs exist to provide.
 *
 * Two columns hold the link, and they are not interchangeable:
 *
 * - `profiles.center_id` — who a person belongs to. It is what the submissions
 *   read policy compares a closing manager against, so an unset one means that
 *   closing manager sees nothing at all.
 * - `submissions.center_name` — the centre's name **as it stood when the lead
 *   was taken**, stamped on the row. Every table that shows a lead's centre
 *   reads this, never a live join: renaming a centre, or moving a closer to a
 *   different one, must not rewrite the history of what has already been
 *   submitted.
 */

export type Center = {
  id: string;
  name: string;
  active: boolean;
  sort_order: number;
};

export const CENTERS_KEY = ["centers"] as const;

export function centersKey(activeOnly: boolean) {
  return [...CENTERS_KEY, activeOnly ? "active" : "all"] as const;
}

/**
 * The roles a centre actually means something for.
 *
 * A closer's centre is what gets stamped on the leads they submit; a closing
 * manager's is what their whole queue is scoped to; a data uploader's is
 * what gets stamped on every lead they import (`ingest_sheet_lead`), the
 * same way a closer's is on submit. Nothing reads it for any other role, so
 * these are the ones the admin screens ask for — stated once here so the
 * invite form and the user table cannot disagree about it.
 */
const CENTER_ROLES: AppRole[] = ["closer", "closing_manager", "data_uploader"];

export function centerRequired(role: AppRole) {
  return CENTER_ROLES.includes(role);
}

export function useCenters(activeOnly = true, enabled = true) {
  return useQuery({
    queryKey: centersKey(activeOnly),
    enabled,
    queryFn: async () => {
      const query = supabase.from("centers").select("id, name, active, sort_order");
      const scoped = activeOnly ? query.eq("active", true) : query;
      // Name breaks the tie, so two centres sharing a sort_order still come
      // back in a stable order rather than shuffling between renders.
      const { data, error } = await scoped
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Center[];
    },
  });
}
