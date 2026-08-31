import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
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
  shortDate,
  sourceLabel,
  type Disposition,
  type LeadSource,
  type SubStatus,
  type UploaderRef,
} from "@/components/ops";
import { CxStatusValue } from "@/components/cx-status-cell";
import { CxLifecycleHistory } from "@/components/cx-lifecycle-history";
import { ValidationTimeline, validationTimelineKey } from "@/components/validation-timeline";
import { PayloadEditor } from "@/components/payload-editor";
import { PayloadEditHistory, payloadHistoryKey } from "@/components/payload-history";
import { PaymentPanel } from "@/components/payment-panel";
import { PaginationBar } from "@/components/pagination-bar";
import {
  CATEGORY_LABEL,
  CX_CATEGORIES,
  useCxStatusOptions,
  type CxCategory,
} from "@/lib/cx-status";
import { useDeclinedCarrierMap } from "@/lib/carriers";
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
 * The closing manager's desk: every closer-originated lead, at whatever stage
 * it has reached, with the payload editable in place.
 *
 * The row set is NOT filtered here. The `submissions` read policy already
 * narrows a closing manager to `submitted_by_role = 'closer'` and unarchived
 * rows, so re-stating that in the query would duplicate a rule that lives in
 * one place, and would quietly diverge the day the policy changes.
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

const CX_FK = "cx_lead_status!cx_lead_status_submission_id_fkey";

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
  "source",
  "closer_id",
  // Not shown as columns of their own — they are what isOnHold() reads to tell
  // a held lead from a merely assigned one.
  "claimed_at",
  "assigned_at",
  "last_held_at",
  "closer:profiles!submissions_closer_id_fkey(full_name)",
  "uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name)",
  // One row per lead at most, so this embeds as an object rather than a list.
  // `updater` is nested a second level so the tooltip can attribute the last CX
  // change to a person rather than to a uuid.
  `cx:${CX_FK}(policy_status_id, policy_reason, premium_status_id, premium_reason, ` +
    "commission_status_id, commission_reason, chargeback_status_id, chargeback_reason, " +
    "updated_at, updater:profiles!cx_lead_status_updated_by_fkey(full_name))",
].join(", ");

type CxLeadStatus = {
  policy_status_id: string | null;
  policy_reason: string | null;
  premium_status_id: string | null;
  premium_reason: string | null;
  commission_status_id: string | null;
  commission_reason: string | null;
  chargeback_status_id: string | null;
  chargeback_reason: string | null;
  updated_at: string | null;
  updater: { full_name: string | null } | null;
};

