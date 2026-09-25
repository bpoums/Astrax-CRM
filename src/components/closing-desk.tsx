import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  CenterBadge,
  DISPOSITIONS,
  DispositionBadge,
  QueueStatusBadge,
  STATUS_LABEL,
  SUB_STATUSES,
  StatusBadge,
  closerName,
  customerName,
  dispositionLabel,
  OriginBadge,
  isOnHold,
  sourceLabel,
  type Disposition,
  type LeadSource,
  type SubStatus,
  type UploaderRef,
} from "@/components/ops";
import { formatDate } from "@/lib/format-date";
import { CxLeadStatusValue } from "@/components/cx-status-cell";
import { validationTimelineKey } from "@/components/validation-timeline";
import { LeadHistoryDialog } from "@/components/lead-history-dialog";
import { History } from "lucide-react";
import { PayloadEditor } from "@/components/payload-editor";
import { ValidatorFields } from "@/components/validator-fields";
import { PayloadEditHistory, payloadHistoryKey } from "@/components/payload-history";
import { PaymentPanel } from "@/components/payment-panel";
import { SubmissionTags } from "@/components/submission-tags";
import { PaginationBar } from "@/components/pagination-bar";
import {
  CATEGORY_LABEL,
  CX_CATEGORIES,
  CX_LEAD_STATUS_FK,
  CX_LEAD_STATUS_SELECT,
  useCxStatusOptions,
  type CxCategory,
  type CxLeadStatus,
} from "@/lib/cx-status";
import { useDeclinedCarrierMap } from "@/lib/carriers";
import { useCenterColorById, useCenters } from "@/lib/centers";
import { useAuth } from "@/lib/auth";
import {
  LEAD_PAGE_SIZE,
  matchingProfileIds,
  payloadSearchClauses,
  personSearchClauses,
  sanitizeTerm,
} from "@/lib/lead-search";
import { Tooltip, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipBody, TooltipHeading } from "@/components/free-text";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The closing desk: every lead the reader is entitled to, at whatever stage it
 * has reached, with the payload editable in place.
 *
 * The row set is NOT scoped here. The `submissions` read policy decides it —
 * a closing manager sees `submitted_by_role = 'closer'` within their own
 * centre, a general manager sees closer and validator work across all of them —
 * so re-stating any of that in the query would duplicate a rule that lives in
 * one place, and would quietly diverge the day the policy changes.
 *
 * The Submitted By filter is not that. It is the reader narrowing what they
 * asked for, applied on top of whatever they are allowed to see, and it is the
 * same control for both roles: a closing manager who picks Validator gets an
 * empty table, which is the truth about their access, not a broken screen.
 *
 * Unlike the CX pipeline this cannot read `cx_pipeline`, which carries its own
 * `disposition = 'accepted'` and so holds only the tail of what belongs here.
 * The statuses come off `cx_lead_status` instead, which stores option ids, and
 * the labels and tones are resolved against the vocabulary fetched once for the
 * whole table.
 *
 * Those statuses are read-only throughout. Moving a lead through the customer
 * lifecycle is the CXA's job, `set_cx_status` refuses anyone outside the CX
 * roles, and offering a control that always fails is worse than offering none.
 */

const PAGE_SIZE = LEAD_PAGE_SIZE;

/** The payload keys the search box spans. The closer is matched by name too. */
/** A filter is "any", "none" (not set / not disposed), or a specific value. */
const ANY = "any";
const NOT_SET = "none";

