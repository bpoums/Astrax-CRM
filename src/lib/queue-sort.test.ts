import { describe, expect, it } from "vitest";
import { statusRank, textKey, timeKey } from "./queue-sort";

describe("statusRank", () => {
  it("orders the rows that need the manager first", () => {
    const order = ["in_review", "assigned", "pending_manager", "returned_timeout"];
    expect([...order].sort((a, b) => statusRank(a) - statusRank(b))).toEqual([
      "returned_timeout",
      "pending_manager",
      "assigned",
      "in_review",
    ]);
  });

  it("puts an unknown status after every known one", () => {
    expect(statusRank("something_new")).toBeGreaterThan(statusRank("in_review"));
  });
});

describe("textKey", () => {
  it("ignores case and surrounding space", () => {
    expect(textKey("  Jane Doe ")).toBe("jane doe");
  });

  it("treats blanks and the em-dash placeholder as nothing to sort by", () => {
    expect(textKey("—")).toBeUndefined();
    expect(textKey("   ")).toBeUndefined();
    expect(textKey(null)).toBeUndefined();
    expect(textKey(undefined)).toBeUndefined();
  });
});

describe("timeKey", () => {
  it("returns epoch milliseconds", () => {
    expect(timeKey("2026-10-08T00:00:00.000Z")).toBe(Date.UTC(2026, 9, 8));
  });

  it("returns undefined for a missing or invalid date", () => {
    expect(timeKey(null)).toBeUndefined();
    expect(timeKey("")).toBeUndefined();
    expect(timeKey("not a date")).toBeUndefined();
  });
});
