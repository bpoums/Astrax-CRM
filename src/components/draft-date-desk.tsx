import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  CenterBadge,
  carrierName,
  customerName,
  type Disposition,
  type LeadSource,
  type SubStatus,
} from "@/components/ops";
import { useCenterColorById } from "@/lib/centers";
import { CxLeadStatusValue } from "@/components/cx-status-cell";
import { LeadHistoryDialog } from "@/components/lead-history-dialog";
import { History } from "lucide-react";
import { LeadPayload } from "@/components/lead-editor";
import { PayloadEditHistory } from "@/components/payload-history";
import { PaginationBar } from "@/components/pagination-bar";
import { formatCalendarDate } from "@/lib/format-date";
import {
  CATEGORY_LABEL,
  CX_CATEGORIES,
  CX_LEAD_STATUS_SELECT,
  useCxStatusOptions,
  type CxLeadStatus,
} from "@/lib/cx-status";
import {
  LEAD_PAGE_SIZE,
  carrierSearchClauses,
  payloadSearchClauses,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Accepted leads drafting on one day.
 *
 * The question this answers is a banking one: what is going to hit the
 * customers' accounts on a given date, and where does each of those policies
 * stand with the CX team. So it is keyed on `draft_date` — a real column, not a
 * payload key — and narrowed to `disposition = 'accepted'`.
 *
 * That single pair of conditions is deliberately the whole filter. It already
 * spans both populations a manager cares about: a closer's lead that somebody
 * accepted, and a validator's own submission, which auto-accepts on submit. Any
 * `source` or `submitted_by_role` test on top of it would only be able to
 * remove rows that belong here.
 *
 * `future_draft_date` is NOT consulted, though the validator form collects it
 * and many rows carry both. A lead is on this list for the day it actually
 * drafts; matching the second date as well would put the same policy on two
 * days and double-count the money.
 *
 * Nothing runs until a date is picked. An unbounded query over every accepted
 * lead in the system is not a useful default and is the one thing this screen
 * must not do on mount.
 */

const PAGE_SIZE = LEAD_PAGE_SIZE;

const SELECT = [
  "id",
  "payload",
  "status",
  "disposition",
  "created_at",
  "source",
  "draft_date",
  "center_name",
  "center_id",
  "closer_id",
  // Null on an uploaded lead, which has no closer at all — rendered as a dash
  // rather than left to print "undefined".
  "closer:profiles!submissions_closer_id_fkey(full_name)",
  CX_LEAD_STATUS_SELECT,
].join(", ");

type DraftRow = {
  id: string;
  payload: Record<string, unknown>;
  status: SubStatus;
  disposition: Disposition | null;
  created_at: string;
  source: LeadSource;
  draft_date: string | null;
  center_name: string | null;
  center_id: string | null;
  closer_id: string | null;
  closer: { full_name: string | null } | null;
  /** Null until the CX team touches the lead at all. */
  cx: CxLeadStatus | null;
};

export function DraftDateDesk() {
  const centerColorById = useCenterColorById();
  const [draftDate, setDraftDate] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const term = sanitizeTerm(search);
  const chosen = draftDate !== "";

  // A different date, or a different search, changes what page 1 means.
  useEffect(() => {
    setPage(0);
  }, [draftDate, term]);

  /**
   * The whole vocabulary, retired options included: a lead can be sitting on a
   * status that has since been deactivated, and drawing that as a blank would
   * be a lie. Fetched only once a date is picked, like everything else here.
   */
  const vocabulary = useCxStatusOptions(false, chosen);
  const { byId } = vocabulary;

  const leads = useQuery({
    queryKey: ["draft-dates", draftDate, term, page],
    // The whole point: no date, no query.
    enabled: chosen,
    queryFn: async () => {
      let query = supabase
        .from("submissions")
        .select(SELECT, { count: "exact" })
        .eq("draft_date", draftDate)
        .eq("disposition", "accepted");

      // A second `or` group; PostgREST ANDs repeated filters, so this narrows
      // the chosen date rather than widening it. Server-side because the table
      // is paged — a browser-side match would only ever see the twenty-five
      // rows already fetched.
      if (term) {
        query = query.or([...payloadSearchClauses(term), ...carrierSearchClauses(term)].join(","));
      }

      const from = page * PAGE_SIZE;
      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as unknown as DraftRow[], total: count ?? 0 };
    },
  });

  const rows = useMemo(() => leads.data?.rows ?? [], [leads.data]);
  const total = leads.data?.total ?? 0;
  const selected = rows.find((row) => row.id === openId) ?? null;

  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={300}>
      <section className="panel">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="panel-title">By Draft Date{chosen ? ` (${total})` : ""}</h2>
          <span className="text-[0.66rem] text-muted-foreground">
            Accepted leads drafting on the chosen date.
          </span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="draft-date" className="field-label">
              Draft date
            </label>
            <input
              id="draft-date"
              type="date"
              value={draftDate}
              onChange={(event) => setDraftDate(event.target.value)}
              className="field-input"
            />
          </div>
          {chosen ? (
            <>
              <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
                <label htmlFor="draft-date-search" className="field-label">
                  Search
                </label>
                <input
                  id="draft-date-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Customer or carrier…"
                  className="field-input"
                />
              </div>
              <button
                type="button"
                className="chip px-2.5 py-0.5 text-[0.66rem]"
                onClick={() => {
                  setDraftDate("");
                  setSearch("");
                }}
              >
                Clear
              </button>
            </>
          ) : null}
        </div>

        {/* A refused read is not an empty day, and must not be drawn as one. */}
        {leads.isError ? (
          <p className="text-xs text-destructive">
            These leads could not be read: {(leads.error as Error).message}
          </p>
        ) : null}

        {!chosen ? (
          <p className="text-xs text-muted-foreground">
            Pick a draft date to see the accepted leads drafting that day.
          </p>
        ) : (
          <>
            {/* Fixed layout so the declared widths hold and the cells truncate
                to their column; the min-width scrolls the panel sideways on a
                narrow screen rather than crushing them. */}
            <Table className="min-w-[80rem] table-fixed">
              <TableHeader>
                <TableRow>
                  {/* No width: Customer absorbs whatever the others leave. */}
                  <TableHead>Customer</TableHead>
                  <TableHead className="w-36">Carrier</TableHead>
                  <TableHead className="w-32">Center</TableHead>
                  <TableHead className="w-36">Submitted By</TableHead>
                  <TableHead className="w-28">Draft Date</TableHead>
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
                  const carrier = carrierName(row.payload);
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
                              {carrier} · drafts {formatCalendarDate(row.draft_date)}
                            </span>
                          </TooltipBody>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="truncate text-muted-foreground" title={carrier}>
                        {carrier}
                      </TableCell>
                      <TableCell className="truncate">
                        <CenterBadge
                          name={row.center_name}
                          color={row.center_id ? centerColorById.get(row.center_id) : null}
                        />
                      </TableCell>
                      {/* An uploaded lead has no closer — dash, never a blank. */}
                      <TableCell className="truncate text-muted-foreground">
                        {row.closer?.full_name ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatCalendarDate(row.draft_date)}
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
                    <TableCell colSpan={9} className="text-center text-muted-foreground">
                      {leads.isLoading
                        ? "Loading…"
                        : leads.isError
                          ? "—"
                          : "No accepted leads with this draft date"}
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
          </>
        )}
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
                  {carrierName(selected.payload)} · drafts {formatCalendarDate(selected.draft_date)}
                </SheetDescription>
              </SheetHeader>

              {/* min-w-0 + max-w-full: nothing inside may widen the sheet. */}
              <div className="flex min-w-0 max-w-full flex-col gap-4 px-4 pb-4">
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

                {/* Read-only. This screen is for seeing what drafts when, not
                    for working the lead — the Operations queue is where a lead
                    is edited, and offering an editor here would be a second
                    place for the same edit to go wrong. */}
                <LeadPayload submissionId={selected.id} payload={selected.payload} />

                <PayloadEditHistory submissionId={selected.id} />

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
        submissionId={selected?.id ?? null}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        customerName={selected ? customerName(selected.payload) : null}
      />
    </TooltipProvider>
  );
}
