import { useEffect, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginationBar } from "@/components/pagination-bar";

/**
 * Row ticking for a table whose selection is owned by the caller.
 *
 * The caller keeps the id list (and anything it derives from it); the table only
 * reports changes. The header checkbox acts on the rows of the CURRENT PAGE, so
 * one click can never tick a lead that is not on screen to be unticked.
 */
export type DataTableSelection<T> = {
  ids: string[];
  onChange: (ids: string[]) => void;
  isSelectable: (row: T) => boolean;
  rowLabel: (row: T) => string;
  disabled?: boolean;
};

/**
 * A sortable, client-paginated table over rows that are already fully loaded.
 *
 * Not for server-paginated screens: those must sort and page in the query
 * (`PaginationBar` + `range()`), because only one page of them exists here.
 * Rendering goes through `ui/table.tsx`, so the header band and label styling
 * are the app's own, not restated.
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  onRowClick,
  initialSorting,
  pageSize = 50,
  emptyMessage,
  resetKey,
  selection,
}: {
  columns: ColumnDef<T>[];
  data: T[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  initialSorting: SortingState;
  pageSize?: number;
  emptyMessage: string;
  /** Back to page one whenever this changes (a new search term, say). */
  resetKey?: string;
  selection?: DataTableSelection<T>;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [pageIndex, setPageIndex] = useState(0);

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting, pagination: { pageIndex, pageSize } },
    onSortingChange: (updater) => {
      setSorting(updater);
      setPageIndex(0);
      // The order decides what is on screen, so a tick made under the old one
      // is dropped, the same way a tab or search change drops it.
      selection?.onChange([]);
    },
    enableSortingRemoval: false,
    // The page is reset by hand (resetKey, sorting). The built-in reset would
    // also fire on every realtime refetch and throw the reader back to page one.
    autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  useEffect(() => setPageIndex(0), [resetKey]);

  // A refetch can retire the last page out from under the reader.
  const pageCount = table.getPageCount();
  useEffect(() => {
    if (pageIndex > 0 && pageIndex >= pageCount) setPageIndex(Math.max(0, pageCount - 1));
  }, [pageIndex, pageCount]);

  const pageRows = table.getRowModel().rows;
  const total = table.getPrePaginationRowModel().rows.length;

  const selectedIds = new Set(selection?.ids ?? []);
  const selectableOnPage = selection
    ? pageRows.filter((row) => selection.isSelectable(row.original)).map((row) => row.id)
    : [];
  const tickedOnPage = selectableOnPage.filter((id) => selectedIds.has(id)).length;

  const setPageSelected = (checked: boolean) => {
    if (!selection) return;
    if (checked) {
      selection.onChange([...new Set([...selection.ids, ...selectableOnPage])]);
    } else {
      const onPage = new Set(selectableOnPage);
      selection.onChange(selection.ids.filter((id) => !onPage.has(id)));
    }
  };

  const toggleRow = (id: string, checked: boolean) => {
    if (!selection) return;
    selection.onChange(
      checked ? [...new Set([...selection.ids, id])] : selection.ids.filter((x) => x !== id),
    );
  };

  const columnCount = columns.length + (selection ? 1 : 0);

  return (
    <>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {selection ? (
                <TableHead className="w-8">
                  <Checkbox
                    aria-label="Select all assignable submissions on this page"
                    disabled={selectableOnPage.length === 0 || selection.disabled === true}
                    checked={
                      selectableOnPage.length > 0 && tickedOnPage === selectableOnPage.length
                        ? true
                        : tickedOnPage > 0
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(checked) => setPageSelected(checked === true)}
                  />
                </TableHead>
              ) : null}
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <TableHead
                    key={header.id}
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 uppercase hover:text-foreground"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === "asc" ? (
                          <ChevronUp className="h-3 w-3" aria-hidden />
                        ) : sorted === "desc" ? (
                          <ChevronDown className="h-3 w-3" aria-hidden />
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-40" aria-hidden />
                        )}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {pageRows.map((row) => (
            <TableRow
              key={row.id}
              className={onRowClick ? "cursor-pointer" : undefined}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
            >
              {selection ? (
                <TableCell className="w-8" onClick={(event) => event.stopPropagation()}>
                  {selection.isSelectable(row.original) ? (
                    <Checkbox
                      aria-label={selection.rowLabel(row.original)}
                      disabled={selection.disabled === true}
                      checked={selectedIds.has(row.id)}
                      onCheckedChange={(checked) => toggleRow(row.id, checked === true)}
                    />
                  ) : null}
                </TableCell>
              ) : null}
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className={cellClassName(cell.column.columnDef)}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {pageRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      {total > pageSize ? (
        <PaginationBar
          page={pageIndex}
          pageSize={pageSize}
          shown={pageRows.length}
          total={total}
          onPage={setPageIndex}
        />
      ) : null}
    </>
  );
}

/** A column's own cell styling, carried on `meta` so a column list stays one object per column. */
function cellClassName<T>(def: ColumnDef<T>): string | undefined {
  const meta = def.meta as { cellClassName?: string } | undefined;
  return meta?.cellClassName;
}
