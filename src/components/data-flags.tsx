import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { CANONICAL_FIELDS } from "@/lib/canonical-fields";
import { paymentSummaryKey, usePaymentSummary } from "@/lib/payment-summary";
import { useAuth } from "@/lib/auth";
import type { DataFlag } from "@/components/ops";
import { ClampedText } from "@/components/free-text";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The data flags on one submission, and — for a manager or admin — the way to
 * actually fix what they point at.
 *
 * Clearing a flag on its own only hides the problem: the bad value stays put
 * and the next person to read the lead has no idea it was ever questioned. So
 * the primary action edits the value and clears the flag afterwards, and
 * dismissal is a separate, quieter action that says plainly that nothing
 * changed.
 *
 * A lead's values live in two stores — the payload and payment_details — and
 * the operator has no reason to care which. Both go through one "fix this
 * value" flow; only the write underneath differs.
 */

/** The payment fields `update_payment_field` will accept. */
type PaymentField =
  | "payment_type"
  | "bank_name"
  | "routing_number"
  | "account_number"
  | "account_title"
  | "card_exp"
  | "card_number"
  | "cvv";

const PAYMENT_FIELDS = new Set<string>([
  "payment_type",
  "bank_name",
  "routing_number",
  "account_number",
  "account_title",
  "card_exp",
  "card_number",
  "cvv",
]);

/**
 * Card credentials: admin only, and not readable back from `payment_summary`,
 * so they are entered blind and replace whatever is stored. The RPC enforces
 * the same rule server-side and its refusal is shown to the user as written.
 */
const CARD_CREDENTIALS = new Set<string>(["card_number", "cvv"]);

type Target =
  | { store: "payload"; label: string }
  | { store: "payment"; label: string; field: PaymentField; credential: boolean }
  | null;

/**
 * Which store a flag's field belongs to, and what to call it. `payment_type` is
 * a property of the instrument rather than a form field, so it has no entry in
 * the canonical catalog and is named here.
 */
function targetFor(fieldKey: string): Target {
  if (fieldKey === "payment_type") {
    return { store: "payment", label: "Payment Type", field: "payment_type", credential: false };
  }

  const field = CANONICAL_FIELDS.find((entry) => entry.key === fieldKey);
  if (!field) return null;
  if (field.target === "payload") return { store: "payload", label: field.label };

  const key = field.paymentKey;
  if (!key || !PAYMENT_FIELDS.has(key)) return null;
  return {
    store: "payment",
    label: field.label,
    field: key as PaymentField,
    credential: CARD_CREDENTIALS.has(key),
  };
}

function payloadValue(payload: Record<string, unknown>, label: string) {
  const value = payload[label];
  return value === null || value === undefined ? "" : String(value);
}

