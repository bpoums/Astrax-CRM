/**
 * Sort keys for the manager's Operations queue.
 *
 * Pure: no React, no I/O. Each function turns one cell's value into something a
 * plain `<` / `>` can order, and returns `undefined` for "nothing to sort by" —
 * the table is configured with `sortUndefined: "last"`, so an empty cell sinks
 * to the bottom in both directions instead of leading a descending sort.
 */

/**
 * Where a lead stands, ordered by how much it needs the manager. Ascending puts
 * the rows that want action first: a timed-out lead, then one waiting to be
 * assigned, then one already assigned, then one a validator has open.
 */
const STATUS_RANK: Record<string, number> = {
  returned_timeout: 0,
  pending_manager: 1,
  assigned: 2,
  in_review: 3,
};

export function statusRank(status: string): number {
  return STATUS_RANK[status] ?? Object.keys(STATUS_RANK).length;
}

/**
 * Case-insensitive text key. The placeholders the queue prints for a missing
 * value ("—") and blanks are not names, so they sort last rather than first.
 */
export function textKey(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed !== "—" ? trimmed : undefined;
}

/** Milliseconds since the epoch, or undefined for a missing or unparseable date. */
export function timeKey(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}
