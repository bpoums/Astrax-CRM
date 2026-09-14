import { useMemo } from "react";
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

/**
 * A fixed, pre-approved palette rather than a free color picker — picked at
 * center-creation time, deliberately clear of amber (the app's one accent)
 * and of the red/emerald already reserved for destructive/positive outcomes.
 * A `check` constraint on `centers.color` enforces the same six values in
 * the database; kept here as the one place both agree with.
 */
export const CENTER_COLORS = ["slate", "teal", "violet", "clay", "sky", "sage"] as const;

export type CenterColor = (typeof CENTER_COLORS)[number];

export type Center = {
  id: string;
  name: string;
  active: boolean;
  sort_order: number;
  color: CenterColor;
};

export const CENTERS_KEY = ["centers"] as const;

export function centersKey(activeOnly: boolean) {
  return [...CENTERS_KEY, activeOnly ? "active" : "all"] as const;
}

/**
 * The roles the admin screens ask a centre for — stated once here so the
 * invite form and the user table cannot disagree about it.
 *
 * A closer's centre is what gets stamped on the leads they submit; a closing
 * manager's is what their whole queue is scoped to; a data uploader's is
 * what gets stamped on every lead they import (`ingest_sheet_lead`), the
 * same way a closer's is on submit — all three are read by something. A
 * validator's is not: nothing scopes a validator's queue by it, and no lead
 * stamps it. It's tracked anyway, purely as roster information (which
 * physical center a validator sits in), and shown/edited the same way the
 * other three are so the answer isn't only ever visible in the database.
 */
const CENTER_ROLES: AppRole[] = ["closer", "closing_manager", "data_uploader", "validator"];

export function centerRequired(role: AppRole) {
  return CENTER_ROLES.includes(role);
}

export function useCenters(activeOnly = true, enabled = true) {
  return useQuery({
    queryKey: centersKey(activeOnly),
    enabled,
    queryFn: async () => {
      const query = supabase.from("centers").select("id, name, active, sort_order, color");
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

/**
 * `center_id -> color`, for a `CenterBadge` reading a lead's stamped
 * `center_id`/`center_name` rather than the picker's own live list. Pulls
 * every center, active or not — a lead taken under a since-deactivated
 * center still deserves its real color, not a "not found" fallback.
 * `useCenters` is a cached query, so calling this from several components on
 * one screen costs one fetch, not one per caller.
 */
export function useCenterColorById() {
  const centers = useCenters(false);
  return useMemo(() => {
    const map = new Map<string, CenterColor>();
    for (const center of centers.data ?? []) map.set(center.id, center.color);
    return map;
  }, [centers.data]);
}