const BASE_SELECT = [
  "id",
  "payload",
  "status",
  "disposition",
  // Only the badge chain reads these three: a returned lead has to be told
  // apart from one nobody has picked up, and both of those name a person.
  "rejection_count",
  "timeout_by:profiles!submissions_last_timeout_by_fkey(full_name)",
  "rejected_by:profiles!submissions_last_rejected_by_fkey(full_name)",
  "created_at",
  // Set by dispose_submission every time a validator (or a manager/admin)
  // records an outcome. Null until then — distinct from created_at, which
  // is stamped once at the original closer/validator submission.
  "disposed_at",
  "source",
  // The review's own outcome, shown and edited in the ValidatorFields section.
  "submitted_by_role",
  "final_carrier_id",
  "agent_name",
  "policy_number",
  // The stamped name, not a join — see `centers.ts`. Constant down the column
  // for a closing manager, who is scoped to one centre; the useful part of the
  // row for a general manager, whose rows span all of them. center_id rides
  // alongside it only to look up the center's current badge color — the
  // color is live/current, unlike the name, which stays a point-in-time
  // snapshot even if the center is later renamed.
  "center_name",
  "center_id",
  "closer_id",
  // Not shown as columns of their own — they are what isOnHold() reads to tell
  // a held lead from a merely assigned one.
  "claimed_at",
  "assigned_at",
  "last_held_at",
  "closer:profiles!submissions_closer_id_fkey(full_name)",
  "uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name)",
  CX_LEAD_STATUS_SELECT,
].join(", ");

type ClosingRow = {
  id: string;
  payload: Record<string, unknown>;
  status: SubStatus;
  disposition: Disposition | null;
  rejection_count: number;
  timeout_by: { full_name: string | null } | null;
  rejected_by: { full_name: string | null } | null;
  created_at: string;
  disposed_at: string | null;
  source: LeadSource;
  submitted_by_role: "closer" | "validator" | null;
  final_carrier_id: string | null;
  agent_name: string | null;
  policy_number: string | null;
  center_name: string | null;
  center_id: string | null;
  closer_id: string | null;
  claimed_at: string | null;
  assigned_at: string | null;
  last_held_at: string | null;
  closer: { full_name: string | null } | null;
  uploader: UploaderRef;
  /** Null until the CX team touches the lead at all. */
  cx: CxLeadStatus | null;
};

/**
 * Validation status is never null, so it has no "not set". Disposition is null
 * for every lead still in flight, which is the single most useful thing to
 * filter on, so it has one and calls it "Not disposed".
 */
type StatusFilter = typeof ANY | SubStatus;
type DispositionFilter = typeof ANY | typeof NOT_SET | Disposition;
/** A centre id, or neither. Ids rather than names: a rename must not silently
 *  empty a filter someone has left applied. */
type CenterFilter = typeof ANY | typeof NOT_SET | string;

/**
 * Which form a lead arrived on — the coarsest cut this desk offers, and the one
 * a general manager needs most: they see closer and validator work in the same
 * table, and most questions are about one or the other.
 *
 * Split by ORIGIN, not by the role tag alone, because the role tag does not
 * separate them cleanly. `ingest_sheet_lead` writes an imported lead with
 * `submitted_by_role = 'closer'` and no closer at all, so filtering on the role
 * by itself files every uploaded lead under Closer with an empty Closer column.
 * `source` is NOT NULL and defaults to 'live', and a row written before the
 * role column existed has a null role rather than a wrong one — so the three
 * tests below cover every row exactly once. This is the same split, and the
 * same wording, as the Reporting lead tabs; the two are meant to agree.
 */
const ORIGINS = ["closer", "validator", "manual"] as const;

type Origin = (typeof ORIGINS)[number];
type OriginFilter = typeof ANY | Origin;

const ORIGIN_LABEL: Record<Origin, string> = {
  closer: "Closer",
  validator: "Validator",
  manual: "Manual",
};

type CxFilters = Record<CxCategory, string>;

const NO_CX_FILTERS: CxFilters = {
  policy: ANY,
  premium: ANY,
  commission: ANY,
  chargeback: ANY,
};

const UNFILTERED_CX = CX_CATEGORIES.map(() => ANY).join("|");

