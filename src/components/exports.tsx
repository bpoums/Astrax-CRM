import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  carrierName,
  closerName,
  customerName,
  dispositionLabel,
  orderedPayloadEntries,
  payloadDisplayLabel,
  payloadDisplayValue,
  STATUS_LABEL,
  type SubmissionRow,
} from "@/components/ops";
import { formatCalendarDate, formatDate } from "@/lib/format-date";
import {
  carrierSearchClauses,
  customerNameSearchClause,
  draftDateSearchClauses,
  sanitizeTerm,
} from "@/lib/lead-search";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ExportRow = SubmissionRow & {
  closer: { full_name: string | null } | null;
  uploader: { full_name: string | null; org_name: string | null } | null;
  /**
   * The carrier the lead was actually placed with — set during review, not at
   * submission (see `final_carrier_id` on `SubmissionRow`). Never populated
   * on a validator-submitted lead, which auto-closes without going through
   * one, so this reads as a dash for those rows and that is correct.
   */
  final_carrier: { name: string | null } | null;
};

/** One pickable export column, whichever kind it comes from. */
type Column = { key: string; label: string; get: (row: ExportRow) => string };

/**
 * Fields the submission carries itself, not typed into a form — so they exist
 * on every row regardless of which of the two forms produced it.
 */
const METADATA_COLUMNS: Column[] = [
  { key: "__closer", label: "Submitted By", get: (row) => closerName(row) },
  {
    key: "__final_carrier",
    label: "Final Carrier Name",
    get: (row) => row.final_carrier?.name ?? "—",
  },
  { key: "__agent", label: "Agent Name", get: (row) => row.agent_name ?? "—" },
  { key: "__policy", label: "Policy Number", get: (row) => row.policy_number ?? "—" },
  { key: "__center", label: "Center", get: (row) => row.center_name ?? "—" },
  { key: "__status", label: "Status", get: (row) => STATUS_LABEL[row.status] },
  {
    key: "__disposition",
    label: "Disposition",
    get: (row) => dispositionLabel(row.disposition) ?? "—",
  },
  { key: "__submitted", label: "Submitted Date", get: (row) => formatDate(row.created_at) },
];

/**
 * The form fields present on the checked leads, as export columns — a union
 * across every selected row, not an intersection, so checking a closer lead
 * and a validator lead offers every field either one carries.
 *
 * Grouped by DISPLAY label rather than raw key: "Agency" and "Carrier Name"
 * are the same idea under two different stored keys (see `CARRIER_KEYS` /
 * `payloadDisplayLabel`), and a picker offering both as separate options would
 * just be the same column asked for twice.
 */
