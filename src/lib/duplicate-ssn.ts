import { createElement, Fragment, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { dispositionLabel, relativeTime } from "@/components/ops";
import { digitsOf } from "@/lib/normalize/text";

/**
 * "Has this SSN been sold before?", asked live on the intake forms.
 *
 * This hint is now a preview of a REAL gate for one case, not just an FYI:
 * `submit_form_internal` blocks the actual submission (both the closer's
 * forms and the validator's own direct submit) when the SSN matches another
 * non-archived ACCEPTED lead, unless a CX agent has tagged that existing
 * policy as eligible for a second one (see `SubmissionTags`,
 * `docs/decisions/0007-duplicate-ssn-blocks-unless-tagged.md`). A declined or
 * still-in-progress duplicate is unchanged — advisory only, never blocks,
 * for the original reason: a repeat SSN there is often a legitimate re-write.
 * This hook still never fires the RPC itself and a failed lookup stays
 * silent — the block is enforced server-side regardless of whether this
 * hint loads.
 *
 * It lives here rather than in `form-warnings.ts` because that file is
 * deliberately pure: no I/O, no React, every rule shared with the uploader. This
 * one is a round trip and a hook, so it stays out of there. Its hint shape
 * mirrors `FieldWarning` (`{ tone, text }`) so both kinds render through the
 * same code in `closer-form.tsx`, but `text` here is a `ReactNode` rather than
 * a plain string — it needs to colour the outcome word (Submitted/Declined)
 * inside the sentence, which a pure string can't do.
 *
 * `check_duplicate_ssn` returns the collapsed status and nothing else — no
 * name, no phone, no lead id. That is the design, not an omission: a closer
 * needs to know a number has been seen, not whose it was. Do not go looking for
 * the other lead through another query.
 */

/** The SSN field's label in both forms, which is also its payload key. */
export const SSN_FIELD = "SSN Number";

/** A full SSN, which is the only thing worth asking the database about. */
const SSN_LENGTH = 9;

type DuplicateStatus = "accepted" | "declined" | "in_progress";

type DuplicateHit = { status: DuplicateStatus; submittedAt: string; exempt: boolean };

const STATUSES: DuplicateStatus[] = ["accepted", "declined", "in_progress"];

function isStatus(value: unknown): value is DuplicateStatus {
  return typeof value === "string" && STATUSES.includes(value as DuplicateStatus);
}

export type DuplicateSsnHint = { tone: "warn" | "danger" | "ok"; text: ReactNode };

/**
 * The outcome word inside the sentence, coloured the same way the rest of the
 * app marks that outcome: emerald for Submitted (the one hardcoded exception
 * to amber-only, shared with `DispositionBadge` in `ops.tsx`), destructive
 * red for Declined — that token already exists, so no new colour is added.
 */
function outcomeWord(label: string, tone: "submitted" | "declined") {
  return createElement(
    "span",
    { className: tone === "submitted" ? "text-emerald-600" : "text-destructive" },
    label,
  );
}

/**
 * The RPC returns `Json`, so the shape is checked rather than asserted.
 *
 * "No duplicate" and "could not tell" collapse to the same `null` on purpose:
 * both mean there is nothing to say to the closer, and keeping them apart would
 * only invite a caller to render something on the failure case.
 */
function readHit(data: unknown): DuplicateHit | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (row["exists"] !== true) return null;

  const status = row["status"];
  const submittedAt = row["submitted_at"];
  if (!isStatus(status) || typeof submittedAt !== "string") return null;
  return { status, submittedAt, exempt: row["exempt"] === true };
}

/**
 * What to say about a hit.
 *
 * One step louder for an accepted lead, because that is the case with money
 * attached — the same number already sold is the thing a closer has to stop and
 * check. A decline is the opposite: it is normal, it is often why this call is
 * happening at all, and the wording says so rather than implying a problem.
 *
 * `relativeTime` measures the gap between two instants, so unlike a calendar
 * date it needs no Pacific conversion to be true.
 */
export function duplicateSsnWarning(
  hit: DuplicateHit | null,
  now: number,
): DuplicateSsnHint | null {
  if (!hit) return null;
  const when = relativeTime(hit.submittedAt, now);

  // Only an accepted duplicate actually blocks submission (see
  // `submit_form_internal`), so `exempt` only ever matters here.
  if (hit.status === "accepted" && hit.exempt) {
    return {
      tone: "ok",
      text: "CX has cleared this SSN for a second policy — submitting is allowed.",
    };
  }

  switch (hit.status) {
    case "accepted":
      return {
        tone: "danger",
        text: createElement(
          Fragment,
          null,
          "⚠ This SSN already belongs to a lead marked ",
          outcomeWord(dispositionLabel("accepted") ?? "Submitted", "submitted"),
          ` (submitted ${when}). Submitting will be blocked — ask a CX agent to tag the original policy as eligible for a second policy first.`,
        ),
      };
    case "declined":
      return {
        tone: "warn",
        text: createElement(
          Fragment,
          null,
          "This SSN was previously marked ",
          outcomeWord(dispositionLabel("declined") ?? "Declined", "declined"),
          ` (${when}). You may still proceed — a different carrier may accept it.`,
        ),
      };
    case "in_progress":
      return {
        tone: "warn",
        text: `This SSN is already on a lead currently marked In Progress (${when}).`,
      };
  }
}

/**
 * The lookup, driven by blur rather than by the value.
 *
 * Keying the query on a separate `checked` string is what keeps this off the
 * keystroke path. Typing nine digits asks nothing; `check()` on blur moves them
 * into `checked` and that is what runs the query. The React Query cache does
 * the rest of the guarding for free — blurring twice without editing produces
 * the same key, so it is answered from memory rather than re-queried.
 *
 * The warning is then tied back to what is actually in the box: a hit is
 * returned only while the field still holds the digits it was about, so editing
 * after a check clears the message instead of leaving it to describe a number
 * that is no longer there.
 */
export function useDuplicateSsn(value: string) {
  const [checked, setChecked] = useState("");

  const query = useQuery({
    queryKey: ["duplicate-ssn", checked],
    enabled: checked.length === SSN_LENGTH,
    // The lead being reported already exists and will not change while this
    // form is open, so one answer per SSN is all this ever needs.
    staleTime: Infinity,
    // Fail silent: one attempt, and a failure leaves `data` undefined, which
    // reads as "nothing to say" rather than as a problem to show.
    retry: false,
    queryFn: async () => {
      // The raw field value would do — the function normalises dashes itself —
      // but the digits are what the key is built from, so they are what is sent.
      const { data, error } = await supabase.rpc("check_duplicate_ssn", { p_ssn: checked });
      if (error) throw error;
      return readHit(data);
    },
  });

  return {
    /**
     * Call on blur. Anything short of a whole SSN asks nothing and clears the
     * previous answer, so a half-deleted number never keeps an old warning up.
     */
    check: (next: string) => {
      const digits = digitsOf(next);
      setChecked(digits.length === SSN_LENGTH ? digits : "");
    },
    hit: query.data && digitsOf(value) === checked ? query.data : null,
  };
}
