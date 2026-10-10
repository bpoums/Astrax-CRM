import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  STATUS_LABEL,
  customerName,
  dataFlags,
  orderedPayloadEntries,
  payloadDisplayLabel,
  payloadDisplayValue,
  relativeTime,
  useNow,
  type SubStatus,
} from "@/components/ops";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/format-date";
import { LEAD_PAGE_SIZE } from "@/lib/lead-search";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PaginationBar } from "@/components/pagination-bar";
import { LeadPayload } from "@/components/lead-editor";
import { MissingInfoBadge, MissingInfoSection } from "@/components/missing-info";
import { PaymentPanel } from "@/components/payment-panel";
import { DataFlagList } from "@/components/data-flags";
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

type ImportRow = {
  id: string;
  file_name: string | null;
  row_count: number;
  imported_count: number;
  skipped_count: number;
  created_at: string;
  uploader?: { full_name: string | null } | null;
  /**
   * Where the file was uploaded from, captured best-effort when the batch was
   * opened. Null on every batch that predates the column and on any upload
   * where the address could not be read — which is why it is only ever
   * secondary metadata, never something to reason about a batch from.
   */
  upload_ip?: string | null;
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
type DecisionCounts = {
  pending: number;
  approved: number;
  rejected: number;
  /** Not-rejected leads in the batch still missing a required field. */
  missing: number;
  /** Same, for the required banking fields. */
  bank: number;
};

/**
 * Age / State / Zip for the batch leads table below. Same shape as
 * `customerName()` in `ops.tsx` — a single fixed payload key with a safe
 * fallback — kept local since nowhere else needs these three as an export.
 * The keys are the closer form's own field labels (`closer-form.tsx`
 * `SECTIONS`), which are also what an imported lead's payload carries.
 */
function payloadField(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : "—";
}

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

/** A lead as the download needs it — current (possibly corrected) payload,
 *  plus whatever decides its Status column. */
type DownloadLeadRow = {
  import_id: string | null;
  payload: Record<string, unknown> | null;
  status: SubStatus;
  archived_at: string | null;
};

/** One column in the downloaded file, whichever kind it comes from. */
type DownloadColumn = { label: string; get: (row: DownloadLeadRow) => string };

/**
 * The metadata columns every download carries. "Source File" only makes
 * sense — and only appears — when more than one batch is selected, so a row
 * stays traceable to its batch in a combined download.
 */
function metadataColumns(batchById: Map<string, ImportRow>, multiBatch: boolean): DownloadColumn[] {
  const columns: DownloadColumn[] = [];
  if (multiBatch) {
    columns.push({
      label: "Source File",
      get: (row) => (row.import_id && batchById.get(row.import_id)?.file_name) || "—",
    });
  }
  columns.push(
    {
      label: "Status",
      // A rejected lead is archived and left in the import status, so the
      // raw label would read as still waiting — same rule the batch's own
      // lead table above applies.
      get: (row) =>
        row.archived_at && row.status === "pending_import_approval"
          ? "Rejected"
          : STATUS_LABEL[row.status],
    },
    {
      label: "Uploaded On",
      get: (row) => {
        const batch = row.import_id ? batchById.get(row.import_id) : undefined;
        return batch ? formatDate(batch.created_at) : "—";
      },
    },
    {
      label: "Uploader",
      get: (row) => {
        const batch = row.import_id ? batchById.get(row.import_id) : undefined;
        return batch?.uploader?.full_name ?? "—";
      },
    },
  );
  return columns;
}

/**
 * The form fields present on the downloaded leads, as columns — a union
 * across every row, not an intersection, grouped by DISPLAY label so a key
 * the app relabels is offered under the word the reader knows it by. Reads
 * whatever is CURRENTLY in `payload`, corrections included — the same
 * `update_payload_field` that fixed it lives here, so a downloaded file
 * reflects the live record, not a frozen copy of the original upload.
 * Mirrors `exports.tsx`'s `payloadColumns()`; kept local rather than shared
 * since the row shapes differ and the function is small.
 */
function payloadColumns(rows: DownloadLeadRow[]): DownloadColumn[] {
  const order: string[] = [];
  const rawKeysByLabel = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const [rawKey] of orderedPayloadEntries(row.payload ?? {})) {
      const label = payloadDisplayLabel(rawKey);
      if (!rawKeysByLabel.has(label)) {
        rawKeysByLabel.set(label, new Set());
        order.push(label);
      }
      rawKeysByLabel.get(label)?.add(rawKey);
    }
  }
  return order.map((label) => {
    const rawKeys = Array.from(rawKeysByLabel.get(label) ?? []);
    return {
      label,
      get: (row: DownloadLeadRow) => {
        for (const rawKey of rawKeys) {
          const raw = row.payload?.[rawKey];
          if (raw !== null && raw !== undefined && raw !== "") {
            return payloadDisplayValue(rawKey, raw);
          }
        }
        return "";
      },
    };
  });
}

