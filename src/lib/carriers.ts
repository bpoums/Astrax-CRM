import { useQuery, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { CarrierRef } from "@/lib/normalize";

/**
 * Carriers, and the record of which of them have already said no to a lead.
 *
 * A decline is no longer a single outcome on the submission — it is one row per
 * carrier in `carrier_declines`, written by `decline_with_carriers`. The point
 * of the feature is that nobody resubmits a lead to a carrier that has already
 * refused it, so everything here exists to put those names in front of whoever
 * is about to act: the queue badge, the assign flow, and the dialog itself.
 *
 * Three reads, deliberately kept apart:
 *
 * - `carriers` — the vocabulary. `active` is what the decline dialog offers;
 *   the admin screen wants the inactive ones too so one can be brought back.
 * - `submission_declined_carriers` — one row per lead, carrier NAMES only. It
 *   is the cheap answer to "who has already declined this?", which is all the
 *   badge and the dialog's disabled rows need.
 * - `carrier_declines` — the attempts themselves, with reason and actor. Only
 *   the detail sheet asks for these, and only for the lead that is open.
 */

export type Carrier = {
  id: string;
  name: string;
  /**
   * The alternate spellings seen in uploaded files. They are matched by the
   * normaliser and edited in Settings; nothing else reads them, and they are
   * never shown to a closer or a validator — those two pick the canonical name.
   */
  aliases: string[];
  active: boolean;
  sort_order: number;
};

export const CARRIERS_KEY = ["carriers"] as const;
export const DECLINED_CARRIERS_KEY = ["declined-carriers"] as const;
export const CARRIER_DECLINES_KEY = ["carrier-declines"] as const;
export const CARRIER_DECLINE_STATS_KEY = ["carrier-decline-stats"] as const;

export function carriersKey(activeOnly: boolean) {
  return [...CARRIERS_KEY, activeOnly ? "active" : "all"] as const;
}

export function declinedCarriersKey(submissionId: string | null) {
  return [...DECLINED_CARRIERS_KEY, submissionId] as const;
}

export function carrierDeclinesKey(submissionId: string | null) {
  return [...CARRIER_DECLINES_KEY, submissionId] as const;
}

/**
 * Everything a recorded decline touches, retired in one place.
 *
 * The queue badge, the dialog's disabled rows, the detail sheet's list and the
 * admin report are four separate cache entries fed by the same write — missing
 * one of them leaves a carrier looking available immediately after someone
 * recorded that it declined.
 */
export function invalidateCarrierDeclines(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: DECLINED_CARRIERS_KEY });
  queryClient.invalidateQueries({ queryKey: CARRIER_DECLINES_KEY });
  queryClient.invalidateQueries({ queryKey: CARRIER_DECLINE_STATS_KEY });
}

export function useCarriers(activeOnly = true, enabled = true) {
  return useQuery({
    queryKey: carriersKey(activeOnly),
    enabled,
    queryFn: async () => {
      const query = supabase.from("carriers").select("id, name, aliases, active, sort_order");
      const scoped = activeOnly ? query.eq("active", true) : query;
      // Name is the tie-break, so two carriers sharing a sort_order still come
      // back in a stable order rather than shuffling between renders.
      const { data, error } = await scoped
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Carrier[];
    },
  });
}

export type DeclinedCarriers = {
  declined_carriers: string[];
  decline_count: number;
  last_declined_at: string | null;
};

/** The carriers that have already declined one lead. Null when none have. */
export function useDeclinedCarriers(submissionId: string | null) {
  return useQuery({
    queryKey: declinedCarriersKey(submissionId),
    enabled: !!submissionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submission_declined_carriers")
        .select("declined_carriers, decline_count, last_declined_at")
        .eq("submission_id", submissionId!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        declined_carriers: data.declined_carriers ?? [],
        decline_count: data.decline_count ?? 0,
        last_declined_at: data.last_declined_at,
      } satisfies DeclinedCarriers;
    },
  });
}

/**
 * The same view for a whole queue, as a lookup.
 *
 * One query rather than one per row: the view only holds leads that have been
 * declined at least once, so it is short even when the queue is not, and a
 * badge per row cannot be worth a request per row.
 */
export function useDeclinedCarrierMap(enabled = true) {
  return useQuery({
    queryKey: [...DECLINED_CARRIERS_KEY, "map"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submission_declined_carriers")
        .select("submission_id, declined_carriers");
      if (error) throw error;
      const map = new Map<string, string[]>();
      for (const row of data ?? []) {
        if (row.submission_id) map.set(row.submission_id, row.declined_carriers ?? []);
      }
      return map;
    },
  });
}

export type CarrierDecline = {
  id: number;
  reason: string | null;
  declined_at: string;
  carrier: { name: string } | null;
  by: { full_name: string | null } | null;
};

/**
 * Every decline recorded against one lead, newest first.
 *
 * Both foreign keys resolve to two relations apiece — `carrier_id` to `carriers`
 * and `carrier_decline_stats`, `declined_by` to `profiles` and
 * `validator_stats` — so each hint names the relation it wants. Dropping the
 * relation name is what makes PostgREST refuse the embed as ambiguous.
 */
export function useCarrierDeclines(submissionId: string | null) {
  return useQuery({
    queryKey: carrierDeclinesKey(submissionId),
    enabled: !!submissionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("carrier_declines")
        .select(
          "id, reason, declined_at, carrier:carriers!carrier_declines_carrier_id_fkey(name), by:profiles!carrier_declines_declined_by_fkey(full_name)",
        )
        .eq("submission_id", submissionId!)
        .order("declined_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CarrierDecline[];
    },
  });
}

/**
 * "TransAmerica, Corbridge +2" — the first `max` names and a count of the rest.
 *
 * A queue cell has room for two carrier names and no more; the full list is one
 * click away in the detail sheet, so truncating here costs nothing and keeps
 * the badge from swallowing the row.
 */
export function carrierSummary(names: string[], max = 2) {
  const shown = names.slice(0, max).join(", ");
  const rest = names.length - max;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/**
 * The carrier list as the normaliser wants it.
 *
 * The upload tool fetches the table once and hands this down, the same way it
 * hands down the canonical field catalogue — `src/lib/normalize` is pure and
 * must never query for itself.
 */
export function carrierRefs(carriers: Carrier[] | undefined): CarrierRef[] {
  return (carriers ?? []).map((carrier) => ({
    name: carrier.name,
    aliases: carrier.aliases ?? [],
  }));
}

/** Case- and whitespace-insensitive, because the view returns display names. */
export function isDeclinedBy(declined: string[], name: string) {
  const target = name.trim().toLowerCase();
  return declined.some((entry) => entry.trim().toLowerCase() === target);
}
