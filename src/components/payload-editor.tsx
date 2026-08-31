import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SECTIONS, type Field } from "@/components/closer-form";
import { fieldWarning } from "@/lib/form-warnings";
import { orderedPayloadEntries } from "@/components/ops";

/**
 * The payload as editable fields, one `update_payload_field` call per field.
 *
 * Field-at-a-time rather than a whole-form save: two closing managers working
 * the same lead cannot overwrite one another, and every change lands in
 * `payload_edits` as its own before/after pair. That is also why there is no
 * Save button — the commit point is leaving the field.
 *
 * Nothing here decides whether a value is allowed. `update_payload_field`
 * refuses the server-stamped keys and archived leads and raises its own wording
 * for both; that wording is shown as written rather than replaced with a
 * generic failure. The inline checks are the closer form's own warnings, reused
 * verbatim — advisory, never blocking. A customer really can read back an
 * unusual but correct value, and refusing to record it would be worse than
 * recording it with a note next to it.
 */

// The closer form is the only place that knows a value is a date, a paragraph
// or one of a fixed set of choices. Keyed by label, because the label IS the
// payload key. A key the form has never heard of falls through to plain text.
const FIELD_BY_LABEL = new Map<string, Field>(
  SECTIONS.flatMap((section) => section.fields).map((field) => [field.label, field]),
);

/**
 * Stamped by `submit_form`: who entered the lead, not what it says.
 * `update_payload_field` raises on either of them, so they are shown as values
 * and never offered as inputs.
 */
const LOCKED_KEYS = new Set(["ID", "Submitted By Role"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

export function PayloadEditor({
  submissionId,
  payload,
  onSaved,
}: {
  submissionId: string;
  payload: Record<string, unknown>;
  /** Fired after a confirmed write, so the table and the edit history refetch. */
  onSaved?: () => void;
}) {
  // The one shared order, so the read-only panel and this editor list a
  // lead identically rather than each following the payload's own key order.
  const entries = orderedPayloadEntries(payload);

  // The whole payload as strings — the zip/state cross-check needs a second
  // field to compare against, so a control cannot warn on its own value alone.
  const values = Object.fromEntries(entries.map(([key, value]) => [key, text(value)]));

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">Lead details</h3>
        <span className="text-[0.66rem] text-muted-foreground">Saved when you leave a field</span>
      </div>

      <div className="grid grid-cols-1 gap-x-3 gap-y-2 rounded-md border border-border p-3 sm:grid-cols-2">
        {entries.map(([key, value]) =>
          LOCKED_KEYS.has(key) ? (
            <LockedField key={key} label={key} value={text(value)} />
          ) : (
            <EditableField
              key={key}
              submissionId={submissionId}
              label={key}
              stored={text(value)}
              values={values}
              {...(onSaved ? { onSaved } : {})}
            />
          ),
        )}
        {entries.length === 0 ? (
          <span className="text-xs text-muted-foreground sm:col-span-2">
            This lead has no payload.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LockedField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="field-label">{label}</span>
      <span className="free-text text-xs text-muted-foreground">{value || "—"}</span>
      <span className="text-[0.62rem] text-muted-foreground">Set by the system</span>
    </div>
  );
}

/**
 * One field and its own small write.
 *
 * `saved` is what the database is known to hold; `draft` is what is in the box.
 * They part company only between blur and the RPC settling, and the pending
 * note spells out the value still stored, so nothing on screen claims a change
 * has landed before it has. On failure the box goes back to `saved`.
 */
function EditableField({
  submissionId,
  label,
  stored,
  values,
  onSaved,
}: {
  submissionId: string;
  label: string;
  stored: string;
  values: Record<string, string>;
  onSaved?: () => void;
}) {
  const [saved, setSaved] = useState(stored);
  const [draft, setDraft] = useState(stored);
  const [touched, setTouched] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const clearTick = useRef<number | undefined>(undefined);

  // A refetch after somebody else's edit arrives as a new `stored`. Adopting it
  // unconditionally would discard whatever is being typed, so it is taken only
  // when the box still matches what was last confirmed.
  useEffect(() => {
    setDraft((current) => (current === saved ? stored : current));
    setSaved(stored);
    // `saved` is read, not tracked: this runs when the stored value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, submissionId]);

  useEffect(() => () => window.clearTimeout(clearTick.current), []);

  const save = useMutation({
    mutationFn: async (value: string) => {
      const { error } = await supabase.rpc("update_payload_field", {
        p_sub: submissionId,
        p_field: label,
        p_value: value,
      });
      if (error) throw error;
      return value;
    },
    onSuccess: (value) => {
      setSaved(value);
      setJustSaved(true);
      window.clearTimeout(clearTick.current);
      clearTick.current = window.setTimeout(() => setJustSaved(false), 2000);
      onSaved?.();
    },
    // The RPC raises its own wording — "archived leads cannot be edited",
    // "not authorized", "<field> is set by the system". Show it as written.
    onError: (error: Error) => {
      setDraft(saved);
      toast.error(error.message);
    },
  });

  function commit(value: string) {
    setTouched(true);
    if (value === saved || save.isPending) return;
    save.mutate(value);
  }

  const id = `payload-${submissionId}-${label.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
  const field = FIELD_BY_LABEL.get(label);
  const type = field?.type ?? "text";
  const warning = touched ? fieldWarning(label, draft, { ...values, [label]: draft }) : null;

  // A date picker only accepts YYYY-MM-DD. Imported leads normalise to
  // MM/DD/YYYY, which a date input renders as empty — and an empty date input
  // is one careless blur away from wiping the value. Anything it cannot hold is
  // edited as text.
  const asDate = type === "date" && (draft === "" || ISO_DATE.test(draft));

  return (
    <div className={`flex min-w-0 flex-col gap-1 ${field?.span ?? ""}`}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>

      {type === "textarea" ? (
        <textarea
          id={id}
          rows={2}
          value={draft}
          disabled={save.isPending}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          className="field-input resize-none"
        />
      ) : type === "radio" ? (
        // A chip is a whole answer the moment it is clicked; there is no
        // half-typed state to wait out, so it commits on selection.
        <div className="flex flex-wrap gap-1.5">
          {field?.options?.map((option) => (
            <button
              key={option}
              type="button"
              disabled={save.isPending}
              onClick={() => {
                const next = draft === option ? "" : option;
                setDraft(next);
                commit(next);
              }}
              aria-pressed={draft === option}
              className={draft === option ? "chip chip-active" : "chip"}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <input
          id={id}
          type={asDate ? "date" : "text"}
          inputMode={type === "number" ? "numeric" : undefined}
          value={draft}
          disabled={save.isPending}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          className="field-input"
          autoComplete="off"
        />
      )}

      {save.isPending ? (
        <span className="text-[0.62rem] text-muted-foreground">
          Saving… still stored as {saved ? `“${saved}”` : "empty"}
        </span>
      ) : justSaved ? (
        <span className="text-[0.62rem] text-accent">Saved</span>
      ) : null}

      {warning ? (
        <span
          className={`text-[0.68rem] font-semibold ${
            warning.tone === "warn" ? "text-primary" : "text-muted-foreground"
          }`}
        >
          {warning.text}
        </span>
      ) : null}
    </div>
  );
}
