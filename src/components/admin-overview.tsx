import { useMemo } from "react";
import { PeriodPicker } from "@/components/period-picker";
import { OverviewPanels } from "@/components/overview-panels";
import { TotalsPanel } from "@/components/reporting";
import { SalesBreakdown } from "@/components/sales-breakdown";
import { usePeriod } from "@/lib/period-range";
import { useOverviewStats } from "@/lib/overview-stats";
import { useParkedClientsByCenter, useTransferClients } from "@/lib/transfer-clients";
import type { BreakdownItem } from "@/components/overview-panels";

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

  /**
   * What each center's Live number is made of: In House, then the external
   * clients linked to that center. The clients' numbers are the leads still
   * parked with them that were submitted in the selected window, so they are a
   * subset of the center's live total and In House = live - clients cannot go
   * negative. A client shows even at 0 so a newly linked one is visible. A
   * refused read is shown rather than silently dropping the breakdown.
   */
  const clients = useTransferClients(true);
  const parked = useParkedClientsByCenter(period.range);
  const liveBreakdown = useMemo(() => {
    const out: Record<string, BreakdownItem[]> = {};
    const clientList = clients.data ?? [];
    const order = new Map(clientList.map((client, index) => [client.id, index]));
    const counts = parked.data ?? [];
    for (const center of perCenter) {
      if (!center.center_id) continue;
      const rows = counts.filter((row) => row.center_id === center.center_id);
      const names = new Map<string, string>();
      for (const client of clientList) {
        if (client.center_id === center.center_id) names.set(client.id, client.name);
      }
      for (const row of rows) if (!names.has(row.client_id)) names.set(row.client_id, row.client_name);
      if (names.size === 0) continue;

      const items = [...names.entries()]
        .map(([id, label]) => ({
          id,
          label,
          value: rows.find((row) => row.client_id === id)?.lead_count ?? 0,
        }))
        .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
      const away = items.reduce((sum, item) => sum + item.value, 0);
      out[center.center_id] = [
        { label: "In House", value: Math.max(0, (center.total_submissions ?? 0) - away) },
        ...items.map(({ label, value }) => ({ label, value })),
      ];
    }
    return out;
  }, [perCenter, clients.data, parked.data]);
  const totalsRow = totals.data ?? null;

  return (
    <>
      {/* One window for the whole tab, so it stays in reach while the page
          scrolls past the Overview panels into the sales section. */}
      <div className="sticky top-0 z-20 -mx-1 bg-background/95 px-1 py-1.5 backdrop-blur">
        <PeriodPicker
          period={period}
          note={
            <span className="inline-flex items-center gap-1.5">
              {/* Not a filter — a statement that these figures keep themselves up
                  to date off the realtime subscription in `useOverviewStats`. */}
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
              Live · the window applies to every panel except Operations
            </span>
          }
        />
      </div>

      <OverviewPanels
        period={period}
        stats={stats}
        centers={perCenter}
        liveBreakdown={liveBreakdown}
      />
      {parked.isError ? (
        <p className="text-xs text-destructive">{(parked.error as Error).message}</p>
      ) : null}

      {/* Approved sales over the same window. */}
      <div className="flex items-center gap-3 pt-2">
        <h2 className="font-display text-sm font-semibold">Sales</h2>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      <SalesBreakdown sharedPeriod={period} />

      {/* The record. Deliberately quieter than the row above — true, worth
          having, and not what anybody opens this tab to find out. */}
      {/* <TotalsPanel row={totalsRow} heading={heading} /> */}
    </>
  );
}
