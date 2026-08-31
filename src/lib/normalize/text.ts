/** Small pure string helpers shared by the detectors and the normalisers. */

export function collapseSpace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function digitsOf(value: string) {
  return value.replace(/\D/g, "");
}

/** Lowercase, strip punctuation, collapse space — for comparing headers and labels. */
export function slug(value: string) {
  return collapseSpace(value.toLowerCase().replace(/[^a-z0-9]+/g, " "));
}

/** Classic iterative Levenshtein. Bounded inputs, so the O(n·m) table is fine. */
export function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * Title case for names.
 *
 * A word that already carries an internal capital is left exactly as it is —
 * that is what preserves "MacLeod", "O'Brien" and "DeVito" when the file
 * already spelled them correctly. Only all-lower or all-upper words are
 * re-cased, and there the "Mc" prefix is restored because no ordinary English
 * name starts with those two letters otherwise. "Mac" is deliberately not
 * split: inventing "MacIas" out of "macias" would be worse than leaving it.
 */
export function titleCaseName(value: string) {
  return collapseSpace(value)
    .split(" ")
    .map((word) => (hasInternalCapital(word) ? word : recase(word)))
    .join(" ");
}

function hasInternalCapital(word: string) {
  return /[a-z].*[A-Z]/.test(word);
}

const PARTICLES = new Set(["de", "del", "der", "van", "von", "da", "di", "la", "le", "du"]);

function recase(word: string): string {
  return word.split("-").map(recasePart).join("-");
}

function recasePart(part: string): string {
  if (!part) return part;
  if (part.includes("'")) {
    return part
      .split("'")
      .map((piece, index) => (index === 0 ? recasePart(piece) : capitalize(piece.toLowerCase())))
      .join("'");
  }
  const lower = part.toLowerCase();
  if (PARTICLES.has(lower)) return lower;
  if (lower.startsWith("mc") && lower.length > 3) return `Mc${capitalize(lower.slice(2))}`;
  return capitalize(lower);
}

function capitalize(value: string) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Deterministic 32-bit hash, rendered hex. Used to fingerprint a header set. */
export function hashString(value: string) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
