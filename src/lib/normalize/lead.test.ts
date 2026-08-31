import { describe, expect, it } from "vitest";
import { buildLead, reparseCell, setLeadField, type Column } from "./lead";
import { droppedRows, duplicateGroups, markDuplicates } from "./duplicates";
import { fingerprintHeaders, suggestMapping } from "./mapping";
import type { CanonicalField, Lead } from "./types";

const NOW = new Date(Date.UTC(2026, 7, 21));

/**
 * A small catalog with the same shape as the real one, so these tests exercise
 * the engine rather than the closer form's current field list.
 */
const FIELDS: CanonicalField[] = [
  {
    key: "full_name",
    label: "Full Name",
    kind: "name",
    target: "payload",
    donate: true,
    aliases: ["name", "customer name"],
  },
  {
    key: "date_of_birth",
    label: "Date of Birth",
    kind: "date",
    target: "payload",
    birthDate: true,
    donate: true,
    aliases: ["dob"],
  },
  { key: "age", label: "Age", kind: "text", target: "payload" },
  { key: "state", label: "State", kind: "state", target: "payload", donate: true },
  {
    key: "ssn",
    label: "SSN Number",
    kind: "ssn",
    target: "payload",
    donate: true,
    aliases: ["ssn"],
  },
  {
    key: "phone",
    label: "Phone Number",
    kind: "phone",
    target: "payload",
    donate: true,
    aliases: ["phone"],
  },
  { key: "email", label: "Email Address", kind: "email", target: "payload", donate: true },
  {
    key: "zip",
    label: "Customer Zip Code",
    kind: "zip",
    target: "payload",
    donate: true,
    aliases: ["zip"],
  },
  { key: "premium", label: "Premium", kind: "currency", target: "payload", donate: true },
  { key: "carrier_name", label: "Carrier Name", kind: "carrier", target: "payload", donate: true },
  { key: "notes", label: "Notes & Comments", kind: "text", target: "payload" },
  {
    key: "bank_name",
    label: "Bank Name",
    kind: "bank",
    target: "payment",
    paymentKey: "bank_name",
    donate: true,
  },
  {
    key: "routing_number",
    label: "Routing Number",
    kind: "routing",
    target: "payment",
    paymentKey: "routing_number",
    donate: true,
    aliases: ["routing"],
  },
  {
    key: "account_number",
    label: "Account Number",
    kind: "account",
    target: "payment",
    paymentKey: "account_number",
    donate: true,
    aliases: ["account"],
  },
  {
    key: "account_title",
    label: "Account Title",
    kind: "name",
    target: "payment",
    paymentKey: "account_title",
  },
  {
    key: "card_number",
    label: "Card Number",
    kind: "card",
    target: "payment",
    paymentKey: "card_number",
    donate: true,
    aliases: ["card"],
  },
  {
    key: "card_exp",
    label: "Card Expiry",
    kind: "expiry",
    target: "payment",
    paymentKey: "card_exp",
    donate: true,
  },
  { key: "cvv", label: "CVV", kind: "cvv", target: "payment", paymentKey: "cvv", donate: true },
];

function columns(mapping: Record<string, string | null>): Column[] {
  return Object.entries(mapping).map(([header, fieldKey]) => ({ header, fieldKey }));
}

function lead(row: Record<string, string>, mapping: Record<string, string | null>): Lead {
  return buildLead(row, columns(mapping), FIELDS, { now: NOW });
}