function payloadColumns(rows: ExportRow[]): Column[] {
  const order: string[] = [];
  const rawKeysByLabel = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const [rawKey] of orderedPayloadEntries(row.payload)) {
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
      key: label,
      label,
      get: (row: ExportRow) => {
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

const EXPORTS_KEY = ["admin", "exports"];

/**
 * The Exports tab. Every submitted (accepted) lead, filterable down to a
 * handful, then downloadable as exactly the columns asked for and nothing
 * else — no write path anywhere in this file, it only ever reads and then
 * builds a file in the browser.
 */
export function Exports() {
  const [carrierSearch, setCarrierSearch] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [draftDate, setDraftDate] = useState("");
  // The row itself, not just its id — a change of filter can drop a selected
  // lead out of `rows` entirely, and losing its data at that point would mean
  // losing it from the export silently rather than just from view.
  const [selected, setSelected] = useState<Map<string, ExportRow>>(new Map());
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());

  const carrierTerm = sanitizeTerm(carrierSearch);
  const customerTerm = sanitizeTerm(customerSearch);

  const leads = useQuery({
    queryKey: [...EXPORTS_KEY, carrierTerm, customerTerm, draftDate],
    queryFn: async () => {
      let query = supabase
        .from("submissions")
        .select(
          "*, closer:profiles!submissions_closer_id_fkey(full_name), uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name), final_carrier:carriers!submissions_final_carrier_id_fkey(name)",
        )
        .eq("disposition", "accepted")
        .is("archived_at", null);

      // Independent `or` groups, so each filter narrows rather than competes —
      // the same composition SubmissionsExplorer uses.
      if (carrierTerm) query = query.or(carrierSearchClauses(carrierTerm).join(","));
      if (customerTerm) query = query.or(customerNameSearchClause(customerTerm));
      if (draftDate) query = query.or(draftDateSearchClauses(draftDate).join(","));

      const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as ExportRow[];
    },
  });

  const rows = useMemo(() => leads.data ?? [], [leads.data]);
  const selectedRows = useMemo(() => Array.from(selected.values()), [selected]);
  const displayRows = showSelectedOnly ? selectedRows : rows;

  const formFieldColumns = useMemo(() => payloadColumns(selectedRows), [selectedRows]);
  const availableColumns = useMemo(
    () => [...METADATA_COLUMNS, ...formFieldColumns],
    [formFieldColumns],
  );
  // A column picked while a lead that offered it was checked stays picked even
  // if that lead is then unchecked — losing the choice the moment the one lead
  // that happened to have the field is deselected would be a worse surprise
  // than an option that no longer does anything.
  const activeColumns = availableColumns.filter((column) => selectedColumns.has(column.key));

  function toggleLead(row: ExportRow) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelected((prev) => {
      const allSelected = rows.length > 0 && rows.every((row) => prev.has(row.id));
      const next = new Map(prev);
      for (const row of rows) {
        if (allSelected) next.delete(row.id);
        else next.set(row.id, row);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Map());
    setShowSelectedOnly(false);
  }

  function toggleColumn(key: string) {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function buildExportRecords() {
    return selectedRows.map((row) => {
      const record: Record<string, string> = {};
      for (const column of activeColumns) record[column.label] = column.get(row);
      return record;
    });
  }

  function downloadCsv() {
    const records = buildExportRecords();
    const csv = Papa.unparse(records);
    // A BOM, so Excel — the thing most people open a .csv in — reads it as
    // UTF-8 instead of guessing and mangling any accented name.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, `leads-export-${fileStamp()}.csv`);
    toast.success(`Exported ${records.length} lead${records.length === 1 ? "" : "s"} as CSV`);
  }

  function downloadExcel() {
    const records = buildExportRecords();
    const sheet = XLSX.utils.json_to_sheet(records);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Leads");
    XLSX.writeFile(workbook, `leads-export-${fileStamp()}.xlsx`);
    toast.success(`Exported ${records.length} lead${records.length === 1 ? "" : "s"} as Excel`);
  }

  const allFilteredSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const ready = selectedRows.length > 0 && activeColumns.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="panel">
        <h2 className="panel-title">Filter leads</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="export-carrier" className="field-label">
              Carrier name
            </label>
            <input
              id="export-carrier"
              type="text"
              value={carrierSearch}
              onChange={(e) => setCarrierSearch(e.target.value)}
              placeholder="e.g. Fidelity"
              className="field-input h-8 w-48 text-xs"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="export-customer" className="field-label">
              Customer name
            </label>
            <input
              id="export-customer"
              type="text"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              placeholder="e.g. Maria Gomez"
              className="field-input h-8 w-48 text-xs"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="export-draft-date" className="field-label">
              Draft date
            </label>
            <input
              id="export-draft-date"
              type="date"
              value={draftDate}
              onChange={(e) => setDraftDate(e.target.value)}
              className="field-input h-8 w-40 text-xs"
            />
          </div>
          {carrierTerm || customerTerm || draftDate ? (
            <button
              type="button"
              className="chip"
              onClick={() => {
                setCarrierSearch("");
                setCustomerSearch("");
                setDraftDate("");
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="panel-title">
            Submitted leads ({rows.length}
            {rows.length >= 500 ? "+" : ""})
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            {selectedRows.length > 0 ? (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={showSelectedOnly}
                  onCheckedChange={(checked) => setShowSelectedOnly(checked === true)}
                />
                Show selected only
              </label>
            ) : null}
            {rows.length > 0 ? (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={allFilteredSelected} onCheckedChange={toggleAllFiltered} />
                Select all filtered
              </label>
            ) : null}
          </div>
        </div>

        {/* The whole reason this exists: checking a lead on page one of a long
            filtered list and then scrolling past it leaves no way to find it
            again short of scrolling back — this puts every current pick in
            view, wherever it sits in the list, and clicking one drops it. */}
        {selectedRows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
            <span className="field-label mr-1">Selected ({selectedRows.length})</span>
            {selectedRows.map((row) => (
              <button
                key={row.id}
                type="button"
                title="Remove from selection"
                onClick={() => toggleLead(row)}
                className="chip chip-active"
              >
                {customerName(row.payload)}
                <span aria-hidden className="ml-1.5 text-muted-foreground">
                  ×
                </span>
              </button>
            ))}
            <button type="button" className="chip" onClick={clearSelection}>
              Clear all
            </button>
          </div>
        ) : null}

        {/* `Table` wraps itself in its own scrolling div — capping height and
            hiding the scrollbar on THAT div, not this one, is what makes it the
            actual scrolling ancestor the sticky header sticks against. Doing it
            on an outer div here left the header sticking to a container that
            never scrolls, so it just drifted with the page. */}
        <div className="[&>div]:no-scrollbar [&>div]:max-h-[50vh] [&>div]:overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10">
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Customer</TableHead>
                <TableHead>Carrier</TableHead>
                <TableHead className="w-32">Draft Date</TableHead>
                <TableHead>Submitted By</TableHead>
                <TableHead className="w-40">Center</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayRows.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => toggleLead(row)}>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(row.id)}
                      onCheckedChange={() => toggleLead(row)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                  <TableCell>{carrierName(row.payload)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatCalendarDate(
                      (row.payload?.["Draft Date"] as string | undefined) ?? null,
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{closerName(row)}</TableCell>
                  <TableCell className="text-muted-foreground">{row.center_name ?? "—"}</TableCell>
                </TableRow>
              ))}
              {displayRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {leads.isLoading
                      ? "Loading…"
                      : showSelectedOnly
                        ? "Nothing selected yet."
                        : "No submitted leads match these filters."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className={selectedRows.length === 0 ? "panel opacity-60" : "panel"}>
        <h2 className="panel-title">Choose columns</h2>
        {selectedRows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Check one or more leads above to see the fields available on them.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="field-label mr-1">Lead details</span>
              {METADATA_COLUMNS.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  onClick={() => toggleColumn(column.key)}
                  aria-pressed={selectedColumns.has(column.key)}
                  className={selectedColumns.has(column.key) ? "chip chip-active" : "chip"}
                >
                  {column.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="field-label mr-1">Form fields</span>
              {formFieldColumns.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  onClick={() => toggleColumn(column.key)}
                  aria-pressed={selectedColumns.has(column.key)}
                  className={selectedColumns.has(column.key) ? "chip chip-active" : "chip"}
                >
                  {column.label}
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      {/* The one deliberate bit of motion here: the border warms from muted to
          amber the moment there is something real to export, rather than the
          buttons simply switching from disabled to enabled with no signal. */}
      <section
        className={`panel flex flex-wrap items-center justify-between gap-3 border transition-colors duration-300 ${
          ready ? "border-accent/60" : "border-border"
        }`}
      >
        <div>
          <span className="font-display text-2xl font-semibold tracking-tight">
            {selectedRows.length}
          </span>
          <span className="text-sm text-muted-foreground">
            {" "}
            lead{selectedRows.length === 1 ? "" : "s"}
          </span>
          <span className="text-muted-foreground"> · </span>
          <span className="font-display text-2xl font-semibold tracking-tight">
            {activeColumns.length}
          </span>
          <span className="text-sm text-muted-foreground">
            {" "}
            column{activeColumns.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="chip" disabled={!ready} onClick={downloadExcel}>
            Download Excel
          </button>
          <button type="button" className="btn-submit" disabled={!ready} onClick={downloadCsv}>
            Download CSV
          </button>
        </div>
      </section>
    </div>
  );
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
