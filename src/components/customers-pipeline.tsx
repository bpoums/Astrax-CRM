import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  OriginBadge,
  PayloadTable,
  customerName,
  sourceLabel,
  type LeadSource,
  type UploaderRef,
} from "@/components/ops";
import { formatDate } from "@/lib/format-date";
import { CxStatusCell } from "@/components/cx-status-cell";
import { CxLifecycleHistory } from "@/components/cx-lifecycle-history";
import { ValidationTimeline } from "@/components/validation-timeline";
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
const SEARCH_KEYS = ["Full Name", "Carrier Name", "Phone Number"];

const SELECT_COLUMNS = [
  "submission_id",
  "payload",
  "submitted_on",
  "source",
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

/** What OriginBadge needs, however it was resolved. */
type OriginRow = { source: LeadSource | null; uploader: UploaderRef };

type PipelineRow = {
  submission_id: string;
  source: string | null;
  payload: Record<string, unknown>;
  submitted_on: string | null;
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

function payloadText(payload: Record<string, unknown>, key: string) {
  const value = payload?.[key];
  return value === null || value === undefined || value === "" ? "—" : String(value);
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
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);

  // One fetch for the whole vocabulary, handed to every cell as props.
  const vocabulary = useCxStatusOptions(true);
  const byCategory = vocabulary.byCategory;

  const term = search.trim();
  const filterKey = CX_CATEGORIES.map((category) => filters[category]).join("|");

  // A filter or a search changes what page 1 even means.
  useEffect(() => {
    setPage(0);
  }, [term, filterKey]);

  const pipeline = useQuery({
    queryKey: ["cx", "pipeline", page, term, filterKey],
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
        .select("id, source, uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name)")
        .in("id", pageIds);
      if (error) throw error;
      const byId = new Map<string, OriginRow>();
      for (const row of (data ?? []) as unknown as (OriginRow & { id: string })[]) {
        byId.set(row.id, { source: row.source, uploader: row.uploader });
      }
      return byId;
    },
  });

  /**
   * The view's own `source` is the fallback, so a row still reads Live or
   * Offline while the names are in flight or if the lookup comes back short.
   */
  const originOf = (row: PipelineRow): OriginRow =>
    origins.data?.get(row.submission_id) ?? {
      source: row.source === "sheet" ? "sheet" : "live",
      uploader: null,
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
  const filtersActive = term !== "" || filterKey !== UNFILTERED;

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
          {filtersActive ? (
            <button
              type="button"
              className="chip shrink-0 px-2.5 py-0.5 text-[0.66rem]"
              onClick={() => {
                setSearch("");
                setFilters(NO_FILTERS);
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>

        {/* Fixed layout, so the declared widths hold and the cells truncate to
            their column instead of stretching it.

            The widths are set from the headers up: each is wide enough to spell
            its column out in full, and the min-width makes the panel scroll
            sideways on a narrow screen rather than squeezing them. Headers never
            truncate; data does. */}
        <Table className="min-w-[78rem] table-fixed">
          <TableHeader>
            <TableRow>
              {/* No width: Customer absorbs whatever the others leave. */}
              <TableHead className="w-28">Source</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="w-28">Carrier</TableHead>
              <TableHead className="w-28">Submitted On</TableHead>
              {CX_CATEGORIES.map((category) => (
                <TableHead key={category} className="w-40">
                  {CATEGORY_LABEL[category]}
                </TableHead>
              ))}
              {showUpdatedBy ? <TableHead className="w-24">Updated</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.submission_id}
                className="cursor-pointer align-top"
                onClick={() => setOpenId(row.submission_id)}
              >
                {/* Fixed columns clip rather than stretch, so anything that can
                    run long truncates and keeps its full text on hover. */}
                <TableCell>
                  <OriginBadge row={originOf(row)} />
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
                        {payloadText(row.payload, "Carrier Name")} · submitted{" "}
                        {formatDate(row.submitted_on)}
                      </span>
                    </TooltipBody>
                  </Tooltip>
                </TableCell>
                <TableCell
                  className="truncate text-muted-foreground"
                  title={payloadText(row.payload, "Carrier Name")}
                >
                  {payloadText(row.payload, "Carrier Name")}
                </TableCell>

                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDate(row.submitted_on)}
                </TableCell>
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
                        <span className="text-xs text-foreground">{row.cx_updated_by ?? "—"}</span>
                        <span className="text-[0.62rem]">{formatDate(row.cx_updated_at)}</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={showUpdatedBy ? 9 : 8}
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

      <Sheet open={!!selected} onOpenChange={(open) => !open && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto overflow-x-hidden sm:max-w-xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{customerName(selected.payload)}</SheetTitle>
                <SheetDescription>
                  {payloadText(selected.payload, "Carrier Name")} ·{" "}
                  {sourceLabel(originOf(selected))} · submitted {formatDate(selected.submitted_on)}
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

                {/* Two separate stories about the same lead: the customer
                    lifecycle after approval, and the validation workflow that
                    got it there. Kept apart and labelled so neither reads as a
                    continuation of the other. */}
                <CxLifecycleHistory submissionId={selected.submission_id} />

                <ValidationTimeline submissionId={selected.submission_id} />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}
