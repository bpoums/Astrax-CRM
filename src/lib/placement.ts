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
