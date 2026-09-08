import { describe, expect, it } from "vitest";
import {
  closeField,
  closeHeight,
  closeMoney,
  maskField,
  maskMoney,
  maskStateCode,
} from "./field-mask";

/**
 * Typing, one keystroke at a time.
 *
 * The masks take the previous value as well as the new one, so testing them
 * with single calls would miss the case they exist for — backspacing over a
 * separator the mask inserted itself. This replays what the browser actually
 * hands a controlled input: the current value with one character added at the
 * end, or one removed.
 */
function type(label: string, keys: string) {
  let value = "";
  for (const key of keys) value = maskField(label, value + key, value);
  return value;
}

function backspace(label: string, value: string) {
  return maskField(label, value.slice(0, -1), value);
}

describe("height", () => {
  it("inserts the foot mark after the first digit", () => {
    expect(type("Height", "5")).toBe("5'");
  });

  it("closes itself the instant a third digit lands", () => {
    expect(type("Height", "56")).toBe("5'6");
    expect(type("Height", "612")).toBe("6'12\"");
  });

  // Given explicitly as a valid value, so the mask must not cap inches at 11.
  it("accepts 6'12\"", () => {
    expect(type("Height", "612")).toBe("6'12\"");
  });

  it("closes a short entry on blur", () => {
    expect(closeField("Height", "5'6")).toBe("5'6\"");
    // One digit is whole feet, not a field left half-formatted.
    expect(closeHeight("5'")).toBe("5'0\"");
    expect(closeHeight("")).toBe("");
  });

  it("takes the digit with the separator when backspacing", () => {
    // The `'` was never typed, so deleting it deletes the 5 behind it —
    // otherwise the mask rebuilds it and the field can never be cleared.
    expect(backspace("Height", "5'")).toBe("");
    expect(backspace("Height", "6'12\"")).toBe("6'1");
    // A digit at the end is an ordinary delete.
    expect(backspace("Height", "5'6")).toBe("5'");
  });

  it("ignores everything that is not a digit", () => {
    expect(type("Height", "5ft6in")).toBe("5'6");
  });
});

describe("money", () => {
  it("prefixes and groups as it is typed", () => {
    expect(type("Premium", "12500")).toBe("$12,500");
    expect(type("Coverage Amount", "1000000")).toBe("$1,000,000");
  });

  it("refuses a non-digit keystroke instead of stripping it later", () => {
    // The value simply does not change when a letter is pressed.
    expect(maskMoney("$12,500a")).toBe("$12,500");
    expect(maskField("Premium", "$12,500a", "$12,500")).toBe("$12,500");
  });

  it("walks back through its own separators", () => {
    expect(backspace("Premium", "$12,500")).toBe("$1,250");
    expect(backspace("Premium", "$1")).toBe("");
  });

  it("drops a leading zero", () => {
    expect(maskMoney("007")).toBe("$7");
  });

  it("takes cents, which is the whole point of a premium", () => {
    expect(type("Premium", "25.6")).toBe("$25.6");
    expect(type("Premium", "25.60")).toBe("$25.60");
    expect(type("Coverage Amount", "1250.75")).toBe("$1,250.75");
  });

  it("holds a point with nothing after it yet, so the key can be pressed", () => {
    expect(type("Premium", "25.")).toBe("$25.");
  });

  it("keeps the zero that a point follows, and drops the one it does not", () => {
    expect(maskMoney("0.75")).toBe("$0.75");
    expect(maskMoney("00.75")).toBe("$0.75");
    expect(maskMoney(".75")).toBe("$0.75");
  });

  it("stops at the hundredths and folds in a second point", () => {
    expect(maskMoney("25.6789")).toBe("$25.67");
    expect(maskMoney("1.2.3")).toBe("$1.23");
  });

  it("walks back over the point like any other character", () => {
    expect(backspace("Premium", "$25.6")).toBe("$25.");
    expect(backspace("Premium", "$25.")).toBe("$25");
  });

  it("drops a dangling point on blur", () => {
    expect(closeMoney("$25.")).toBe("$25");
    expect(closeField("Premium", "$25.")).toBe("$25");
    expect(closeField("Premium", "$25.60")).toBe("$25.60");
  });
});

describe("zip", () => {
  it("pads a short zip back to five on blur", () => {
    // The leading zero a spreadsheet or a keypad drops.
    expect(closeField("Customer Zip Code", "2134")).toBe("02134");
  });

  it("trims a zip+4 to five", () => {
    expect(closeField("Customer Zip Code", "021341234")).toBe("02134");
  });

  it("takes digits only while typing", () => {
    expect(type("Customer Zip Code", "02134")).toBe("02134");
    expect(maskField("Customer Zip Code", "021-34", "02134")).toBe("02134");
  });
});

describe("state", () => {
  it("uppercases and stops at two letters", () => {
    expect(type("State", "ca")).toBe("CA");
    expect(type("Residential State", "california")).toBe("CA");
    expect(maskStateCode("c4a!")).toBe("CA");
  });

  it("applies to every state-labelled field", () => {
    expect(maskField("Birth State", "ny", "")).toBe("NY");
  });
});

describe("unmasked fields", () => {
  it("passes anything without a mask straight through", () => {
    expect(maskField("Full Name", "Jane Doe", "Jane Do")).toBe("Jane Doe");
    expect(closeField("Full Name", "Jane Doe")).toBe("Jane Doe");
  });
});
