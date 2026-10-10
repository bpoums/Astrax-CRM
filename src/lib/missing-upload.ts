import type { CanonicalField, Lead } from "@/lib/normalize";

/**
 * Which required fields a row of the uploader's review grid is still missing.
 *
 * The list of required fields is NOT written here: it is `uploaded_required_fields()`
 * in the database, the same definition that fills `submissions.missing_info` and
 * `missing_bank`, fetched once by the review step and passed in. This module only
 * answers "is that field empty on this row", from what the grid holds — so the
 * count the uploader sees before import is the count a manager will see after it.
 *
 * Pure: no I/O, no React. Informational only; nothing here blocks an import.
 */

export type RequiredField = {
  label: string;
  /** `core` is the 15 payload fields; `bank` is the five banking ones. */
  grp: "core" | "bank";
};

export type RowMissing = { core: string[]; bank: string[] };

function isBlank(value: string | null | undefined) {
  return value === null || value === undefined || value.trim() === "";
}

/**
 * The value this row will actually send for one canonical field. Payload fields
 * come from `lead.fields`; payment fields from `lead.payment`, which is what the
 * import body carries — reading the grid cell instead could disagree with it.
 */
function valueFor(lead: Lead, field: CanonicalField) {
  if (field.target === "payment") {
    const key = field.paymentKey;
    return key ? lead.payment[key as keyof Lead["payment"]] : null;
  }
  return lead.fields[field.key]?.value ?? null;
}

export function missingForLead(
  lead: Lead,
  required: RequiredField[],
  catalog: CanonicalField[],
): RowMissing {
  const out: RowMissing = { core: [], bank: [] };
  for (const entry of required) {
    const field = catalog.find((candidate) => candidate.label === entry.label);
    // A required label the catalog does not know cannot be filled in the grid;
    // it still counts as missing, because the database will count it.
    const value = field ? valueFor(lead, field) : null;
    if (isBlank(value)) out[entry.grp].push(entry.label);
  }
  return out;
}

/**
 * Required fields with no column in this file's mapping. Every row is missing
 * these, and the fix is a different mapping rather than typing 400 values, which
 * is worth saying out loud.
 */
export function unmappedRequired(
  required: RequiredField[],
  mapped: CanonicalField[],
  catalog: CanonicalField[],
): string[] {
  const mappedKeys = new Set(mapped.map((field) => field.key));
  return required
    .filter((entry) => {
      const field = catalog.find((candidate) => candidate.label === entry.label);
      return !field || !mappedKeys.has(field.key);
    })
    .map((entry) => entry.label);
}
