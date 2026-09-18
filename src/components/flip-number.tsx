import { useEffect, useState, type CSSProperties } from "react";

/**
 * A count, drawn as a split-flap board.
 *
 * The top half of each digit card hinges down over the bottom and the new digit
 * is revealed behind it — a departure board, or a desk calendar losing a page.
 * Every figure on the Overview is already re-fetched by a realtime subscription
 * on `submissions`, so the flip is not decoration: it is the one cue that a
 * number moved while the reader was looking at something else on the page.
 *
 * Restraint is the whole design here. This is an ops console somebody stares at
 * all day, so:
 *   - a digit animates ONLY when that digit actually changes. Nothing idles,
 *     nothing loops, and a board that has not moved is completely still.
 *   - 400ms end to end (two 200ms halves), once.
 *   - `prefers-reduced-motion: reduce` swaps the digit outright. The check is
 *     made in JS as well as in CSS, because with `animation: none` the
 *     `animationend` that retires the moving flaps would never fire.
 *
 * Pure CSS 3D (`rotateX` + `backface-visibility`, in `styles.css`). No
 * animation library — one would have to re-implement exactly this to drive it.
 */

const DURATION_MS = 400;
const QUERY = "(prefers-reduced-motion: reduce)";

/** How big the cards are. Each maps to a `@utility` in `styles.css`. */
type FlipSize = "hero" | "tile" | "row";

const SIZE_CLASS: Record<FlipSize, string> = {
  hero: "flip-hero",
  tile: "flip-tile",
  row: "flip-row",
};

/**
 * Read SYNCHRONOUSLY on the first render, not in an effect.
 *
 * An effect lands after the first commit, and the entrance flip is decided in
 * that very commit — so reading it late let one cascade through before the
 * preference was known, which is the one case it most obviously must not.
 */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(QUERY);
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export function FlipNumber({
  value,
  size = "tile",
  /** Staggers this tile against its neighbours on first paint. */
  delayMs = 0,
  className = "",
}: {
  value: number | null | undefined;
  size?: FlipSize;
  delayMs?: number;
  className?: string;
}) {
  const text = String(value ?? 0);
  const digits = text.split("");

  return (
    <span className={`inline-flex items-end gap-[2px] ${SIZE_CLASS[size]} ${className}`}>
      {/* The value itself, once, for anything not reading the cards. */}
      <span className="sr-only">{text}</span>
      {digits.map((digit, index) => (
        // Keyed from the RIGHT so a value crossing a power of ten flips the
        // units column rather than re-animating every digit into a new place:
        // 9 -> 10 moves one card, not two.
        <FlipDigit key={digits.length - index} digit={digit} delayMs={delayMs} />
      ))}
    </span>
  );
}

function FlipDigit({ digit, delayMs }: { digit: string; delayMs: number }) {
  const reduced = usePrefersReducedMotion();
  // Starts blank so the board deals itself in once on mount, then settles.
  const [shown, setShown] = useState("");
  // The digit being turned over FROM. Null whenever nothing is in motion, which
  // is the normal resting state and the only one most renders ever see.
  const [previous, setPrevious] = useState<string | null>(null);

  useEffect(() => {
    if (digit === shown) return;
    setShown(digit);
    setPrevious(reduced ? null : shown);
  }, [digit, shown, reduced]);

  // Belt and braces: `animationend` can be missed if the element is torn down
  // or never painted, and a flap left lying on top of the card would show a
  // stale digit for good.
  useEffect(() => {
    if (previous === null) return;
    const timer = window.setTimeout(() => setPrevious(null), DURATION_MS + delayMs + 120);
    return () => window.clearTimeout(timer);
  }, [previous, delayMs]);

  const flipping = previous !== null;
  const style = { "--flip-delay": `${delayMs}ms` } as CSSProperties;

  return (
    <span className="flip-card" style={style} aria-hidden>
      {/* Static halves: the top already shows the NEW digit, waiting to be
          uncovered; the bottom still shows the OLD one until the rising flap
          covers it. */}
      <span className="flip-face flip-face-top">
        <span className="flip-glyph flip-glyph-top">{shown}</span>
      </span>
      <span className="flip-face flip-face-bottom">
        <span className="flip-glyph flip-glyph-bottom">{flipping ? previous : shown}</span>
      </span>

      {flipping ? (
        <>
          <span
            className="flip-face flip-face-top flip-fall"
            onAnimationEnd={() => setPrevious(null)}
          >
            <span className="flip-glyph flip-glyph-top">{previous}</span>
          </span>
          <span className="flip-face flip-face-bottom flip-rise">
            <span className="flip-glyph flip-glyph-bottom">{shown}</span>
          </span>
        </>
      ) : null}
    </span>
  );
}