type ClosingRow = {
  id: string;
  payload: Record<string, unknown>;
  status: SubStatus;
  disposition: Disposition | null;
  rejection_count: number;
  timeout_by: { full_name: string | null } | null;
  rejected_by: { full_name: string | null } | null;
  created_at: string;
  source: LeadSource;
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
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>(ANY);
  const [disposition, setDisposition] = useState<DispositionFilter>(ANY);
  const [cxFilters, setCxFilters] = useState<CxFilters>(NO_CX_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);

  // The whole vocabulary in one fetch, deactivated options included: a lead can
  // still be sitting on a status that has since been retired, and rendering it
  // as an unresolved blank would be a lie. The dropdowns offer the active ones.
  const vocabulary = useCxStatusOptions(false);
  const { byCategory, byId } = vocabulary;

  const term = sanitizeTerm(search);
  const cxKey = CX_CATEGORIES.map((category) => cxFilters[category]).join("|");

  // A filter or a search changes what page 1 even means.
  useEffect(() => {
    setPage(0);
  }, [term, status, disposition, cxKey]);

  // Names the carriers on a returned lead. The view holds only leads that have
  // been declined at least once, so it stays short whatever this page shows.
  const declinedMap = useDeclinedCarrierMap();

  const leads = useQuery({
    queryKey: ["closing", "leads", page, term, status, disposition, cxKey],
    queryFn: async () => {
      // Resolved before the main query so a person match can be folded into
      // the same `or` as the payload matches: closer_id and uploaded_by are
      // base columns, whereas an embedded profiles filter could not be or-ed
      // with one. One lookup covers both — a term matches a profile by its name
      // or by its centre, and the row is kept if either column points at it.
      const profileIds = term ? await matchingProfileIds(term) : [];

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
      if (setFilters.length > 0) select.push(`setf:${CX_FK}!inner(submission_id)`);
      for (const category of unsetFilters) select.push(`no_${category}:${CX_FK}(submission_id)`);

      let query = supabase.from("submissions").select(select.join(", "), { count: "exact" });

      if (status !== ANY) query = query.eq("status", status);
      if (disposition === NOT_SET) query = query.is("disposition", null);
      else if (disposition !== ANY) query = query.eq("disposition", disposition);

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
    term !== "" || status !== ANY || disposition !== ANY || cxKey !== UNFILTERED_CX;

  function clearFilters() {
    setSearch("");
    setStatus(ANY);
    setDisposition(ANY);
    setCxFilters(NO_CX_FILTERS);
  }

  return (
    // One provider for the table and the detail sheet alike. 120ms instead of
    // the browser's ~1s title delay, so a hover reads as instant.
    <TooltipProvider delayDuration={120} skipDelayDuration={300}>
      <section className="panel">
        <h2 className="panel-title">Closer Leads ({total})</h2>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <FilterSelect
            label="Validation Status"
            value={status}
            onChange={setStatus}
            /* This desk is closer-originated leads only, and a closer
               submission never enters import approval — offering it would be a
               filter that always returns nothing. */
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
        <Table className="min-w-[92rem] table-fixed">
          <TableHeader>
            <TableRow>
              {/* No width: Customer absorbs whatever the others leave. */}
              <TableHead>Customer</TableHead>
              <TableHead className="w-32">Closer</TableHead>
              <TableHead className="w-28">Source</TableHead>
              <TableHead className="w-28">Submitted</TableHead>
              <TableHead className="w-28">Validation</TableHead>
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
                  <TableCell className="font-medium">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="free-text block max-w-full truncate">{name}</span>
                      </TooltipTrigger>
                      <TooltipBody>
                        <TooltipHeading>{name}</TooltipHeading>
                        <span className="free-text text-[0.62rem] text-muted-foreground">
                          {closer} · submitted {shortDate(row.created_at)}
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
                    {shortDate(row.created_at)}
                  </TableCell>
                  <TableCell>
                    {/* The same chain the Operations queue draws, so a lead
                        that came back declined reads the same in both. */}
                    <QueueStatusBadge
                      row={row}
                      declinedCarriers={declinedMap.data?.get(row.id) ?? []}
                    />
                  </TableCell>
                  <TableCell>
                    <DispositionBadge disposition={row.disposition} onHold={isOnHold(row)} />
                  </TableCell>
                  {CX_CATEGORIES.map((category) => (
                    <TableCell key={category}>
                      <ReadOnlyStatus
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
                <TableCell colSpan={10} className="text-center text-muted-foreground">
                  {leads.isLoading
                    ? "Loading…"
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

      <Sheet open={!!selected} onOpenChange={(open) => !open && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto overflow-x-hidden sm:max-w-2xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{customerName(selected.payload)}</SheetTitle>
                <SheetDescription>
                  {closerName(selected)} · {sourceLabel(selected)} · submitted{" "}
                  {shortDate(selected.created_at)}
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
                        <ReadOnlyStatus
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

                {/* Read-only, and no card reveal: `card_details` belongs to an
                    admin and to the validator inside their own open review. */}
                <PaymentPanel submissionId={selected.id} />

                <PayloadEditHistory submissionId={selected.id} />

                {/* Three separate stories about the same lead — what was
                    corrected, what the customer lifecycle did after approval,
                    and the validation workflow that got it there. Kept apart and
                    labelled so none reads as a continuation of another. */}
                <CxLifecycleHistory submissionId={selected.id} />
                <ValidationTimeline submissionId={selected.id} />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}

/** One category's chip and reason, resolved from the stored option id. */
function ReadOnlyStatus({
  category,
  cx,
  optionFor,
}: {
  category: CxCategory;
  cx: CxLeadStatus | null;
  optionFor: (id: string) => { label: string; tone: string } | null;
}) {
  const id = cx?.[`${category}_status_id`] ?? null;
  const option = id ? optionFor(id) : null;

  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-0.5 px-1 py-0.5">
      <CxStatusValue
        category={category}
        label={option?.label ?? null}
        tone={option?.tone ?? null}
        reason={cx?.[`${category}_reason`] ?? null}
        updatedBy={cx?.updater?.full_name ?? null}
        updatedAt={cx?.updated_at ?? null}
      />
    </div>
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
