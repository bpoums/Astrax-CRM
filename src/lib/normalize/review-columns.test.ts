import { describe, expect, it } from "vitest";
import { CANONICAL_FIELDS } from "@/lib/canonical-fields";
import { buildLead, reviewColumns, setLeadField, type Column } from "./lead";

const NOW = new Date(Date.UTC(2026, 7, 21));

const keys = (fields: ReturnType<typeof reviewColumns>) => fields.map((field) => field.key);

/** A one-row file whose single payment cell carries card, expiry and CVV. */
function singleCardLead() {
  const columns: Column[] = [
    { header: "Name", fieldKey: "full_name" },
    { header: "Payment", fieldKey: "card_number" },
  ];
  const lead = buildLead(
    { Name: "Jane Doe", Payment: "Card no 4111111111111111 Exp: 05/27 Cvv: 145" },
    columns,
    CANONICAL_FIELDS,
    { index: 0, now: NOW },
  );
  return { columns, lead };
}

describe("reviewColumns", () => {
  it("covers what detection found, including donated fields", () => {
    const { columns, lead } = singleCardLead();
    const visible = keys(reviewColumns([lead], columns, CANONICAL_FIELDS));
    // Expiry and CVV came out of the card cell, not a column of their own.
    expect(visible).toEqual(
      expect.arrayContaining(["full_name", "card_number", "card_exp", "cvv"]),
    );
  });

  it("keeps a mapped column that produced nothing at all", () => {
    const columns: Column[] = [
      { header: "Name", fieldKey: "full_name" },
      { header: "Email", fieldKey: "email" },
    ];
    const lead = buildLead({ Name: "Jane Doe", Email: "" }, columns, CANONICAL_FIELDS, {
      index: 0,
      now: NOW,
    });
    // The operator said that column is the email; give them somewhere to type one.
    expect(keys(reviewColumns([lead], columns, CANONICAL_FIELDS))).toContain("email");
  });

  it("leaves out a field nothing mapped to and nothing detected", () => {
    const { columns, lead } = singleCardLead();
    expect(keys(reviewColumns([lead], columns, CANONICAL_FIELDS))).not.toContain("routing_number");
  });

  /**
   * The bug this function exists for: the column set used to be recomputed from
   * the leads on every edit, so emptying the only card number in a one-row file
   * removed the column and left nowhere to type the corrected value.
   */
  it("does not lose the card columns when the only card number is cleared", () => {
    const { columns, lead } = singleCardLead();
    const fixed = reviewColumns([lead], columns, CANONICAL_FIELDS);
    expect(keys(fixed)).toContain("card_number");
    expect(keys(fixed)).toContain("card_exp");

    const cleared = setLeadField(lead, "card_number", "", CANONICAL_FIELDS, { now: NOW });
    expect(cleared.fields["card_number"]?.value).toBe("");

    // The column set is fixed, so it is unchanged by the edit...
    expect(keys(fixed)).toContain("card_number");
    expect(keys(fixed)).toContain("card_exp");

    // ...and recomputing it against the edited lead would still keep both,
    // because the mapping alone is enough to hold the column open.
    const recomputed = keys(reviewColumns([cleared], columns, CANONICAL_FIELDS));
    expect(recomputed).toContain("card_number");
    expect(recomputed).toContain("card_exp");

    // Both cells are still there to edit: an empty card number and its expiry.
    expect(cleared.fields["card_exp"]?.value).toBe("05/27");
    // Empty but expected, so it is flagged rather than silently blank.
    expect(cleared.fields["card_number"]?.status).toBe("review");
  });

  it("holds the column open even for a field only ever detected, once cleared", () => {
    // card_exp was donated, never mapped — clearing it must not close its column.
    const { columns, lead } = singleCardLead();
    const cleared = setLeadField(lead, "card_exp", "", CANONICAL_FIELDS, { now: NOW });
    const fixed = keys(reviewColumns([lead], columns, CANONICAL_FIELDS));
    expect(fixed).toContain("card_exp");
    expect(cleared.fields["card_exp"]?.value).toBe("");
  });
});
