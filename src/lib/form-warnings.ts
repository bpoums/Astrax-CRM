import {
  cardBrand,
  expiryProblem,
  isAbaRouting,
  isLuhn,
  normalizeState,
  ssnProblem,
} from "@/lib/normalize/rules";
import { STATE_ABBREVIATIONS, stateForZip } from "@/lib/normalize/states";
import { STATE_FIELDS } from "@/lib/field-mask";
import { digitsOf } from "@/lib/normalize/text";

/**
 * Inline warnings for the intake forms.
 *
 * This file holds NO validation logic. Every check is the one already written
 * and tested in the normaliser and shared with the uploader tool — this only
 * decides what to say about the result, in wording meant for a closer on a live
 * call rather than for someone reviewing an import.
 *
 * These are warnings, never blocks. Nothing here is consulted by the submit
 * path: a customer may be reading back something unusual but correct, and
 * refusing the submission would lose the lead. The form submits either way.
 */

export type FieldWarning = {
  /**
   * `warn` is amber and advisory, `ok` confirms a check passed, and `danger`
   * is the one step louder — reserved for something that will actually fail if
   * it goes out as typed, like a draft scheduled on a Sunday.
   */
  tone: "warn" | "ok" | "danger";
  text: string;
};

/** Labels this module knows how to check. Labels ARE the payload keys. */
const ROUTING = "Routing Number";
const SSN = "SSN Number";
const ZIP = "Customer Zip Code";
const CARD = "Card Number";
const EXPIRY = "Exp Date";
/** The one the ZIP cross-check reads. The other State fields are its own. */
const STATE = "State";

const EXPIRY_TEXT: Record<NonNullable<ReturnType<typeof expiryProblem>>, string> = {
  format: "Expiry should be MM/YY.",
  month: "That isn't a real month — please confirm the expiry.",
  past: "This card has already expired — please confirm the date.",
};

/**
 * A draft scheduled on a weekend, which the bank will not process on the day.
 *
 * Kept out of the switch below and exported on its own, because both forms show
 * it as the date is picked rather than on blur, and the validator form has two
 * draft dates to run it against.
 */
export function draftDateWarning(value: string): FieldWarning | null {
  if (!value.trim()) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getDay() === 6) return { tone: "warn", text: "⚠ It's Saturday" };
  if (date.getDay() === 0) return { tone: "danger", text: "⛔ It's Sunday" };
  return null;
}

/**
 * @param label  the field's label, which is also its payload key
 * @param value  what the closer has typed
 * @param values the whole form, for the checks that need a second field
 */
export function fieldWarning(
  label: string,
  value: string,
  values: Record<string, string>,
  now: Date = new Date(),
): FieldWarning | null {
  // An empty field is not a mistake — it is a field nobody has filled in yet.
  if (!value.trim()) return null;

  switch (label) {
    case ROUTING:
      return routingWarning(value);
    case SSN:
      return ssnWarning(value);
    case ZIP:
      return zipWarning(value, values);
    case CARD:
      return cardWarning(value);
    case EXPIRY:
      return expiryWarning(value, now);
    default:
      // Every State-labelled field in either form, checked against the real
      // USPS list rather than "any two letters".
      return STATE_FIELDS.includes(label as (typeof STATE_FIELDS)[number])
        ? stateWarning(value)
        : null;
  }
}

/**
 * A two-letter code that is not a state.
 *
 * The mask has already reduced whatever was typed to at most two uppercase
 * letters, so the only question left is membership — and a single letter is
 * someone mid-word, not a mistake to interrupt. `STATE_ABBREVIATIONS` is the
 * same set the uploader's `normalizeState` resolves against, so the form and
 * the importer agree on what a state is.
 */
function stateWarning(value: string): FieldWarning | null {
  const code = value.trim().toUpperCase();
  if (code.length < 2) return { tone: "warn", text: "State codes are 2 letters." };
  if (!STATE_ABBREVIATIONS.has(code)) {
    return { tone: "warn", text: `"${code}" isn't a US state code.` };
  }
  return null;
}

/**
 * The positive tick matters here more than anywhere else: a routing number read
 * back over the phone is the single most transcription-prone field on the form,
 * and confirming it landed is the whole point of checking it live.
 */
function routingWarning(value: string): FieldWarning {
  const digits = digitsOf(value);
  if (digits.length !== 9) return { tone: "warn", text: "Routing numbers are 9 digits." };
  if (!isAbaRouting(digits)) {
    return {
      tone: "warn",
      text: "This doesn't look like a valid routing number — please re-read it back to the customer.",
    };
  }
  return { tone: "ok", text: "✓ Routing number checks out" };
}

/** `ssnProblem` already covers the length case, so it answers on its own. */
function ssnWarning(value: string): FieldWarning | null {
  const problem = ssnProblem(digitsOf(value));
  if (!problem) return null;
  return { tone: "warn", text: `This SSN ${problem} — please confirm it with the customer.` };
}

function zipWarning(value: string, values: Record<string, string>): FieldWarning | null {
  const digits = digitsOf(value);
  if (digits.length !== 5) return { tone: "warn", text: "Zip codes are 5 digits." };

  const typedState = (values[STATE] ?? "").trim();
  if (!typedState) return null;

  // Whatever the closer typed — "CA", "calif", "California" — reduced to a code
  // by the same normaliser the importer uses. A value it cannot resolve is not
  // something to contradict them about.
  const state = normalizeState(typedState);
  if (state.status === "review") return null;

  const owner = stateForZip(digits);
  if (owner && owner !== state.value) {
    return { tone: "warn", text: "Zip doesn't match the selected state — please confirm." };
  }
  return null;
}

function cardWarning(value: string): FieldWarning {
  const digits = digitsOf(value);
  if (digits.length < 15 || digits.length > 16) {
    return { tone: "warn", text: "Card numbers are 15 or 16 digits." };
  }
  if (!isLuhn(digits)) {
    return {
      tone: "warn",
      text: "This card number doesn't check out — please confirm the digits.",
    };
  }
  const brand = cardBrand(digits);
  return { tone: "ok", text: brand ? `✓ ${brand}` : "✓ Card number checks out" };
}

function expiryWarning(value: string, now: Date): FieldWarning | null {
  const problem = expiryProblem(value, now);
  if (!problem) return null;
  return { tone: "warn", text: EXPIRY_TEXT[problem] };
}
