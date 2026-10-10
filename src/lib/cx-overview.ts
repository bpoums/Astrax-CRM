import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { groupByCategory, readStatusTone, type CxCategory, type StatusTone } from "@/lib/cx-status";

/**
 * The shape of the CX backlog, over APPROVED leads: how many exist, how many have
 * had any status set, and how many nobody has touched — plus, separately, how
 * many CX has sent back to the manager for re-validation.
 *
 * `total` is the approved leads on the pipeline (the figure on the Submission
 * Outcome card). `cx_untouched` counts an approved lead as untouched when it has
 * no `cx_lead_status` row OR has one with all four dimensions null — a lead whose
 * statuses were all cleared is back in the backlog. So "in CX" is derived as
 * total minus untouched rather than counted off `cx_lead_status` directly; a raw
 * row count would claim such a lead twice and the two numbers would not add up
 * to `total`. Sent-back leads are on the pipeline table too but are neither
 * approved nor untouched, so they have a count of their own (`total + sentBack`
 * is every row of the table).
 */

export const CX_COVERAGE_KEY = ["cx", "coverage"] as const;

export function useCxCoverage() {
  const query = useQuery({
    queryKey: CX_COVERAGE_KEY,
    queryFn: async () => {
      // head:true asks for the count without the rows.
      const [approved, untouched, sentBack, waiting] = await Promise.all([
        supabase
          .from("cx_pipeline")
          .select("submission_id", { count: "exact", head: true })
          .eq("disposition", "accepted"),
        supabase.from("cx_untouched").select("submission_id", { count: "exact", head: true }),
        // Sent back for re-validation and not approved again: the rule the
        // pipeline table's own "Sent back" chip uses.
        supabase
          .from("cx_pipeline")
          .select("submission_id", { count: "exact", head: true })
          .not("reopened_from_cx_at", "is", null)
          .or("disposition.is.null,disposition.neq.accepted"),
        // Of those, the ones nobody has picked up yet.
        supabase
          .from("cx_pipeline")
          .select("submission_id", { count: "exact", head: true })
          .not("reopened_from_cx_at", "is", null)
          .or("disposition.is.null,disposition.neq.accepted")
          .eq("status", "pending_manager"),
      ]);
      if (approved.error) throw approved.error;
      if (untouched.error) throw untouched.error;
      if (sentBack.error) throw sentBack.error;
      if (waiting.error) throw waiting.error;

      const total = approved.count ?? 0;
      const idle = untouched.count ?? 0;
      return {
        total,
        untouched: idle,
        inCx: Math.max(0, total - idle),
        sentBack: sentBack.count ?? 0,
        sentBackWaiting: waiting.count ?? 0,
      };
    },
  });

  return {
    ...query,
    total: query.data?.total ?? 0,
    untouched: query.data?.untouched ?? 0,
    inCx: query.data?.inCx ?? 0,
    sentBack: query.data?.sentBack ?? 0,
    sentBackWaiting: query.data?.sentBackWaiting ?? 0,
  };
}

export type StatusSummaryRow = {
  category: CxCategory;
  code: string;
  label: string;
  tone: StatusTone;
  sort_order: number;
  lead_count: number;
};

export const CX_SUMMARY_KEY = ["cx", "status-summary"] as const;

const CATEGORIES: readonly string[] = ["policy", "premium", "commission", "chargeback"];

/**
 * Per-option lead counts, one row per active status option.
 *
 * The four dimensions are independent and stay that way: this groups counts
 * under the category they belong to and never combines them. A lead counted
 * under Policy "Issued / Active" may equally be counted under Premium "Payment
 * Failed", and both facts are true at once.
 */
export function useCxStatusSummary() {
  const query = useQuery({
    queryKey: CX_SUMMARY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cx_status_summary")
        .select("category, code, label, tone, sort_order, lead_count")
        .order("sort_order", { ascending: true });
      if (error) throw error;

      const rows: StatusSummaryRow[] = (data ?? []).flatMap((row) => {
        // Every column on a view is nullable to the type generator; a row
        // missing its category or code cannot be placed under a heading.
        if (!row.category || !row.code || !CATEGORIES.includes(row.category)) return [];
        return [
          {
            category: row.category as CxCategory,
            code: row.code,
            label: row.label ?? row.code,
            tone: readStatusTone(row.tone),
            sort_order: row.sort_order ?? 0,
            lead_count: row.lead_count ?? 0,
          },
        ];
      });
      return rows;
    },
  });

  return {
    ...query,
    rows: query.data ?? [],
    byCategory: groupByCategory(query.data ?? []),
  };
}
