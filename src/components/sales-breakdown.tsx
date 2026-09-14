import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
import { carrierName, type Disposition } from "@/components/ops";
import { carrierRefs, useCarriers } from "@/lib/carriers";
import { carrierKey, lookupCarrier, type CarrierRef } from "@/lib/normalize/carriers";
import { STATE_ABBREVIATIONS, STATE_CODES } from "@/lib/normalize/states";
import { normalizePlanType, PLAN_TYPE_COLUMNS, type PlanTypeBucket } from "@/lib/plan-type";
import { MetricBar } from "@/components/metric-bar";
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
 * Carrier and state resolution both reuse the alias-aware normalizers the
 * upload engine already owns (`src/lib/normalize/carriers.ts`,
 * `src/lib/normalize/states.ts`) rather than re-deriving fuzzy matching here
 * — the payload free text ("TransAmerica" vs "TRANSAMERICA", "Texas" vs "TX")
 * is exactly what those modules were built to fold together.
 */

type PeriodId = "week" | "month" | "all" | "custom";

const PERIOD_CHIPS: { id: PeriodId; label: string }[] = [
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
  if (period === "week") return "of the Week";
  if (period === "month") return "of the Month";
  return "Overall";
}

type AcceptedRow = {
  payload: Record<string, unknown>;
  final_carrier: { name: string | null } | null;
};

type CloserRow = {
  closer_id: string | null;
  disposition: Disposition | null;
  closer: { full_name: string | null } | null;
};

type BucketCounts = Record<PlanTypeBucket, number>;

function emptyCounts(): BucketCounts {
  return { Level: 0, Graded: 0, Mod: 0, GI: 0, Unspecified: 0 };
}

const STATE_FIELDS = ["State", "Residential State", "Birth State"];

/**
 * A registered carrier's name/aliases are usually the short, official form
 * ("Corbridge", "TransAmerica"); what closers actually type is often that
 * name plus a specific product ("Corebridge GIWL", "Transamerica Express
 * Select"). `lookupCarrier` requires an exact match and rightly never
 * guesses for the upload-import pipeline (a wrong carrier there is worse
 * than a flagged one) — but for this report, folding "starts with a known
 * carrier's name" into that carrier is a reasonable, much lower-maintenance
 * default than requiring a fresh alias for every new product name. Only
 * applied here, not in `src/lib/normalize`, so the import pipeline's
 * stricter behavior is untouched. Keys under 4 characters are skipped to
 * avoid a short abbreviation false-matching an unrelated carrier.
 */
function prefixMatchCarrier(raw: string, refs: CarrierRef[]): string | null {
  const key = carrierKey(raw);
  let best: { name: string; keyLength: number } | null = null;
  for (const ref of refs) {
    for (const candidate of [ref.name, ...ref.aliases]) {
      const candidateKey = carrierKey(candidate);
      if (candidateKey.length < 4 || !key.startsWith(candidateKey)) continue;
      if (!best || candidateKey.length > best.keyLength) {
        best = { name: ref.name, keyLength: candidateKey.length };
      }
    }
  }
  return best?.name ?? null;
}

/**
 * The carrier a row counts under, plus a stable grouping key.
 *
 * The key is case/whitespace-insensitive so "American Amicable" and
 * "AMERICAN AMICABLE" — literally the same text, typed with different
 * casing — land in one row instead of two; the label keeps the original
 * casing/spacing of whichever row is encountered first, purely cosmetic.
 */
function resolveCarrier(row: AcceptedRow, refs: CarrierRef[]): { key: string; label: string } {
  const finalName = row.final_carrier?.name?.trim();
  if (finalName) return { key: finalName.toLowerCase(), label: finalName };
  const raw = carrierName(row.payload);
  if (raw === "—") return { key: "unspecified", label: "Unspecified" };
  const matched = lookupCarrier(raw, refs) ?? prefixMatchCarrier(raw, refs);
  if (matched) return { key: matched.toLowerCase(), label: matched };
  const cleaned = raw.trim().replace(/\s+/g, " ");
  return { key: cleaned.toLowerCase(), label: cleaned };
}