describe("buildLead", () => {
  it("normalises a clean row", () => {
    const result = lead(
      {
        Name: "  jane   doe ",
        DOB: "8/27/1971",
        State: "texas",
        SSN: "568809709",
        Phone: "15551234567",
        Zip: "75001",
      },
      {
        Name: "full_name",
        DOB: "date_of_birth",
        State: "state",
        SSN: "ssn",
        Phone: "phone",
        Zip: "zip",
      },
    );

    expect(result.fields["full_name"]?.value).toBe("Jane Doe");
    expect(result.fields["date_of_birth"]?.value).toBe("08/27/1971");
    expect(result.fields["state"]?.value).toBe("TX");
    expect(result.fields["ssn"]?.value).toBe("568-80-9709");
    expect(result.fields["phone"]?.value).toBe("(555) 123-4567");
    expect(result.fields["zip"]?.value).toBe("75001");
  });

  it("keeps the raw value beside a fixed one", () => {
    const result = lead({ Zip: "2134", State: "MA" }, { Zip: "zip", State: "state" });
    expect(result.fields["zip"]).toMatchObject({ value: "02134", raw: "2134", status: "fixed" });
  });

  it("cross-checks the ZIP against the state whatever order the columns are in", () => {
    const result = lead({ Zip: "02134", State: "TX" }, { Zip: "zip", State: "state" });
    expect(result.fields["zip"]?.status).toBe("review");
  });

  it("derives an age the file did not carry", () => {
    const result = lead({ DOB: "8/27/1971" }, { DOB: "date_of_birth" });
    expect(result.fields["age"]?.value).toBe("54");
  });

  it("splits one cell into three fields", () => {
    const result = lead(
      { Payment: "Card no 4111111111111111 Exp: 05/27 Cvv: 145" },
      { Payment: "card_number" },
    );
    expect(result.fields["card_number"]?.value).toBe("4111111111111111");
    expect(result.fields["card_exp"]?.value).toBe("05/27");
    expect(result.fields["cvv"]?.value).toBe("145");
    expect(result.payment.payment_type).toBe("card");
    expect(result.payment.card_last4).toBe("1111");
  });

  it("splits a labelled banking cell into its parts", () => {
    const result = lead(
      { Banking: "Bank: US BANK Account: 113105070 Routing: 021000021" },
      { Banking: "bank_name" },
    );
    expect(result.fields["bank_name"]?.value).toBe("Us Bank");
    expect(result.fields["account_number"]?.value).toBe("113105070");
    expect(result.fields["routing_number"]?.value).toBe("021000021");
    expect(result.payment.payment_type).toBe("draft");
  });

  it("flags a card sitting in a column the header called routing", () => {
    const result = lead(
      { "Routing / Card Detail": "4111111111111111" },
      { "Routing / Card Detail": "routing_number" },
    );
    // The card is extracted for what it is, and the routing field stays empty.
    expect(result.fields["card_number"]?.value).toBe("4111111111111111");
    expect(result.fields["routing_number"]).toBeUndefined();
    expect(result.flags.some((flag) => flag.issue.includes("card number"))).toBe(true);
    expect(result.payment.payment_type).toBe("card");
  });

  it("does not give away a value its own column already consumed", () => {
    // 113105070 passes the ABA checksum by coincidence; it is still an account
    // number, because that is the column it came out of.
    const result = lead({ "Acct #": "113105070" }, { "Acct #": "account_number" });
    expect(result.fields["account_number"]?.value).toBe("113105070");
    expect(result.fields["routing_number"]).toBeUndefined();
  });

  it("carries a review status through to a flag", () => {
    const result = lead({ SSN: "666-12-3456" }, { SSN: "ssn" });
    expect(result.fields["ssn"]?.status).toBe("review");
    expect(result.flags.some((flag) => flag.field === "ssn")).toBe(true);
    expect(result.flags.find((flag) => flag.field === "ssn")?.raw).toBe("666-12-3456");
  });

  it("finds an SSN hiding in a notes column", () => {
    const result = lead(
      { Notes: "called twice, SSN: 568-80-9709", SSN: "" },
      { Notes: "notes", SSN: "ssn" },
    );
    expect(result.fields["ssn"]?.value).toBe("568-80-9709");
  });

  it("ignores an unmapped column it cannot make anything of", () => {
    const result = lead({ Junk: "lorem ipsum" }, { Junk: null });
    expect(result.fields["notes"]).toBeUndefined();
    expect(result.raw["Junk"]).toBe("lorem ipsum");
  });
});

describe("payment instrument", () => {
  it("flags a card with no expiry and no CVV", () => {
    const result = lead({ Card: "4111111111111111" }, { Card: "card_number" });
    expect(result.payment.payment_type).toBe("card");
    expect(result.flags.map((flag) => flag.field)).toEqual(
      expect.arrayContaining(["card_exp", "cvv"]),
    );
  });

  it("flags a draft with no account number", () => {
    const result = lead({ Routing: "021000021" }, { Routing: "routing_number" });
    expect(result.payment.payment_type).toBe("draft");
    expect(result.flags.some((flag) => flag.field === "account_number")).toBe(true);
  });

  it("flags a lead with neither instrument", () => {
    const result = lead({ Name: "jane doe" }, { Name: "full_name" });
    expect(result.payment.payment_type).toBe("unknown");
    expect(result.flags.some((flag) => flag.field === "payment_type")).toBe(true);
  });

  it("prefers the card when a lead somehow carries both", () => {
    const result = lead(
      { Card: "4111111111111111", Routing: "021000021", Account: "113105070" },
      { Card: "card_number", Routing: "routing_number", Account: "account_number" },
    );
    expect(result.payment.payment_type).toBe("card");
    expect(result.flags.some((flag) => flag.field === "payment_type")).toBe(true);
  });

  it("never puts payment values anywhere but the payment object", () => {
    const result = lead(
      { Card: "Card no 4111111111111111 Exp: 05/27 Cvv: 145" },
      { Card: "card_number" },
    );
    const payloadKeys = Object.values(result.fields)
      .filter((field) => FIELDS.find((entry) => entry.key === field.key)?.target === "payload")
      .map((field) => field.value)
      .join(" ");
    expect(payloadKeys).not.toContain("4111111111111111");
    expect(payloadKeys).not.toContain("145");
  });
});

