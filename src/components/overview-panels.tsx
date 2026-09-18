import { useMemo } from "react";
import { CenterBadge } from "@/components/ops";
import { MetricBar } from "@/components/metric-bar";
import { QueueFlow } from "@/components/queue-flow";
import { FlipNumber } from "@/components/flip-number";
import { SubmissionOutcome } from "@/components/submission-outcome";
import { useCenterColorById } from "@/lib/centers";
import type { usePeriod } from "@/lib/period-range";
import type { CenterTotalsRow, useOverviewStats } from "@/lib/overview-stats";

/**
 * The three questions, side by side: what came in, what happened to it, and
 * where the open work is standing.
 *
 * Mounted by the admin Overview, the manager's Reporting tab and the Closing
 * Desk's Overview tab. One component rather than three, because the layout is
 * the business's own picture of itself and three copies of it would start
 * disagreeing within a month.
 *
 * **It is given its data, never fetching any.** `useOverviewStats` opens a
 * realtime channel, and two Supabase subscriptions may not share one name — on
 * the manager's Reporting tab `ReportingStats` already calls that hook, so a
 * second call in here would mount the same channel twice on one screen. The
 * parent calls `usePeriod()` and `useOverviewStats()` once and passes both
 * down: one window, one fetch, one channel per screen.
 *
 * Nothing here is gated on a role. Every figure arrives already scoped by the
 * caller's own RLS — the `_range` RPCs are SECURITY INVOKER over `submissions`
 * — so a closing manager reading this component sees their centre's numbers
 * through the identical code an admin sees the whole business through. The two
 * props below are about what is worth DRAWING for a role, never about what it
 * is allowed to know.
 */
