import type { ReactNode } from "react";
import { PERIODS, type usePeriod } from "@/lib/period-range";

/**
 * The window chips, and the two date inputs "Custom" reveals.
 *
 * Presentation only — every value it shows and sets belongs to `usePeriod()`,
 * so the caller owns the state and the queries keyed off it. Shared by the
 * manager's Reporting tab and the admin Overview.
 */
export function PeriodPicker({
  period,
  note,
}: {
  period: ReturnType<typeof usePeriod>;
  /** Said out loud beside the chips, because a filter that silently leaves one
   *  panel out is worse than no filter. Omitted where nothing is left out. */
  note?: ReactNode;
}) {
  const { periodId, setPeriodId, customFrom, setCustomFrom, customTo, setCustomTo, isCustom } =
    period;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {PERIODS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setPeriodId(entry.id)}
            aria-pressed={entry.id === periodId}
            className={`chip px-2.5 py-0.5 text-[0.66rem] ${
              entry.id === periodId ? "chip-active" : ""
            }`}
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPeriodId("custom")}
          aria-pressed={isCustom}
          className={`chip px-2.5 py-0.5 text-[0.66rem] ${isCustom ? "chip-active" : ""}`}
        >
          Custom
        </button>
        {isCustom ? (
          <>
            <input
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              aria-label="From date"
              className="field-input h-6 w-32 py-0 text-[0.66rem]"
            />
            {/* Left blank, this filters exactly the one day above. */}
            <input
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              aria-label="To date (optional — leave blank for a single day)"
              className="field-input h-6 w-32 py-0 text-[0.66rem]"
            />
            {customFrom || customTo ? (
              <button
                type="button"
                className="chip px-2.5 py-0.5 text-[0.66rem]"
                onClick={() => {
                  setCustomFrom("");
                  setCustomTo("");
                }}
              >
                Clear dates
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {note ? <span className="text-[0.66rem] text-muted-foreground">{note}</span> : null}
    </div>
  );
}
