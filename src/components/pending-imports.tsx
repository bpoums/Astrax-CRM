import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { customerName, dataFlags, relativeTime, useNow } from "@/components/ops";
import { useAuth } from "@/lib/auth";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Batches waiting on a manager. Exported so the manager page's realtime
 * subscription can invalidate the whole group in one call.
 */
export const PENDING_IMPORTS_KEY = ["pending-imports"] as const;

type BatchRow = {
  import_id: string | null;
  file_name: string | null;
  uploader_name: string | null;
  lead_count: number | null;
  flagged_count: number | null;
  created_at: string | null;
};

type PendingLead = {
  id: string;
  payload: Record<string, unknown>;
  data_flags: unknown;
  created_at: string;
};

/**
 * Imported leads awaiting a manager's decision, one row per batch.
 *
 * Closer submissions never appear here. They land in `pending_manager` exactly
 * as they always have and go straight to the Operations queue; this screen only
 * ever holds `source = 'sheet'` rows sitting in `pending_import_approval`.
 */
export function PendingImports() {
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const { profile } = useAuth();
  // This screen is the manager's; the upload address is the admin's.
  const showIp = profile?.role === "admin";
  const [openId, setOpenId] = useState<string | null>(null);
  /** Leads ticked for rejection inside the open batch. */
  const [excluded, setExcluded] = useState<string[]>([]);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // Closing a batch drops the exclusions with it: a tick made against one
  // batch's leads means nothing in another's.
  useEffect(() => setExcluded([]), [openId]);

  const batches = useQuery({
    queryKey: [...PENDING_IMPORTS_KEY, "batches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pending_import_batches")
        .select("import_id, file_name, uploader_name, lead_count, flagged_count, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as BatchRow[];
    },
  });

  // Derived straight from the batches rather than from `rows` below, which is
  // computed after the queries — same ids either way, since `rows` only drops
  // the null import_id the view's type allows and never reorders.
  const batchIds = useMemo(
    () => (batches.data ?? []).flatMap((batch) => (batch.import_id ? [batch.import_id] : [])),
    [batches.data],
  );

  /**
   * The upload addresses for the batches on screen.
   *
   * A second small query rather than a column on `pending_import_batches`:
   * the view does not carry `upload_ip`, and this is a display detail for one
   * role — not a reason to change a view four screens read. One request covers
   * every row, the same way the import history resolves its decisions, and it
   * does not run at all for anyone but an admin.
   */
  const uploadIps = useQuery({
    queryKey: [...PENDING_IMPORTS_KEY, "upload-ips", batchIds],
    enabled: showIp && batchIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lead_imports")
        .select("id, upload_ip")
        .in("id", batchIds);
      if (error) throw error;
      return new Map((data ?? []).map((row) => [row.id, row.upload_ip]));
    },
  });

  const leads = useQuery({
    queryKey: [...PENDING_IMPORTS_KEY, "leads", openId],
    enabled: !!openId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("id, payload, data_flags, created_at")
        .eq("import_id", openId ?? "")
        .eq("status", "pending_import_approval")
        .is("archived_at", null)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PendingLead[];
    },
  });

  function settle() {
    setOpenId(null);
    setRejectId(null);
    setRejectReason("");
    queryClient.invalidateQueries({ queryKey: PENDING_IMPORTS_KEY });
    // Approved leads are in the Operations queue the moment this returns.
    queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
    queryClient.invalidateQueries({ queryKey: ["lead-imports"] });
    queryClient.invalidateQueries({ queryKey: ["reporting"] });
  }

  // One call does both halves: the leads not ticked move to pending_manager,
  // the ticked ones are archived. There is no second request to get wrong.
  const approve = useMutation({
    mutationFn: async (vars: { importId: string; reject: string[] }) => {
      const { data, error } = await supabase.rpc("approve_import_batch", {
        p_import_id: vars.importId,
        p_reject_ids: vars.reject,
      });
      if (error) throw error;
      const result = (data ?? {}) as { approved?: number; rejected?: number };
      return {
        approved: typeof result.approved === "number" ? result.approved : 0,
        rejected: typeof result.rejected === "number" ? result.rejected : 0,
      };
    },
    onSuccess: ({ approved, rejected }) => {
      toast.success(
        rejected > 0
          ? `${approved} leads sent to Operations, ${rejected} rejected`
          : `${approved} leads sent to Operations`,
      );
      settle();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const reject = useMutation({
    mutationFn: async (vars: { importId: string; reason: string }) => {
      const reason = vars.reason.trim();
      // exactOptionalPropertyTypes refuses an explicit null for p_reason, so
      // the key is omitted and the SQL default applies.
      const { data, error } = await supabase.rpc(
        "reject_import_batch",
        reason ? { p_import_id: vars.importId, p_reason: reason } : { p_import_id: vars.importId },
      );
      if (error) throw error;
      const result = (data ?? {}) as { rejected?: number };
      return typeof result.rejected === "number" ? result.rejected : 0;
    },
    onSuccess: (rejected) => {
      toast.success(
        rejected === 1
          ? "1 lead rejected — nothing from this batch reaches Operations"
          : `${rejected} leads rejected — nothing from this batch reaches Operations`,
      );
      settle();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // The view counts only leads that are still in `pending_import_approval` and
  // unarchived, so a rejected batch — and one whose every lead was excluded on
  // approval — drops out of it entirely. A batch on this list has something
  // left to decide.
  const rows = useMemo(
    () =>
      (batches.data ?? []).flatMap((batch) =>
        batch.import_id ? [{ ...batch, importId: batch.import_id }] : [],
      ),
    [batches.data],
  );

  const busy = approve.isPending || reject.isPending;
  const open = rows.find((row) => row.importId === openId) ?? null;
  const leadRows = leads.data ?? [];
  const flaggedIds = leadRows
    .filter((lead) => dataFlags(lead.data_flags).length > 0)
    .map((lead) => lead.id);
  const allFlaggedExcluded =
    flaggedIds.length > 0 && flaggedIds.every((id) => excluded.includes(id));
  // A refetch can retire a lead mid-selection, so what is sent is always
  // re-derived against the leads actually on screen.
  const rejecting = excluded.filter((id) => leadRows.some((lead) => lead.id === id));
  const accepting = leadRows.length - rejecting.length;
  const loading = batches.isLoading;

  const toggleLead = (id: string, checked: boolean) =>
    setExcluded((current) =>
      checked ? [...new Set([...current, id])] : current.filter((entry) => entry !== id),
    );

  return (
    <section className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-title">Pending imports ({rows.length})</h2>
        <span className="text-[0.66rem] text-muted-foreground">
          Uploaded leads wait here. Nothing reaches Operations until a batch is accepted.
        </span>
      </div>

      {/* A refused read is not an empty queue, and must not be drawn as one. */}
      {batches.error ? (
        <p className="text-xs text-destructive">
          These batches could not be read: {(batches.error as Error).message}
        </p>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>File</TableHead>
            <TableHead>Uploader</TableHead>
            {showIp ? <TableHead>Upload IP</TableHead> : null}
            <TableHead className="text-right">Leads</TableHead>
            <TableHead className="text-right">Flagged</TableHead>
            <TableHead>Uploaded</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.importId}
              className="cursor-pointer"
              aria-expanded={openId === row.importId}
              onClick={() =>
                setOpenId((current) => (current === row.importId ? null : row.importId))
              }
            >
              <TableCell className="font-medium">{row.file_name ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{row.uploader_name ?? "—"}</TableCell>
              {showIp ? (
                <TableCell className="tabular-nums text-muted-foreground">
                  {/* Captured best-effort, and blank on anything uploaded
                      before it was — a dash, never an empty cell. */}
                  {uploadIps.data?.get(row.importId) ?? "—"}
                </TableCell>
              ) : null}
              <TableCell className="text-right tabular-nums">{row.lead_count ?? 0}</TableCell>
              <TableCell
                className={`text-right tabular-nums ${
                  (row.flagged_count ?? 0) > 0 ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {row.flagged_count ?? 0}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.created_at ? relativeTime(row.created_at, now) : "—"}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={showIp ? 6 : 5} className="text-center text-muted-foreground">
                {loading ? "Loading…" : "No imports waiting."}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      {open ? (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="panel-title">
              {open.file_name ?? "This batch"} — {leadRows.length} leads
            </h3>
            {flaggedIds.length > 0 ? (
              <button
                type="button"
                className="chip text-[0.66rem]"
                disabled={busy}
                onClick={() =>
                  setExcluded((current) =>
                    allFlaggedExcluded
                      ? current.filter((id) => !flaggedIds.includes(id))
                      : [...new Set([...current, ...flaggedIds])],
                  )
                }
              >
                {allFlaggedExcluded ? "Clear flagged" : `Exclude ${flaggedIds.length} flagged`}
              </button>
            ) : null}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">Reject</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Flags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leadRows.map((lead) => {
                const flags = dataFlags(lead.data_flags);
                return (
                  <TableRow
                    key={lead.id}
                    className={excluded.includes(lead.id) ? "opacity-60" : ""}
                  >
                    <TableCell className="w-12">
                      <Checkbox
                        aria-label={`Reject ${customerName(lead.payload)}`}
                        disabled={busy}
                        checked={excluded.includes(lead.id)}
                        onCheckedChange={(checked) => toggleLead(lead.id, checked === true)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{customerName(lead.payload)}</TableCell>
                    <TableCell>
                      {flags.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {flags.map((flag) => (
                            <li
                              key={flag.field}
                              className="free-text text-[0.68rem] text-destructive"
                              title={flag.raw ? `Raw: "${flag.raw}"` : undefined}
                            >
                              {flag.issue}
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {leadRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    {leads.isLoading
                      ? "Loading…"
                      : leads.error
                        ? `These leads could not be read: ${(leads.error as Error).message}`
                        : "This batch has already been decided."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-submit"
              disabled={busy || accepting === 0}
              onClick={() => approve.mutate({ importId: open.importId, reject: rejecting })}
            >
              {approve.isPending
                ? "Accepting…"
                : rejecting.length === 0
                  ? "Accept batch"
                  : `Accept ${accepting}, reject ${rejecting.length}`}
            </button>
            <button
              type="button"
              className="chip border-destructive text-destructive"
              disabled={busy || leadRows.length === 0}
              onClick={() => setRejectId(open.importId)}
            >
              Reject entire batch
            </button>
            <span className="text-[0.66rem] text-muted-foreground">
              Rejected leads are archived, not deleted — an admin can restore one from Reporting.
            </span>
          </div>
        </div>
      ) : null}

      <AlertDialog
        open={!!rejectId}
        onOpenChange={(next) => {
          if (!next) {
            setRejectId(null);
            setRejectReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this whole batch?</AlertDialogTitle>
            <AlertDialogDescription>
              Every lead in it is archived and none of them ever reaches Operations. They are not
              deleted — an admin can restore them from the Reporting tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1">
            <label htmlFor="import-reject-reason" className="field-label">
              Reason (optional)
            </label>
            <input
              id="import-reject-reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="Wrong file, unreadable data, duplicate batch…"
              className="field-input"
              maxLength={500}
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reject.isPending}>Cancel</AlertDialogCancel>
            <button
              type="button"
              className="chip justify-center border-destructive text-destructive"
              disabled={reject.isPending}
              onClick={() => {
                if (rejectId) reject.mutate({ importId: rejectId, reason: rejectReason });
              }}
            >
              {reject.isPending ? "Rejecting…" : "Reject batch"}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
