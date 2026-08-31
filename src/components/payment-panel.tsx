import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePaymentSummary } from "@/lib/payment-summary";
import { Badge } from "@/components/ui/badge";

/**
 * Banking details for a submission.
 *
 * The numbers never come down with the row: `payment_summary` returns the bank
 * fields plus the card's last four and nothing else, so a manager's queue never
 * holds a card number to leak. The full card is a separate, logged RPC that
 * only a validator inside their own review can call.
 */

type CardDetails = {
  card_number: string | null;
  card_exp: string | null;
  cvv: string | null;
};

function readCard(value: unknown): CardDetails | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : null);
  return {
    card_number: text("card_number"),
    card_exp: text("card_exp"),
    cvv: text("cvv"),
  };
}

function groupCard(digits: string | null) {
  if (!digits) return "—";
  return digits.replace(/(.{4})/g, "$1 ").trim();
}

export function PaymentPanel({
  submissionId,
  canRevealCard = false,
}: {
  submissionId: string;
  canRevealCard?: boolean;
}) {
  const [card, setCard] = useState<CardDetails | null>(null);

  const summary = usePaymentSummary(submissionId);

  // Deliberately a mutation, not a query: every reveal is one logged call, and
  // the result is held in component state so it disappears with the sheet
  // rather than sitting in the query cache.
  const reveal = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("card_details", { p_sub: submissionId });
      if (error) throw error;
      return readCard(data);
    },
    onSuccess: (data) => setCard(data),
    onError: (error: Error) => toast.error(error.message),
  });

  const details = summary.data;
  const type = details?.payment_type ?? "unknown";

  if (summary.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="panel-title">Banking</h3>
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }

  // `payment_summary` raises its own message when the caller may not read it
  // ("not authorized", "not assigned to you"). Falling through to the empty
  // state would report that as "no details attached", which is a different
  // thing and the wrong thing to tell someone chasing a missing bank draft.
  if (summary.isError) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="panel-title">Banking</h3>
        <p className="text-xs text-destructive">{(summary.error as Error).message}</p>
      </div>
    );
  }

  if (!details || type === "unknown") {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="panel-title">Banking</h3>
        <p className="text-xs text-muted-foreground">
          No card or bank draft details are attached to this lead.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="panel-title">Banking</h3>
        <Badge variant="secondary" className="text-muted-foreground">
          {type === "card" ? "Card" : "Bank draft"}
        </Badge>
      </div>

      <div className="divide-y divide-border rounded-md border border-border">
        {type === "card" ? (
          <>
            <Row
              label="Card Number"
              value={details.card_last4 ? `•••• ${details.card_last4}` : "—"}
            />
            <Row label="Card Expiry" value={details.card_exp ?? "—"} />
          </>
        ) : (
          <>
            <Row label="Bank Name" value={details.bank_name ?? "—"} />
            <Row label="Account Title" value={details.account_title ?? "—"} />
            <Row label="Routing Number" value={details.routing_number ?? "—"} />
            <Row label="Account Number" value={details.account_number ?? "—"} />
          </>
        )}
      </div>

      {type === "card" && canRevealCard ? (
        card ? (
          <div className="flex flex-col gap-2">
            <div className="divide-y divide-border rounded-md border border-accent">
              <Row label="Card Number" value={groupCard(card.card_number)} />
              <Row label="Card Expiry" value={card.card_exp ?? "—"} />
              <Row label="CVV" value={card.cvv ?? "—"} />
            </div>
            <button type="button" className="chip justify-center" onClick={() => setCard(null)}>
              Hide card details
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              className="chip justify-center"
              disabled={reveal.isPending}
              onClick={() => reveal.mutate()}
            >
              {reveal.isPending ? "Opening…" : "Show card details"}
            </button>
            <span className="text-[0.66rem] text-muted-foreground">
              Every reveal is recorded against your name.
            </span>
          </div>
        )
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-center gap-2 px-3 py-1.5">
      <span className="field-label truncate">{label}</span>
      <span className="break-words text-xs tabular-nums text-foreground">{value}</span>
    </div>
  );
}
