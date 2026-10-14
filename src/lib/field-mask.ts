import { normalizeZip } from "@/lib/normalize/rules";
import { digitsOf, forceTitleCaseName } from "@/lib/normalize/text";

/**
 * The input masks the two intake forms share.
 *
 * One registry, keyed by field label, rather than a mask wired into each form:
 * labels ARE the payload keys and are spelled identically in both forms, so a
 * rule written once here reaches whichever form actually has that field, and a
 * form that does not have it never sees the mask at all. That is why there is
 * no per-form configuration below — `Birth Country` and `Customer Zip Code`
 * exist only on the closer form today, and adding either to the validator form
 * would pick up its mask with no further work.
 *
 * Same split as `form-fields.ts` and `form-warnings.ts`, kept deliberately:
 * this file FORMATS and CONSTRAINS what can be typed, `form-warnings.ts` says
 * whether a well-formed value looks wrong, and neither blocks submission. The
 * checks themselves are not reimplemented here — the ZIP rule is the
 * normaliser's `normalizeZip`, the same function the uploader runs.
 *
 * Two entry points, because two moments matter:
 *
 * - `maskField(label, next, previous)` on every keystroke. It takes the
 *   previous value as well as the new one, which is what makes backspacing over
 *   an auto-inserted separator work — see `maskHeight`.
 * - `closeField(label, value)` on blur, for the part of a mask that must not
 *   fire mid-typing: closing 5'6" while someone is still typing the 6 would
 *   fight them for the cursor.
 */

export type FieldMask = {
  /** Every keystroke. `previous` distinguishes typing from deleting. */
  live: (next: string, previous: string) => string;
  /** On blur, where a mask has an ending that cannot be inserted live. */
  blur?: (value: string) => string;
};

/** Labels, spelled once. Both forms use these exact strings as payload keys. */
export const HEIGHT_FIELD = "Height";
export const ZIP_FIELD = "Customer Zip Code";
export const BIRTH_COUNTRY_FIELD = "Birth Country";
export const FULL_NAME_FIELD = "Full Name";
export const DOC_NAME_FIELD = "Doc Name";
export const MONEY_FIELDS = ["Premium", "Coverage Amount"] as const;
/** Every State-labelled field across both forms. */
export const STATE_FIELDS = ["State", "Residential State", "Birth State"] as const;

/** The two Birth Country choices. Anything else is typed under "Other". */
export const BIRTH_COUNTRY_DEFAULT = "USA";

/**
 * 5, 6 -> 5'6" — feet always one digit, inches one or two.
 *
 * Inches are NOT capped at 11. 6'12" was given as a valid value, and a mask
 * that silently refused the second 2 would be a worse lie than the odd reading.
 *
 * The whole value is rebuilt from its digits on every keystroke, so there is no
 * half-formatted state to get stuck in: whatever is in the box, the digits are
 * the truth and the separators are redrawn around them.
 *
 * The awkward case is backspace. Typing 5 gives `5'`, and deleting that `'`
 * would rebuild it from the surviving 5 — the caret would never move and the
 * field could not be cleared. So when the deletion took a separator, it takes
 * the digit in front of it too, which is what a person means by backspacing
 * over punctuation they never typed.
 */
