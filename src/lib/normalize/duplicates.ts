import { digitsOf, slug } from "./text";
import type { Lead } from "./types";

/**
 * Duplicate detection, in the order the keys can be trusted: a normalised SSN
 * identifies a person outright, a phone number nearly does, and name plus date
 * of birth is the fallback for rows carrying neither.
 */
function keysFor(lead: Lead): string[] {
  const keys: string[] = [];

  const ssn = digitsOf(lead.fields["ssn"]?.value ?? "");
  if (ssn.length === 9) keys.push(`ssn:${ssn}`);

  const phone = digitsOf(lead.fields["phone"]?.value ?? "");
  if (phone.length === 10) keys.push(`phone:${phone}`);

  const name = slug(lead.fields["full_name"]?.value ?? "");
  const dob = lead.fields["date_of_birth"]?.value ?? "";
  if (name && dob) keys.push(`name-dob:${name}|${dob}`);

  return keys;
}

/**
 * Returns the same leads with `duplicateOf` populated — every lead in a
 * colliding group points at the others, so filtering on it catches all of them
 * rather than only the second occurrence.
 */
export function markDuplicates(leads: Lead[]): Lead[] {
  const groups = new Map<string, number[]>();
  leads.forEach((lead, index) => {
    for (const key of keysFor(lead)) {
      const bucket = groups.get(key);
      if (bucket) bucket.push(index);
      else groups.set(key, [index]);
    }
  });

  const matches = leads.map(() => new Set<number>());
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    for (const index of bucket) {
      for (const other of bucket) {
        if (other !== index) matches[index]?.add(other);
      }
    }
  }

  return leads.map((lead, index) => ({
    ...lead,
    duplicateOf: [...(matches[index] ?? [])].sort((a, b) => a - b),
  }));
}

/**
 * How complete one row is, for choosing between copies of the same lead: the
 * number of fields carrying a value the engine did not have to flag.
 *
 * A filled-but-flagged field deliberately scores nothing. A row whose SSN came
 * out unreadable is not the better copy for having an unreadable SSN in it —
 * that cell is work for a human either way — and counting it would let the
 * messier copy of a lead win on volume alone.
 */
export function completeness(lead: Lead): number {
  return Object.values(lead.fields).filter(
    (field) => field.value.trim() !== "" && field.status !== "review",
  ).length;
}

/** One duplicate group, already resolved down to the row that will import. */
export type DuplicateGroup = {
  /** The copy that proceeds to import. */
  keep: number;
  /** The copies that will not be sent, ascending. */
  drop: number[];
};

/** Union-find root, with path compression. */
function find(parent: number[], index: number): number {
  let root = index;
  while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
  let walk = index;
  while ((parent[walk] ?? walk) !== walk) {
    const next = parent[walk] ?? walk;
    parent[walk] = root;
    walk = next;
  }
  return root;
}

/**
 * Every duplicate group in the file, resolved to one surviving row each.
 *
 * Grouping here is TRANSITIVE, unlike `duplicateOf` above: if row 3 shares a
 * phone with row 8 and row 8 shares an SSN with row 14, all three are one
 * person and only one of them may import. Pairwise links would keep two.
 *
 * The keeper is the most complete row by `completeness`. An exact tie goes to
 * whichever row appears earliest in the file — the only tie-break that does not
 * depend on the order a Map happened to hand its buckets back in, and the one
 * an operator can check against the spreadsheet in front of them.
 *
 * This is scoped to the file being imported and nothing else. It never looks at
 * leads already in the database.
 */
export function duplicateGroups(leads: Lead[]): DuplicateGroup[] {
  const parent = leads.map((_, index) => index);
  const firstSeen = new Map<string, number>();

  leads.forEach((lead, index) => {
    for (const key of keysFor(lead)) {
      const seen = firstSeen.get(key);
      if (seen === undefined) {
        firstSeen.set(key, index);
        continue;
      }
      const a = find(parent, seen);
      const b = find(parent, index);
      // The lower root always wins, so a group's root is its earliest row.
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });

  const buckets = new Map<number, number[]>();
  leads.forEach((_, index) => {
    const root = find(parent, index);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(index);
    else buckets.set(root, [index]);
  });

  const groups: DuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    // Ascending, because forEach filled it in file order — so a strict `>`
    // below leaves the earliest row holding a tie.
    let keep = bucket[0] ?? 0;
    let best = -1;
    for (const position of bucket) {
      const lead = leads[position];
      if (!lead) continue;
      const score = completeness(lead);
      if (score > best) {
        keep = position;
        best = score;
      }
    }

    const rowOf = (position: number) => leads[position]?.index ?? position;
    groups.push({
      keep: rowOf(keep),
      drop: bucket
        .filter((position) => position !== keep)
        .map(rowOf)
        .sort((a, b) => a - b),
    });
  }

  return groups.sort((a, b) => a.keep - b.keep);
}

/** The row indexes a set of groups drops — everything that will not be sent. */
export function droppedRows(groups: DuplicateGroup[]): Set<number> {
  return new Set(groups.flatMap((group) => group.drop));
}
