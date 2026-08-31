import { describe, expect, it } from "vitest";
import { detectCell, splitLabelledSegments } from "./detect";
import type { DetectorKind } from "./types";

function kinds(text: string, hint?: DetectorKind | null) {
  return detectCell(text, hint).map((candidate) => candidate.kind);
}

function valueFor(text: string, kind: DetectorKind, hint?: DetectorKind | null) {
  return detectCell(text, hint)
    .find((candidate) => candidate.kind === kind)
    ?.raw.trim();
}

describe("splitLabelledSegments", () => {
  it("strips an inline label", () => {
    const segments = splitLabelledSegments("SSN: 568-80-9709");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.label).toBe("ssn");
    expect(segments[0]?.text.trim()).toBe("568-80-9709");
  });

  it("does not let an unlabelled repeat of the word swallow the value", () => {
    const segments = splitLabelledSegments("Bank: US BANK");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text.trim()).toBe("US BANK");
  });

  it("splits a multi-label cell", () => {
    const segments = splitLabelledSegments("Card no 4366-1031-4047-6613 Exp: 05/17 Cvv: 145");
    expect(segments.map((segment) => segment.label)).toEqual(["card", "expiry", "cvv"]);
  });

  it("keeps unlabelled text ahead of the first label", () => {
    const segments = splitLabelledSegments("John Doe SSN: 568-80-9709");
    expect(segments[0]?.label).toBeNull();
    expect(segments[0]?.text.trim()).toBe("John Doe");
  });
});

describe("detectCell", () => {
  it("reads an SSN out of a labelled cell", () => {
    expect(valueFor("SSN: 568-80-9709", "ssn")).toBe("568-80-9709");
  });

  it("reads bank, account and routing out of their own cells", () => {
    expect(valueFor("Bank: US BANK", "bank")).toBe("US BANK");
    expect(valueFor("Account: 113105070", "account")).toBe("113105070");
    expect(valueFor("Routing: 021000021", "routing")).toBe("021000021");
  });

  it("pulls three fields out of one card cell", () => {
    const found = kinds("Card no 4366-1031-4047-6613 Exp: 05/17 Cvv: 145");
    expect(found).toContain("card");
    expect(found).toContain("expiry");
    expect(found).toContain("cvv");
    expect(valueFor("Card no 4366-1031-4047-6613 Exp: 05/17 Cvv: 145", "cvv")).toBe("145");
  });

  it("splits a card written with spaces", () => {
    expect(valueFor("4111 1111 1111 1111", "card")).toBe("4111 1111 1111 1111");
  });

  it("finds a card in a column the header called routing", () => {
    // The point of the whole design: a header claiming "Routing / Card Detail"
    // must not turn a card number into a routing number.
    const found = detectCell("4111111111111111", "routing");
    expect(found.map((candidate) => candidate.kind)).toContain("card");
    expect(found.map((candidate) => candidate.kind)).not.toContain("routing");
  });

  it("does not read a valid SSN as a routing number", () => {
    expect(kinds("568-80-9709")).toContain("ssn");
    expect(kinds("568-80-9709")).not.toContain("routing");
  });

  it("only offers a CVV when a card is in the same cell", () => {
    expect(kinds("145")).not.toContain("cvv");
    expect(kinds("4111111111111111 145")).toContain("cvv");
  });

  it("does not invent a state out of trailing noise", () => {
    // "Routing: 0070158296 Chq NM 1072" carries a stray NM that is not a state field.
    expect(kinds("Routing: 0070158296 Chq NM 1072")).not.toContain("state");
  });

  it("still yields the claimed kind when the value fails its checksum", () => {
    const found = detectCell("Routing: 0070158296 Chq NM 1072");
    const routing = found.find((candidate) => candidate.kind === "routing");
    expect(routing?.raw).toBe("0070158296");
  });

  it("finds an email, a phone number and an amount", () => {
    expect(valueFor("jane@example.com", "email")).toBe("jane@example.com");
    expect(valueFor("(555) 123-4567", "phone")).toBe("(555) 123-4567");
    expect(valueFor("61.69$", "currency")).toBe("61.69$");
  });

  it("recognises a whole-cell state but not a state inside a sentence", () => {
    expect(kinds("Texas")).toContain("state");
    expect(kinds("moved to Texas last year")).not.toContain("state");
  });

  it("never returns two candidates covering the same characters", () => {
    const found = detectCell("Card no 4111111111111111 Exp: 05/27 Cvv: 145");
    for (const a of found) {
      for (const b of found) {
        if (a === b) continue;
        expect(a.start < b.end && b.start < a.end).toBe(false);
      }
    }
  });
});
