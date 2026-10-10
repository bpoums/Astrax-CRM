import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SECTIONS, type Field } from "@/components/closer-form";
import { payloadDisplayLabel } from "@/components/ops";
import { Check } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useUploadedRequiredFields } from "@/lib/required-fields";
import { paymentSummaryKey } from "@/lib/payment-summary";

/**
 * "Missing information" on an uploaded lead: badges for the lists, and a section
 * for the lead's detail panel that lets the people allowed to edit the lead fill
 * each gap in.
 *
 * Two groups, deliberately apart:
 *  - **core** — `submissions.missing_info`, a generated column over the payload;
 *  - **bank** — `submissions.missing_bank`, kept current by triggers because four
 *    of the five fields live in `payment_details`, which a generated column
 *    cannot read.
 * Both come from the one list in `uploaded_required_fields()`. They are separate
 * because Account Title was empty on every uploaded lead when this was built, so
 * one combined label would have said nothing; the bank badge is muted for the
 * same reason, and amber stays reserved for the group that tells leads apart.
 *
 * Nothing is stored here and there is no flag to clear: a column recomputes on
 * every write, so a badge and its row vanish the moment the value is saved and
 * the lead is refetched. A lead that is not an uploaded one has `{}` in both.
 *
 * It is its own section, not a change to `LeadPayload` / `PayloadEditor`: those
 * only list the keys a lead already carries, and a field that was never in the
 * file has no key to edit. Core fields and Bank Type go through
 * `update_payload_field`; the other four bank fields through
 * `update_payment_field`. Both record what a value was before, and both raise
 * their own authorisation message, shown here as written.
 */

const FIELD_BY_LABEL = new Map<string, Field>(
  SECTIONS.flatMap((section) => section.fields).map((field) => [field.label, field]),
);

/**
 * Where each bank label is written. "Bank Type" is a payload key like the core
 * fields; the rest are `payment_details` columns, reached only through
 * `update_payment_field`.
 */
const PAYMENT_COLUMN: Record<string, string> = {
  "Account Title": "account_title",
  "Bank Name": "bank_name",
  "Routing Number": "routing_number",
  "Account Number": "account_number",
};

/** The roles `update_payment_field` accepts for these four columns. */
const BANK_EDIT_ROLES = new Set(["admin", "manager", "general_manager"]);

/**
 * Two fill rings: one for the core fields, one for the banking ones. Each ring
 * fills in proportion to how many of its group's required fields are present,
 * and the number in the middle is how many are still missing — so a row says how
 * much is left without anyone counting ticks. An earlier version drew one tick
 * per field; at 3px each it was too small to read, and the count had to be done
 * by eye.
 *
 * Amber is a missing core field (the signal that tells leads apart); the banking
 * ring is grey, because Account Title was empty on every uploaded lead when this
 * was built and amber on every row would say nothing. A complete group is a
 * dim ring with a tick, not nothing, so the two rings keep their positions down
 * a column and a lead with only a banking gap is not mistaken for a core one.
 * Colour is never the only carrier: the badge is an image with a text label, and
 * the names of the missing fields are in its `title` — a native title, not a
 * mounted Tooltip, so a long list does not mount one per row.
 *
 * About 64px on one line. `shrink-0` keeps it whole; the cell that hosts it keeps
 * `flex-wrap`, so on a narrow window it drops under the name rather than
 * widening the table. Renders nothing for a lead missing nothing.
 */
const RING = 30;
const RING_STROKE = 3.5;
const RING_RADIUS = (RING - RING_STROKE) / 2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function FillRing({
  missing,
  total,
  tone,
}: {
  missing: number;
  total: number;
  tone: "accent" | "muted";
}) {
  const present = Math.max(0, total - missing);
  const share = total > 0 ? present / total : 0;
  const complete = missing === 0;
  const arc = tone === "accent" ? "stroke-accent" : "stroke-muted-foreground";
  const text = tone === "accent" ? "text-accent" : "text-muted-foreground";

  return (
    <span
      aria-hidden
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: RING, height: RING }}
    >
      <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} className="-rotate-90">
        <circle
          cx={RING / 2}
          cy={RING / 2}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          className="stroke-border"
        />
        {!complete && share > 0 ? (
          <circle
            cx={RING / 2}
            cy={RING / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="butt"
            strokeDasharray={`${share * RING_LENGTH} ${RING_LENGTH}`}
            className={arc}
          />
        ) : null}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">
        {complete ? (
          <Check className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={3} />
        ) : (
          <span className={`text-xs font-semibold leading-none tabular-nums ${text}`}>
            {missing}
          </span>
        )}
      </span>
    </span>
  );
}

