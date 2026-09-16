import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { paymentSummaryKey, usePaymentSummary } from "@/lib/payment-summary";
import { Badge } from "@/components/ui/badge";

/**
 * Banking details for a submission.
 *
 * The numbers never come down with the row: `payment_summary` returns the bank
 * fields plus the card's last four and nothing else, so a manager's queue never
 * holds a card number to leak. The full card is a separate, logged RPC that
 * only a validator inside their own review can call.
 *
 * `editable` adds inline correction of the bank fields through
 * `update_payment_field`, one field per call, the same RPC and the same
 * `form_events` trail the data-flag editor uses. The card number and the CVV are
 * never offered here for anyone — they cannot be read back out of
 * `payment_summary`, and the RPC refuses them to every role but admin. A
 * card-type lead therefore has nothing editable in this panel at all: its last
 * four and its expiry are all that ever reach the browser.
 */

/**
 * The bank-draft fields, which are the ones `update_payment_field` accepts and
 * `payment_summary` reads back — so the input can start from the stored value.
 */
const EDITABLE_BANK_FIELDS = [
  { field: "bank_name", label: "Bank Name" },
  { field: "account_title", label: "Account Title" },
  { field: "routing_number", label: "Routing Number" },
  { field: "account_number", label: "Account Number" },
] as const;

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
  editable = false,
}: {
  submissionId: string;
  canRevealCard?: boolean;
  /** Inline correction of the bank fields. Never the card number or the CVV. */
  editable?: boolean;
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
          EDITABLE_BANK_FIELDS.map(({ field, label }) =>
            editable ? (
              <EditableRow
                key={field}
                submissionId={submissionId}
                field={field}
                label={label}
                value={details[field] ?? ""}
              />
            ) : (
              <Row key={field} label={label} value={details[field] ?? "—"} />
            ),
          )
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

/**
 * One bank field, corrected in place.
 *
 * Save is only offered once the value actually differs, and the field re-reads
 * from `paymentSummaryKey` afterwards rather than trusting the local draft — the
 * panel and the data-flag editor share that one cache entry, so a correction
 * made in either place has to be what both then draw from.
 */
function EditableRow({
  submissionId,
  field,
  label,
  value,
}: {
  submissionId: string;
  field: string;
  label: string;
  value: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(value);
  // The row is keyed by submission upstream, but a refetch can bring a new
  // stored value in underneath an untouched input.
  const [committed, setCommitted] = useState(value);
  if (committed !== value) {
    setCommitted(value);
    setDraft(value);
  }

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("update_payment_field", {
        p_sub: submissionId,
        p_field: field,
        p_value: draft.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${label} updated`);
      queryClient.invalidateQueries({ queryKey: paymentSummaryKey(submissionId) });
    },
    // The RPC raises its own authorisation message ("not authorized", "only an
    // admin may change card credentials") — show that, not a generic one.
    onError: (error: Error) => toast.error(error.message),
  });

  const dirty = draft.trim() !== value.trim();

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-center gap-2 px-3 py-1.5">
      <label className="field-label truncate" htmlFor={`payment-${field}-${submissionId}`}>
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          id={`payment-${field}-${submissionId}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="field-input h-7 flex-1 text-xs tabular-nums"
          autoComplete="off"
        />
        {dirty ? (
          <button
            type="button"
            className="chip shrink-0 px-2 py-0.5 text-[0.62rem]"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>
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
