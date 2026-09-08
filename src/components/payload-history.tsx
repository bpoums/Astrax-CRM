import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ClampedText } from "@/components/free-text";
import { payloadDisplayLabel } from "@/components/ops";
import { formatEventTime } from "@/lib/format-date";

/**
 * Who changed which payload field, from what to what.
 *
 * `update_payload_field` writes a row here per field it changes, so this is the
 * before/after record the validation timeline cannot give: `form_events` notes
 * that a payload was edited, this says what the value used to be. Newest first,
 * because the question being asked is almost always "what just changed".
 *
 * An empty value is rendered as "empty" rather than as an em dash: a field
 * cleared on purpose and a field that never had a value read the same way
 * otherwise.
 *
 * A handful of edits predate this: they were written by a bulk-patch RPC that
 * recorded an event naming the fields and nothing else, so their old and new
 * values do not exist anywhere and never will. They are still listed, because
 * an edit that happened is worth knowing about, but they say plainly that the
 * values were not recorded rather than drawing two blanks as if the field had
 * been cleared.
 */

type EditRow = {
  id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  edited_at: string;
  actor: { full_name: string | null } | null;
};

type EventRow = {
  id: number;
  created_at: string;
  detail: Record<string, unknown> | null;
  actor: { full_name: string | null } | null;
};

/** One line in the list: either a full before/after, or a bare "it changed". */
type Entry = {
  key: string;
  field: string;
  at: string;
  actor: string | null;
} & ({ recorded: true; old: string | null; next: string | null } | { recorded: false });

export function payloadHistoryKey(submissionId: string | null) {
  return ["payload-edits", submissionId] as const;
}

/**
 * How far apart the `payload_edits` row and the `payload_edited` event may be
 * and still be the same edit.
 *
 * Both are written by one call inside one transaction, so in practice they
 * share a timestamp to the millisecond. The window only has to be wide enough
 * to survive that not being exactly true, and narrow enough that two genuine
 * edits of the same field cannot collapse into one — nobody edits one field
 * twice in two seconds, and if they somehow did, both rows exist and both are
 * matched anyway.
 */
const SAME_EDIT_MS = 2000;

/**
 * The events that no `payload_edits` row accounts for.
 *
 * Everything written since edits started going through `update_payload_field`
 * has a row, so this only ever yields the old bulk-patch edits. Matching on
 * field and time rather than on the event's shape means it stays correct
 * whatever detail the RPC records.
 */
function unrecordedEntries(events: EventRow[], edits: EditRow[]): Entry[] {
  const out: Entry[] = [];
  for (const event of events) {
    const fields = Array.isArray(event.detail?.["fields"]) ? event.detail["fields"] : [];
    const at = new Date(event.created_at).getTime();
    for (const raw of fields) {
      if (typeof raw !== "string") continue;
      const covered = edits.some(
        (edit) =>
          edit.field === raw && Math.abs(new Date(edit.edited_at).getTime() - at) <= SAME_EDIT_MS,
      );
      if (covered) continue;
      out.push({
        key: `event-${event.id}-${raw}`,
        field: raw,
        at: event.created_at,
        actor: event.actor?.full_name ?? null,
        recorded: false,
      });
    }
  }
  return out;
}

export function PayloadEditHistory({ submissionId }: { submissionId: string | null }) {
  const history = useQuery({
    queryKey: payloadHistoryKey(submissionId),
    enabled: !!submissionId,
    queryFn: async () => {
      const edits = await supabase
        .from("payload_edits")
        .select(
          "id, field, old_value, new_value, edited_at, actor:profiles!payload_edits_actor_id_fkey(full_name)",
        )
        .eq("submission_id", submissionId!)
        .order("edited_at", { ascending: false })
        .order("id", { ascending: false });
      if (edits.error) throw edits.error;

      // The events are only read to find the ones nothing accounts for. A
      // failure here must not cost the reader the history that IS recorded, so
      // it degrades to an empty list rather than throwing.
      const events = await supabase
        .from("form_events")
        .select("id, created_at, detail, actor:profiles!form_events_actor_id_fkey(full_name)")
        .eq("submission_id", submissionId!)
        .eq("event_type", "payload_edited")
        .order("created_at", { ascending: false });

      return {
        edits: (edits.data ?? []) as unknown as EditRow[],
        events: events.error ? [] : ((events.data ?? []) as unknown as EventRow[]),
      };
    },
  });

  const edits = history.data?.edits ?? [];
  const events = history.data?.events ?? [];

  const entries: Entry[] = [
    ...edits.map((row): Entry => ({
      key: `edit-${row.id}`,
      field: row.field,
      at: row.edited_at,
      actor: row.actor?.full_name ?? null,
      recorded: true,
      old: row.old_value,
      next: row.new_value,
    })),
    ...unrecordedEntries(events, edits),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">Edit history</h3>
        <span className="text-[0.66rem] text-muted-foreground">Payload changes</span>
      </div>

      <ol className="min-w-0 divide-y divide-border rounded-md border border-border">
        {entries.map((entry) => (
          <li key={entry.key} className="flex min-w-0 flex-col gap-0.5 px-3 py-1.5">
            {/* The same word the panel above calls this field, so a lead does
                not read as "Carrier Name" in the details and "Agency" in its
                own edit history. `entry.field` stays the stored key. */}
            <span className="field-label">{payloadDisplayLabel(entry.field)}</span>
            {entry.recorded ? (
              <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-baseline gap-1.5">
                <Value field={payloadDisplayLabel(entry.field)} text={entry.old} muted />
                <span aria-hidden className="text-muted-foreground">
                  →
                </span>
                <Value field={payloadDisplayLabel(entry.field)} text={entry.next} />
              </span>
            ) : (
              <span className="text-[0.68rem] italic text-muted-foreground">
                field edited (values not recorded)
              </span>
            )}
            <span className="text-[0.66rem] text-muted-foreground">
              <span className="text-foreground">{entry.actor ?? "system"}</span> ·{" "}
              {formatEventTime(entry.at)}
            </span>
          </li>
        ))}
        {entries.length === 0 ? (
          <li className="px-3 py-1.5 text-xs text-muted-foreground">
            {history.isError
              ? (history.error as Error).message
              : history.isLoading
                ? "Loading…"
                : "This lead has not been edited."}
          </li>
        ) : null}
      </ol>
    </div>
  );
}

function Value({
  field,
  text,
  muted = false,
}: {
  field: string;
  text: string | null;
  muted?: boolean;
}) {
  if (!text) {
    return <span className="text-[0.68rem] italic text-muted-foreground">empty</span>;
  }
  return (
    <span
      className={`min-w-0 text-[0.68rem] ${muted ? "text-muted-foreground line-through" : "text-foreground"}`}
    >
      <ClampedText text={text} heading={field} lines={1} />
    </span>
  );
}