function resolveState(payload: Record<string, unknown>): string {
  for (const field of STATE_FIELDS) {
    const value = payload?.[field];
    if (typeof value !== "string" || !value.trim()) continue;
    const cleaned = value.trim();
    const upper = cleaned.toUpperCase();
    if (STATE_ABBREVIATIONS.has(upper)) return upper;
    const byName = STATE_CODES[cleaned.toLowerCase()];
    if (byName) return byName;
    // A non-empty value that isn't a recognisable state (e.g. "N/A", a typo,
    // a country name) still falls through to the next field rather than
    // stopping here — "State" being junk shouldn't hide a good "Birth State".
  }
  return "Unspecified";
}

type GroupedCounts = { label: string; counts: BucketCounts };
type PivotRow = { key: string; counts: BucketCounts; total: number };

function toPivotRows(map: Map<string, GroupedCounts>): PivotRow[] {
  return Array.from(map.values())
    .map(({ label, counts }) => ({
      key: label,
      counts,
      total: PLAN_TYPE_COLUMNS.reduce((sum, bucket) => sum + counts[bucket], 0),
    }))
    .sort((a, b) => b.total - a.total);
}

/** Groups by `key` (case/whitespace-insensitive for carriers), displaying
 * `label` — the first-seen original text for that key. */
function bump(map: Map<string, GroupedCounts>, key: string, label: string, bucket: PlanTypeBucket) {
  const entry = map.get(key) ?? { label, counts: emptyCounts() };
  entry.counts[bucket] += 1;
  map.set(key, entry);
}

const SALES_BREAKDOWN_KEY = ["admin", "sales-breakdown"];
const PAGE_SIZE = 1000;

/** Fetches every page of a query, not just the first — this is an aggregate
 * report, so silently stopping at a cap would undercount rather than just
 * truncate a preview. */
async function fetchAllRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

