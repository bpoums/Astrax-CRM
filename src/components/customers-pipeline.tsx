import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  CARRIER_KEYS,
  CenterBadge,
  carrierName,
  PayloadTable,
  customerName,
  sourceLabel,
  type LeadSource,
  type UploaderRef,
} from "@/components/ops";
import { useCenterColorById } from "@/lib/centers";
import { SSN_FIELD } from "@/lib/duplicate-ssn";
import { formatCalendarDate, formatDate } from "@/lib/format-date";
import { CxStatusCell, ReturnForValidationButton } from "@/components/cx-status-cell";
import { LeadHistoryDialog } from "@/components/lead-history-dialog";
import { History } from "lucide-react";
import {
  CATEGORY_LABEL,
  CX_CATEGORIES,
  useCxStatusOptions,
  type CxCategory,
} from "@/lib/cx-status";
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
 * The customers pipeline: every approved lead and the four independent statuses
 * the CX team moves it through.
 *
 * Reads `cx_pipeline`, which is one row per lead with the status labels, tones
 * and reasons already resolved — so the table needs no joins and no per-cell
 * lookups. That view carries its own `disposition = 'accepted' AND archived_at
 * IS NULL`, which is why nothing here re-filters for it: unlike a bare
 * submissions query, an admin reading this view gets the same set a CXA does.
 */

const PAGE_SIZE = 25;

/** The payload keys the search box spans. */
/**
 * Spread from `CARRIER_KEYS` rather than naming one of them: a validator
 * submission files the carrier under "Agency", so searching only "Carrier Name"
 * matched none of them — the same split that used to leave the column blank.
 */
const SEARCH_KEYS = ["Full Name", ...CARRIER_KEYS, "Phone Number"];

const SELECT_COLUMNS = [
  "submission_id",
  "payload",
  "submitted_on",
  "source",
  "draft_date",
  "policy_code, policy_label, policy_tone, policy_reason",
  "premium_code, premium_label, premium_tone, premium_reason",
  "commission_code, commission_label, commission_tone, commission_reason",
  "chargeback_code, chargeback_label, chargeback_tone, chargeback_reason",
  "cx_updated_by, cx_updated_at",
].join(", ");

/** A filter is "any", "none" (not set), or a status code within that category. */
const ANY = "any";
const NOT_SET = "none";

type Filters = Record<CxCategory, string>;

const NO_FILTERS: Filters = {
  policy: ANY,
  premium: ANY,
  commission: ANY,
  chargeback: ANY,
};

/** What `sourceLabel()`/the Center column need, however it was resolved. */
type OriginRow = {
  source: LeadSource | null;
  /** Live vs Manual turns on this as well as on `source` — see sourceLabel. */
  submitted_by_role: string | null;
  uploader: UploaderRef;
  center_id: string | null;
  center_name: string | null;
};

type PipelineRow = {
  submission_id: string;
  source: string | null;
  payload: Record<string, unknown>;
  submitted_on: string | null;
  /** The date the first premium draws. Null on a lead that never carried one. */
  draft_date: string | null;
  policy_code: string | null;
  policy_label: string | null;
  policy_tone: string | null;
  policy_reason: string | null;
  premium_code: string | null;
  premium_label: string | null;
  premium_tone: string | null;
  premium_reason: string | null;
  commission_code: string | null;
  commission_label: string | null;
  commission_tone: string | null;
  commission_reason: string | null;
  chargeback_code: string | null;
  chargeback_label: string | null;
  chargeback_tone: string | null;
  chargeback_reason: string | null;
  cx_updated_by: string | null;
  cx_updated_at: string | null;
};

/** Reads one category's four columns off a row. */
function statusOf(row: PipelineRow, category: CxCategory) {
  return {
    code: row[`${category}_code`],
    label: row[`${category}_label`],
    tone: row[`${category}_tone`],
    reason: row[`${category}_reason`],
  };
}

/**
 * PostgREST parses `or=(a.op.val,b.op.val)`, so a comma, parenthesis, quote or
 * backslash in the term would end it early or change the logic. They are
 * dropped rather than escaped — this is a search box, not a query language.
 */
