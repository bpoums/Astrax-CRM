import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SECTIONS, type Field } from "@/components/closer-form";
import { PayloadTable, orderedPayloadEntries, payloadDisplayLabel } from "@/components/ops";

/**
 * A lead's payload — read-only for everyone, editable for a manager or admin.
 *
 * Reading and editing are one component on purpose: the values a manager is
 * looking at and the values they are correcting have to be the same list, in
 * the same order. That order is not cosmetic — the payload keys are the Google
 * Sheet column headers, so the panel renders whatever keys the row actually
 * carries rather than a form definition. An imported lead and a closer form
 * therefore both show exactly what is stored.
 *
 * The write goes through `update_payload_field`, one call per changed field —
 * the only path that records what a value was before it changed. Nothing here
 * replaces the payload wholesale, so two managers editing different fields of
 * the same lead cannot overwrite one another.
 */

// The closer form is the only place that knows a value is a date, a paragraph
// or one of a fixed set of choices. Keyed by label, because the label IS the
// payload key. A key the form has never heard of — an imported column, a
// validator-form field — falls through to a plain text input.
const FIELD_BY_LABEL = new Map<string, Field>(
  SECTIONS.flatMap((section) => section.fields).map((field) => [field.label, field]),
);

/**
 * Stamped by `submit_form`: who entered the lead, not what it says.
 * `update_payload_field` raises on either of them, so they are shown here but
 * never offered as inputs.
 */
const LOCKED_KEYS = new Set(["ID", "Submitted By Role"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

export function LeadPayload({
  submissionId,
  payload,
  editable = false,
  onSaved,
}: {
  submissionId: string;
  payload: Record<string, unknown>;
  /** Managers and admins get the editor; everyone else reads. */
  editable?: boolean;
  onSaved?: () => void;
}) {
  // Held as an id rather than a boolean so that selecting a different lead
  // drops the editor and its half-typed draft instead of carrying them over.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const editing = editable && editingId === submissionId;

  // The one shared order, so the read-only panel and this editor list a
  // lead identically rather than each following the payload's own key order.
  const entries = orderedPayloadEntries(payload);

  /**
   * One `update_payload_field` call per changed field.
   *
   * The bulk patch RPC this used to call wrote the payload and an event naming
   * the fields, but no before/after pair — which is why `payload_edits` was
   * empty while `payload_edited` events piled up. That RPC is the only path
   * that could write a payload without recording what it replaced, so nothing
   * calls it any more.
   *
   * A loop rather than one call, so a single field the server refuses — a
   * system-stamped key, an archived lead — does not take the rest of the edit
   * with it. The fields that did save are already committed and audited; the
   * editor stays open on a partial failure so the rest can be retried.
   */
  const save = useMutation({
    mutationFn: async (patch: Record<string, string>) => {
      const failures: string[] = [];
      for (const [field, value] of Object.entries(patch)) {
        const { error } = await supabase.rpc("update_payload_field", {
          p_sub: submissionId,
          p_field: field,
          p_value: value,
        });
        // The RPC raises its own wording and names the field it refused; keep
        // it, and say which field it belonged to.
        if (error) failures.push(`${field}: ${error.message}`);
      }
      const saved = Object.keys(patch).length - failures.length;
      if (saved === 0) throw new Error(failures[0] ?? "Could not save");
      return { saved, failures };
    },
    onSuccess: (result) => {
      toast.success(result.saved === 1 ? "Lead updated" : `${result.saved} fields updated`);
      if (result.failures.length > 0) {
        toast.error(result.failures[0] ?? "Some fields could not be saved");
      } else {
        setEditingId(null);
      }
      onSaved?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function startEditing() {
    setDraft(Object.fromEntries(entries.map(([key, value]) => [key, text(value)])));
    setEditingId(submissionId);
  }

  function submit() {
    // Only what actually changed is sent. Everything else keeps the JSON type
    // it was stored with — an imported number does not silently become a string
    // because the manager opened the editor and saved.
    const patch = Object.fromEntries(
      entries
        .filter(([key]) => !LOCKED_KEYS.has(key))
        .filter(([key, value]) => (draft[key] ?? "") !== text(value))
        .map(([key]) => [key, draft[key] ?? ""]),
    );

    if (Object.keys(patch).length === 0) {
      toast.info("Nothing changed");
      setEditingId(null);
      return;
    }
    save.mutate(patch);
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="panel-title">Lead details</h3>
          {editable ? (
            <button
              type="button"
              className="chip px-2.5 py-0.5 text-[0.66rem]"
              onClick={startEditing}
            >
              Edit
            </button>
          ) : null}
        </div>
        <PayloadTable payload={payload} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="panel-title">Editing lead</h3>
        <span className="text-[0.66rem] text-muted-foreground">
          Changes are recorded against your name
        </span>
      </div>

      <div className="grid grid-cols-1 gap-x-3 gap-y-2 rounded-md border border-border p-3 sm:grid-cols-2">
        {entries.map(([key, value]) =>
          LOCKED_KEYS.has(key) ? (
            <LockedField key={key} label={key} value={text(value)} />
          ) : (
            <EditField
              key={key}
              label={key}
              value={draft[key] ?? ""}
              onChange={(next) => setDraft((prev) => ({ ...prev, [key]: next }))}
            />
          ),
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-submit" disabled={save.isPending} onClick={submit}>
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          className="chip"
          disabled={save.isPending}
          onClick={() => setEditingId(null)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function LockedField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      {/* `label` stays the stored key everywhere it is used as one — this is
          only the word on screen. See payloadDisplayLabel. */}
      <span className="field-label">{payloadDisplayLabel(label)}</span>
      <span className="text-xs text-muted-foreground">{value || "—"}</span>
    </div>
  );
}

function EditField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `lead-${label.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
  const field = FIELD_BY_LABEL.get(label);
  const type = field?.type ?? "text";

  // A date picker only accepts YYYY-MM-DD. Imported leads normalise to
  // MM/DD/YYYY, which a date input renders as empty — and an empty date input
  // is one careless save away from wiping the value. Anything it cannot hold
  // is edited as text.
  const asDate = type === "date" && (value === "" || ISO_DATE.test(value));

  return (
    <div className={`flex flex-col gap-1 ${field?.span ?? ""}`}>
      <label htmlFor={id} className="field-label">
        {payloadDisplayLabel(label)}
      </label>

      {type === "textarea" ? (
        <textarea
          id={id}
          rows={2}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="field-input resize-none"
        />
      ) : type === "radio" ? (
        <div className="flex flex-wrap gap-1.5">
          {field?.options?.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onChange(value === option ? "" : option)}
              aria-pressed={value === option}
              className={value === option ? "chip chip-active" : "chip"}
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
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="field-input"
          autoComplete="off"
        />
      )}
    </div>
  );
}
