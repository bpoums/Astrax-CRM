import { useQuery, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Where a lead can be placed: Agency -> IMO -> Carrier -> Agent.
 *
 * Every link is many-to-many. One carrier is contracted through several IMOs,
 * and an agent's appointment belongs to one IMO->Carrier contract (an
 * `imo_carriers` row), not to the carrier in general — appointed with Corbridge
 * through IMO1 does not mean appointed with Corbridge through IMO2.
 *
 * Carriers themselves stay in `@/lib/carriers`; this module only adds the
 * other three lists and the links between them. All writes go through the
 * admin-only `placement_upsert_item` / `placement_set_link` RPCs.
 */

export type PlacementKind = "agency" | "imo" | "agent";

export type PlacementItem = {
  id: string;
  name: string;
  active: boolean;
  sort_order: number;
  /** Agents only — the agent's National Producer Number, optional. */
  npn: string | null;
};

export type AgencyImoLink = { agency_id: string; imo_id: string; active: boolean };
export type ImoCarrierLink = { id: string; imo_id: string; carrier_id: string; active: boolean };
export type AgentAppointment = { agent_id: string; imo_carrier_id: string; active: boolean };

export type PlacementLinks = {
  agencyImos: AgencyImoLink[];
  imoCarriers: ImoCarrierLink[];
  appointments: AgentAppointment[];
};

export const PLACEMENT_KEY = ["placement"] as const;

const TABLE = { agency: "agencies", imo: "imos", agent: "agents" } as const;

export const PLACEMENT_LABEL: Record<PlacementKind, { one: string; many: string }> = {
  agency: { one: "Agency", many: "Agencies" },
  imo: { one: "IMO", many: "IMOs" },
  agent: { one: "Agent", many: "Agents" },
};

/** Everything placement-related is cached under one prefix, so one call retires it all. */
export function invalidatePlacement(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: PLACEMENT_KEY });
}

/**
 * Is the full placement chain (agency → IMO → carrier → agent, plus the
 * rejection rule) switched on? Read from `app_config` by `placement_rule_enabled()`.
 * While it is off, validators fill the original three fields instead — carrier,
 * a typed agent name and the policy number — and the server asks for no more.
 */
export function usePlacementRuleEnabled(enabled = true) {
  return useQuery({
    queryKey: [...PLACEMENT_KEY, "rule-enabled"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("placement_rule_enabled");
      if (error) throw error;
      return data === true;
    },
  });
}

/** One list, inactive rows included — callers filter, so a retired value still renders its name. */
export function usePlacementList(kind: PlacementKind, enabled = true) {
  return useQuery({
    queryKey: [...PLACEMENT_KEY, "list", kind],
    enabled,
    queryFn: async () => {
      const columns =
        kind === "agent" ? "id, name, active, sort_order, npn" : "id, name, active, sort_order";
      const { data, error } = await supabase
        .from(TABLE[kind])
        .select(columns)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return (
        (data ?? []) as unknown as Array<Omit<PlacementItem, "npn"> & { npn?: string | null }>
      ).map((row) => ({ ...row, npn: row.npn ?? null })) satisfies PlacementItem[];
    },
  });
}

export function usePlacementLinks(enabled = true) {
  return useQuery({
    queryKey: [...PLACEMENT_KEY, "links"],
    enabled,
    queryFn: async (): Promise<PlacementLinks> => {
      const [agencyImos, imoCarriers, appointments] = await Promise.all([
        supabase.from("agency_imos").select("agency_id, imo_id, active"),
        supabase.from("imo_carriers").select("id, imo_id, carrier_id, active"),
        supabase.from("agent_appointments").select("agent_id, imo_carrier_id, active"),
      ]);
      if (agencyImos.error) throw agencyImos.error;
      if (imoCarriers.error) throw imoCarriers.error;
      if (appointments.error) throw appointments.error;
      return {
        agencyImos: agencyImos.data ?? [],
        imoCarriers: imoCarriers.data ?? [],
        appointments: appointments.data ?? [],
      };
    },
  });
}

/** IMO ids actively linked to an agency. */
export function imosForAgency(links: PlacementLinks | undefined, agencyId: string) {
  return new Set(
    (links?.agencyImos ?? [])
      .filter((link) => link.active && link.agency_id === agencyId)
      .map((link) => link.imo_id),
  );
}

/** Carrier ids actively contracted through an IMO. */
export function carriersForImo(links: PlacementLinks | undefined, imoId: string) {
  return new Set(
    (links?.imoCarriers ?? [])
      .filter((link) => link.active && link.imo_id === imoId)
      .map((link) => link.carrier_id),
  );
}

