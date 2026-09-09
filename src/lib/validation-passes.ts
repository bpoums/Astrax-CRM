/**
 * A lead's validation history, grouped the way the floor talks about it.
 *
 * Nobody describes a lead as nineteen events. They say "it went to Rabia, she
 * declined it, then Saad had it and held it five times before submitting". That
 * unit — one validator's tenure, from the assignment to the outcome — is a
 * PASS, and the database already counts it: `claimed` carries an `attempt`
 * number that resets per assignment.
 *
 * So this turns a flat event list into passes, and collapses the claim/hold
 * churn inside each one. A real lead in the table has ten consecutive
 * claimed/held events from a single validator across eight minutes; rendered
 * flat they are ten identical rows burying the two that matter.
 *
 * PURE: no React, no I/O, no formatting. It decides structure only — what the
 * rows say is `event-labels.ts`, and how they look is the timeline component.
 */

/** The minimum this module needs to group. Callers pass their own richer row. */
type Event = { event_type: string };

/** A pass opens here. `held` does NOT — a hold keeps the same validator. */
const OPENS_PASS = "assigned";

/** A pass closes on any outcome. Everything after belongs outside it. */
const CLOSES_PASS = new Set(["disposed", "timeout", "rejected"]);

/** The back-and-forth of picking a lead up and putting it down. */
const CHURN = new Set(["claimed", "held"]);

/**
 * Below this, a run is not churn — it is just what happened.
 *
 * Collapsing a single claim into "1 attempt, 0 holds" replaces a clear sentence
 * with a worse one. Three is where the repetition starts costing more to read
 * than the summary does.
 */
const CHURN_THRESHOLD = 3;

export type PassItem<T> =
  { kind: "event"; event: T } | { kind: "churn"; attempts: number; holds: number; events: T[] };

export type ValidationPass<T> = {
  /** 1-based, and a real sequence — these are numbered attempts, not decoration. */
  number: number;
  /** The `assigned` event that opened it, null for a pass with no opener. */
  assigned: T | null;
  /** Everything after the assignment, in order, with churn collapsed. */
  items: PassItem<T>[];
};

export type Segment<T> = { kind: "event"; event: T } | { kind: "pass"; pass: ValidationPass<T> };

/**
 * Fold a maximal run of consecutive claim/hold events into one item.
 *
 * Runs shorter than the threshold are emitted unchanged, so a lead that was
 * claimed once and disposed reads as two plain rows rather than a summary of
 * nothing.
 */
function collapseChurn<T extends Event>(events: T[]): PassItem<T>[] {
  const items: PassItem<T>[] = [];
  let run: T[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length < CHURN_THRESHOLD) {
      for (const event of run) items.push({ kind: "event", event });
    } else {
      items.push({
        kind: "churn",
        attempts: run.filter((event) => event.event_type === "claimed").length,
        holds: run.filter((event) => event.event_type === "held").length,
        events: run,
      });
    }
    run = [];
  };

  for (const event of events) {
    if (CHURN.has(event.event_type)) {
      run.push(event);
      continue;
    }
    flush();
    items.push({ kind: "event", event });
  }
  flush();
  return items;
}

/**
 * Split a lead's events into passes and the events that sit outside them.
 *
 * Events before the first assignment (submitted, parked, approved from an
 * import) and after a pass closes (payload edits, CX changes, archiving) are
 * standalone: they belong to the lead, not to anyone's tenure with it.
 *
 * @param events ascending by time. Order in equals order out.
 */
export function groupIntoPasses<T extends Event>(events: T[]): Segment<T>[] {
  const segments: Segment<T>[] = [];
  let open: { number: number; assigned: T; events: T[] } | null = null;
  let passes = 0;

  const close = () => {
    if (!open) return;
    segments.push({
      kind: "pass",
      pass: { number: open.number, assigned: open.assigned, items: collapseChurn(open.events) },
    });
    open = null;
  };

  for (const event of events) {
    if (event.event_type === OPENS_PASS) {
      // A reassignment without an outcome — the previous pass ended when the
      // manager moved the lead on, so close it where it actually stopped.
      close();
      passes += 1;
      open = { number: passes, assigned: event, events: [] };
      continue;
    }

    if (!open) {
      segments.push({ kind: "event", event });
      continue;
    }

    open.events.push(event);
    if (CLOSES_PASS.has(event.event_type)) close();
  }

  close();
  return segments;
}
