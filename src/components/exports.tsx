import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  CenterBadge,
  OriginBadge,
  closerName,
  customerName,
  dataFlags,
  dispositionLabel,
  finalCarrierName,
  isOnHold,
  orderedPayloadEntries,
  payloadDisplayLabel,
  payloadDisplayValue,
  relativeTime,
  sourceLabel,
  useNow,
  DISPOSITIONS,
  STATUS_LABEL,
  SUB_STATUSES,
  DispositionBadge,
  QueueStatusBadge,
  type SubmissionRow,
} from "@/components/ops";
import { useDeclinedCarrierMap } from "@/lib/carriers";
import { useCenterColorById, useCenters } from "@/lib/centers";
import { CATEGORY_LABEL, CX_CATEGORIES, useCxStatusOptions } from "@/lib/cx-status";
import { formatCalendarDate, formatDate } from "@/lib/format-date";
import {
  ANY,
  ARCHIVED_LABEL,
  ARCHIVED_MODES,
  NOT_SET,
  NO_FILTERS,
  ORIGINS,
  ORIGIN_LABEL,
  buildExportQuery,
  countActiveFilters,
  filtersKey,
  type ExportFilters,
} from "@/lib/export-filters";
import { Checkbox } from "@/components/ui/checkbox";
import { PaginationBar } from "@/components/pagination-bar";
import { DataFlagList } from "@/components/data-flags";
import { LeadPayload } from "@/components/lead-editor";
import { MissingInfoSection } from "@/components/missing-info";
import { PaymentPanel } from "@/components/payment-panel";
import { SubmissionTags } from "@/components/submission-tags";
import { PayloadEditHistory, payloadHistoryKey } from "@/components/payload-history";
import { CarrierDeclineList } from "@/components/carrier-declines";
import { validationTimelineKey } from "@/components/validation-timeline";
import { LeadHistoryDialog } from "@/components/lead-history-dialog";
import { ValidatorFields } from "@/components/validator-fields";
import { History } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 50;
/** PostgREST returns at most 1,000 rows a request, so "select all" reads in chunks. */
const CHUNK = 1000;
const ROW_SELECT =
  "*, closer:profiles!submissions_closer_id_fkey(full_name), uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name), final_carrier:carriers!submissions_final_carrier_id_fkey(name)";

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
 * Grouped by DISPLAY label rather than raw key, so a key the app relabels is
 * offered under the word the reader knows it by (see `payloadDisplayLabel`).
 *
 * Since 2026-09-15 that grouping no longer merges the carrier keys, and should
 * not: "Agency" now reads as "Final Carrier" and a closer's key is "Proposed
 * Carrier", which are two genuinely different facts about a lead rather than
 * one idea stored two ways. They correctly offer as two separate columns.
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
 * The Exports tab. Every lead, submitted or not, filterable by everything the
 * CRM filters by, paged, openable, then downloadable as exactly the columns asked
 * for and nothing else. It only ever reads (the detail panel's own edit controls
 * write through their usual RPCs) and builds the file in the browser.
 */
