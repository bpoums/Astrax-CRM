import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatEventTime } from "@/lib/format-date";
import { ClampedText } from "@/components/free-text";
import { formatOffset } from "@/components/ops";
import { presentEvent } from "@/lib/event-labels";
import { groupIntoPasses } from "@/lib/validation-passes";
import {
  TimelineChurn,
  TimelineEmpty,
  TimelineGroup,
  TimelineList,
  TimelineRow,
  TimelineSection,
} from "@/components/timeline";

/**
 * A lead's `form_events` trail, told as the hand-offs it actually was.
 *
 * The events are grouped into PASSES — one validator's tenure, from the
 * assignment to the outcome — because that is the unit the floor talks in, and
 * because a flat list buries the two events that matter under the ten that do
 * not. See `validation-passes.ts` for the grouping and `event-labels.ts` for
 * the wording; this file only draws them.
 *
 * Time is measured two ways on purpose. Events outside a pass keep their wall
 * clock, since they are what a reader dates the lead by. Events inside one show
 * the gap since the assignment, because "held six times in eight minutes" is
 * the fact, and the reader should not have to subtract timestamps to find it.
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

export function ValidationTimeline({
  submissionId,
  /** Reporting shows seconds: its events can land inside the same minute. */
  seconds = false,
  /** The larger, more breathing-room variant `LeadHistoryDialog` asks for. */
  comfortable = false,
}: {
  submissionId: string | null;
  seconds?: boolean;
  comfortable?: boolean;
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
      return (data ?? []) as unknown as TimelineEventRow[];
    },
  });

  const events = timeline.data ?? [];
  const segments = groupIntoPasses(events);
  const passes = segments.filter((segment) => segment.kind === "pass").length;

  const stamp = (iso: string) => formatEventTime(iso, seconds ? { seconds: true } : undefined);

  /** One row, wherever it sits. `since` switches the clock to an offset. */
  const row = (event: TimelineEventRow, since?: string) => {
    const shown = presentEvent(event);
    return (
      <TimelineRow
        key={event.id}
        tone={shown.tone}
        actor={actorName(event)}
        time={since ? formatOffset(since, event.created_at) : stamp(event.created_at)}
        comfortable={comfortable}
        note={
          shown.note ? (
            <ClampedText
              text={shown.note}
              heading={shown.text}
              meta={`${actorName(event)} · ${stamp(event.created_at)}`}
            />
          ) : null
        }
      >
        {shown.text}
      </TimelineRow>
    );
  };

  return (
    <TimelineSection
      title="Validation"
      summary={
        events.length === 0
          ? undefined
          : `${passes === 1 ? "1 pass" : `${passes} passes`} · ${events.length} events`
      }
    >
      {events.length === 0 ? (
        <TimelineEmpty>{timeline.isLoading ? "Loading…" : "No events visible."}</TimelineEmpty>
      ) : (
        <TimelineList comfortable={comfortable}>
          {segments.map((segment) => {
            if (segment.kind === "event") return row(segment.event);

            const { pass } = segment;
            const opened = pass.assigned;
            // Every event in the pass is measured from the assignment that
            // opened it, so the offsets read as one continuous clock.
            const since = opened?.created_at;

            return (
              <TimelineGroup
                key={`pass-${pass.number}-${opened?.id ?? "none"}`}
                heading={`Pass ${pass.number}`}
                meta={
                  opened ? `assigned by ${actorName(opened)} · ${stamp(opened.created_at)}` : null
                }
                comfortable={comfortable}
              >
                {pass.items.map((item) => {
                  if (item.kind === "event") return row(item.event, since);

                  const first = item.events[0];
                  const last = item.events[item.events.length - 1];
                  return (
                    <TimelineChurn
                      key={`churn-${first?.id ?? pass.number}`}
                      summary={`${item.attempts} attempts, ${item.holds} ${
                        item.holds === 1 ? "hold" : "holds"
                      }`}
                      time={since && last ? formatOffset(since, last.created_at) : null}
                      comfortable={comfortable}
                    >
                      {item.events.map((event) => row(event, since))}
                    </TimelineChurn>
                  );
                })}
              </TimelineGroup>
            );
          })}
        </TimelineList>
      )}
    </TimelineSection>
  );
}
