import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { EventTone } from "@/lib/event-labels";

/**
 * The shape both of a lead's histories are drawn in.
 *
 * There were four copies of this before — the validation timeline, a second
 * inline one in Reporting, the customer lifecycle, and the payload edit list —
 * each with its own row anatomy and its own idea of what a heading looks like.
 * They had already drifted. This is the one shape, and the two panels differ
 * only in what they group by: validation by pass, the lifecycle by dimension.
 *
 * Three deliberate choices:
 *
 * - **The rail is drawn only inside a group.** A full-height rule down every
 *   timeline is decoration; a rule that spans one validator's tenure means
 *   containment. Standalone events sit without one.
 * - **Time is a column, not a suffix.** The old rows joined actor and timestamp
 *   with a middle dot, which made every row a sentence to be read rather than
 *   scanned. Right-aligning time lets the eye run down one edge.
 * - **Rows are sentence case.** `.field-label` is uppercase and tracked out; it
 *   earns that on a section heading and shouts on twenty consecutive rows.
 */

/**
 * Tone reaches the row twice, on purpose.
 *
 * The dot always carries it, which gives a scannable colour channel down the
 * left edge. The text takes it only for an outcome — the two things worth
 * interrupting a reader for — so the panel does not become a rainbow. Nothing
 * here is conveyed by colour ALONE: every row says what happened in words.
 */
const DOT: Record<EventTone, string> = {
  muted: "bg-muted-foreground/40",
  accent: "bg-accent",
  positive: "bg-emerald-600",
  destructive: "bg-destructive",
};

const TEXT: Record<EventTone, string> = {
  muted: "text-foreground",
  accent: "text-foreground",
  positive: "text-emerald-500",
  destructive: "text-destructive",
};

export function TimelineSection({
  title,
  summary,
  children,
}: {
  title: string;
  /** The one-line count that saves opening the panel at all. */
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">{title}</h3>
        {summary ? <span className="text-[0.66rem] text-muted-foreground">{summary}</span> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

/**
 * One thing that happened.
 *
 * `time` is preformatted by the caller because the two panels measure it
 * differently: a lifecycle change wants its wall clock, an event inside a pass
 * wants the gap since the pass began.
 */
export function TimelineRow({
  tone = "muted",
  children,
  actor,
  time,
  note,
  comfortable = false,
}: {
  tone?: EventTone;
  /** The sentence. A node, so a caller can put chips in it. */
  children: ReactNode;
  actor?: string | null;
  time?: string | null;
  /** Free text the actor wrote. Rendered quoted, under the row. */
  note?: ReactNode;
  /** A larger, more breathing-room variant for a dedicated full-size view
   * (`LeadHistoryDialog`) — every other caller leaves this off and gets the
   * same dense appearance as before. */
  comfortable?: boolean;
}) {
  return (
    <li className={`flex min-w-0 flex-col ${comfortable ? "gap-1" : "gap-0.5"}`}>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2">
        {/* translate-y aligns a round dot to the baseline of the text beside
            it, which items-baseline cannot do for a bare div. */}
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${DOT[tone]}`}
        />
        <span className={`min-w-0 ${comfortable ? "text-sm" : "text-xs"} ${TEXT[tone]}`}>
          {children}
          {actor ? <span className="text-muted-foreground"> by {actor}</span> : null}
        </span>
        {time ? (
          <span
            className={`shrink-0 tabular-nums text-muted-foreground ${
              comfortable ? "text-xs" : "text-[0.66rem]"
            }`}
          >
            {time}
          </span>
        ) : null}
      </div>
      {note ? (
        <p
          className={`ml-[calc(0.375rem+0.5rem)] min-w-0 border-l-2 border-border pl-2 italic text-muted-foreground ${
            comfortable ? "text-xs" : "text-[0.68rem]"
          }`}
        >
          {note}
        </p>
      ) : null}
    </li>
  );
}

/**
 * A group of rows under one heading, with the rail that says they belong to it.
 *
 * Used for a validation pass and for a lifecycle dimension. `heading` and
 * `meta` sit on one line: what this group is on the left, who opened it and
 * when on the right.
 */
export function TimelineGroup({
  heading,
  meta,
  children,
  comfortable = false,
}: {
  heading: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  comfortable?: boolean;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span
          className={`min-w-0 truncate font-medium text-foreground ${
            comfortable ? "text-sm" : "text-xs"
          }`}
        >
          {heading}
        </span>
        {meta ? (
          <span
            className={`shrink-0 text-muted-foreground ${comfortable ? "text-xs" : "text-[0.66rem]"}`}
          >
            {meta}
          </span>
        ) : null}
      </div>
      <ol
        className={`ml-[3px] flex min-w-0 flex-col gap-1 border-l border-border ${
          comfortable ? "pl-4" : "pl-3"
        }`}
      >
        {children}
      </ol>
    </li>
  );
}

/**
 * The repetition, folded away.
 *
 * A validator picking a lead up and putting it down six times is one fact, not
 * twelve rows. It stays reachable rather than hidden — the count is the
 * headline and the individual events are one click behind it. No animation:
 * this answers a click and shows what changed, and a height transition on a
 * list of unknown length is jitter, not feedback.
 */
export function TimelineChurn({
  summary,
  time,
  children,
  comfortable = false,
}: {
  summary: string;
  time?: string | null;
  children: ReactNode;
  comfortable?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${DOT.accent}`}
        />
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className={`group flex min-w-0 items-center gap-1 text-left text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
            comfortable ? "text-sm" : "text-xs"
          }`}
        >
          <span className="truncate">{summary}</span>
          <ChevronRight
            aria-hidden
            className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
              open ? "rotate-90" : ""
            }`}
          />
        </button>
        {time ? (
          <span
            className={`shrink-0 tabular-nums text-muted-foreground ${
              comfortable ? "text-xs" : "text-[0.66rem]"
            }`}
          >
            {time}
          </span>
        ) : null}
      </div>
      {open ? (
        <ol
          className={`ml-[3px] flex min-w-0 flex-col gap-1 border-l border-border ${
            comfortable ? "pl-4" : "pl-3"
          }`}
        >
          {children}
        </ol>
      ) : null}
    </li>
  );
}

/** The wrapper every list of rows and groups sits in. */
export function TimelineList({
  children,
  comfortable = false,
}: {
  children: ReactNode;
  comfortable?: boolean;
}) {
  return (
    <ol className={`flex min-w-0 flex-col ${comfortable ? "gap-2.5" : "gap-1.5"}`}>{children}</ol>
  );
}

/** Nothing happened, or nothing this reader may see. */
export function TimelineEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground">
      {children}
    </p>
  );
}
