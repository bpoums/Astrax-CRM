import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatEventTime } from "@/lib/format-date";
import { StatusChip } from "@/components/cx-status-cell";
import {
  CATEGORY_LABEL,
  CX_CATEGORIES,
  groupByCategory,
  useCxStatusOptions,
  type CxCategory,
  type CxStatusOption,
} from "@/lib/cx-status";
import { ClampedText } from "@/components/free-text";
import {
  TimelineEmpty,
  TimelineGroup,
  TimelineList,
  TimelineRow,
  TimelineSection,
} from "@/components/timeline";

/**
 * A lead's customer-lifecycle history: every status change, per dimension.
 *
 * Deliberately separate from the validation timeline. That one records the
 * workflow — submitted, assigned, claimed, disposed — and stops once a lead is
 * approved. This one begins there. Showing them as one list would suggest a
 * single sequence, when they are two different stories about the same lead, so
 * both are rendered in the same SHAPE and each is labelled for what it is.
 *
 * Grouped by dimension rather than interleaved, because the four are
 * independent: a policy moving to Lapsed says nothing about where the
 * commission got to, and reading them as one stream invites exactly that
 * inference.
 *
 * `cx_status_history` stores CODES — `PAYMENT_FAILED`, `ISSUED_ACTIVE` — and
 * this used to render them raw, in a chip hardcoded to muted. So the panel
 * showed database constants in grey, in the one place where colour answers the
 * question being asked: did this lead get better or worse? Both are now
 * resolved against the same vocabulary the pickers use.
 */

type HistoryRow = {
  id: number;
  category: CxCategory;
  from_code: string | null;
  to_code: string | null;
  reason: string | null;
  changed_at: string;
  actor: { full_name: string | null } | null;
};

export function CxLifecycleHistory({ submissionId }: { submissionId: string }) {
  /**
   * Retired options included: a lead can be sitting on a status that has since
   * been deactivated, and a change that resolved to a blank chip would be worse
   * than the raw code this replaces.
   */
  const vocabulary = useCxStatusOptions(false);

  const history = useQuery({
    queryKey: ["cx", "history", submissionId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cx_status_history")
        .select(
          "id, category, from_code, to_code, reason, changed_at, actor:profiles!cx_status_history_actor_id_fkey(full_name)",
        )
        .eq("submission_id", submissionId)
        // Ascending, like the validation timeline beside it: both are stories
        // about this lead and both should be read in the order they happened.
        .order("changed_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as HistoryRow[];
    },
  });

  const rows = history.data ?? [];
  const byCategory = groupByCategory(rows);
  const dimensions = CX_CATEGORIES.filter((category) => byCategory[category].length > 0);

  /** A stored code, resolved to the option it names. Null where it is unset. */
  const optionFor = (category: CxCategory, code: string | null): CxStatusOption | null => {
    if (!code) return null;
    return vocabulary.byCategory[category].find((option) => option.code === code) ?? null;
  };

  /**
   * The chip for one end of a change.
   *
   * The destination carries its real tone and the source stays muted, so the
   * eye lands on where the lead ended up rather than on where it came from. An
   * unset end renders as a dashed "Not set" rather than as nothing, because
   * "was never set" and "was cleared" are different facts.
   */
  const chip = (category: CxCategory, code: string | null, current: boolean) => {
    const option = optionFor(category, code);
    if (!option) return <StatusChip label="Not set" tone="muted" muted />;
    return <StatusChip label={option.label} tone={current ? option.tone : "muted"} />;
  };

  return (
    <TimelineSection
      title="Customer lifecycle"
      summary={
        rows.length === 0
          ? undefined
          : `${rows.length === 1 ? "1 change" : `${rows.length} changes`} · ${
              dimensions.length === 1 ? "1 dimension" : `${dimensions.length} dimensions`
            }`
      }
    >
      {rows.length === 0 ? (
        <TimelineEmpty>
          {history.isLoading ? "Loading…" : "No CX status has been set on this lead yet."}
        </TimelineEmpty>
      ) : (
        <TimelineList>
          {dimensions.map((category) => (
            <TimelineGroup key={category} heading={CATEGORY_LABEL[category]}>
              {byCategory[category].map((entry) => {
                const actor = entry.actor?.full_name ?? "—";
                const when = formatEventTime(entry.changed_at);
                return (
                  <TimelineRow
                    key={entry.id}
                    actor={actor}
                    time={when}
                    note={
                      entry.reason ? (
                        <ClampedText
                          text={entry.reason}
                          heading={CATEGORY_LABEL[category]}
                          meta={`${actor} · ${when}`}
                        />
                      ) : null
                    }
                  >
                    <span className="inline-flex flex-wrap items-center gap-1">
                      {chip(category, entry.from_code, false)}
                      <span aria-hidden className="text-muted-foreground">
                        →
                      </span>
                      {chip(category, entry.to_code, true)}
                    </span>
                  </TimelineRow>
                );
              })}
            </TimelineGroup>
          ))}
        </TimelineList>
      )}
    </TimelineSection>
  );
}
