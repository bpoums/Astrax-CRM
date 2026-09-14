import type { ReactNode } from "react";
import type { EventTone } from "@/lib/event-labels";

/**
 * The shape both of a lead's histories are drawn in: a horizontally
 * scrolling row of self-contained cards, connected left to right.
 *
 * Chosen over a vertical row-per-event list (the previous shape here) because
 * the two panels this feeds — `ValidationTimeline`, `CxLifecycleHistory` —
 * moved out of a cramped 576-672px detail sheet into a dedicated, wide
 * history dialog. A vertical list still grows without bound as a lead
 * accumulates events; a horizontal row of cards keeps every fact for one
 * phase visible on that phase's own card, with nothing hidden behind a
 * click, at the cost of scrolling sideways once there are many phases —
 * the explicit tradeoff picked over a stepper-with-expandable-detail
 * alternative.
 */

const BADGE_TONE: Record<EventTone, string> = {
  muted: "bg-muted text-muted-foreground",
  accent: "bg-accent/15 text-accent",
  positive: "bg-emerald-500/15 text-emerald-500",
  destructive: "bg-destructive/15 text-destructive",
};

const TEXT_TONE: Record<EventTone, string> = {
  muted: "text-muted-foreground",
  accent: "text-foreground",
  positive: "text-emerald-500",
  destructive: "text-destructive",
};

export function HistorySection({
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
      {children}
    </div>
  );
}

/** Nothing happened, or nothing this reader may see. */
export function HistoryEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/** One horizontally-scrolling row of cards. Callers intersperse `CardConnector`. */
export function CardRow({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 items-stretch gap-2 overflow-x-auto pb-2">{children}</div>;
}

export function CardConnector() {
  return (
    <span aria-hidden className="flex shrink-0 items-center text-muted-foreground">
      →
    </span>
  );
}

/**
 * One self-contained phase or status card.
 *
 * Every fact worth knowing about this phase lives on the card itself — that
 * is the whole point of this shape over a click-to-expand row. `badge` names
 * what kind of phase this is ("Pass 2", "Submitted"); `heading` is who or
 * what it resolved to; `outcome` is the one line worth a reader's attention
 * (an acceptance, a rejection, a timeout), coloured distinctly from the
 * quieter `lines`.
 */
export function EventCard({
  badge,
  heading,
  time,
  lines = [],
  outcome,
  highlight = false,
}: {
  badge?: { label: string; tone: EventTone } | undefined;
  heading: ReactNode;
  time?: string | null;
  lines?: string[];
  outcome?: { text: string; tone: EventTone } | undefined;
  /** The lead's current/final state on this card — a soft emerald frame,
   * the same hardcoded exception `DispositionBadge` uses for "accepted". */
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex w-[200px] shrink-0 flex-col gap-1 rounded-lg border px-3 py-2.5 ${
        highlight ? "border-emerald-500/50 bg-emerald-500/5" : "border-border bg-card"
      }`}
    >
      {badge ? (
        <span
          className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wide ${BADGE_TONE[badge.tone]}`}
        >
          {badge.label}
        </span>
      ) : null}
      <span className="min-w-0 truncate font-display text-sm font-semibold text-foreground">
        {heading}
      </span>
      {time ? (
        <span className="text-[0.68rem] tabular-nums text-muted-foreground">{time}</span>
      ) : null}
      {lines.map((line, index) => (
        <span key={index} className="min-w-0 text-xs text-muted-foreground">
          {line}
        </span>
      ))}
      {outcome ? (
        <span className={`text-xs font-semibold ${TEXT_TONE[outcome.tone]}`}>{outcome.text}</span>
      ) : null}
    </div>
  );
}

/** Interleaves `CardConnector`s between an array of cards, keyed. */
export function connectCards(cards: { key: string; node: ReactNode }[]): ReactNode[] {
  return cards.flatMap(({ key, node }, index) =>
    index === 0
      ? [<span key={key}>{node}</span>]
      : [<CardConnector key={`${key}-arrow`} />, <span key={key}>{node}</span>],
  );
}
