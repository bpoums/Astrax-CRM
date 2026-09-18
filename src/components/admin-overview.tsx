import { useMemo } from "react";
import { PeriodPicker } from "@/components/period-picker";
import { OverviewPanels } from "@/components/overview-panels";
import { LeadsByCenterPanel, TotalsPanel } from "@/components/reporting";
import { usePeriod } from "@/lib/period-range";
import { useOverviewStats } from "@/lib/overview-stats";

/**
 * The admin Overview — three questions, side by side, over the record.
 *
 * The top row answers what is happening NOW: what came in, what happened to it,
 * and where the open work is standing. Everything below it answers what
 * happened over the selected window. Splitting the two is the whole point of
 * the layout: the figures an admin opens this tab for are the first three, and
 * they were previously stacked underneath each other in one column of panels.
 *
 * The row itself is `OverviewPanels`, shared with the manager's Reporting tab
 * and the Closing Desk. What is admin-only is what sits UNDER it — the
 * lifetime record and the per-centre breakdown.
 *
 * Every number comes from `useOverviewStats`, the same hook and the same query
 * keys those other screens use. Nothing here recounts anything, and no figure
 * on this screen is computed from a rule that is not already the database's.
 *
 * The period picker governs the first two panels and the record below.
 * Operations is deliberately outside it and says so on the panel — where work
 * is standing right now is current state, and scoping it to a past week would
 * answer a question nobody asked.
 */
export function AdminOverview() {
  const period = usePeriod();
  const { heading } = period;
  const stats = useOverviewStats(period);
  const { centerTotals, totals } = stats;

  const perCenter = useMemo(() => centerTotals.data ?? [], [centerTotals.data]);
  const totalsRow = totals.data ?? null;

  // The record panel below compares centres against each other only — it has no
  // Manual rows to make room for, unlike the source list in the panels above.
  const centerMax = useMemo(
    () => perCenter.reduce((most, center) => Math.max(most, center.total_submissions ?? 0), 0),
    [perCenter],
  );

  return (
    <>
      <PeriodPicker
        period={period}
        note={
          <span className="inline-flex items-center gap-1.5">
            {/* Not a filter — a statement that these figures keep themselves up
                to date off the realtime subscription in `useOverviewStats`. */}
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            Live · the window applies to the two panels and the record below
          </span>
        }
      />

      <OverviewPanels period={period} stats={stats} centers={perCenter} />

      {/* The record. Deliberately quieter than the row above — true, worth
          having, and not what anybody opens this tab to find out. */}
      <TotalsPanel row={totalsRow} heading={heading} />

      <LeadsByCenterPanel
        centers={perCenter}
        max={centerMax}
        heading={heading}
        loading={centerTotals.isLoading}
        error={centerTotals.isError ? (centerTotals.error as Error).message : null}
      />
    </>
  );
}