export function MissingInfoBadge({
  missing,
  bank,
}: {
  missing: string[] | null | undefined;
  /** `submissions.missing_bank`. */
  bank?: string[] | null | undefined;
}) {
  const required = useUploadedRequiredFields();
  const core = missing ?? [];
  const banking = bank ?? [];
  if (core.length === 0 && banking.length === 0) return null;

  const title = [
    core.length > 0 ? `Missing: ${core.join(", ")}` : null,
    banking.length > 0 ? `Bank: ${banking.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
  const label = `Missing ${core.length} required ${core.length === 1 ? "field" : "fields"} and ${banking.length} banking ${banking.length === 1 ? "field" : "fields"}`;

  // Until the list arrives there is no total to fill a ring against. If it cannot
  // be read at all, say so with the counts instead of drawing nothing.
  if (!required.data) {
    if (!required.isError) return null;
    return (
      <span
        role="img"
        aria-label={label}
        title={title}
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[0.66rem] tabular-nums"
      >
        <span className="text-accent">{core.length}</span>
        <span className="text-muted-foreground">/ {banking.length}</span>
      </span>
    );
  }

  const coreTotal = required.data.filter((field) => field.grp === "core").length;
  const bankTotal = required.data.filter((field) => field.grp === "bank").length;

  return (
    <span
      role="img"
      aria-label={label}
      title={title}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap align-middle"
    >
      <FillRing missing={core.length} total={coreTotal} tone="accent" />
      <FillRing missing={banking.length} total={bankTotal} tone="muted" />
    </span>
  );
}

export function MissingInfoSection({
  submissionId,
  missing,
  missingBank,
  editable = false,
  onSaved,
}: {
  submissionId: string;
  /** `submissions.missing_info` for this lead. */
  missing: string[] | null | undefined;
  /** `submissions.missing_bank` for this lead. */
  missingBank?: string[] | null | undefined;
  /** Whoever may call `update_payload_field` on this lead gets the core inputs. */
  editable?: boolean;
  /** Fired after a confirmed write, so the lead refetches and the row leaves. */
  onSaved?: () => void;
}) {
  const { profile } = useAuth();
  const core = missing ?? [];
  const bank = missingBank ?? [];
  if (core.length === 0 && bank.length === 0) return null;

  // Bank details are entered only by the roles `update_payment_field` accepts —
  // a closing manager can edit a payload but is refused here, so showing them
  // inputs would only hand them an error.
  const canEditBank = editable && !!profile && BANK_EDIT_ROLES.has(profile.role);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {core.length > 0 ? (
        <MissingGroup
          title="Missing information"
          note="This uploaded lead has no value for these required fields."
          submissionId={submissionId}
          labels={core}
          editable={editable}
          {...(onSaved ? { onSaved } : {})}
        />
      ) : null}
      {bank.length > 0 ? (
        <MissingGroup
          title="Missing bank information"
          note={
            canEditBank
              ? "Required banking fields this lead does not have."
              : "Required banking fields this lead does not have. Only an admin, manager or general manager can enter them."
          }
          // Said once, plainly: this list only ever holds REQUIRED fields, so the
          // optional card ones never appear as inputs here. It used to sit in the
          // sentence before "Fill them in here", which read as an offer to fill
          // those in.
          footnote="Card number, expiry and CVC are optional, so they are not listed here."
          submissionId={submissionId}
          labels={bank}
          editable={canEditBank}
          {...(onSaved ? { onSaved } : {})}
        />
      ) : null}
    </div>
  );
}

function MissingGroup({
  title,
  note,
  footnote,
  submissionId,
  labels,
  editable,
  onSaved,
}: {
  title: string;
  note: string;
  footnote?: string;
  submissionId: string;
  labels: string[];
  editable: boolean;
  onSaved?: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="panel-title">
        {title} ({labels.length})
      </h3>
      <p className="text-[0.66rem] text-muted-foreground">
        {note}
        {editable ? " Fill them in here; each is saved on its own." : ""}
      </p>
      <ul className="min-w-0 divide-y divide-border rounded-md border border-border">
        {labels.map((label) => (
          <li key={label} className="flex flex-col gap-1.5 px-3 py-2">
            {editable ? (
              <MissingField
                submissionId={submissionId}
                label={label}
                {...(onSaved ? { onSaved } : {})}
              />
            ) : (
              <span className="field-label">{payloadDisplayLabel(label)}</span>
            )}
          </li>
        ))}
      </ul>
      {footnote ? <p className="text-[0.66rem] text-muted-foreground">{footnote}</p> : null}
    </div>
  );
}

function MissingField({
  submissionId,
  label,
  onSaved,
}: {
  submissionId: string;
  label: string;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const field = FIELD_BY_LABEL.get(label);
  const type = field?.type ?? "text";
  const column = PAYMENT_COLUMN[label];
  const id = `missing-${submissionId}-${label.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;

  const save = useMutation({
    mutationFn: async (value: string) => {
      if (column) {
        const { error } = await supabase.rpc("update_payment_field", {
          p_sub: submissionId,
          p_field: column,
          p_value: value,
        });
        if (error) throw error;
        return;
      }
      const { error } = await supabase.rpc("update_payload_field", {
        p_sub: submissionId,
        p_field: label,
        p_value: value,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${payloadDisplayLabel(label)} saved`);
      // The banking panel reads the same cache entry as a payment correction.
      if (column) queryClient.invalidateQueries({ queryKey: paymentSummaryKey(submissionId) });
      onSaved?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const value = draft.trim();

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="field-label">
        {payloadDisplayLabel(label)}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {type === "radio" ? (
          <div id={id} className="flex flex-wrap gap-1.5">
            {field?.options?.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={draft === option}
                disabled={save.isPending}
                onClick={() => setDraft(draft === option ? "" : option)}
                className={draft === option ? "chip chip-active" : "chip"}
              >
                {option}
              </button>
            ))}
          </div>
        ) : (
          <input
            id={id}
            type={type === "date" ? "date" : "text"}
            inputMode={type === "number" ? "numeric" : undefined}
            value={draft}
            disabled={save.isPending}
            onChange={(event) => setDraft(event.target.value)}
            className="field-input min-w-0 flex-1"
            autoComplete="off"
          />
        )}
        <button
          type="button"
          className="chip px-2.5 py-0.5 text-[0.66rem]"
          disabled={save.isPending || !value}
          onClick={() => save.mutate(value)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
