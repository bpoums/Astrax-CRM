import { describe, expect, it } from "vitest";
import {
  ageFrom,
  cardBrand,
  expiryProblem,
  isAbaRouting,
  isCardNumber,
  isLuhn,
  isSsn,
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
} from "./rules";
import { stateForZip } from "./states";
import { normalizeZip } from "./rules";
import { levenshtein, titleCaseName } from "./text";

const NOW = new Date(Date.UTC(2026, 7, 21));

describe("checksums", () => {
  it("accepts routing numbers that pass ABA mod-10", () => {
    expect(isAbaRouting("021000021")).toBe(true);
    expect(isAbaRouting("122105155")).toBe(true);
  });

  it("rejects routing numbers that do not", () => {
    expect(isAbaRouting("021000022")).toBe(false);
    expect(isAbaRouting("568809709")).toBe(false);
    expect(isAbaRouting("12345678")).toBe(false);
  });

  it("accepts card numbers that pass Luhn at 15 and 16 digits", () => {
    expect(isCardNumber("4111111111111111")).toBe(true);
    expect(isCardNumber("378282246310005")).toBe(true);
  });

  it("rejects the wrong length even when Luhn passes", () => {
    expect(isLuhn("4222222222222")).toBe(true);
    expect(isCardNumber("4222222222222")).toBe(false);
  });
});

describe("normalizeSsn", () => {
  it("formats nine digits as XXX-XX-XXXX", () => {
    expect(normalizeSsn("568809709")).toEqual({ value: "568-80-9709", status: "fixed" });
    expect(normalizeSsn("568-80-9709").status).toBe("clean");
  });

  it("strips an inline label", () => {
    expect(normalizeSsn("SSN: 568-80-9709").value).toBe("568-80-9709");
  });

  it.each([
    ["000123456", "area"],
    ["666123456", "area"],
    ["900123456", "area"],
    ["123004567", "group"],
    ["123450000", "serial"],
    ["111111111", "repeated"],
  ])("flags %s for review", (digits) => {
    const result = normalizeSsn(digits);
    expect(result.status).toBe("review");
    expect(result.note).toBeTruthy();
  });

  it("flags the wrong digit count", () => {
    expect(normalizeSsn("5688097").status).toBe("review");
  });

  it("agrees with isSsn", () => {
    expect(isSsn("568809709")).toBe(true);
    expect(isSsn("666123456")).toBe(false);
  });
});

describe("normalizeRouting", () => {
  it("keeps a valid nine-digit routing number", () => {
    expect(normalizeRouting("021000021")).toEqual({ value: "021000021", status: "clean" });
  });

  it("strips a label and reformats", () => {
    expect(normalizeRouting("Routing: 021000021")).toEqual({
      value: "021000021",
      status: "fixed",
    });
  });

  it("flags the ten-digit value real files carry", () => {
    const result = normalizeRouting("0070158296");
    expect(result.status).toBe("review");
    expect(result.note).toContain("nine digits");
  });

  it("flags a checksum failure", () => {
    expect(normalizeRouting("021000029").note).toContain("ABA");
  });
});

describe("normalizeCard", () => {
  it("accepts a Luhn-valid card", () => {
    expect(normalizeCard("4111 1111 1111 1111")).toEqual({
      value: "4111111111111111",
      status: "fixed",
    });
  });

  it("flags a Luhn failure rather than dropping the value", () => {
    const result = normalizeCard("4366-1031-4047-6613");
    expect(result.value).toBe("4366103140476613");
    expect(result.status).toBe("review");
    expect(result.note).toContain("Luhn");
  });

  it("exposes only the last four", () => {
    expect(last4("4111111111111111")).toBe("1111");
    expect(last4(null)).toBeNull();
  });
});

