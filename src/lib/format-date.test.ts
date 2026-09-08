import { afterEach, describe, expect, it } from "vitest";
import { formatCalendarDate, formatDate } from "./format-date";

/**
 * Timezones far enough either side of UTC to expose any shift.
 *
 * Kiritimati is UTC+14 and Midway UTC-11 — a 25-hour spread, so a value that
 * survives both cannot be reading a clock. Karachi is where the console is
 * actually used and Los_Angeles is what the timestamp formatters render in.
 */
const ZONES = [
  "Pacific/Kiritimati",
  "Asia/Karachi",
  "UTC",
  "America/Los_Angeles",
  "Pacific/Midway",
];

const ORIGINAL_TZ = process.env["TZ"];

/**
 * Point the runner at a zone, and confirm it actually moved.
 *
 * Node re-reads `TZ` for each newly constructed Date, but if that ever stops
 * being true the loops below would keep passing while testing nothing. The
 * assertion here is what stops this whole file going quietly vacuous.
 */
function switchToZone(zone: string) {
  process.env["TZ"] = zone;
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone, "TZ did not take effect").toBe(zone);
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env["TZ"];
  else process.env["TZ"] = ORIGINAL_TZ;
});

describe("formatCalendarDate", () => {
  // The reported bug: draft_date 2026-09-17 rendered as 16 Sept.
  it("renders the 17th as the 17th in every timezone", () => {
    for (const zone of ZONES) {
      switchToZone(zone);
      expect(formatCalendarDate("2026-09-17"), `TZ=${zone}`).toBe("17 Sept 2026");
    }
  });

  it("holds at the year boundary, where a shift would move the year too", () => {
    for (const zone of ZONES) {
      switchToZone(zone);
      expect(formatCalendarDate("2026-01-01"), `TZ=${zone}`).toBe("1 Jan 2026");
      expect(formatCalendarDate("2026-12-31"), `TZ=${zone}`).toBe("31 Dec 2026");
    }
  });

  it("drops the leading zero, matching the timestamp formatter's day", () => {
    expect(formatCalendarDate("2026-09-04")).toBe("4 Sept 2026");
  });

  it("has nothing to say about a missing date", () => {
    expect(formatCalendarDate(null)).toBe("—");
    expect(formatCalendarDate(undefined)).toBe("—");
    expect(formatCalendarDate("   ")).toBe("—");
  });

  it("passes anything that is not YYYY-MM-DD through untouched", () => {
    // Better an odd string on screen than an invented date.
    expect(formatCalendarDate("09/17/2026")).toBe("09/17/2026");
    expect(formatCalendarDate("not a date")).toBe("not a date");
  });
});

/**
 * The trap this bug came from, pinned.
 *
 * `formatDate` renders the Pacific day an INSTANT falls on. Handed a SQL date,
 * JavaScript reads the string as midnight UTC, and Pacific is always behind
 * UTC — so it prints the day before, for every viewer, not just ones ahead of
 * UTC. Swapping the two functions back at any call site fails here.
 */
describe("the two are not interchangeable", () => {
  it("shifts a bare calendar date by a day, which is why it must not get one", () => {
    expect(formatDate("2026-09-17")).toBe("16 Sept 2026");
    expect(formatCalendarDate("2026-09-17")).toBe("17 Sept 2026");
  });

  it("still renders a real timestamp in Pacific, whatever the runner is set to", () => {
    for (const zone of ZONES) {
      switchToZone(zone);
      // 23:08 UTC on the 4th is 16:08 Pacific, still the 4th.
      expect(formatDate("2026-09-04T23:08:01.049Z"), `TZ=${zone}`).toBe("4 Sept 2026");
    }
  });
});
