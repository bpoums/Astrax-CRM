import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { STATUS_LABEL, customerName, dataFlags, relativeTime, useNow } from "@/components/ops";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ImportRow = {
  id: string;
  file_name: string | null;
  row_count: number;
  imported_count: number;
  skipped_count: number;
  created_at: string;
  uploader?: { full_name: string | null } | null;
};

/**
 * How a batch stands with the manager who has to accept it.
 *
 * Read off the leads rather than off `lead_imports`, which carries no decision
 * of its own. The three cases are distinguishable because rejection archives a
 * lead WITHOUT moving it out of `pending_import_approval`, while approval moves
 * it to `pending_manager` — so a row still in the import status says which way
 * it went, and a lead archived later for some ordinary reason is not mistaken
 * for a rejected one.
 */
type DecisionCounts = { pending: number; approved: number; rejected: number };

function DecisionBadge({ counts }: { counts: DecisionCounts | undefined }) {
  if (!counts) return <span className="text-muted-foreground">—</span>;
  if (counts.pending > 0) {
    return (
      <Badge variant="secondary" className="text-muted-foreground">
        Awaiting approval
      </Badge>
    );
  }
  if (counts.approved > 0) {
    return (
      <Badge variant="outline" className="border-border text-muted-foreground">
        Approved{counts.rejected > 0 ? ` · ${counts.rejected} rejected` : ""}
      </Badge>
    );
  }
  if (counts.rejected > 0) return <Badge variant="destructive">Rejected</Badge>;
  return <span className="text-muted-foreground">—</span>;
}

/**
 * An uploader's own batches. RLS scopes every query to uploaded_by = their id,
 * so an uploader sees the leads they imported and no others; the admin view
 * passes `allUploaders` and gets everyone's, with names.
 */
export function ImportHistory({ allUploaders = false }: { allUploaders?: boolean }) {
  const now = useNow(30_000);
  const [openId, setOpenId] = useState<string | null>(null);

  const imports = useQuery({
    queryKey: ["lead-imports", allUploaders],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lead_imports")
        .select(
          allUploaders
            ? "id, file_name, row_count, imported_count, skipped_count, created_at, uploader:profiles!lead_imports_uploaded_by_fkey(full_name)"
            : "id, file_name, row_count, imported_count, skipped_count, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as ImportRow[];
    },
  });

  const rows = useMemo(() => imports.data ?? [], [imports.data]);
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);

  /**
   * One query for every batch on screen rather than one per row. Uploading is
   * not a high-volume action and the list is capped at 100 batches, so this
   * stays a single small request.
   */
  const decisions = useQuery({
    queryKey: ["lead-imports", "decisions", ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("import_id, status, archived_at")
        .in("import_id", ids);
      if (error) throw error;
      const counts = new Map<string, DecisionCounts>();
      for (const row of data ?? []) {
        if (!row.import_id) continue;
        const entry = counts.get(row.import_id) ?? { pending: 0, approved: 0, rejected: 0 };
        if (row.status !== "pending_import_approval") entry.approved += 1;
        else if (row.archived_at) entry.rejected += 1;
        else entry.pending += 1;
        counts.set(row.import_id, entry);
      }
      return counts;
    },
  });

  const leads = useQuery({
    queryKey: ["lead-imports", "leads", openId],
    enabled: !!openId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("id, payload, status, archived_at, created_at, data_flags")
        .eq("import_id", openId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <section className="panel">
      <h2 className="panel-title">
        {allUploaders ? "Lead imports" : "My imports"} ({rows.length})
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>File</TableHead>
            {allUploaders ? <TableHead>Uploader</TableHead> : null}
            <TableHead className="text-right">Rows</TableHead>
            <TableHead className="text-right">Imported</TableHead>
            <TableHead className="text-right">Skipped</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead>When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className="cursor-pointer"
              onClick={() => setOpenId((current) => (current === row.id ? null : row.id))}
            >
              <TableCell className="font-medium">{row.file_name ?? "—"}</TableCell>
              {allUploaders ? (
                <TableCell className="text-muted-foreground">
                  {row.uploader?.full_name ?? "—"}
                </TableCell>
              ) : null}
              <TableCell className="text-right tabular-nums">{row.row_count}</TableCell>
              <TableCell className="text-right tabular-nums">{row.imported_count}</TableCell>
              <TableCell
                className={`text-right tabular-nums ${
                  row.skipped_count > 0 ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {row.skipped_count}
              </TableCell>
              <TableCell>
                <DecisionBadge counts={decisions.data?.get(row.id)} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {relativeTime(row.created_at, now)}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={allUploaders ? 7 : 6}
                className="text-center text-muted-foreground"
              >
                {imports.isLoading ? "Loading…" : "No imports yet."}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      {openId ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <h3 className="panel-title">Leads in this batch ({leads.data?.length ?? 0})</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Flags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(leads.data ?? []).map((lead) => {
                const flags = dataFlags(lead.data_flags);
                return (
                  <TableRow key={lead.id}>
                    <TableCell className="font-medium">
                      {customerName((lead.payload ?? {}) as Record<string, unknown>)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {/* A rejected lead is archived and left in the import
                          status, so the raw label would read as still waiting. */}
                      {lead.archived_at && lead.status === "pending_import_approval"
                        ? "Rejected"
                        : STATUS_LABEL[lead.status]}
                    </TableCell>
                    <TableCell>
                      {flags.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Badge variant="outline" className="border-destructive text-destructive">
                          {flags.length}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {(leads.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    {leads.isLoading ? "Loading…" : "No leads found for this batch."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </section>
  );
}
