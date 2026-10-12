import { describe, expect, it } from "vitest";
import { CANONICAL_FIELDS, PAYLOAD_FIELDS } from "@/lib/canonical-fields";
import { buildLead, setLeadField, type Column } from "@/lib/normalize/lead";

const NOW = new Date(Date.UTC(2026, 7, 21));

const columns: Column[] = [
  { header: "Name", fieldKey: "full_name" },
  { header: "Payment", fieldKey: "card_number" },
];

function leadFor(payment: string) {
  return buildLead({ Name: "Jane Doe", Payment: payment }, columns, CANONICAL_FIELDS, {
    index: 0,
    now: NOW,
  });
}

describe("canonical field catalog", () => {
  it("has exactly one field per key", () => {
    // buildLead resolves a key through a Map and setLeadField through
    // Array.find; a duplicate makes them disagree about the same field.
    const keys = CANONICAL_FIELDS.map((field) => field.key);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });

  it("defines the card number once, as a payment field", () => {
    const cards = CANONICAL_FIELDS.filter((field) => field.key === "card_number");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "card", target: "payment" });
  });

  it("keeps card data out of the payload fields", () => {
    expect(PAYLOAD_FIELDS.map((field) => field.key)).not.toContain("card_number");

    // Mirrors toIngestPayload: whatever lands in the payload is synced to Sheets.
    const lead = leadFor("Card no 4111111111111111 Exp: 05/27 Cvv: 145");
    const payload: Record<string, string> = {};
    for (const field of PAYLOAD_FIELDS) {
      const value = lead.fields[field.key]?.value;
      if (value) payload[field.label] = value;
    }
    expect(JSON.stringify(payload)).not.toContain("4111111111111111");
  });
});

describe("card number: build versus edit", () => {
  it("flags a short card number the same way whether built or edited", () => {
    const built = leadFor("1234");
    expect(built.fields["card_number"]?.status).toBe("review");

    const edited = setLeadField(
      leadFor("Card no 4111111111111111 Exp: 05/27 Cvv: 145"),
      "card_number",
      "1234",
      CANONICAL_FIELDS,
      { now: NOW },
    );
    expect(edited.fields["card_number"]?.status).toBe("review");
    expect(edited.fields["card_number"]?.note).toBe(built.fields["card_number"]?.note);
  });

  it("accepts a valid card number typed during review", () => {
    const edited = setLeadField(
      leadFor("1234"),
      "card_number",
      "4111111111111111",
      CANONICAL_FIELDS,
      {
        now: NOW,
      },
    );
    expect(edited.fields["card_number"]?.status).toBe("clean");
    expect(edited.payment.card_last4).toBe("1111");
  });
});
