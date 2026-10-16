import type { Disposition, SubStatus } from "@/components/ops";
import { supabase } from "@/integrations/supabase/client";
import {
  CX_CATEGORIES,
  CX_LEAD_STATUS_FK,
  type CxCategory,
  type OptionsByCategory,
} from "@/lib/cx-status";
import {
  finalCarrierSearchClauses,
  matchingCarrierIds,
  matchingProfileIds,
  payloadSearchClauses,
  personSearchClauses,
  proposedCarrierSearchClauses,
} from "@/lib/lead-search";

/**
 * Every filter the Exports tab offers, and the one function that turns them into
 * a query.
 *
 * One builder for both consumers — the paged table and "select all matching" —
 * so the rows a reader ticks are always exactly the rows the table was showing.
 * The composition is the Closing Desk's: each filter is its own `or` group or its
 * own condition, PostgREST ANDs them, and everything runs in the database (this
 * table is paged, so a browser-side match would only ever see the rows already
 * fetched).
 *
 * Every lead is in scope, submitted or not. Archived leads are hidden unless the
 * Archived filter asks for them, as everywhere else in the CRM — see
 * docs/features/lead-export.md.
 */

export const ANY = "any";
export const NOT_SET = "none";

export const ORIGINS = ["closer", "validator", "manual"] as const;
export type Origin = (typeof ORIGINS)[number];
export const ORIGIN_LABEL: Record<Origin, string> = {
  closer: "Closer",
  validator: "Validator",
  manual: "Manual",
};

/** Archived rows: hidden by default, or included, or the only ones shown. */
export const ARCHIVED_MODES = ["hide", "include", "only"] as const;
export type ArchivedMode = (typeof ARCHIVED_MODES)[number];
export const ARCHIVED_LABEL: Record<ArchivedMode, string> = {
  hide: "Hide archived",
  include: "Include archived",
  only: "Archived only",
};

export type ExportFilters = {
  search: string;
  /** Bank name, on the payload or on an imported lead's payment details. */
  bank: string;
  /** ANY, NOT_SET (not disposed), or a disposition. */
  disposition: typeof ANY | typeof NOT_SET | Disposition;
  /** ANY, or a validation status. */
  status: typeof ANY | SubStatus;
  archived: ArchivedMode;
  proposedCarrier: string;
  finalCarrier: string;
  /** ANY, or an Origin. */
  origin: string;
  /** ANY, NOT_SET, or a centre id (ids, so a rename cannot empty the filter). */
  center: string;
  /** ANY, NOT_SET (any gap), or one field's label. */
  missing: string;
  missingBank: string;
  /** Per CX category: ANY, NOT_SET, or an option code. */
  cx: Record<CxCategory, string>;
  /** "Submitted on" — when the outcome was recorded (`disposed_at`). */
  submittedFrom: string;
  submittedTo: string;
  /** "Sale made on" — when the lead first entered the queue (`created_at`). */
  saleFrom: string;
  saleTo: string;
  draftFrom: string;
  draftTo: string;
  ageFrom: string;
  ageTo: string;
};

export const NO_CX: Record<CxCategory, string> = {
  policy: ANY,
  premium: ANY,
  commission: ANY,
  chargeback: ANY,
};

export const NO_FILTERS: ExportFilters = {
  search: "",
  bank: "",
  disposition: ANY,
  status: ANY,
  archived: "hide",
  proposedCarrier: "",
  finalCarrier: "",
  origin: ANY,
  center: ANY,
  missing: ANY,
  missingBank: ANY,
  cx: NO_CX,
  submittedFrom: "",
  submittedTo: "",
  saleFrom: "",
  saleTo: "",
  draftFrom: "",
  draftTo: "",
  ageFrom: "",
  ageTo: "",
};

