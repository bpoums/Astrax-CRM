import { useCallback, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { toast } from "sonner";
import { CANONICAL_FIELDS } from "@/lib/canonical-fields";
import {
  buildLead,
  fingerprintHeaders,
  markDuplicates,
  reviewColumns,
  suggestMapping,
  type CanonicalField,
  type CarrierRef,
  type Lead,
} from "@/lib/normalize";
import { carrierRefs, useCarriers } from "@/lib/carriers";
import { parseFile, type ParsedFile } from "@/lib/parse-file";
import { downloadLeadTemplate } from "@/lib/lead-template";
import { UploadReview } from "@/components/upload-review";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Step = "upload" | "map" | "review";

const MAPPING_STORAGE_PREFIX = "ums.upload.mapping.";
const UNMAPPED = "__unmapped__";

/**
 * A confirmed mapping is remembered against the file's header fingerprint, so a
 * source that does repeat pre-fills next time.
 *
 * It is an accelerant and nothing else. Sources may never repeat, so a file the
 * tool has never seen must map itself from scratch and import correctly with no
 * setup — which is exactly what the fuzzy suggestion below does.
 */
function loadStoredMapping(fingerprint: string): Record<string, string | null> | null {
  try {
    const raw = window.localStorage.getItem(MAPPING_STORAGE_PREFIX + fingerprint);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, string | null>;
  } catch {
    return null;
  }
}

function storeMapping(fingerprint: string, mapping: Record<string, string | null>) {
  try {
    window.localStorage.setItem(MAPPING_STORAGE_PREFIX + fingerprint, JSON.stringify(mapping));
  } catch {
    // A full or blocked localStorage costs the operator a pre-fill, nothing more.
  }
}

export function DataUploader() {
  const [step, setStep] = useState<Step>("upload");
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [leads, setLeads] = useState<Lead[]>([]);
  // Fixed for the life of the review: editing never adds or removes a column.
  const [columns, setColumns] = useState<CanonicalField[]>([]);
  const [busy, setBusy] = useState(false);

  /**
   * The carrier vocabulary, fetched HERE and passed down.
   *
   * This is the upload tool's entry point and the only place in the import path
   * that may query — `src/lib/normalize` is pure by design, so the list travels
   * as a parameter exactly the way the canonical field catalogue does. The
   * array is memoised because the matcher indexes it by identity.
   */
  const carriers = useCarriers(true);
  const carrierList = useMemo<CarrierRef[]>(() => carrierRefs(carriers.data), [carriers.data]);

  const fingerprint = useMemo(() => (parsed ? fingerprintHeaders(parsed.headers) : ""), [parsed]);
  const remembered = useMemo(
    () => (fingerprint ? loadStoredMapping(fingerprint) !== null : false),
    [fingerprint],
  );

  const handleFile = useCallback(async (file: File) => {
    setBusy(true);
    try {
      const result = await parseFile(file);
      if (result.rows.length === 0) throw new Error("That file has no data rows in it.");
      setParsed(result);
      const stored = loadStoredMapping(fingerprintHeaders(result.headers));
      setMapping(stored ?? suggestMapping(result.headers, CANONICAL_FIELDS));
      setStep("map");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read that file.");
    } finally {
      setBusy(false);
    }
  }, []);

  function confirmMapping() {
    if (!parsed) return;
    storeMapping(fingerprint, mapping);
    const mapped = parsed.headers.map((header) => ({
      header,
      fieldKey: mapping[header] ?? null,
    }));
    const built = markDuplicates(
      parsed.rows.map((row, index) =>
        buildLead(row, mapped, CANONICAL_FIELDS, { index, carriers: carrierList }),
      ),
    );
    setLeads(built);
    setColumns(reviewColumns(built, mapped, CANONICAL_FIELDS));
    setStep("review");
  }

  function reset() {
    setParsed(null);
    setMapping({});
    setLeads([]);
    setColumns([]);
    setStep("upload");
  }

  if (step === "review" && parsed) {
    return (
      <UploadReview
        fileName={parsed.fileName}
        leads={leads}
        columns={columns}
        carriers={carrierList}
        onLeadsChange={setLeads}
        onBack={() => setStep("map")}
        onDone={reset}
      />
    );
  }

  if (step === "map" && parsed) {
    return (
      <MapStep
        parsed={parsed}
        mapping={mapping}
        remembered={remembered}
        carriersReady={!carriers.isLoading}
        carriersError={carriers.isError ? (carriers.error as Error).message : null}
        onChange={setMapping}
        onConfirm={confirmMapping}
        onBack={reset}
      />
    );
  }

  return <UploadStep busy={busy} onFile={handleFile} />;
}

function UploadStep({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onFile(file);
    event.target.value = "";
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  return (
    <section className="panel">
      <h2 className="panel-title">Upload a lead file</h2>

      {/* Above the picker, because it is the step before choosing a file for
          anyone who does not have one in the right shape yet. */}
      <div className="flex flex-col gap-1">
        <div>
          <button
            type="button"
            className="chip"
            onClick={() => downloadLeadTemplate(CANONICAL_FIELDS)}
          >
            Download template
          </button>
        </div>
        <p className="text-[0.66rem] text-muted-foreground">
          Column order does not matter and extra columns are fine — the tool reads what each cell
          contains, not where it sits. Using these exact names just means there is no mapping step.
        </p>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className={`flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-10 transition-colors ${
          dragging ? "border-accent bg-accent/5" : "border-border"
        }`}
      >
        <p className="text-sm text-foreground">
          {busy ? "Reading the file…" : "Drop a .csv or .xlsx here"}
        </p>
        <button
          type="button"
          className="btn-submit"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          Choose file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,.xlsx,.xls,.xlsm"
          className="hidden"
          onChange={pick}
        />
        {/* Worth stating plainly: the operator is about to open a file full of
            SSNs and card numbers. */}
        <p className="max-w-md text-center text-[0.66rem] text-muted-foreground">
          The file is read in this browser. Nothing leaves your machine until you press Import.
        </p>
      </div>
    </section>
  );
}

function MapStep({
  parsed,
  mapping,
  remembered,
  carriersReady,
  carriersError,
  onChange,
  onConfirm,
  onBack,
}: {
  parsed: ParsedFile;
  mapping: Record<string, string | null>;
  remembered: boolean;
  /** Building the leads before the carriers land would flag every one of them. */
  carriersReady: boolean;
  carriersError: string | null;
  onChange: (next: Record<string, string | null>) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const firstRow = parsed.rows[0] ?? {};
  const mapped = Object.values(mapping).filter(Boolean).length;

  // One canonical field cannot receive two columns, so a field already spoken
  // for is hidden from the other selects.
  const claimed = new Set(Object.values(mapping).filter(Boolean) as string[]);

  function setColumn(header: string, value: string) {
    onChange({ ...mapping, [header]: value === UNMAPPED ? null : value });
  }

  return (
    <section className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-title">
          Map columns — {parsed.fileName} ({parsed.rows.length} rows)
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {mapped} of {parsed.headers.length} mapped
            {remembered ? " · pre-filled from a previous file with these headers" : ""}
          </span>
          <button type="button" className="chip" onClick={onBack}>
            Start over
          </button>
          <button
            type="button"
            className="btn-submit"
            disabled={!carriersReady}
            onClick={onConfirm}
          >
            {carriersReady ? "Confirm and review" : "Loading carriers…"}
          </button>
        </div>
      </div>

      {/* A refused carrier read is not an empty carrier list: without it every
          carrier value in the file is flagged as unrecognised, so say why. */}
      {carriersError ? (
        <p className="text-xs text-destructive">
          Carriers could not be read ({carriersError}) — carrier values will all be flagged for
          review.
        </p>
      ) : null}

      {/* The header is only ever a hint: a column left unmapped still has its
          contents scanned, and a mapped one is still checked against what the
          cell actually holds. */}
      <p className="text-[0.66rem] text-muted-foreground">
        Every cell is scanned for what it actually contains, whatever the header says. Mapping
        settles where the ordinary values go.
      </p>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Column in file</TableHead>
              <TableHead>First value</TableHead>
              <TableHead className="w-64">Maps to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parsed.headers.map((header) => {
              const current = mapping[header] ?? null;
              return (
                <TableRow key={header}>
                  <TableCell className="font-medium">{header}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {firstRow[header] || "—"}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={current ?? UNMAPPED}
                      onValueChange={(value) => setColumn(header, value)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNMAPPED}>Not mapped</SelectItem>
                        {CANONICAL_FIELDS.filter(
                          (field) => field.key === current || !claimed.has(field.key),
                        ).map((field) => (
                          <SelectItem key={field.key} value={field.key}>
                            {field.label}
                            {field.target === "payment" ? " · banking" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
