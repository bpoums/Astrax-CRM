import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  CenterBadge,
  DispositionBadge,
  OriginBadge,
  QueueStatusBadge,
  carrierName,
  closerName,
  customerName,
  dataFlags,
  dispositionLabel,
  finalCarrierName,
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
import { useCenterColorById } from "@/lib/centers";
import { formatDate, formatEventTime } from "@/lib/format-date";
import { DataFlagList } from "@/components/data-flags";
import { LeadPayload } from "@/components/lead-editor";
import { PayloadEditHistory, payloadHistoryKey } from "@/components/payload-history";
import { CarrierDeclineList } from "@/components/carrier-declines";
import { validationTimelineKey } from "@/components/validation-timeline";
import { LeadHistoryDialog } from "@/components/lead-history-dialog";
import { History } from "lucide-react";
import { OverviewPanels } from "@/components/overview-panels";
import { MetricBar } from "@/components/metric-bar";
import { PeriodPicker } from "@/components/period-picker";
import { usePeriod } from "@/lib/period-range";
import {
  useOverviewStats,
  type CenterTotalsRow,
  type OverviewTotalsRow,
} from "@/lib/overview-stats";
import { ValidatorFields } from "@/components/validator-fields";
import { useDeclinedCarrierMap } from "@/lib/carriers";
import {
  LEAD_PAGE_SIZE,
  finalCarrierSearchClauses,
  matchingCarrierIds,
  matchingProfileIds,
  payloadSearchClauses,
  personSearchClauses,
  proposedCarrierSearchClauses,
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
import { Badge } from "@/components/ui/badge";
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
  /** Set during review by `set_validator_fields`; null until then, and on
   *  every validator submission (which never passes through review). */
  final_carrier: { name: string | null } | null;
};

/**
 * The two sets of leads, named for how the business actually categorises them:
 * a lead a closer took on the phone is *Live*; everything a human typed or
 * uploaded outside that flow is *Manual*.
 *
 * Live is a pure origin test, and has to be. `ingest_sheet_lead` writes an
 * imported lead with `submitted_by_role = 'closer'` and `closer_id = null`, so
 * splitting on the role alone put every uploaded lead on this tab with an empty
 * Closer column.
 *
 * Manual is the one place this file mixes a ROLE test with an ORIGIN test, and
 * does so deliberately: a validator's own submission (role) and an uploaded
 * lead (origin) arrive by completely different paths but are the same thing to
 * a reader of this table — a lead nobody closed live. They used to be two
 * separate tabs; the merged table is what pays for that, and its columns are
 * chosen so none of them changes meaning depending on which kind a row is.
 */
type LeadTab = "live" | "manual";

const LEAD_TABS: { id: LeadTab; label: string }[] = [
  { id: "live", label: "Live Submissions" },
  { id: "manual", label: "Manual Submissions" },
];

/**
 * The Manual tab's selection, applied in one place because it is used twice —
 * the paged fetch and the chip's head-count. A chip whose number disagrees
 * with its own table is worse than either being wrong on its own.
 *
 * Two conditions ANDed, not a nested `or(and(...))`: the role test and the
 * origin test are genuinely alternatives (a validator submission is stored
 * `source = 'live'`, so origin alone would miss it), but the
 * `pending_import_approval` exclusion can sit outside the group because only
 * a sheet import is ever in that status — `submit_form_internal` hardcodes
 * 'closed' for a validator's own submission. So excluding it unconditionally
 * hides exactly the rows the nested form would have, while keeping this flat
 * enough to read. Those rows belong to the Pending Imports queue and must
 * appear nowhere else until a batch is accepted.
 */
function applyManualTabFilter<
  T extends { or(filters: string): T; neq(column: string, value: string): T },
>(query: T): T {
  return query
    .or("submitted_by_role.eq.validator,source.eq.sheet")
    .neq("status", "pending_import_approval");
}

