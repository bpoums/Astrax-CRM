import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { forceTitleCaseName } from "@/lib/normalize/text";

/**
 * Banks: the list behind the Bank Name dropdown on both intake forms.
 *
 * The lead stores only the bank NAME, as a plain string under the label
 * "Bank Name" (the payload key and the Sheet header), so nothing about the
 * payload changed. The table supplies the list a closer searches, and the
 * `aliases` that let "Chase" or "Wels Fargo" find the right entry. Reads go
 * through RLS; a new bank is added through the `add_bank` RPC.
 */

export type Bank = {
  id: string;
  name: string;
  /** Other spellings that should find this bank when typed. Never displayed. */
  aliases: string[];
  active: boolean;
};

export const BANKS_KEY = ["banks"] as const;

export function banksKey(activeOnly: boolean) {
  return [...BANKS_KEY, activeOnly ? "active" : "all"] as const;
}

export function useBanks(activeOnly = true, enabled = true) {
  return useQuery({
    queryKey: banksKey(activeOnly),
    enabled,
    queryFn: async () => {
      const query = supabase
        .from("banks")
        .select("id, name, aliases, active, created_at, created_by");
      const scoped = activeOnly ? query.eq("active", true) : query;
      const { data, error } = await scoped.order("name", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Words that stay upper-case in a bank name a closer types fresh. Names already
 * in the list are used exactly as stored, so brand spellings such as "KeyBank"
 * and "CommunityAmerica" never pass through here; this only decides how a
 * brand-new name is written down.
 */
const ACRONYMS = new Set([
  "US",
  "TD",
  "PNC",
  "BMO",
  "USAA",
  "CIBC",
  "OZK",
  "UMB",
  "HSBC",
  "SECU",
  "FCU",
  "CU",
  "EECU",
  "MECU",
  "SSFCU",
  "NASA",
  "MUNA",
  "M&T",
  "S&T",
  "BB&T",
  "NA",
  "N.A.",
  "ATM",
  "IBC",
  "BOK",
  "FNB",
  "HFS",
  "PFCU",
]);

/** Kept lower-case unless they open the name: "Bank of America". */
const SMALL_WORDS = new Set(["of", "and", "the", "for", "in", "at", "on", "&"]);

/**
 * Title Case for a bank name typed into the "add a new bank" row.
 *
 * Built on `forceTitleCaseName` (Mc, hyphens, apostrophes), with the two things
 * a bank name needs that a person's does not: acronyms that stay upper-case
 * (`US Bank`, `PNC Bank`, `M&T Bank`) and small words that stay lower-case
 * (`Bank of America`). A leading "(" or trailing ")" is kept, and a two-letter
 * word in brackets is read as a state code (`(AR)`).
 */
export function formatBankName(raw: string): string {
  const cleaned = raw
    .replace(/[\u200b-\u200d\u2060\u00ad]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  return cleaned
    .split(" ")
    .map((token, index) => {
      const match = /^([("]*)(.*?)([)",.;:]*)$/.exec(token);
      const lead = match?.[1] ?? "";
      const core = match?.[2] ?? token;
      const tail = match?.[3] ?? "";
      if (!core) return token;

      const upper = core.toUpperCase();
      if (ACRONYMS.has(upper)) return `${lead}${upper}${tail}`;
      if (lead === "(" && tail.startsWith(")") && /^[A-Za-z]{2}$/.test(core)) {
        return `${lead}${upper}${tail}`;
      }
      if (index > 0 && SMALL_WORDS.has(core.toLowerCase())) {
        return `${lead}${core.toLowerCase()}${tail}`;
      }
      // "people's" is a possessive, not a name like O'Brien: the s stays small.
      const possessive = /^(.+)'s$/i.exec(core);
      if (possessive?.[1]) {
        return `${lead}${forceTitleCaseName(possessive[1])}'s${tail}`;
      }
      return `${lead}${forceTitleCaseName(core)}${tail}`;
    })
    .join(" ");
}

/**
 * The comparison key for "is this already in the list": case, punctuation and
 * apostrophes ignored, so "U.S. Bank", "us bank" and "US Bank" are one bank.
 */
export function bankKey(value: string): string {
  return (
    value
      .toLowerCase()
      // Dots and apostrophes vanish rather than becoming spaces, so "U.S. Bank"
      // and "US Bank" are one key.
      .replace(/[\u2018\u2019\u02bc'.]/g, "")
      .replace(/[^a-z0-9&]+/g, " ")
      .trim()
  );
}

/** The list's own entry for some typed text, by name or alias, or null. */
export function findBank<T extends { name: string; aliases: string[] }>(
  banks: T[],
  text: string,
): T | null {
  const key = bankKey(text);
  if (!key) return null;
  return (
    banks.find(
      (bank) => bankKey(bank.name) === key || bank.aliases.some((alias) => bankKey(alias) === key),
    ) ?? null
  );
}