describe("reparseCell", () => {
  it("re-reads a cell with no header hint at all", () => {
    const parsed = reparseCell("4111111111111111 05/27 145", FIELDS);
    expect(parsed["card_number"]?.value).toBe("4111111111111111");
    expect(parsed["card_exp"]?.value).toBe("05/27");
    expect(parsed["cvv"]?.value).toBe("145");
  });
});

describe("setLeadField", () => {
  it("re-normalises an edited value and rebuilds the flags", () => {
    const before = lead({ SSN: "666-12-3456" }, { SSN: "ssn" });
    expect(before.flags.some((flag) => flag.field === "ssn")).toBe(true);

    const after = setLeadField(before, "ssn", "568809709", FIELDS, { now: NOW });
    expect(after.fields["ssn"]?.value).toBe("568-80-9709");
    expect(after.flags.some((flag) => flag.field === "ssn")).toBe(false);
  });

  it("keeps what the operator typed when no rule can read it", () => {
    // The card rule finds no digits at all here and yields an empty value.
    // Blanking the cell under someone mid-edit is worse than showing them their
    // own text flagged.
    const before = lead({ Card: "4111111111111111" }, { Card: "card_number" });
    const after = setLeadField(before, "card_number", "pending", FIELDS, { now: NOW });
    expect(after.fields["card_number"]?.value).toBe("pending");
    expect(after.fields["card_number"]?.status).toBe("review");
    expect(after.flags.some((flag) => flag.field === "card_number")).toBe(true);
  });

  it("keeps a partial value the rule could still read digits out of", () => {
    const before = lead({ Card: "4111111111111111" }, { Card: "card_number" });
    const after = setLeadField(before, "card_number", "4111-oops", FIELDS, { now: NOW });
    expect(after.fields["card_number"]?.value).toBe("4111");
    expect(after.fields["card_number"]?.status).toBe("review");
  });

  it("still lets a cell be cleared outright", () => {
    const before = lead({ Card: "4111111111111111" }, { Card: "card_number" });
    const after = setLeadField(before, "card_number", "", FIELDS, { now: NOW });
    expect(after.fields["card_number"]?.value).toBe("");
  });

  it("does not disturb a value a rule could read", () => {
    const before = lead({ Card: "4111111111111111" }, { Card: "card_number" });
    const after = setLeadField(before, "card_number", "4111 1111 1111 1111", FIELDS, { now: NOW });
    expect(after.fields["card_number"]?.value).toBe("4111111111111111");
    expect(after.fields["card_number"]?.status).toBe("fixed");
  });
});

describe("markDuplicates", () => {
  const rows = [
    { Name: "jane doe", SSN: "568809709", Phone: "5551234567", DOB: "8/27/1971" },
    { Name: "j doe", SSN: "568-80-9709", Phone: "5559998888", DOB: "8/27/1971" },
    { Name: "john roe", SSN: "123456789", Phone: "5551234567", DOB: "5/24/1941" },
    { Name: "jane doe", SSN: "", Phone: "", DOB: "8/27/1971" },
    { Name: "solo person", SSN: "234567891", Phone: "5554443333", DOB: "1/1/1980" },
  ];
  const mapping = { Name: "full_name", SSN: "ssn", Phone: "phone", DOB: "date_of_birth" };
  const leads = markDuplicates(
    rows.map((row, index) => buildLead(row, columns(mapping), FIELDS, { index, now: NOW })),
  );

  it("matches on the normalised SSN", () => {
    expect(leads[0]?.duplicateOf).toContain(1);
    expect(leads[1]?.duplicateOf).toContain(0);
  });

  it("matches on the phone number", () => {
    expect(leads[0]?.duplicateOf).toContain(2);
  });

  it("matches on name plus date of birth", () => {
    expect(leads[3]?.duplicateOf).toContain(0);
  });

  it("leaves a unique lead alone", () => {
    expect(leads[4]?.duplicateOf).toEqual([]);
  });
});