describe("normalizeExpiry", () => {
  it("normalises MM/YY and MM/YYYY to MM/YY", () => {
    expect(normalizeExpiry("05/30", NOW)).toEqual({ value: "05/30", status: "clean" });
    expect(normalizeExpiry("5/2030", NOW)).toEqual({ value: "05/30", status: "fixed" });
    expect(normalizeExpiry("0530", NOW)).toEqual({ value: "05/30", status: "fixed" });
  });

  it("flags an impossible month", () => {
    expect(normalizeExpiry("13/25", NOW).status).toBe("review");
    expect(normalizeExpiry("00/30", NOW).status).toBe("review");
  });

  it("flags a card that has already expired", () => {
    // NOW is August 2026.
    const result = normalizeExpiry("05/17", NOW);
    expect(result).toEqual({ value: "05/17", status: "review", note: "card expired 05/17" });
    expect(normalizeExpiry("07/26", NOW).status).toBe("review");
  });

  it("accepts a card that expires this month", () => {
    // A card is good through the last day of the month it names.
    expect(normalizeExpiry("08/26", NOW)).toEqual({ value: "08/26", status: "clean" });
  });

  it("flags something that is not an expiry at all", () => {
    expect(normalizeExpiry("n/a", NOW).status).toBe("review");
  });
});

describe("cardBrand", () => {
  it("reads the issuer off the leading digits", () => {
    expect(cardBrand("4111111111111111")).toBe("Visa");
    expect(cardBrand("5555555555554444")).toBe("Mastercard");
    expect(cardBrand("2221000000000009")).toBe("Mastercard");
    expect(cardBrand("2720999999999996")).toBe("Mastercard");
    expect(cardBrand("378282246310005")).toBe("Amex");
    expect(cardBrand("6011111111111117")).toBe("Discover");
    expect(cardBrand("6500000000000002")).toBe("Discover");
  });

  it("returns null for a prefix it does not know", () => {
    expect(cardBrand("9999999999999999")).toBeNull();
    expect(cardBrand("2220000000000000")).toBeNull();
    expect(cardBrand("")).toBeNull();
    expect(cardBrand("not digits")).toBeNull();
  });

  it("says nothing about validity", () => {
    // a Visa prefix on a number that fails Luhn
    expect(cardBrand("4111111111111112")).toBe("Visa");
    expect(isLuhn("4111111111111112")).toBe(false);
  });
});

describe("expiryProblem", () => {
  const now = new Date(2026, 7, 21); // 21 Aug 2026, local

  it("accepts a future expiry", () => {
    expect(expiryProblem("12/26", now)).toBeNull();
    expect(expiryProblem("01/30", now)).toBeNull();
  });

  it("treats the stated month as valid through its last day", () => {
    expect(expiryProblem("08/26", now)).toBeNull();
    expect(expiryProblem("07/26", now)).toBe("past");
  });

  it("flags a month that does not exist", () => {
    expect(expiryProblem("13/28", now)).toBe("month");
    expect(expiryProblem("00/28", now)).toBe("month");
  });

  it("flags anything it cannot read as MM/YY", () => {
    expect(expiryProblem("", now)).toBe("format");
    expect(expiryProblem("next year", now)).toBe("format");
  });

  it("reads the formats normalizeExpiry already accepts", () => {
    expect(expiryProblem("1226", now)).toBeNull();
    expect(expiryProblem("12/2026", now)).toBeNull();
    expect(expiryProblem("7/26", now)).toBe("past");
  });
});

describe("normalizeCvv", () => {
  it("accepts three and four digits", () => {
    expect(normalizeCvv("145").status).toBe("clean");
    expect(normalizeCvv("1450").status).toBe("clean");
  });

  it("flags anything else", () => {
    expect(normalizeCvv("14").status).toBe("review");
    expect(normalizeCvv("14567").status).toBe("review");
  });
});

describe("normalizePhone", () => {
  it("formats ten digits", () => {
    expect(normalizePhone("5551234567")).toEqual({ value: "(555) 123-4567", status: "fixed" });
    expect(normalizePhone("(555) 123-4567").status).toBe("clean");
  });

  it("strips a leading country code", () => {
    expect(normalizePhone("1-555-123-4567")).toEqual({ value: "(555) 123-4567", status: "fixed" });
  });

  it("rejects an area code starting 0 or 1", () => {
    expect(normalizePhone("0551234567").status).toBe("review");
    expect(normalizePhone("1551234567").status).toBe("review");
  });

  it("flags the wrong digit count", () => {
    expect(normalizePhone("55512345").status).toBe("review");
  });
});