export function Exports() {
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const centerColorById = useCenterColorById();
  const centers = useCenters(false);
  const vocabulary = useCxStatusOptions(false);
  // Names the carriers on a returned lead, as the other lead tables do.
  const declinedMap = useDeclinedCarrierMap();

  const [filters, setFilters] = useState<ExportFilters>(NO_FILTERS);
  const [page, setPage] = useState(0);
  const [showCx, setShowCx] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // The row itself, not just its id — paging or a change of filter can drop a
  // selected lead out of the current page entirely, and losing its data at that
  // point would mean losing it from the export silently rather than just from view.
  const [selected, setSelected] = useState<Map<string, ExportRow>>(new Map());
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [gathering, setGathering] = useState<{ done: number; total: number } | null>(null);

  const key = filtersKey(filters);
  const active = countActiveFilters(filters);

  // Any filter changes what page 1 even means.
  useEffect(() => {
    setPage(0);
  }, [key]);

  function patch(next: Partial<ExportFilters>) {
    setFilters((current) => ({ ...current, ...next }));
  }

  const leads = useQuery({
    queryKey: [...EXPORTS_KEY, page, key],
    queryFn: async () => {
      const { query } = await buildExportQuery(filters, {
        select: ROW_SELECT,
        count: "exact",
        cxByCategory: vocabulary.byCategory,
      });
      const from = page * PAGE_SIZE;
      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as unknown as ExportRow[], total: count ?? 0 };
    },
  });

  // Counted over THIS tab's scope (submitted, not archived), not taken from
  // `missing_info_by_field()`: that function counts every non-archived lead,
  // including ones never submitted, so its numbers promised leads this table can
  // never show. Only leads with a gap are read, so the set is small.
  const missingByField = useQuery({
    queryKey: [...EXPORTS_KEY, "missing-by-field"],
    queryFn: () => missingTally("missing_info"),
  });
  const bankByField = useQuery({
    queryKey: [...EXPORTS_KEY, "missing-bank-by-field"],
    queryFn: () => missingTally("missing_bank"),
  });

  const rows = useMemo(() => leads.data?.rows ?? [], [leads.data]);
  const total = leads.data?.total ?? 0;
  const selectedRows = useMemo(() => Array.from(selected.values()), [selected]);
  const displayRows = showSelectedOnly ? selectedRows : rows;
  const open = displayRows.find((row) => row.id === openId) ?? selected.get(openId ?? "") ?? null;

  // A lead corrected in the panel is refetched; keep the held copy in step so the
  // export carries the corrected value rather than the one first ticked.
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const row of rows) {
        if (next.has(row.id) && next.get(row.id) !== row) {
          next.set(row.id, row);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

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

  const pageFullySelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  function togglePage() {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const row of rows) {
        if (pageFullySelected) next.delete(row.id);
        else next.set(row.id, row);
      }
      return next;
    });
  }

  /**
   * Every lead matching the current filters, not just this page. Read in chunks
   * because a request returns at most 1,000 rows; the query is rebuilt per chunk
   * (a builder is single-use) with a stable order so no row is read twice.
   */
  async function selectAllMatching() {
    setGathering({ done: 0, total });
    try {
      const all: ExportRow[] = [];
      for (let from = 0; from < total; from += CHUNK) {
        const { query } = await buildExportQuery(filters, {
          select: ROW_SELECT,
          cxByCategory: vocabulary.byCategory,
        });
        const { data, error } = await query
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, from + CHUNK - 1);
        if (error) throw error;
        all.push(...((data ?? []) as unknown as ExportRow[]));
        setGathering({ done: all.length, total });
      }
      setSelected((prev) => {
        const next = new Map(prev);
        for (const row of all) next.set(row.id, row);
        return next;
      });
      toast.success(`Selected ${all.length} lead${all.length === 1 ? "" : "s"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not select all leads");
    } finally {
      setGathering(null);
    }
  }

  function clearSelection() {
    setSelected(new Map());
    setShowSelectedOnly(false);
  }

  function toggleColumn(columnKey: string) {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(columnKey)) next.delete(columnKey);
      else next.add(columnKey);
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

  const ready = selectedRows.length > 0 && activeColumns.length > 0;

  // What is applied, in words, each removable — so the slice being looked at is
  // always readable without scanning the controls.
  const centerName = (id: string) => centers.data?.find((entry) => entry.id === id)?.name ?? id;
  const cxLabel = (category: (typeof CX_CATEGORIES)[number], code: string) =>
    vocabulary.byCategory[category].find((entry) => entry.code === code)?.label ?? code;
  const dateText = (from: string, to: string) =>
    !to || to === from ? from : from ? `${from} → ${to}` : `until ${to}`;
  const appliedChips: { id: string; label: string; clear: () => void }[] = [];
  if (filters.search.trim())
    appliedChips.push({
      id: "search",
      label: `Search: ${filters.search.trim()}`,
      clear: () => patch({ search: "" }),
    });
  if (filters.bank.trim())
    appliedChips.push({
      id: "bank",
      label: `Bank: ${filters.bank.trim()}`,
      clear: () => patch({ bank: "" }),
    });
  if (filters.disposition !== ANY)
    appliedChips.push({
      id: "disposition",
      label: `Disposition: ${
        filters.disposition === NOT_SET
          ? "not disposed"
          : (dispositionLabel(filters.disposition) ?? filters.disposition)
      }`,
      clear: () => patch({ disposition: ANY }),
    });
  if (filters.status !== ANY)
    appliedChips.push({
      id: "status",
      label: `Status: ${STATUS_LABEL[filters.status]}`,
      clear: () => patch({ status: ANY }),
    });
  if (filters.archived !== "hide")
    appliedChips.push({
      id: "archived",
      label: ARCHIVED_LABEL[filters.archived],
      clear: () => patch({ archived: "hide" }),
    });
  if (filters.proposedCarrier.trim())
    appliedChips.push({
      id: "proposed",
      label: `Proposed carrier: ${filters.proposedCarrier.trim()}`,
      clear: () => patch({ proposedCarrier: "" }),
    });
  if (filters.finalCarrier.trim())
    appliedChips.push({
      id: "final",
      label: `Final carrier: ${filters.finalCarrier.trim()}`,
      clear: () => patch({ finalCarrier: "" }),
    });
  if (filters.origin !== ANY)
    appliedChips.push({
      id: "origin",
      label: `Submitted by: ${ORIGIN_LABEL[filters.origin as keyof typeof ORIGIN_LABEL]}`,
      clear: () => patch({ origin: ANY }),
    });
  if (filters.center !== ANY)
    appliedChips.push({
      id: "center",
      label: `Center: ${filters.center === NOT_SET ? "none" : centerName(filters.center)}`,
      clear: () => patch({ center: ANY }),
    });
  if (filters.missing !== ANY)
    appliedChips.push({
      id: "missing",
      label: `Missing: ${filters.missing === NOT_SET ? "any field" : filters.missing}`,
      clear: () => patch({ missing: ANY }),
    });
  if (filters.missingBank !== ANY)
    appliedChips.push({
      id: "missingBank",
      label: `Missing bank: ${filters.missingBank === NOT_SET ? "any field" : filters.missingBank}`,
      clear: () => patch({ missingBank: ANY }),
    });
  for (const category of CX_CATEGORIES) {
    const value = filters.cx[category];
    if (value === ANY) continue;
    appliedChips.push({
      id: `cx-${category}`,
      label: `${CATEGORY_LABEL[category]}: ${value === NOT_SET ? "not set" : cxLabel(category, value)}`,
      clear: () => patch({ cx: { ...filters.cx, [category]: ANY } }),
    });
  }
  if (filters.submittedFrom || filters.submittedTo)
    appliedChips.push({
      id: "submitted",
      label: `Submitted on: ${dateText(filters.submittedFrom, filters.submittedTo)}`,
      clear: () => patch({ submittedFrom: "", submittedTo: "" }),
    });
  if (filters.saleFrom || filters.saleTo)
    appliedChips.push({
      id: "sale",
      label: `Sale made on: ${dateText(filters.saleFrom, filters.saleTo)}`,
      clear: () => patch({ saleFrom: "", saleTo: "" }),
    });
  if (filters.draftFrom || filters.draftTo)
    appliedChips.push({
      id: "draft",
      label: `Draft date: ${dateText(filters.draftFrom, filters.draftTo)}`,
      clear: () => patch({ draftFrom: "", draftTo: "" }),
    });
  if (filters.ageFrom || filters.ageTo)
    appliedChips.push({
      id: "age",
      label: `Age: ${dateText(filters.ageFrom, filters.ageTo)}`,
      clear: () => patch({ ageFrom: "", ageTo: "" }),
    });

  const dateInput = "field-input h-8 min-w-0 flex-1 text-xs";

  return (
    <div className="flex flex-col gap-4">
      <section className="panel">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="panel-title">Filter leads</h2>
          <span className="text-[0.66rem] text-muted-foreground">
            Every lead, submitted or not. Each filter narrows the others.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={filters.search}
            onChange={(event) => patch({ search: event.target.value })}
            placeholder="Search customer, closer, phone, SSN, policy #…"
            className="field-input min-w-64 flex-1"
            aria-label="Search leads"
          />
          <input
            type="search"
            value={filters.bank}
            onChange={(event) => patch({ bank: event.target.value })}
            placeholder="Bank name…"
            className="field-input w-44 shrink-0"
            aria-label="Bank name"
          />
          <input
            type="search"
            value={filters.proposedCarrier}
            onChange={(event) => patch({ proposedCarrier: event.target.value })}
            placeholder="Proposed carrier…"
            className="field-input w-44 shrink-0"
            aria-label="Carrier the closer proposed"
          />
          <input
            type="search"
            value={filters.finalCarrier}
            onChange={(event) => patch({ finalCarrier: event.target.value })}
            placeholder="Final carrier…"
            className="field-input w-44 shrink-0"
            aria-label="Carrier the policy was written on"
          />
          {active > 0 ? (
            <button
              type="button"
              className="chip shrink-0 px-2.5 py-0.5 text-[0.66rem]"
              onClick={() => setFilters(NO_FILTERS)}
            >
              Clear all ({active})
            </button>
          ) : null}
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect
            label="Disposition"
            value={filters.disposition}
            onChange={(disposition) => patch({ disposition })}
            notSet="Not disposed"
            options={DISPOSITIONS.map((value) => ({
              // Never spelled here: 'accepted' reads as "Submit", and
              // DISPOSITION_LABEL is the only place that is decided.
              value,
              label: dispositionLabel(value) ?? value,
            }))}
          />
          <FilterSelect
            label="Validation Status"
            value={filters.status}
            onChange={(status) => patch({ status })}
            options={SUB_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] }))}
          />
          <FilterSelect
            label="Archived"
            value={filters.archived}
            onChange={(archived) => patch({ archived })}
            anyLabel={null}
            options={ARCHIVED_MODES.map((value) => ({ value, label: ARCHIVED_LABEL[value] }))}
          />
          <FilterSelect
            label="Submitted By"
            value={filters.origin}
            onChange={(origin) => patch({ origin })}
            options={ORIGINS.map((value) => ({ value, label: ORIGIN_LABEL[value] }))}
          />
          <FilterSelect
            label="Center"
            value={filters.center}
            onChange={(center) => patch({ center })}
            notSet="No center"
            options={(centers.data ?? []).map((entry) => ({
              value: entry.id,
              label: entry.active ? entry.name : `${entry.name} (inactive)`,
            }))}
          />
          <FilterSelect
            label="Missing info"
            value={filters.missing}
            onChange={(missing) => patch({ missing })}
            notSet="Any missing field"
            options={(missingByField.data ?? []).map((row) => ({
              value: row.field,
              label: `${row.field} (${Number(row.lead_count)})`,
            }))}
          />
          <FilterSelect
            label="Missing bank info"
            value={filters.missingBank}
            onChange={(missingBank) => patch({ missingBank })}
            notSet="Any missing bank field"
            options={(bankByField.data ?? []).map((row) => ({
              value: row.field,
              label: `${row.field} (${Number(row.lead_count)})`,
            }))}
          />
        </div>

        {/* Leaving "To" blank filters exactly the one day (or age) in "From". */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <RangeField label="Submitted on">
            <input
              type="date"
              value={filters.submittedFrom}
              onChange={(event) => patch({ submittedFrom: event.target.value })}
              aria-label="Submitted from date"
              className={dateInput}
            />
            <input
              type="date"
              value={filters.submittedTo}
              onChange={(event) => patch({ submittedTo: event.target.value })}
              aria-label="Submitted to date (optional — leave blank for a single day)"
              className={dateInput}
            />
          </RangeField>
          <RangeField label="Sale made on">
            <input
              type="date"
              value={filters.saleFrom}
              onChange={(event) => patch({ saleFrom: event.target.value })}
              aria-label="Sale made from date"
              className={dateInput}
            />
            <input
              type="date"
              value={filters.saleTo}
              onChange={(event) => patch({ saleTo: event.target.value })}
              aria-label="Sale made to date (optional — leave blank for a single day)"
              className={dateInput}
            />
          </RangeField>
          <RangeField label="Draft date">
            <input
              type="date"
              value={filters.draftFrom}
              onChange={(event) => patch({ draftFrom: event.target.value })}
              aria-label="Draft date from"
              className={dateInput}
            />
            <input
              type="date"
              value={filters.draftTo}
              onChange={(event) => patch({ draftTo: event.target.value })}
              aria-label="Draft date to (optional — leave blank for a single day)"
              className={dateInput}
            />
          </RangeField>
          <RangeField label="Age">
            <input
              type="number"
              min={0}
              max={120}
              inputMode="numeric"
              value={filters.ageFrom}
              onChange={(event) => patch({ ageFrom: event.target.value.replace(/\D/g, "") })}
              placeholder="From"
              aria-label="Age from"
              className={dateInput}
            />
            <input
              type="number"
              min={0}
              max={120}
              inputMode="numeric"
              value={filters.ageTo}
              onChange={(event) => patch({ ageTo: event.target.value.replace(/\D/g, "") })}
              placeholder="To"
              aria-label="Age to (optional — leave blank for a single age)"
              className={dateInput}
            />
          </RangeField>
        </div>

        {/* The four CX statuses sit behind a disclosure: they are the least
            used and would otherwise double the height of the filter block. */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="chip w-fit px-2.5 py-0.5 text-[0.66rem]"
            aria-expanded={showCx}
            onClick={() => setShowCx((prev) => !prev)}
          >
            {showCx ? "Hide customer statuses" : "Customer statuses"}
            {CX_CATEGORIES.some((category) => filters.cx[category] !== ANY) ? " •" : ""}
          </button>
          {showCx ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {CX_CATEGORIES.map((category) => (
                <FilterSelect
                  key={category}
                  label={CATEGORY_LABEL[category]}
                  value={filters.cx[category]}
                  onChange={(value) => patch({ cx: { ...filters.cx, [category]: value } })}
                  notSet="Not set"
                  options={vocabulary.byCategory[category]
                    .filter((option) => option.active)
                    .map((option) => ({ value: option.code, label: option.label }))}
                />
              ))}
            </div>
          ) : null}
        </div>

        {appliedChips.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
            <span className="field-label mr-1">Applied</span>
            {appliedChips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                title="Remove this filter"
                onClick={chip.clear}
                className="chip chip-active px-2.5 py-0.5 text-[0.66rem]"
              >
                {chip.label}
                <span aria-hidden className="ml-1.5 text-muted-foreground">
                  ×
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {missingByField.isError ? (
          <p className="text-xs text-destructive">{(missingByField.error as Error).message}</p>
        ) : null}
        {bankByField.isError ? (
          <p className="text-xs text-destructive">{(bankByField.error as Error).message}</p>
        ) : null}
      </section>

      <section className="panel">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="panel-title">Leads ({total})</h2>
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
          </div>
        </div>

        {/* Offered once the whole page is ticked, which is when "and the rest?"
            becomes the obvious next question. */}
        {pageFullySelected && selectedRows.length < total ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs">
            <span>All {rows.length} leads on this page are selected.</span>
            <button
              type="button"
              className="chip px-2.5 py-0.5 text-[0.66rem]"
              disabled={gathering !== null}
              onClick={selectAllMatching}
            >
              {gathering
                ? `Selecting… ${gathering.done} of ${gathering.total}`
                : `Select all ${total} matching`}
            </button>
          </div>
        ) : null}

        {/* The whole reason this exists: checking a lead on page one of a long
            filtered list and then paging away leaves no way to find it again —
            this puts every current pick in view, wherever it sits, and clicking
            one drops it. Capped so a select-all does not fill the screen. */}
        {selectedRows.length > 0 ? (
          <div className="flex max-h-24 flex-wrap items-center gap-1.5 overflow-y-auto border-b border-border pb-3">
            <span className="field-label mr-1">Selected ({selectedRows.length})</span>
            {selectedRows.slice(0, 40).map((row) => (
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
            {selectedRows.length > 40 ? (
              <span className="text-[0.66rem] text-muted-foreground">
                +{selectedRows.length - 40} more
              </span>
            ) : null}
            <button type="button" className="chip" onClick={clearSelection}>
              Clear all
            </button>
          </div>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  aria-label="Select all leads on this page"
                  disabled={rows.length === 0}
                  checked={pageFullySelected}
                  onCheckedChange={togglePage}
                />
              </TableHead>
              <TableHead className="w-24">Center</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Final carrier</TableHead>
              <TableHead className="w-28">Draft date</TableHead>
              <TableHead>Submitted by</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Validation status</TableHead>
              <TableHead className="w-28">Disposition</TableHead>
              <TableHead className="w-28">Submitted on</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayRows.map((row) => {
              const isOpen = openId === row.id;
              return (
                <TableRow
                  key={row.id}
                  aria-selected={isOpen}
                  className={`cursor-pointer ${
                    isOpen ? "bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]" : ""
                  }`}
                  onClick={() => setOpenId(row.id)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select ${customerName(row.payload)}`}
                      checked={selected.has(row.id)}
                      onCheckedChange={() => toggleLead(row)}
                    />
                  </TableCell>
                  <TableCell>
                    <CenterBadge
                      name={row.center_name}
                      color={row.center_id ? centerColorById.get(row.center_id) : null}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                  <TableCell>{finalCarrierName(row)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatCalendarDate(
                      (row.payload?.["Draft Date"] as string | undefined) ?? null,
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{closerName(row)}</TableCell>
                  <TableCell>
                    <OriginBadge row={row} />
                  </TableCell>
                  <TableCell className="overflow-hidden">
                    <QueueStatusBadge
                      row={row}
                      declinedCarriers={declinedMap.data?.get(row.id) ?? []}
                    />
                  </TableCell>
                  <TableCell>
                    <DispositionBadge disposition={row.disposition} onHold={isOnHold(row)} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {row.disposed_at ? formatDate(row.disposed_at) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
            {displayRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground">
                  {leads.isLoading
                    ? "Loading…"
                    : leads.isError
                      ? (leads.error as Error).message
                      : showSelectedOnly
                        ? "Nothing selected yet."
                        : active > 0
                          ? "No leads match these filters."
                          : "No leads yet."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

        {showSelectedOnly ? null : (
          <PaginationBar
            page={page}
            pageSize={PAGE_SIZE}
            shown={rows.length}
            total={total}
            busy={leads.isFetching}
            onPage={setPage}
          />
        )}
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

      <Sheet
        open={!!open}
        onOpenChange={(next) => {
          if (!next) {
            setOpenId(null);
            setHistoryOpen(false);
          }
        }}
      >
        <SheetContent className="w-full overflow-y-auto overflow-x-hidden sm:max-w-xl">
          {open ? (
            <>
              <SheetHeader>
                <SheetTitle>{customerName(open.payload)}</SheetTitle>
                <SheetDescription>
                  {closerName(open)} · {sourceLabel(open)} · {relativeTime(open.created_at, now)} ·{" "}
                  {dispositionLabel(open.disposition) ?? open.status}
                </SheetDescription>
              </SheetHeader>

              <div className="flex min-w-0 max-w-full flex-col gap-4 px-4 pb-4">
                <MissingInfoSection
                  submissionId={open.id}
                  missing={open.missing_info}
                  missingBank={open.missing_bank}
                  editable
                  onSaved={() => {
                    queryClient.invalidateQueries({ queryKey: EXPORTS_KEY });
                    queryClient.invalidateQueries({ queryKey: payloadHistoryKey(open.id) });
                  }}
                />

                <LeadPayload
                  submissionId={open.id}
                  payload={open.payload}
                  editable
                  onSaved={() => {
                    queryClient.invalidateQueries({ queryKey: EXPORTS_KEY });
                    queryClient.invalidateQueries({ queryKey: payloadHistoryKey(open.id) });
                  }}
                />

                {/* Bank fields live in payment_details, not the payload above. */}
                <PaymentPanel submissionId={open.id} editable />

                <ValidatorFields
                  row={open}
                  onSaved={() => {
                    queryClient.invalidateQueries({ queryKey: EXPORTS_KEY });
                    queryClient.invalidateQueries({ queryKey: validationTimelineKey(open.id) });
                  }}
                />

                <DataFlagList
                  submissionId={open.id}
                  payload={open.payload}
                  flags={dataFlags(open.data_flags)}
                />

                {/* add_submission_tag refuses anything not accepted. */}
                {open.disposition === "accepted" ? <SubmissionTags submissionId={open.id} /> : null}

                <CarrierDeclineList submissionId={open.id} />

                <PayloadEditHistory submissionId={open.id} />

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
        submissionId={open?.id ?? null}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        customerName={open ? customerName(open.payload) : null}
        showCxLifecycle={false}
        seconds
      />
    </div>
  );
}

/** A labelled from–to pair, laid out like a FilterSelect so the rows line up. */
function RangeField({ label, children }: { label: string; children: [ReactNode, ReactNode] }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="field-label">{label}</span>
      <div className="flex items-center gap-1.5">
        {children[0]}
        <span className="text-xs text-muted-foreground" aria-hidden>
          –
        </span>
        {children[1]}
      </div>
    </div>
  );
}

/** "Any", optionally "not set", then whatever this dimension offers. */
function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  notSet,
  anyLabel = "Any",
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  /** The label for the null case, or omitted where there is no null case. */
  notSet?: string;
  /** The label for the unfiltered choice; null where the control has no such choice. */
  anyLabel?: string | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="field-label">{label}</span>
      {/* Radix hands back one of the values rendered below, all of which are T by
          construction — the cast asserts what the item list already guarantees. */}
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {anyLabel === null ? null : (
            <SelectItem value={ANY} className="text-xs">
              {anyLabel}
            </SelectItem>
          )}
          {notSet ? (
            <SelectItem value={NOT_SET} className="text-xs">
              {notSet}
            </SelectItem>
          ) : null}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} className="text-xs">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** How many leads are missing each field, most common first. Archived are excluded. */
async function missingTally(column: "missing_info" | "missing_bank") {
  const { data, error } = await supabase
    .from("submissions")
    .select(column)
    .is("archived_at", null)
    .not(column, "eq", "{}");
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as unknown as Record<string, string[] | null>[]) {
    for (const field of row[column] ?? []) counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  return Array.from(counts, ([field, lead_count]) => ({ field, lead_count })).sort(
    (a, b) => b.lead_count - a.lead_count || a.field.localeCompare(b.field),
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
