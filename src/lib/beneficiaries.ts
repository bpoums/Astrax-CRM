/**
 * Beneficiaries on the intake forms.
 *
 * The payload keeps its three flat keys — "Beneficiary Name", "Beneficiary
 * Relationship", "Beneficiary Info" — because each label is also a Google Sheet
 * column header and an import target. A lead with several beneficiaries joins
 * them with " | ", in the same order in all three, so item N of each column is
 * the same person. An empty Info keeps its slot ("Mary | John" / "Spouse | Son"
 * / " | lives in Ohio") for exactly that reason.
 *
 * Pure: no React, no I/O.
 */

import { maskPersonName } from "@/lib/field-mask";

export type Beneficiary = { name: string; relationship: string; info: string };

export const BENEFICIARY_NAME = "Beneficiary Name";
export const BENEFICIARY_RELATIONSHIP = "Beneficiary Relationship";
export const BENEFICIARY_INFO = "Beneficiary Info";

/** The three payload keys the group owns, in sheet-column order. */
export const BENEFICIARY_LABELS: readonly string[] = [
  BENEFICIARY_NAME,
  BENEFICIARY_RELATIONSHIP,
  BENEFICIARY_INFO,
];

export const BENEFICIARY_SEPARATOR = " | ";
export const MAX_BENEFICIARIES = 6;

/** Offered in the dropdown. Anything else is typed under "Other". */
export const RELATIONSHIPS = [
  "Spouse",
  "Son",
  "Daughter",
  "Brother",
  "Sister",
  "Mother",
  "Father",
  "Grandson",
  "Granddaughter",
  "Niece",
  "Nephew",
  "Friend",
  "Estate",
] as const;

export type BeneficiaryValues = Record<string, string>;

const blank = (): Beneficiary => ({ name: "", relationship: "", info: "" });

/**
 * Keeps a typed value from breaking the structure, without touching spaces —
 * this runs on every keystroke, and trimming here would eat the space between
 * a first and last name as it is typed.
 */
export function stripStructure(value: string): string {
  return value.replace(/\|/g, "/").replace(/[\r\n\t]+/g, " ");
}

/** The final form of one value: structure stripped, whitespace collapsed. */
export function cleanPart(value: string): string {
  return stripStructure(value).replace(/\s+/g, " ").trim();
}

/** A row the user has typed or picked nothing into. */
export function isBlankBeneficiary(entry: Beneficiary): boolean {
  return !entry.name.trim() && !entry.relationship.trim() && !entry.info.trim();
}

/** Drops blank rows and cleans the rest. This is what is submitted. */
export function compactBeneficiaries(list: Beneficiary[]): Beneficiary[] {
  return list
    .filter((entry) => !isBlankBeneficiary(entry))
    .map((entry) => ({
      // Title Case only. Not the "Last, First" flip Full Name gets: a comma in a
      // beneficiary row more likely separates two people than reverses one.
      name: maskPersonName(cleanPart(entry.name)).trim(),
      relationship: cleanPart(entry.relationship),
      info: cleanPart(entry.info),
    }));
}

const join = (parts: string[]) => parts.join(BENEFICIARY_SEPARATOR);

/**
 * The three payload values for a list, exactly as given. Used live by the
 * group, where the value must round-trip through `parseBeneficiaries` without
 * losing a half-typed space. Submit with `compactBeneficiaries` first.
 */
export function serializeBeneficiaries(list: Beneficiary[]): BeneficiaryValues {
  const rows = list.length > 0 ? list : [blank()];
  return {
    [BENEFICIARY_NAME]: join(rows.map((entry) => stripStructure(entry.name))),
    [BENEFICIARY_RELATIONSHIP]: join(rows.map((entry) => stripStructure(entry.relationship))),
    [BENEFICIARY_INFO]: join(rows.map((entry) => stripStructure(entry.info))),
  };
}

/**
 * Splits one column on "|". Exactly the one space the separator adds on each
 * side is removed, so what `serializeBeneficiaries` joined comes back
 * unchanged, and a hand-typed "A|B" still splits.
 */
function splitColumn(value: string): string[] {
  const parts = value.split("|");
  return parts.map((part, index) => {
    let out = part;
    if (index > 0 && out.startsWith(" ")) out = out.slice(1);
    if (index < parts.length - 1 && out.endsWith(" ")) out = out.slice(0, -1);
    return out;
  });
}

/**
 * The list a set of payload values describes. Always at least one row, so an
 * empty form (or a reset) shows one blank row. A lead saved before the group
 * existed has one name and parses to one beneficiary.
 */
export function parseBeneficiaries(values: BeneficiaryValues): Beneficiary[] {
  const names = splitColumn(values[BENEFICIARY_NAME] ?? "");
  const relationships = splitColumn(values[BENEFICIARY_RELATIONSHIP] ?? "");
  const infos = splitColumn(values[BENEFICIARY_INFO] ?? "");
  const count = Math.max(names.length, relationships.length, infos.length);
  return Array.from({ length: count }, (_, index) => ({
    name: names[index] ?? "",
    relationship: relationships[index] ?? "",
    info: infos[index] ?? "",
  }));
}

/**
 * Why the list cannot be submitted, or null. The first beneficiary is
 * required, as the two single fields were, and so is their Info; any further
 * row that has something in it needs a name and a relationship too, so the
 * columns cannot drift out of step.
 */
export function validateBeneficiaries(list: Beneficiary[]): string | null {
  const rows = compactBeneficiaries(list);
  const first = rows[0];
  if (!first) return `${BENEFICIARY_NAME} is required.`;
  for (const [index, entry] of rows.entries()) {
    const who = entry.name || `beneficiary ${index + 1}`;
    if (!entry.name) return `Add a name for beneficiary ${index + 1}.`;
    if (!entry.relationship) {
      return index === 0
        ? `${BENEFICIARY_RELATIONSHIP} is required.`
        : `Add a relationship for ${who}.`;
    }
    // Info is required for the first beneficiary only; later rows may leave it
    // blank, as the extra people are often named with nothing more to say.
    if (index === 0 && !entry.info) return `${BENEFICIARY_INFO} is required.`;
  }
  if (rows.length > MAX_BENEFICIARIES) return `Up to ${MAX_BENEFICIARIES} beneficiaries.`;
  return null;
}

/**
 * `values` with the group's three keys replaced by their submitted form —
 * blank rows dropped, every part cleaned. Every other key passes through.
 */
export function withSubmittedBeneficiaries(values: BeneficiaryValues): BeneficiaryValues {
  const rows = compactBeneficiaries(parseBeneficiaries(values));
  return { ...values, ...serializeBeneficiaries(rows) };
}
