import { STATUS_TONE_CLASS, CATEGORY_LABEL, CX_CATEGORIES } from "@/lib/cx-status";
import { useCxCoverage, useCxStatusSummary } from "@/lib/cx-overview";
import { MetricBar } from "@/components/metric-bar";

/**
 * Where the submitted leads are right now, per dimension.
 *
 * Four blocks, one per dimension, each listing its own options with counts.
 * There is deliberately no combined figure and no "overall status": a lead can
 * be Issued / Active with a failed premium and a paid commission, and every one
 * of those is true at the same time. Rolling them into one value would throw
 * two of the three facts away, so a lead simply appears once in each block.
 *
 * Counts come from `cx_status_summary`, which is grouped server-side; the
 * client never adds anything up.
 */

export function CxStatusBreakdown() {
  const summary = useCxStatusSummary();
  const coverage = useCxCoverage();
  const byCategory = summary.byCategory;

  return (
    <>
      {/* The backlog first: it is the number that decides whether anything else
          on this screen matters today. */}
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="panel gap-1">
          <span className="panel-title">Untouched</span>
          <span
            className={`font-display text-3xl font-semibold tabular-nums ${
              coverage.untouched > 0 ? "text-destructive" : ""
            }`}
          >
            {coverage.untouched}
          </span>
          <span className="text-[0.66rem] text-muted-foreground">
            Submitted leads with no status set at all — nobody has picked these up.
          </span>
        </div>

        <div className="panel gap-1">
          <span className="panel-title">In CX</span>
          <span className="font-display text-3xl font-semibold tabular-nums">{coverage.inCx}</span>
          <span className="text-[0.66rem] text-muted-foreground">At least one status set.</span>
        </div>

        <div className="panel gap-1">
          <span className="panel-title">Submitted leads</span>
          <span className="font-display text-3xl font-semibold tabular-nums">{coverage.total}</span>
          {/* <span className="text-[0.66rem] text-muted-foreground">
            Everything approved and not archived.
          </span> */}
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        {CX_CATEGORIES.map((category) => {
          const rows = byCategory[category];
          const counted = rows.reduce((sum, row) => sum + row.lead_count, 0);
          // Each block is scaled against its own busiest status, not against
          // the other three: the question inside a dimension is which status
          // holds the backlog, and a shared scale would flatten a small
          // dimension into invisibility next to a large one.
          const most = rows.reduce((top, row) => Math.max(top, row.lead_count), 0);
          return (
            <div key={category} className="panel gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="panel-title">{CATEGORY_LABEL[category]}</h3>
                <span className="text-[0.66rem] tabular-nums text-muted-foreground">{counted}</span>
              </div>

              <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                  <li key={row.code} className="flex flex-col gap-1">
                    <span className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.66rem] font-medium ${
                          STATUS_TONE_CLASS[row.tone]
                        }`}
                      >
                        {row.label}
                      </span>
                      <span
                        className={`text-xs tabular-nums ${
                          row.lead_count > 0 ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {row.lead_count}
                      </span>
                    </span>
                    {/* The chip already carries what this status MEANS; the bar
                        carries only how big it is, which is why it stays in the
                        neutral ramp and does not repeat the tone. */}
                    <MetricBar value={row.lead_count} max={most} />
                  </li>
                ))}
                {rows.length === 0 ? (
                  <li className="text-xs text-muted-foreground">
                    {summary.isLoading ? "Loading…" : "No active options."}
                  </li>
                ) : null}
              </ul>
            </div>
          );
        })}
      </section>
    </>
  );
}

/**
 * The one-card version for the admin Overview tab: how much of the approved
 * backlog CX has actually started on.
 *
 * Rendered by the admin page rather than from inside ReportingStats, so the
 * manager's Reporting tab — which shares that component — is unchanged.
 */
export function CxCoverageCard() {
  const coverage = useCxCoverage();

  return (
    <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-7">
      <div className="panel gap-1 sm:col-span-2">
        <span className="panel-title">CX coverage</span>
        <span className="font-display text-3xl font-semibold tabular-nums">
          {coverage.inCx}
          <span className="text-base font-normal text-muted-foreground"> / {coverage.total}</span>
        </span>
        <span className="text-[0.66rem] text-muted-foreground">
          Submitted leads that have entered CX.{" "}
          <span className={coverage.untouched > 0 ? "text-destructive" : ""}>
            {coverage.untouched} untouched.
          </span>
        </span>
      </div>
    </section>
  );
}
