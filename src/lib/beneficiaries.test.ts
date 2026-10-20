import { describe, expect, it } from "vitest";
import {
  cleanPart,
  compactBeneficiaries,
  parseBeneficiaries,
  serializeBeneficiaries,
  stripStructure,
  validateBeneficiaries,
  withSubmittedBeneficiaries,
  type Beneficiary,
} from "./beneficiaries";

const mary: Beneficiary = { name: "Mary Smith", relationship: "Spouse", info: "DOB 01/07/1957" };
const john: Beneficiary = { name: "John Smith", relationship: "Son", info: "" };

describe("serialize and parse", () => {
  it("joins with ' | ' and keeps position across all three columns", () => {
    expect(serializeBeneficiaries([mary, john])).toEqual({
      "Beneficiary Name": "Mary Smith | John Smith",
      "Beneficiary Relationship": "Spouse | Son",
      "Beneficiary Info": "DOB 01/07/1957 | ",
    });
  });

  it("leaves a single beneficiary looking exactly like the old flat value", () => {
    expect(serializeBeneficiaries([mary])).toEqual({
      "Beneficiary Name": "Mary Smith",
      "Beneficiary Relationship": "Spouse",
      "Beneficiary Info": "DOB 01/07/1957",
    });
  });

  it("round-trips, including an empty Info slot in the middle", () => {
    const list = [mary, john, { name: "Ann Lee", relationship: "Friend", info: "50%" }];
    expect(parseBeneficiaries(serializeBeneficiaries(list))).toEqual(list);
  });

  it("round-trips a half-typed value, so a trailing space survives a keystroke", () => {
    const typing = [{ name: "Mary ", relationship: "", info: " x" }, john];
    expect(parseBeneficiaries(serializeBeneficiaries(typing))).toEqual(typing);
  });

  it("gives one blank row for an empty form", () => {
    expect(parseBeneficiaries({})).toEqual([{ name: "", relationship: "", info: "" }]);
    expect(parseBeneficiaries(serializeBeneficiaries([]))).toHaveLength(1);
  });

  it("reads a value saved before the group existed as one beneficiary", () => {
    expect(
      parseBeneficiaries({
        "Beneficiary Name": "Thomas Sadler, Ethan Hunt",
        "Beneficiary Relationship": "Sons",
      }),
    ).toEqual([{ name: "Thomas Sadler, Ethan Hunt", relationship: "Sons", info: "" }]);
  });

  it("splits a hand-typed 'A|B' and pads the shorter columns", () => {
    expect(
      parseBeneficiaries({ "Beneficiary Name": "A|B", "Beneficiary Relationship": "Son" }),
    ).toEqual([
      { name: "A", relationship: "Son", info: "" },
      { name: "B", relationship: "", info: "" },
    ]);
  });
});

describe("keeping the structure intact", () => {
  it("turns a typed pipe into a slash and a line break into a space", () => {
    expect(stripStructure("a|b\nc")).toBe("a/b c");
  });

  it("does not touch spaces while typing", () => {
    expect(stripStructure("Mary ")).toBe("Mary ");
  });

  it("collapses and trims for the submitted value", () => {
    expect(cleanPart("  Mary   Smith \t")).toBe("Mary Smith");
  });

  it("never lets a pipe inside a value split into a second beneficiary", () => {
    const out = serializeBeneficiaries([{ name: "A | B", relationship: "Son", info: "x|y" }]);
    expect(parseBeneficiaries(out)).toHaveLength(1);
  });
});

describe("compact and submit", () => {
  it("drops blank rows and cleans the rest", () => {
    const rows = compactBeneficiaries([
      { name: " Mary  Smith ", relationship: "Spouse", info: "" },
      { name: "", relationship: "", info: "  " },
    ]);
    expect(rows).toEqual([{ name: "Mary Smith", relationship: "Spouse", info: "" }]);
  });

  it("replaces only the three beneficiary keys", () => {
    const out = withSubmittedBeneficiaries({
      "Full Name": "X",
      "Beneficiary Name": "Mary ",
      "Beneficiary Relationship": "Spouse",
      "Beneficiary Info": "",
    });
    expect(out["Full Name"]).toBe("X");
    expect(out["Beneficiary Name"]).toBe("Mary");
  });

  it("writes the Info key even when the form never had one", () => {
    const out = withSubmittedBeneficiaries({
      "Beneficiary Name": "Mary",
      "Beneficiary Relationship": "Spouse",
    });
    expect(out["Beneficiary Info"]).toBe("");
  });

  it("drops a trailing blank row typed by 'Add beneficiary'", () => {
    const out = withSubmittedBeneficiaries({
      "Beneficiary Name": "Mary |  ",
      "Beneficiary Relationship": "Spouse | ",
      "Beneficiary Info": " | ",
    });
    expect(out["Beneficiary Name"]).toBe("Mary");
    expect(out["Beneficiary Relationship"]).toBe("Spouse");
  });
});

describe("validation", () => {
  it("requires a name and a relationship on the first beneficiary", () => {
    expect(validateBeneficiaries([{ name: "", relationship: "", info: "" }])).toBe(
      "Beneficiary Name is required.",
    );
    expect(validateBeneficiaries([{ name: "Mary", relationship: "", info: "" }])).toBe(
      "Beneficiary Relationship is required.",
    );
    expect(validateBeneficiaries([mary])).toBeNull();
  });

  it("treats a blank first row as absent, so the filled second row becomes the first", () => {
    const rows = [
      { name: "", relationship: "", info: "" },
      { ...john, info: "DOB 1980" },
    ];
    expect(validateBeneficiaries(rows)).toBeNull();
    expect(compactBeneficiaries(rows)).toEqual([{ ...john, info: "DOB 1980" }]);
  });

  it("requires Info on the first beneficiary only", () => {
    expect(validateBeneficiaries([{ ...mary, info: "" }])).toBe("Beneficiary Info is required.");
    expect(validateBeneficiaries([{ ...mary, info: "   " }])).toBe("Beneficiary Info is required.");
    // john has no Info, and is the second row.
    expect(validateBeneficiaries([mary, john])).toBeNull();
  });

  it("title-cases every name on submit, without flipping a comma", () => {
    const rows = compactBeneficiaries([
      { name: "mARY  sMITH", relationship: "Spouse", info: "x" },
      { name: "JOHN, ANN", relationship: "Son", info: "" },
    ]);
    expect(rows.map((row) => row.name)).toEqual(["Mary Smith", "John, Ann"]);
  });

  it("names the person whose relationship is missing", () => {
    expect(validateBeneficiaries([mary, { name: "John Smith", relationship: "", info: "" }])).toBe(
      "Add a relationship for John Smith.",
    );
  });

  it("asks for a name when a later row has only a relationship", () => {
    expect(validateBeneficiaries([mary, { name: "", relationship: "Son", info: "" }])).toBe(
      "Add a name for beneficiary 2.",
    );
  });

  it("ignores a blank extra row", () => {
    expect(validateBeneficiaries([mary, { name: "", relationship: "", info: "" }])).toBeNull();
  });

  it("caps the list at six", () => {
    expect(validateBeneficiaries(Array.from({ length: 7 }, () => mary))).toBe(
      "Up to 6 beneficiaries.",
    );
  });
});
