import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { dispositionLabel, relativeTime } from "@/components/ops";
import { digitsOf } from "@/lib/normalize/text";

/**
 * "Has this account number been on a lead before?", asked live on the closer
 * form's Account Number field.
 *
 * ADVISORY ONLY, and that is the whole contract. Unlike the SSN check, nothing
 * on the submit path reads this — `submit_form_internal` is untouched — so a
 * duplicate can never block anything, and this hook offers no way to. The
 * warning's tone is always "warn", never "danger", and its wording says the
 * closer may still go ahead.
 *
 * Same shape as `duplicate-ssn.ts`, deliberately: driven by blur rather than by
 * keystroke, answered from the React Query cache when the same number is blurred
 * twice, and silent on failure (a failed lookup reads as "nothing to say").
 *
 * `check_duplicate_account` returns a count, the latest outcome and when — no
 * name, phone, bank or lead id. A closer needs to know the number has been seen,
 * not whose it was. Do not go looking for the other lead through another query.
 */

/** The Account Number field's label, which is also its payload key. */
export const ACCOUNT_FIELD = "Account Number";

/** Below this many digits it is not an account number worth asking about. */
const MIN_DIGITS = 6;

type DuplicateStatus = "accepted" | "declined" | "in_progress";

type DuplicateAccountHit = { count: number; status: DuplicateStatus; submittedAt: string };

const STATUSES: DuplicateStatus[] = ["accepted", "declined", "in_progress"];

function isStatus(value: unknown): value is DuplicateStatus {
  return typeof value === "string" && STATUSES.includes(value as DuplicateStatus);
}

export type DuplicateAccountHint = { tone: "warn"; text: string };

/**
 * The RPC returns `Json`, so the shape is checked rather than asserted. "No
 * duplicate" and "could not tell" both come out as `null`: both mean there is
 * nothing to say.
 */
function readHit(data: unknown): DuplicateAccountHit | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (row["exists"] !== true) return null;

  const count = row["count"];
  const status = row["status"];
  const submittedAt = row["submitted_at"];
  if (typeof count !== "number" || !isStatus(status) || typeof submittedAt !== "string") {
    return null;
  }
  return { count, status, submittedAt };
}

/** The outcome as the app words it everywhere else ("Submit", never "accepted"). */
function outcomeText(status: DuplicateStatus) {
  if (status === "in_progress") return "In Progress";
  return dispositionLabel(status) ?? status;
}

/**
 * What to say about a hit. Always a warning, never a stop: a repeat account
 * number is sometimes a genuine re-write, a family account, or a coincidence
 * between two banks, so the wording states a fact and leaves the decision alone.
 */
export function duplicateAccountWarning(
  hit: DuplicateAccountHit | null,
  now: number,
): DuplicateAccountHint | null {
  if (!hit) return null;
  const where = hit.count === 1 ? "another lead" : `${hit.count} other leads`;
  return {
    tone: "warn",
    text: `This account number is already on ${where} (latest: ${outcomeText(hit.status)}, ${relativeTime(hit.submittedAt, now)}). You can still submit.`,
  };
}

/**
 * The lookup, driven by blur rather than by the value — see `useDuplicateSsn`,
 * which this mirrors. The hit is returned only while the field still holds the
 * digits it was about, so editing after a check clears the message instead of
 * leaving it to describe a number that is no longer there.
 */
export function useDuplicateAccount(value: string) {
  const [checked, setChecked] = useState("");

  const query = useQuery({
    queryKey: ["duplicate-account", checked],
    enabled: checked.length >= MIN_DIGITS,
    // The lead being reported already exists and will not change while this form
    // is open, so one answer per number is all this ever needs.
    staleTime: Infinity,
    // Fail silent: one attempt, and a failure leaves `data` undefined.
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("check_duplicate_account", {
        p_account: checked,
      });
      if (error) throw error;
      return readHit(data);
    },
  });

  return {
    /** Call on blur. Anything too short asks nothing and clears the previous answer. */
    check: (next: string) => {
      const digits = digitsOf(next);
      setChecked(digits.length >= MIN_DIGITS ? digits : "");
    },
    hit: query.data && digitsOf(value) === checked ? query.data : null,
  };
}
