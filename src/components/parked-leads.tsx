import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  CenterBadge,
  closerName,
  customerName,
  OriginBadge,
  PayloadTable,
  relativeTime,
  sourceLabel,
  useNow,
  type LeadSource,
} from "@/components/ops";
import { useCenterColorById } from "@/lib/centers";
import { formatDate } from "@/lib/format-date";
import { PaginationBar } from "@/components/pagination-bar";
import { LEAD_PAGE_SIZE, matchingProfileIds, payloadSearchClauses } from "@/lib/lead-search";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * External transfers, waiting for someone to send them into validation.
 *
 * A closer presses "External Transfer" instead of "Submit entry" and the lead
 * is written by `submit_form_parked` in `parked` — a status held out of every
 * queue, the same way `pending_import_approval` holds an uploaded batch. The
 * lead still reaches Google Sheets on submission and still appears in the admin
 * Submissions listing; what it does not do is reach a manager.
 *
 * `move_to_validation` flips one lead to `pending_manager`, which is the moment
 * it becomes an ordinary queue row and leaves this screen for good. A lead
 * nobody moves stays here indefinitely — that is the point of the tab, and why
 * there is no other exit from it.
 *
 * The row set is NOT scoped here. `move_to_validation` refuses anyone but an
 * admin or a general manager, and the read policy decides what comes back; a
 * `status = 'parked'` filter is all this query adds.
 */

export const PARKED_LEADS_KEY = ["parked-leads"] as const;

const PAGE_SIZE = LEAD_PAGE_SIZE;

const SELECT = [
  "id",
  "payload",
  "created_at",
  "source",
  "center_name",
  "center_id",
  "closer_id",
  // Null on an uploaded lead, which has no closer at all — rendered as a dash
  // rather than left to print "undefined".
  "closer:profiles!submissions_closer_id_fkey(full_name)",
  "uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name)",
].join(", ");

type ParkedRow = {
  id: string;
  payload: Record<string, unknown>;
  created_at: string;
  source: LeadSource;
  center_name: string | null;
  center_id: string | null;
  closer_id: string | null;
  closer: { full_name: string | null } | null;
  uploader: { full_name: string | null; org_name?: string | null } | null;
};

export function ParkedLeads() {
  const queryClient = useQueryClient();
  const centerColorById = useCenterColorById();
  const now = useNow(30_000);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  /** The row whose button is mid-flight, so only that one shows as busy. */
  const [movingId, setMovingId] = useState<string | null>(null);
  /** The lead whose detail panel is open, or null. */
  const [openId, setOpenId] = useState<string | null>(null);

  const term = search.trim();

  const leads = useQuery({
    queryKey: [...PARKED_LEADS_KEY, page, term],
    queryFn: async () => {
      const profileIds = term ? await matchingProfileIds(term) : [];

      let query = supabase
        .from("submissions")
        .select(SELECT, { count: "exact" })
        .eq("status", "parked")
        .is("archived_at", null);

      if (term) {
        const clauses = [...payloadSearchClauses(term)];
        if (profileIds.length > 0) clauses.push(`closer_id.in.(${profileIds.join(",")})`);
        query = query.or(clauses.join(","));
      }

      const from = page * PAGE_SIZE;
      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as unknown as ParkedRow[], total: count ?? 0 };
    },
  });

  const move = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("move_to_validation", { p_sub: id });
      // The RPC raises its own wording — "not authorized", "lead is not
      // parked". Show it as written rather than replacing it.
      if (error) throw error;
    },
    onMutate: (id) => setMovingId(id),
    onSettled: () => setMovingId(null),
    onSuccess: () => {
      toast.success("Moved to validation");
      // The lead leaves this list the moment it moves, so a panel left open
      // would be sitting over a row that no longer exists.
      setOpenId(null);
      // It has left this list and joined the manager's queue, so both go.
      queryClient.invalidateQueries({ queryKey: PARKED_LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = leads.data?.rows ?? [];
  const total = leads.data?.total ?? 0;
  // Only ever a row on the page in front of the reader, which is the only row
  // they can have clicked.
  const selected = rows.find((row) => row.id === openId) ?? null;

  return (
    <>
      <section className="panel">
        <h2 className="panel-title">Parked Leads ({total})</h2>
        <p className="text-[0.66rem] text-muted-foreground">
          External transfers. They stay here until someone moves one into validation, and a lead
          nobody moves stays indefinitely.
        </p>

        <div className="flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="Search customer, closer, phone…"
            className="field-input flex-1"
            aria-label="Search parked leads"
          />
        </div>

        <Table className="min-w-[60rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Center</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="w-32">Closer</TableHead>
              <TableHead className="w-24">Source</TableHead>
              <TableHead className="w-28">Parked</TableHead>
              <TableHead className="w-40 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                <TableCell className="truncate">
                  <CenterBadge
                    name={row.center_name}
                    color={row.center_id ? centerColorById.get(row.center_id) : null}
                  />
                </TableCell>
                <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                <TableCell className="truncate text-muted-foreground">{closerName(row)}</TableCell>
                <TableCell title={sourceLabel(row)}>
                  <OriginBadge row={row} />
                </TableCell>
                <TableCell
                  className="whitespace-nowrap text-muted-foreground"
                  title={formatDate(row.created_at)}
                >
                  {relativeTime(row.created_at, now)}
                </TableCell>
                {/* Stops the row's own click handler firing too, which would
                  open the detail panel over a lead that is already leaving. */}
                <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="chip px-2.5 py-0.5 text-[0.66rem]"
                    disabled={move.isPending}
                    onClick={() => move.mutate(row.id)}
                  >
                    {movingId === row.id ? "Moving…" : "Move to Validation"}
                  </button>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  {leads.isLoading
                    ? "Loading…"
                    : leads.isError
                      ? (leads.error as Error).message
                      : term
                        ? "No parked leads match that search."
                        : "No parked leads."}
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

      {/* The lead itself, so the decision is made against what it actually
          says rather than against a customer name and a date. No extra query:
          `payload` is already on the row the table drew. */}
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto overflow-x-hidden sm:max-w-xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{customerName(selected.payload)}</SheetTitle>
                <SheetDescription>
                  {closerName(selected)} · {sourceLabel(selected)} · parked{" "}
                  {relativeTime(selected.created_at, now)}
                </SheetDescription>
              </SheetHeader>

              {/* min-w-0 + max-w-full: nothing inside may widen the sheet. */}
              <div className="flex min-w-0 max-w-full flex-col gap-4 px-4 pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <CenterBadge
                    name={selected.center_name}
                    color={selected.center_id ? centerColorById.get(selected.center_id) : null}
                  />
                  <span className="text-[0.66rem] text-muted-foreground">
                    Submitted {formatDate(selected.created_at)}
                  </span>
                </div>

                <PayloadTable payload={selected.payload} />

                {/* The same action as the row's, here so the reader does not
                    have to close this, find the row again and lose their place.
                    One mutation drives both. */}
                <button
                  type="button"
                  className="btn-submit w-full"
                  disabled={move.isPending}
                  onClick={() => move.mutate(selected.id)}
                >
                  {movingId === selected.id ? "Moving…" : "Move to Validation"}
                </button>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