/** Strips the original extension and anything unsafe for a filename. */
function safeFileBase(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-");
}

function fileStamp() {
  return new Date().toISOString().slice(0, 10);
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * An uploader's own batches. RLS scopes every query to uploaded_by = their id,
 * so an uploader sees the leads they imported and no others; the admin view
 * passes `allUploaders` and gets everyone's, with names.
 */
export function ImportHistory({ allUploaders = false }: { allUploaders?: boolean }) {
  const now = useNow(30_000);
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  /** One lead's detail sheet, opened from the batch table below. */
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  /** Narrow the opened batch to the leads still missing a required field. */
  const [missingOnly, setMissingOnly] = useState(false);
  /** Same, for the required banking fields. */
  const [bankOnly, setBankOnly] = useState(false);
  /**
   * `payment_summary` (behind `PaymentPanel`) does not accept `data_uploader`
   * — only admin reaches full read/edit here; an uploader viewing their own
   * batch gets the payload and flags read-only, and no banking panel at all
   * rather than one that would just error.
   */
  const canEditLead = profile?.role === "admin";

  /**
   * The upload address is admin-only, and gated on the role rather than on
   * `allUploaders` — a manager reaches this list too. RLS lets both of them
   * read the row, so this decides who is shown the column.
   */
  const showIp = profile?.role === "admin";

  /** Same gate as `canEditLead`/`showIp` — admin only. Batch download reads
   *  every selected batch's full lead payload in one go, which is the kind
   *  of access already reserved for admin everywhere else on this screen. */
  const canDownload = profile?.role === "admin";
  /**
   * The row object, not just the id — same reasoning `exports.tsx` already
   * documents for its own selection: paging away from a selected batch must
   * not lose what the download needs to know about it (file name, uploader,
   * uploaded-on), the way it would if this only tracked ids and looked them
   * up in the current page's rows.
   */
  const [selected, setSelected] = useState<Map<string, ImportRow>>(new Map());
  const [downloading, setDownloading] = useState<"csv" | "excel" | null>(null);
  const [page, setPage] = useState(0);

  const imports = useQuery({
    // `showIp` is part of the key: the two variants fetch different columns,
    // and a cached row without upload_ip must not be served to an admin.
    queryKey: ["lead-imports", allUploaders, showIp, page],
    queryFn: async () => {
      const columns = [
        "id",
        "file_name",
        "row_count",
        "imported_count",
        "skipped_count",
        "created_at",
      ];
      if (allUploaders) {
        columns.push("uploader:profiles!lead_imports_uploaded_by_fkey(full_name)");
      }
      if (showIp) columns.push("upload_ip");
      const from = page * LEAD_PAGE_SIZE;
      const { data, error, count } = await supabase
        .from("lead_imports")
        .select(columns.join(", "), { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, from + LEAD_PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as unknown as ImportRow[], total: count ?? 0 };
    },
  });

  const rows = useMemo(() => imports.data?.rows ?? [], [imports.data]);
  const total = imports.data?.total ?? 0;
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);

  const selectedBatches = useMemo(() => Array.from(selected.values()), [selected]);
  // "Select all" reflects THIS page, same as Exports' own toggleAllFiltered —
  // a batch on another page is either already selected or not, but this
  // control only ever acts on what's currently on screen.
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  function toggleBatch(row: ImportRow) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  }

  function toggleAllBatches() {
    setSelected((prev) => {
      const pageFullySelected = rows.length > 0 && rows.every((row) => prev.has(row.id));
      const next = new Map(prev);
      for (const row of rows) {
        if (pageFullySelected) next.delete(row.id);
        else next.set(row.id, row);
      }
      return next;
    });
  }

  /**
   * Every lead tagged with any of the selected batches, current payload
   * included — corrections and all. Not paginated: a batch is capped at 200
   * leads at ingest time, so even a selection spanning every page stays a
   * single bounded request, the same tolerance `SalesBreakdown` and
   * `Exports` already accept for their own unpaginated reads.
   */
  async function downloadSelectedBatches(format: "csv" | "excel") {
    const batchIds = Array.from(selected.keys());
    if (batchIds.length === 0) return;
    setDownloading(format);
    try {
      const { data, error } = await supabase
        .from("submissions")
        .select("import_id, payload, status, archived_at")
        .in("import_id", batchIds)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const leadRows = (data ?? []) as unknown as DownloadLeadRow[];

      const multiBatch = batchIds.length > 1;
      const columns = [...metadataColumns(selected, multiBatch), ...payloadColumns(leadRows)];
      const records = leadRows.map((row) => {
        const record: Record<string, string> = {};
        for (const column of columns) record[column.label] = column.get(row);
        return record;
      });

      const fileBase =
        batchIds.length === 1
          ? safeFileBase(selectedBatches[0]?.file_name ?? "lead-import")
          : `lead-imports-${fileStamp()}`;

      if (format === "csv") {
        const csv = Papa.unparse(records);
        // A BOM, so Excel — the thing most people open a .csv in — reads it
        // as UTF-8 instead of guessing and mangling any accented name.
        const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
        triggerDownload(blob, `${fileBase}.csv`);
      } else {
        const sheet = XLSX.utils.json_to_sheet(records);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheet, "Leads");
        XLSX.writeFile(workbook, `${fileBase}.xlsx`);
      }

      toast.success(
        `Downloaded ${records.length} lead${records.length === 1 ? "" : "s"} from ${batchIds.length} batch${batchIds.length === 1 ? "" : "es"} as ${format === "csv" ? "CSV" : "Excel"}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Download failed");
    } finally {
      setDownloading(null);
    }
  }

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
        .select("import_id, status, archived_at, missing_info, missing_bank")
        .in("import_id", ids);
      if (error) throw error;
      const counts = new Map<string, DecisionCounts>();
      for (const row of data ?? []) {
        if (!row.import_id) continue;
        const entry = counts.get(row.import_id) ?? {
          pending: 0,
          approved: 0,
          rejected: 0,
          missing: 0,
          bank: 0,
        };
        if (row.status !== "pending_import_approval") entry.approved += 1;
        else if (row.archived_at) entry.rejected += 1;
        else entry.pending += 1;
        // A rejected lead is archived and will never be worked, so a gap in it
        // is not work to do.
        if (!row.archived_at && (row.missing_info?.length ?? 0) > 0) entry.missing += 1;
        if (!row.archived_at && (row.missing_bank?.length ?? 0) > 0) entry.bank += 1;
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
        .select(
          "id, payload, status, archived_at, created_at, data_flags, missing_info, missing_bank",
        )
        .eq("import_id", openId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Found in the already-loaded batch, not a second fetch by id — the same
  // row `leads` just queried carries everything the sheet needs.
  const selectedLead = (leads.data ?? []).find((lead) => lead.id === selectedLeadId) ?? null;
  const allLeads = leads.data ?? [];
  const missingLeads = allLeads.filter((lead) => (lead.missing_info?.length ?? 0) > 0);
  const bankLeads = allLeads.filter((lead) => (lead.missing_bank?.length ?? 0) > 0);
  const shownLeads = allLeads.filter(
    (lead) =>
      (!missingOnly || (lead.missing_info?.length ?? 0) > 0) &&
      (!bankOnly || (lead.missing_bank?.length ?? 0) > 0),
  );
  const narrowed = missingOnly || bankOnly;

  return (
    <section className="panel">
      <h2 className="panel-title">
        {allUploaders ? "Lead imports" : "My imports"} ({total})
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            {canDownload ? (
              <TableHead className="w-8">
                <Checkbox
                  aria-label="Select all batches"
                  disabled={rows.length === 0}
                  checked={allSelected}
                  onCheckedChange={toggleAllBatches}
                />
              </TableHead>
            ) : null}
            <TableHead>File</TableHead>
            {allUploaders ? <TableHead>Uploader</TableHead> : null}
            {showIp ? <TableHead>Upload IP</TableHead> : null}
            <TableHead className="text-right">Rows</TableHead>
            <TableHead className="text-right">Imported</TableHead>
            <TableHead className="text-right">Skipped</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead className="text-right">Missing info</TableHead>
            <TableHead className="text-right">Missing bank</TableHead>
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
              {canDownload ? (
                <TableCell onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    aria-label={`Select ${row.file_name ?? "this batch"}`}
                    checked={selected.has(row.id)}
                    onCheckedChange={() => toggleBatch(row)}
                  />
                </TableCell>
              ) : null}
              <TableCell className="font-medium">{row.file_name ?? "—"}</TableCell>
              {allUploaders ? (
                <TableCell className="text-muted-foreground">
                  {row.uploader?.full_name ?? "—"}
                </TableCell>
              ) : null}
              {showIp ? (
                <TableCell className="tabular-nums text-muted-foreground">
                  {row.upload_ip ?? "—"}
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
              <TableCell
                className={`text-right tabular-nums ${
                  (decisions.data?.get(row.id)?.missing ?? 0) > 0
                    ? "text-accent"
                    : "text-muted-foreground"
                }`}
              >
                {decisions.data ? (decisions.data.get(row.id)?.missing ?? 0) : "…"}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {decisions.data ? (decisions.data.get(row.id)?.bank ?? 0) : "…"}
              </TableCell>
              <TableCell className="text-muted-foreground" title={relativeTime(row.created_at, now)}>
                {formatDate(row.created_at)}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={(allUploaders ? 9 : 8) + (showIp ? 1 : 0) + (canDownload ? 1 : 0)}
                className="text-center text-muted-foreground"
              >
                {imports.isLoading ? "Loading…" : "No imports yet."}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <PaginationBar
        page={page}
        pageSize={LEAD_PAGE_SIZE}
        shown={rows.length}
        total={total}
        busy={imports.isFetching}
        onPage={setPage}
      />

      {canDownload ? (
        <section
          className={`panel flex flex-wrap items-center justify-between gap-3 border transition-colors duration-300 ${
            selected.size > 0 ? "border-accent/60" : "border-border"
          }`}
        >
          <div>
            <span className="font-display text-2xl font-semibold tracking-tight">
              {selected.size}
            </span>
            <span className="ml-1.5 text-xs text-muted-foreground">
              {selected.size === 1
                ? `batch selected — ${selectedBatches[0]?.imported_count ?? 0} leads`
                : `batches selected — ${selectedBatches.reduce((sum, row) => sum + row.imported_count, 0)} leads`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="chip"
              disabled={selected.size === 0 || downloading !== null}
              onClick={() => downloadSelectedBatches("excel")}
            >
              {downloading === "excel" ? "Downloading…" : "Download Excel"}
            </button>
            <button
              type="button"
              className="btn-submit"
              disabled={selected.size === 0 || downloading !== null}
              onClick={() => downloadSelectedBatches("csv")}
            >
              {downloading === "csv" ? "Downloading…" : "Download CSV"}
            </button>
          </div>
        </section>
      ) : null}

      {openId ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="panel-title">
              Leads in this batch ({shownLeads.length}
              {narrowed ? ` of ${allLeads.length}` : ""})
            </h3>
            <button
              type="button"
              onClick={() => setMissingOnly((prev) => !prev)}
              aria-pressed={missingOnly}
              className={`chip px-2.5 py-0.5 text-[0.66rem] ${missingOnly ? "chip-active" : ""}`}
              title="Leads in this batch that are missing a required field"
            >
              Missing info ({missingLeads.length})
            </button>
            <button
              type="button"
              onClick={() => setBankOnly((prev) => !prev)}
              aria-pressed={bankOnly}
              className={`chip px-2.5 py-0.5 text-[0.66rem] ${bankOnly ? "chip-active" : ""}`}
              title="Leads in this batch that are missing a required banking field"
            >
              Missing bank info ({bankLeads.length})
            </button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Age</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Zip</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Flags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownLeads.map((lead) => {
                const flags = dataFlags(lead.data_flags);
                const payload = (lead.payload ?? {}) as Record<string, unknown>;
                return (
                  <TableRow
                    key={lead.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedLeadId(lead.id)}
                  >
                    <TableCell className="font-medium">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span>{customerName(payload)}</span>
                        <MissingInfoBadge missing={lead.missing_info} bank={lead.missing_bank} />
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {payloadField(payload, "Age")}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {payloadField(payload, "State")}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {payloadField(payload, "Customer Zip Code")}
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
              {shownLeads.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {leads.isLoading
                      ? "Loading…"
                      : narrowed
                        ? "No lead in this batch matches those missing-information filters."
                        : "No leads found for this batch."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <Sheet
        open={!!selectedLead}
        onOpenChange={(open) => {
          if (!open) setSelectedLeadId(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto overflow-x-hidden sm:max-w-xl">
          {selectedLead ? (
            <>
              <SheetHeader>
                <SheetTitle>
                  {customerName((selectedLead.payload ?? {}) as Record<string, unknown>)}
                </SheetTitle>
                <SheetDescription>
                  {selectedLead.archived_at && selectedLead.status === "pending_import_approval"
                    ? "Rejected"
                    : STATUS_LABEL[selectedLead.status]}{" "}
                  · imported {relativeTime(selectedLead.created_at, now)}
                </SheetDescription>
              </SheetHeader>

              <div className="flex min-w-0 max-w-full flex-col gap-4 px-4 pb-4">
                <MissingInfoSection
                  submissionId={selectedLead.id}
                  missing={selectedLead.missing_info}
                  missingBank={selectedLead.missing_bank}
                  editable={canEditLead}
                  onSaved={() => {
                    void queryClient.invalidateQueries({
                      queryKey: ["lead-imports", "leads", openId],
                    });
                  }}
                />

                <LeadPayload
                  submissionId={selectedLead.id}
                  payload={(selectedLead.payload ?? {}) as Record<string, unknown>}
                  editable={canEditLead}
                  onSaved={() => {
                    void queryClient.invalidateQueries({
                      queryKey: ["lead-imports", "leads", openId],
                    });
                  }}
                />

                <DataFlagList
                  submissionId={selectedLead.id}
                  payload={(selectedLead.payload ?? {}) as Record<string, unknown>}
                  flags={dataFlags(selectedLead.data_flags)}
                  editable={canEditLead}
                />

                {/* payment_summary refuses data_uploader outright — only
                    shown where it will actually resolve. */}
                {canEditLead ? (
                  <PaymentPanel submissionId={selectedLead.id} editable={canEditLead} />
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
