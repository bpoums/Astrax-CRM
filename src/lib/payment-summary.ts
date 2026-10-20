import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * `payment_summary` for one submission.
 *
 * Shared by the banking panel and the data-flag editor so both read the same
 * cache entry — and so a correction made through the editor invalidates the
 * key the panel is drawing from. Getting that wrong would leave the panel
 * showing the old value straight after a successful fix.
 *
 * It returns the bank fields plus the card's last four. A full card number is
 * never in here; that is `card_details`, which is admin, manager, general_manager
 * and (inside their own open review) validator only, and logged. `has_card` and
 * `has_cvv` say whether a value is stored without carrying it.
 */

export type PaymentSummary = {
  payment_type: string | null;
  bank_name: string | null;
  routing_number: string | null;
  account_number: string | null;
  account_title: string | null;
  card_last4: string | null;
  card_exp: string | null;
  has_card: boolean;
  has_cvv: boolean;
  cvv_purged: boolean;
};

export function paymentSummaryKey(submissionId: string) {
  return ["payment-summary", submissionId] as const;
}

export function readPaymentSummary(value: unknown): PaymentSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : null);
  return {
    payment_type: text("payment_type"),
    bank_name: text("bank_name"),
    routing_number: text("routing_number"),
    account_number: text("account_number"),
    account_title: text("account_title"),
    card_last4: text("card_last4"),
    card_exp: text("card_exp"),
    has_card: raw["has_card"] === true,
    has_cvv: raw["has_cvv"] === true,
    cvv_purged: raw["cvv_purged"] === true,
  };
}

export function usePaymentSummary(submissionId: string, enabled = true) {
  return useQuery({
    queryKey: paymentSummaryKey(submissionId),
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("payment_summary", { p_sub: submissionId });
      if (error) throw error;
      return readPaymentSummary(data);
    },
  });
}