/**
 * Which kind of Manual lead a row is — the one thing the merged tab would
 * otherwise lose, since `sourceLabel()` calls both of them "Manual".
 *
 * Reads the role first for the same reason `sourceLabel()` does: a validator
 * submission is `source = 'live'`, so origin alone would file it as an upload.
 */
function manualKind(row: { source?: LeadSource | null; submitted_by_role?: string | null }) {
  return row.submitted_by_role === "validator" ? "Validator" : "Upload";
}

/**
 * The windows the record can be read over, and the queries every figure comes
 * from, both live in `lib/` now — the admin Overview offers the same chips over
 * the same numbers, and a period or a count that means one thing on one
 * dashboard and something else on the other would be worse than having neither.
 * See `lib/period-range.ts` and `lib/overview-stats.ts`.
 */

const SUBMISSIONS_KEY = ["reporting", "submissions"];
const SUBMISSION_COUNTS_KEY = ["reporting", "submission-counts"];

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
 * "Manual" means two things since the Validator and Manual tabs merged, and a
 * search for the word has to find both of them. `source.in.('sheet')` alone
 * misses a validator's own submission, which is stored `source = 'live'` and
 * is only manual by virtue of its role.
 */
function matchesValidatorRole(term: string) {
  return "manual".includes(term) || "validator".includes(term);
}

/**
 * The other half of the Type column.
 *
 * `matchesValidatorRole` above already makes "Validator" findable. "Upload"
 * was not: the word is printed in the Type cell of every imported row, but it
 * appeared in no clause anywhere — not a status, not a disposition, not a
 * source alias — so searching for the thing on screen returned nothing at all.
 *
 * An uploaded lead is exactly `source = 'sheet'` on this tab. The Manual tab
 * admits validator submissions and sheet imports, and `manualKind()` calls
 * everything that is not a validator submission an Upload — confirmed against
 * the live data, where every Upload row is 'sheet' and every Validator row is
 * 'live'.
 *
 * "uploaded" is accepted alongside "upload" so the past tense finds them too;
 * `"upload".includes("uploaded")` is false, so it needs saying separately.
 */
