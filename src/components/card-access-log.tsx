import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { customerName, relativeTime, useNow } from "@/components/ops";
import { PaginationBar } from "@/components/pagination-bar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Every `card_details` call, newest first. The point of logging a reveal is
 * that someone can read the log, so it is a plain audit table: who opened which
 * lead's card, and when.
 *
 * Read-only by construction: `card_access_log` has an admin SELECT policy and
 * no write policy, so rows arrive only from the RPC that did the revealing.
 */

const PAGE_SIZE = 25;

type AccessRow = {
  id: number;
  accessed_at: string;
  actor: { full_name: string | null } | null;
  submission: { payload: Record<string, unknown> | null } | null;
};

export function CardAccessLog() {
  const now = useNow(30_000);
  const [page, setPage] = useState(0);

  const log = useQuery({
    queryKey: ["card-access-log", page],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const { data, error, count } = await supabase
        .from("card_access_log")
        .select(
          "id, accessed_at, actor:profiles!card_access_log_actor_id_fkey(full_name), submission:submissions!card_access_log_submission_id_fkey(payload)",
          { count: "exact" },
        )
        .order("accessed_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as unknown as AccessRow[], total: count ?? 0 };
    },
  });

  const rows = log.data?.rows ?? [];
  const total = log.data?.total ?? 0;

  return (
    <section className="panel">
      <h2 className="panel-title">Card access log ({total})</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Who</TableHead>
            <TableHead>Lead</TableHead>
            <TableHead>When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.actor?.full_name ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">
                {customerName((row.submission?.payload ?? {}) as Record<string, unknown>)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {relativeTime(row.accessed_at, now)}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-muted-foreground">
                {log.isLoading ? "Loading…" : "No card details have been opened."}
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
        busy={log.isFetching}
        onPage={setPage}
      />
    </section>
  );
}