/** PostgREST breaks an `or=(…)` group on these; same sanitiser as lead-search. */
function clean(term: string) {
  return term.replace(/[,()"\\]/g, " ").trim();
}

/** How many filters are on, for the Clear button and the summary. */
export function countActiveFilters(filters: ExportFilters) {
  let n = 0;
  if (clean(filters.search)) n++;
  if (clean(filters.bank)) n++;
  if (filters.disposition !== ANY) n++;
  if (filters.status !== ANY) n++;
  if (filters.archived !== "hide") n++;
  if (clean(filters.proposedCarrier)) n++;
  if (clean(filters.finalCarrier)) n++;
  if (filters.origin !== ANY) n++;
  if (filters.center !== ANY) n++;
  if (filters.missing !== ANY) n++;
  if (filters.missingBank !== ANY) n++;
  for (const category of CX_CATEGORIES) if (filters.cx[category] !== ANY) n++;
  if (filters.submittedFrom || filters.submittedTo) n++;
  if (filters.saleFrom || filters.saleTo) n++;
  if (filters.draftFrom || filters.draftTo) n++;
  if (filters.ageFrom || filters.ageTo) n++;
  return n;
}

/** The part of the key that changes the result — query keys and page resets. */
export function filtersKey(filters: ExportFilters) {
  return JSON.stringify({
    ...filters,
    search: clean(filters.search),
    bank: clean(filters.bank),
  });
}

/** Both bounds blank = no filter; one bound = that single day; reversed = swapped. */
function normaliseRange(from: string, to: string): [string, string] | null {
  const lo = from || to;
  const hi = to || from;
  if (!lo) return null;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

type Window = { since: string | null; until: string | null };

/** Day boundaries come from the database (Pacific calendar days), never from JS. */
async function dayWindow(from: string, to: string): Promise<Window | null> {
  const range = normaliseRange(from, to);
  if (!range) return null;
  const { data, error } = await supabase
    .rpc("reporting_window", { p_start_date: range[0], p_end_date: range[1] })
    .single();
  if (error) throw error;
  return data;
}

/**
 * Age is stored as TEXT in the payload ("70"), so gte/lte would sort "9" above
 * "70". The range is expanded into the exact ages and matched with `in`.
 */
function agesInRange(from: string, to: string): string[] | null {
  const range = normaliseRange(from, to);
  if (!range) return null;
  const a = Number(range[0]);
  const b = Number(range[1]);
  const ages: string[] = [];
  for (let n = Math.max(0, a); n <= Math.min(120, b); n++) ages.push(String(n));
  // A range wholly outside 0–120 matches nothing, as it should.
  return ages.length > 0 ? ages : ["-1"];
}

/** Lead ids whose imported bank name matches; throws the RPC's own refusal text. */
async function leadIdsByBank(term: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("lead_ids_by_bank", { p_term: term });
  if (error) throw error;
  return data ?? [];
}

type Options = {
  /** Everything before the filters: the select list, without CX embeds. */
  select: string;
  count?: "exact";
  head?: boolean;
  cxByCategory: OptionsByCategory;
};

/**
 * The accepted, non-archived leads matching `filters`, ready for `.order()` and
 * `.range()`. Async because a few filters resolve a name to ids (or a day to a
 * window) before the main query can be written.
 */
export async function buildExportQuery(filters: ExportFilters, options: Options) {
  const term = clean(filters.search);
  const proposedTerm = clean(filters.proposedCarrier);
  const finalTerm = clean(filters.finalCarrier);
  const bankTerm = clean(filters.bank);

  const profileIds = term ? await matchingProfileIds(term) : [];
  const finalCarrierIds = finalTerm ? await matchingCarrierIds(finalTerm) : [];
  // An imported lead's bank is in payment_details, which the browser cannot read
  // (RLS, no policy, on purpose). The RPC answers with lead ids and nothing more.
  const bankLeadIds = bankTerm ? await leadIdsByBank(bankTerm) : [];
  const [submittedWindow, saleWindow] = await Promise.all([
    dayWindow(filters.submittedFrom, filters.submittedTo),
    dayWindow(filters.saleFrom, filters.saleTo),
  ]);

  // Concrete CX statuses share one inner join, which ANDs them. "Not set" needs
  // rows with no matching CX row at all, so it gets its own aliased left join per
  // category, then keeps only the rows where that join came back empty.
  const setFilters = CX_CATEGORIES.flatMap((category) => {
    const value = filters.cx[category];
    if (value === ANY || value === NOT_SET) return [];
    const option = options.cxByCategory[category].find((entry) => entry.code === value);
    return option ? [{ category, optionId: option.id }] : [];
  });
  const unsetFilters = CX_CATEGORIES.filter((category) => filters.cx[category] === NOT_SET);

  const select = [options.select];
  if (setFilters.length > 0) select.push(`setf:${CX_LEAD_STATUS_FK}!inner(submission_id)`);
  for (const category of unsetFilters) {
    select.push(`no_${category}:${CX_LEAD_STATUS_FK}(submission_id)`);
  }

  let query = supabase
    .from("submissions")
    .select(select.join(", "), {
      ...(options.count ? { count: options.count } : {}),
      ...(options.head ? { head: true } : {}),
    })
    // No disposition or archived condition of its own: both are filters below.
    .not("id", "is", null);

  if (filters.archived === "hide") query = query.is("archived_at", null);
  else if (filters.archived === "only") query = query.not("archived_at", "is", null);

  if (filters.disposition === NOT_SET) query = query.is("disposition", null);
  else if (filters.disposition !== ANY) query = query.eq("disposition", filters.disposition);
  if (filters.status !== ANY) query = query.eq("status", filters.status);

  // Origin, by the same three tests the Closing Desk and Reporting use: an
  // imported lead is tagged 'closer' with no closer, so the role alone is not it.
  if (filters.origin === "validator") query = query.eq("submitted_by_role", "validator");
  else if (filters.origin === "manual") query = query.eq("source", "sheet");
  else if (filters.origin === "closer") {
    query = query
      .eq("source", "live")
      .or("submitted_by_role.is.null,submitted_by_role.neq.validator");
  }

  if (filters.center === NOT_SET) query = query.is("center_id", null);
  else if (filters.center !== ANY) query = query.eq("center_id", filters.center);

  if (filters.missing === NOT_SET) query = query.not("missing_info", "eq", "{}");
  else if (filters.missing !== ANY) query = query.contains("missing_info", [filters.missing]);
  if (filters.missingBank === NOT_SET) query = query.not("missing_bank", "eq", "{}");
  else if (filters.missingBank !== ANY) {
    query = query.contains("missing_bank", [filters.missingBank]);
  }

  for (const filter of setFilters) {
    query = query.eq(`setf.${filter.category}_status_id`, filter.optionId);
  }
  for (const category of unsetFilters) {
    query = query
      .not(`no_${category}.${category}_status_id`, "is", null)
      .is(`no_${category}`, null);
  }

  if (term) {
    const clauses = [
      ...payloadSearchClauses(term),
      ...personSearchClauses(["closer_id", "uploaded_by"], profileIds),
      `policy_number.ilike.*${term}*`,
      `payload->>Policy Number.ilike.*${term}*`,
    ];
    // Digits only against the normalised column: dashed and plain SSNs both
    // match, and under four digits a fragment would match most of the book.
    const ssnDigits = term.replace(/\D/g, "");
    if (ssnDigits.length >= 4) clauses.push(`ssn_normalized.ilike.*${ssnDigits}*`);
    query = query.or(clauses.join(","));
  }
  if (bankTerm) {
    const clauses = [`payload->>Bank Name.ilike.*${bankTerm}*`];
    if (bankLeadIds.length > 0) clauses.push(`id.in.(${bankLeadIds.join(",")})`);
    query = query.or(clauses.join(","));
  }
  if (proposedTerm) query = query.or(proposedCarrierSearchClauses(proposedTerm).join(","));
  if (finalTerm) query = query.or(finalCarrierSearchClauses(finalTerm, finalCarrierIds).join(","));

  // A row with no `disposed_at` has no submitted date to test, so it drops out.
  if (submittedWindow?.since) query = query.gte("disposed_at", submittedWindow.since);
  if (submittedWindow?.until) query = query.lt("disposed_at", submittedWindow.until);
  if (saleWindow?.since) query = query.gte("created_at", saleWindow.since);
  if (saleWindow?.until) query = query.lt("created_at", saleWindow.until);

  // `draft_date` is a SQL date, so the YYYY-MM-DD strings compare directly.
  const draft = normaliseRange(filters.draftFrom, filters.draftTo);
  if (draft) query = query.gte("draft_date", draft[0]).lte("draft_date", draft[1]);

  const ages = agesInRange(filters.ageFrom, filters.ageTo);
  if (ages) query = query.in("payload->>Age", ages);

  // Wrapped: a query builder is thenable, so returning it bare from an async
  // function would execute it instead of handing it back for .order()/.range().
  return { query };
}
