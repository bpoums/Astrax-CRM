import { supabase } from "@/integrations/supabase/client";
import { CARRIER_KEYS } from "@/components/ops";

/**
 * Searching leads server-side.
 *
 * Every lead table in the app pages through `range()` with an exact count, so
 * the search has to run in the database too. A filter applied in the browser
 * would only ever see the twenty-five rows already on screen and would report
 * "no results" for a customer sitting on page four — silently, with nothing to
 * tell the operator their search was not what they thought it was.
 *
 * The two awkward parts, and how they are handled:
 *
 * - **The customer's name lives in `payload` jsonb.** PostgREST can reach into
 *   it — `payload->>Full Name.ilike.*term*` — and the space in the key is fine
 *   inside an `or=` group.
 * - **The people are in another table.** `closer_id`, `uploaded_by` and
 *   `assigned_to` are uuids pointing at `profiles`, and an embedded filter
 *   (`closer.full_name=ilike.*x*`) cannot be OR-ed with a filter on a base
 *   column. So the names are resolved to ids first, in their own small query,
 *   and folded into the same `or` as `<column>.in.(ids)`.
 */

/** Rows per page, shared by every paged lead table so they all behave alike. */
export const LEAD_PAGE_SIZE = 25;

/**
 * The payload keys a free-text search looks at. Both are what an operator has
 * in front of them when a customer calls — a name, or the number they rang from.
 */
export const SEARCH_KEYS = ["Full Name", "Phone Number"];

/**
 * PostgREST parses `or=(a.op.val,b.op.val)`, so a comma, parenthesis, quote or
 * backslash in the term would end it early or change the logic. They are
 * dropped rather than escaped — this is a search box, not a query language.
 */
export function sanitizeTerm(term: string) {
  return term.replace(/[,()"\\]/g, " ").trim();
}

/** `payload->>Key ILIKE %term%` for each searched key. */
export function payloadSearchClauses(term: string) {
  return SEARCH_KEYS.map((key) => `payload->>${key}.ilike.*${term}*`);
}

/**
 * The carrier filter, as its own `or` group.
 *
 * Kept apart from the free-text search above rather than folded into
 * `SEARCH_KEYS`, for two reasons. PostgREST ANDs repeated filters, so a
 * separate group NARROWS the search instead of widening it — a carrier and a
 * customer name can be combined, which is the useful case. And the general
 * search box is shared with the closing desk, where quietly matching a carrier
 * would change what an unrelated screen returns.
 *
 * Both carrier keys are OR-ed together because the two forms disagree about
 * which one they write — see `CARRIER_KEYS`. The match is a substring, so
 * "fidelity" pulls back "Fidelity Life" and " Fidelity " alike, which is what
 * makes it usable against a free-text field nobody has ever typed consistently.
 */
export function carrierSearchClauses(term: string) {
  return CARRIER_KEYS.map((key) => `payload->>${key}.ilike.*${term}*`);
}

/** The customer's own name, as a single `or` clause. */
export function customerNameSearchClause(term: string) {
  return `payload->>Full Name.ilike.*${term}*`;
}

/**
 * The payload keys that can hold a draft date. A validator submission carries
 * two — the draft itself and the future one taken alongside it — so a filter
 * for "this draft date" has to check both or it would silently miss half of
 * that form's leads.
 */
export const DRAFT_DATE_KEYS = ["Draft Date", "Future Draft Date"] as const;

/** Exact match — both forms store this as the date input's own YYYY-MM-DD. */
export function draftDateSearchClauses(isoDate: string) {
  return DRAFT_DATE_KEYS.map((key) => `payload->>${key}.eq.${isoDate}`);
}

/**
 * The profiles whose name — or whose centre — matches the term.
 *
 * Capped rather than paged: this exists to narrow a lead search, and a term
 * broad enough to match two hundred staff is not one the ids are going to
 * usefully narrow anyway.
 */
export async function matchingProfileIds(term: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .or(`full_name.ilike.*${term}*,org_name.ilike.*${term}*`)
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((row) => row.id);
}

/**
 * `<column>.in.(ids)` for each uuid column that points at a profile, so a lead
 * matches when any of the people on it matches.
 */
export function personSearchClauses(columns: string[], profileIds: string[]) {
  if (profileIds.length === 0) return [];
  const list = profileIds.join(",");
  return columns.map((column) => `${column}.in.(${list})`);
}
