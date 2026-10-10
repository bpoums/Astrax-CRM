import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ReportingRange } from "@/lib/period-range";

/**
 * Transfer clients — the external parties a closer hands a lead to.
 *
 * Vocabulary, not workflow, so `transfer_clients` is written directly under
 * RLS (admin only) exactly the way `centers` and `carriers` are. There is no
 * RPC because naming a client needs none of the ordering guarantees the
 * submission RPCs exist to provide.
 *
 * Two columns hold the link on a lead, and they are not interchangeable:
 *
 * - `submissions.transfer_client_id` — which client, live. Parked Leads
 *   filters its tabs on this.
 * - `submissions.transfer_client_name` — the client's name **as it stood when
 *   the lead was parked**, stamped on the row by `submit_form_parked`. Every
 *   table that shows a lead's client reads this, never a live join, so
 *   renaming a client cannot rewrite the history of leads already transferred.
 */

export type TransferClient = {
  id: string;
  name: string;
  active: boolean;
  sort_order: number;
  /**
   * The center whose closers may transfer to this client, and the center it is
   * shown under on the Overview. Null = offered to every center.
   */
  center_id: string | null;
};

export const TRANSFER_CLIENTS_KEY = ["transfer-clients"] as const;

export function transferClientsKey(activeOnly: boolean) {
  return [...TRANSFER_CLIENTS_KEY, activeOnly ? "active" : "all"] as const;
}

export function useTransferClients(activeOnly = true, enabled = true) {
  return useQuery({
    queryKey: transferClientsKey(activeOnly),
    enabled,
    queryFn: async () => {
      const query = supabase.from("transfer_clients").select("id, name, active, sort_order, center_id");
      const scoped = activeOnly ? query.eq("active", true) : query;
      // Name breaks the tie, so two clients sharing a sort_order still come
      // back in a stable order rather than shuffling between renders.
      const { data, error } = await scoped
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as TransferClient[];
    },
  });
}

export type ParkedClientCount = {
  /** The LEAD's center — where its closer's row is counted on the Overview. */
  center_id: string | null;
  client_id: string;
  client_name: string;
  lead_count: number;
};

/**
 * Leads still parked with each client, per center, for the selected period.
 *
 * "Still parked, submitted in the period": a subset of that center's live total,
 * so "In House = live - clients" on the Overview always adds up. Admin and
 * general manager only — the RPC refuses anyone else, and a refusal arrives as
 * `isError`, which the caller must not read as "no transfers". Kept under the
 * `["parked-leads"]` prefix so moving a lead into validation refreshes it.
 */
export function useParkedClientsByCenter(range: ReportingRange, enabled = true) {
  return useQuery({
    queryKey: ["parked-leads", "by-center", JSON.stringify(range)],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("parked_client_counts_range", range);
      if (error) throw error;
      return (data ?? []).map(
        (row): ParkedClientCount => ({
          center_id: row.center_id,
          client_id: row.client_id,
          client_name: row.client_name,
          lead_count: Number(row.lead_count),
        }),
      );
    },
  });
}
