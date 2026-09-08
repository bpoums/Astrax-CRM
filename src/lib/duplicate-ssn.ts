import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { relativeTime } from "@/components/ops";
import { digitsOf } from "@/lib/normalize/text";
import type { FieldWarning } from "@/lib/form-warnings";

/**
 * "Has this SSN been sold before?", asked live on the intake forms.
 *
 * ADVISORY, exactly like every other check in `form-warnings.ts`, and for the
 * same reason: a repeat SSN is often a legitimate re-write after a decline, and
 * refusing the submission would lose a lead over a guess. Nothing here is
 * consulted by the submit path, and a failed lookup is silent — an advisory aid
 * that goes down must not become a gate.
 *
 * It lives here rather than in `form-warnings.ts` because that file is
 * deliberately pure: no I/O, no React, every rule shared with the uploader. This
 * one is a round trip and a hook, so it stays out of there and only borrows the
 * `FieldWarning` shape so both kinds of hint render through the same code.
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

type DuplicateHit = { status: DuplicateStatus; submittedAt: string };

const STATUSES: DuplicateStatus[] = ["accepted", "declined", "in_progress"];

function isStatus(value: unknown): value is DuplicateStatus {
  return typeof value === "string" && STATUSES.includes(value as DuplicateStatus);
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
  return { status, submittedAt };
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
export function duplicateSsnWarning(hit: DuplicateHit | null, now: number): FieldWarning | null {
  if (!hit) return null;
  const when = relativeTime(hit.submittedAt, now);

  switch (hit.status) {
    case "accepted":
      return {
        tone: "danger",
        text: `⚠ This SSN already belongs to an accepted lead (submitted ${when}). This may be a duplicate sale.`,
      };
    case "declined":
      return {
        tone: "warn",
        text: `This SSN was previously declined (${when}). You may still proceed — a different carrier may accept it.`,
      };
    case "in_progress":
      return {
        tone: "warn",
        text: `This SSN is already on a lead currently in progress (${when}).`,
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
