import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatEventTime } from "@/lib/format-date";
import { formatOffset } from "@/components/ops";
import { presentEvent, humanizeEventType, type EventTone } from "@/lib/event-labels";
import { groupIntoPasses, type ValidationPass } from "@/lib/validation-passes";
import {
  CardRow,
  EventCard,
  HistoryEmpty,
  HistorySection,
  connectCards,
} from "@/components/timeline";

/**
 * A lead's `form_events` trail, told as the hand-offs it actually was — one
 * card per standalone event or per validator PASS (assignment to outcome),
 * running left to right rather than down a growing vertical list. See
 * `validation-passes.ts` for the grouping and `event-labels.ts` for the
 * wording; this file only builds the cards.
 *
 * `form_events` is readable by managers and admins. Anyone else gets an empty
 * list rather than an error, which is why the empty state says "No events
 * visible" rather than claiming nothing happened.
 */

type TimelineEventRow = {
  id: number;
  event_type: string;
  created_at: string;
  detail: Record<string, unknown> | null;
  actor: { full_name: string | null } | null;
};

export function validationTimelineKey(submissionId: string | null) {
  return ["validation-timeline", submissionId] as const;
}

/** Who did it, or the system where no person is recorded. */
function actorName(event: TimelineEventRow) {
  return event.actor?.full_name ?? "system";
}

/**
 * The validator who actually worked this pass.
 *
 * `pass.assigned`'s ACTOR is whoever ran `assign_to_validator` — a manager,
 * not the validator the lead went to (the validator's id sits unresolved in
 * `detail.validator`, a bare uuid this panel has no name for). The validator
 * is instead whoever's actor_id shows up on a `claimed`/`held` event — the
 * only actions a validator performs themselves — falling back to whoever
 * disposed it if the pass has no churn recorded at all.
 */
function findValidator(pass: ValidationPass<TimelineEventRow>): string | null {
  for (const item of pass.items) {
    if (item.kind === "churn") return item.events[0] ? actorName(item.events[0]) : null;
    if (item.event.event_type === "claimed" || item.event.event_type === "held") {
      return actorName(item.event);
    }
  }
  for (const item of pass.items) {
    if (
      item.kind === "event" &&
      ["disposed", "timeout", "rejected"].includes(item.event.event_type)
    ) {
      return actorName(item.event);
    }
  }
  return null;
}

/**
 * One pass's card content, folding its churn and outcome into card fields.
 *
 * The outcome line carries the offset from the assignment ("Rejected ·
 * +7m 12s"), not just a timestamp — "held six times in eight minutes" is the
 * fact worth reading, and a reader should not have to subtract two
 * timestamps themselves to find it.
 */
function summarizePass(pass: ValidationPass<TimelineEventRow>, stamp: (iso: string) => string) {
  let attempts = 0;
  let holds = 0;
  let hasChurn = false;
  let outcome: { text: string; tone: EventTone } | null = null;
  const extra: string[] = [];
  const since = pass.assigned?.created_at;

  for (const item of pass.items) {
    if (item.kind === "churn") {
      hasChurn = true;
      attempts += item.attempts;
      holds += item.holds;
      continue;
    }
    const isOutcome = ["disposed", "timeout", "rejected"].includes(item.event.event_type);
    const shown = presentEvent(item.event);
    if (isOutcome) {
      const offset = since ? formatOffset(since, item.event.created_at) : "";
      outcome = { text: offset ? `${shown.text} · ${offset}` : shown.text, tone: shown.tone };
    } else {
      extra.push(shown.text);
    }
  }

  const validator = findValidator(pass);

  return {
    heading: validator ?? "Awaiting claim",
    assignedBy: pass.assigned ? `Assigned by ${actorName(pass.assigned)}` : null,
    openedTime: pass.assigned ? stamp(pass.assigned.created_at) : null,
    churn: hasChurn ? { attempts, holds } : null,
    outcome,
    extra,
  };
}

export function ValidationTimeline({
  submissionId,
  /** Reporting shows seconds: its events can land inside the same minute. */
  seconds = false,
}: {
  submissionId: string | null;
  seconds?: boolean;
}) {
  const timeline = useQuery({
    queryKey: validationTimelineKey(submissionId),
    enabled: !!submissionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("form_events")
        .select(
          "id, event_type, created_at, detail, actor:profiles!form_events_actor_id_fkey(full_name)",
        )
        .eq("submission_id", submissionId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      // `cx_status_changed` is a bare marker `set_cx_status` also writes here
      // — the actual detail (from/to status, reason) lives in
      // `cx_status_history` and is what `CxLifecycleHistory` renders. Kept in
      // `form_events` for other tooling, but showing it here too would be a
      // near-empty card duplicating a story this panel doesn't tell.
      return ((data ?? []) as unknown as TimelineEventRow[]).filter(
        (event) => event.event_type !== "cx_status_changed",
      );
    },
  });

  const events = timeline.data ?? [];
  const segments = groupIntoPasses(events);
  const passCount = segments.filter((segment) => segment.kind === "pass").length;
  const stamp = (iso: string) => formatEventTime(iso, seconds ? { seconds: true } : undefined);

  const cards = segments.map((segment) => {
    if (segment.kind === "event") {
      const shown = presentEvent(segment.event);
      return {
        key: `event-${segment.event.id}`,
        node: (
          <EventCard
            badge={{ label: humanizeEventType(segment.event.event_type), tone: shown.tone }}
            heading={actorName(segment.event)}
            time={stamp(segment.event.created_at)}
            lines={[shown.text]}
          />
        ),
      };
    }

    const { pass } = segment;
    const summary = summarizePass(pass, stamp);
    const lines: string[] = [];
    if (summary.assignedBy) lines.push(summary.assignedBy);
    if (summary.churn) {
      lines.push(
        `${summary.churn.attempts} attempt${summary.churn.attempts === 1 ? "" : "s"}, ${summary.churn.holds} hold${summary.churn.holds === 1 ? "" : "s"}`,
      );
    }
    lines.push(...summary.extra);

    return {
      key: `pass-${pass.number}`,
      node: (
        <EventCard
          badge={{ label: `Pass ${pass.number}`, tone: "accent" }}
          heading={summary.heading}
          time={summary.openedTime}
          lines={lines}
          outcome={summary.outcome ?? undefined}
          highlight={summary.outcome?.tone === "positive"}
        />
      ),
    };
  });

  return (
    <HistorySection
      title="Validation"
      summary={
        events.length === 0
          ? undefined
          : `${passCount === 1 ? "1 pass" : `${passCount} passes`} · ${events.length} events`
      }
    >
      {events.length === 0 ? (
        <HistoryEmpty>{timeline.isLoading ? "Loading…" : "No events visible."}</HistoryEmpty>
      ) : (
        <CardRow>{connectCards(cards)}</CardRow>
      )}
    </HistorySection>
  );
}
