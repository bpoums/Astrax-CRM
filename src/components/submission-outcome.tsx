import { dispositionLabel } from "@/components/ops";
import { FlipNumber } from "@/components/flip-number";

/**
 * What happened to the leads that were dealt with — the second of the three
 * questions the Overview answers.
 *
 * The two figures are the app's own outcomes, read through `dispositionLabel()`
 * so the words here are the same words every badge, button and cell uses. The
 * one on the left is `accepted`, which this business has always called
 * **Submitted** (`DISPOSITION_LABEL` in `ops.tsx`); nothing about the stored
 * value or the query changes to print it.
 *
 * `pending` is deliberately not drawn. It is not an outcome — a pending lead
 * has gone back to the manager's queue and is still open, so it belongs to the
 * Operations panel beside this one, not to a ring of things that are finished.
 *
 * The ring is two SVG arcs and a `stroke-dasharray` — no charting library, and
 * nothing to interpret. It carries the ratio, which is the part worth seeing at
 * a glance; both exact counts are printed underneath, because a ring cannot be
 * read off to a precise figure or announced to a screen reader.
 */

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function SubmissionOutcome({
  approved,
  declined,
  heading,
  loading = false,
}: {
  approved: number;
  declined: number;
  /** The period these two figures were counted over. */
  heading: string;
  loading?: boolean;
}) {
  const disposed = approved + declined;
  const share = disposed > 0 ? approved / disposed : 0;
  const rate = disposed > 0 ? Math.round(share * 100) : null;

  return (
    /* No `h-full`: it is a grid item and stretches on its own. See the note on
       the grid in `overview-panels.tsx`. */
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Submission Outcome</h2>
        <span className="text-[0.66rem] text-muted-foreground">{heading}</span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-1">
        <div className="relative h-[124px] w-[124px] shrink-0">
          <svg viewBox="0 0 124 124" className="h-full w-full -rotate-90">
            {/* The track, so an empty period still draws a ring rather than
                nothing at all. */}
            <circle
              cx="62"
              cy="62"
              r={RADIUS}
              fill="none"
              strokeWidth="9"
              className="text-border"
              stroke="currentColor"
            />
            {disposed > 0 ? (
              <>
                {/* Declined fills the whole ring and Submitted is drawn over
                    it, so the two always meet exactly and no rounding gap can
                    open up between them. */}
                <circle
                  cx="62"
                  cy="62"
                  r={RADIUS}
                  fill="none"
                  strokeWidth="9"
                  className="text-destructive"
                  stroke="currentColor"
                />
                <circle
                  cx="62"
                  cy="62"
                  r={RADIUS}
                  fill="none"
                  strokeWidth="9"
                  strokeLinecap="butt"
                  className="text-accent transition-[stroke-dasharray] duration-500 motion-reduce:transition-none"
                  stroke="currentColor"
                  strokeDasharray={`${share * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                />
              </>
            ) : null}
          </svg>

          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
            <span className="font-display text-2xl font-semibold tabular-nums">
              {loading ? "…" : rate === null ? "—" : `${rate}%`}
            </span>
            <span className="field-label">{dispositionLabel("accepted")}</span>
          </div>
        </div>

        <dl className="grid w-full grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="field-label flex items-center gap-1.5">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              {dispositionLabel("accepted")}
            </dt>
            <dd>
              <FlipNumber value={approved} size="tile" delayMs={40} />
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="field-label flex items-center gap-1.5">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
              {dispositionLabel("declined")}
            </dt>
            <dd className={declined > 0 ? "text-destructive" : ""}>
              <FlipNumber value={declined} size="tile" delayMs={110} />
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
