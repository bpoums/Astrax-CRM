/**
 * Every timestamp the app displays, rendered in US Pacific.
 *
 * Timestamps are stored in UTC and the business runs on US Pacific time, but
 * the console is read from Pakistan. Left to the browser's own timezone, a lead
 * taken at 4pm Pacific on the 4th renders as the 5th — a full calendar day out
 * — so a day's work appears split across two dates and a night's work appears
 * to belong to tomorrow. Every reader, wherever they sit, must see the same
 * wall clock the business operates on.
 *
 * Two decisions worth keeping:
 *
 * - **A named zone, never a fixed offset.** `America/Los_Angeles` is -7 in
 *   summer and -8 in winter; hardcoding either would be silently wrong for half
 *   the year, and wrong by an hour in exactly the window where a late-evening
 *   lead crosses midnight. Intl applies the right one per timestamp, including
 *   for dates in the past.
 * - **A pinned locale.** `undefined` would hand the format to the viewer's
 *   browser, so the same lead would read "5 Sept 2026" for one operator and
 *   "Sep 5, 2026" for another. This is an internal console where people read
 *   each other's screenshots; `en-GB` reproduces the format already in use.
 *
 * `Intl.DateTimeFormat` is expensive to construct, and these run once per cell
 * in tables of twenty-five rows — so the formatters are built once here rather
 * than per call.
 *
 * This is a DISPLAY layer and nothing else. Nothing here parses input, decides
 * a business date, or touches what is stored: durations (`relativeTime`,
 * `formatClock` in `ops.tsx`) are differences between two instants and are the
 * same number in every zone, and the closer form's weather clock is the
 * CUSTOMER's local time at their ZIP, which is the one time in the app that is
 * deliberately not Pacific.
 */

export const APP_TIME_ZONE = "America/Los_Angeles";

/** See the note above: pinned so the rendered string does not vary by viewer. */
const LOCALE = "en-GB";

const DATE_ONLY = new Intl.DateTimeFormat(LOCALE, {
  timeZone: APP_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const DATE_TIME = new Intl.DateTimeFormat(LOCALE, {
  timeZone: APP_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const EVENT_TIME = new Intl.DateTimeFormat(LOCALE, {
  timeZone: APP_TIME_ZONE,
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const EVENT_TIME_SECONDS = new Intl.DateTimeFormat(LOCALE, {
  timeZone: APP_TIME_ZONE,
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/**
 * "PDT" or "PST", for the timestamp given.
 *
 * Appended by hand rather than asked of the formatters above, because the two
 * halves want different locales. `en-GB` is what produces "4 Sept 2026", but it
 * renders the zone as "GMT-7" — technically right and useless to read. `en-US`
 * gives the "PDT" everyone recognises but reorders the date to "Sep 4, 2026".
 * Taking the abbreviation from its own en-US formatter buys both.
 *
 * It is derived per timestamp, not stored, so a lead from January still says
 * PST while one from July says PDT.
 *
 * A bare clock time is what makes this necessary at all: "3:45 pm" tells a
 * reader in Pakistan nothing about whose afternoon it is, which is the exact
 * confusion this module exists to end.
 */
const ZONE_ABBREVIATION = new Intl.DateTimeFormat("en-US", {
  timeZone: APP_TIME_ZONE,
  hour: "numeric",
  timeZoneName: "short",
});

function zone(date: Date) {
  const part = ZONE_ABBREVIATION.formatToParts(date).find((p) => p.type === "timeZoneName");
  return part ? ` ${part.value}` : "";
}

/**
 * The short month names, taken from the SAME locale the formatters above use,
 * so a calendar date and a timestamp can never print September two ways.
 *
 * Anchored to UTC on both sides — the dates are built from explicit UTC
 * components and formatted in UTC — so the lookup cannot shift no matter where
 * it is built. Only the twelve names come out of it; no caller's value ever
 * passes through a Date here.
 */
const MONTH_NAMES = (() => {
  const format = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", month: "short" });
  return Array.from({ length: 12 }, (_, month) =>
    format.format(new Date(Date.UTC(2026, month, 1))),
  );
})();

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "17 Sept 2026" from the string "2026-09-17", with no timezone anywhere near it.
 *
 * A SQL `date` is a calendar date: no time, no zone, nothing to convert. The
 * moment one is handed to `new Date("2026-09-17")` JavaScript reads it as
 * MIDNIGHT UTC, and rendering that instant in any zone behind UTC — which
 * America/Los_Angeles always is — prints the day before. That is not a
 * Pakistan-only problem, or an edge case: routed through `formatDate` this
 * column was wrong for every viewer, every time.
 *
 * So the string is taken apart and put back together, and no Date is
 * constructed from it at any point. There is nothing here for a timezone to
 * act on, which is what makes the result the same on every machine.
 *
 * Anything that is not exactly YYYY-MM-DD is returned as it came, the same way
 * `payloadDisplayValue` leaves an unrecognised value alone — better an odd
 * string on screen than a mangled or invented date.
 */
export function formatCalendarDate(value: string | null | undefined) {
  const text = (value ?? "").trim();
  if (!text) return "—";

  const parts = CALENDAR_DATE.exec(text);
  const year = parts?.[1];
  const month = parts?.[2];
  const day = parts?.[3];
  if (!year || !month || !day) return text;

  const name = MONTH_NAMES[Number(month) - 1];
  if (!name) return text;

  // Number() drops the leading zero, matching `day: "numeric"` above.
  return `${Number(day)} ${name} ${year}`;
}

/**
 * A timestamp that is missing, or that is not one at all.
 *
 * Both end as the same dash. A null column and a malformed string are equally
 * un-renderable, and `Intl.format` throws a RangeError on an Invalid Date —
 * which would take down the whole table over one bad row.
 */
function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * "4 Sept 2026" — the Pacific calendar day an INSTANT falls on.
 *
 * For `timestamptz` columns only. A SQL `date` — `draft_date`,
 * `future_draft_date` — has no instant in it and must go through
 * `formatCalendarDate` instead; passing one here shifts it a day. See the note
 * on that function.
 */
export function formatDate(iso: string | null | undefined) {
  const date = parse(iso);
  return date ? DATE_ONLY.format(date) : "—";
}

/** "4 Sept 2026, 4:08 pm PDT" — the full stamp, where the year matters. */
export function formatDateTime(iso: string | null | undefined) {
  const date = parse(iso);
  return date ? DATE_TIME.format(date) + zone(date) : "—";
}

/**
 * "4 Sept, 4:08 pm PDT" — the compact stamp the audit trails use.
 *
 * No year, matching the format those timelines already had: they read as a
 * sequence of events on one lead, where the year is the same on every line and
 * only adds width. `seconds` is for the reporting timeline, which shows the
 * order of events that can land inside the same minute.
 */
export function formatEventTime(iso: string | null | undefined, options?: { seconds?: boolean }) {
  const date = parse(iso);
  if (!date) return "—";
  const stamp = options?.seconds ? EVENT_TIME_SECONDS.format(date) : EVENT_TIME.format(date);
  return stamp + zone(date);
}
