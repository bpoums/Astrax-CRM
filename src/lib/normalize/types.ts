/**
 * Shared vocabulary for the lead normalisation engine.
 *
 * Everything under src/lib/normalize is pure: no I/O, no React, no browser
 * globals. It runs unchanged in the browser, in Node under Vitest, and later
 * in a Deno edge function.
 */

/** What a detector recognises in a cell, independent of the column header. */
export type DetectorKind =
  | "ssn"
  | "routing"
  | "account"
  | "card"
  | "expiry"
  | "cvv"
  | "date"
  | "currency"
  | "phone"
  | "zip"
  | "state"
  | "email"
  | "name"
  | "carrier"
  | "bank"
  | "text";

/**
 * clean  — the value arrived usable and was passed through
 * fixed  — the value was rewritten into canonical shape; `raw` holds the original
 * review — the value could not be resolved safely and a human must look
 */
export type FieldStatus = "clean" | "fixed" | "review";

/** The result of normalising one value. */
export type Normalized = {
  value: string;
  status: FieldStatus;
  note?: string;
};

/** Where a canonical field ends up once the lead is imported. */
export type FieldTarget = "payload" | "payment";

export type PaymentKey =
  | "bank_name"
  | "routing_number"
  | "account_number"
  | "account_title"
  | "card_number"
  | "card_exp"
  | "cvv";

/**
 * One canonical destination field. The catalog is derived from the closer form
 * definition (see src/lib/canonical-fields.ts) and handed to the engine as
 * data, which is what keeps this module free of app imports.
 */
export type CanonicalField = {
  /** Stable machine key, e.g. "full_name". */
  key: string;
  /** The jsonb payload key — and therefore the Sheet column header. */
  label: string;
  kind: DetectorKind;
  target: FieldTarget;
  /** Set on every field with target 'payment'. */
  paymentKey?: PaymentKey;
  /** Extra header spellings that should map here. */
  aliases?: string[];
  options?: string[];
  /** Date fields that are a date of birth get the 18-100 plausibility check. */
  birthDate?: boolean;
  /**
   * The field a value of this kind lands on when it is detected in a cell
   * mapped to something else. Three columns hold a state and two hold an
   * amount, so the catalog has to say which one is the default.
   */
  donate?: boolean;
};

/** A value resolved onto a canonical field. */
export type LeadField = {
  key: string;
  label: string;
  value: string;
  /** Exactly what the spreadsheet cell held, kept for tooltips and re-parsing. */
  raw: string;
  status: FieldStatus;
  note?: string;
  /** The header the value came out of, for disagreement messages. */
  header?: string;
};

/** Carried into submissions.data_flags verbatim. */
export type LeadFlag = {
  field: string;
  issue: string;
  raw: string;
};

export type PaymentType = "card" | "draft" | "unknown";

export type PaymentInstrument = {
  payment_type: PaymentType;
  bank_name: string | null;
  routing_number: string | null;
  account_number: string | null;
  account_title: string | null;
  card_number: string | null;
  card_last4: string | null;
  card_exp: string | null;
  cvv: string | null;
};

export type Lead = {
  /** Index of the source row, 0-based over data rows. */
  index: number;
  fields: Record<string, LeadField>;
  flags: LeadFlag[];
  payment: PaymentInstrument;
  /** Raw cells keyed by header — needed for "re-parse this cell". */
  raw: Record<string, string>;
  /** Ids of other leads this one collides with. */
  duplicateOf: number[];
};
