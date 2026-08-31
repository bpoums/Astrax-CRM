import { describe, expect, it } from "vitest";
import { fieldWarning } from "./form-warnings";

/**
 * These lock the wording, because the wording is the feature: a closer reads
 * this mid-call. The checks underneath are the normaliser's and are tested in
 * src/lib/normalize/rules.test.ts — nothing is re-verified here.
 */

const NOW = new Date(2026, 7, 21); // 21 Aug 2026
const NO_OTHER_FIELDS: Record<string, string> = {};

describe("routing number", () => {
  it("says nothing until there is something to say", () => {
    expect(fieldWarning("Routing Number", "", NO_OTHER_FIELDS, NOW)).toBeNull();
    expect(fieldWarning("Routing Number", "   ", NO_OTHER_FIELDS, NOW)).toBeNull();
  });

  it("asks for nine digits when there are fewer", () => {
    expect(fieldWarning("Routing Number", "12345", NO_OTHER_FIELDS, NOW)).toEqual({
      tone: "warn",
      text: "Routing numbers are 9 digits.",
    });
  });

  it("asks for a re-read when nine digits fail the checksum", () => {
    expect(fieldWarning("Routing Number", "021000022", NO_OTHER_FIELDS, NOW)).toEqual({
      tone: "warn",
      text: "This doesn't look like a valid routing number — please re-read it back to the customer.",
    });
  });

  it("confirms a number that passes", () => {
    const warning = fieldWarning("Routing Number", "021000021", NO_OTHER_FIELDS, NOW);
    expect(warning?.tone).toBe("ok");
  });

  it("ignores the separators a closer might type", () => {
    expect(fieldWarning("Routing Number", "021-000-021", NO_OTHER_FIELDS, NOW)?.tone).toBe("ok");
  });
});

describe("SSN", () => {
  it("passes a structurally possible SSN quietly", () => {
    expect(fieldWarning("SSN Number", "123-45-6789", NO_OTHER_FIELDS, NOW)).toBeNull();
  });

  it("warns on an impossible area, group or serial", () => {
    expect(fieldWarning("SSN Number", "000-45-6789", NO_OTHER_FIELDS, NOW)?.tone).toBe("warn");
    expect(fieldWarning("SSN Number", "666-45-6789", NO_OTHER_FIELDS, NOW)?.tone).toBe("warn");
    expect(fieldWarning("SSN Number", "900-45-6789", NO_OTHER_FIELDS, NOW)?.tone).toBe("warn");
    expect(fieldWarning("SSN Number", "123-00-6789", NO_OTHER_FIELDS, NOW)?.tone).toBe("warn");
    expect(fieldWarning("SSN Number", "123-45-0000", NO_OTHER_FIELDS, NOW)?.tone).toBe("warn");
    expect(fieldWarning("SSN Number", "111-11-1111", NO_OTHER_FIELDS, NOW)?.tone).toBe("warn");
  });
});

describe("zip against state", () => {
  it("stays quiet when the zip belongs to the state", () => {
    expect(fieldWarning("Customer Zip Code", "02134", { State: "MA" }, NOW)).toBeNull();
  });

  it("flags a mismatch", () => {
    expect(fieldWarning("Customer Zip Code", "02134", { State: "TX" }, NOW)).toEqual({
      tone: "warn",
      text: "Zip doesn't match the selected state — please confirm.",
    });
  });

  it("resolves whatever spelling of the state was typed", () => {
    expect(fieldWarning("Customer Zip Code", "90210", { State: "California" }, NOW)).toBeNull();
    expect(fieldWarning("Customer Zip Code", "90210", { State: "Texas" }, NOW)?.tone).toBe("warn");
  });

  it("does not contradict a state it cannot resolve", () => {
    expect(fieldWarning("Customer Zip Code", "02134", { State: "???" }, NOW)).toBeNull();
    expect(fieldWarning("Customer Zip Code", "02134", NO_OTHER_FIELDS, NOW)).toBeNull();
  });

  it("asks for five digits", () => {
    expect(fieldWarning("Customer Zip Code", "021", { State: "MA" }, NOW)?.tone).toBe("warn");
  });
});

describe("card number", () => {
  it("names the brand when the number checks out", () => {
    expect(fieldWarning("Card Number", "4111111111111111", NO_OTHER_FIELDS, NOW)).toEqual({
      tone: "ok",
      text: "✓ Visa",
    });
    expect(fieldWarning("Card Number", "378282246310005", NO_OTHER_FIELDS, NOW)).toEqual({
      tone: "ok",
      text: "✓ Amex",
    });
  });

  it("asks for confirmation when Luhn fails", () => {
    expect(fieldWarning("Card Number", "4111111111111112", NO_OTHER_FIELDS, NOW)).toEqual({
      tone: "warn",
      text: "This card number doesn't check out — please confirm the digits.",
    });
  });
});

describe("expiry", () => {
  it("accepts a date still ahead", () => {
    expect(fieldWarning("Exp Date", "12/26", NO_OTHER_FIELDS, NOW)).toBeNull();
  });

  it("flags one that has passed", () => {
    expect(fieldWarning("Exp Date", "07/26", NO_OTHER_FIELDS, NOW)?.tone).toBe("warn");
  });

  it("flags a month that does not exist", () => {
    expect(fieldWarning("Exp Date", "13/28", NO_OTHER_FIELDS, NOW)?.tone).toBe("warn");
  });
});

describe("fields it does not check", () => {
  it("returns nothing rather than guessing", () => {
    expect(fieldWarning("Full Name", "Bob", NO_OTHER_FIELDS, NOW)).toBeNull();
    expect(fieldWarning("Premium", "not a number", NO_OTHER_FIELDS, NOW)).toBeNull();
  });
});
