import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { ClampedText } from "@/components/free-text";
import { dispositionLabel, relativeTime, shortDate, useNow } from "@/components/ops";
import { CARRIER_DECLINE_STATS_KEY, carrierSummary, useCarrierDeclines } from "@/lib/carriers";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Where carrier declines are read rather than recorded: the queue badge, the
 * warning a manager gets before reassigning, the per-lead history and the
 * admin's roll-up.
 *
 * They all answer one question — which carriers have already refused this
 * lead — and the answer is only useful if it arrives before someone sends it
 * back out to the same carrier.
 */

/**
 * "Declined · TransAmerica, Corbridge" in the queue's status column.
 *
 * It replaces the generic declined badge rather than sitting beside it: the
 * state was never the missing information, the names are. Two names fit; the
 * rest become "+N" and the full list is in the detail sheet.
 */
export function DeclinedCarriersBadge({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <Badge variant="destructive" className="max-w-[18rem]">
      <span className="truncate">
        {dispositionLabel("declined")} · {carrierSummary(names)}
      </span>
    </Badge>
  );
}

/**
 * The same names, unabbreviated, at the point of reassigning.
 *
 * This is the whole point of the feature. A manager routing a lead onward has
 * to see who has already said no before they pick the next validator, so the
 * list is spelled out in full here — no "+N", no click-through.
 */
export function DeclinedCarriersCallout({
  names,
  className = "",
}: {
  names: string[];
  className?: string;
}) {
  if (names.length === 0) return null;
  return (
    <div
      className={`flex flex-col gap-1 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 ${className}`}
    >
      <span className="field-label text-destructive">
        Already declined by {names.length === 1 ? "1 carrier" : `${names.length} carriers`}
      </span>
      <span className="text-xs text-foreground">{names.join(", ")}</span>
      <span className="text-[0.66rem] text-muted-foreground">
        Do not send this lead back to these carriers.
      </span>
    </div>
  );
}

/**
 * Every decline attempt on one lead: carrier, reason, who and when, newest
 * first.
 *
 * Kept out of the validation timeline on purpose. The timeline is the story of
 * one pass through the queue; this is the story of the lead's carriers across
 * all of them, and merging the two would bury a decline among a dozen claims
 * and holds.
 */
export function CarrierDeclineList({ submissionId }: { submissionId: string | null }) {
  const declines = useCarrierDeclines(submissionId);
  const now = useNow(30_000);
  const rows = declines.data ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">Carrier declines</h3>
        {rows.length > 0 ? (
          <span className="text-[0.66rem] text-muted-foreground">
            {rows.length === 1 ? "1 attempt" : `${rows.length} attempts`}
          </span>
        ) : null}
      </div>
      <ol className="min-w-0 divide-y divide-border rounded-md border border-border">
        {rows.map((row) => (
          <li
            key={row.id}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-2 px-3 py-1.5"
          >
            <span className="field-label text-destructive">{row.carrier?.name ?? "Carrier"}</span>
            <span className="min-w-0 text-xs text-muted-foreground">
              <span className="text-foreground">{row.by?.full_name ?? "system"}</span> ·{" "}
              {relativeTime(row.declined_at, now)}
              {row.reason ? (
                <ClampedText
                  text={row.reason}
                  heading={row.carrier?.name ?? "Carrier decline"}
                  meta={`${row.by?.full_name ?? "system"} · ${shortDate(row.declined_at)}`}
                  className="italic"
                />
              ) : null}
            </span>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="px-3 py-1.5 text-xs text-muted-foreground">
            {declines.isError
              ? (declines.error as Error).message
              : declines.isLoading
                ? "Loading…"
                : "No carrier has declined this lead."}
          </li>
        ) : null}
      </ol>
    </div>
  );
}

type CarrierDeclineStat = {
  carrier_id: string | null;
  carrier_name: string | null;
  total_declines: number | null;
  leads_declined: number | null;
  last_decline: string | null;
};

/**
 * Declines per carrier, straight off `carrier_decline_stats`.
 *
 * `total_declines` and `leads_declined` are different numbers and both matter:
 * a carrier that refused forty leads once each is a different problem from one
 * that refused the same eight leads five times over.
 */
export function CarrierDeclineReport() {
  const stats = useQuery({
    queryKey: CARRIER_DECLINE_STATS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("carrier_decline_stats")
        .select("carrier_id, carrier_name, total_declines, leads_declined, last_decline")
        .order("total_declines", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CarrierDeclineStat[];
    },
  });

  const rows = stats.data ?? [];

  return (
    <section className="panel">
      <h2 className="panel-title">Carrier declines ({rows.length})</h2>
      {stats.isError ? (
        <p className="text-xs text-destructive">{(stats.error as Error).message}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Carrier</TableHead>
              <TableHead className="text-right">Total declines</TableHead>
              <TableHead className="text-right">Leads declined</TableHead>
              <TableHead className="text-right">Last decline</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.carrier_id ?? row.carrier_name}>
                <TableCell className="font-medium">{row.carrier_name ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-destructive">
                  {row.total_declines ?? 0}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {row.leads_declined ?? 0}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {shortDate(row.last_decline)}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {stats.isLoading ? "Loading…" : "No carrier declines recorded."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
