import { describe, expect, it } from "vitest";
import { SECTIONS as CLOSER_SECTIONS } from "@/components/closer-form";
import { SECTIONS as VALIDATOR_SECTIONS } from "@/components/validator-form";
import { calcAge, formatSSN } from "@/lib/form-fields";
import { draftDateWarning, fieldWarning } from "@/lib/form-warnings";
import { closerTestData, validatorTestData } from "@/lib/test-data";

const NOW = new Date(2026, 9, 12, 14, 30); // a Monday
const options = { carrier: "Test Carrier", now: NOW };

/** A deterministic random source, so two seeds give two different leads. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const closer = closerTestData({ ...options, random: seeded(1) });
const { agency, values: validator } = validatorTestData({ ...options, random: seeded(1) });

const labels = (sections: typeof CLOSER_SECTIONS) =>
  sections.flatMap((section) => section.fields.map((field) => field));

describe("closer test data", () => {
  it("fills every required field of the closer form", () => {
    const missing = labels(CLOSER_SECTIONS)
      .filter((field) => field.required && !closer[field.label]?.trim())
      .map((field) => field.label);
    expect(missing).toEqual([]);
  });

  it("uses only labels the closer form has", () => {
    const known = new Set(labels(CLOSER_SECTIONS).map((field) => field.label));
    expect(Object.keys(closer).filter((key) => !known.has(key))).toEqual([]);
  });

  it("uses a valid option for every radio field", () => {
    for (const field of labels(CLOSER_SECTIONS)) {
      if (field.type === "radio") expect(field.options).toContain(closer[field.label]);
    }
  });
});

describe("validator test data", () => {
  it("fills every required field and the carrier", () => {
    const missing = labels(VALIDATOR_SECTIONS)
      .filter((field) => field.required && !validator[field.label]?.trim())
      .map((field) => field.label);
    expect(missing).toEqual([]);
    expect(agency).toBe("Test Carrier");
  });

  it("uses only labels the validator form has", () => {
    const known = new Set(labels(VALIDATOR_SECTIONS).map((field) => field.label));
    expect(Object.keys(validator).filter((key) => !known.has(key))).toEqual([]);
  });

  it("uses a valid option for every radio field", () => {
    for (const field of labels(VALIDATOR_SECTIONS)) {
      if (field.type === "radio") expect(field.options).toContain(validator[field.label]);
    }
  });
});

describe.each([
  ["closer", closer],
  ["validator", validator],
])("%s sample values", (_name, values) => {
  it("names the lead Test and leaves the optional card fields blank", () => {
    expect(values["Full Name"]).toMatch(/^Test /);
    expect(values["Card Number"]).toBe("");
    expect(values["Exp Date"]).toBe("");
    expect(values["CVC"]).toBe("");
  });

  it("has a well-formed SSN that the mask would leave alone", () => {
    const ssn = values["SSN Number"] ?? "";
    expect(ssn).toMatch(/^\d{3}-\d{2}-\d{4}$/);
    expect(formatSSN(ssn)).toBe(ssn);
  });

  it("has an age that matches the date of birth", () => {
    expect(values["Age"]).toBe(String(calcAge(values["Date of Birth"] ?? "")));
  });

  it("schedules both drafts on weekdays", () => {
    expect(draftDateWarning(values["Draft Date"] ?? "")).toBeNull();
    expect(draftDateWarning(values["Future Draft Date"] ?? "")).toBeNull();
  });

  it("triggers no inline warning on the checked fields", () => {
    for (const label of ["Routing Number", "SSN Number", "Customer Zip Code", "Birth State"]) {
      const warning = fieldWarning(label, values[label] ?? "", values, NOW);
      expect(warning?.tone === "warn" || warning?.tone === "danger").toBeFalsy();
    }
    expect(fieldWarning("State", values["State"] ?? "", values, NOW)).toBeNull();
  });
});

describe("test data variety", () => {
  it("gives a different SSN to different random sources", () => {
    const a = closerTestData({ ...options, random: seeded(2) })["SSN Number"];
    const b = closerTestData({ ...options, random: seeded(3) })["SSN Number"];
    expect(a).not.toBe(b);
  });

  it("leaves the carrier empty, for the form to report, when none is set up", () => {
    expect(closerTestData({ carrier: null, now: NOW })["Proposed Carrier"]).toBe("");
    expect(validatorTestData({ carrier: null, now: NOW }).agency).toBe("");
  });
});