export function DataFlagList({
  submissionId,
  payload,
  flags,
  editable = false,
  onChange,
}: {
  submissionId: string;
  payload: Record<string, unknown>;
  flags: DataFlag[];
  /** Managers and admins get the editor; everyone else reads. */
  editable?: boolean;
  onChange?: () => void;
}) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const [openField, setOpenField] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const isAdmin = profile?.role === "admin";
  const needsSummary = editable && flags.some((flag) => targetFor(flag.field)?.store === "payment");
  const summary = usePaymentSummary(submissionId, needsSummary);

  function close() {
    setOpenField(null);
    setDraft("");
    setFailure(null);
  }

  /** What the input starts at. Card credentials start empty by design. */
  function prefill(target: Exclude<Target, null>) {
    if (target.store === "payload") return payloadValue(payload, target.label);
    if (target.credential) return "";
    const current = summary.data?.[target.field as keyof NonNullable<typeof summary.data>];
    return typeof current === "string" ? current : "";
  }

  /**
   * Correct, then clear — in that order and only in that order. If the write
   * fails the flag stays up, which is the outcome we want: a flag is never
   * removed for a value that was not actually fixed.
   *
   * Both writes are RPCs that authorise themselves and raise a message meant
   * to be read by the person who tried, so those messages are surfaced verbatim
   * rather than replaced. `update_payload_field` writes the one field rather
   * than the whole payload, so a correction here cannot roll back an edit
   * someone else made to a different field in the meantime — and it is what
   * records the value that was replaced, which a flag fix needs more than most
   * edits do.
   */
  const correct = useMutation({
    mutationFn: async (vars: {
      flagField: string;
      target: Exclude<Target, null>;
      value: string;
    }) => {
      if (vars.target.store === "payload") {
        const { error } = await supabase.rpc("update_payload_field", {
          p_sub: submissionId,
          p_field: vars.target.label,
          p_value: vars.value,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.rpc("update_payment_field", {
          p_sub: submissionId,
          p_field: vars.target.field,
          p_value: vars.value,
        });
        if (error) throw error;
      }

      const { error } = await supabase.rpc("clear_data_flag", {
        p_sub: submissionId,
        p_field: vars.flagField,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      toast.success(`${vars.target.label} corrected`);
      // The banking panel reads the same cache entry, so it has to be told.
      if (vars.target.store === "payment") {
        queryClient.invalidateQueries({ queryKey: paymentSummaryKey(submissionId) });
      }
      close();
      onChange?.();
    },
    onError: (error: Error) => setFailure(error.message),
  });

  const ignore = useMutation({
    mutationFn: async (field: string) => {
      const { error } = await supabase.rpc("clear_data_flag", {
        p_sub: submissionId,
        p_field: field,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Flag dismissed — the value was left as it is");
      close();
      onChange?.();
    },
    onError: (error: Error) => setFailure(error.message),
  });

  if (flags.length === 0) return null;
  const busy = correct.isPending || ignore.isPending;

  return (
    // Self-contained: this list is mounted in four different sheets, not all of
    // which provide a tooltip context of their own.
    <TooltipProvider delayDuration={120} skipDelayDuration={300}>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="panel-title">Data flags ({flags.length})</h3>
        <ul className="min-w-0 divide-y divide-border rounded-md border border-border">
          {flags.map((flag) => {
            const target = targetFor(flag.field);
            const open = editable && openField === flag.field;
            // Card credentials are the one thing a manager cannot touch.
            const locked = target?.store === "payment" && target.credential && !isAdmin;
            const fixable = !!target && !locked;
            const credential = target?.store === "payment" && target.credential;

            return (
              <li key={`${flag.field}-${flag.issue}`} className="flex flex-col gap-1.5 px-3 py-2">
                <FlagSummary
                  flag={flag}
                  label={target?.label ?? flag.field}
                  editable={editable}
                  fixable={fixable}
                  open={open}
                  onToggle={() => {
                    if (!editable) return;
                    if (open) return close();
                    setOpenField(flag.field);
                    setFailure(null);
                    setDraft(target && fixable ? prefill(target) : "");
                  }}
                />

                {open ? (
                  <div className="flex flex-col gap-2 rounded-md border border-border bg-accent/5 p-2">
                    {target && fixable ? (
                      <>
                        <div className="flex flex-col gap-1">
                          <label htmlFor={`fix-${flag.field}`} className="field-label">
                            {target.label}
                          </label>
                          <input
                            id={`fix-${flag.field}`}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            className="field-input"
                            autoComplete="off"
                            autoFocus
                          />
                          {credential ? (
                            <span className="text-[0.66rem] text-muted-foreground">
                              The stored value cannot be read back. Whatever you enter here replaces
                              it.
                            </span>
                          ) : null}
                        </div>

                        {failure ? <p className="text-xs text-destructive">{failure}</p> : null}

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="btn-submit"
                            disabled={busy || (credential && !draft.trim())}
                            onClick={() =>
                              correct.mutate({ flagField: flag.field, target, value: draft.trim() })
                            }
                          >
                            {correct.isPending ? "Saving…" : "Save correction"}
                          </button>
                          <button type="button" className="chip" disabled={busy} onClick={close}>
                            Cancel
                          </button>
                          <IgnoreButton
                            disabled={busy}
                            pending={ignore.isPending}
                            onClick={() => ignore.mutate(flag.field)}
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">
                          {locked
                            ? "Only an admin may change card credentials."
                            : "There is no single stored value behind this flag to edit."}
                        </p>
                        {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" className="chip" disabled={busy} onClick={close}>
                            Close
                          </button>
                          <IgnoreButton
                            disabled={busy}
                            pending={ignore.isPending}
                            onClick={() => ignore.mutate(flag.field)}
                          />
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </TooltipProvider>
  );
}

function FlagSummary({
  flag,
  label,
  editable,
  fixable,
  open,
  onToggle,
}: {
  flag: DataFlag;
  label: string;
  editable: boolean;
  fixable: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const body = (
    <>
      <span className="field-label truncate">{label}</span>
      {/* The issue is the actionable half — wrapped in full, never clipped. */}
      <span className="free-text block text-xs text-destructive">{flag.issue}</span>
      {/* The raw value is whatever was in the spreadsheet and can be any length,
          so it is clamped with the whole of it on hover. */}
      {flag.raw ? (
        <span className="block text-[0.68rem] text-muted-foreground">
          <ClampedText text={flag.raw} heading={label} meta="Raw value from the source file" />
        </span>
      ) : null}
    </>
  );

  if (!editable) return <div className="flex min-w-0 flex-col">{body}</div>;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex min-w-0 flex-col text-left transition-colors hover:opacity-80"
    >
      {body}
      <span className="mt-0.5 text-[0.66rem] text-accent">
        {open ? "Close" : fixable ? "Fix this value" : "Review"}
      </span>
    </button>
  );
}

/** Deliberately quiet, and worded so it cannot be mistaken for a fix. */
function IgnoreButton({
  disabled,
  pending,
  onClick,
}: {
  disabled: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="chip ml-auto text-muted-foreground"
      disabled={disabled}
      title="Clears the flag and leaves the value unchanged"
      onClick={onClick}
    >
      {pending ? "Dismissing…" : "Ignore without fixing"}
    </button>
  );
}