describe("duplicateGroups", () => {
  const mapping = {
    Name: "full_name",
    SSN: "ssn",
    Phone: "phone",
    DOB: "date_of_birth",
    Email: "email",
    Zip: "zip",
  };
  const build = (rows: Record<string, string>[]) =>
    duplicateGroups(
      rows.map((row, index) => buildLead(row, columns(mapping), FIELDS, { index, now: NOW })),
    );

  it("keeps the most complete row and drops the rest of the group", () => {
    // 0 and 1 are the same person by SSN; 2 reaches 0 through the phone alone,
    // so all three are one group even though 1 and 2 share nothing.
    const groups = build([
      {
        Name: "jane doe",
        SSN: "568809709",
        Phone: "5551234567",
        DOB: "8/27/1971",
        Email: "",
        Zip: "",
      },
      {
        Name: "jane doe",
        SSN: "568-80-9709",
        Phone: "",
        DOB: "8/27/1971",
        Email: "jane@example.com",
        Zip: "60601",
      },
      { Name: "j doe", SSN: "", Phone: "5551234567", DOB: "", Email: "", Zip: "" },
      {
        Name: "solo person",
        SSN: "234567891",
        Phone: "5554443333",
        DOB: "1/1/1980",
        Email: "",
        Zip: "",
      },
    ]);
    expect(groups).toEqual([{ keep: 1, drop: [0, 2] }]);
    expect([...droppedRows(groups)].sort()).toEqual([0, 2]);
  });

  it("gives an exact tie to the earlier row", () => {
    const row = {
      Name: "amy poe",
      SSN: "568809709",
      Phone: "5551112222",
      DOB: "3/4/1980",
      Email: "",
      Zip: "",
    };
    expect(build([{ ...row }, { ...row }])).toEqual([{ keep: 0, drop: [1] }]);
  });

  it("does not count a filled-but-flagged field toward completeness", () => {
    // Row 1 has one more value in it, but its phone is unusable and flagged —
    // which leaves the two tied, and the tie goes to the earlier row.
    const groups = build([
      { Name: "kay ray", SSN: "568809709", Phone: "5551234567", DOB: "", Email: "", Zip: "" },
      {
        Name: "kay ray",
        SSN: "568809709",
        Phone: "12",
        DOB: "",
        Email: "kay@example.com",
        Zip: "",
      },
    ]);
    expect(groups).toEqual([{ keep: 0, drop: [1] }]);
  });

  it("leaves a file with no duplicates alone", () => {
    const groups = build([
      {
        Name: "jane doe",
        SSN: "568809709",
        Phone: "5551234567",
        DOB: "8/27/1971",
        Email: "",
        Zip: "",
      },
      {
        Name: "john roe",
        SSN: "234567891",
        Phone: "5554443333",
        DOB: "1/1/1980",
        Email: "",
        Zip: "",
      },
    ]);
    expect(groups).toEqual([]);
  });
});

describe("mapping", () => {
  it("pre-selects fields by fuzzy header match", () => {
    const mapping = suggestMapping(
      ["Customer Name", "DOB", "SSN", "Zip", "Routing", "Nonsense Column"],
      FIELDS,
    );
    expect(mapping["Customer Name"]).toBe("full_name");
    expect(mapping["DOB"]).toBe("date_of_birth");
    expect(mapping["SSN"]).toBe("ssn");
    expect(mapping["Zip"]).toBe("zip");
    expect(mapping["Routing"]).toBe("routing_number");
    expect(mapping["Nonsense Column"]).toBeNull();
  });

  it("never gives one field to two headers", () => {
    const mapping = suggestMapping(["SSN", "SSN Number"], FIELDS);
    const claimed = Object.values(mapping).filter(Boolean);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("fingerprints a header set independently of order", () => {
    expect(fingerprintHeaders(["A", "B", "C"])).toBe(fingerprintHeaders(["C", "A", "B"]));
    expect(fingerprintHeaders(["A", "B"])).not.toBe(fingerprintHeaders(["A", "B", "C"]));
  });
});
