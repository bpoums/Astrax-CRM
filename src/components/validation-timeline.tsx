import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatEventTime } from "@/lib/format-date";
import { StatusChip } from "@/components/cx-status-cell";
import { ClampedText } from "@/components/free-text";
import { eventLabel } from "@/components/ops";

/**
 * A lead's `form_events` trail: submitted, assigned, claimed, disposed, edited.
 *
 * The validation workflow, and only that. It is always rendered beside the CX
 * lifecycle rather than merged into it, because the two are separate stories
 * about the same lead — this one ends where the customer lifecycle begins — and
 * one interleaved list invites the reader to treat them as a single sequence.
 *
 * `form_events` is readable by managers and admins. Anyone else gets an empty
 * list rather than an error, which is why the empty state says "No events
 * visible" rather than claiming nothing happened.
 */

type TimelineEvent = {
  id: number;
  event_type: string;
  created_at: string;
  detail: Record<string, unknown> | null;
  actor: { full_name: string | null } | null;
};

export function validationTimelineKey(submissionId: string | null) {
  return ["validation-timeline", submissionId] as const;
}

export function ValidationTimeline({ submissionId }: { submissionId: string | null }) {
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
      return (data ?? []) as unknown as TimelineEvent[];
    },
  });

  const events = timeline.data ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">Validation timeline</h3>
        <span className="text-[0.66rem] text-muted-foreground">Before approval</span>
      </div>
      <ol className="min-w-0 divide-y divide-border rounded-md border border-border">
        {events.map((event) => (
          <TimelineRow key={event.id} event={event} />
        ))}
        {events.length === 0 ? (
          <li className="px-3 py-1.5 text-xs text-muted-foreground">
            {timeline.isLoading ? "Loading…" : "No events visible."}
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/**
 * A status change carries category, from, to and reason. Everything else in the
 * timeline is a validation-workflow event and keeps its existing shape.
 */
function TimelineRow({ event }: { event: TimelineEvent }) {
  const detail = event.detail ?? {};
  const isStatus = event.event_type === "cx_status_changed";
  const category = typeof detail["category"] === "string" ? detail["category"] : null;
  const from = typeof detail["from"] === "string" ? detail["from"] : null;
  const to = typeof detail["to"] === "string" ? detail["to"] : null;
  const reason = typeof detail["reason"] === "string" ? detail["reason"] : null;

  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-2 px-3 py-1.5">
      <span className="field-label">
        {isStatus && category ? `${category} status` : eventLabel(event.event_type)}
      </span>
      <span className="min-w-0 text-xs text-muted-foreground">
        {isStatus ? (
          <span className="mb-0.5 flex flex-wrap items-center gap-1">
            <StatusChip label={from ?? "Not set"} tone="muted" muted={!from} />
            <span aria-hidden>→</span>
            <StatusChip label={to ?? "Not set"} tone="muted" muted={!to} />
          </span>
        ) : null}
        <span className="text-foreground">{event.actor?.full_name ?? "system"}</span> ·{" "}
        {formatEventTime(event.created_at)}
        {reason ? (
          <ClampedText
            text={reason}
            heading={isStatus && category ? `${category} status` : eventLabel(event.event_type)}
            meta={`${event.actor?.full_name ?? "system"} · ${formatEventTime(event.created_at)}`}
            className="italic"
          />
        ) : null}
      </span>
    </li>
  );
}
