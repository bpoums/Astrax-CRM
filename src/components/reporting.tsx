import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  DispositionBadge,
  OriginBadge,
  QueueStatusBadge,
  carrierName,
  closerName,
  customerName,
  dataFlags,
  dispositionLabel,
  isOnHold,
  relativeTime,
  sourceLabel,
  useNow,
  DISPOSITIONS,
  STATUS_LABEL,
  SUB_STATUSES,
  type Disposition,
  type LeadSource,
  type SubStatus,
  type SubmissionRow,
} from "@/components/ops";
import { formatDate } from "@/lib/format-date";
import { DataFlagList } from "@/components/data-flags";
import { LeadPayload } from "@/components/lead-editor";
import { PayloadEditHistory, payloadHistoryKey } from "@/components/payload-history";
import { CarrierDeclineList } from "@/components/carrier-declines";
import { ValidationTimeline, validationTimelineKey } from "@/components/validation-timeline";
import { QueueFlow } from "@/components/queue-flow";
import { MetricBar } from "@/components/metric-bar";
import { ValidatorFields } from "@/components/validator-fields";
import { useDeclinedCarrierMap } from "@/lib/carriers";
import {
  LEAD_PAGE_SIZE,
  carrierSearchClauses,
  matchingProfileIds,
  payloadSearchClauses,
  personSearchClauses,
  sanitizeTerm,
} from "@/lib/lead-search";
import { PaginationBar } from "@/components/pagination-bar";
import { useAuth } from "@/lib/auth";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CxCoverageCard } from "./cx-status-breakdown";

/**
 * Reporting, in two halves that can be mounted separately.
 *
 * `ReportingStats` is the volume and per-validator picture; `SubmissionsExplorer`
 * is the searchable lead table and its audit trail. The admin dashboard puts
 * them on separate tabs so only one runs its queries at a time, while
 * `ReportingDashboard` still renders both together for the manager's Reporting
 * tab — which is what keeps the two dashboards from drifting apart.
 */

type ReportingRow = SubmissionRow & {
  closer: { full_name: string | null } | null;
  uploader: { full_name: string | null } | null;
  assignee: { full_name: string | null } | null;
  timeout_by: { full_name: string | null } | null;
  rejected_by: { full_name: string | null } | null;
};

/**
 * The three sets of leads, split by where each one came from rather than by
 * what it is tagged with.
 *
 * That distinction is the point. `ingest_sheet_lead` writes an imported lead
 * with `submitted_by_role = 'closer'` and `closer_id = null`, so splitting on
 * the role alone put every uploaded lead on the Closer tab with an empty Closer
 * column. Origin is what actually separates them.
 */
type LeadTab = "closer" | "validator" | "offline";

const LEAD_TABS: { id: LeadTab; label: string }[] = [
  { id: "closer", label: "Closer Submissions" },
  { id: "validator", label: "Validator Submissions" },
  { id: "offline", label: "Manual Submissions" },
];

/**
 * The windows the record can be read over.
 *
 * `days` is what the RPCs take, and null means all time — the same value the
 * functions treat as "no filter", so All time returns exactly what the old
 * unscoped views did. The boundary itself is a Pacific calendar day computed in
 * `reporting_since`, not in the browser: "today" must mean the same day for a
 * reader in Lahore as for the business in Los Angeles.
 */
const PERIODS = [
  { id: "today", label: "Today", days: 1, heading: "Today" },
  { id: "7d", label: "7 days", days: 7, heading: "Last 7 days" },
  { id: "30d", label: "30 days", days: 30, heading: "Last 30 days" },
  { id: "all", label: "All time", days: null, heading: "All time" },
] as const;

type PeriodId = (typeof PERIODS)[number]["id"] | "custom";

/**
 * All time by default, deliberately.
 *
 * Every figure on this page has been a lifetime total until now. Opening it to
 * a 30-day window would make each one appear to drop, which reads as data loss
 * rather than as a filter. The reader opts in.
 */
const DEFAULT_PERIOD: PeriodId = "all";

const SUBMISSIONS_KEY = ["reporting", "submissions"];
const SUBMISSION_COUNTS_KEY = ["reporting", "submission-counts"];
const TOTALS_KEY = ["reporting", "totals"];
const VALIDATOR_STATS_KEY = ["reporting", "validator-stats"];
const CENTER_TOTALS_KEY = ["reporting", "center-totals"];
const ON_HOLD_KEY = ["reporting", "on-hold"];

/**
 * Enums cannot be searched with ILIKE — Postgres has no such operator for them
 * — so the term is matched here against both the stored value and the label on
 * screen, and the values that matched become an `in.(...)` clause.
 *
 * This also fixes something the old client-side filter got wrong: it compared
 * the term against the raw enum, so typing the word actually printed in the
 * column ("Unassigned") found nothing, while "pending_manager" worked. Both
 * work now.
 */