/** The `imo_carriers` row for one IMO + carrier, active or not. */
export function imoCarrierLink(
  links: PlacementLinks | undefined,
  imoId: string,
  carrierId: string,
) {
  return (links?.imoCarriers ?? []).find(
    (link) => link.imo_id === imoId && link.carrier_id === carrierId,
  );
}

/** Agent ids actively appointed on one IMO->Carrier contract. */
export function agentsForLink(links: PlacementLinks | undefined, imoCarrierId: string) {
  return new Set(
    (links?.appointments ?? [])
      .filter((link) => link.active && link.imo_carrier_id === imoCarrierId)
      .map((link) => link.agent_id),
  );
}

/**
 * One carrier rejection on file for this customer, from any of their leads.
 * `imo_id` is null on declines recorded before IMOs existed — those block
 * their carrier only.
 */
export type PlacementRejection = {
  imo_id: string | null;
  imo_name: string | null;
  carrier_id: string;
  carrier_name: string;
  declined_at: string;
  source: "validator" | "after_submit";
  same_lead: boolean;
};

export type PlacementOverride = {
  imo_id: string;
  carrier_id: string;
  reason: string;
  created_at: string;
};

export type PlacementBlocks = {
  rejections: PlacementRejection[];
  overrides: PlacementOverride[];
};

export function placementBlocksKey(submissionId: string | null) {
  return [...PLACEMENT_KEY, "blocks", submissionId] as const;
}

/**
 * The customer's carrier rejections and this lead's overrides, so the
 * dropdowns can grey out what the server would refuse. Display only — the
 * server enforces the rule itself in `set_validator_fields` and on accept.
 */
export function usePlacementBlocks(submissionId: string | null, enabled = true) {
  return useQuery({
    queryKey: placementBlocksKey(submissionId),
    enabled: enabled && !!submissionId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("placement_blocks", { p_sub: submissionId! });
      if (error) throw error;
      return data as unknown as PlacementBlocks;
    },
  });
}

/** MM/DD/YYYY in Pakistan time, the same clock the server's block messages use. */
function blockDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "Asia/Karachi",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

/**
 * Why this lead may not be placed at IMO -> carrier, or null when it may.
 * Mirrors `placement_conflict` in the database, including its wording, so the
 * greyed-out option and the server's refusal say the same thing. Only the same
 * carrier blocks; a different carrier under the same IMO is a warning, below.
 */
export function placementBlockReason(
  blocks: PlacementBlocks | undefined,
  imoId: string,
  carrierId: string,
): string | null {
  if (!blocks || !imoId || !carrierId) return null;
  if (blocks.overrides.some((o) => o.imo_id === imoId && o.carrier_id === carrierId)) return null;
  const sameCarrier = blocks.rejections.find((r) => r.carrier_id === carrierId);
  if (!sameCarrier) return null;
  const via = sameCarrier.imo_name ? ` via ${sameCarrier.imo_name}` : "";
  return `${sameCarrier.carrier_name} already rejected this customer${via} on ${blockDate(sameCarrier.declined_at)} — it cannot be used again under any IMO.`;
}

/**
 * The warning, not a block: this customer was rejected by a different carrier
 * under the SAME IMO. Saving past it needs the validator to tick "I understand".
 * Mirrors `placement_warning` in the database, wording included. Only a
 * rejection that names its IMO can warn — declines from before IMOs existed
 * have none.
 */
export function placementWarningReason(
  blocks: PlacementBlocks | undefined,
  imoId: string,
  carrierId: string,
): string | null {
  if (!blocks || !imoId || !carrierId) return null;
  const sameImo = blocks.rejections.find(
    (r) => r.imo_id !== null && r.imo_id === imoId && r.carrier_id !== carrierId,
  );
  if (!sameImo) return null;
  return `${sameImo.carrier_name} rejected this customer via ${sameImo.imo_name} on ${blockDate(sameImo.declined_at)}. You are applying to a different carrier under the same IMO — confirm that is intended.`;
}

/**
 * Per lead, how many carrier rejections are on file for that customer, as a
 * lookup — one query for the whole queue, same as `useDeclinedCarrierMap`.
 */
export function useCustomerRejectionMap(enabled = true) {
  return useQuery({
    queryKey: [...PLACEMENT_KEY, "customer-rejections"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submission_customer_rejections")
        .select("submission_id, rejection_count, rejected_carriers");
      if (error) throw error;
      const map = new Map<string, { count: number; carriers: string[] }>();
      for (const row of data ?? []) {
        if (row.submission_id) {
          map.set(row.submission_id, {
            count: row.rejection_count ?? 0,
            carriers: row.rejected_carriers ?? [],
          });
        }
      }
      return map;
    },
  });
}
