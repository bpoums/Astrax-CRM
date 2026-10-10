import { describe, expect, it } from "vitest";
import { CANONICAL_FIELDS } from "@/lib/canonical-fields";
import type { Lead } from "@/lib/normalize";
import { missingForLead, unmappedRequired, type RequiredField } from "./missing-upload";

const REQUIRED: RequiredField[] = [
  { label: "Full Name", grp: "core" },
  { label: "Draft Date", grp: "core" },
  { label: "Account Title", grp: "bank" },
  { label: "Bank Type", grp: "bank" },
  { label: "Routing Number", grp: "bank" },
];

function lead(values: Record<string, string>, payment: Partial<Lead["payment"]> = {}): Lead {
  const fields: Lead["fields"] = {};
  for (const [key, value] of Object.entries(values)) {
    const label = CANONICAL_FIELDS.find((f) => f.key === key)?.label ?? key;
    fields[key] = { key, label, value, raw: value, status: "clean" };
  }
  return {
    index: 0,
    fields,
    flags: [],
    raw: {},
    duplicateOf: [],
    payment: {
      payment_type: "unknown",
      bank_name: null,
      routing_number: null,
      account_number: null,
      account_title: null,
      card_number: null,
      card_last4: null,
      card_exp: null,
      cvv: null,
      ...payment,
    },
  };
}

describe("missingForLead", () => {
  it("reports every required field an empty row lacks, by group", () => {
    expect(missingForLead(lead({}), REQUIRED, CANONICAL_FIELDS)).toEqual({
      core: ["Full Name", "Draft Date"],
      bank: ["Account Title", "Bank Type", "Routing Number"],
    });
  });

  it("is empty when everything is present", () => {
    const row = lead(
      { full_name: "Ann Lee", draft_date: "01/05/2026", bank_type: "Checking" },
      { account_title: "Ann Lee", routing_number: "021000021" },
    );
    expect(missingForLead(row, REQUIRED, CANONICAL_FIELDS)).toEqual({ core: [], bank: [] });
  });

  it("reads payment fields from the payment object, not the grid cell", () => {
    // The cell says there is a routing number, but what will be sent has none.
    const row = lead({
      full_name: "Ann",
      draft_date: "x",
      bank_type: "Checking",
      routing_number: "1",
    });
    expect(missingForLead(row, REQUIRED, CANONICAL_FIELDS).bank).toContain("Routing Number");
  });

  it("treats whitespace as empty", () => {
    const row = lead({ full_name: "   ", draft_date: "01/05/2026" });
    expect(missingForLead(row, REQUIRED, CANONICAL_FIELDS).core).toEqual(["Full Name"]);
  });

  it("counts a required label the catalog does not know as missing", () => {
    const row = lead({});
    const result = missingForLead(row, [{ label: "No Such Field", grp: "core" }], CANONICAL_FIELDS);
    expect(result.core).toEqual(["No Such Field"]);
  });
});

describe("unmappedRequired", () => {
  it("names the required fields that have no column in the mapping", () => {
    const mapped = CANONICAL_FIELDS.filter((f) => f.label === "Full Name");
    expect(unmappedRequired(REQUIRED, mapped, CANONICAL_FIELDS)).toEqual([
      "Draft Date",
      "Account Title",
      "Bank Type",
      "Routing Number",
    ]);
  });
});
