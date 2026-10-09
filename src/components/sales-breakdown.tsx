import { useState } from "react";
import type { usePeriod } from "@/lib/period-range";
import { useQuery } from "@tanstack/react-query";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
import { PLAN_TYPE_COLUMNS, type PlanTypeBucket } from "@/lib/plan-type";
import { MetricBar } from "@/components/metric-bar";
import { CenterBadge } from "@/components/ops";
import { useCenters, type CenterColor } from "@/lib/centers";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Approved-sales reporting: how many Level/Graded/Mod/GI sales closed, broken
 * down by carrier, by customer state, and a closer leaderboard — all scoped
 * to `disposition = 'accepted'` (the "Submitted" outcome), the same scope
 * `Exports` already uses for "sold" leads.
 *
 * All aggregation (carrier/state alias folding, plan-type bucketing, the
 * closer leaderboard) happens server-side in the `sales_breakdown_range` /
 * `sales_closer_leaderboard_range` RPCs — this component never fetches raw
 * lead payloads. See `supabase/migrations/20260927120000_sales_breakdown_range.sql`
 * for the SQL reimplementation of the same carrier-alias/state-fallback logic
 * `src/lib/normalize/carriers.ts` and `src/lib/normalize/states.ts` use
 * elsewhere in the app.
 */

type PeriodId = "today" | "week" | "month" | "all" | "custom";

const PERIOD_CHIPS: { id: PeriodId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This Week" },
  { id: "month", label: "This Month" },
  { id: "all", label: "All time" },
];

/** "YYYY-MM-DD" from the browser's local calendar, for `reporting_window`'s
 * plain-date args — never `toISOString()`, which reads off UTC and can name
 * the wrong calendar day for anyone not near UTC. */