describe("normalizeZip", () => {
  it("pads a leading zero the spreadsheet ate", () => {
    expect(normalizeZip("2134")).toEqual({
      value: "02134",
      status: "fixed",
      note: "padded to five digits",
    });
  });

  it("trims ZIP+4", () => {
    expect(normalizeZip("02134-1234").value).toBe("02134");
  });

  it("cross-checks the prefix against the state", () => {
    expect(normalizeZip("02134", "MA").status).toBe("clean");
    const mismatch = normalizeZip("02134", "TX");
    expect(mismatch.status).toBe("review");
    expect(mismatch.note).toContain("MA");
  });

  it("knows which state owns a prefix", () => {
    expect(stateForZip("02134")).toBe("MA");
    expect(stateForZip("75001")).toBe("TX");
    expect(stateForZip("90210")).toBe("CA");
  });
});

describe("normalizeState", () => {
  it("passes a valid code through", () => {
    expect(normalizeState("TX")).toEqual({ value: "TX", status: "clean" });
    expect(normalizeState("tx")).toEqual({ value: "TX", status: "fixed" });
  });

  it("is insensitive to case, spacing and punctuation", () => {
    expect(normalizeState("  new   york ").value).toBe("NY");
    expect(normalizeState("N.Y.").value).toBe("NY");
  });

  it("corrects a typo within two edits", () => {
    expect(normalizeState("Californai").value).toBe("CA");
    expect(normalizeState("Texs").value).toBe("TX");
  });

  it("never auto-picks beyond that", () => {
    const result = normalizeState("Freedonia");
    expect(result.status).toBe("review");
  });

  it("refuses to fuzzy-match a two-letter code", () => {
    // "XA" is one edit from both CA and GA — guessing would be worse than flagging.
    expect(normalizeState("XA").status).toBe("review");
  });
});

describe("normalizeDate", () => {
  // Every normalised date comes out MM/DD/YYYY, whatever went in.
  it("reads the spreadsheet export format", () => {
    expect(normalizeDate("1951-04-01 0:00:00", { now: NOW })).toEqual({
      value: "04/01/1951",
      status: "fixed",
    });
  });

  it("reads an unambiguous US date", () => {
    expect(normalizeDate("5/24/1941", { now: NOW }).value).toBe("05/24/1941");
    expect(normalizeDate("8/27/1971", { now: NOW }).value).toBe("08/27/1971");
  });

  it("leaves a date that is already MM/DD/YYYY alone", () => {
    expect(normalizeDate("08/27/1971", { now: NOW })).toEqual({
      value: "08/27/1971",
      status: "clean",
    });
  });

  it("flags an ambiguous one instead of assuming", () => {
    const result = normalizeDate("01/02/1990", { now: NOW });
    expect(result.status).toBe("review");
    expect(result.note).toContain("ambiguous");
    expect(result.value).toBe("01/02/1990");
  });

  it("reads a day-first date when the first part cannot be a month", () => {
    const result = normalizeDate("24/05/1941", { now: NOW });
    expect(result.value).toBe("05/24/1941");
    expect(result.status).toBe("fixed");
  });

  it("expands a two-digit year", () => {
    expect(normalizeDate("5/24/41", { now: NOW }).value).toBe("05/24/1941");
  });

  it("reads a named month", () => {
    expect(normalizeDate("April 1, 1951", { now: NOW }).value).toBe("04/01/1951");
  });

  it("reads a spreadsheet serial", () => {
    expect(normalizeDate("44197", { now: NOW }).value).toBe("01/01/2021");
  });

  it("flags an age under 18", () => {
    const result = normalizeDate("2015-01-01", { birthDate: true, now: NOW });
    expect(result.status).toBe("review");
    expect(result.note).toContain("11");
  });

  it("flags an age over 100", () => {
    expect(normalizeDate("1910-01-01", { birthDate: true, now: NOW }).status).toBe("review");
  });

  it("accepts a plausible age", () => {
    expect(normalizeDate("08/27/1971", { birthDate: true, now: NOW }).status).toBe("clean");
    expect(normalizeDate("1971-08-27", { birthDate: true, now: NOW })).toEqual({
      value: "08/27/1971",
      status: "fixed",
    });
  });

  it("rejects a date it cannot read", () => {
    expect(normalizeDate("sometime last spring", { now: NOW }).status).toBe("review");
    expect(normalizeDate("2/30/1990", { now: NOW }).status).toBe("review");
  });

  it("computes an age", () => {
    expect(ageFrom("08/27/1971", NOW)).toBe(54);
    expect(ageFrom("1971-08-27", NOW)).toBeNull();
  });
});

