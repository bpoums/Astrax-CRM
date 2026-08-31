import { isAbaRouting, isCardNumber, isSsn } from "./rules";
import { STATE_ABBREVIATIONS, STATE_CODES } from "./states";
import { collapseSpace, digitsOf, slug } from "./text";
import type { DetectorKind } from "./types";

/**
 * Content detection.
 *
 * The rule this module exists to enforce: a column header is a hint, never a
 * decision. Real source files put a card number in a column headed
 * "Routing / Card Detail", so anything that trusts the header accepts a card as
 * a routing number without noticing. Every detector below runs against the cell
 * text regardless of what the header claimed, and the comparison between the
 * two is what produces a flag.
 */

export type Candidate = {
  kind: DetectorKind;
  /** The exact substring the detector matched. */
  raw: string;
  start: number;
  end: number;
  /** 0-1. Checksum-backed matches outrank shape-only ones. */
  confidence: number;
  /** True when an inline label inside the cell named this kind. */
  labelled: boolean;
};

type Segment = {
  text: string;
  offset: number;
  /** The kind the inline label claimed, if there was one. */
  label: DetectorKind | null;
};

/**
 * Inline labels, as they actually appear: "SSN: 568-80-9709",
 * "Card no 4366-1031-4047-6613", "Routing: 0070158296 Chq NM 1072".
 *
 * A label only counts when a separator or a "no/number/#" word follows it,
 * which is what stops the second word of "Bank: US BANK" being read as a new
 * label and swallowing the value.
 */
const LABEL_PATTERNS: { kind: DetectorKind; source: string }[] = [
  { kind: "ssn", source: "ssn|social\\s*security|social" },
  { kind: "routing", source: "routing|route|aba|rtn" },
  { kind: "account", source: "account|acct|acc" },
  { kind: "card", source: "card|cc|debit\\s*card|credit\\s*card|visa|mastercard" },
  { kind: "expiry", source: "exp(?:iry|iration)?(?:\\s*date)?" },
  { kind: "cvv", source: "cvv|cvc|cid|security\\s*code|sec\\s*code" },
  { kind: "bank", source: "bank(?:\\s*name)?" },
  { kind: "date", source: "dob|d\\.o\\.b\\.?|date\\s*of\\s*birth|birth\\s*date|draft\\s*date" },
  { kind: "phone", source: "phone|tel|telephone|mobile|cell" },
  { kind: "zip", source: "zip(?:\\s*code)?|postal(?:\\s*code)?" },
  { kind: "email", source: "e-?mail" },
  { kind: "currency", source: "premium|amount|draft\\s*amount" },
  { kind: "state", source: "state" },
];

/**
 * The alternation has to be wrapped before the suffix is appended, or the
 * suffix binds to the last alternative only.
 *
 * The separator is a colon or a hash, never a dash: "US BANK - CHECKING" would
 * otherwise have its second half read as the bank name.
 */
const LABEL_RE = new RegExp(
  "\\b(?:" +
    LABEL_PATTERNS.map(({ source }) => `(?:${source})`).join("|") +
    ")(?:\\s*(?:no|num|number|#))?\\s*(?::|#)?\\s*",
  "gi",
);

function labelKind(matched: string): DetectorKind | null {
  const cleaned = slug(matched)
    .replace(/\b(no|num|number)\b/g, "")
    .trim();
  for (const { kind, source } of LABEL_PATTERNS) {
    if (new RegExp(`^(?:${source})$`, "i").test(cleaned)) return kind;
  }
  return null;
}

/**
 * Split a cell into labelled segments. Text before the first label becomes one
 * unlabelled segment, so a plain cell is handled by exactly the same path.
 */