function ymd(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Monday of the current calendar week (ISO week start), local calendar. */
function mostRecentMonday(date: Date) {
  const day = date.getDay(); // 0 = Sunday .. 6 = Saturday
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setDate(date.getDate() + diff);
  return monday;
}

/** The 1st of the current calendar month, local calendar. */
function firstOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** "of the Week" / "of the Month" / "Overall" — feeds the leaderboard headings. */
function periodPhrase(period: PeriodId) {
  if (period === "today") return "of the Day";
  if (period === "week") return "of the Week";
  if (period === "month") return "of the Month";
  return "Overall";
}

type BucketCounts = Record<PlanTypeBucket, number>;

function emptyCounts(): BucketCounts {
  return { Level: 0, Graded: 0, Mod: 0, GI: 0, Unspecified: 0 };
}

/** One row of `sales_breakdown_range` — already aggregated server-side. */
type SalesBreakdownRow = {
  dimension: "total" | "carrier" | "state";
  label: string;
  level_count: number;
  graded_count: number;
  mod_count: number;
  gi_count: number;
  unspecified_count: number;
  total_count: number;
};

/** One row of `sales_closer_leaderboard_range` — already aggregated server-side. */
type LeaderboardRpcRow = {
  closer_id: string;
  closer_name: string;
  accepted: number;
  total: number;
};

type PivotRow = { key: string; counts: BucketCounts; total: number };

function toPivotRow(row: SalesBreakdownRow): PivotRow {
  return {
    key: row.label,
    counts: {
      Level: row.level_count,
      Graded: row.graded_count,
      Mod: row.mod_count,
      GI: row.gi_count,
      Unspecified: row.unspecified_count,
    },
    total: row.total_count,
  };
}

const SALES_BREAKDOWN_KEY = ["admin", "sales-breakdown"];

/**
 * With no `sharedPeriod` this owns its own chips (the `/reporting` Sales tab).
 * The admin Overview passes its `usePeriod()` so one filter governs both the
 * Overview panels and this section; the chips are then not rendered here.
 */
export function SalesBreakdown({ sharedPeriod }: { sharedPeriod?: ReturnType<typeof usePeriod> }) {
  const [period, setPeriod] = useState<PeriodId>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [carrierFilter, setCarrierFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");

  const isCustom = period === "custom";

  // "This Week"/"This Month" are real calendar boundaries (Monday-to-today,
  // 1st-of-month-to-today), NOT a rolling 7/30-day window — `ReportingStats`'
  // Today/7d/30d chips use rolling windows, but "This Month" reading as
  // "last 30 days" is indistinguishable from "All time" for the first month
  // of this app's life (every accepted lead so far is under 30 days old) and
  // reads wrong once real history exists too — a caller in the first week of
  // October expects "This Month" to mean October, not "since September 5th."
  // The anchor dates (today, the most recent Monday, the 1st of the current
  // month) are computed from the browser's local calendar and passed straight
  // through to the RPCs' `p_start_date`/`p_end_date` args — the same plain
  // args `Custom` already uses and the same ones `submission_totals_range`
  // takes elsewhere, so only the day BOUNDARY math (midnight, DST) is left to
  // the server. A viewer many hours from Pacific time could see a label off
  // by one calendar day right at midnight — the same tolerance `Custom`'s
  // plain date inputs already accept.
  let rpcArgs: { p_start_date?: string; p_end_date?: string } = {};
  if (period === "today" || period === "week" || period === "month") {
    const today = new Date();
    const startDate =
      period === "today"
        ? today
        : period === "week"
          ? mostRecentMonday(today)
          : firstOfMonth(today);
    rpcArgs = { p_start_date: ymd(startDate), p_end_date: ymd(today) };
  } else if (isCustom && customFrom) {
    rpcArgs = { p_start_date: customFrom, p_end_date: customTo || customFrom };
  }
  const rpcReady =
    period === "all" ||
    period === "today" ||
    period === "week" ||
    period === "month" ||
    !!customFrom;
  // The shared window wins outright; the local state above is then unused.
  const queryArgs: { p_days?: number; p_start_date?: string; p_end_date?: string } = sharedPeriod
    ? sharedPeriod.range
    : rpcArgs;
  const queryEnabled = sharedPeriod ? true : rpcReady;
  const phrase = sharedPeriod ? `(${sharedPeriod.heading})` : periodPhrase(period);

  const breakdownQuery = useQuery({
    queryKey: [...SALES_BREAKDOWN_KEY, "breakdown", queryArgs],
    enabled: queryEnabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("sales_breakdown_range", queryArgs);
      if (error) throw error;
      return (data ?? []) as SalesBreakdownRow[];
    },
  });

  const leaderboardQuery = useQuery({
    queryKey: [...SALES_BREAKDOWN_KEY, "leaderboard", queryArgs],
    enabled: queryEnabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("sales_closer_leaderboard_range", queryArgs);
      if (error) throw error;
      return (data ?? []) as LeaderboardRpcRow[];
    },
  });

  const totalsRow = breakdownQuery.data?.find((row) => row.dimension === "total");
  const breakdown = {
    total: totalsRow?.total_count ?? 0,
    totals: totalsRow
      ? {
          Level: totalsRow.level_count,
          Graded: totalsRow.graded_count,
          Mod: totalsRow.mod_count,
          GI: totalsRow.gi_count,
          Unspecified: totalsRow.unspecified_count,
        }
      : emptyCounts(),
    byCarrier: (breakdownQuery.data ?? [])
      .filter((row) => row.dimension === "carrier")
      .map(toPivotRow)
      .sort((a, b) => b.total - a.total),
    byState: (breakdownQuery.data ?? [])
      .filter((row) => row.dimension === "state")
      .map(toPivotRow)
      .sort((a, b) => b.total - a.total),
  };

  // The RPC carries no center, so look up each closer's current profile
  // center (readable by admin and reporting_manager) and color it from the
  // centers list. Inactive centers included — see `useCenterColorById`.
  const closerIds = (leaderboardQuery.data ?? []).map((row) => row.closer_id).sort();
  const closerCentersQuery = useQuery({
    queryKey: [...SALES_BREAKDOWN_KEY, "closer-centers", closerIds],
    enabled: closerIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, center_id")
        .in("id", closerIds);
      if (error) throw error;
      return new Map((data ?? []).map((row) => [row.id, row.center_id] as const));
    },
  });
  const centers = useCenters(false);
  const centerById = new Map((centers.data ?? []).map((center) => [center.id, center] as const));

  const leaderboard = (leaderboardQuery.data ?? [])
    .map((row) => {
      const center = centerById.get(closerCentersQuery.data?.get(row.closer_id) ?? "");
      return {
        id: row.closer_id,
        name: row.closer_name,
        total: row.total,
        accepted: row.accepted,
        centerName: center?.name ?? null,
        centerColor: center?.color ?? null,
      };
    })
    .sort((a, b) => b.accepted - a.accepted);

  const best = leaderboard[0] ?? null;
  const worst = leaderboard.length > 1 ? (leaderboard[leaderboard.length - 1] ?? null) : null;

  const carrierRows = breakdown.byCarrier.filter((row) =>
    row.key.toLowerCase().includes(carrierFilter.trim().toLowerCase()),
  );
  const stateRows = breakdown.byState.filter((row) =>
    row.key.toLowerCase().includes(stateFilter.trim().toLowerCase()),
  );
  const carrierMax = breakdown.byCarrier.reduce((most, row) => Math.max(most, row.total), 0);
  const stateMax = breakdown.byState.reduce((most, row) => Math.max(most, row.total), 0);

  const loading = breakdownQuery.isLoading || leaderboardQuery.isLoading;

  return (
    <div className="flex flex-col gap-4">
      <section className="panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="panel-title">
            Sales Breakdown{sharedPeriod ? ` — ${sharedPeriod.heading}` : ""}
          </h2>
          {sharedPeriod ? null : (
            <div className="flex flex-wrap items-center gap-1.5">
              {PERIOD_CHIPS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setPeriod(entry.id)}
                  aria-pressed={entry.id === period}
                  className={`chip px-2.5 py-0.5 text-[0.66rem] ${entry.id === period ? "chip-active" : ""}`}
                >
                  {entry.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPeriod("custom")}
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
                    onChange={(e) => setCustomFrom(e.target.value)}
                    aria-label="From date"
                    className="field-input h-6 w-32 py-0 text-[0.66rem]"
                  />
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    aria-label="To date (optional — leave blank for a single day)"
                    className="field-input h-6 w-32 py-0 text-[0.66rem]"
                  />
                </>
              ) : null}
            </div>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Total Submitted" value={breakdown.total} emphasis />
          {PLAN_TYPE_COLUMNS.map((bucket) => (
            <StatCard
              key={bucket}
              label={bucket}
              value={breakdown.totals[bucket]}
              share={breakdown.total > 0 ? breakdown.totals[bucket] / breakdown.total : null}
              muted={bucket === "Unspecified"}
            />
          ))}
        </dl>
      </section>

      <div className={sharedPeriod ? "grid items-start gap-4 xl:grid-cols-2" : "contents"}>
        <section className="panel min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="panel-title">By Carrier ({carrierRows.length})</h2>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={carrierFilter}
                onChange={(e) => setCarrierFilter(e.target.value)}
                placeholder="Filter carrier…"
                className="field-input h-7 w-40 text-xs"
                autoComplete="off"
              />
              <button
                type="button"
                className="chip"
                onClick={() =>
                  downloadCsv(carrierRows, "Carrier", `carrier-sales-${fileStamp()}.csv`)
                }
              >
                Export CSV
              </button>
            </div>
          </div>
          <PivotTable
            rows={carrierRows}
            rowLabel="Carrier"
            max={carrierMax}
            loading={loading}
            emptyMessage="No approved sales in this period."
          />
        </section>

        <section className="panel min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="panel-title">By State ({stateRows.length})</h2>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
                placeholder="Filter state…"
                className="field-input h-7 w-40 text-xs"
                autoComplete="off"
              />
              <button
                type="button"
                className="chip"
                onClick={() => downloadCsv(stateRows, "State", `state-sales-${fileStamp()}.csv`)}
              >
                Export CSV
              </button>
            </div>
          </div>
          <PivotTable
            rows={stateRows}
            rowLabel="State"
            max={stateMax}
            loading={loading}
            emptyMessage="No approved sales in this period."
          />
        </section>
      </div>

      <section className="panel">
        <h2 className="panel-title">Closer Leaderboard</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <LeaderboardCard title={`Top Performer ${phrase}`} entry={best} tone="positive" />
          <LeaderboardCard title={`Needs Support ${phrase}`} entry={worst} tone="destructive" />
        </div>

        <div className="mt-3 [&>div]:no-scrollbar [&>div]:max-h-[50vh] [&>div]:overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10">
              <TableRow>
                <TableHead className="w-12">Rank</TableHead>
                <TableHead>Center</TableHead>
                <TableHead>Closer</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Sales Closed</TableHead>
                <TableHead>Conversion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leaderboard.map((entry, index) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <CenterBadge name={entry.centerName} color={entry.centerColor} />
                  </TableCell>
                  <TableCell className="font-medium">{entry.name}</TableCell>
                  <TableCell className=" tabular-nums">{entry.accepted}</TableCell>
                  <TableCell className=" tabular-nums">{entry.total}</TableCell>
                  <TableCell className=" tabular-nums text-muted-foreground">
                    {entry.total > 0 ? `${Math.round((entry.accepted / entry.total) * 100)}%` : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {leaderboard.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {loading ? "Loading…" : "No closer submissions in this period."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  share = null,
  emphasis = false,
  muted = false,
}: {
  label: string;
  value: number;
  /** Fraction of the total (0–1); renders a share bar and percentage when set. */
  share?: number | null;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-card px-3 py-2">
      <dt className="field-label">{label}</dt>
      <dd className="flex items-baseline gap-1.5">
        <span
          className={`font-display text-xl font-semibold tabular-nums ${
            emphasis ? "text-accent" : muted ? "text-muted-foreground" : ""
          }`}
        >
          {value}
        </span>
        {share !== null ? (
          <span className="text-[0.66rem] tabular-nums text-muted-foreground">
            {Math.round(share * 100)}%
          </span>
        ) : null}
      </dd>
      {share !== null ? (
        <div className="h-0.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div
            className={`h-full rounded-full ${muted ? "bg-muted-foreground/50" : "bg-accent"}`}
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function LeaderboardCard({
  title,
  entry,
  tone,
}: {
  title: string;
  entry: {
    name: string;
    total: number;
    accepted: number;
    centerName: string | null;
    centerColor: CenterColor | null;
  } | null;
  tone: "positive" | "destructive";
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border p-3 ${
        tone === "positive" ? "border-accent/40" : "border-destructive/40"
      }`}
    >
      <span className="field-label">{title}</span>
      {entry ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-lg font-semibold">{entry.name}</span>
            <CenterBadge name={entry.centerName} color={entry.centerColor} />
          </div>
          <span className="text-xs text-muted-foreground">
            {entry.accepted} submitted / {entry.total} sales closed (
            {entry.total > 0 ? Math.round((entry.accepted / entry.total) * 100) : 0}%)
          </span>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">Not enough data in this period.</span>
      )}
    </div>
  );
}

function PivotTable({
  rows,
  rowLabel,
  max,
  loading,
  emptyMessage,
}: {
  rows: PivotRow[];
  rowLabel: string;
  max: number;
  loading: boolean;
  emptyMessage: string;
}) {
  return (
    <div className="[&>div]:no-scrollbar [&>div]:max-h-[50vh] [&>div]:overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10">
          <TableRow>
            <TableHead>{rowLabel}</TableHead>
            {PLAN_TYPE_COLUMNS.map((bucket) => (
              <TableHead key={bucket} className="text-right">
                {bucket}
              </TableHead>
            ))}
            <TableHead className="w-40 text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="font-medium">{row.key}</TableCell>
              {PLAN_TYPE_COLUMNS.map((bucket) => (
                <TableCell key={bucket} className="text-right tabular-nums">
                  {row.counts[bucket]}
                </TableCell>
              ))}
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <span className="tabular-nums">{row.total}</span>
                  <div className="w-16">
                    <MetricBar value={row.total} max={max} />
                  </div>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={PLAN_TYPE_COLUMNS.length + 2}
                className="text-center text-muted-foreground"
              >
                {loading ? "Loading…" : emptyMessage}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}

function fileStamp() {
  return new Date().toISOString().slice(0, 10);
}

function downloadCsv(rows: PivotRow[], rowLabel: string, fileName: string) {
  const records = rows.map((row) => ({
    [rowLabel]: row.key,
    ...Object.fromEntries(PLAN_TYPE_COLUMNS.map((bucket) => [bucket, row.counts[bucket]])),
    Total: row.total,
  }));
  const csv = Papa.unparse(records);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
