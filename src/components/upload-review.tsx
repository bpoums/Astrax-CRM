import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { readFunctionError } from "@/lib/function-error";
import { CANONICAL_FIELDS, PAYLOAD_FIELDS } from "@/lib/canonical-fields";
import {
  droppedRows,
  duplicateGroups,
  markDuplicates,
  setLeadField,
  type CanonicalField,
  type CarrierRef,
  type DetectorKind,
  type FieldStatus,
  type Lead,
  type LeadFlag,
} from "@/lib/normalize";
import { downloadCsv, toCleanedCsv } from "@/lib/parse-file";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** The edge function's own ceiling is 200; 50 keeps each request small. */
const BATCH_SIZE = 50;

/** How many rows the grid draws at once. See `drawn` below. */
const PAGE_SIZE = 100;

type Filter = "all" | "fixed" | "review" | "duplicates";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "fixed", label: "Fixed" },
  { id: "review", label: "Needs review" },
  { id: "duplicates", label: "Duplicates" },
];

const STATUS_CLASS: Record<FieldStatus, string> = {
  clean: "",
  fixed: "text-accent",
  review: "text-destructive",
};

export function UploadReview({
  fileName,
  leads,
  columns,
  carriers,
  onLeadsChange,
  onBack,
  onDone,
}: {
  fileName: string;
  leads: Lead[];
  /**
   * Fixed when the mapping was confirmed. Deliberately a prop, not derived from
   * `leads`: a column set that depends on the data in it disappears out from
   * under whoever is editing that data.
   */
  columns: CanonicalField[];
  /**
   * The carrier vocabulary, fetched by the uploader and passed straight
   * through: re-normalising an edited carrier cell has to match against the
   * same list the first pass used, or a value accepted on import is flagged
   * the moment someone touches the row.
   */
  carriers: CarrierRef[];
  onLeadsChange: (next: Lead[]) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [progress, setProgress] = useState<string | null>(null);
  /** Flags the operator dismissed without changing the value, per row index. */
  const [ignored, setIgnored] = useState<Record<number, string[]>>({});
  const [openFlag, setOpenFlag] = useState<string | null>(null);

  // A dismissed flag stops counting, stops filtering and — because it was
  // deliberately waved through here — is not carried into the database either.
  const liveFlags = useCallback(
    (lead: Lead): LeadFlag[] => {
      const dismissed = ignored[lead.index] ?? [];
      return lead.flags.filter((flag) => !dismissed.includes(flag.field));
    },
    [ignored],
  );

  /**
   * Duplicates, already resolved: one row per group survives and the rest are
   * dropped before anything is sent. Recomputed off `leads`, so correcting a
   * field can hand the group to a different row while the operator watches.
   */
  const groups = useMemo(() => duplicateGroups(leads), [leads]);
  const dropped = useMemo(() => droppedRows(groups), [groups]);
  const grouped = useMemo(
    () => new Set(groups.flatMap((group) => [group.keep, ...group.drop])),
    [groups],
  );
  /** What Import actually sends — the kept copy of each group, plus the rest. */
  const sending = useMemo(() => leads.filter((lead) => !dropped.has(lead.index)), [leads, dropped]);
  /** Dropped row -> the row that beat it, for the marker in the grid. */
  const keptFor = useMemo(
    () => new Map(groups.flatMap((group) => group.drop.map((row) => [row, group.keep] as const))),
    [groups],
  );

  const counts = useMemo(() => {
    let fixed = 0;
    let review = 0;
    for (const lead of leads) {
      const statuses = Object.values(lead.fields).map((field) => field.status);
      if (statuses.includes("review") || liveFlags(lead).length > 0) review += 1;
      else if (statuses.includes("fixed")) fixed += 1;
    }
    return {
      total: leads.length,
      fixed,
      review,
      duplicates: grouped.size,
      merged: dropped.size,
      sending: sending.length,
    };
  }, [leads, liveFlags, grouped, dropped, sending]);

  const visible = useMemo(() => {
    if (filter === "all") return leads;
    if (filter === "duplicates") return leads.filter((lead) => grouped.has(lead.index));
    if (filter === "review") {
      return leads.filter(
        (lead) =>
          liveFlags(lead).length > 0 ||
          Object.values(lead.fields).some((field) => field.status === "review"),
      );
    }
    return leads.filter((lead) =>
      Object.values(lead.fields).some((field) => field.status === "fixed"),
    );
  }, [leads, filter, liveFlags, grouped]);

  // Every cell is a controlled input, so a five-thousand-row file would be
  // twenty thousand of them and one keystroke would stall the tab. Drawing is
  // paged; `leads` is not — the import always sends the whole file.
  const drawn = useMemo(() => visible.slice(0, limit), [visible, limit]);

  // `lead.index` is the row's position in this array and stays that way — the
  // filters narrow what is drawn, never what is held — so markDuplicates can
  // re-derive collisions positionally after every edit.
  function replaceLead(index: number, next: Lead) {
    onLeadsChange(markDuplicates(leads.map((lead) => (lead.index === index ? next : lead))));
  }

  function editField(lead: Lead, field: CanonicalField, value: string) {
    replaceLead(lead.index, setLeadField(lead, field.key, value, CANONICAL_FIELDS, { carriers }));
  }

  /**
   * Dismissal, kept apart from correction. It clears the flag and changes
   * nothing else, which is why it is worded the way it is.
   */
  function ignoreFlag(lead: Lead, field: string) {
    setIgnored((current) => ({
      ...current,
      [lead.index]: [...(current[lead.index] ?? []), field],
    }));
    setOpenFlag(null);
  }

  const importLeads = useMutation({
    mutationFn: async () => {
      const { data: batch, error: startError } = await supabase.rpc("start_lead_import", {
        p_file_name: fileName,
        p_row_count: leads.length,
      });
      if (startError) throw startError;
      const importId = (batch as { id?: string } | null)?.id;
      if (!importId) throw new Error("The import batch could not be opened.");

      let imported = 0;
      let skipped = 0;

      // `sending`, not `leads`: the losing copy of a duplicate group was
      // resolved away in the review above and is simply never sent. Nothing to
      // un-send afterwards — no row for it is ever created.
      for (let start = 0; start < sending.length; start += BATCH_SIZE) {
        const slice = sending.slice(start, start + BATCH_SIZE);
        setProgress(`Importing ${start + 1}–${Math.min(start + BATCH_SIZE, sending.length)}…`);

        const { data, error } = await supabase.functions.invoke("ingest-sheet-lead", {
          body: {
            import_id: importId,
            leads: slice.map((lead) => toIngestPayload(lead, liveFlags(lead))),
          },
        });
        if (error) throw new Error(await readFunctionError(error, "The import failed."));

        const result = (data ?? {}) as { imported?: number; skipped?: number };
        imported += typeof result.imported === "number" ? result.imported : slice.length;
        skipped += typeof result.skipped === "number" ? result.skipped : 0;
      }

      return { imported, skipped };
    },
    onSuccess: ({ imported, skipped }) => {
      setProgress(null);
      toast.success(
        skipped > 0
          ? `Imported ${imported} leads, ${skipped} skipped`
          : `Imported ${imported} leads`,
      );
      queryClient.invalidateQueries({ queryKey: ["lead-imports"] });
      onDone();
    },
    onError: (error: Error) => {
      setProgress(null);
      toast.error(error.message);
    },
  });

  return (
    <section className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-title">
          Review — {fileName} ({counts.total} leads)
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="chip" onClick={onBack} disabled={importLeads.isPending}>
            Back to mapping
          </button>
          <button
            type="button"
            className="chip"
            disabled={importLeads.isPending}
            onClick={() =>
              downloadCsv(
                fileName.replace(/\.[^.]+$/, "") + "-cleaned.csv",
                toCleanedCsv(leads, CANONICAL_FIELDS, liveFlags),
              )
            }
          >
            Export cleaned CSV
          </button>
          <button
            type="button"
            className="btn-submit"
            disabled={importLeads.isPending || counts.sending === 0}
            onClick={() => importLeads.mutate()}
          >
            {progress ?? (importLeads.isPending ? "Importing…" : `Import ${counts.sending} leads`)}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Summary label="Total" value={counts.total} />
        <Summary label="Fixed" value={counts.fixed} tone="accent" />
        <Summary label="Needs review" value={counts.review} tone="destructive" />
        <Summary label="Duplicates" value={counts.duplicates} tone="destructive" />
        <Summary label="Merged away" value={counts.merged} tone="destructive" />
        {/* Nothing is blocked on a flag. A flagged row still imports, carrying
            its flags — a manager approves the batch before any of it moves. */}
        <span className="text-[0.66rem] text-muted-foreground">
          Flagged rows still import and carry their flags; a manager approves the batch before it
          reaches the queue.
        </span>
      </div>

      {/* Above the grid on purpose. Merging is a decision the import makes on
          the operator's behalf, so it is shown as a review step they can read
          and overturn — by correcting the losing row until it wins — rather
          than reported after the fact. */}
      {groups.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border border-accent/60 bg-accent/5 p-2.5">
          <h3 className="panel-title text-accent">
            Duplicates merged — {counts.merged} of {counts.total} rows will not be imported
          </h3>
          <ul className="flex flex-col gap-0.5">
            {groups.map((group) => (
              <li key={group.keep} className="text-[0.68rem] text-muted-foreground">
                <span className="font-medium text-foreground">Row {group.keep + 1} kept</span> —{" "}
                {group.drop.length === 1 ? "row" : "rows"} {rowList(group.drop)}{" "}
                {group.drop.length === 1 ? "was a duplicate" : "were duplicates"} and will not be
                imported.
              </li>
            ))}
          </ul>
          <p className="text-[0.66rem] text-muted-foreground">
            The most complete copy is kept — fields that are filled and unflagged decide it, and the
            earliest row wins a tie. Fixing a flag on a dropped row can hand it the group.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              setFilter(entry.id);
              setLimit(PAGE_SIZE);
            }}
            aria-pressed={filter === entry.id}
            className={`chip px-2.5 py-0.5 text-[0.66rem] ${filter === entry.id ? "chip-active" : ""}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead className="w-24">Payment</TableHead>
              {columns.map((field) => (
                <TableHead key={field.key} className="whitespace-nowrap">
                  {field.label}
                </TableHead>
              ))}
              <TableHead className="min-w-56">Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drawn.map((lead) => (
              // A dropped row stays in the grid, editable, and dimmed — it is
              // the evidence for the merge, and correcting it is how an
              // operator disagrees with the choice.
              <TableRow key={lead.index} className={dropped.has(lead.index) ? "opacity-50" : ""}>
                <TableCell className="text-muted-foreground tabular-nums">
                  {lead.index + 1}
                  {dropped.has(lead.index) ? (
                    <span
                      className="ml-1 text-destructive"
                      title={`Duplicate of row ${(keptFor.get(lead.index) ?? 0) + 1} — not imported`}
                    >
                      merged
                    </span>
                  ) : grouped.has(lead.index) ? (
                    <span
                      className="ml-1 text-accent"
                      title={`Kept — also rows ${lead.duplicateOf.map((i) => i + 1).join(", ")}`}
                    >
                      kept
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-muted-foreground">
                    {lead.payment.payment_type}
                  </Badge>
                </TableCell>
                {columns.map((field, column) => (
                  <TableCell key={field.key} className="align-top">
                    <Cell
                      lead={lead}
                      field={field}
                      column={column}
                      onCommit={(value) => editField(lead, field, value)}
                    />
                  </TableCell>
                ))}
                <TableCell className="align-top">
                  {liveFlags(lead).length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {liveFlags(lead).map((flag) => {
                        const key = `${lead.index}:${flag.field}`;
                        return (
                          <FlagRow
                            key={key}
                            lead={lead}
                            flag={flag}
                            open={openFlag === key}
                            onToggle={() =>
                              setOpenFlag((current) => (current === key ? null : key))
                            }
                            onSave={(field, value) => {
                              editField(lead, field, value);
                              setOpenFlag(null);
                            }}
                            onIgnore={() => ignoreFlag(lead, flag.field)}
                          />
                        );
                      })}
                    </ul>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {drawn.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + 3}
                  className="text-center text-muted-foreground"
                >
                  Nothing matches that filter.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      {drawn.length < visible.length ? (
        <div className="flex items-center justify-center gap-2">
          <span className="text-xs text-muted-foreground">
            Showing {drawn.length} of {visible.length}
          </span>
          <button
            type="button"
            className="chip"
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, visible.length - drawn.length)} more
          </button>
          <button type="button" className="chip" onClick={() => setLimit(visible.length)}>
            Show all
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * "9 and 22", "9, 22 and 31" — row numbers as a sentence reads them.
 * The indexes are 0-based; the operator's spreadsheet is not.
 */
function rowList(indexes: number[]) {
  const rows = indexes.map((index) => index + 1);
  const last = rows[rows.length - 1];
  if (rows.length <= 1) return String(last ?? "");
  return `${rows.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * One flag, with the way to fix what it points at.
 *
 * Same shape as the manager's DataFlagList: the issue and the raw value the
 * detector choked on, and an input pre-filled with the current value. Saving
 * re-normalises the field, which clears the flag on its own when the new value
 * is good. Dismissing is a separate action that changes nothing.
 *
 * Card fields are no different from any other here — see the note on `Cell`.
 */
function FlagRow({
  lead,
  flag,
  open,
  onToggle,
  onSave,
  onIgnore,
}: {
  lead: Lead;
  flag: LeadFlag;
  open: boolean;
  onToggle: () => void;
  onSave: (field: CanonicalField, value: string) => void;
  onIgnore: () => void;
}) {
  const field = CANONICAL_FIELDS.find((entry) => entry.key === flag.field);

  return (
    <li className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 flex-col text-left text-[0.68rem] text-destructive hover:opacity-80"
      >
        <span className="free-text">{flag.issue}</span>
        {flag.raw ? (
          <span className="free-text line-clamp-2 text-muted-foreground" title={flag.raw}>
            Raw: &ldquo;{flag.raw}&rdquo;
          </span>
        ) : null}
        <span className="text-accent">{open ? "Close" : field ? "Fix this value" : "Dismiss"}</span>
      </button>

      {open ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-accent/5 p-1.5">
          {field ? (
            <FlagEditor
              inputId={`flagfix-${lead.index}-${field.key}`}
              label={field.label}
              initial={lead.fields[field.key]?.value ?? ""}
              onSave={(value) => onSave(field, value)}
            />
          ) : (
            <p className="text-[0.66rem] text-muted-foreground">
              Nothing to edit here — this flag is about the lead as a whole.
            </p>
          )}
          <button
            type="button"
            className="chip justify-center text-[0.66rem] text-muted-foreground"
            title="Clears the flag and leaves the value unchanged"
            onClick={onIgnore}
          >
            Ignore without fixing
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Split out so the draft seeds from the field's current value every time the
 * editor opens — the cell above it is editable too, and a stale draft would
 * quietly overwrite whatever was typed there.
 */
function FlagEditor({
  inputId,
  label,
  initial,
  onSave,
}: {
  inputId: string;
  label: string;
  initial: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initial);

  return (
    <>
      <label htmlFor={inputId} className="field-label">
        {label}
      </label>
      <input
        id={inputId}
        name={inputId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="field-input h-7 px-1.5 py-0 text-xs"
        autoComplete="new-password"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
      />
      <button
        type="button"
        className="chip justify-center text-[0.66rem]"
        onClick={() => onSave(draft.trim())}
      >
        Save correction
      </button>
    </>
  );
}

/** Kinds whose value is digits. A numeric keypad helps and signals nothing. */
const NUMERIC_KINDS: ReadonlySet<DetectorKind> = new Set([
  "ssn",
  "routing",
  "account",
  "card",
  "cvv",
  "zip",
  "phone",
  "currency",
  "expiry",
]);

/**
 * Chrome ignores autocomplete="off" on anything it has decided is a payment
 * field, and then manages the lot as one group — clearing a card number wipes
 * the CVV with it, and it warns about an insecure payment form. It does honour
 * "new-password", so that is what these two get.
 */
const AUTOFILL_SUPPRESSED: ReadonlySet<string> = new Set(["card_number", "cvv"]);

/**
 * One cell, editable, whatever the field.
 *
 * Two things this gets right that a plain controlled input does not:
 *
 * 1. WHILE FOCUSED, the keystrokes are the value. They are held verbatim in
 *    local state and rendered exactly as typed — no normalising, no detection,
 *    no validation. A half-deleted card number is not an invalid card number,
 *    and rewriting the value on every change fights the cursor. Detection runs
 *    once, on blur.
 * 2. THE BROWSER KEEPS ITS HANDS OFF. These are data-cleaning cells, not a
 *    payment form: autofill is suppressed and the identifiers are keyed by row
 *    and column so none of Chrome's name heuristics ("card", "cc", "cvv",
 *    "number"…) can match.
 *
 * Card numbers and CVVs are shown in full here and nowhere else. This grid is
 * PRE-import: the operator has the source spreadsheet open on the same machine,
 * so masking the parsed copy of a number they can already read protects nothing
 * and only stops them fixing a mis-parse. None of it extends past Import —
 * afterwards the card is reachable only through `card_details`, which is
 * role-checked and logged.
 *
 * The raw value sits in a `title` attribute rather than a mounted Tooltip:
 * a thousand-row grid would otherwise mount a thousand tooltip roots.
 */
function Cell({
  lead,
  field,
  column,
  onCommit,
}: {
  lead: Lead;
  field: CanonicalField;
  /** Column position — half of the neutral identifier. */
  column: number;
  onCommit: (value: string) => void;
}) {
  const entry = lead.fields[field.key];
  const committed = entry?.value ?? "";
  const status = entry?.status ?? "clean";

  // null means "not being edited": the cell shows whatever the engine last
  // resolved. Anything else is the operator's own text, untouched.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? committed;

  const title = [
    entry?.raw && entry.raw !== committed ? `Was: ${entry.raw}` : null,
    entry?.note ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Deliberately carries no field name: "ur-3-7", never "card_number".
  const identifier = `ur-${lead.index}-${column}`;

  function commit() {
    const typed = draft;
    setDraft(null);
    if (typed !== null && typed !== committed) onCommit(typed);
  }

  return (
    <input
      id={identifier}
      name={identifier}
      value={shown}
      title={title}
      aria-label={`${field.label}, row ${lead.index + 1}`}
      autoComplete={AUTOFILL_SUPPRESSED.has(field.key) ? "new-password" : "off"}
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      {...(NUMERIC_KINDS.has(field.kind) ? { inputMode: "numeric" as const } : {})}
      onFocus={() => setDraft(committed)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        // Escape abandons the edit rather than committing half a value.
        if (event.key === "Escape") {
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
      className={`field-input h-7 min-w-28 px-1.5 py-0 text-xs ${STATUS_CLASS[status]} ${
        status === "review" ? "border-destructive" : status === "fixed" ? "border-accent/60" : ""
      }`}
    />
  );
}

function Summary({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "accent" | "destructive";
}) {
  const valueClass =
    tone === "destructive" ? "text-destructive" : tone === "accent" ? "text-accent" : "";
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="field-label">{label}</span>
      <span className={`font-display text-lg font-semibold tabular-nums ${valueClass}`}>
        {value}
      </span>
    </span>
  );
}

/**
 * The import body for one lead.
 *
 * CRITICAL: payment values go in `payment` and nowhere else. `payload` is what
 * the sheet-sync trigger pushes to Google Sheets — a card number placed there
 * would be written into a spreadsheet.
 */
function toIngestPayload(lead: Lead, flags: LeadFlag[]) {
  const payload: Record<string, string> = {};
  for (const field of PAYLOAD_FIELDS) {
    const value = lead.fields[field.key]?.value;
    if (value) payload[field.label] = value;
  }

  return {
    source_ref: crypto.randomUUID(),
    payload,
    flags,
    payment: {
      payment_type: lead.payment.payment_type,
      bank_name: lead.payment.bank_name,
      routing_number: lead.payment.routing_number,
      account_number: lead.payment.account_number,
      account_title: lead.payment.account_title,
      card_number: lead.payment.card_number,
      card_last4: lead.payment.card_last4,
      card_exp: lead.payment.card_exp,
      cvv: lead.payment.cvv,
    },
  };
}
