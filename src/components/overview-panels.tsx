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
  showValidatorRow = true,
}: {
  period: ReturnType<typeof usePeriod>;
  stats: ReturnType<typeof useOverviewStats>;
  /**
   * The centre rows to draw. Usually every row the RPC returned; the Closing
   * Desk narrows it to the reader's own centre, because RLS leaves the others
   * sitting at zero and a row that can never move is noise.
   */
  centers: CenterTotalsRow[];
  /**
   * Dropped for a closing manager, whose read policy excludes validator
   * submissions outright — the figure is not low, it is structurally zero.
   */
  showValidatorRow?: boolean;
}) {
  const { heading } = period;
  const { centerTotals, totals, openQueue } = stats;
  const centerColorById = useCenterColorById();
  const totalsRow = totals.data ?? null;

  const live = totalsRow?.closer_submissions ?? 0;
  const uploaded = totalsRow?.offline_submissions ?? 0;
  const validator = totalsRow?.validator_submissions ?? 0;
  /**
   * One Manual figure, not two.
   *
   * An uploaded lead and a validator's own submission arrive by completely
   * different paths but are the same thing to a reader: a lead nobody closed
   * live. The Submissions tab already merged them on exactly this reasoning
   * (Closer/Validator/Manual became Live/Manual), and the two are broken back
   * out a level down, in the source list below.
   */
  const manual = uploaded + validator;

  // What every bar in the source list is measured against, so the busiest line
  // fills. The Manual rows are in the scale rather than beside it — comparing
  // five uploads against twelve live leads is the comparison the panel exists
  // for.
  const sourceMax = useMemo(
    () =>
      centers.reduce(
        (most, center) => Math.max(most, center.total_submissions ?? 0),
        Math.max(uploaded, showValidatorRow ? validator : 0),
      ),
    [centers, uploaded, validator, showValidatorRow],
  );

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

        {/* The two origins, and only two. Everything below this line adds up
            to one of them. */}
        <dl className="grid grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="field-label">Live</dt>
            <dd>
              <FlipNumber value={live} size="hero" />
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="field-label">Manual</dt>
            <dd>
              <FlipNumber value={manual} size="hero" delayMs={80} />
            </dd>
          </div>
        </dl>

        <div className="border-t border-border/60" />

        {/* Where those leads came from. Centres carry the Live figure; the
            rows under the separator carry the Manual one. */}
        <ul className="flex flex-1 flex-col gap-2">
          {centers.map((center) => (
            <li key={center.center_id ?? center.center_name} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <CenterBadge
                  name={center.center_name}
                  color={center.center_id ? centerColorById.get(center.center_id) : null}
                />
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {center.total_submissions ?? 0}
                </span>
              </div>
              <MetricBar value={center.total_submissions ?? 0} max={sourceMax} />
            </li>
          ))}
          {centers.length === 0 ? (
            <li className="text-xs text-muted-foreground">
              {centerTotals.isLoading
                ? "Loading…"
                : centerTotals.isError
                  ? (centerTotals.error as Error).message
                  : "No active centers."}
            </li>
          ) : null}

          {/* Origins with no centre behind them, so they are kept apart from
              the centre rows while sharing their scale. */}
          <li className="mt-1 border-t border-border/60 pt-2">
            <SourceRow label="Uploaded" value={uploaded} max={sourceMax} />
          </li>
          {showValidatorRow ? (
            <li>
              <SourceRow label="Validator" value={validator} max={sourceMax} />
            </li>
          ) : null}
        </ul>
      </section>

      <SubmissionOutcome
        approved={totalsRow?.approved ?? 0}
        declined={totalsRow?.declined ?? 0}
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

/** A Manual origin, drawn to match the centre rows above it. */
function SourceRow({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="field-label truncate">{label}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      <MetricBar value={value} max={max} />
    </div>
  );
}
