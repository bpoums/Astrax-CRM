/** Bucketing for the free-text "Plan Type" payload field, as typed on both forms. */

export const PLAN_TYPE_BUCKETS = ["Level", "Graded", "Mod", "GI"] as const;

export type PlanTypeBucket = (typeof PLAN_TYPE_BUCKETS)[number] | "Unspecified";

export const PLAN_TYPE_COLUMNS = [
  ...PLAN_TYPE_BUCKETS,
  "Unspecified",
] as const satisfies readonly PlanTypeBucket[];

/**
 * Both forms offer "Level" / "Graded" / "Mod" / "G.I" as the canonical
 * options, but the stored value has drifted in real data: different casing
 * (LEVEL, GI), punctuation (G.I vs GI), and at least one lead typed as
 * "Graded / Mod". Mod is kept as its own bucket rather than folded into
 * Graded — it's the rarer, more specific category, and merging it would hide
 * it entirely from a report meant to surface exactly this kind of count.
 */
export function normalizePlanType(raw: unknown): PlanTypeBucket {
  if (typeof raw !== "string") return "Unspecified";
  const value = raw.trim().toUpperCase();
  if (!value) return "Unspecified";
  if (value.includes("MOD")) return "Mod";
  if (value.includes("LEVEL")) return "Level";
  if (value.includes("GRADED")) return "Graded";
  if (value.replace(/\./g, "") === "GI") return "GI";
  return "Unspecified";
}
