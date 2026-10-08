import { describe, expect, it } from "vitest";
import { CANONICAL_FIELDS } from "./canonical-fields";
import { joinList, parseSuggestions, splitList } from "./health-suggest";

describe("parseSuggestions", () => {
  it("reads the display rows of a Clinical Tables response", () => {
    const raw = [2, ["1", "2"], null, [["Diabetes mellitus (DM)"], ["Retinopathy - diabetic"]]];
    expect(parseSuggestions(raw, "condition")).toEqual([
      "Diabetes mellitus (DM)",
      "Retinopathy - diabetic",
    ]);
  });

  it("drops the route suffix from medications and de-duplicates", () => {
    const raw = [
      3,
      [],
      null,
      [["metFORMIN (Oral Pill)"], ["metformin (Oral Liquid)"], ["lisinopril (Oral Pill)"]],
    ];
    expect(parseSuggestions(raw, "medication")).toEqual(["metFORMIN", "lisinopril"]);
  });

  it("returns nothing for a malformed response", () => {
    expect(parseSuggestions(null, "condition")).toEqual([]);
    expect(parseSuggestions({}, "condition")).toEqual([]);
    expect(parseSuggestions([0, [], null], "condition")).toEqual([]);
  });
});

describe("list helpers", () => {
  it("round-trips a comma-separated value", () => {
    expect(splitList("Asthma, COPD ,, ")).toEqual(["Asthma", "COPD"]);
    expect(joinList(["Asthma", "COPD"])).toBe("Asthma, COPD");
    expect(splitList("")).toEqual([]);
  });
});

describe("import catalog", () => {
  it("has exactly one Medications entry", () => {
    expect(CANONICAL_FIELDS.filter((f) => f.key === "medications")).toHaveLength(1);
  });
});