export function SalesBreakdown() {
  const [period, setPeriod] = useState<PeriodId>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [carrierFilter, setCarrierFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");

  const isCustom = period === "custom";

  // Same server-side Pacific-calendar-day RPC `SubmissionsExplorer` already
  // uses for its own date filter (`reporting_window`) — reused rather than
  // reimplemented, so this tab's day boundaries can never disagree with the
  // rest of the app about where midnight falls.
  //
  // "This Week"/"This Month" are real calendar boundaries (Monday-to-today,
  // 1st-of-month-to-today), NOT a rolling 7/30-day window — `ReportingStats`'
  // Today/7d/30d chips use rolling windows, but "This Month" reading as
  // "last 30 days" is indistinguishable from "All time" for the first month
  // of this app's life (every accepted lead so far is under 30 days old) and
  // reads wrong once real history exists too — a caller in the first week of
  // October expects "This Month" to mean October, not "since September 5th."
  // The anchor dates (today, the most recent Monday, the 1st of the current
  // month) are computed from the browser's local calendar; only the day
  // BOUNDARY math (midnight, DST) is left to the server, same as `Custom`'s
  // manually-picked dates already are. A viewer many hours from Pacific time
  // could see a label off by one calendar day right at midnight — the same
  // tolerance `Custom`'s plain date inputs already accept.
  const windowQuery = useQuery({
    queryKey: [...SALES_BREAKDOWN_KEY, "window", period, customFrom, customTo],
    queryFn: async () => {
      if (period === "all") return { since: null, until: null };
      if (isCustom) {
        if (!customFrom) return { since: null, until: null };
        const { data, error } = await supabase
          .rpc("reporting_window", { p_start_date: customFrom, p_end_date: customTo || customFrom })
          .single();
        if (error) throw error;
        return data;
      }
      const today = new Date();
      const startDate = period === "week" ? mostRecentMonday(today) : firstOfMonth(today);
      const { data, error } = await supabase
        .rpc("reporting_window", { p_start_date: ymd(startDate), p_end_date: ymd(today) })
        .single();
      if (error) throw error;
      return data;
    },
  });

  const since = windowQuery.data?.since ?? null;
  const until = windowQuery.data?.until ?? null;
  const windowReady = !windowQuery.isPending;

  const carriersQuery = useCarriers(false);
  const carrierRefsList = useMemo(() => carrierRefs(carriersQuery.data), [carriersQuery.data]);

  const acceptedQuery = useQuery({
    queryKey: [...SALES_BREAKDOWN_KEY, "accepted", since, until],
    enabled: windowReady,
    queryFn: () =>
      fetchAllRows<AcceptedRow>((from, to) => {
        let query = supabase
          .from("submissions")
          .select("payload, final_carrier:carriers!submissions_final_carrier_id_fkey(name)")
          .eq("disposition", "accepted")
          .is("archived_at", null);
        if (since) query = query.gte("created_at", since);
        if (until) query = query.lt("created_at", until);
        return query.range(from, to) as unknown as PromiseLike<{
          data: AcceptedRow[] | null;
          error: { message: string } | null;
        }>;
      }),
  });

  const closerQuery = useQuery({
    queryKey: [...SALES_BREAKDOWN_KEY, "closers", since, until],
    enabled: windowReady,
    queryFn: () =>
      fetchAllRows<CloserRow>((from, to) => {
        let query = supabase
          .from("submissions")
          .select("closer_id, disposition, closer:profiles!submissions_closer_id_fkey(full_name)")
          .not("closer_id", "is", null)
          // A validator-submitted lead auto-closes as accepted and stamps
          // closer_id with the VALIDATOR's own id (see ops.tsx/CLAUDE.md) —
          // without this exclusion every validator shows up as a "closer"
          // with a trivial 100% conversion rate from their own self-authored
          // leads, drowning out real closer performance.
          .neq("submitted_by_role", "validator")
          .is("archived_at", null);
        if (since) query = query.gte("created_at", since);
        if (until) query = query.lt("created_at", until);
        return query.range(from, to) as unknown as PromiseLike<{
          data: CloserRow[] | null;
          error: { message: string } | null;
        }>;
      }),
  });

  const breakdown = useMemo(() => {
    const rows = acceptedQuery.data ?? [];
    const totals = emptyCounts();
    const byCarrier = new Map<string, GroupedCounts>();
    const byState = new Map<string, GroupedCounts>();
    for (const row of rows) {
      const bucket = normalizePlanType(row.payload?.["Plan Type"]);
      totals[bucket] += 1;
      const carrier = resolveCarrier(row, carrierRefsList);
      bump(byCarrier, carrier.key, carrier.label, bucket);
      const state = resolveState(row.payload);
      bump(byState, state, state, bucket);
    }
    return {
      total: rows.length,
      totals,
      byCarrier: toPivotRows(byCarrier),
      byState: toPivotRows(byState),
    };
  }, [acceptedQuery.data, carrierRefsList]);

  const leaderboard = useMemo(() => {
    const rows = closerQuery.data ?? [];
    const map = new Map<string, { name: string; total: number; accepted: number }>();
    for (const row of rows) {
      if (!row.closer_id) continue;
      const entry = map.get(row.closer_id) ?? {
        name: row.closer?.full_name?.trim() || "Unnamed closer",
        total: 0,
        accepted: 0,
      };
      entry.total += 1;
      if (row.disposition === "accepted") entry.accepted += 1;
      map.set(row.closer_id, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.accepted - a.accepted);
  }, [closerQuery.data]);

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

  const loading = acceptedQuery.isLoading || closerQuery.isLoading;

  return (
    <div className="flex flex-col gap-4">
      <section className="panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="panel-title">Sales Breakdown</h2>
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
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Total Submitted" value={breakdown.total} />
          {PLAN_TYPE_COLUMNS.map((bucket) => (
            <StatCard key={bucket} label={bucket} value={breakdown.totals[bucket]} />
          ))}
        </dl>
      </section>

      <section className="panel">
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

      <section className="panel">
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

      <section className="panel">
        <h2 className="panel-title">Closer Leaderboard</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <LeaderboardCard
            title={`Top Performer ${periodPhrase(period)}`}
            entry={best}
            tone="positive"
          />
          <LeaderboardCard
            title={`Needs Support ${periodPhrase(period)}`}
            entry={worst}
            tone="destructive"
          />
        </div>

        <div className="mt-3 [&>div]:no-scrollbar [&>div]:max-h-[50vh] [&>div]:overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10">
              <TableRow>
                <TableHead className="w-12">Rank</TableHead>
                <TableHead>Closer</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead className="text-right">Total Submitted</TableHead>
                <TableHead className="text-right">Conversion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leaderboard.map((entry, index) => (
                <TableRow key={entry.name + index}>
                  <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                  <TableCell className="font-medium">{entry.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.accepted}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.total}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
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

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="field-label">{label}</dt>
      <dd className="font-display text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function LeaderboardCard({
  title,
  entry,
  tone,
}: {
  title: string;
  entry: { name: string; total: number; accepted: number } | null;
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
          <span className="font-display text-lg font-semibold">{entry.name}</span>
          <span className="text-xs text-muted-foreground">
            {entry.accepted} accepted / {entry.total} submitted (
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
