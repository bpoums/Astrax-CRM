import type { CarrierRef } from "./carriers";
import { detectCell, type Candidate } from "./detect";
import {
  ageFrom,
  last4,
  normalizeAccountNumber,
  normalizeBankName,
  normalizeCard,
  normalizeCarrier,
  normalizeCurrency,
  normalizeCvv,
  normalizeDate,
  normalizeEmail,
  normalizeExpiry,
  normalizeName,
  normalizePhone,
  normalizeRouting,
  normalizeSsn,
  normalizeState,
  normalizeText,
  normalizeZip,
} from "./rules";
import { collapseSpace, digitsOf } from "./text";
import type {
  CanonicalField,
  DetectorKind,
  Lead,
  LeadField,
  LeadFlag,
  Normalized,
  PaymentInstrument,
  PaymentType,
} from "./types";

/** How a kind reads in a flag message. */
const KIND_LABEL: Record<DetectorKind, string> = {
  ssn: "social security number",
  routing: "routing number",
  account: "account number",
  card: "card number",
  expiry: "card expiry",
  cvv: "CVV",
  date: "date",
  currency: "amount",
  phone: "phone number",
  zip: "ZIP code",
  state: "state",
  email: "email address",
  name: "name",
  carrier: "carrier",
  bank: "bank name",
  text: "free text",
};

/**
 * Kinds where a header/content disagreement matters. Free text and names look
 * like everything, so a mismatch there says nothing.
 */
const STRONG: ReadonlySet<DetectorKind> = new Set([
  "ssn",
  "routing",
  "card",
  "expiry",
  "cvv",
  "phone",
  "email",
  "currency",
  "date",
  "zip",
]);

/**
 * Kinds a cell may donate to a field it was not mapped to. Payment instruments
 * and identifiers are unmistakable enough to move on their own; a bare date or
 * ZIP found inside an address column is not, and only moves when an inline
 * label named it.
 */
const FREELY_DONATED: ReadonlySet<DetectorKind> = new Set([
  "card",
  "expiry",
  "cvv",
  "routing",
  "account",
  "ssn",
  "email",
  "phone",
]);

export type Column = { header: string; fieldKey: string | null };

/**
 * Where a detected value goes when the cell it came from was mapped elsewhere.
 * A field marked `donate` claims its kind outright; otherwise the first field
 * of that kind in the catalog does.
 */
function donationTargets(fields: CanonicalField[]) {
  const byKind = new Map<DetectorKind, CanonicalField>();
  for (const field of fields) if (!byKind.has(field.kind)) byKind.set(field.kind, field);
  for (const field of fields) if (field.donate) byKind.set(field.kind, field);
  return byKind;
}

/**
 * What a rule needs beyond the cell itself. `carriers` is the live list from
 * the `carriers` table, threaded down from the upload tool the same way the
 * canonical field catalogue is — this module never fetches it.
 */
type Context = { now: Date; state: string | null; carriers: CarrierRef[] };

/** The options every public entry point takes for the shared context. */
export type NormalizeOptions = { now?: Date; carriers?: CarrierRef[] };

export function normalizeFor(field: CanonicalField, raw: string, context: Context): Normalized {
  switch (field.kind) {
    case "ssn":
      return normalizeSsn(raw);
    case "routing":
      return normalizeRouting(raw);
    case "account":
      return normalizeAccountNumber(raw);
    case "card":
      return normalizeCard(raw);
    case "expiry":
      return normalizeExpiry(raw, context.now);
    case "cvv":
      return normalizeCvv(raw);
    case "date":
      return field.birthDate
        ? normalizeDate(raw, { birthDate: true, now: context.now })
        : normalizeDate(raw, { now: context.now });
    case "currency":
      return normalizeCurrency(raw);
    case "phone":
      return normalizePhone(raw);
    case "zip":
      return normalizeZip(raw, context.state);
    case "state":
      return normalizeState(raw);
    case "email":
      return normalizeEmail(raw);
    case "name":
      return normalizeName(raw);
    case "carrier":
      return normalizeCarrier(raw, context.carriers);
    case "bank":
      return normalizeBankName(raw);
    case "text":
      return normalizeText(raw);
    default:
      return normalizeText(raw);
  }
}