export function maskHeight(next: string, previous: string) {
  const deleting = next.length < previous.length;
  let digits = digitsOf(next).slice(0, 3);
  if (deleting && /['"]$/.test(previous)) digits = digits.slice(0, -1);
  if (!digits) return "";

  const feet = digits.slice(0, 1);
  const inches = digits.slice(1);
  if (!inches) return `${feet}'`;
  // The third digit is the last one this field can take, so the moment it
  // lands the value is complete and closes itself.
  return inches.length === 1 ? `${feet}'${inches}` : `${feet}'${inches}"`;
}

/**
 * The closing quote for anything shorter than three digits, on blur.
 *
 * A single digit is read as whole feet — 5 becomes 5'0", not 5' — because
 * leaving the inches open is exactly the half-formatted state this mask exists
 * to prevent, and 5 feet is the only thing "5" can mean here.
 */
export function closeHeight(value: string) {
  const digits = digitsOf(value).slice(0, 3);
  if (!digits) return "";
  return `${digits.slice(0, 1)}'${digits.slice(1) || "0"}"`;
}

/**
 * 12500 -> $12,500 and 25.6 -> $25.6, as they are typed.
 *
 * Cents are part of these amounts. A premium is quoted as 25.60 far more often
 * than as 26, so the point has to survive the keystroke that types it — an
 * earlier version rebuilt the value from `digitsOf` alone, which silently ate
 * the point and made a decimal premium impossible to enter at all.
 *
 * Everything else is still refused rather than stripped after the fact: the
 * value is rebuilt from the digits and at most one point, so a letter or a
 * stray symbol never reaches the box and the field simply does not change. The
 * `$` and the commas are ours, redrawn each keystroke, which is what lets
 * backspace walk through them.
 *
 * Grouped by regex rather than `toLocaleString`, for two reasons: the number
 * never becomes a Number, so neither a long entry nor a fraction can lose
 * anything to floating point, and the separator cannot change under a viewer
 * whose locale groups with dots.
 */
export function maskMoney(next: string) {
  const cleaned = next.replace(/[^\d.]/g, "");
  const point = cleaned.indexOf(".");
  const rawWhole = point === -1 ? cleaned : cleaned.slice(0, point);

  // Null means no point has been typed, which is not the same as a point with
  // nothing after it yet: `$25.` has to be a state the box can hold, or the
  // key could never be pressed. A second point is folded into the cents rather
  // than starting a new number, and anything past the hundredths is dropped.
  const cents =
    point === -1
      ? null
      : cleaned
          .slice(point + 1)
          .replace(/\./g, "")
          .slice(0, 2);

  // A leading zero is a typo in a whole amount — $007 means 7 — but the zero in
  // 0.75 IS the value, and this only strips zeros that another digit follows,
  // so the one in front of a point is left alone.
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  if (!whole && cents === null) return "";

  // `.75` is a real way to type three quarters; it is shown as $0.75 rather
  // than as $.75, which is not an amount anyone writes on a form.
  const grouped = (whole || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents === null ? `$${grouped}` : `$${grouped}.${cents}`;
}

/**
 * A point nobody finished typing is not part of the amount.
 *
 * `$25.` is a legitimate half-typed state while the cents are still coming, and
 * a meaningless one the moment the field is left — and `payload` is what the
 * sheet-sync trigger pushes, so it would be exported exactly as it stands.
 */
export function closeMoney(value: string) {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

/** Digits only while typing. ZIP+4 is allowed in, and trimmed on blur. */
export function maskZip(next: string) {
  return digitsOf(next).slice(0, 9);
}

/**
 * The normaliser's own ZIP rule, on blur.
 *
 * `normalizeZip` is what the uploader runs over an imported file — it pads 2134
 * back to 02134 (spreadsheets eat the leading zero, and a phone keypad drops it
 * for the same reason) and trims a ZIP+4 to five. Reusing it means the closer's
 * form and the import path can never disagree about what a ZIP is.
 *
 * The state cross-check is deliberately NOT here. It already runs as an
 * advisory warning through `fieldWarning`, where a mismatch is something to
 * confirm with the customer rather than something to rewrite under them.
 */
export function closeZip(value: string) {
  const digits = digitsOf(value);
  if (!digits) return "";
  return normalizeZip(digits).value || digits;
}

/**
 * Two letters, uppercased as they are typed.
 *
 * Whether those two letters are a real USPS code is a question for
 * `fieldWarning`, not for the mask: refusing the keystroke would make "MI"
 * untypeable, since "M" alone is not a code and every code starts as one
 * letter that is not.
 */
export function maskStateCode(next: string) {
  return next
    .replace(/[^A-Za-z]/g, "")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * What a paste drags in besides the text: tabs and line breaks, non-breaking
 * and other odd spaces (all matched by \s), and the zero-width characters and
 * soft hyphen that \s does not match. None of them is visible, all of them end
 * up in the Sheet cell. A curly apostrophe from a word processor is made
 * straight, so "O’Brien" and "O'Brien" are one spelling.
 *
 * Runs of spaces become one and a leading space is dropped, but a single
 * trailing space is kept: this runs on every keystroke, and removing it would
 * make the space between a first and last name impossible to type.
 */
function stripPasteNoise(value: string) {
  return value
    .replace(/[\u200b-\u200d\u2060\u00ad]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^ /, "");
}

const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|2nd|3rd)\.?$/i;

/**
 * A person's name, as it is typed or pasted: always Title Case, so a pasted
 * "JOHN  DOE" or "joHN dOE" is "John Doe" the instant it lands. Used for Full
 * Name and for each beneficiary's name.
 */
export function maskPersonName(next: string) {
  const cleaned = stripPasteNoise(next);
  const cased = forceTitleCaseName(cleaned);
  return cleaned.endsWith(" ") && cased ? `${cased} ` : cased;
}

/**
 * On blur: "Doe, John" is the surname-first order other CRMs export, so one
 * comma between two non-empty parts is flipped to "John Doe". "Smith, Jr" is
 * left to read as a suffix, and any other comma is just dropped.
 */
export function closePersonName(value: string) {
  const cleaned = maskPersonName(value).trim();
  const parts = cleaned.split(",").map((part) => part.trim());
  if (parts.length === 2 && parts[0] && parts[1] && !NAME_SUFFIX.test(parts[1] ?? "")) {
    return forceTitleCaseName(`${parts[1]} ${parts[0]}`);
  }
  return forceTitleCaseName(cleaned.replace(/^[,\s]+|[,\s]+$/g, "").replace(/\s*,\s*/g, " "));
}

/**
 * A free-text name that is cleaned but never re-cased: Doc Name holds a
 * doctor's name or, when the customer cannot remember one, the hospital they
 * last visited, so nothing about its wording is ours to change.
 */
export function maskFreeName(next: string) {
  return stripPasteNoise(next);
}

export function closeFreeName(value: string) {
  return stripPasteNoise(value).trim();
}

const MONEY_MASK: FieldMask = { live: maskMoney, blur: closeMoney };
const STATE_MASK: FieldMask = { live: maskStateCode };

const MASKS: Record<string, FieldMask> = {
  [FULL_NAME_FIELD]: { live: maskPersonName, blur: closePersonName },
  [DOC_NAME_FIELD]: { live: maskFreeName, blur: closeFreeName },
  [HEIGHT_FIELD]: { live: maskHeight, blur: closeHeight },
  [ZIP_FIELD]: { live: maskZip, blur: closeZip },
  ...Object.fromEntries(MONEY_FIELDS.map((label) => [label, MONEY_MASK])),
  ...Object.fromEntries(STATE_FIELDS.map((label) => [label, STATE_MASK])),
};

/** The keystroke pass. Labels with no mask are returned untouched. */
export function maskField(label: string, next: string, previous: string) {
  const mask = MASKS[label];
  return mask ? mask.live(next, previous) : next;
}

/**
 * The blur pass. Returns the value unchanged where a field has no closing rule,
 * so a caller can compare and skip the write.
 */
export function closeField(label: string, value: string) {
  const mask = MASKS[label];
  return mask?.blur ? mask.blur(value) : value;
}

/**
 * The blur pass over a whole payload, for submit.
 *
 * Blur only fires when a field is left, and Enter submits from inside one. Every
 * closing rule is idempotent, so running them all again here costs nothing and
 * guarantees that what reaches the Sheet is what blur would have produced.
 */
export function closeAllFields(values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(values).map(([label, value]) => [label, closeField(label, value)]),
  );
}
