/**
 * A count, and how big it is next to the others beside it.
 *
 * Four counts printed as "40 12 1 0" are read one numeral at a time; the same
 * four with a bar behind them are read as a shape. That is the whole job — this
 * is a comparison device, not a chart, and it deliberately stops well short of
 * one: no axis, no legend, no library, and nothing a reader has to interpret.
 *
 * The fill is structural rather than semantic. Amber is the app's single accent
 * and it means "this wants attention"; magnitude does not, and rows that
 * already carry a status chip have their meaning from that chip. So the bar
 * stays in the neutral ramp and never competes with the colour beside it.
 *
 * The number is never replaced by the bar, only accompanied — the exact value
 * still has to be readable, and a bar alone cannot be scanned by a screen
 * reader or read off at a glance for a precise figure.
 */
export function MetricBar({
  value,
  /** The largest value in the group, which is what makes the bars comparable. */
  max,
}: {
  value: number;
  max: number;
}) {
  // A zero row still draws its track, so the list keeps an even rhythm and an
  // empty status reads as "none of these" rather than as a missing row.
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

  return (
    <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-border/60">
      <div
        className="h-full rounded-full bg-muted-foreground/50 transition-[width] duration-300 motion-reduce:transition-none"
        style={{ width: `${share * 100}%` }}
      />
    </div>
  );
}