export function splitLabelledSegments(text: string): Segment[] {
  const hits: { kind: DetectorKind; start: number; end: number }[] = [];
  LABEL_RE.lastIndex = 0;
  for (const match of text.matchAll(LABEL_RE)) {
    const whole = match[0];
    const index = match.index ?? 0;
    const trimmed = whole.replace(/[\s:#]+$/, "");
    const separatorFollowed = /(?:no|num|number|#)\s*(?::|#)?\s*$|(?::|#)\s*$/i.test(whole);
    if (!separatorFollowed) continue;
    const kind = labelKind(trimmed);
    if (!kind) continue;
    hits.push({ kind, start: index, end: index + whole.length });
  }

  if (hits.length === 0) return [{ text, offset: 0, label: null }];

  const segments: Segment[] = [];
  const firstStart = hits[0]?.start ?? 0;
  if (firstStart > 0) {
    const head = text.slice(0, firstStart);
    if (head.trim()) segments.push({ text: head, offset: 0, label: null });
  }
  hits.forEach((hit, index) => {
    const nextStart = hits[index + 1]?.start ?? text.length;
    segments.push({ text: text.slice(hit.end, nextStart), offset: hit.end, label: hit.kind });
  });
  return segments;
}

type NumberToken = { digits: string; start: number; end: number };

function numberTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const match of text.matchAll(/\d+/g)) {
    out.push({
      digits: match[0],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return out;
}

/** Digit runs that a single separator joins, e.g. "4366 1031 4047 6613". */
function mergedRuns(text: string, tokens: NumberToken[], maxDigits: number) {
  const runs: { digits: string; start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let digits = tokens[i]?.digits ?? "";
    const start = tokens[i]?.start ?? 0;
    let end = tokens[i]?.end ?? 0;
    runs.push({ digits, start, end });
    for (let j = i + 1; j < tokens.length; j += 1) {
      const gap = text.slice(end, tokens[j]?.start ?? end);
      if (!/^[\s-]{1,2}$/.test(gap)) break;
      digits += tokens[j]?.digits ?? "";
      end = tokens[j]?.end ?? end;
      if (digits.length > maxDigits) break;
      runs.push({ digits, start, end });
    }
  }
  return runs;
}

const DATE_RE =
  /\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?)?/g;
const EXPIRY_RE = /\b(0?[1-9]|1[0-2])\s*[/-]\s*(\d{2}|\d{4})\b/g;
const EMAIL_RE = /[^\s,;:]+@[^\s,;:]+\.[A-Za-z]{2,}/g;
const CURRENCY_RE = /(?:\$\s*\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s*\$)/g;
const PHONE_RE = /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const ZIP_PLUS4_RE = /\b\d{5}-\d{4}\b/g;

/**
 * Every detector that applies, over one cell. Candidates may overlap; call
 * `resolveCandidates` to reduce them to a non-conflicting set.
 */
export function detectCandidates(text: string, hint?: DetectorKind | null): Candidate[] {
  const found: Candidate[] = [];
  for (const segment of splitLabelledSegments(text)) {
    // An inline label beats the column header inside its own segment.
    const claim = segment.label ?? hint ?? null;
    for (const candidate of detectSegment(segment.text, claim, segment.label !== null)) {
      found.push({
        ...candidate,
        start: candidate.start + segment.offset,
        end: candidate.end + segment.offset,
      });
    }
  }
  return found;
}

function detectSegment(text: string, claim: DetectorKind | null, labelled: boolean): Candidate[] {
  const out: Candidate[] = [];
  const push = (kind: DetectorKind, start: number, end: number, confidence: number) => {
    // An inline label inside the cell is much better evidence than a column
    // header: "Account: 113105070" is an account number even though those nine
    // digits happen to pass the ABA checksum too.
    const bonus = claim === kind ? (labelled ? 0.2 : 0.05) : 0;
    out.push({
      kind,
      raw: text.slice(start, end),
      start,
      end,
      confidence: Math.min(1, confidence + bonus),
      labelled: labelled && claim === kind,
    });
  };

  const tokens = numberTokens(text);
  const runs = mergedRuns(text, tokens, 16);

  // --- card: 15-16 digits passing Luhn -----------------------------------
  let cardFound = false;
  for (const run of runs) {
    if (isCardNumber(run.digits)) {
      push("card", run.start, run.end, 0.9);
      cardFound = true;
    }
  }

  // --- ssn: nine digits with a valid area/group/serial --------------------
  const ssnShaped = [...text.matchAll(/\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g)];
  for (const match of ssnShaped) {
    const start = match.index ?? 0;
    const digits = digitsOf(match[0]);
    push("ssn", start, start + match[0].length, isSsn(digits) ? 0.92 : 0.7);
  }
  for (const token of tokens) {
    if (token.digits.length !== 9) continue;
    if (ssnShaped.some((m) => (m.index ?? 0) <= token.start)) continue;
    if (isSsn(token.digits)) push("ssn", token.start, token.end, 0.62);
  }

  // --- routing: nine digits passing the ABA checksum ----------------------
  for (const token of tokens) {
    if (token.digits.length !== 9) continue;
    if (isAbaRouting(token.digits)) push("routing", token.start, token.end, 0.85);
  }

  // --- expiry -------------------------------------------------------------
  let expiryFound = false;
  for (const match of text.matchAll(EXPIRY_RE)) {
    const start = match.index ?? 0;
    push("expiry", start, start + match[0].length, 0.75);
    expiryFound = true;
  }

  // --- cvv: only ever alongside a card in the same cell -------------------
  if (claim === "cvv" || cardFound || expiryFound) {
    for (const token of tokens) {
      if (token.digits.length < 3 || token.digits.length > 4) continue;
      const confidence = claim === "cvv" ? 0.8 : cardFound ? 0.5 : 0.35;
      push("cvv", token.start, token.end, confidence);
    }
  }

  // --- date ---------------------------------------------------------------
  for (const match of text.matchAll(DATE_RE)) {
    const start = match.index ?? 0;
    push("date", start, start + match[0].length, 0.72);
  }

  // --- currency -----------------------------------------------------------
  for (const match of text.matchAll(CURRENCY_RE)) {
    const start = match.index ?? 0;
    push("currency", start, start + match[0].length, 0.85);
  }

  // --- phone --------------------------------------------------------------
  for (const match of text.matchAll(PHONE_RE)) {
    const start = match.index ?? 0;
    push("phone", start, start + match[0].length, 0.8);
  }
  for (const token of tokens) {
    if (
      token.digits.length === 10 ||
      (token.digits.length === 11 && token.digits.startsWith("1"))
    ) {
      push("phone", token.start, token.end, claim === "phone" ? 0.8 : 0.45);
    }
  }

  // --- zip ----------------------------------------------------------------
  for (const match of text.matchAll(ZIP_PLUS4_RE)) {
    const start = match.index ?? 0;
    push("zip", start, start + match[0].length, 0.8);
  }
  for (const token of tokens) {
    if (token.digits.length === 5) push("zip", token.start, token.end, claim === "zip" ? 0.8 : 0.4);
    if (token.digits.length < 5 && claim === "zip") push("zip", token.start, token.end, 0.7);
  }

  // --- account: a bare digit run in a segment that asked for one ----------
  if (claim === "account") {
    for (const token of tokens) {
      if (token.digits.length >= 4 && token.digits.length <= 17) {
        push("account", token.start, token.end, 0.7);
      }
    }
  }

  // --- email --------------------------------------------------------------
  for (const match of text.matchAll(EMAIL_RE)) {
    const start = match.index ?? 0;
    push("email", start, start + match[0].length, 0.95);
  }

  // --- state: only when the whole segment is one ---------------------------
  const trimmed = collapseSpace(text.replace(/[.,]/g, " "));
  if (trimmed) {
    const isState =
      (trimmed.length === 2 && STATE_ABBREVIATIONS.has(trimmed.toUpperCase())) ||
      STATE_CODES[slug(trimmed)] !== undefined;
    if (isState) {
      const start = text.indexOf(trimmed.slice(0, 1));
      push("state", Math.max(0, start), text.length, 0.8);
    } else if (claim === "state") {
      push("state", 0, text.length, 0.6);
    }
  }

  // --- name / bank / free text: whole-segment, weak by construction --------
  if (claim === "name" || claim === "bank" || claim === "carrier" || claim === "text") {
    if (trimmed) push(claim, 0, text.length, 0.3);
  } else if (trimmed && /^[A-Za-z][A-Za-z'\-. ]*$/.test(trimmed)) {
    push("name", 0, text.length, 0.2);
  }

  // A segment that was explicitly asked for a kind always yields one, even when
  // the value fails its checksum: a mistyped card belongs in the review column,
  // not dropped on the floor. If a stronger detector claimed the same
  // characters this fallback loses the overlap and the disagreement is flagged.
  if (claim && trimmed && !out.some((candidate) => candidate.kind === claim)) {
    const longest = [...runs].sort((a, b) => b.digits.length - a.digits.length)[0];
    if (NUMERIC_KINDS.has(claim) && longest) {
      push(claim, longest.start, longest.end, 0.55);
    } else if (!NUMERIC_KINDS.has(claim)) {
      push(claim, 0, text.length, 0.55);
    }
  }

  return out;
}

/** Kinds whose value is a run of digits rather than the whole segment. */
const NUMERIC_KINDS: ReadonlySet<DetectorKind> = new Set([
  "ssn",
  "routing",
  "account",
  "card",
  "cvv",
  "zip",
  "phone",
]);

/**
 * Reduce overlapping candidates to the best non-conflicting set: strongest
 * confidence first, longest span as the tie-break, then anything that would
 * re-use already-claimed characters is dropped.
 */
export function resolveCandidates(candidates: Candidate[]): Candidate[] {
  const ordered = [...candidates].sort(
    (a, b) => b.confidence - a.confidence || b.end - b.start - (a.end - a.start),
  );
  const kept: Candidate[] = [];
  for (const candidate of ordered) {
    const overlaps = kept.some(
      (other) => candidate.start < other.end && other.start < candidate.end,
    );
    if (overlaps) continue;
    // A cell holds at most one value of each kind; the strongest one wins.
    if (kept.some((other) => other.kind === candidate.kind)) continue;
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Detect and resolve in one step — what callers normally want. */
export function detectCell(text: string, hint?: DetectorKind | null): Candidate[] {
  return resolveCandidates(detectCandidates(text, hint));
}