function matchingStatuses(term: string): SubStatus[] {
  return SUB_STATUSES.filter(
    (status) =>
      status.toLowerCase().includes(term) || STATUS_LABEL[status].toLowerCase().includes(term),
  );
}

function matchingDispositions(term: string): Disposition[] {
  return DISPOSITIONS.filter(
    (value) => value.includes(term) || (dispositionLabel(value) ?? "").toLowerCase().includes(term),
  );
}

/**
 * The Source column shows a centre's name for an imported lead and the word
 * "Live" for a closer's own. The centre names are already reached through
 * `uploaded_by`, so only the two literals need matching here.
 */
function matchingSources(term: string): LeadSource[] {
  const out: LeadSource[] = [];
  if ("live".includes(term)) out.push("live");
  // "offline" still matches, so a saved search or an old habit keeps working
  // after the rename.
  if ("manual".includes(term) || "offline".includes(term) || "sheet".includes(term))
    out.push("sheet");
  return out;
}

/**
 * Everything a lead can be matched on, as one `or` group.
 *
 * Both sub-tabs use it, so a term behaves the same whichever one is open —
 * the alternative was two search implementations drifting apart.
 */
function leadSearchClauses(term: string, profileIds: string[]) {
  const lower = term.toLowerCase();
  const clauses = [
    ...payloadSearchClauses(term),
    // Customer, closer, uploading centre and validator, in that order.
    ...personSearchClauses(["closer_id", "uploaded_by", "assigned_to"], profileIds),
  ];
  const statuses = matchingStatuses(lower);
  if (statuses.length > 0) clauses.push(`status.in.(${statuses.join(",")})`);
  const dispositions = matchingDispositions(lower);
  if (dispositions.length > 0) clauses.push(`disposition.in.(${dispositions.join(",")})`);
  const sources = matchingSources(lower);
  if (sources.length > 0) clauses.push(`source.in.(${sources.join(",")})`);
  return clauses;
}

/**
 * One cache entry per tab, page, term and archived state, so paging back and
 * forth is instant and two tabs never share a page number.
 */
function explorerKey(
  tab: LeadTab,
  page: number,
  term: string,
  archived: boolean,
  carrier: string,
  dateFrom: string,
  dateTo: string,
) {
  return [...SUBMISSIONS_KEY, tab, page, term, archived, carrier, dateFrom, dateTo] as const;
}

/**
 * Volume and per-validator performance. Counts are aggregated server-side by
 * `submission_totals` and `validator_stats`; the client never recounts them.
 */