export function ClosingDesk() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  /**
   * Fail-closed, and said out loud.
   *
   * The read policy matches a closing manager's `center_id` against each lead's,
   * and a null one matches nothing — so an unassigned desk is empty in exactly
   * the same way a quiet morning is. This does not filter anything; it only
   * tells the two apart in the empty row, which is the difference between
   * waiting and raising a ticket.
   */
  const noCenter = profile?.role === "closing_manager" && !profile.center_id;
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState<OriginFilter>(ANY);
  const [status, setStatus] = useState<StatusFilter>(ANY);
  const [disposition, setDisposition] = useState<DispositionFilter>(ANY);
  const [center, setCenter] = useState<CenterFilter>(ANY);
  const [cxFilters, setCxFilters] = useState<CxFilters>(NO_CX_FILTERS);
  // A specific day, or a from/to range, over the Submitted column. Left blank,
  // nothing is filtered by date at all — the same "unset means no filter"
  // convention every other filter on this screen already uses.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // The whole vocabulary in one fetch, deactivated options included: a lead can
  // still be sitting on a status that has since been retired, and rendering it
  // as an unresolved blank would be a lie. The dropdowns offer the active ones.
  const vocabulary = useCxStatusOptions(false);
  const { byCategory, byId } = vocabulary;

  // Retired centres included, for the same reason the CX vocabulary is fetched
  // whole: leads already stamped with one are still on this desk, and a filter
  // that cannot name them could not find them.
  const centers = useCenters(false);
  const centerColorById = useCenterColorById();

  const term = sanitizeTerm(search);
  const cxKey = CX_CATEGORIES.map((category) => cxFilters[category]).join("|");

  // A filter or a search changes what page 1 even means.
  useEffect(() => {
    setPage(0);
  }, [term, origin, status, disposition, center, cxKey, dateFrom, dateTo]);

  // Names the carriers on a returned lead. The view holds only leads that have
  // been declined at least once, so it stays short whatever this page shows.
  const declinedMap = useDeclinedCarrierMap();

  const leads = useQuery({
    queryKey: [
      "closing",
      "leads",
      page,
      term,
      origin,
      status,
      disposition,
      center,
      cxKey,
      dateFrom,
      dateTo,
    ],
    queryFn: async () => {
      // Resolved before the main query so a person match can be folded into
      // the same `or` as the payload matches: closer_id and uploaded_by are
      // base columns, whereas an embedded profiles filter could not be or-ed
      // with one. One lookup covers both — a term matches a profile by its name
      // or by its centre, and the row is kept if either column points at it.
      const profileIds = term ? await matchingProfileIds(term) : [];

      // The boundaries come from the database, not from the browser. Pacific
      // day maths has to stay server-side — a hardcoded JS offset is wrong for
      // roughly half the year once DST moves — and this is the same RPC the
      // Reporting date filter calls, so a "today" here and a "today" there can
      // never disagree about where midnight falls. A blank To filters exactly
      // the single day named in From.
      let dateWindow: { since: string | null; until: string | null } | null = null;
      if (dateFrom) {
        const { data, error } = await supabase
          .rpc("reporting_window", { p_start_date: dateFrom, p_end_date: dateTo || dateFrom })
          .single();
        if (error) throw error;
        dateWindow = data;
      }

      // Each concrete status filter goes on one shared inner join, which ANDs
      // them correctly. "Not set" cannot: it needs rows with no matching CX row
      // at all, so it gets its own left join per category, filtered down to the
      // rows where that category IS set and then kept only where that join came
      // back empty. Aliasing keeps the two kinds from interfering.
      const setFilters = CX_CATEGORIES.flatMap((category) => {
        const value = cxFilters[category];
        if (value === ANY || value === NOT_SET) return [];
        const option = byCategory[category].find((entry) => entry.code === value);
        return option ? [{ category, optionId: option.id }] : [];
      });
      const unsetFilters = CX_CATEGORIES.filter((category) => cxFilters[category] === NOT_SET);

      const select = [BASE_SELECT];
      if (setFilters.length > 0) select.push(`setf:${CX_LEAD_STATUS_FK}!inner(submission_id)`);
      for (const category of unsetFilters)
        select.push(`no_${category}:${CX_LEAD_STATUS_FK}(submission_id)`);

      let query = supabase.from("submissions").select(select.join(", "), { count: "exact" });

      // Anything not tagged 'validator' is closer work, which is what keeps
      // rows written before the column existed on the Closer side rather than
      // dropping them out of every option.
      if (origin === "validator") query = query.eq("submitted_by_role", "validator");
      else if (origin === "manual") query = query.eq("source", "sheet");
      else if (origin === "closer")
        query = query
          .eq("source", "live")
          .or("submitted_by_role.is.null,submitted_by_role.neq.validator");

      if (status !== ANY) query = query.eq("status", status);
      if (disposition === NOT_SET) query = query.is("disposition", null);
      else if (disposition !== ANY) query = query.eq("disposition", disposition);

      // `center_id`, not the stamped name: the id is what a renamed centre
      // keeps. The name is only ever what the column renders.
      if (center === NOT_SET) query = query.is("center_id", null);
      else if (center !== ANY) query = query.eq("center_id", center);

      for (const filter of setFilters) {
        query = query.eq(`setf.${filter.category}_status_id`, filter.optionId);
      }
      for (const category of unsetFilters) {
        query = query
          .not(`no_${category}.${category}_status_id`, "is", null)
          .is(`no_${category}`, null);
      }

      if (term) {
        const clauses = [
          ...payloadSearchClauses(term),
          ...personSearchClauses(["closer_id", "uploaded_by"], profileIds),
        ];
        query = query.or(clauses.join(","));
      }

      // Independent of everything above: narrows whatever the other filters
      // already matched rather than competing with them. Runs in the database
      // like every filter here — this table is paged, so a browser-side match
      // would only ever see the rows already fetched and would report nothing
      // for a lead on page four.
      if (dateWindow?.since) query = query.gte("created_at", dateWindow.since);
      if (dateWindow?.until) query = query.lt("created_at", dateWindow.until);

      const from = page * PAGE_SIZE;
      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as unknown as ClosingRow[], total: count ?? 0 };
    },
  });

  const rows = useMemo(() => leads.data?.rows ?? [], [leads.data]);
  const total = leads.data?.total ?? 0;
  const selected = rows.find((row) => row.id === openId) ?? null;

  // An edit changes the Customer column and adds an entry to both trails.
  const onEdited = () => {
    queryClient.invalidateQueries({ queryKey: ["closing", "leads"] });
    queryClient.invalidateQueries({ queryKey: payloadHistoryKey(openId) });
    queryClient.invalidateQueries({ queryKey: validationTimelineKey(openId) });
  };

  const filtersActive =
    term !== "" ||
    origin !== ANY ||
    status !== ANY ||
    disposition !== ANY ||
    center !== ANY ||
    cxKey !== UNFILTERED_CX ||
    dateFrom !== "" ||
    dateTo !== "";

  function clearFilters() {
    setSearch("");
    setOrigin(ANY);
    setStatus(ANY);
    setDisposition(ANY);
    setCenter(ANY);
    setCxFilters(NO_CX_FILTERS);
    setDateFrom("");
    setDateTo("");
  }

  return (
    // One provider for the table and the detail sheet alike. 120ms instead of
    // the browser's ~1s title delay, so a hover reads as instant.
    <TooltipProvider delayDuration={120} skipDelayDuration={300}>
      <section className="panel">
        {/* Named after what is actually in the table. This desk used to say
            "Closer Leads" unconditionally, which stopped being true the day a
            general manager could see validator work in it. Derived from the
            filter rather than from the reader's role — the table shows what the
            database returned, and the heading says which slice of it. */}
        <h2 className="panel-title">
          {origin === ANY ? "Leads" : `${ORIGIN_LABEL[origin]} Leads`} ({total})
        </h2>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect
            label="Submitted By"
            value={origin}
            onChange={setOrigin}
            options={ORIGINS.map((value) => ({ value, label: ORIGIN_LABEL[value] }))}
          />
          <FilterSelect
            label="Validation Status"
            value={status}
            onChange={setStatus}
            /* A submitted form never enters import approval — that gate is
               for uploaded rows, and they are reviewed in Pending Imports, not
               here. Offering it would be a filter that always returns nothing. */
            options={SUB_STATUSES.filter((value) => value !== "pending_import_approval").map(
              (value) => ({ value, label: STATUS_LABEL[value] }),
            )}
          />
          <FilterSelect
            label="Disposition"
            value={disposition}
            onChange={setDisposition}
            notSet="Not disposed"
            options={DISPOSITIONS.map((value) => ({
              // Never spelled here: 'accepted' reads as "Submit", and
              // DISPOSITION_LABEL is the only place that is decided.
              value,
              label: dispositionLabel(value) ?? value,
            }))}
          />
          <FilterSelect
            label="Center"
            value={center}
            onChange={setCenter}
            notSet="No center"
            options={(centers.data ?? []).map((entry) => ({
              value: entry.id,
              label: entry.active ? entry.name : `${entry.name} (inactive)`,
            }))}
          />
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {CX_CATEGORIES.map((category) => (
            <FilterSelect
              key={category}
              label={CATEGORY_LABEL[category]}
              value={cxFilters[category]}
              onChange={(value) => setCxFilters((current) => ({ ...current, [category]: value }))}
              notSet="Not set"
              options={byCategory[category]
                .filter((option) => option.active)
                .map((option) => ({ value: option.code, label: option.label }))}
            />
          ))}
        </div>

        {/* Directly above the table it filters, spanning it. */}
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search customer, closer, phone…"
            className="field-input flex-1"
            aria-label="Search closer leads"
          />
          {/* Its own pair rather than another word in the search box: a date
              range is a different kind of question, and this narrows whatever
              the boxes above already matched. Leaving "To" blank filters
              exactly the one day named in "From". */}
          <input
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
            aria-label="Submitted from date"
            className="field-input w-36 shrink-0"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
            aria-label="Submitted to date (optional — leave blank for a single day)"
            className="field-input w-36 shrink-0"
          />
          {filtersActive ? (
            <button
              type="button"
              className="chip shrink-0 px-2.5 py-0.5 text-[0.66rem]"
              onClick={clearFilters}
            >
              Clear filters
            </button>
          ) : null}
        </div>

        {/* Fixed layout, so the declared widths hold and the cells truncate to
            their column instead of stretching it. The min-width makes the panel
            scroll sideways on a narrow screen rather than squeezing them. */}
        <Table className="min-w-[100rem] table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Center</TableHead>
              {/* No width: Customer absorbs whatever the others leave. */}
              <TableHead className="w-32">Customer</TableHead>
              <TableHead className="w-32">Submitted By</TableHead>
              <TableHead className="w-28">Source</TableHead>
              <TableHead className="w-28">SaleMade On</TableHead>
              <TableHead className="w-55">Validation Status</TableHead>
              <TableHead className="w-28">Submitted On</TableHead>
              <TableHead className="w-24">Disposition</TableHead>
              {CX_CATEGORIES.map((category) => (
                <TableHead key={category} className="w-40">
                  {CATEGORY_LABEL[category]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const name = customerName(row.payload);
              const closer = closerName(row);
              return (
                <TableRow
                  key={row.id}
                  className="cursor-pointer align-top"
                  onClick={() => setOpenId(row.id)}
                >
                  <TableCell className="truncate" title={row.center_name ?? undefined}>
                    <CenterBadge
                      name={row.center_name}
                      color={row.center_id ? centerColorById.get(row.center_id) : null}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="free-text block max-w-full truncate">{name}</span>
                      </TooltipTrigger>
                      <TooltipBody>
                        <TooltipHeading>{name}</TooltipHeading>
                        <span className="free-text text-[0.62rem] text-muted-foreground">
                          {closer} · submitted {formatDate(row.created_at)}
                        </span>
                      </TooltipBody>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="truncate text-muted-foreground" title={closer}>
                    {closer}
                  </TableCell>
                  <TableCell title={sourceLabel(row)}>
                    <OriginBadge row={row} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDate(row.created_at)}
                  </TableCell>
                  <TableCell className="overflow-hidden">
                    {/* The same chain the Operations queue draws, so a lead
                        that came back declined reads the same in both.
                        overflow-hidden: some of its badges carry a
                        max-w-[18rem] declined-carrier summary wider than this
                        column, which table-fixed does not clip on its own —
                        without it the badge visually spills into the next
                        cell instead of truncating. */}
                    <QueueStatusBadge
                      row={row}
                      declinedCarriers={declinedMap.data?.get(row.id) ?? []}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {row.disposed_at ? formatDate(row.disposed_at) : "—"}
                  </TableCell>
                  <TableCell>
                    <DispositionBadge disposition={row.disposition} onHold={isOnHold(row)} />
                  </TableCell>
                  {CX_CATEGORIES.map((category) => (
                    <TableCell key={category}>
                      <CxLeadStatusValue
                        category={category}
                        cx={row.cx}
                        optionFor={(id) => byId.get(id) ?? null}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="text-center text-muted-foreground">
                  {leads.isLoading
                    ? "Loading…"
                    : noCenter
                      ? "No center is assigned to your account, so this desk can show nothing. Ask an admin to set one."
                      : filtersActive
                        ? "No leads match that filter."
                        : "No closer leads yet."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

        <PaginationBar
          page={page}
          pageSize={PAGE_SIZE}
          shown={rows.length}
          total={total}
          busy={leads.isFetching}
          onPage={setPage}
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
        <SheetContent className="w-full overflow-y-auto overflow-x-hidden sm:max-w-2xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{customerName(selected.payload)}</SheetTitle>
                <SheetDescription>
                  {closerName(selected)} · {sourceLabel(selected)} · submitted{" "}
                  {formatDate(selected.created_at)}
                  {selected.disposed_at
                    ? ` · disposed ${formatDate(selected.disposed_at)}`
                    : ""}
                </SheetDescription>
              </SheetHeader>

              {/* min-w-0 + max-w-full: nothing inside may widen the sheet. */}
              <div className="flex min-w-0 max-w-full flex-col gap-4 px-4 pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={selected.status} />
                  <DispositionBadge
                    disposition={selected.disposition}
                    onHold={isOnHold(selected)}
                  />
                </div>

                <div className="flex min-w-0 flex-col gap-2">
                  <h3 className="panel-title">Customer statuses</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {CX_CATEGORIES.map((category) => (
                      <div key={category} className="flex min-w-0 flex-col gap-1">
                        <span className="field-label">{CATEGORY_LABEL[category]}</span>
                        <CxLeadStatusValue
                          category={category}
                          cx={selected.cx}
                          optionFor={(id) => byId.get(id) ?? null}
                        />
                      </div>
                    ))}
                  </div>
                  <span className="text-[0.66rem] text-muted-foreground">
                    Set by the CX team; read-only here.
                  </span>
                </div>

                <PayloadEditor
                  submissionId={selected.id}
                  payload={selected.payload}
                  onSaved={onEdited}
                />

                {/* The review's own outcome, below the payload it is about. */}
                <ValidatorFields row={selected} onSaved={onEdited} />

                {/* Read-only, and no card reveal: `card_details` belongs to an
                    admin and to the validator inside their own open review. */}
                <PaymentPanel submissionId={selected.id} />

                {/* general_manager only — closing_manager shares this screen
                    but add_submission_tag refuses that role, so it isn't
                    offered a control that would only error. Only meaningful
                    once a lead is accepted, same precondition the RPC checks. */}
                {profile?.role === "general_manager" && selected.disposition === "accepted" ? (
                  <SubmissionTags submissionId={selected.id} />
                ) : null}

                <PayloadEditHistory submissionId={selected.id} />

                {/* The validation workflow and the customer lifecycle both
                    live in the dedicated history dialog now — squeezed inline
                    here, a lead with real history made this sheet scroll a
                    long way in a column too narrow to read comfortably. */}
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
      />
    </TooltipProvider>
  );
}

/**
 * "Any", optionally "not set", then whatever this dimension offers.
 *
 * Generic over its own values so each filter keeps its real type — the query
 * builder types `status` and `disposition` to their enums, and a plain `string`
 * here would only push a cast into the caller.
 */
function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  notSet,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  /** The label for the null case, or omitted where there is no null case. */
  notSet?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="field-label">{label}</span>
      {/* Radix hands back one of the values rendered below, all of which are
          T by construction — the cast asserts what the item list already
          guarantees. */}
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY} className="text-xs">
            Any
          </SelectItem>
          {notSet ? (
            <SelectItem value={NOT_SET} className="text-xs">
              {notSet}
            </SelectItem>
          ) : null}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} className="text-xs">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