export function OverviewPanels({
  period,
  stats,
  centers,
}: {
  period: ReturnType<typeof usePeriod>;
  stats: ReturnType<typeof useOverviewStats>;
  /**
   * The centre rows to draw, in both columns. Usually every row the RPC
   * returned; the Closing Desk narrows it to the reader's own centre, because
   * RLS leaves the others sitting at zero and a row that can never move is
   * noise.
   */
  centers: CenterTotalsRow[];
}) {
  const { heading } = period;
  const { centerTotals, totals, openQueue } = stats;
  const centerColorById = useCenterColorById();
  const totalsRow = totals.data ?? null;

  const live = totalsRow?.closer_submissions ?? 0;
  /**
   * One Manual figure, not two.
   *
   * An uploaded lead and a validator's own submission arrive by completely
   * different paths but are the same thing to a reader: a lead nobody closed
   * live. The Submissions tab already merged them on exactly this reasoning
   * (Closer/Validator/Manual became Live/Manual), and that tab's Type column is
   * where the two are still told apart per lead.
   */
  const manual = (totalsRow?.offline_submissions ?? 0) + (totalsRow?.validator_submissions ?? 0);

  /**
   * ONE scale across both columns, not one per column.
   *
   * The whole point of standing Live and Manual side by side is comparing them;
   * normalising each column to its own busiest centre would draw a centre's 40
   * manual leads the same length as another's 303 live ones.
   */
  const sourceMax = useMemo(
    () =>
      centers.reduce(
        (most, center) =>
          Math.max(most, center.total_submissions ?? 0, center.manual_submissions ?? 0),
        0,
      ),
    [centers],
  );

  const emptyMessage = centerTotals.isLoading
    ? "Loading…"
    : centerTotals.isError
      ? (centerTotals.error as Error).message
      : "No active centers.";

  return (
    /* `items-stretch` alone is what makes the three panels equal height, so
       none of them carries `h-full` as well. `.panel` sets `overflow: auto`
       AND hides its own scrollbar, so a panel that ever ends up shorter than
       its contents loses them with nothing on screen to say so — worth not
       handing it a `height: 100%` it does not need. */
    <div className="grid items-stretch gap-4 md:grid-cols-2 lg:grid-cols-[40fr_28fr_32fr]">
      <section className="panel">
        {/* Named for the window it is showing. It said "Today" whatever the
            chips were set to until 2026-09-18, which made the panel contradict
            the figures inside it. */}
        <h2 className="panel-title">{heading}</h2>

        {/* Two origins, two columns, each with its own centres underneath.

            They were one merged list until 2026-09-18, which answered "how big
            is this centre" but destroyed the question the panel is actually
            opened with: WHERE did the uploaded leads come from. A centre whose
            forty leads are all uploads and one whose two hundred are all
            validator submissions looked identical. */}
        <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2">
          <OriginColumn
            label="Live"
            total={live}
            centers={centers}
            valueOf={(center) => center.total_submissions ?? 0}
            max={sourceMax}
            colorById={centerColorById}
            empty={emptyMessage}
          />
          <OriginColumn
            label="Manual"
            total={manual}
            delayMs={80}
            centers={centers}
            valueOf={(center) => center.manual_submissions ?? 0}
            max={sourceMax}
            colorById={centerColorById}
            empty={emptyMessage}
          />
        </div>
      </section>

      <SubmissionOutcome
        /* `_all`, not the bare columns: those count LIVE leads only, and this
           panel sits beside intake that counts Live AND Manual. It read 183
           Submitted against 386 actually sold until 2026-09-18. */
        approved={totalsRow?.approved_all ?? 0}
        declined={totalsRow?.declined_all ?? 0}
        heading={heading}
        loading={totals.isLoading}
      />

      {/* The same strip the manager has always worked from, stood on its side
          to fit a third of the page. Unscoped by the period picker, exactly as
          it has always been. */}
      <QueueFlow
        className="md:col-span-2 lg:col-span-1"
        title="L.A. Operations"
        orientation="rows"
        flip
        unassigned={{
          value: totalsRow?.awaiting_manager ?? 0,
          oldest: openQueue.data?.oldest.unassigned ?? null,
        }}
        assigned={{
          value: openQueue.data?.assigned ?? 0,
          oldest: openQueue.data?.oldest.assigned ?? null,
        }}
        inReview={{
          value: totalsRow?.in_review ?? 0,
          oldest: openQueue.data?.oldest.inReview ?? null,
        }}
        onHold={{
          value: openQueue.data?.onHold ?? 0,
          oldest: openQueue.data?.oldest.onHold ?? null,
        }}
        returned={{
          value: openQueue.data?.returned ?? 0,
          oldest: openQueue.data?.oldest.returned ?? null,
        }}
        loading={totals.isLoading || openQueue.isLoading}
      />
    </div>
  );
}

/**
 * One origin: its headline count, then every centre's share of it.
 *
 * Both columns are handed the same `centers` array and the same `max`, and
 * differ only in which column of the row they read — so the two lists always
 * carry the same centres in the same order, and their bars are on one scale.
 */
function OriginColumn({
  label,
  total,
  centers,
  valueOf,
  max,
  colorById,
  empty,
  delayMs = 0,
}: {
  label: string;
  total: number;
  centers: CenterTotalsRow[];
  valueOf: (center: CenterTotalsRow) => number;
  max: number;
  /** Taken from the hook rather than restated, so the palette union stays
   *  whatever `useCenterColorById` says it is. */
  colorById: ReturnType<typeof useCenterColorById>;
  /** Loading, error or "none" — whichever the centre query is saying. */
  empty: string;
  delayMs?: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="field-label">{label}</span>
        <FlipNumber value={total} size="hero" delayMs={delayMs} />
      </div>

      <ul className="flex flex-col gap-2 border-t border-border/60 pt-2">
        {centers.map((center) => {
          const value = valueOf(center);
          return (
            <li key={center.center_id ?? center.center_name} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <CenterBadge
                  name={center.center_name}
                  color={center.center_id ? colorById.get(center.center_id) : null}
                />
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{value}</span>
              </div>
              <MetricBar value={value} max={max} />
            </li>
          );
        })}
        {centers.length === 0 ? <li className="text-xs text-muted-foreground">{empty}</li> : null}
      </ul>
    </div>
  );
}