describe("normalizeCurrency", () => {
  it("strips a leading dollar sign and commas", () => {
    expect(normalizeCurrency("$47.70")).toEqual({ value: "47.70", status: "fixed" });
    expect(normalizeCurrency("$1,234.50").value).toBe("1234.50");
  });

  it("strips a trailing dollar sign", () => {
    expect(normalizeCurrency("61.69$").value).toBe("61.69");
  });

  it("keeps a whole number whole", () => {
    expect(normalizeCurrency("$25,000").value).toBe("25000");
  });

  it("flags text with no amount in it", () => {
    expect(normalizeCurrency("call me").status).toBe("review");
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  JOHN@Gmail.com ")).toEqual({
      value: "john@gmail.com",
      status: "fixed",
    });
  });

  it("flags a typo domain", () => {
    const result = normalizeEmail("john@gmial.com");
    expect(result.status).toBe("review");
    expect(result.note).toContain("gmail.com");
    expect(normalizeEmail("jane@yahooo.com").status).toBe("review");
  });

  it("flags an invalid address", () => {
    expect(normalizeEmail("not-an-email").status).toBe("review");
  });
});

describe("normalizeName", () => {
  it("collapses whitespace and title-cases", () => {
    expect(normalizeName("  jane   doe ")).toEqual({ value: "Jane Doe", status: "fixed" });
  });

  it("restores Mc and keeps hyphens and apostrophes", () => {
    expect(titleCaseName("mcdonald")).toBe("McDonald");
    expect(titleCaseName("o'brien-smith")).toBe("O'Brien-Smith");
  });

  it("leaves a name that already has its capitals alone", () => {
    expect(titleCaseName("MacLeod")).toBe("MacLeod");
    expect(titleCaseName("DeVito")).toBe("DeVito");
  });
});

/**
 * The carrier list now comes from the `carriers` table and is passed in, so the
 * tests supply their own fixture rather than leaning on a constant that no
 * longer exists. Only "Trans America" needs to be spelled as an alias — the
 * rest are reached by stripping punctuation off the canonical name.
 */
const CARRIERS = [
  { name: "TransAmerica", aliases: ["trans america", "ta"] },
  { name: "Insta Brain", aliases: [] },
  { name: "GWS", aliases: [] },
];

describe("normalizeCarrier", () => {
  it("treats GWS and GW's as one carrier", () => {
    expect(normalizeCarrier("GWS", CARRIERS).value).toBe("GWS");
    expect(normalizeCarrier("GW's", CARRIERS).value).toBe("GWS");
    expect(normalizeCarrier("gw s", CARRIERS).value).toBe("GWS");
  });

  it("normalises spacing variants", () => {
    expect(normalizeCarrier("trans america", CARRIERS).value).toBe("TransAmerica");
    expect(normalizeCarrier("INSTABRAIN", CARRIERS).value).toBe("Insta Brain");
  });

  it("matches an alias whose letters differ from the name", () => {
    expect(normalizeCarrier("TA", CARRIERS).value).toBe("TransAmerica");
  });

  it("flags a carrier it does not recognise", () => {
    const result = normalizeCarrier("Northern Sky Mutual", CARRIERS);
    expect(result.status).toBe("review");
    expect(result.value).toBe("Northern Sky Mutual");
  });

  // Whatever the reason the list is empty — a carrier table that has not been
  // filled in, or a read that was refused — nothing may be auto-picked.
  it("flags everything when no carriers are supplied", () => {
    expect(normalizeCarrier("TransAmerica", []).status).toBe("review");
  });
});

describe("bank and account", () => {
  it("un-shouts a bank name", () => {
    expect(normalizeBankName("US BANK").value).toBe("Us Bank");
  });

  it("keeps digits only for an account number", () => {
    expect(normalizeAccountNumber("Account: 113105070").value).toBe("113105070");
  });

  it("flags an implausible account number length", () => {
    expect(normalizeAccountNumber("12").status).toBe("review");
  });
});

describe("levenshtein", () => {
  it("measures edit distance", () => {
    expect(levenshtein("texas", "texas")).toBe(0);
    expect(levenshtein("texs", "texas")).toBe(1);
    expect(levenshtein("californai", "california")).toBe(2);
  });
});
