import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { relativeTime, useNow } from "@/components/ops";
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
 * Every change made through `set_admin_setting`, newest first.
 *
 * Read-only by construction: `settings_audit` has an admin SELECT policy and no
 * write policy at all, so rows arrive only from the RPC that made the change.
 */

const PAGE_SIZE = 25;

type AuditRow = {
  id: number;
  key: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
  actor: { full_name: string | null } | null;
};

export function SettingsAudit() {
  const now = useNow(30_000);
  const [page, setPage] = useState(0);

  const log = useQuery({
    queryKey: ["settings-audit", page],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const { data, error, count } = await supabase
        .from("settings_audit")
        .select(
          "id, key, old_value, new_value, changed_at, actor:profiles!settings_audit_actor_id_fkey(full_name)",
          { count: "exact" },
        )
        .order("changed_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as unknown as AuditRow[], total: count ?? 0 };
    },
  });

  const rows = log.data?.rows ?? [];
  const total = log.data?.total ?? 0;

  return (
    <section className="panel">
      <h2 className="panel-title">Settings changes ({total})</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Setting</TableHead>
            <TableHead>From</TableHead>
            <TableHead>To</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono text-[0.68rem]">{row.key}</TableCell>
              <TableCell className="text-muted-foreground">{row.old_value ?? "—"}</TableCell>
              <TableCell className="font-medium">{row.new_value ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{row.actor?.full_name ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">
                {relativeTime(row.changed_at, now)}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                {log.isLoading ? "Loading…" : "No settings have been changed."}
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