function searchFilter(term: string) {
  const safe = term.replace(/[,()"\\]/g, " ").trim();
  if (!safe) return null;
  return SEARCH_KEYS.map((key) => `payload->>${key}.ilike.*${safe}*`).join(",");
}

const UNFILTERED = CX_CATEGORIES.map(() => ANY).join("|");

export function CustomersPipeline({
  readOnly = false,
  showUpdatedBy = false,
}: {
  /** Admin views the pipeline; working it is the CXA's job. */
  readOnly?: boolean;
  /**
   * The "Updated" column. Admin only: `cx_pipeline` is a security_invoker view,
   * so its join to profiles resolves under the reader's own RLS. A CXA can read
   * their own profile but not a colleague's, which would leave the column
   * populated for their own changes and blank for everyone else's — worse than
   * not showing it. An admin reads every profile, so it resolves throughout.
   */
  showUpdatedBy?: boolean;
}) {
  const queryClient = useQueryClient();
  const centerColorById = useCenterColorById();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // One fetch for the whole vocabulary, handed to every cell as props.
  const vocabulary = useCxStatusOptions(true);
  const byCategory = vocabulary.byCategory;

  const term = search.trim();
  const filterKey = CX_CATEGORIES.map((category) => filters[category]).join("|");

  // A filter or a search changes what page 1 even means.
  useEffect(() => {
    setPage(0);
  }, [term, draftDate, filterKey]);

  const pipeline = useQuery({
    queryKey: ["cx", "pipeline", page, term, draftDate, filterKey],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      let query = supabase.from("cx_pipeline").select(SELECT_COLUMNS, { count: "exact" });

      for (const category of CX_CATEGORIES) {
        const value = filters[category];
        if (value === ANY) continue;
        // Each view column belongs to exactly one category, and codes are
        // unique per category, so matching on the code needs no extra scoping.
        if (value === NOT_SET) query = query.is(`${category}_code`, null);
        else query = query.eq(`${category}_code`, value);
      }

      // An exact date, not a range: this answers "what is drafting on the
      // 14th", which is the question a CXA works a day's list from. Applied
      // server-side like every other filter here, because the table is paged —
      // matching in the browser would only ever see the current page.
      if (draftDate) query = query.eq("draft_date", draftDate);

      const filter = term ? searchFilter(term) : null;
      if (filter) query = query.or(filter);

      const { data, error, count } = await query
        .order("submitted_on", { ascending: false, nullsFirst: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as unknown as PipelineRow[], total: count ?? 0 };
    },
  });

  const rows = useMemo(() => pipeline.data?.rows ?? [], [pipeline.data]);
  const total = pipeline.data?.total ?? 0;

  const pageIds = useMemo(() => rows.map((row) => row.submission_id), [rows]);

  /**
   * Who supplied each lead on this page.
   *
   * `cx_pipeline` carries `source` but not `uploaded_by`, and it is a view with
   * no foreign keys, so the uploading profile cannot be embedded through it.
   * The names are fetched alongside instead, for the twenty-five ids actually
   * on screen. Every role that reaches this component can read those rows —
   * a CXA and a CXM are scoped to accepted, unarchived leads, which is exactly
   * what this view contains, and an admin reads everything.
   */
  const origins = useQuery({
    queryKey: ["cx", "origins", pageIds],
    enabled: pageIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select(
          "id, source, submitted_by_role, center_id, center_name, uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name)",
        )
        .in("id", pageIds);
      if (error) throw error;
      const byId = new Map<string, OriginRow>();
      for (const row of (data ?? []) as unknown as (OriginRow & { id: string })[]) {
        byId.set(row.id, {
          source: row.source,
          submitted_by_role: row.submitted_by_role,
          uploader: row.uploader,
          center_id: row.center_id,
          center_name: row.center_name,
        });
      }
      return byId;
    },
  });

  /**
   * The view's own `source` is the fallback, so a row still reads Live or
   * Manual while the names are in flight or if the lookup comes back short.
   * `cx_pipeline` carries no center at all, so the fallback has nothing to
   * offer there — the Center column reads "—" until the lookup lands.
   *
   * The fallback cannot tell a validator's submission from a closer's — the
   * view carries no role — so it reads as Live until the lookup lands. That is
   * the same direction every pre-column row resolves in, and it corrects itself
   * within the same page load rather than persisting.
   */
  const originOf = (row: PipelineRow): OriginRow =>
    origins.data?.get(row.submission_id) ?? {
      source: row.source === "sheet" ? "sheet" : "live",
      submitted_by_role: null,
      uploader: null,
      center_id: null,
      center_name: null,
    };
  const selected = rows.find((row) => row.submission_id === openId) ?? null;

  // A status change can move a row out of a filtered page, and it adds a
  // timeline entry, so both are refetched.
  const onStatusSaved = () => {
    queryClient.invalidateQueries({ queryKey: ["cx", "pipeline"] });
    queryClient.invalidateQueries({ queryKey: ["validation-timeline"] });
  };

  const firstShown = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastShown = page * PAGE_SIZE + rows.length;
  const filtersActive = term !== "" || draftDate !== "" || filterKey !== UNFILTERED;

  return (
    // One provider for the table and the detail sheet alike. 120ms instead of
    // the browser's ~1s title delay, so a hover reads as instant.
    <TooltipProvider delayDuration={120} skipDelayDuration={300}>
      <section className="panel">
        <h2 className="panel-title">Customers Pipeline ({total})</h2>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {CX_CATEGORIES.map((category) => (
            <div key={category} className="flex flex-col gap-1">
              <span className="field-label">{CATEGORY_LABEL[category]}</span>
              <Select
                value={filters[category]}
                onValueChange={(value) =>
                  setFilters((current) => ({ ...current, [category]: value }))
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY} className="text-xs">
                    Any
                  </SelectItem>
                  <SelectItem value={NOT_SET} className="text-xs">
                    Not set
                  </SelectItem>
                  {byCategory[category].map((option) => (
                    <SelectItem key={option.id} value={option.code} className="text-xs">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>

        {/* Directly above the table it filters, spanning it. */}
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search customer, carrier, phone…"
            className="field-input flex-1"
            aria-label="Search the customers pipeline"
          />
          {/* Its own control rather than another word in the search box: this
              NARROWS whatever that search returned, so a customer and a draft
              date can be asked for together. Empty means every date, unlike
              the admin's By Draft Date screen where a date is the whole query. */}
          <input
            type="date"
            value={draftDate}
            onChange={(event) => setDraftDate(event.target.value)}
            className="field-input w-40 shrink-0"
            aria-label="Filter by draft date"
          />
          {filtersActive ? (
            <button
              type="button"
              className="chip shrink-0 px-2.5 py-0.5 text-[0.66rem]"
              onClick={() => {
                setSearch("");
                setDraftDate("");
                setFilters(NO_FILTERS);
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>

        {/* Fixed layout, so the declared widths hold and the cells truncate to
            their column instead of stretching it. (draft-date filter above.)

            The widths are set from the headers up: each is wide enough to spell
            its column out in full, and the min-width makes the panel scroll
            sideways on a narrow screen rather than squeezing them. Headers never
            truncate; data does. */}
        <Table className="min-w-[85rem] table-fixed">
          <TableHeader>
            <TableRow>
              {/* No width: Customer absorbs whatever the others leave. */}
              <TableHead className="w-28">Center</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="w-32">SSN</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead>Draft Date</TableHead>
              {/* <TableHead>Submitted On</TableHead> */}
              {CX_CATEGORIES.map((category) => (
                <TableHead key={category} className="w-40">
                  {CATEGORY_LABEL[category]}
                </TableHead>
              ))}
              {showUpdatedBy ? <TableHead className="w-24">Updated</TableHead> : null}
              {/* Admin views the pipeline but does not work it — this is the
                  CXA/CXM's action, not something to show where it can't be used. */}
              {readOnly ? null : <TableHead className="w-40">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const origin = originOf(row);
              return (
                <TableRow
                  key={row.submission_id}
                  className="cursor-pointer align-top"
                  onClick={() => setOpenId(row.submission_id)}
                >
                  {/* Fixed columns clip rather than stretch, so anything that can
                    run long truncates and keeps its full text on hover. */}
                  <TableCell>
                    <CenterBadge
                      name={origin.center_name}
                      color={origin.center_id ? centerColorById.get(origin.center_id) : null}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="free-text block max-w-full truncate">
                          {customerName(row.payload)}
                        </span>
                      </TooltipTrigger>
                      <TooltipBody>
                        <TooltipHeading>{customerName(row.payload)}</TooltipHeading>
                        <span className="free-text text-[0.62rem] text-muted-foreground">
                          {carrierName(row.payload)} · submitted {formatDate(row.submitted_on)}
                        </span>
                      </TooltipBody>
                    </Tooltip>
                  </TableCell>
                  {/* Same field the intake forms write and PayloadTable already
                      shows unmasked in the detail sheet — every role that
                      reaches this table can already see it there, so a column
                      exposes nothing new, just saves the click. */}
                  <TableCell className="text-muted-foreground tabular-nums">
                    {typeof row.payload[SSN_FIELD] === "string" ? row.payload[SSN_FIELD] : "—"}
                  </TableCell>
                  {/* carrierName(), not the payload key: a closer's lead files
                    this under "Carrier Name" and a validator's under "Agency",
                    and reading one of them left every validator row blank. */}
                  <TableCell
                    className="truncate text-muted-foreground"
                    title={carrierName(row.payload)}
                  >
                    {carrierName(row.payload)}
                  </TableCell>

                  {/* formatCalendarDate, not formatDate: draft_date is a SQL
                    `date` with no instant in it, and rendering it in Pacific
                    prints the day before. See format-date.ts. */}
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatCalendarDate(row.draft_date)}
                  </TableCell>

                  {/* <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDate(row.submitted_on)}
                </TableCell> */}
                  {CX_CATEGORIES.map((category) => {
                    const status = statusOf(row, category);
                    return (
                      // The status cells are the interactive part of the row, so
                      // they must not open the detail sheet underneath them.
                      <TableCell key={category} onClick={(event) => event.stopPropagation()}>
                        <CxStatusCell
                          submissionId={row.submission_id}
                          category={category}
                          code={status.code}
                          label={status.label}
                          tone={status.tone}
                          reason={status.reason}
                          options={byCategory[category]}
                          updatedBy={row.cx_updated_by}
                          updatedAt={row.cx_updated_at}
                          readOnly={readOnly}
                          onSaved={onStatusSaved}
                        />
                      </TableCell>
                    );
                  })}
                  {showUpdatedBy ? (
                    <TableCell className="text-muted-foreground">
                      {row.cx_updated_at ? (
                        <span className="flex flex-col">
                          <span className="text-xs text-foreground">
                            {row.cx_updated_by ?? "—"}
                          </span>
                          <span className="text-[0.62rem]">{formatDate(row.cx_updated_at)}</span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  ) : null}
                  {/* The action is the interactive part of the row, so it must
                    not open the detail sheet underneath it. Admin's read-only
                    mount has no column for it at all — see the header above. */}
                  {readOnly ? null : (
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <ReturnForValidationButton
                        submissionId={row.submission_id}
                        onReturned={onStatusSaved}
                      />
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={showUpdatedBy ? (readOnly ? 11 : 12) : readOnly ? 10 : 11}
                  className="text-center text-muted-foreground"
                >
                  {pipeline.isLoading
                    ? "Loading…"
                    : filtersActive
                      ? "No approved leads match that filter."
                      : "No approved leads yet."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

        {total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[0.66rem] text-muted-foreground">
              {firstShown}–{lastShown} of {total}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="chip px-2.5 py-0.5 text-[0.66rem]"
                disabled={page === 0 || pipeline.isFetching}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="chip px-2.5 py-0.5 text-[0.66rem]"
                disabled={lastShown >= total || pipeline.isFetching}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
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
                  {carrierName(selected.payload)} · {sourceLabel(originOf(selected))} · submitted{" "}
                  {formatDate(selected.submitted_on)}
                </SheetDescription>
              </SheetHeader>

              {/* min-w-0 + max-w-full: nothing inside may widen the sheet. */}
              <div className="flex min-w-0 max-w-full flex-col gap-4 px-4 pb-4">
                <div className="flex min-w-0 flex-col gap-2">
                  <h3 className="panel-title">Statuses</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {CX_CATEGORIES.map((category) => {
                      const status = statusOf(selected, category);
                      return (
                        <div key={category} className="flex min-w-0 flex-col gap-1">
                          <span className="field-label">{CATEGORY_LABEL[category]}</span>
                          <CxStatusCell
                            submissionId={selected.submission_id}
                            category={category}
                            code={status.code}
                            label={status.label}
                            tone={status.tone}
                            reason={status.reason}
                            options={byCategory[category]}
                            updatedBy={selected.cx_updated_by}
                            updatedAt={selected.cx_updated_at}
                            readOnly={readOnly}
                            onSaved={onStatusSaved}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <PayloadTable payload={selected.payload} />

                {/* Both stories now live in the dedicated history dialog —
                    squeezed inline here, a lead with real history made this
                    sheet scroll a long way in a column too narrow to read
                    comfortably. */}
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
        submissionId={selected?.submission_id ?? null}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        customerName={selected ? customerName(selected.payload) : null}
      />
    </TooltipProvider>
  );
}
