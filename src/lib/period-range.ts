import { useState } from "react";

/**
 * The window every reporting figure can be read over, and the one place it is
 * turned into RPC arguments.
 *
 * Lifted out of `reporting.tsx` when the admin Overview became its own screen:
 * two dashboards now offer the same chips, and a period that means one thing on
 * one of them and something else on the other is worse than having no filter at
 * all. The derivation below is the single copy.
 */

/**
 * `days` is what the RPCs take, and null means all time — the same value the
 * functions treat as "no filter", so All time returns exactly what the old
 * unscoped views did. The boundary itself is a Pacific calendar day computed in
 * `reporting_since`, not in the browser: "today" must mean the same day for a
 * reader in Lahore as for the business in Los Angeles.
 */
export const PERIODS = [
  { id: "today", label: "Today", days: 1, heading: "Today" },
  { id: "7d", label: "7 days", days: 7, heading: "Last 7 days" },
  { id: "30d", label: "30 days", days: 30, heading: "Last 30 days" },
  { id: "all", label: "All time", days: null, heading: "All time" },
] as const;

export type PeriodId = (typeof PERIODS)[number]["id"] | "custom";

/**
 * All time by default, deliberately.
 *
 * Every figure on these pages has been a lifetime total until now. Opening one
 * to a 30-day window would make each figure appear to drop, which reads as data
 * loss rather than as a filter. The reader opts in.
 */
export const DEFAULT_PERIOD: PeriodId = "all";

/** The argument object the `_range` RPCs are called with. */
export type ReportingRange = ReturnType<typeof usePeriod>["range"];

export function usePeriod(initial: PeriodId = DEFAULT_PERIOD) {
  const [periodId, setPeriodId] = useState<PeriodId>(initial);
  // A specific day, or a from/to range — kept apart from the PERIODS chips
  // because it needs two text inputs rather than one click. Left in place
  // (not cleared) when a fixed period is picked instead — inert rather than
  // gone, via the `isCustom &&` guards below, so re-opening "Custom" later
  // remembers the last range rather than asking for it again.
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const isCustom = periodId === "custom";
  const period = PERIODS.find((entry) => entry.id === periodId) ?? PERIODS[3];
  const days = isCustom ? null : period.days;
  // Until a from-date is actually chosen, "Custom" behaves like "All time"
  // rather than sending a half-filled range.
  const startKey = isCustom && customFrom ? customFrom : null;
  const endKey = isCustom && customFrom ? customTo || customFrom : null;
  /**
   * All time omits the argument rather than passing null.
   *
   * `p_days` has a SQL default, so the generated type is `p_days?: number` —
   * and under exactOptionalPropertyTypes an explicit null is rejected. Omitting
   * the key lets the default apply, which is the same "no filter" the functions
   * read a null as. Same reasoning for `p_start_date`/`p_end_date`.
   */
  const range = startKey
    ? { p_start_date: startKey, p_end_date: endKey ?? startKey }
    : days === null
      ? {}
      : { p_days: days };
  // What every heading reads, instead of the fixed PERIODS label.
  const heading = startKey
    ? endKey && endKey !== startKey
      ? `${startKey} – ${endKey}`
      : startKey
    : isCustom
      ? "Custom range — pick a date"
      : period.heading;

  return {
    periodId,
    setPeriodId,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    isCustom,
    days,
    startKey,
    endKey,
    range,
    heading,
  };
}
