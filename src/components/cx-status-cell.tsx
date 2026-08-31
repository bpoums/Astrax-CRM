import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  STATUS_TONE_CLASS,
  readStatusTone,
  shortCategory,
  type CxCategory,
  type CxStatusOption,
  type StatusTone,
} from "@/lib/cx-status";
import { shortDate } from "@/components/ops";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipBody, TooltipHeading } from "@/components/free-text";

/**
 * One of a lead's four statuses: the current value, the reason behind it, and
 * the dropdown that changes both.
 *
 * The reason is part of setting a status, not a separate step — picking a value
 * opens a reason box before anything is written, so a status and the reason for
 * it are always committed together. It is then rendered underneath the chip
 * rather than hidden in a tooltip, because the reason is the thing the CXA is
 * actually scanning for.
 */

/**
 * `set_cx_status` takes a null option id to clear a status, and the type
 * generator cannot express a nullable function argument — it emits
 * `p_option_id: string`. The cast is here, at the one call site, rather than by
 * hand-editing the generated file.
 */
type SetStatusArgs = {
  p_sub: string;
  p_category: string;
  p_option_id: string;
  p_reason?: string;
};

export function StatusChip({
  label,
  tone,
  muted,
}: {
  label: string;
  tone: StatusTone;
  muted?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.66rem] font-medium ${
        muted ? "border-dashed border-border text-muted-foreground" : STATUS_TONE_CLASS[tone]
      }`}
    >
      {label}
    </span>
  );
}

/**
 * The value of one status: its chip, the reason underneath, and a tooltip that
 * says who decided it.
 *
 * Rendered on its own wherever the status is read but not changed — the admin's
 * pipeline view — and inside the trigger when it is editable, so the two read
 * identically.
 *
 * The trigger is a span, not the default button: this is rendered inside the
 * popover trigger button when the status is editable, and a button inside a
 * button is invalid markup.
 */
export function CxStatusValue({
  category,
  label,
  tone,
  reason,
  updatedBy,
  updatedAt,
}: {
  category: CxCategory;
  label: string | null;
  tone: string | null;
  reason: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
}) {
  const body = (
    <span className="flex w-full min-w-0 flex-col items-start gap-0.5">
      {label ? (
        <StatusChip label={label} tone={readStatusTone(tone)} />
      ) : (
        <span className="px-1 text-xs text-muted-foreground">—</span>
      )}

      {/* The reason at a glance: one line, truncated to its column, with a rule
          down its left edge so a cell carrying a reason reads differently from
          one that does not without having to be read. The whole of it is in the
          tooltip. */}
      {reason ? (
        <span className="free-text block w-full max-w-full truncate border-l-2 border-accent/50 pl-1.5 text-[0.62rem] italic text-muted-foreground">
          {reason}
        </span>
      ) : null}
    </span>
  );

  // Nothing set and nothing said: an empty tooltip would be worse than none.
  if (!label && !reason) return body;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <CxStatusTooltip
        heading={`${shortCategory(category)}${label ? ` \u00b7 ${label}` : ""}`}
        updatedBy={updatedBy ?? null}
        updatedAt={updatedAt ?? null}
        reason={reason}
      />
    </Tooltip>
  );
}

/**
 * The tooltip body, styled to the panel rather than shadcn's default amber
 * `bg-primary` block.
 *
 * It answers the question someone actually has when they hover a status: not
 * just what the reason says, but which status it belongs to and who decided it.
 *
 * The attribution is the lead's last CX update (`cx_updated_by` /
 * `cx_updated_at`) — the view records it per lead, not per status — so it is
 * labelled "last updated by" rather than claiming to attribute this one field.
 */
export function CxStatusTooltip({
  heading,
  updatedBy,
  updatedAt,
  reason,
}: {
  heading: string;
  updatedBy: string | null;
  updatedAt: string | null;
  reason: string | null;
}) {
  return (
    <TooltipBody>
      <TooltipHeading>{heading}</TooltipHeading>
      {updatedBy || updatedAt ? (
        <span className="free-text text-[0.62rem] text-muted-foreground">
          last updated by {updatedBy ?? "—"}
          {updatedAt ? `, ${shortDate(updatedAt)}` : ""}
        </span>
      ) : null}
      {reason ? (
        <p className="free-text whitespace-pre-wrap text-xs leading-snug text-foreground">
          {reason}
        </p>
      ) : (
        <p className="text-xs italic text-muted-foreground">No reason recorded.</p>
      )}
    </TooltipBody>
  );
}

export function CxStatusCell({
  submissionId,
  category,
  code,
  label,
  tone,
  reason,
  options,
  updatedBy = null,
  updatedAt = null,
  readOnly = false,
  onSaved,
}: {
  submissionId: string;
  category: CxCategory;
  /** Null when the status has never been set. */
  code: string | null;
  label: string | null;
  tone: string | null;
  reason: string | null;
  /** Active options for THIS category, already sorted. */
  options: CxStatusOption[];
  /** The lead's last CX update, shown as attribution in the tooltip. */
  updatedBy?: string | null;
  updatedAt?: string | null;
  /** Admin views the pipeline but does not work it — setting a status is the CXA's job. */
  readOnly?: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  // null = the option list; set = the reason step for that choice.
  // `{ option: null }` is the reason step for clearing.
  const [picked, setPicked] = useState<{ option: CxStatusOption | null } | null>(null);
  const [draftReason, setDraftReason] = useState("");

  function close() {
    setOpen(false);
    setPicked(null);
    setDraftReason("");
  }

  const save = useMutation({
    mutationFn: async (vars: { optionId: string | null; reason: string }) => {
      const args = {
        p_sub: submissionId,
        p_category: category,
        p_option_id: vars.optionId,
        // Always a string: the RPC does nullif(p_reason, ''), and passing an
        // explicit undefined is what exactOptionalPropertyTypes rejects.
        p_reason: vars.reason,
      } as unknown as SetStatusArgs;

      const { error } = await supabase.rpc("set_cx_status", args);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Status updated");
      close();
      onSaved();
    },
    // The RPC raises its own messages ("not authorized", "lead is not in the
    // customer pipeline", "invalid option for category x").
    onError: (error: Error) => toast.error(error.message),
  });

  function pick(option: CxStatusOption | null) {
    setPicked({ option });
    // Re-picking the value already set means the reason is being edited, so it
    // is carried over. Choosing a different value starts clean — the old reason
    // explained the old value.
    setDraftReason(option && option.code === code ? (reason ?? "") : "");
  }

  const isSet = !!code && !!label;

  // No trigger at all when read-only: an admin should not find a dropdown that
  // refuses them, and the RPC would refuse them anyway.
  if (readOnly) {
    return (
      <div className="flex w-full min-w-0 flex-col items-start gap-0.5 px-1 py-0.5">
        <CxStatusValue
          category={category}
          label={label}
          tone={tone}
          reason={reason}
          updatedBy={updatedBy}
          updatedAt={updatedAt}
        />
      </div>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          // The reason is only visible in full on hover, so it belongs in the
          // accessible name too.
          aria-label={`${category} status${isSet ? `: ${label}` : ", not set"}${
            reason ? `. Reason: ${reason}` : ""
          }`}
        >
          <CxStatusValue
            category={category}
            label={label}
            tone={tone}
            reason={reason}
            updatedBy={updatedBy}
            updatedAt={updatedAt}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-64 p-2">
        {picked === null ? (
          <div className="flex flex-col gap-1">
            <span className="field-label px-1">Set status</span>
            <div className="flex flex-col gap-0.5">
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => pick(option)}
                  className={`flex items-center justify-between gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-accent/10 ${
                    option.code === code ? "bg-accent/10" : ""
                  }`}
                >
                  <StatusChip label={option.label} tone={option.tone} />
                  {option.code === code ? (
                    <span className="text-[0.62rem] text-muted-foreground">current</span>
                  ) : null}
                </button>
              ))}
              {options.length === 0 ? (
                <span className="px-1 py-1 text-xs text-muted-foreground">
                  No options defined for this category.
                </span>
              ) : null}
            </div>

            {isSet ? (
              <button
                type="button"
                onClick={() => pick(null)}
                className="mt-1 rounded border-t border-border px-1 pt-1.5 text-left text-[0.66rem] text-muted-foreground hover:text-foreground"
              >
                Clear this status
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <span className="field-label">
                {picked.option ? "Setting to" : "Clearing status"}
              </span>
              {picked.option ? (
                <StatusChip label={picked.option.label} tone={picked.option.tone} />
              ) : (
                <StatusChip label="Not set" tone="muted" muted />
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={`reason-${submissionId}-${category}`} className="field-label">
                Reason (optional)
              </label>
              <input
                id={`reason-${submissionId}-${category}`}
                value={draftReason}
                onChange={(event) => setDraftReason(event.target.value)}
                className="field-input"
                // Generous for a sentence, short of anything that could break a
                // layout. Constrained at entry as well as at display.
                maxLength={500}
                autoComplete="off"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !save.isPending) {
                    event.preventDefault();
                    save.mutate({
                      optionId: picked.option?.id ?? null,
                      reason: draftReason.trim(),
                    });
                  }
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-submit"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    optionId: picked.option?.id ?? null,
                    reason: draftReason.trim(),
                  })
                }
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="chip"
                disabled={save.isPending}
                onClick={() => {
                  setPicked(null);
                  setDraftReason("");
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