export function ReportingStats({
  showValidatorSubmissions = false,
}: {
  showValidatorSubmissions?: boolean;
}) {
  const queryClient = useQueryClient();
  const [periodId, setPeriodId] = useState<PeriodId>(DEFAULT_PERIOD);
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
  // What every heading below reads, instead of the fixed PERIODS label.
  const heading = startKey
    ? endKey && endKey !== startKey
      ? `${startKey} – ${endKey}`
      : startKey
    : isCustom
      ? "Custom range — pick a date"
      : period.heading;

  const validatorStats = useQuery({
    queryKey: [...VALIDATOR_STATS_KEY, days, startKey, endKey],
    queryFn: async () => {
      // Ordered again here as well as in the function body: PostgREST makes no
      // promise about preserving a function's own ORDER BY, and this table is
      // meant to read alphabetically however it was fetched.
      const { data, error } = await supabase
        .rpc("validator_stats_range", range)
        .order("validator_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  /**
   * The same volume, split by centre.
   *
   * One row per ACTIVE centre, including the ones with nothing on them yet —
   * the view left-joins from `centers`, so a centre that has taken no leads
   * reports zeroes rather than dropping out of the table. Nothing here names a
   * centre; adding one in Settings is all it takes to appear.
   *
   * `sort_order` is restated as an explicit order rather than trusted from the
   * view: PostgREST makes no promise about the order rows come back in without
   * one, and this table is meant to read in the same sequence as the Center
   * picker.
   */
  const centerTotals = useQuery({
    queryKey: [...CENTER_TOTALS_KEY, days, startKey, endKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .rpc("submission_totals_by_center_range", range)
        .order("sort_order", { ascending: true })
        .order("center_name", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const totals = useQuery({
    queryKey: [...TOTALS_KEY, days, startKey, endKey],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("submission_totals_range", range).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  /**
   * The two open stages `submission_totals` cannot publish, in one read.
   *
   * Being on hold is a SHAPE across four columns, and its last condition —
   * `last_held_at` newer than `assigned_at` — is a column-to-column comparison
   * PostgREST has no filter for. So the query narrows to the statuses it can
   * express and the shape is applied here, over the open rows only.
   *
   * Held leads sit in `assigned`, so the two are separated rather than summed:
   * a lead is counted once, in the stage it is actually in, and the flow strip
   * above never adds up to more than the work that exists.
   *
   * `awaiting_manager` and `in_review` are NOT recomputed here — those the view
   * publishes, and they are read from it. The open rows are still fetched, but
   * only for the age of the oldest lead in each stage, which no view carries.
   */
  const openQueue = useQuery({
    queryKey: ON_HOLD_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("status, created_at, claimed_at, assigned_at, last_held_at")
        .in("status", ["pending_manager", "assigned", "in_review", "returned_timeout"])
        .is("archived_at", null);
      if (error) throw error;
      const rows = data ?? [];
      const held = rows.filter((row) => row.status === "assigned" && isOnHold(row));

      /** The submission date of the oldest lead among these, or null. */
      const oldest = (of: typeof rows) =>
        of.reduce<string | null>(
          (first, row) => (!first || row.created_at < first ? row.created_at : first),
          null,
        );

      const byStatus = (status: string) => rows.filter((row) => row.status === status);
      const assigned = byStatus("assigned").filter((row) => !isOnHold(row));

      return {
        // COUNTS for the two stages the view publishes are not taken from here
        // — see the note above. These rows exist for the ages, and for the
        // three counts submission_totals cannot express.
        onHold: held.length,
        assigned: assigned.length,
        returned: byStatus("returned_timeout").length,
        oldest: {
          unassigned: oldest(byStatus("pending_manager")),
          assigned: oldest(assigned),
          inReview: oldest(byStatus("in_review")),
          onHold: oldest(held),
          returned: oldest(byStatus("returned_timeout")),
        },
      };
    },
  });

  // Its own channel name: this half and the explorer can be mounted on
  // different tabs, and two subscriptions may not share one name.
  useEffect(() => {
    const channel = supabase
      .channel("reporting-stats")
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, () => {
        queryClient.invalidateQueries({ queryKey: TOTALS_KEY });
        queryClient.invalidateQueries({ queryKey: VALIDATOR_STATS_KEY });
        queryClient.invalidateQueries({ queryKey: CENTER_TOTALS_KEY });
        queryClient.invalidateQueries({ queryKey: ON_HOLD_KEY });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const perValidator = useMemo(() => validatorStats.data ?? [], [validatorStats.data]);
  const perCenter = useMemo(() => centerTotals.data ?? [], [centerTotals.data]);
  // What every centre's bar is measured against, so the busiest one fills.
  const centerMax = useMemo(
    () => perCenter.reduce((most, center) => Math.max(most, center.total_submissions ?? 0), 0),
    [perCenter],
  );
  const totalsRow = totals.data ?? null;

  return (
    <>
      {/* The news, first and largest: open work, and which stage it is
          sitting in. Everything below this is the record. */}
      <QueueFlow
        unassigned={{
          value: totalsRow?.awaiting_manager ?? 0,
          oldest: openQueue.data?.oldest.unassigned ?? null,
        }}
        assigned={{
          value: openQueue.data?.assigned ?? 0,
          oldest: openQueue.data?.oldest.assigned ?? null,
        }}
        inReview={{
          value: totalsRow?.in_review ?? 0,
          oldest: openQueue.data?.oldest.inReview ?? null,
        }}
        onHold={{
          value: openQueue.data?.onHold ?? 0,
          oldest: openQueue.data?.oldest.onHold ?? null,
        }}
        returned={{
          value: openQueue.data?.returned ?? 0,
          oldest: openQueue.data?.oldest.returned ?? null,
        }}
        loading={totals.isLoading || openQueue.isLoading}
      />

      {/* The window applies to everything BELOW it, never to the strip above:
          "where leads are right now" is current state, and scoping it to a past
          week would answer a question nobody asked. Said out loud beside the
          chips, because a filter that silently leaves one panel out is worse
          than no filter. */}
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
        <span className="text-[0.66rem] text-muted-foreground">
          Applies to the totals below. The queue above is always live.
        </span>
      </div>

      {/* Deliberately quieter than the strip above. These are the record —
          true, worth having, and not what anybody opens this tab to find out.
          Eight of them as 3xl cards gave a number nobody can act on the same
          weight as the queue that needs working today. */}
      <section className="panel">
        <h2 className="panel-title">{heading}</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <Total label="Closer" value={totalsRow?.closer_submissions} />
          {/* Uploaded leads that a manager has accepted. The view counts
              `source = 'sheet'` excluding `pending_import_approval`, which is
              the same rule the Manual Submissions tab uses — so a batch
              contributes nothing here until it is approved, and there is no
              client-side condition to keep in step with it. */}
          <Total label="Manual" value={totalsRow?.offline_submissions} />
          {/* Validator submissions are self-entered and auto-approved, so they
              are named as their own figure rather than mixed into the review
              outcomes beside them. */}
          {showValidatorSubmissions ? (
            <Total label="Validator" value={totalsRow?.validator_submissions} />
          ) : null}
          <Total label="Submitted" value={totalsRow?.approved} />
          <Total label="Declined" value={totalsRow?.declined} tone="destructive" />
          {showValidatorSubmissions ? null : (
            <>
              <Total label="Timeouts" value={totalsRow?.timeouts} tone="destructive" />
              <Total label="Rejections" value={totalsRow?.rejections} tone="destructive" />
            </>
          )}
        </dl>
      </section>

      {/* A list rather than a table: two columns over a handful of rows is
          less than a table earns, and the bar does the comparing that a second
          numeric column would otherwise be needed for.

          Gated on the same flag the strip above is — this is the admin
          Overview's picture, and the manager's Reporting tab shows the queue
          it works rather than a breakdown of the whole business. */}
      {showValidatorSubmissions ? (
        <section className="panel">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="panel-title">Leads by Center ({perCenter.length})</h2>
            <span className="text-[0.66rem] text-muted-foreground">{heading}</span>
          </div>
          <ul className="flex flex-col gap-2.5">
            {perCenter.map((center) => (
              <li key={center.center_id ?? center.center_name} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-xs font-medium">
                    {center.center_name ?? "—"}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {center.total_submissions ?? 0}
                  </span>
                </div>
                <MetricBar value={center.total_submissions ?? 0} max={centerMax} />
              </li>
            ))}
            {perCenter.length === 0 ? (
              <li className="text-xs text-muted-foreground">
                {centerTotals.isLoading
                  ? "Loading…"
                  : centerTotals.isError
                    ? (centerTotals.error as Error).message
                    : "No active centers."}
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {showValidatorSubmissions ? null : (
        <>
          <section className="panel">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="panel-title">Validators Team Dashboard ({perValidator.length})</h2>
              {/* Scoped on when the validator ACTED, not on when the lead
                  arrived — a lead submitted last month and disposed today is
                  today's work. See validator_stats_range. */}
              <span className="text-[0.66rem] text-muted-foreground">{heading}</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Validator</TableHead>
                  <TableHead className="text-right">Assigned</TableHead>
                  <TableHead className="text-right">Submitted</TableHead>
                  <TableHead className="text-right">Declined</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead className="text-right">Timed out</TableHead>
                  <TableHead className="text-right">Holds</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perValidator.map((validator) => (
                  <TableRow key={validator.validator_id ?? validator.validator_name}>
                    <TableCell className="font-medium">
                      {validator.validator_name ?? validator.validator_id}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {validator.assigned ?? 0}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {validator.approved ?? 0}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {validator.declined ?? 0}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${
                        (validator.rejected ?? 0) > 0 ? "text-destructive" : "text-muted-foreground"
                      }`}
                    >
                      {validator.rejected ?? 0}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${
                        (validator.timed_out ?? 0) > 0
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {validator.timed_out ?? 0}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {validator.holds ?? 0}
                    </TableCell>
                  </TableRow>
                ))}
                {perValidator.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      {validatorStats.isLoading ? "Loading…" : "No validators yet."}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </section>
        </>
      )}
    </>
  );
}

/**
 * Every submission, searchable, with its full audit trail.
 *
 * Deliberately unfiltered by status: a lead stays in this table for good once
 * it is disposed, unlike the Operations queue which retires it.
 */
export function SubmissionsExplorer() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const now = useNow();
  const [search, setSearch] = useState("");
  const [carrierSearch, setCarrierSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [leadTab, setLeadTab] = useState<LeadTab>("closer");
  const [showArchived, setShowArchived] = useState(false);
  // A specific day, or a from/to range. Left blank, nothing is filtered by
  // date at all — the same "unset means no filter" convention the carrier
  // box and the Overview tab's custom range both already use.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // A page number each. The three tabs are separate lists of separate lengths;
  // sharing one would land the reader on an empty page four when they switch.
  const [closerPage, setCloserPage] = useState(0);
  const [validatorPage, setValidatorPage] = useState(0);
  const [offlinePage, setOfflinePage] = useState(0);

  const term = sanitizeTerm(search);
  // Same sanitiser: this ends up in an `or=` group too, so a comma or a bracket
  // would end the group early exactly as it would in the free-text search.
  const carrierTerm = sanitizeTerm(carrierSearch);
  const carrierFiltered = carrierTerm.length > 0;
  const dateFiltered = dateFrom.length > 0 || dateTo.length > 0;

  // Any of these changes what page 1 even means, so all three go back to the start.
  useEffect(() => {
    setCloserPage(0);
    setValidatorPage(0);
    setOfflinePage(0);
  }, [term, carrierTerm, showArchived, leadTab, dateFrom, dateTo]);

  /**
   * One page of one sub-tab.
   *
   * The search runs in the database, not over the rows already fetched. That
   * distinction is the whole point: filtering twenty-five fetched rows would
   * report "no submissions match" for a lead sitting on the next page, and
   * would look exactly like a genuinely empty result.
   *
   * Only the visible tab's query runs — switching tabs is what starts the other.
   */
  function submissionsQuery(tab: LeadTab, page: number) {
    return {
      queryKey: explorerKey(tab, page, term, showArchived, carrierTerm, dateFrom, dateTo),
      enabled: leadTab === tab,
      queryFn: async () => {
        // Resolved first so a person match can join the same `or` as the
        // payload matches: closer_id, uploaded_by and assigned_to are base
        // columns, whereas an embedded profiles filter could not be or-ed
        // with one.
        const profileIds = term ? await matchingProfileIds(term) : [];

        // The same Pacific-calendar-day RPC the Overview tab's custom range
        // uses — reused rather than reimplemented, so a "today" here and a
        // "today" there can never disagree about where midnight falls.
        let dateWindow: { since: string | null; until: string | null } | null = null;
        if (dateFrom) {
          const { data, error } = await supabase
            .rpc("reporting_window", { p_start_date: dateFrom, p_end_date: dateTo || dateFrom })
            .single();
          if (error) throw error;
          dateWindow = data;
        }

        let query = supabase
          .from("submissions")
          .select(
            "*, closer:profiles!submissions_closer_id_fkey(full_name), uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name), assignee:profiles!submissions_assigned_to_fkey(full_name), timeout_by:profiles!submissions_last_timeout_by_fkey(full_name), rejected_by:profiles!submissions_last_rejected_by_fkey(full_name)",
            { count: "exact" },
          );

        // A validator submission carries its author in closer_id. Anything not
        // explicitly tagged 'validator' is a closer submission, which is what
        // keeps rows written before the column existed on the Closer tab.
        //
        // ORIGIN is what separates the other two, not the role. An imported
        // lead is tagged 'closer' by ingest_sheet_lead and has no closer at
        // all, so without the source test it sat on the Closer tab with an
        // empty Closer column. `source` is NOT NULL and defaults to 'live', so
        // no row is old enough to fall through this split.
        if (tab === "validator") {
          query = query.eq("submitted_by_role", "validator");
        } else if (tab === "offline") {
          // A lead still inside the import gate belongs to Pending Imports and
          // nowhere else — that queue is the action, this tab is the record of
          // what happened after the decision. Neither may show it at once.
          query = query.eq("source", "sheet").neq("status", "pending_import_approval");
        } else {
          query = query
            .eq("source", "live")
            .or("submitted_by_role.is.null,submitted_by_role.neq.validator");
        }

        // Archived rows are hidden until the toggle asks for them, and then
        // they are ALL you see — the two sets never mix.
        query = showArchived ? query.not("archived_at", "is", null) : query.is("archived_at", null);

        // A second `or` group; PostgREST ANDs repeated filters, so this narrows
        // the tab above rather than widening it.
        if (term) query = query.or(leadSearchClauses(term, profileIds).join(","));

        // And a third, for the same reason: the carrier box narrows whatever
        // the search box already matched rather than competing with it. It runs
        // in the database like every other filter here — this table is paged, so
        // a browser-side match would only ever see the twenty-five rows already
        // fetched and would report nothing for a lead on page four.
        if (carrierTerm) query = query.or(carrierSearchClauses(carrierTerm).join(","));

        // A fourth, independent AND: narrows whatever the filters above
        // already matched rather than competing with them, same as every
        // other filter in this query.
        if (dateWindow?.since) query = query.gte("created_at", dateWindow.since);
        if (dateWindow?.until) query = query.lt("created_at", dateWindow.until);

        const from = page * LEAD_PAGE_SIZE;
        const { data, error, count } = await query
          .order("created_at", { ascending: false })
          .range(from, from + LEAD_PAGE_SIZE - 1);
        if (error) throw error;
        return { rows: (data ?? []) as unknown as ReportingRow[], total: count ?? 0 };
      },
    };
  }

  const closerQuery = useQuery(submissionsQuery("closer", closerPage));
  const validatorQuery = useQuery(submissionsQuery("validator", validatorPage));
  const offlineQuery = useQuery(submissionsQuery("offline", offlinePage));

  /**
   * All three tabs' counts, so a reader sees where the leads are without
   * clicking through each one. Head-count only (`head: true`) — no rows,
   * so this runs for every tab at once without the cost the paginated
   * fetch above deliberately avoids by only running the active tab's.
   * Mirrors the same filter composition `submissionsQuery` uses, so a
   * chip's number always matches what that tab would show if opened.
   */
  const submissionCounts = useQuery({
    queryKey: [...SUBMISSION_COUNTS_KEY, term, showArchived, carrierTerm, dateFrom, dateTo],
    queryFn: async () => {
      const profileIds = term ? await matchingProfileIds(term) : [];

      let dateWindow: { since: string | null; until: string | null } | null = null;
      if (dateFrom) {
        const { data, error } = await supabase
          .rpc("reporting_window", { p_start_date: dateFrom, p_end_date: dateTo || dateFrom })
          .single();
        if (error) throw error;
        dateWindow = data;
      }

      async function countFor(tab: LeadTab) {
        let query = supabase.from("submissions").select("id", { count: "exact", head: true });
        if (tab === "validator") {
          query = query.eq("submitted_by_role", "validator");
        } else if (tab === "offline") {
          query = query.eq("source", "sheet").neq("status", "pending_import_approval");
        } else {
          query = query
            .eq("source", "live")
            .or("submitted_by_role.is.null,submitted_by_role.neq.validator");
        }
        query = showArchived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
        if (term) query = query.or(leadSearchClauses(term, profileIds).join(","));
        if (carrierTerm) query = query.or(carrierSearchClauses(carrierTerm).join(","));
        if (dateWindow?.since) query = query.gte("created_at", dateWindow.since);
        if (dateWindow?.until) query = query.lt("created_at", dateWindow.until);
        const { count, error } = await query;
        if (error) throw error;
        return count ?? 0;
      }

      const [closer, validator, offline] = await Promise.all([
        countFor("closer"),
        countFor("validator"),
        countFor("offline"),
      ]);
      return { closer, validator, offline } satisfies Record<LeadTab, number>;
    },
  });

  const unarchive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("unarchive_submission", { p_sub: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Submission restored");
      queryClient.invalidateQueries({ queryKey: SUBMISSIONS_KEY });
      queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Names the carriers on a returned lead, the same one query the manager
  // queue makes — the view holds only leads that have been declined.
  const declinedMap = useDeclinedCarrierMap();

  /**
   * The Validation Status cell, for EVERY tab that draws one.
   *
   * Spelled once on purpose. The Manual tab used to render a bare
   * `StatusBadge`, which reads the status column and nothing else — so a lead
   * sitting at `pending_manager` because nobody has touched it and a lead
   * sitting there because a validator declined it both came out as a plain
   * "Unassigned", and the decision was lost from the only column that could
   * have shown it. `QueueStatusBadge` is the one place that precedence lives;
   * a tab that wants a status badge calls this and gets the whole chain,
   * carrier names included.
   */
  const validationStatus = (row: ReportingRow) => (
    <QueueStatusBadge row={row} declinedCarriers={declinedMap.data?.get(row.id) ?? []} />
  );

  const filteredCloser = useMemo(() => closerQuery.data?.rows ?? [], [closerQuery.data]);
  const filteredValidator = useMemo(() => validatorQuery.data?.rows ?? [], [validatorQuery.data]);
  const filteredOffline = useMemo(() => offlineQuery.data?.rows ?? [], [offlineQuery.data]);

  // Keyed rather than chained: a third tab turns a ternary pair into something
  // nobody can read, and a Record over the union cannot silently miss a tab.
  const queries: Record<LeadTab, typeof closerQuery> = {
    closer: closerQuery,
    validator: validatorQuery,
    offline: offlineQuery,
  };
  const paging: Record<LeadTab, { page: number; setPage: (next: number) => void }> = {
    closer: { page: closerPage, setPage: setCloserPage },
    validator: { page: validatorPage, setPage: setValidatorPage },
    offline: { page: offlinePage, setPage: setOfflinePage },
  };

  const active = queries[leadTab];
  const activePage = paging[leadTab].page;
  const setActivePage = paging[leadTab].setPage;
  // The exact count for the whole result, not the size of this page — the
  // header answers "how many are there", which paging must not change.
  const visibleCount = active.data?.total ?? 0;

  // Only ever a row on the page in front of the reader, which is the only row
  // they can have clicked.
  const rows = active.data?.rows ?? [];
  const selected = rows.find((row) => row.id === openId) ?? null;

  /**
   * Held in a ref, and deliberately not in the effect's dependencies.
   *
   * The handler needs the page and term as they are when a change actually
   * arrives, but putting them in the dependency list would tear down and
   * resubscribe the channel on every keystroke.
   */
  const activeKeyRef = useRef(
    explorerKey(leadTab, activePage, term, showArchived, carrierTerm, dateFrom, dateTo),
  );
  activeKeyRef.current = explorerKey(
    leadTab,
    activePage,
    term,
    showArchived,
    carrierTerm,
    dateFrom,
    dateTo,
  );

  useEffect(() => {
    const channel = supabase
      .channel("reporting-submissions")
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, () => {
        // Just the page being looked at. Retiring every cached page would send
        // the browser back for pages nobody is reading.
        queryClient.invalidateQueries({ queryKey: activeKeyRef.current });
        // The three chip counts are cheap and shared by every tab, so they
        // always refresh rather than only the active one.
        queryClient.invalidateQueries({ queryKey: SUBMISSION_COUNTS_KEY });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // `update_payload_field` accepts these two roles and refuses the rest.
  const canEditLead = profile?.role === "manager" || profile?.role === "admin";

  return (
    <>
      <section className="panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="panel-title">Submissions</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowArchived((prev) => !prev)}
              aria-pressed={showArchived}
              className={`chip px-2.5 py-0.5 text-[0.66rem] ${showArchived ? "chip-active" : ""}`}
            >
              Show archived
            </button>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              // One search for both sub-tabs now that it runs in the
              // database, so the hint no longer differs between them.
              placeholder="Search customer, phone, closer, validator, status, source…"
              className="field-input max-w-xs"
              aria-label="Search submissions"
            />
            {/* Its own box rather than another word in the one beside it: this
                NARROWS whatever that search returned, so a carrier and a
                customer can be asked for together. */}
            <input
              type="search"
              value={carrierSearch}
              onChange={(event) => setCarrierSearch(event.target.value)}
              placeholder="Search carrier…"
              className="field-input w-44"
              aria-label="Filter submissions by carrier"
            />
            {carrierFiltered ? (
              <button
                type="button"
                className="chip px-2.5 py-0.5 text-[0.66rem]"
                onClick={() => setCarrierSearch("")}
              >
                Clear carrier
              </button>
            ) : null}
            {/* Two more boxes rather than a third word in the search field:
                a date range is its own kind of filter, and this narrows
                whatever the search/carrier boxes already matched — same
                composition as every other filter here. Leaving "To" blank
                filters exactly the one day in "From". */}
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              aria-label="From date"
              className="field-input w-36"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              aria-label="To date (optional — leave blank for a single day)"
              className="field-input w-36"
            />
            {dateFiltered ? (
              <button
                type="button"
                className="chip px-2.5 py-0.5 text-[0.66rem]"
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                }}
              >
                Clear dates
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {LEAD_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setLeadTab(tab.id)}
              aria-pressed={leadTab === tab.id}
              className={`chip px-2.5 py-0.5 text-[0.66rem] ${
                leadTab === tab.id ? "chip-active" : ""
              }`}
            >
              {tab.label} ({submissionCounts.data?.[tab.id] ?? "…"})
            </button>
          ))}
        </div>

        {leadTab === "closer" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Center</TableHead>
                <TableHead>Customer</TableHead>
                {/* <TableHead>Carrier Name</TableHead> */}
                <TableHead>Closer</TableHead>
                <TableHead>Validator</TableHead>
                <TableHead>Application Duration</TableHead>
                <TableHead>Validation Status</TableHead>
                <TableHead>Disposition</TableHead>
                {showArchived ? <TableHead className="text-right">Action</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCloser.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                  <TableCell>
                    <OriginBadge row={row} />
                  </TableCell>
                  {/* The stamped name, not a join: a lead keeps the centre it
                      was taken in even after that centre is renamed or the
                      closer is moved to another one. */}
                  <TableCell className="text-muted-foreground">{row.center_name ?? "—"}</TableCell>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                  {/* Free text as the operator typed it — see carrierName(). */}
                  {/* <TableCell className="text-muted-foreground">
                    {carrierName(row.payload)}
                  </TableCell> */}
                  <TableCell className="text-muted-foreground">{closerName(row)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.assignee?.full_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {/* {relativeTime(row.created_at, now)} */}
                    {formatDate(row.created_at)}
                  </TableCell>
                  {/* The same chain the Operations queue draws, so a lead that
                      came back declined reads the same in both. */}
                  <TableCell>{validationStatus(row)}</TableCell>
                  <TableCell>
                    <DispositionBadge disposition={row.disposition} onHold={isOnHold(row)} />
                  </TableCell>
                  {showArchived ? (
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <RestoreButton id={row.id} onRestore={unarchive} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
              {filteredCloser.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={showArchived ? 10 : 9}
                    className="text-center text-muted-foreground"
                  >
                    {closerQuery.isLoading ? "Loading…" : "No submissions match that search."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        ) : leadTab === "validator" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Carrier Name</TableHead>
                <TableHead>Validator</TableHead>
                <TableHead>Submitted</TableHead>
                {showArchived ? <TableHead className="text-right">Action</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredValidator.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                  {/* A validator submission stores this under "Agency", not
                      "Carrier Name" — carrierName() reads both. */}
                  <TableCell className="text-muted-foreground">
                    {carrierName(row.payload)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{closerName(row)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {/* {relativeTime(row.created_at, now)} */}
                    {formatDate(row.created_at)}
                  </TableCell>
                  {showArchived ? (
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <RestoreButton id={row.id} onRestore={unarchive} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
              {filteredValidator.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={showArchived ? 5 : 4}
                    className="text-center text-muted-foreground"
                  >
                    {validatorQuery.isLoading ? "Loading…" : "No submissions match that search."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Carrier Name</TableHead>
                <TableHead>Validator</TableHead>
                <TableHead>Upload Date</TableHead>
                <TableHead>Validation Status</TableHead>
                <TableHead>Disposition</TableHead>
                {showArchived ? <TableHead className="text-right">Action</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOffline.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                  {/* Every row here is manual, so the badge earns its place by
                      naming WHICH centre supplied the lead — org_name, or the
                      uploader's own name where the account has none. */}
                  <TableCell>
                    <OriginBadge row={row} />
                  </TableCell>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {carrierName(row.payload)}
                  </TableCell>
                  {/* No Closer column: an imported lead has none. It can still
                      be assigned to a validator like any other, once its batch
                      has been accepted. */}
                  <TableCell className="text-muted-foreground">
                    {row.assignee?.full_name ?? "—"}
                  </TableCell>
                  {/* An absolute date, not "3d ago": this column is the date the
                      file was uploaded, and it is what an operator reconciles
                      against the spreadsheet they sent. */}
                  <TableCell className="text-muted-foreground">
                    {formatDate(row.created_at)}
                  </TableCell>
                  <TableCell>{validationStatus(row)}</TableCell>
                  <TableCell>
                    <DispositionBadge disposition={row.disposition} onHold={isOnHold(row)} />
                  </TableCell>
                  {showArchived ? (
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <RestoreButton id={row.id} onRestore={unarchive} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
              {filteredOffline.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={showArchived ? 8 : 7}
                    className="text-center text-muted-foreground"
                  >
                    {offlineQuery.isLoading ? "Loading…" : "No submissions match that search."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        )}

        {/* Under the table it belongs to, so the two sub-tabs page
            independently and neither can move the other. */}
        <PaginationBar
          page={activePage}
          pageSize={LEAD_PAGE_SIZE}
          shown={rows.length}
          total={visibleCount}
          busy={active.isFetching}
          onPage={setActivePage}
        />
      </section>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto overflow-x-hidden sm:max-w-xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{customerName(selected.payload)}</SheetTitle>
                <SheetDescription>
                  {closerName(selected)} · {sourceLabel(selected)} ·{" "}
                  {relativeTime(selected.created_at, now)} ·{" "}
                  {dispositionLabel(selected.disposition) ?? selected.status}
                </SheetDescription>
              </SheetHeader>

              <div className="flex min-w-0 max-w-full flex-col gap-4 px-4 pb-4">
                {/* Editable here as well as in the Operations queue: this is
                    the only place a disposed or archived lead can still be
                    reached, and a typo found after the fact is still a typo. */}
                <LeadPayload
                  submissionId={selected.id}
                  payload={selected.payload}
                  editable={canEditLead}
                  onSaved={() => {
                    queryClient.invalidateQueries({ queryKey: SUBMISSIONS_KEY });
                    // The edit that was just written is what the history panel
                    // below exists to show, so it refetches with the lead.
                    queryClient.invalidateQueries({ queryKey: payloadHistoryKey(selected.id) });
                  }}
                />

                {/* Below Lead Details, like everywhere else this renders —
                    the review's own outcome, not part of what was typed. */}
                <ValidatorFields
                  row={selected}
                  onSaved={() => {
                    queryClient.invalidateQueries({ queryKey: SUBMISSIONS_KEY });
                    queryClient.invalidateQueries({
                      queryKey: validationTimelineKey(selected.id),
                    });
                  }}
                />

                <DataFlagList
                  submissionId={selected.id}
                  payload={selected.payload}
                  flags={dataFlags(selected.data_flags)}
                />

                {/* Kept above the timeline and out of it: the carriers a lead
                    has been refused by is a different story from the claims and
                    holds of one pass through the queue. */}
                <CarrierDeclineList submissionId={selected.id} />

                {/* Likewise: the timeline says a payload was edited, this says
                    what the value was. Same panel as the closing desk. */}
                <PayloadEditHistory submissionId={selected.id} />

                {/* The same component the closing desk and the CX pipeline
                    draw, so the four copies of this that had already drifted
                    are now one. `seconds` is the one thing Reporting needs of
                    its own: its events can land inside the same minute and the
                    order is the point. */}
                <ValidationTimeline submissionId={selected.id} seconds />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Both halves together — the manager's Reporting tab, unchanged. The admin
 * dashboard mounts the two separately instead, one per tab.
 */
export function ReportingDashboard({
  showValidatorSubmissions = false,
}: {
  showValidatorSubmissions?: boolean;
}) {
  return (
    <>
      <ReportingStats showValidatorSubmissions={showValidatorSubmissions} />
      <SubmissionsExplorer />
    </>
  );
}

function RestoreButton({
  id,
  onRestore,
}: {
  id: string;
  onRestore: { mutate: (id: string) => void; isPending: boolean };
}) {
  return (
    <button
      type="button"
      className="chip px-2.5 py-0.5 text-[0.66rem]"
      disabled={onRestore.isPending}
      onClick={() => onRestore.mutate(id)}
    >
      Restore
    </button>
  );
}

/** The totals view returns nullable counts, and is undefined until it loads. */
/**
 * One lifetime figure inside the all-time strip.
 *
 * Deliberately not a panel of its own. These were eight separate cards with
 * 3xl numerals, which gave a total nobody can act on the same presence as the
 * queue that needs working today; grouped into one panel at a smaller size they
 * stay readable and stop competing with it.
 */
function Total({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null | undefined;
  tone?: "destructive";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="field-label">{label}</dt>
      <dd
        className={`font-display text-xl font-semibold tabular-nums ${
          tone === "destructive" && (value ?? 0) > 0 ? "text-destructive" : ""
        }`}
      >
        {value ?? 0}
      </dd>
    </div>
  );
}