function makeField(
  field: CanonicalField,
  raw: string,
  header: string | undefined,
  context: Context,
): LeadField {
  const result = normalizeFor(field, raw, context);
  const base: LeadField = {
    key: field.key,
    label: field.label,
    value: result.value,
    raw,
    status: result.status,
  };
  if (result.note) base.note = result.note;
  if (header) base.header = header;
  return base;
}

/**
 * The fields the review grid shows.
 *
 * Computed ONCE, when the mapping is confirmed, and then held as state. It must
 * never be re-derived from the leads as they are edited: doing that made the
 * column set a function of the data in it, so clearing the last card number in
 * a small file took the whole column away mid-edit and left nowhere to type the
 * corrected value.
 *
 * The set is the union of what the operator mapped and what detection found, so
 * a mapped column appears even if every row came out empty, and a donated field
 * — a card detected inside a column headed "Routing" — gets a column of its own.
 */
export function reviewColumns(
  leads: Lead[],
  columns: Column[],
  fields: CanonicalField[],
): CanonicalField[] {
  const wanted = new Set<string>();
  for (const column of columns) if (column.fieldKey) wanted.add(column.fieldKey);
  for (const lead of leads) {
    for (const [key, field] of Object.entries(lead.fields)) {
      if (field.value.trim()) wanted.add(key);
    }
  }
  return fields.filter((field) => wanted.has(field.key));
}

/**
 * Turn one spreadsheet row into a lead.
 *
 * A cell is never reduced to a single field: every detector runs against it and
 * each match lands on its own canonical field, so "Card no 4366-1031-4047-6613
 * Exp: 05/17 Cvv: 145" produces three. Where the header's claim and the
 * detected content disagree, both are kept and the row is flagged.
 */
export function buildLead(
  row: Record<string, string>,
  columns: Column[],
  fields: CanonicalField[],
  options: NormalizeOptions & { index?: number } = {},
): Lead {
  const context: Context = {
    now: options.now ?? new Date(),
    state: null,
    carriers: options.carriers ?? [],
  };
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const byKind = donationTargets(fields);

  const resolved: Record<string, LeadField> = {};
  const flags: LeadFlag[] = [];
  const raw: Record<string, string> = {};

  const claim = (
    field: CanonicalField,
    text: string,
    header: string | undefined,
    authoritative: boolean,
  ) => {
    const existing = resolved[field.key];
    if (existing && !authoritative) {
      if (collapseSpace(existing.raw) !== collapseSpace(text) && STRONG.has(field.kind)) {
        flags.push({
          field: field.key,
          issue: `two columns supplied a different ${KIND_LABEL[field.kind]}`,
          raw: text,
        });
      }
      return;
    }
    resolved[field.key] = makeField(field, text, header, context);
  };

  // Pass 1 — state first, because the ZIP cross-check needs it.
  const stateColumn = columns.find((column) => {
    const field = column.fieldKey ? byKey.get(column.fieldKey) : undefined;
    return field?.kind === "state";
  });
  if (stateColumn?.fieldKey) {
    const field = byKey.get(stateColumn.fieldKey);
    const text = collapseSpace(row[stateColumn.header] ?? "");
    if (field && text) {
      const result = normalizeState(text);
      if (result.status !== "review") context.state = result.value;
    }
  }

  // Pass 2 — every cell, header as a hint only.
  for (const column of columns) {
    const text = (row[column.header] ?? "").toString();
    raw[column.header] = text;
    if (!collapseSpace(text)) continue;

    const target = column.fieldKey ? byKey.get(column.fieldKey) : undefined;
    const hint = target?.kind ?? null;
    const candidates = detectCell(text, hint);
    const primary = hint ? candidates.find((candidate) => candidate.kind === hint) : undefined;

    // A mapped cell that no detector recognised is consumed whole by its own
    // field, so nothing is left in it to give away. Every other case may.
    let donatable = true;

    if (target) {
      const contradiction = contradicting(hint, candidates);
      if (primary) {
        claim(target, primary.raw, column.header, true);
      } else if (contradiction) {
        // The header said one thing and the content is unmistakably another.
        // Leaving the field empty and flagging beats writing the wrong value
        // into it — a card number must not land in routing_number.
        flags.push({
          field: target.key,
          issue: `column "${column.header}" was mapped to ${target.label} but the value reads as a ${KIND_LABEL[contradiction.kind]}`,
          raw: text,
        });
      } else {
        // No detector fired at all: keep the cell as-is and let the normaliser
        // decide whether it is usable.
        claim(target, text, column.header, true);
        donatable = false;
      }
    }

    for (const candidate of candidates) {
      if (!donatable && !candidate.labelled) continue;
      if (primary && candidate === primary) continue;
      const field = byKind.get(candidate.kind);
      if (!field) continue;
      if (target && field.key === target.key) continue;
      if (!FREELY_DONATED.has(candidate.kind) && !candidate.labelled) continue;
      if (candidate.confidence < 0.5) continue;
      claim(field, candidate.raw, column.header, false);
    }
  }

  // Age is derived when the file did not carry it, the same way the closer form
  // derives it — it stays an ordinary field either way.
  fillAgeFromDob(resolved, fields, context);

  const payment = resolvePayment(resolved, flags);

  for (const field of Object.values(resolved)) {
    if (field.status !== "review") continue;
    flags.push({
      field: field.key,
      issue: field.note ?? `${field.label} needs review`,
      raw: field.raw,
    });
  }

  return {
    index: options.index ?? 0,
    fields: resolved,
    flags: dedupeFlags(flags),
    payment,
    raw,
    duplicateOf: [],
  };
}

