import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * The CX status vocabulary, read from `cx_status_options`.
 *
 * A lead carries four INDEPENDENT statuses. Nothing here relates one category
 * to another, and `set_cx_status` writes exactly one category's columns per
 * call — setting a policy status can never move a premium status, and none of
 * them touch submissions.status or disposition.
 *
 * The whole vocabulary is fetched once and handed down as props. A dropdown per
 * cell would otherwise mean four queries per row.
 */

/** The whole of `cx_status_options_category_check`. */
export const CX_CATEGORIES = ["policy", "premium", "commission", "chargeback"] as const;

export type CxCategory = (typeof CX_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<CxCategory, string> = {
  policy: "Policy Status",
  premium: "Premium Status",
  commission: "Commission Status",
  chargeback: "Chargeback Status",
};

/** The whole of `cx_status_options_tone_check`. */
export const STATUS_TONES = ["muted", "accent", "positive", "destructive", "warning"] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

export const TONE_LABEL: Record<StatusTone, string> = {
  muted: "Muted",
  accent: "Accent",
  positive: "Positive",
  destructive: "Destructive",
  warning: "Warning",
};

export type CxStatusOption = {
  id: string;
  category: CxCategory;
  code: string;
  label: string;
  tone: StatusTone;
  sort_order: number;
  active: boolean;
};

export const CX_STATUS_OPTIONS_KEY = ["cx", "status-options"] as const;

export function cxStatusOptionsKey(activeOnly: boolean) {
  return [...CX_STATUS_OPTIONS_KEY, activeOnly ? "active" : "all"] as const;
}

/**
 * Chip styling per tone.
 *
 * Five tones, one accent colour. `warning` and `accent` are both amber because
 * the palette has exactly one amber, so they are separated by weight instead:
 * solid amber for warning, which is the state actually asking to be worked, and
 * outlined amber for accent, which is progress worth noting but not acting on.
 * `positive` reuses the same hardcoded emerald as DispositionBadge's
 * "Approved" — the documented exception, not a second one.
 */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  muted: "border-border bg-transparent text-muted-foreground",
  accent: "border-accent/70 bg-accent/10 text-accent",
  warning: "border-transparent bg-accent text-accent-foreground",
  positive: "border-transparent bg-emerald-600 text-white",
  destructive: "border-transparent bg-destructive text-destructive-foreground",
};

export function isCxCategory(value: unknown): value is CxCategory {
  return typeof value === "string" && (CX_CATEGORIES as readonly string[]).includes(value);
}

/**
 * "Commission Status" reads as "Commission" once it is next to its own value.
 * Spelled here rather than beside each caller so the trim cannot drift from
 * CATEGORY_LABEL above it.
 */
export function shortCategory(category: CxCategory) {
  return CATEGORY_LABEL[category].replace(/ Status$/, "");
}

export function isStatusTone(value: unknown): value is StatusTone {
  return typeof value === "string" && (STATUS_TONES as readonly string[]).includes(value);
}

/**
 * `category` and `tone` are plain text columns. A value the check constraints
 * would reject can only appear if those constraints change underneath us, so
 * fall back rather than render an unstyled chip.
 */
export function readStatusTone(value: unknown): StatusTone {
  return isStatusTone(value) ? value : "muted";
}

function readOption(row: {
  id: string;
  category: string;
  code: string;
  label: string;
  tone: string;
  sort_order: number;
  active: boolean;
}): CxStatusOption {
  return {
    id: row.id,
    category: isCxCategory(row.category) ? row.category : "policy",
    code: row.code,
    label: row.label,
    tone: readStatusTone(row.tone),
    sort_order: row.sort_order,
    active: row.active,
  };
}

export type OptionsByCategory = Record<CxCategory, CxStatusOption[]>;

/**
 * The vocabulary keyed by id, for the readers that hold a lead's raw
 * `cx_lead_status` row rather than the flattened `cx_pipeline` view. That table
 * stores option ids; the label and tone live here.
 */
export function indexById(items: CxStatusOption[]) {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * Buckets anything category-tagged under its category, always returning all
 * four keys so a caller never has to guard an empty dimension. Generic because
 * the status options and the per-option summary counts are grouped the same way
 * but are not the same shape.
 */
export function groupByCategory<T extends { category: CxCategory }>(
  items: T[],
): Record<CxCategory, T[]> {
  const grouped: Record<CxCategory, T[]> = {
    policy: [],
    premium: [],
    commission: [],
    chargeback: [],
  };
  for (const item of items) grouped[item.category].push(item);
  return grouped;
}

/**
 * The pipeline asks for active options only — a deactivated option must not be
 * offered again. The admin panel asks for all of them, because that is where a
 * deactivated option is brought back.
 */
export function useCxStatusOptions(activeOnly = true) {
  const query = useQuery({
    queryKey: cxStatusOptionsKey(activeOnly),
    // The vocabulary changes only when an admin edits it, and that invalidates
    // this key directly.
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const base = supabase
        .from("cx_status_options")
        .select("id, category, code, label, tone, sort_order, active");
      const scoped = activeOnly ? base.eq("active", true) : base;
      const { data, error } = await scoped
        .order("category", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("label", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(readOption);
    },
  });

  return {
    ...query,
    options: query.data ?? [],
    byCategory: groupByCategory(query.data ?? []),
    byId: indexById(query.data ?? []),
  };
}
