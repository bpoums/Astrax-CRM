import type { CanonicalField } from "@/lib/normalize";

/**
 * The blank .xlsx a centre fills in.
 *
 * The columns are read from the canonical field catalog, which is itself
 * derived from the closer form — so a label changing on the form changes the
 * template, and the two cannot drift.
 *
 * WHY THIS IS NOT SheetJS. The template has to look deliberate when it opens:
 * a bold, frozen header row. The community build of SheetJS writes neither —
 * cell styles are a Pro feature and there is no freeze-pane write path at all
 * (verified: `cell.s` and `ws['!freeze']` both produce nothing). An .xlsx is a
 * zip of six small XML parts, so it is written here directly rather than
 * pulling in a second spreadsheet library to bold one row.
 */

const SHEET_NAME = "Leads";
export const TEMPLATE_FILENAME = "ums-lead-template.xlsx";

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number) {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/* ------------------------------------------------------------------ *
 * The parts
 * ------------------------------------------------------------------ */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${NS_CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`;

/** Two fonts and two cell formats: plain, and the bold one the header uses. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS_MAIN}"><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/**
 * One row, styled with cellXfs index 1 (bold), above a frozen pane.
 *
 * Inline strings rather than a shared-string table: with a single row there is
 * nothing to share, and it keeps the package to six parts.
 */
function sheetXml(headers: string[]) {
  const span = `1:${Math.max(1, headers.length)}`;

  const cols = headers
    .map((header, index) => {
      // Roughly fit the label; Excel's width unit is about one character.
      const width = Math.min(40, Math.max(12, header.length + 4));
      return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    })
    .join("");

  const cells = headers
    .map(
      (header, index) =>
        `<c r="${columnLetter(index)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(header)}</t></is></c>`,
    )
    .join("");

  const lastColumn = columnLetter(Math.max(0, headers.length - 1));
  // ySplit="1" with state="frozen" is what pins the header row on scroll.
  const view = `<sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`;

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`,
    `<dimension ref="A1:${lastColumn}1"/>`,
    `<sheetViews>${view}</sheetViews>`,
    `<sheetFormatPr defaultRowHeight="15"/>`,
    `<cols>${cols}</cols>`,
    `<sheetData><row r="1" spans="${span}">${cells}</row></sheetData>`,
    `</worksheet>`,
  ].join("");
}

/* ------------------------------------------------------------------ *
 * A minimal STORED (uncompressed) zip
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

type Part = { name: string; bytes: Uint8Array };

/**
 * Entries are stored, not deflated. The whole package is a few kilobytes of
 * XML, so compression would buy nothing and cost a dependency.
 */
export function zipParts(parts: Part[]) {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const put32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true);

  for (const part of parts) {
    const nameBytes = new TextEncoder().encode(part.name);
    const crc = crc32(part.bytes);
    const size = part.bytes.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    put32(lv, 0, 0x04034b50);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0x21, true); // date: 1980-01-01, so the file is byte-stable
    put32(lv, 14, crc);
    put32(lv, 18, size);
    put32(lv, 22, size);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra
    local.set(nameBytes, 30);

    const entry = new Uint8Array(46 + nameBytes.length);
    const ev = new DataView(entry.buffer);
    put32(ev, 0, 0x02014b50);
    ev.setUint16(4, 20, true); // version made by
    ev.setUint16(6, 20, true); // version needed
    ev.setUint16(8, 0, true);
    ev.setUint16(10, 0, true);
    ev.setUint16(12, 0, true);
    ev.setUint16(14, 0x21, true);
    put32(ev, 16, crc);
    put32(ev, 20, size);
    put32(ev, 24, size);
    ev.setUint16(28, nameBytes.length, true);
    ev.setUint16(30, 0, true);
    ev.setUint16(32, 0, true);
    ev.setUint16(34, 0, true);
    ev.setUint16(36, 0, true);
    put32(ev, 38, 0);
    put32(ev, 42, offset);
    entry.set(nameBytes, 46);

    chunks.push(local, part.bytes);
    central.push(entry);
    offset += local.length + size;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  put32(endView, 0, 0x06054b50);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, parts.length, true);
  endView.setUint16(10, parts.length, true);
  put32(endView, 12, centralSize);
  put32(endView, 16, offset);
  endView.setUint16(20, 0, true);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of [...chunks, ...central, end]) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Every canonical field, payment columns included — centres supply banking too. */
export function templateHeaders(fields: CanonicalField[]) {
  return fields.map((field) => field.label);
}

export function buildLeadTemplate(fields: CanonicalField[]) {
  const headers = templateHeaders(fields);
  const encode = (text: string) => new TextEncoder().encode(text);

  return zipParts([
    { name: "[Content_Types].xml", bytes: encode(CONTENT_TYPES) },
    { name: "_rels/.rels", bytes: encode(ROOT_RELS) },
    { name: "xl/workbook.xml", bytes: encode(WORKBOOK) },
    { name: "xl/_rels/workbook.xml.rels", bytes: encode(WORKBOOK_RELS) },
    { name: "xl/styles.xml", bytes: encode(STYLES) },
    { name: "xl/worksheets/sheet1.xml", bytes: encode(sheetXml(headers)) },
  ]);
}

export function downloadLeadTemplate(fields: CanonicalField[]) {
  const bytes = buildLeadTemplate(fields);
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = TEMPLATE_FILENAME;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