function matchesUploadKind(term: string) {
  return "upload".includes(term) || "uploaded".includes(term);
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
  if (matchesValidatorRole(lower)) clauses.push("submitted_by_role.eq.validator");
  // Harmless on the Live tab, which ANDs `source = 'live'` over this whole
  // group, so the clause can only ever match on Manual where Type is shown.
  if (matchesUploadKind(lower)) clauses.push("source.eq.sheet");
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
  proposed: string,
  final: string,
  dateFrom: string,
  dateTo: string,
) {
  return [
    ...SUBMISSIONS_KEY,
    tab,
    page,
    term,
    archived,
    proposed,
    final,
    dateFrom,
    dateTo,
  ] as const;
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
  const period = usePeriod();
  const { heading } = period;
  const stats = useOverviewStats(period);
  const { validatorStats, centerTotals, totals } = stats;

  const perValidator = useMemo(() => validatorStats.data ?? [], [validatorStats.data]);
  const perCenter = useMemo(() => centerTotals.data ?? [], [centerTotals.data]);
  const totalsRow = totals.data ?? null;

  return (
    <>
      {/* The chips sit ABOVE the panels since 2026-09-18, where they used to
          sit between the queue strip and the totals. The first panel is now
          titled with the window it is showing, and a control that changes a
          heading has to be readable before that heading, not after it.

          The window reaches everything except Operations: "where leads are
          right now" is current state, and scoping it to a past week would
          answer a question nobody asked. Said out loud beside the chips,
          because a filter that silently leaves one panel out is worse than no
          filter. */}
      <PeriodPicker
        period={period}
        note={
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            Live · the window applies to the two panels and the record below
          </span>
        }
      />

      {/* The news, first and largest: what came in, what happened to it, and
          where the open work is sitting. Everything below this is the record.
          The same row the admin Overview and the Closing Desk read — the
          manager used to get the queue strip alone here, without the intake
          and outcome either of those already showed. */}
      <OverviewPanels period={period} stats={stats} centers={perCenter} />

      <TotalsPanel
        row={totalsRow}
        heading={heading}
        showReviewFailures={!showValidatorSubmissions}
      />

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
  const centerColorById = useCenterColorById();
  const [search, setSearch] = useState("");
  // Two boxes, not one, because they are two different questions about a lead:
  // what was pitched, and what it was actually written on. Each becomes its own
  // `or` group, and PostgREST ANDs repeated groups, so filling both narrows to
  // the intersection — "proposed Amicable, written on TransAmerica" is a real
  // slice of the book and now directly askable.
  const [proposedSearch, setProposedSearch] = useState("");
  const [finalSearch, setFinalSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [leadTab, setLeadTab] = useState<LeadTab>("live");
  const [showArchived, setShowArchived] = useState(false);
  // A specific day, or a from/to range. Left blank, nothing is filtered by
  // date at all — the same "unset means no filter" convention the carrier
  // box and the Overview tab's custom range both already use.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // A page number each. The two tabs are separate lists of separate lengths;
  // sharing one would land the reader on an empty page four when they switch.
  const [livePage, setLivePage] = useState(0);
  const [manualPage, setManualPage] = useState(0);

  const term = sanitizeTerm(search);
  // Same sanitiser: this ends up in an `or=` group too, so a comma or a bracket
  // would end the group early exactly as it would in the free-text search.
  const proposedTerm = sanitizeTerm(proposedSearch);
  const finalTerm = sanitizeTerm(finalSearch);
  const carrierFiltered = proposedTerm.length > 0 || finalTerm.length > 0;
  const dateFiltered = dateFrom.length > 0 || dateTo.length > 0;

  // Any of these changes what page 1 even means, so both go back to the start.
  useEffect(() => {
    setLivePage(0);
    setManualPage(0);
  }, [term, proposedTerm, finalTerm, showArchived, leadTab, dateFrom, dateTo]);

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
      queryKey: explorerKey(
        tab,
        page,
        term,
        showArchived,
        proposedTerm,
        finalTerm,
        dateFrom,
        dateTo,
      ),
      enabled: leadTab === tab,
      queryFn: async () => {
        // Resolved first so a person match can join the same `or` as the
        // payload matches: closer_id, uploaded_by and assigned_to are base
        // columns, whereas an embedded profiles filter could not be or-ed
        // with one.
        const profileIds = term ? await matchingProfileIds(term) : [];
        // Same gap, different table: final_carrier_id holds a uuid and the
        // operator types a name, so the text has to become ids first.
        const finalCarrierIds = finalTerm ? await matchingCarrierIds(finalTerm) : [];

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
            "*, closer:profiles!submissions_closer_id_fkey(full_name), uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name), assignee:profiles!submissions_assigned_to_fkey(full_name), timeout_by:profiles!submissions_last_timeout_by_fkey(full_name), rejected_by:profiles!submissions_last_rejected_by_fkey(full_name), final_carrier:carriers!submissions_final_carrier_id_fkey(name)",
            { count: "exact" },
          );

        // Live is an ORIGIN test, not a role one. An imported lead is tagged
        // 'closer' by ingest_sheet_lead and has no closer at all, so without
        // the source test it sat on this tab with an empty Closer column.
        // `source` is NOT NULL and defaults to 'live', so no row is old enough
        // to fall through the split; the role test then lifts out a validator's
        // own submission, which is also stored 'live'. Rows written before that
        // column existed are null and stay here, which is correct — they
        // predate validator self-submission entirely.
        if (tab === "manual") {
          query = applyManualTabFilter(query);
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

        // And a third and fourth, for the same reason: each carrier box narrows
        // whatever the boxes before it matched rather than competing with them.
        // Two SEPARATE groups is the whole point — filling both asks for the
        // intersection ("pitched Amicable, written on TransAmerica"), which one
        // combined group could not express. They run in the database like every
        // other filter here: this table is paged, so a browser-side match would
        // only ever see the twenty-five rows already fetched and would report
        // nothing for a lead on page four.
        if (proposedTerm) query = query.or(proposedCarrierSearchClauses(proposedTerm).join(","));
        if (finalTerm) {
          query = query.or(finalCarrierSearchClauses(finalTerm, finalCarrierIds).join(","));
        }

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

  const liveQuery = useQuery(submissionsQuery("live", livePage));
  const manualQuery = useQuery(submissionsQuery("manual", manualPage));

  /**
   * Both tabs' counts, so a reader sees where the leads are without
   * clicking through each one. Head-count only (`head: true`) — no rows,
   * so this runs for every tab at once without the cost the paginated
   * fetch above deliberately avoids by only running the active tab's.
   * Mirrors the same filter composition `submissionsQuery` uses, so a
   * chip's number always matches what that tab would show if opened.
   */
  const submissionCounts = useQuery({
    queryKey: [
      ...SUBMISSION_COUNTS_KEY,
      term,
      showArchived,
      proposedTerm,
      finalTerm,
      dateFrom,
      dateTo,
    ],
    queryFn: async () => {
      const profileIds = term ? await matchingProfileIds(term) : [];
      const finalCarrierIds = finalTerm ? await matchingCarrierIds(finalTerm) : [];

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
        if (tab === "manual") {
          query = applyManualTabFilter(query);
        } else {
          query = query
            .eq("source", "live")
            .or("submitted_by_role.is.null,submitted_by_role.neq.validator");
        }
        query = showArchived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
        if (term) query = query.or(leadSearchClauses(term, profileIds).join(","));
        if (proposedTerm) query = query.or(proposedCarrierSearchClauses(proposedTerm).join(","));
        if (finalTerm) {
          query = query.or(finalCarrierSearchClauses(finalTerm, finalCarrierIds).join(","));
        }
        if (dateWindow?.since) query = query.gte("created_at", dateWindow.since);
        if (dateWindow?.until) query = query.lt("created_at", dateWindow.until);
        const { count, error } = await query;
        if (error) throw error;
        return count ?? 0;
      }

      const [live, manual] = await Promise.all([countFor("live"), countFor("manual")]);
      return { live, manual } satisfies Record<LeadTab, number>;
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

  const filteredLive = useMemo(() => liveQuery.data?.rows ?? [], [liveQuery.data]);
  const filteredManual = useMemo(() => manualQuery.data?.rows ?? [], [manualQuery.data]);

  // Keyed rather than chained: a Record over the union cannot silently miss a
  // tab, which a ternary chain can.
  const queries: Record<LeadTab, typeof liveQuery> = {
    live: liveQuery,
    manual: manualQuery,
  };
  const paging: Record<LeadTab, { page: number; setPage: (next: number) => void }> = {
    live: { page: livePage, setPage: setLivePage },
    manual: { page: manualPage, setPage: setManualPage },
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
    explorerKey(leadTab, activePage, term, showArchived, proposedTerm, finalTerm, dateFrom, dateTo),
  );
  activeKeyRef.current = explorerKey(
    leadTab,
    activePage,
    term,
    showArchived,
    proposedTerm,
    finalTerm,
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
              // database, so the hint no longer differs between them. "type"
              // earns its place in the list because the Manual tab's Type
              // column is the one thing the merge could have lost, and an
              // unadvertised filter is barely a filter.
              placeholder="Search customer, phone, closer, validator, status, source, type…"
              className="field-input max-w-xs"
              aria-label="Search submissions"
            />
            {/* Two carrier boxes, because they are two different questions:
                what the closer PITCHED, and what the policy was actually
                written on. Each narrows the other, so filling both asks for
                the intersection — "pitched Amicable, written on TransAmerica".
                A proposed carrier only exists on a closer or uploaded lead; a
                validator files its form only after acceptance, so its carrier
                is a final one by definition. */}
            <input
              type="search"
              value={proposedSearch}
              onChange={(event) => setProposedSearch(event.target.value)}
              placeholder="Proposed carrier…"
              className="field-input w-40"
              aria-label="Filter submissions by the carrier the closer proposed"
            />
            <input
              type="search"
              value={finalSearch}
              onChange={(event) => setFinalSearch(event.target.value)}
              placeholder="Final carrier…"
              className="field-input w-40"
              aria-label="Filter submissions by the carrier the policy was written on"
            />
            {carrierFiltered ? (
              <button
                type="button"
                className="chip px-2.5 py-0.5 text-[0.66rem]"
                onClick={() => {
                  setProposedSearch("");
                  setFinalSearch("");
                }}
              >
                Clear carriers
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

        {leadTab === "live" ? (
          <Table>
            <TableHeader>
              <TableRow>
                {/* <TableHead>Source</TableHead> */}
                <TableHead>Center</TableHead>
                <TableHead>Customer</TableHead>
                {/* <TableHead>Carrier Name</TableHead> */}
                <TableHead>Closer</TableHead>
                <TableHead>Validator</TableHead>
                <TableHead>Application Date</TableHead>
                <TableHead>Validation Status</TableHead>
                <TableHead>Disposition</TableHead>
                {showArchived ? <TableHead className="text-right">Action</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredLive.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                  {/* <TableCell>
                    <OriginBadge row={row} />
                  </TableCell> */}
                  {/* The stamped name, not a join: a lead keeps the centre it
                      was taken in even after that centre is renamed or the
                      closer is moved to another one. */}
                  <TableCell>
                    <CenterBadge
                      name={row.center_name}
                      color={row.center_id ? centerColorById.get(row.center_id) : null}
                    />
                  </TableCell>
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
              {filteredLive.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={showArchived ? 10 : 9}
                    className="text-center text-muted-foreground"
                  >
                    {liveQuery.isLoading ? "Loading…" : "No submissions match that search."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        ) : (
          /* Two kinds of lead in one table, so every column here answers the
             same question for both of them. The two that could not — Source,
             which `sourceLabel()` reads as "Manual" for either kind, and
             Validator, which meant the AUTHOR of a validator submission but
             the ASSIGNEE of an uploaded one — are gone: Type says which kind a
             row is, and the author/assignee split is now two honest columns. */
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Center</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Final Carrier</TableHead>
                <TableHead>Submitted By</TableHead>
                <TableHead>Validated By</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Validation Status</TableHead>
                <TableHead>Disposition</TableHead>
                {showArchived ? <TableHead className="text-right">Action</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredManual.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                  {/* Styled like the Source badge it replaces, because it sits
                      where that column used to and does the same job of saying
                      where a row came from — only now it distinguishes the two
                      kinds that share this tab instead of labelling both
                      "Manual". */}
                  <TableCell>
                    <Badge variant="outline" className="border-border text-muted-foreground">
                      {manualKind(row)}
                    </Badge>
                  </TableCell>
                  {/* The stamped name, not a join — see the Live tab's own
                      Center column above for why. Blank on a validator
                      submission from before validators were assigned centres;
                      stamped from their profile on every one since. */}
                  <TableCell>
                    <CenterBadge
                      name={row.center_name}
                      color={row.center_id ? centerColorById.get(row.center_id) : null}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                  {/* The carrier the policy was actually written on, from the
                      FK for an uploaded lead and from "Agency" for a
                      validator's own — finalCarrierName() resolves both. A dash
                      means not yet determined, never "look at the proposal
                      instead". */}
                  <TableCell className="text-muted-foreground">
                    {finalCarrierName(row) ?? "—"}
                  </TableCell>
                  {/* The uploading centre for an imported lead, the validator
                      themselves for one they typed — closerName() already
                      resolves both off `source`, so one column covers it. */}
                  <TableCell className="text-muted-foreground">{closerName(row)}</TableCell>
                  {/* Empty on a validator submission, and that is the fact
                      rather than a gap: it auto-accepts on submit and is never
                      assigned to anyone. */}
                  <TableCell className="text-muted-foreground">
                    {row.assignee?.full_name ?? "—"}
                  </TableCell>
                  {/* Absolute, not "3d ago": for an uploaded lead this is the
                      date the file arrived, which an operator reconciles
                      against the spreadsheet they sent. */}
                  <TableCell className="text-muted-foreground">
                    {formatDate(row.created_at)}
                  </TableCell>
                  {/* Both read "Completed"/"Submit" on every validator row —
                      the real stored values, since submit_form_internal closes
                      and accepts one on submit. Left as they are rather than
                      blanked: the detail sheet shows the same thing, and a
                      dash here would contradict it. */}
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
              {filteredManual.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={showArchived ? 10 : 9}
                    className="text-center text-muted-foreground"
                  >
                    {manualQuery.isLoading ? "Loading…" : "No submissions match that search."}
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

      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) {
            setOpenId(null);
            setHistoryOpen(false);
          }
        }}
      >
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

                {/* The validation timeline now lives in the dedicated history
                    dialog — squeezed inline here, a lead with real history
                    made this sheet scroll a long way in a column too narrow
                    to read comfortably. `seconds` is the one thing Reporting
                    needs of its own: its events can land inside the same
                    minute and the order is the point. */}
                <button
                  type="button"
                  className="chip w-full justify-center gap-1.5"
                  onClick={() => setHistoryOpen(true)}
                >
                  <History className="h-3.5 w-3.5" aria-hidden />
                  View History
                </button>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <LeadHistoryDialog
        submissionId={selected?.id ?? null}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        customerName={selected ? customerName(selected.payload) : null}
        showCxLifecycle={false}
        seconds
      />
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

/**
 * The record for the selected window.
 *
 * Its tiles say exactly what the panels above it say, in the same words and
 * with the same arithmetic — **Live** and **Manual**, where Manual is uploads
 * plus validator submissions. It briefly did not: while the panels were merging
 * the two and this strip was not, the manager's screen printed "Manual 243" and
 * "Manual 41" one above the other, which is worse than either figure being
 * wrong on its own.
 *
 * `showReviewFailures` is the only difference left between the two dashboards.
 * Timeouts and rejections are the review desk's own failures, and they belong
 * on the screen of the person who can do something about them; the admin
 * Overview reads them from the Validators table instead.
 */
export function TotalsPanel({
  row,
  heading,
  showReviewFailures = false,
}: {
  row: OverviewTotalsRow | null;
  heading: string;
  showReviewFailures?: boolean;
}) {
  return (
    <section className="panel">
      <h2 className="panel-title">{heading}</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <Total label="Live" value={row?.closer_submissions} />
        {/* Uploads plus validator submissions — everything nobody closed live.
            The uploaded half counts `source = 'sheet'` excluding
            `pending_import_approval`, which is the same rule the Manual
            Submissions tab uses, so a batch contributes nothing here until it
            is approved and there is no client-side condition to keep in step
            with it. */}
        <Total
          label="Manual"
          value={(row?.offline_submissions ?? 0) + (row?.validator_submissions ?? 0)}
        />
        {/* `_all`: the bare columns count live leads only — see the migration
            20260918160000_all_origin_totals.sql. */}
        <Total label={dispositionLabel("accepted")} value={row?.approved_all} />
        <Total label={dispositionLabel("declined")} value={row?.declined_all} tone="destructive" />
        {showReviewFailures ? (
          <>
            <Total label="Timeouts" value={row?.timeouts} tone="destructive" />
            <Total label="Rejections" value={row?.rejections} tone="destructive" />
          </>
        ) : null}
      </dl>
    </section>
  );
}

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
  /** A node, not a string, so a caller can pass `dispositionLabel(...)`
   *  straight through rather than restating a word the app already spells. */
  label: ReactNode;
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
