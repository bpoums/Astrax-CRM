import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  DispositionBadge,
  OriginBadge,
  QueueStatusBadge,
  closerName,
  customerName,
  dataFlags,
  dispositionLabel,
  eventLabel,
  isOnHold,
  relativeTime,
  shortDate,
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
import { DataFlagList } from "@/components/data-flags";
import { LeadPayload } from "@/components/lead-editor";
import { PayloadEditHistory, payloadHistoryKey } from "@/components/payload-history";
import { CarrierDeclineList } from "@/components/carrier-declines";
import { useDeclinedCarrierMap } from "@/lib/carriers";
import {
  LEAD_PAGE_SIZE,
  matchingProfileIds,
  payloadSearchClauses,
  personSearchClauses,
  sanitizeTerm,
} from "@/lib/lead-search";
import { PaginationBar } from "@/components/pagination-bar";
import { useAuth } from "@/lib/auth";
import { ClampedText } from "@/components/free-text";
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
  submitted_by_role: "closer" | "validator" | null;
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

type TimelineEvent = {
  id: number;
  event_type: string;
  created_at: string;
  actor_id: string | null;
  detail: Record<string, unknown> | null;
  actor: { full_name: string | null } | null;
};

const SUBMISSIONS_KEY = ["reporting", "submissions"];
const TOTALS_KEY = ["reporting", "totals"];
const VALIDATOR_STATS_KEY = ["reporting", "validator-stats"];
const CENTER_TOTALS_KEY = ["reporting", "center-totals"];
const ON_HOLD_KEY = ["reporting", "on-hold"];

/**
 * Held and rejected events number themselves, claimed events number the
 * attempt, and a rejection may carry the reason the validator typed.
 */
function eventCounter(event: TimelineEvent) {
  const detail = event.detail ?? {};
  const holdNumber = detail["hold_number"];
  const rejectionNumber = detail["rejection_number"];
  const attempt = detail["attempt"];
  if (event.event_type === "held" && typeof holdNumber === "number") return `#${holdNumber}`;
  if (event.event_type === "rejected" && typeof rejectionNumber === "number")
    return `#${rejectionNumber}`;
  if (event.event_type === "claimed" && typeof attempt === "number") return `attempt ${attempt}`;
  return null;
}

function eventReason(event: TimelineEvent) {
  const reason = (event.detail ?? {})["reason"];
  return typeof reason === "string" && reason.trim() ? reason : null;
}

function eventTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

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
  if ("offline".includes(term) || "sheet".includes(term)) out.push("sheet");
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
function explorerKey(tab: LeadTab, page: number, term: string, archived: boolean) {
  return [...SUBMISSIONS_KEY, tab, page, term, archived] as const;
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

  const validatorStats = useQuery({
    queryKey: VALIDATOR_STATS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("validator_stats")
        .select(
          "validator_id, validator_name, assigned, approved, declined, rejected, timed_out, holds",
        )
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
    queryKey: CENTER_TOTALS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submission_totals_by_center")
        .select(
          "center_id, center_name, total_submissions, approved, declined, pending, awaiting_manager",
        )
        .order("sort_order", { ascending: true })
        .order("center_name", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const totals = useQuery({
    queryKey: TOTALS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submission_totals")
        .select(
          "closer_submissions, validator_submissions, offline_submissions, approved, declined, in_review, timeouts, rejections",
        )
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  /**
   * How many leads are sitting on a hold right now.
   *
   * `submission_totals` cannot answer this: being on hold is a shape across
   * four columns, and the last of its conditions — `last_held_at` newer than
   * `assigned_at` — is a column-to-column comparison PostgREST has no filter
   * for. So the query narrows to the candidates it CAN express and the last
   * condition is applied here, over a handful of rows, rather than published as
   * an over-count.
   */
  const onHold = useQuery({
    queryKey: ON_HOLD_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("status, claimed_at, assigned_at, last_held_at")
        .eq("status", "assigned")
        .is("claimed_at", null)
        .not("last_held_at", "is", null)
        .is("archived_at", null);
      if (error) throw error;
      return (data ?? []).filter(isOnHold).length;
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
  const totalsRow = totals.data ?? null;

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-8">
        <StatCard label="Closer Submissions" value={totalsRow?.closer_submissions} />
        {/* Uploaded leads that a manager has accepted. The view counts
            `source = 'sheet'` excluding `pending_import_approval`, which is the
            same rule the Offline Submissions tab uses — so a batch contributes
            nothing here until it is approved, and there is no client-side
            condition to keep in step with it. */}
        <StatCard label="Manual Submissions" value={totalsRow?.offline_submissions} />
        <StatCard label="Submitted" value={totalsRow?.approved} />
        <StatCard label="Declined" value={totalsRow?.declined} tone="destructive" />
        <StatCard label="On Hold" value={onHold.data} tone="accent" />
        <StatCard label="In Review" value={totalsRow?.in_review} tone="accent" />
        {showValidatorSubmissions ? null : (
          <>
            <StatCard label="Timeouts" value={totalsRow?.timeouts} tone="destructive" />
            <StatCard label="Rejections" value={totalsRow?.rejections} tone="destructive" />
          </>
        )}
      </section>

      {/* Validator submissions are self-entered and auto-approved, so they are
          kept apart from the review outcomes above rather than mixed in. */}
      {showValidatorSubmissions ? (
        <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <StatCard label="Validator Submissions" value={totalsRow?.validator_submissions} />
        </section>
      ) : null}

      {/* Same panel-and-table shape as the validator dashboard below rather
          than a third pattern: a name, then right-aligned tabular columns.
          Gated on the same flag the neighbouring cards are — this is the admin
          Overview's picture, and the manager's Reporting tab shows the queue
          it works rather than a breakdown of the whole business. */}
      {showValidatorSubmissions ? (
        <section className="panel">
          <h2 className="panel-title">Leads by Center ({perCenter.length})</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Center</TableHead>
                <TableHead className="text-right">Submissions</TableHead>
                {/* <TableHead className="text-right">Submitted</TableHead>
                <TableHead className="text-right">Declined</TableHead>
                <TableHead className="text-right">Pending</TableHead> */}
                {/* The queue's own word for pending_manager, read from the one
                    place it is spelled. */}
                {/* <TableHead className="text-right">{STATUS_LABEL.pending_manager}</TableHead> */}
              </TableRow>
            </TableHeader>
            <TableBody>
              {perCenter.map((center) => (
                <TableRow key={center.center_id ?? center.center_name}>
                  <TableCell className="font-medium">{center.center_name ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {center.total_submissions ?? 0}
                  </TableCell>
                  {/* <TableCell className="text-right tabular-nums">{center.approved ?? 0}</TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${
                      (center.declined ?? 0) > 0 ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {center.declined ?? 0}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {center.pending ?? 0}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {center.awaiting_manager ?? 0}
                  </TableCell> */}
                </TableRow>
              ))}
              {perCenter.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {centerTotals.isLoading
                      ? "Loading…"
                      : centerTotals.isError
                        ? (centerTotals.error as Error).message
                        : "No active centers."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {showValidatorSubmissions ? null : (
        <>
          <section className="panel">
            <h2 className="panel-title">Validators Team Dashboard ({perValidator.length})</h2>
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [leadTab, setLeadTab] = useState<LeadTab>("closer");
  const [showArchived, setShowArchived] = useState(false);
  // A page number each. The three tabs are separate lists of separate lengths;
  // sharing one would land the reader on an empty page four when they switch.
  const [closerPage, setCloserPage] = useState(0);
  const [validatorPage, setValidatorPage] = useState(0);
  const [offlinePage, setOfflinePage] = useState(0);

  const term = sanitizeTerm(search);

  // Any of these changes what page 1 even means, so all three go back to the start.
  useEffect(() => {
    setCloserPage(0);
    setValidatorPage(0);
    setOfflinePage(0);
  }, [term, showArchived, leadTab]);

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
      queryKey: explorerKey(tab, page, term, showArchived),
      enabled: leadTab === tab,
      queryFn: async () => {
        // Resolved first so a person match can join the same `or` as the
        // payload matches: closer_id, uploaded_by and assigned_to are base
        // columns, whereas an embedded profiles filter could not be or-ed
        // with one.
        const profileIds = term ? await matchingProfileIds(term) : [];

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
   * Spelled once on purpose. The Offline tab used to render a bare
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

  const timeline = useQuery({
    queryKey: ["reporting", "timeline", openId],
    enabled: !!openId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("form_events")
        .select(
          "id, event_type, created_at, actor_id, detail, actor:profiles!form_events_actor_id_fkey(full_name)",
        )
        .eq("submission_id", openId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as TimelineEvent[];
    },
  });

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
  const activeLabel = LEAD_TABS.find((tab) => tab.id === leadTab)?.label ?? "";

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
  const activeKeyRef = useRef(explorerKey(leadTab, activePage, term, showArchived));
  activeKeyRef.current = explorerKey(leadTab, activePage, term, showArchived);

  useEffect(() => {
    const channel = supabase
      .channel("reporting-submissions")
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, () => {
        // Just the page being looked at. Retiring every cached page would send
        // the browser back for pages nobody is reading.
        queryClient.invalidateQueries({ queryKey: activeKeyRef.current });
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
          <h2 className="panel-title">
            {activeLabel} ({visibleCount})
          </h2>
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
              {tab.label}
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
                  <TableCell className="text-muted-foreground">{closerName(row)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.assignee?.full_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {/* {relativeTime(row.created_at, now)} */}
                    {shortDate(row.created_at)}
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
                    colSpan={showArchived ? 9 : 8}
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
                <TableHead>Validator</TableHead>
                <TableHead>Submitted</TableHead>
                {showArchived ? <TableHead className="text-right">Action</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredValidator.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                  <TableCell className="text-muted-foreground">{closerName(row)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {/* {relativeTime(row.created_at, now)} */}
                    {shortDate(row.created_at)}
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
                    colSpan={showArchived ? 4 : 3}
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
                  {/* Every row here is offline, so the badge earns its place by
                      naming WHICH centre supplied the lead — org_name, or the
                      uploader's own name where the account has none. */}
                  <TableCell>
                    <OriginBadge row={row} />
                  </TableCell>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
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
                    {shortDate(row.created_at)}
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
                    colSpan={showArchived ? 7 : 6}
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

                <div className="flex flex-col gap-2">
                  <h3 className="panel-title">Timeline</h3>
                  <ol className="divide-y divide-border rounded-md border border-border">
                    {(timeline.data ?? []).map((event) => (
                      <li
                        key={event.id}
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-2 px-3 py-1.5"
                      >
                        <span className="field-label">
                          {eventLabel(event.event_type)}
                          {eventCounter(event) ? (
                            <span className="ml-1 normal-case tracking-normal text-accent">
                              {eventCounter(event)}
                            </span>
                          ) : null}
                        </span>
                        <span className="min-w-0 text-xs text-muted-foreground">
                          <span className="text-foreground">
                            {event.actor?.full_name ?? "system"}
                          </span>{" "}
                          · {eventTime(event.created_at)}
                          {eventReason(event) ? (
                            <ClampedText
                              text={eventReason(event) ?? ""}
                              heading={eventLabel(event.event_type)}
                              meta={`${event.actor?.full_name ?? "system"} · ${eventTime(event.created_at)}`}
                              className="italic"
                            />
                          ) : null}
                        </span>
                      </li>
                    ))}
                    {(timeline.data ?? []).length === 0 ? (
                      <li className="px-3 py-1.5 text-xs text-muted-foreground">
                        {timeline.isLoading ? "Loading…" : "No events recorded."}
                      </li>
                    ) : null}
                  </ol>
                </div>
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
function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null | undefined;
  tone?: "accent" | "destructive";
}) {
  const valueClass =
    tone === "destructive" ? "text-destructive" : tone === "accent" ? "text-primary" : "";
  return (
    <div className="panel gap-1">
      <span className="panel-title">{label}</span>
      <span className={`font-display text-3xl font-semibold tabular-nums ${valueClass}`}>
        {value ?? 0}
      </span>
    </div>
  );
}
