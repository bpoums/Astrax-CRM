import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { CanonicalField, Lead } from "@/lib/normalize";

/**
 * File parsing, entirely in the browser.
 *
 * The file holds SSNs and card numbers. Nothing here uploads it, and nothing
 * fetches: the bytes stay on the operator's machine until they press Import,
 * and even then only the normalised result is sent.
 */

export type ParsedFile = {
  fileName: string;
  headers: string[];
  rows: Record<string, string>[];
};

export async function parseFile(file: File): Promise<ParsedFile> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) return parseCsv(file);
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm")) {
    return parseSheet(file);
  }
  throw new Error("Upload a .csv or .xlsx file.");
}

async function parseCsv(file: File): Promise<ParsedFile> {
  const text = await file.text();
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  const headers = dedupeHeaders(result.meta.fields ?? []);
  return {
    fileName: file.name,
    headers,
    rows: result.data.map((row) => stringifyRow(row, headers)),
  };
}

async function parseSheet(file: File): Promise<ParsedFile> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) throw new Error("That workbook has no sheets in it.");

  // raw:false hands back the displayed text, which is what the detectors want:
  // a date the operator sees as "5/24/1941" should not arrive as a serial.
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });

  const [headerRow, ...dataRows] = matrix;
  if (!headerRow) throw new Error("That sheet is empty.");

  const headers = dedupeHeaders(headerRow.map((cell) => String(cell ?? "").trim()));
  const rows = dataRows
    .map((cells) => {
      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        row[header] = String(cells[index] ?? "").trim();
      });
      return row;
    })
    .filter((row) => Object.values(row).some((value) => value !== ""));

  return { fileName: file.name, headers, rows };
}

/** Blank and repeated headers still have to address a distinct column. */
function dedupeHeaders(headers: string[]) {
  const seen = new Map<string, number>();
  return headers.map((header, index) => {
    const base = header || `Column ${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

function stringifyRow(row: Record<string, unknown>, headers: string[]) {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const value = row[header];
    out[header] = value === null || value === undefined ? "" : String(value).trim();
  }
  return out;
}

/**
 * The cleaned CSV. Payment columns are deliberately absent apart from the card's
 * last four — the export is a working file, not a way to walk card numbers out
 * of the tool.
 */
export function toCleanedCsv(
  leads: Lead[],
  fields: CanonicalField[],
  flagsFor: (lead: Lead) => Lead["flags"] = (lead) => lead.flags,
) {
  const payloadFields = fields.filter((field) => field.target === "payload");
  const columns = [
    ...payloadFields.map((field) => field.label),
    "Payment Type",
    "Bank Name",
    "Routing Number",
    "Account Title",
    "Card Last 4",
    "Flags",
  ];

  const rows = leads.map((lead) => {
    const row: Record<string, string> = {};
    for (const field of payloadFields) row[field.label] = lead.fields[field.key]?.value ?? "";
    row["Payment Type"] = lead.payment.payment_type;
    row["Bank Name"] = lead.payment.bank_name ?? "";
    row["Routing Number"] = lead.payment.routing_number ?? "";
    row["Account Title"] = lead.payment.account_title ?? "";
    row["Card Last 4"] = lead.payment.card_last4 ?? "";
    row["Flags"] = flagsFor(lead)
      .map((flag) => `${flag.field}: ${flag.issue}`)
      .join("; ");
    return row;
  });

  return Papa.unparse({
    fields: columns,
    data: rows.map((row) => columns.map((c) => row[c] ?? "")),
  });
}

export function downloadCsv(fileName: string, csv: string) {
  // Excel needs the BOM to read UTF-8; written as an escape so it is visible.
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
