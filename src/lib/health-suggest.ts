import { useEffect, useState } from "react";

/**
 * Autocomplete for the closer form's Health Conditions / Medications fields.
 *
 * Both lists come from the US National Library of Medicine's Clinical Tables
 * service — free, no key, CORS-open. Only the few characters being typed leave
 * the browser; nothing about the customer does. Every failure is soft: a closer
 * on a bad connection just types the value by hand.
 */
export type SuggestKind = "condition" | "medication";

const ENDPOINT: Record<SuggestKind, string> = {
  condition: "https://clinicaltables.nlm.nih.gov/api/conditions/v3/search",
  medication: "https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search",
};

export const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;
const MAX_LIST = 8;

/**
 * Clinical Tables answers `[total, codes, extras, displayRows]`; `displayRows`
 * is a list of one-element arrays. RxTerms names carry a route suffix —
 * "metFORMIN (Oral Pill)" — that means nothing on a lead, so it is dropped.
 */
export function parseSuggestions(raw: unknown, kind: SuggestKind): string[] {
  if (!Array.isArray(raw)) return [];
  const rows = raw[3];
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    let text = Array.isArray(row) ? row[0] : row;
    if (typeof text !== "string") continue;
    if (kind === "medication") text = text.replace(/\s*\([^)]*\)\s*$/, "");
    text = text.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

const cache = new Map<string, string[]>();

export function useSuggestions(kind: SuggestKind, query: string): string[] {
  const term = query.trim();
  const [results, setResults] = useState<string[]>([]);

  useEffect(() => {
    if (term.length < MIN_QUERY) {
      setResults([]);
      return;
    }
    const cacheKey = `${kind}:${term.toLowerCase()}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      setResults(hit);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const url = `${ENDPOINT[kind]}?terms=${encodeURIComponent(term)}&maxList=${MAX_LIST}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("suggest");
        const parsed = parseSuggestions(await res.json(), kind);
        cache.set(cacheKey, parsed);
        setResults(parsed);
      } catch {
        // Aborted, offline or blocked — no suggestions, and no error to show.
        if (!controller.signal.aborted) setResults([]);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [kind, term]);

  return results;
}

/** The stored value is one comma-separated string; chips are its parts. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function joinList(items: string[]): string {
  return items.join(", ");
}
