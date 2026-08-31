import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  AppHeader,
  DispositionBadge,
  PayloadTable,
  StatusBadge,
  customerName,
  dispositionLabel,
  relativeTime,
  shortDate,
  useNow,
  type Disposition,
  type SubStatus,
} from "@/components/ops";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { StatusChip } from "@/components/cx-status-cell";
import { isCxCategory, readStatusTone, shortCategory } from "@/lib/cx-status";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Everything the signed-in closer has forwarded, and where each lead got to.
 *
 * This does NOT read `submissions`. The RLS policy on that table gives a closer
 * nothing at all, and loosening it would hand them back the SSN, routing and
 * account numbers they are not supposed to see here. `my_forwarded_leads` is a
 * security-definer RPC that strips those keys in the database instead, so the
 * redaction survives anyone opening the network tab.
 *
 * Read-only by design: a closer corrects a lead by telling a manager, not by
 * editing a record that is already in someone's review queue.
 *
 * The CX column comes from `closer_lead_alerts`, a second read that is joined
 * to these rows in the browser. That view runs as its owner and carries
 * `s.closer_id = auth.uid()` inside itself, which is how a closer sees a CX
 * status at all without being given `submissions` or `cx_lead_status`. It also
 * decides what counts as a problem — `tone in ('destructive','warning')` — and
 * drops archived leads, so none of that is re-checked here. Filtering it again
 * client-side would be re-stating a rule that already holds.
 *
 * Informational only, exactly as it was in the panel this replaces: no reason
 * text, nothing to expand, nowhere to click through to. A closer cannot work a
 * CX status, and the view carries no reason, so there is nothing further to
 * show.
 */

const WITHHELD = ["SSN Number", "Routing Number", "Account Number"];

/** StatusBadge's labels, as plain text for places a badge cannot go. */
const STATUS_TEXT: Record<SubStatus, string> = {
  // A closer's lead never sits here — only imported ones do — but the record
  // has to be total, and this is what it would read as if one ever did.
  pending_import_approval: "Awaiting import approval",
  pending_manager: "Awaiting review",
  assigned: "With a validator",
  in_review: "In review",
  returned_timeout: "Back in the queue",
  closed: "Closed",
};

/**
 * One problem status on one lead — "Premium · Payment Failed".
 *
 * `tone` stays as the view spelled it and is resolved at render, so a tone the
 * database gains later needs no change here.
 */
type CxAlert = { key: string; label: string; tone: string | null };

/**
 * The two sources name the lead differently — `my_forwarded_leads` returns
 * `id`, `closer_lead_alerts` returns `submission_id` — but both are the
 * submission's uuid, so the join is on those two columns and nothing else.
 */
function groupAlerts(
  rows: {
    submission_id: string | null;
    category: string | null;
    status_label: string | null;
    tone: string | null;
  }[],
) {
  const byLead = new Map<string, CxAlert[]>();
  for (const row of rows) {
    // Views type every column as nullable. A row with no id cannot be joined
    // to a lead, and one with no label has nothing to say.
    if (!row.submission_id) continue;
    const category = isCxCategory(row.category) ? shortCategory(row.category) : row.category;
    const label = [category, row.status_label].filter(Boolean).join(" · ");
    if (!label) continue;
    const list = byLead.get(row.submission_id) ?? [];
    list.push({ key: `${row.category}-${row.status_label}`, label, tone: row.tone });
    byLead.set(row.submission_id, list);
  }
  return byLead;
}

type ForwardedLead = {
  id: string;
  created_at: string;
  status: SubStatus;
  disposition: Disposition | null;
  disposed_at: string | null;
  timeout_count: number;
  hold_count: number;
  rejection_count: number;
  payload: Record<string, unknown>;
};

export function ForwardedLeads() {
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const leads = useQuery({
    queryKey: ["forwarded-leads"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_forwarded_leads");
      if (error) throw error;
      // The generator cannot see that a RETURNS TABLE column is nullable, so
      // disposition and disposed_at come back over-narrowed.
      return (data ?? []) as unknown as ForwardedLead[];
    },
  });

  const alerts = useQuery({
    queryKey: ["closer", "lead-alerts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("closer_lead_alerts")
        .select("submission_id, category, status_label, tone")
        .order("category", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  // A lead with two problem statuses gets two badges; one with none gets an
  // empty list and renders nothing extra.
  const alertsByLead = useMemo(() => groupAlerts(alerts.data ?? []), [alerts.data]);

  const rows = useMemo(() => leads.data ?? [], [leads.data]);
  const term = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!term) return rows;
    return rows.filter((row) =>
      [customerName(row.payload), row.status, row.disposition ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [rows, term]);

  const selected = rows.find((row) => row.id === openId) ?? null;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-8 lg:py-5">
        <AppHeader
          title="Forwarded Leads"
          subtitle="Closer"
          actions={
            <Link to="/closer" className="chip inline-block">
              New entry
            </Link>
          }
        />

        <section className="panel">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="panel-title">Your submissions ({filtered.length})</h2>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search customer, status, outcome…"
              className="field-input max-w-xs"
              aria-label="Search your forwarded leads"
            />
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Forwarded</TableHead>
                <TableHead>Validation Status</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Policy Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {/* {relativeTime(row.created_at, now)} */}
                    {shortDate(row.created_at)}
                  </TableCell>

                  {/*------ Uncomment this block to get Status and Disposition of Leads ------- */}

                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={row.status} />
                      {/* A lead bouncing back into the queue is the one thing a
                          closer can act on, so it is called out here. */}
                      {row.rejection_count > 0 ? (
                        <Badge variant="secondary" className="text-muted-foreground">
                          Returned ×{row.rejection_count}
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <DispositionBadge disposition={row.disposition} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      {(alertsByLead.get(row.id) ?? []).map((alert) => (
                        <StatusChip
                          key={alert.key}
                          label={alert.label}
                          tone={readStatusTone(alert.tone)}
                        />
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {leads.isLoading
                      ? "Loading…"
                      : rows.length === 0
                        ? "You have not forwarded any leads yet."
                        : "No leads match that search."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </section>
      </div>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{customerName(selected.payload)}</SheetTitle>
                {/* Text only — SheetDescription renders a <p>, so the badge
                    components used in the table cannot go in here. */}
                <SheetDescription>
                  Forwarded {relativeTime(selected.created_at, now)} ·{" "}
                  {dispositionLabel(selected.disposition) ?? STATUS_TEXT[selected.status]}
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-4 px-4 pb-4">
                <PayloadTable payload={selected.payload} />
                <p className="text-[0.66rem] text-muted-foreground">
                  {WITHHELD.join(", ")} are not shown on this screen. Ask a manager if one of them
                  needs correcting.
                </p>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </main>
  );
}
