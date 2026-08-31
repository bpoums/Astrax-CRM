import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { StatusChip } from "@/components/cx-status-cell";
import { CATEGORY_LABEL, CX_CATEGORIES, groupByCategory, type CxCategory } from "@/lib/cx-status";
import { ClampedText } from "@/components/free-text";

/**
 * A lead's customer-lifecycle history: every status change, per dimension.
 *
 * Deliberately separate from the `form_events` timeline. That one records the
 * validation workflow — submitted, assigned, claimed, disposed — and stops once
 * a lead is approved. This one begins there. Showing them as one list would
 * suggest a single sequence, when they are two different stories about the same
 * lead, so both are rendered side by side and each is labelled for what it is.
 *
 * Grouped by dimension rather than interleaved, because the four are
 * independent: a policy moving to Lapsed says nothing about where the
 * commission got to, and reading them as one stream invites exactly that
 * inference.
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

function changeTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CxLifecycleHistory({ submissionId }: { submissionId: string }) {
  const history = useQuery({
    queryKey: ["cx", "history", submissionId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cx_status_history")
        .select(
          "id, category, from_code, to_code, reason, changed_at, actor:profiles!cx_status_history_actor_id_fkey(full_name)",
        )
        .eq("submission_id", submissionId)
        .order("changed_at", { ascending: false })
        .order("id", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as HistoryRow[];
    },
  });

  const rows = history.data ?? [];
  const byCategory = groupByCategory(rows);
  const anyChanges = rows.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">Customer lifecycle</h3>
        <span className="text-[0.66rem] text-muted-foreground">Status changes after approval</span>
      </div>

      {!anyChanges ? (
        <p className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground">
          {history.isLoading ? "Loading…" : "No CX status has been set on this lead yet."}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          {CX_CATEGORIES.map((category) => {
            const entries = byCategory[category];
            if (entries.length === 0) return null;
            return (
              <div key={category} className="flex min-w-0 flex-col gap-1">
                <span className="field-label">{CATEGORY_LABEL[category]}</span>
                <ol className="min-w-0 divide-y divide-border rounded-md border border-border">
                  {entries.map((entry) => (
                    <li key={entry.id} className="flex min-w-0 flex-col gap-0.5 px-3 py-1.5">
                      <span className="flex flex-wrap items-center gap-1">
                        <StatusChip
                          label={entry.from_code ?? "Not set"}
                          tone="muted"
                          muted={!entry.from_code}
                        />
                        <span aria-hidden>→</span>
                        <StatusChip
                          label={entry.to_code ?? "Not set"}
                          tone="muted"
                          muted={!entry.to_code}
                        />
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <span className="text-foreground">{entry.actor?.full_name ?? "—"}</span> ·{" "}
                        {changeTime(entry.changed_at)}
                      </span>
                      {entry.reason ? (
                        <span className="min-w-0 border-l-2 border-accent/50 pl-1.5 text-[0.68rem] italic text-muted-foreground">
                          <ClampedText
                            text={entry.reason}
                            heading={CATEGORY_LABEL[category]}
                            meta={`${entry.actor?.full_name ?? "—"} · ${changeTime(entry.changed_at)}`}
                          />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
