import { hashString, levenshtein, slug } from "./text";
import type { CanonicalField } from "./types";

/**
 * Header → canonical field suggestion, and the fingerprint used to remember a
 * confirmed mapping.
 *
 * This is an accelerant only. Sources may never repeat, so nothing downstream
 * may depend on a stored mapping existing — a file the tool has never seen has
 * to work with zero setup, which is why detection never consults this at all.
 */

/** Stable id for a header set, order-insensitive. */
export function fingerprintHeaders(headers: string[]) {
  const normalised = headers
    .map((header) => slug(header))
    .filter(Boolean)
    .sort()
    .join("|");
  return `${headers.length}-${hashString(normalised)}`;
}

function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aTokens = a.split(" ");
  const bTokens = b.split(" ");
  const shared = aTokens.filter((token) => bTokens.includes(token)).length;
  const overlap = shared / Math.max(aTokens.length, bTokens.length);
  const distance = levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.max(overlap * 0.95, 1 - distance);
}

function fieldTerms(field: CanonicalField) {
  return [field.label, field.key.replace(/_/g, " "), ...(field.aliases ?? [])].map(slug);
}

/**
 * Pre-select a canonical field for each header. Greedy over every (header,
 * field) pair by score so the strongest match claims a field first and no
 * field is claimed twice.
 */
export function suggestMapping(
  headers: string[],
  fields: CanonicalField[],
  threshold = 0.62,
): Record<string, string | null> {
  const scores: { header: string; key: string; score: number }[] = [];
  for (const header of headers) {
    const normalised = slug(header);
    if (!normalised) continue;
    for (const field of fields) {
      const score = Math.max(...fieldTerms(field).map((term) => similarity(normalised, term)));
      if (score >= threshold) scores.push({ header, key: field.key, score });
    }
  }
  scores.sort((a, b) => b.score - a.score);

  const mapping: Record<string, string | null> = Object.fromEntries(
    headers.map((header) => [header, null]),
  );
  const usedFields = new Set<string>();
  for (const { header, key, score } of scores) {
    void score;
    if (mapping[header]) continue;
    if (usedFields.has(key)) continue;
    mapping[header] = key;
    usedFields.add(key);
  }
  return mapping;
}
