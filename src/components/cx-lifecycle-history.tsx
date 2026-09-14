import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatEventTime } from "@/lib/format-date";
import {
  CATEGORY_LABEL,
  CX_CATEGORIES,
  groupByCategory,
  useCxStatusOptions,
  type CxCategory,
  type CxStatusOption,
} from "@/lib/cx-status";
import {
  CardRow,
  EventCard,
  HistoryEmpty,
  HistorySection,
  connectCards,
} from "@/components/timeline";

/**
 * A lead's customer-lifecycle history: every status change, per dimension —
 * one horizontal chain of cards per dimension, each card the status it
 * changed TO, running left to right in the order it actually happened.
 *
 * Deliberately separate from the validation timeline. That one records the
 * workflow — submitted, assigned, claimed, disposed — and stops once a lead
 * is approved. This one begins there. Grouped by dimension rather than
 * interleaved, because the four are independent: a policy moving to Lapsed
 * says nothing about where the commission got to.
 *
 * `cx_status_history` stores CODES — `PAYMENT_FAILED`, `ISSUED_ACTIVE` —
 * resolved here against the same vocabulary the pickers use, never printed
 * raw.
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
        .order("changed_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as HistoryRow[];
    },
  });

  const rows = history.data ?? [];
  const byCategory = groupByCategory(rows);
  const dimensions = CX_CATEGORIES.filter((category) => byCategory[category].length > 0);

  const optionFor = (category: CxCategory, code: string | null): CxStatusOption | null => {
    if (!code) return null;
    return vocabulary.byCategory[category].find((option) => option.code === code) ?? null;
  };

  /** One dimension's chain: the starting status, then one card per change. */
  function chainCards(category: CxCategory, entries: HistoryRow[]) {
    const cards: { key: string; node: ReactNode }[] = [];
    const first = entries[0];
    if (first) {
      const option = optionFor(category, first.from_code);
      cards.push({
        key: `${category}-initial`,
        node: (
          <EventCard
            heading={option?.label ?? "Not set"}
            lines={first.from_code ? [] : ["Never set"]}
          />
        ),
      });
    }
    entries.forEach((entry, index) => {
      const option = optionFor(category, entry.to_code);
      const actor = entry.actor?.full_name ?? "system";
      const when = formatEventTime(entry.changed_at);
      cards.push({
        key: `${category}-${entry.id}`,
        node: (
          <EventCard
            heading={option?.label ?? "Not set"}
            time={when}
            lines={[`by ${actor}`]}
            note={entry.reason}
            highlight={index === entries.length - 1 && !!option && option.tone === "positive"}
          />
        ),
      });
    });
    return cards;
  }

  return (
    <HistorySection
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
        <HistoryEmpty>
          {history.isLoading ? "Loading…" : "No CX status has been set on this lead yet."}
        </HistoryEmpty>
      ) : (
        <div className="flex flex-col gap-3">
          {dimensions.map((category) => (
            <div key={category} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {CATEGORY_LABEL[category]}
              </span>
              <CardRow>{connectCards(chainCards(category, byCategory[category]))}</CardRow>
            </div>
          ))}
        </div>
      )}
    </HistorySection>
  );
}
