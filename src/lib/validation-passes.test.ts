import { describe, expect, it } from "vitest";
import { groupIntoPasses } from "./validation-passes";

/** The shape the grouper needs, plus an id so assertions can name a row. */
function e(event_type: string, id = "") {
  return { event_type, id };
}

describe("groupIntoPasses", () => {
  it("keeps events before the first assignment outside any pass", () => {
    const segments = groupIntoPasses([e("submitted"), e("parked"), e("moved_to_validation")]);
    expect(segments).toHaveLength(3);
    expect(segments.every((segment) => segment.kind === "event")).toBe(true);
  });

  it("opens a pass on assignment and closes it on the outcome", () => {
    const segments = groupIntoPasses([
      e("submitted"),
      e("assigned"),
      e("claimed"),
      e("disposed"),
      e("payload_edited"),
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual(["event", "pass", "event"]);
    const pass = segments[1];
    if (pass?.kind !== "pass") throw new Error("expected a pass");
    expect(pass.pass.number).toBe(1);
    expect(pass.pass.items).toHaveLength(2);
  });

  it("numbers passes in sequence", () => {
    const segments = groupIntoPasses([
      e("assigned"),
      e("disposed"),
      e("assigned"),
      e("timeout"),
      e("assigned"),
      e("rejected"),
    ]);
    const numbers = segments.flatMap((segment) =>
      segment.kind === "pass" ? [segment.pass.number] : [],
    );
    expect(numbers).toEqual([1, 2, 3]);
  });

  it("a hold stays inside the same pass — it does not reassign the lead", () => {
    const segments = groupIntoPasses([e("assigned"), e("claimed"), e("held"), e("claimed")]);
    expect(segments).toHaveLength(1);
    const [only] = segments;
    if (only?.kind !== "pass") throw new Error("expected a pass");
    // Three churn events, at the threshold, so they collapse to one item.
    expect(only.pass.items).toHaveLength(1);
  });

  /**
   * The real lead this was built for: one validator claimed and held six times
   * across eight minutes before submitting.
   */
  it("collapses a long claim/hold run into a single summary", () => {
    const churn = [
      e("claimed"),
      e("held"),
      e("claimed"),
      e("held"),
      e("claimed"),
      e("held"),
      e("claimed"),
    ];
    const segments = groupIntoPasses([e("assigned"), ...churn, e("disposed")]);
    const [only] = segments;
    if (only?.kind !== "pass") throw new Error("expected a pass");

    expect(only.pass.items).toHaveLength(2);
    const [collapsed, outcome] = only.pass.items;
    if (collapsed?.kind !== "churn") throw new Error("expected churn");
    expect(collapsed.attempts).toBe(4);
    expect(collapsed.holds).toBe(3);
    expect(outcome?.kind).toBe("event");
  });

  it("leaves a short run alone rather than summarising nothing", () => {
    const segments = groupIntoPasses([e("assigned"), e("claimed"), e("disposed")]);
    const [only] = segments;
    if (only?.kind !== "pass") throw new Error("expected a pass");
    expect(only.pass.items.every((item) => item.kind === "event")).toBe(true);
  });

  it("closes an unfinished pass when the lead is reassigned", () => {
    const segments = groupIntoPasses([
      e("assigned", "first"),
      e("claimed"),
      e("assigned", "second"),
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual(["pass", "pass"]);
    const [first, second] = segments;
    if (first?.kind !== "pass" || second?.kind !== "pass") throw new Error("expected two passes");
    expect(first.pass.assigned?.id).toBe("first");
    expect(second.pass.items).toHaveLength(0);
  });

  it("returns nothing for a lead with no events", () => {
    expect(groupIntoPasses([])).toEqual([]);
  });
});
