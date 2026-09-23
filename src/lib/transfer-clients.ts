import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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
      const query = supabase.from("transfer_clients").select("id, name, active, sort_order");
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
