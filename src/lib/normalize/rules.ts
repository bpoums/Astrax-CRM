import { lookupCarrier, type CarrierRef } from "./carriers";
import { STATE_ABBREVIATIONS, STATE_CODES, STATE_NAMES, stateForZip } from "./states";
import { collapseSpace, digitsOf, levenshtein, slug, titleCaseName } from "./text";
import type { Normalized } from "./types";

/* ------------------------------------------------------------------ *
 * Validators. Each answers a yes/no question about a digit string and
 * is used by the detectors and the normalisers alike.
 * ------------------------------------------------------------------ */

/** ABA mod-10 with the standard 3-7-1 weights. */
export function isAbaRouting(digits: string) {
  if (!/^\d{9}$/.test(digits)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(digits[i]) * (weights[i] ?? 1);
  return sum % 10 === 0;
}

export function isLuhn(digits: string) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function isCardNumber(digits: string) {
  return /^\d{15,16}$/.test(digits) && isLuhn(digits);
}

export type CardBrand = "Visa" | "Mastercard" | "Amex" | "Discover";

/**
 * The issuer, read off the leading digits (the IIN). Prefix only — it says
 * nothing about whether the number is valid, so pair it with isLuhn rather than
 * treating a recognised brand as a passing check.
 */
export function cardBrand(digits: string): CardBrand | null {
  if (!/^\d+$/.test(digits)) return null;
  if (/^4/.test(digits)) return "Visa";
  // 51-55, plus the 2221-2720 range Mastercard added in 2017.
  if (/^5[1-5]/.test(digits)) return "Mastercard";
  if (/^2(22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)/.test(digits)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "Amex";
  if (/^(6011|65|64[4-9])/.test(digits)) return "Discover";
  return null;
}

export type ExpiryProblem = "format" | "month" | "past";

/**
 * What is wrong with a card expiry, or null if nothing is.
 *
 * Parsing goes through normalizeExpiry so there is one MM/YY reader. A card is
 * good through the LAST day of its stated month, so the comparison is against
 * the first instant of the following month rather than the month itself.
 */
export function expiryProblem(raw: string, now: Date = new Date()): ExpiryProblem | null {
  const parsed = normalizeExpiry(raw);
  const match = /^(\d{2})\/(\d{2})$/.exec(parsed.value);
  if (!match) return "format";

  const month = Number(match[1]);
  if (month < 1 || month > 12) return "month";

  const year = 2000 + Number(match[2]);
  const expiresAfter = new Date(year, month, 1);
  return expiresAfter.getTime() <= now.getTime() ? "past" : null;
}

/**
 * SSA issuance rules: no 000/666/900-999 area, no 00 group, no 0000 serial.
 * A run of one repeated digit is placeholder data rather than an SSN.
 */
export function ssnProblem(digits: string): string | null {
  if (!/^\d{9}$/.test(digits)) return "is not nine digits";
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  if (/^(\d)\1{8}$/.test(digits)) return "has nine repeated digits";
  if (area === "000" || area === "666" || Number(area) >= 900) return `has invalid area ${area}`;
  if (group === "00") return "has group 00";
  if (serial === "0000") return "has serial 0000";
  return null;
}

export function isSsn(digits: string) {
  return ssnProblem(digits) === null;
}

/* ------------------------------------------------------------------ *
 * Normalisers. Every one returns { value, status, note? }.
 * ------------------------------------------------------------------ */

export function normalizeSsn(raw: string): Normalized {
  const digits = digitsOf(raw);
  const formatted =
    digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : digits;
  const problem = ssnProblem(digits);
  if (problem) return { value: formatted, status: "review", note: `SSN ${problem}` };
  return { value: formatted, status: raw.trim() === formatted ? "clean" : "fixed" };
}

export function normalizeRouting(raw: string): Normalized {
  const digits = digitsOf(raw);
  if (digits.length !== 9) {
    return { value: digits, status: "review", note: "routing number is not nine digits" };
  }
  if (!isAbaRouting(digits)) {
    return { value: digits, status: "review", note: "routing number fails the ABA checksum" };
  }
  return { value: digits, status: raw.trim() === digits ? "clean" : "fixed" };
}

export function normalizeAccountNumber(raw: string): Normalized {
  const digits = digitsOf(raw);
  if (!digits) return { value: "", status: "review", note: "no account number found" };
  if (digits.length < 4 || digits.length > 17) {
    return { value: digits, status: "review", note: `account number is ${digits.length} digits` };
  }
  return { value: digits, status: raw.trim() === digits ? "clean" : "fixed" };
}

export function normalizeCard(raw: string): Normalized {
  const digits = digitsOf(raw);
  if (digits.length < 15 || digits.length > 16) {
    return { value: digits, status: "review", note: `card number is ${digits.length} digits` };
  }
  if (!isLuhn(digits)) {
    return { value: digits, status: "review", note: "card number fails the Luhn check" };
  }
  return { value: digits, status: raw.trim() === digits ? "clean" : "fixed" };
}

export function last4(cardDigits: string | null | undefined) {
  if (!cardDigits) return null;
  const digits = digitsOf(cardDigits);
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * A card expiry has run out once its month is over — it is valid through the
 * last day of the month it names, so only a strictly earlier month is expired.
 * Two-digit years are read as this century; no card carries a 19xx expiry.
 */
function expiryExpired(month: number, yy: string, now: Date) {
  const year = 2000 + Number(yy);
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  return year < nowYear || (year === nowYear && month < nowMonth);
}

/**
 * MM/YY or MM/YYYY in, MM/YY out.
 *
 * A well-formed but expired date is still emitted — the operator needs to see
 * what the file actually said — but it is marked for review rather than passed
 * off as clean.
 */
export function normalizeExpiry(raw: string, now = new Date()): Normalized {
  const match = collapseSpace(raw).match(/^(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})$/);

  let month: number;
  let yy: string;

  if (match) {
    month = Number(match[1]);
    const yearPart = match[2] ?? "";
    if (month < 1 || month > 12) {
      return { value: collapseSpace(raw), status: "review", note: `expiry month is ${month}` };
    }
    yy = yearPart.length === 4 ? yearPart.slice(2) : yearPart;
  } else {
    const bare = digitsOf(raw);
    if (bare.length !== 4) {
      return { value: collapseSpace(raw), status: "review", note: "expiry is not MM/YY" };
    }
    month = Number(bare.slice(0, 2));
    if (month < 1 || month > 12) {
      return { value: collapseSpace(raw), status: "review", note: "expiry is not MM/YY" };
    }
    yy = bare.slice(2);
  }

  const value = `${String(month).padStart(2, "0")}/${yy}`;
  if (expiryExpired(month, yy, now)) {
    return { value, status: "review", note: `card expired ${value}` };
  }
  return { value, status: raw.trim() === value ? "clean" : "fixed" };
}

export function normalizeCvv(raw: string): Normalized {
  const digits = digitsOf(raw);
  if (digits.length < 3 || digits.length > 4) {
    return { value: digits, status: "review", note: "CVV is not 3-4 digits" };
  }
  return { value: digits, status: raw.trim() === digits ? "clean" : "fixed" };
}

export function normalizePhone(raw: string): Normalized {
  let digits = digitsOf(raw);
  let trimmedCountryCode = false;
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
    trimmedCountryCode = true;
  }
  if (digits.length !== 10) {
    return { value: digits, status: "review", note: `phone number has ${digits.length} digits` };
  }
  const area = digits.slice(0, 3);
  if (area.startsWith("0") || area.startsWith("1")) {
    return {
      value: digits,
      status: "review",
      note: `area code ${area} cannot start with ${area[0]}`,
    };
  }
  const value = `(${area}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return {
    value,
    status: !trimmedCountryCode && raw.trim() === value ? "clean" : "fixed",
  };
}

/**
 * Spreadsheets treat a ZIP as a number and eat the leading zero, so 02134
 * arrives as 2134. Padding it back to five is the commonest fix in this file.
 */
export function normalizeZip(raw: string, state?: string | null): Normalized {
  const digits = digitsOf(raw);
  if (!digits) return { value: "", status: "review", note: "no ZIP digits found" };

  let value = digits;
  let status: Normalized["status"] = "clean";
  let note: string | undefined;

  if (digits.length === 9) {
    value = digits.slice(0, 5);
    status = "fixed";
    note = "ZIP+4 trimmed to five digits";
  } else if (digits.length < 5) {
    value = digits.padStart(5, "0");
    status = "fixed";
    note = "padded to five digits";
  } else if (digits.length > 5) {
    return { value: digits, status: "review", note: `ZIP has ${digits.length} digits` };
  } else if (raw.trim() !== digits) {
    status = "fixed";
  }

  if (state) {
    const owner = stateForZip(value);
    if (owner && owner !== state.toUpperCase()) {
      return { value, status: "review", note: `ZIP ${value} is in ${owner}, not ${state}` };
    }
  }

  return note ? { value, status, note } : { value, status };
}

export function normalizeState(raw: string): Normalized {
  const cleaned = collapseSpace(raw.replace(/[.,]/g, " "));
  if (!cleaned) return { value: "", status: "review", note: "no state given" };

  const upper = cleaned.toUpperCase();
  if (upper.length === 2 && STATE_ABBREVIATIONS.has(upper)) {
    return { value: upper, status: raw.trim() === upper ? "clean" : "fixed" };
  }

  // "N.Y." and "N Y" are the same code once the punctuation is gone.
  const compact = cleaned.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (compact.length === 2 && STATE_ABBREVIATIONS.has(compact)) {
    return { value: compact, status: "fixed" };
  }

  const key = slug(cleaned);
  const exact = STATE_CODES[key];
  if (exact) return { value: exact, status: "fixed" };

  // A two-letter input is either a code or a mystery: "CA" and "GA" are one
  // edit apart, so fuzzy-matching short strings would silently pick a state.
  if (key.length < 4) {
    return { value: upper, status: "review", note: `"${cleaned}" is not a state code` };
  }

  const prefixed = STATE_NAMES.filter((name) => name.startsWith(key));
  const onlyPrefix = prefixed.length === 1 ? prefixed[0] : undefined;
  if (onlyPrefix) {
    const code = STATE_CODES[onlyPrefix];
    if (code) return { value: code, status: "fixed", note: `read as ${onlyPrefix}` };
  }

  let best: { name: string; distance: number } | null = null;
  for (const name of STATE_NAMES) {
    const distance = levenshtein(key, name);
    if (!best || distance < best.distance) best = { name, distance };
  }
  if (best && best.distance <= 2) {
    const code = STATE_CODES[best.name];
    if (code) return { value: code, status: "fixed", note: `corrected from "${cleaned}"` };
  }
  return { value: cleaned, status: "review", note: `"${cleaned}" is not a recognised state` };
}

/** Appears as "$47.70" and as "61.69$", sometimes with thousands commas. */
export function normalizeCurrency(raw: string): Normalized {
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) {
    return { value: collapseSpace(raw), status: "review", note: "no amount found" };
  }
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) {
    return { value: collapseSpace(raw), status: "review", note: "amount is not a number" };
  }
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return { value, status: raw.trim() === value ? "clean" : "fixed" };
}

const TYPO_DOMAINS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmaill.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gamil.com": "gmail.com",
  "yahooo.com": "yahoo.com",
  "yaho.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "yahoi.com": "yahoo.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "outlok.com": "outlook.com",
  "outllok.com": "outlook.com",
  "iclod.com": "icloud.com",
  "aol.co": "aol.com",
};

export function normalizeEmail(raw: string): Normalized {
  const value = collapseSpace(raw).toLowerCase();
  if (!value) return { value: "", status: "review", note: "no email given" };
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(value)) {
    return { value, status: "review", note: "email is not a valid address" };
  }
  const domain = value.slice(value.lastIndexOf("@") + 1);
  const suggestion = TYPO_DOMAINS[domain];
  if (suggestion) return { value, status: "review", note: `did you mean @${suggestion}?` };
  return { value, status: raw.trim() === value ? "clean" : "fixed" };
}

export function normalizeName(raw: string): Normalized {
  const value = titleCaseName(raw);
  if (!value) return { value: "", status: "review", note: "no name given" };
  return { value, status: raw.trim() === value ? "clean" : "fixed" };
}

/**
 * `carriers` is the live list from the `carriers` table, handed down from the
 * upload tool. An empty list therefore flags every carrier rather than
 * inventing one — which is the right answer when the list could not be read.
 */
export function normalizeCarrier(raw: string, carriers: CarrierRef[]): Normalized {
  const cleaned = collapseSpace(raw);
  if (!cleaned) return { value: "", status: "review", note: "no carrier given" };
  const canonical = lookupCarrier(cleaned, carriers);
  if (!canonical) {
    return { value: cleaned, status: "review", note: `"${cleaned}" is not a known carrier` };
  }
  return { value: canonical, status: cleaned === canonical ? "clean" : "fixed" };
}

export function normalizeBankName(raw: string): Normalized {
  const cleaned = collapseSpace(raw);
  if (!cleaned) return { value: "", status: "review", note: "no bank name given" };
  // Source files shout their bank names ("US BANK"); the rest of the app does not.
  const value = cleaned === cleaned.toUpperCase() ? titleCaseName(cleaned) : cleaned;
  return { value, status: value === raw.trim() ? "clean" : "fixed" };
}

export function normalizeText(raw: string): Normalized {
  const value = collapseSpace(raw);
  if (!value) return { value: "", status: "clean" };
  return { value, status: raw === value ? "clean" : "fixed" };
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The one output format for every normalised date: MM/DD/YYYY.
 *
 * Parsing is unchanged and still accepts ISO, day-first, two-digit years, named
 * months and spreadsheet serials — only what comes out is fixed. Anything that
 * needs the parts back should go through `dateParts`, not split on a separator.
 */
function formatDate(year: number, month: number, day: number) {
  return [
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
    String(year).padStart(4, "0"),
  ].join("/");
}

/** Read a normalised MM/DD/YYYY value back into numbers. */
function dateParts(value: string) {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return { month: Number(match[1]), day: Number(match[2]), year: Number(match[3]) };
}

/** A value that arrived already in canonical form was not touched. */
function statusFor(raw: string, value: string): Normalized["status"] {
  return raw === value ? "clean" : "fixed";
}

/** Two-digit years pivot on the current year: 51 is 1951, 05 is 2005. */
function expandYear(part: string, now: Date) {
  if (part.length === 4) return Number(part);
  const yy = Number(part);
  const currentYy = now.getUTCFullYear() % 100;
  return yy <= currentYy ? 2000 + yy : 1900 + yy;
}

/** Age in whole years from a normalised MM/DD/YYYY date. */
export function ageFrom(value: string, now: Date) {
  const parts = dateParts(value);
  if (!parts) return null;
  let age = now.getUTCFullYear() - parts.year;
  const monthDelta = now.getUTCMonth() + 1 - parts.month;
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < parts.day)) age -= 1;
  return age;
}

export type DateOptions = {
  /** Apply the 18-100 plausibility check and pull future dates back a century. */
  birthDate?: boolean;
  now?: Date;
};

/**
 * Real files mix "1951-04-01 0:00:00", "5/24/1941" and "8/27/1971" in one
 * column. Where both halves could be a month the order is genuinely unknown, so
 * the value is emitted under the US reading but marked 'review' rather than
 * quietly assumed — that is the one case a human has to settle.
 */
export function normalizeDate(raw: string, options: DateOptions = {}): Normalized {
  const now = options.now ?? new Date();
  const text = collapseSpace(raw);
  if (!text) return { value: "", status: "review", note: "no date given" };

  const parsed = parseDateText(text, now);
  if (!parsed) return { value: text, status: "review", note: "date could not be read" };

  let value = parsed.value;
  let status = parsed.status;
  let note = parsed.note;

  if (options.birthDate) {
    const age = ageFrom(value, now);
    if (age !== null && age < 0) {
      // A two-digit year that landed in the future can only be last century.
      const parts = dateParts(value);
      if (parts) {
        value = formatDate(parts.year - 100, parts.month, parts.day);
        status = "fixed";
        note = "two-digit year read as last century";
      }
    }
    const finalAge = ageFrom(value, now);
    if (finalAge !== null && (finalAge < 18 || finalAge > 100)) {
      return { value, status: "review", note: `age works out at ${finalAge}` };
    }
  }

  return note ? { value, status, note } : { value, status };
}

function parseDateText(text: string, now: Date): Normalized | null {
  // A trailing "0:00:00" from a spreadsheet export carries no information.
  const body = text.replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\s*[AaPp]\.?[Mm]\.?)?$/, "").trim();

  const isoMatch = body.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (!validParts(year, month, day)) return null;
    const value = formatDate(year, month, day);
    return { value, status: statusFor(text, value) };
  }

  const compact = body.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const year = Number(compact[1]);
    const month = Number(compact[2]);
    const day = Number(compact[3]);
    if (validParts(year, month, day)) {
      const value = formatDate(year, month, day);
      return { value, status: statusFor(text, value) };
    }
  }

  const named = parseNamedMonth(body, now);
  if (named) return named;

  const slashed = body.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
  if (slashed) {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    const year = expandYear(slashed[3] ?? "", now);

    if (first > 12 && second > 12) return null;
    if (first > 12) {
      if (!validParts(year, second, first)) return null;
      return {
        value: formatDate(year, second, first),
        status: "fixed",
        note: "read as day/month/year",
      };
    }
    if (second > 12 || first === second) {
      if (!validParts(year, first, second)) return null;
      const value = formatDate(year, first, second);
      return { value, status: statusFor(text, value) };
    }
    if (!validParts(year, first, second)) return null;
    return {
      value: formatDate(year, first, second),
      status: "review",
      note: `ambiguous: ${first}/${second} could be month/day or day/month`,
    };
  }

  // Excel serial dates, which survive an export as a bare number.
  if (/^\d{1,5}$/.test(body)) {
    const serial = Number(body);
    if (serial > 0 && serial < 60000) {
      const date = new Date(EXCEL_EPOCH_UTC + serial * 86_400_000);
      return {
        value: formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
        status: "fixed",
        note: "read as a spreadsheet serial date",
      };
    }
  }

  return null;
}

function parseNamedMonth(body: string, now: Date): Normalized | null {
  const cleaned = body.replace(/,/g, " ").replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  const parts = collapseSpace(cleaned).split(" ");
  if (parts.length !== 3) return null;

  const monthIndex = parts.findIndex((part) => monthNumber(part) !== null);
  if (monthIndex === -1) return null;
  const month = monthNumber(parts[monthIndex] ?? "");
  const [a, b] = parts.filter((_, index) => index !== monthIndex);
  if (!month || a === undefined || b === undefined) return null;
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;

  const dayFirst = a.length <= 2 && Number(a) <= 31;
  const day = dayFirst ? Number(a) : Number(b);
  const year = expandYear(dayFirst ? b : a, now);
  if (!validParts(year, month, day)) return null;
  return { value: formatDate(year, month, day), status: "fixed" };
}

function monthNumber(part: string): number | null {
  const lower = part.toLowerCase().replace(/\.$/, "");
  if (lower.length < 3) return null;
  const index = MONTH_NAMES.findIndex((name) => name.startsWith(lower) || lower.startsWith(name));
  return index === -1 ? null : index + 1;
}

function validParts(year: number, month: number, day: number) {
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}