/**
 * The whole point of detecting from content: a strong detector fired, and it
 * disagrees with what the column header claimed.
 */
function contradicting(hint: DetectorKind | null, candidates: Candidate[]): Candidate | undefined {
  if (!hint || !STRONG.has(hint)) return undefined;
  if (candidates.some((candidate) => candidate.kind === hint)) return undefined;
  return candidates.find((candidate) => STRONG.has(candidate.kind) && candidate.confidence >= 0.6);
}

function fillAgeFromDob(
  resolved: Record<string, LeadField>,
  fields: CanonicalField[],
  context: Context,
) {
  const dobField = fields.find((field) => field.birthDate);
  const ageField = fields.find((field) => field.key === "age");
  if (!dobField || !ageField) return;
  const dob = resolved[dobField.key];
  const age = resolved[ageField.key];
  if (!dob || !dob.value) return;
  if (age && age.value.trim()) return;
  const years = ageFrom(dob.value, context.now);
  if (years === null || years < 0) return;
  resolved[ageField.key] = {
    key: ageField.key,
    label: ageField.label,
    value: String(years),
    raw: "",
    status: "fixed",
    note: "derived from the date of birth",
  };
}

function dedupeFlags(flags: LeadFlag[]) {
  const seen = new Set<string>();
  return flags.filter((flag) => {
    const key = `${flag.field}|${flag.issue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Card or draft is decided by what the detectors actually found, never by which
 * columns the file happened to have. The two instruments need different
 * companions, so the missing ones are flagged per type.
 */
export function resolvePayment(
  resolved: Record<string, LeadField>,
  flags: LeadFlag[],
): PaymentInstrument {
  const value = (key: string) => {
    const field = resolved[key];
    const text = field?.value?.trim();
    return text ? text : null;
  };

  const cardNumber = value("card_number");
  const cardDigits = cardNumber ? digitsOf(cardNumber) : null;
  const hasCard = !!cardDigits && cardDigits.length >= 15 && cardDigits.length <= 16;

  const routing = value("routing_number");
  const account = value("account_number");
  const bank = value("bank_name");
  const hasDraft = !!routing || (!!account && !!bank);

  let paymentType: PaymentType = "unknown";
  if (hasCard) paymentType = "card";
  else if (hasDraft) paymentType = "draft";

  if (hasCard && hasDraft) {
    flags.push({
      field: "payment_type",
      issue: "the lead carries both a card and bank draft details — imported as a card",
      raw: cardNumber ?? "",
    });
  }

  if (paymentType === "card") {
    if (!value("card_exp")) {
      flags.push({ field: "card_exp", issue: "card has no expiry date", raw: "" });
    }
    if (!value("cvv")) {
      flags.push({ field: "cvv", issue: "card has no CVV", raw: "" });
    }
  } else if (paymentType === "draft") {
    if (!routing) {
      flags.push({ field: "routing_number", issue: "bank draft has no routing number", raw: "" });
    }
    if (!account) {
      flags.push({ field: "account_number", issue: "bank draft has no account number", raw: "" });
    }
    if (!bank) {
      flags.push({ field: "bank_name", issue: "bank draft has no bank name", raw: "" });
    }
  } else {
    flags.push({
      field: "payment_type",
      issue: "no card and no bank draft details were found",
      raw: "",
    });
  }

  return {
    payment_type: paymentType,
    bank_name: bank,
    routing_number: routing,
    account_number: account,
    account_title: value("account_title"),
    card_number: cardNumber,
    card_last4: last4(cardNumber),
    card_exp: value("card_exp"),
    cvv: value("cvv"),
  };
}

/**
 * Re-run detection over one cell's original text and hand back what it yields,
 * with no header hint at all. This is how the uploader corrects a mis-parsed
 * card cell: they re-parse, they never read or retype the number.
 */
export function reparseCell(
  text: string,
  fields: CanonicalField[],
  options: NormalizeOptions = {},
): Record<string, LeadField> {
  const context: Context = {
    now: options.now ?? new Date(),
    state: null,
    carriers: options.carriers ?? [],
  };
  const byKind = donationTargets(fields);

  const out: Record<string, LeadField> = {};
  for (const candidate of detectCell(text, null)) {
    const field = byKind.get(candidate.kind);
    if (!field || out[field.key]) continue;
    if (!FREELY_DONATED.has(candidate.kind) && !candidate.labelled) continue;
    out[field.key] = makeField(field, candidate.raw, undefined, context);
  }
  return out;
}

/**
 * What the operator typed is never thrown away.
 *
 * A rule that cannot make sense of its input returns an empty value — right for
 * an empty source cell, wrong for a person mid-edit, whose text would vanish
 * from under them. If they typed something and the rule produced nothing, their
 * text stays and the cell is marked for review instead.
 */
function keepTyped(resolved: LeadField, typed: string): LeadField {
  if (!typed.trim() || resolved.value.trim()) return resolved;
  return {
    ...resolved,
    value: typed,
    status: "review",
    note: resolved.note ?? `${resolved.label} could not be read`,
  };
}

/** Re-normalise one field after an inline edit and rebuild the lead's flags. */
export function setLeadField(
  lead: Lead,
  fieldKey: string,
  nextValue: string,
  fields: CanonicalField[],
  options: NormalizeOptions = {},
): Lead {
  const field = fields.find((entry) => entry.key === fieldKey);
  if (!field) return lead;

  const stateField = fields.find((entry) => entry.kind === "state");
  const stateValue =
    stateField && stateField.key !== fieldKey ? (lead.fields[stateField.key]?.value ?? null) : null;
  const context: Context = {
    now: options.now ?? new Date(),
    state: stateValue,
    carriers: options.carriers ?? [],
  };

  const previous = lead.fields[fieldKey];
  const resolved: Record<string, LeadField> = {
    ...lead.fields,
    [fieldKey]: keepTyped(makeField(field, nextValue, previous?.header, context), nextValue),
  };

  const flags: LeadFlag[] = [];
  const payment = resolvePayment(resolved, flags);
  for (const entry of Object.values(resolved)) {
    if (entry.status !== "review") continue;
    flags.push({
      field: entry.key,
      issue: entry.note ?? `${entry.label} needs review`,
      raw: entry.raw,
    });
  }

  return { ...lead, fields: resolved, flags: dedupeFlags(flags), payment };
}
