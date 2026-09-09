import { relativeTime, STATUS_LABEL, useNow } from "@/components/ops";

/**
 * Where the open work actually is, as one bar.
 *
 * The Overview used to answer this with four identical stat cards, which give
 * every stage the same weight and show no relationship between them. The
 * question an ops lead opens this tab with is not "how many are assigned" but
 * "where is it stuck", and that is a question about PROPORTION — a fat
 * Unassigned segment means the manager is the bottleneck, a fat On hold means
 * validators are stalling on something. One bar says that; five cards cannot.
 *
 * Only open work appears here. Closed leads are the record, not the news, and
 * they are counted in the all-time strip below this one.
 *
 * Colour carries a rough grammar rather than a per-stage identity: neutral is
 * waiting, amber is being worked, red went wrong. Nothing is conveyed by colour
 * alone — every segment is named and counted in the legend underneath.
 *
 * The two waiting stages are separated by LUMINANCE, not by opacity of the same
 * grey — dim for a lead nobody holds, bright for one a validator does. Two
 * steps of one colour looked distinct in source and merged into a single band
 * eight pixels tall on screen, which is the only place it matters.
 *
 * Each stage also carries the AGE of its oldest lead, which is the difference
 * between three timeouts this morning and three that have been sitting since
 * August. The count alone draws those identically, and the second is the one
 * worth doing something about. It is the lead's own age, not time in this
 * stage: no column records when a lead entered `pending_manager`, and "this
 * lead is fifteen days old and still not resolved" is the more useful fact
 * anyway.
 */

type Stage = {
  key: string;
  label: string;
  value: number;
  /** When the oldest lead in this stage was submitted. Null where none is. */
  oldest: string | null;
  /** The bar segment and its legend dot, which must always match. */
  fill: string;
};

/** One stage's numbers, as the caller supplies them. */
export type StageCount = {
  value: number;
  oldest?: string | null;
};

export function QueueFlow({
  unassigned,
  assigned,
  inReview,
  onHold,
  returned,
  loading = false,
}: {
  unassigned: StageCount;
  /** Assigned and NOT on hold — the two are exclusive here, never double-counted. */
  assigned: StageCount;
  inReview: StageCount;
  onHold: StageCount;
  returned: StageCount;
  loading?: boolean;
}) {
  // A minute is plenty: these ages are read in days and hours, and a faster
  // clock would re-render the whole strip for nothing.
  const now = useNow(60_000);

  const stages: Stage[] = [
    // The queue's own words, read from the one place they are spelled, so a
    // rename in STATUS_LABEL moves this strip with every other screen.
    {
      key: "unassigned",
      label: STATUS_LABEL.pending_manager,
      value: unassigned.value,
      oldest: unassigned.oldest ?? null,
      fill: "bg-muted-foreground/45",
    },
    {
      key: "assigned",
      label: STATUS_LABEL.assigned,
      value: assigned.value,
      oldest: assigned.oldest ?? null,
      // Near-white against the dim grey above it. Also the right reading:
      // somebody is holding this lead, so it is brighter than the pile nobody
      // has picked up — and it matches QueueStatusBadge, where an untouched
      // lead is deliberately the quiet one.
      fill: "bg-foreground/80",
    },
    {
      key: "in_review",
      label: STATUS_LABEL.in_review,
      value: inReview.value,
      oldest: inReview.oldest ?? null,
      fill: "bg-accent",
    },
    // Quieter amber than a live review: a hold is work paused, not work
    // happening, and the two should not read as the same thing.
    {
      key: "on_hold",
      label: "On Hold",
      value: onHold.value,
      oldest: onHold.oldest ?? null,
      fill: "bg-accent/45",
    },
    {
      key: "returned",
      label: STATUS_LABEL.returned_timeout,
      value: returned.value,
      oldest: returned.oldest ?? null,
      fill: "bg-destructive",
    },
  ];

  const total = stages.reduce((sum, stage) => sum + stage.value, 0);

  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Where leads are right now</h2>
        {/* Said here rather than only beside the period chips below, where it
            was missed: this strip is current state and the window does not
            touch it. */}
        <span className="text-[0.66rem] tabular-nums text-muted-foreground">
          {loading ? "Loading…" : `${total} in flight · always live, not filtered by period`}
        </span>
      </div>

      {/* One track, split by share. A stage with nothing in it takes no width
          and simply is not drawn; a stage with one lead out of five hundred
          keeps a sliver, so "a few" never renders as "none". */}
      <div
        aria-hidden
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-border/60"
      >
        {stages.map((stage) =>
          stage.value > 0 ? (
            <div
              key={stage.key}
              className={`h-full min-w-[3px] rounded-full ${stage.fill} transition-[flex-grow] duration-300 motion-reduce:transition-none`}
              style={{ flexGrow: stage.value }}
            />
          ) : null,
        )}
      </div>

      <ul className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {stages.map((stage) => (
          <li key={stage.key} className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${stage.fill}`} />
              <span className="field-label truncate">{stage.label}</span>
            </span>
            <span
              className={`font-display text-2xl font-semibold tabular-nums ${
                stage.value === 0 ? "text-muted-foreground" : ""
              }`}
            >
              {stage.value}
            </span>
            {/* Only where there is something to age. An empty stage saying
                "oldest —" is noise, and the count already says it is empty. */}
            {stage.value > 0 && stage.oldest ? (
              <span className="truncate text-[0.62rem] text-muted-foreground">
                oldest {relativeTime(stage.oldest, now)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {total === 0 && !loading ? (
        <p className="text-[0.66rem] text-muted-foreground">
          Nothing open. Every lead has been disposed or archived.
        </p>
      ) : null}
    </section>
  );
}
