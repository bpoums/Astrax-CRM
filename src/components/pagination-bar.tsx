/**
 * The range indicator and Prev/Next pair used under a server-paginated table.
 *
 * Pure presentation: the caller owns the page state and the `range()` query.
 * Rendered only when there is something to show, so an empty table is not
 * followed by "0–0 of 0".
 */
export function PaginationBar({
  page,
  pageSize,
  shown,
  total,
  busy = false,
  onPage,
}: {
  /** Zero-based. */
  page: number;
  pageSize: number;
  /** Rows actually returned for this page. */
  shown: number;
  /** Exact count from the query. */
  total: number;
  busy?: boolean;
  onPage: (next: number) => void;
}) {
  if (total === 0) return null;

  const first = page * pageSize + 1;
  const last = page * pageSize + shown;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-[0.66rem] text-muted-foreground">
        {first}–{last} of {total}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="chip px-2.5 py-0.5 text-[0.66rem]"
          disabled={page === 0 || busy}
          onClick={() => onPage(Math.max(0, page - 1))}
        >
          Previous
        </button>
        <button
          type="button"
          className="chip px-2.5 py-0.5 text-[0.66rem]"
          disabled={last >= total || busy}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
