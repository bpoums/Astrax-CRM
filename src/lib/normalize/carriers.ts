/**
 * Carrier matching, against a list supplied by the caller.
 *
 * The names and their alternate spellings live in the `carriers` table — one
 * source for the whole app — and are fetched at the upload tool's entry point
 * and passed down, exactly the way the canonical field catalogue is. Nothing in
 * this module queries anything: it stays pure so the whole normaliser can be
 * lifted into an edge function unchanged.
 *
 * Matching strips every non-alphanumeric character and compares
 * case-insensitively, which is what makes "GWS", "GW's" and "gw s" one carrier
 * without anyone having to list all three. An alias is still needed wherever
 * the letters themselves differ ("Trans America" vs "TA").
 *
 * An unrecognised carrier is never guessed at. It comes back null, the rule
 * flags the row for review, and an admin either fixes the file or adds the
 * spelling as an alias — a wrong carrier is worse than a flagged one.
 */

/** A carrier as the matcher needs it: its canonical name and its spellings. */
export type CarrierRef = { name: string; aliases: string[] };

/** Lowercase, non-alphanumerics removed. "GW's" and "GWS" collapse to "gws". */
export function carrierKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export type CarrierIndex = ReadonlyMap<string, string>;

/** Every key that resolves to a canonical name — the name itself included. */
export function carrierIndex(carriers: CarrierRef[]): CarrierIndex {
  const index = new Map<string, string>();
  for (const carrier of carriers) {
    const name = carrier.name.trim();
    if (!name) continue;
    // The name is set first and the aliases after, so an alias that collides
    // with another carrier's name cannot displace it.
    const key = carrierKey(name);
    if (key) index.set(key, name);
  }
  for (const carrier of carriers) {
    const name = carrier.name.trim();
    if (!name) continue;
    for (const alias of carrier.aliases ?? []) {
      const key = carrierKey(alias);
      if (key && !index.has(key)) index.set(key, name);
    }
  }
  return index;
}

/**
 * Indexes are memoised per list, keyed on the array itself.
 *
 * A file of five thousand rows would otherwise rebuild the same map five
 * thousand times. The cache holds no state of its own — the same array always
 * yields the same index — and a WeakMap lets a discarded list be collected.
 */
const INDEX_CACHE = new WeakMap<CarrierRef[], CarrierIndex>();

function indexFor(carriers: CarrierRef[]): CarrierIndex {
  const cached = INDEX_CACHE.get(carriers);
  if (cached) return cached;
  const built = carrierIndex(carriers);
  INDEX_CACHE.set(carriers, built);
  return built;
}

/** The canonical carrier name, or null when the value matches nothing given. */
export function lookupCarrier(value: string, carriers: CarrierRef[]): string | null {
  const key = carrierKey(value);
  if (!key) return null;
  return indexFor(carriers).get(key) ?? null;
}
