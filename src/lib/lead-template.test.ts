import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { CANONICAL_FIELDS } from "@/lib/canonical-fields";
import { buildLeadTemplate, columnLetter, templateHeaders } from "@/lib/lead-template";

/**
 * The template is hand-built OOXML rather than SheetJS output (see the note in
 * lead-template.ts), so it gets read back with SheetJS here — if the package is
 * malformed, the parser says so.
 */
describe("lead template", () => {
  const bytes = buildLeadTemplate(CANONICAL_FIELDS);
  const xml = new TextDecoder().decode(bytes);

  it("names every canonical field, payment columns included", () => {
    const headers = templateHeaders(CANONICAL_FIELDS);
    expect(headers).toContain("Full Name");
    expect(headers).toContain("SSN Number");
    // The banking columns a centre has to supply.
    expect(headers).toContain("Routing Number");
    expect(headers).toContain("Account Number");
    expect(headers).toContain("Card Number");
    expect(headers).toContain("CVV");
    expect(headers.length).toBe(CANONICAL_FIELDS.length);
  });

  it("reads back as a workbook with exactly one header row", () => {
    const workbook = XLSX.read(bytes, { type: "array" });
    expect(workbook.SheetNames).toEqual(["Leads"]);

    const sheet = workbook.Sheets["Leads"];
    expect(sheet).toBeDefined();
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet!, { header: 1, blankrows: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(templateHeaders(CANONICAL_FIELDS));
  });

  it("bolds the header row and freezes it", () => {
    // cellXfs index 1 is the bold format; every header cell references it.
    expect(xml).toContain('<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"');
    expect(xml).toContain('<c r="A1" s="1"');
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('ySplit="1"');
  });

  it("escapes a label that would otherwise break the XML", () => {
    const awkward = [
      { key: "notes", label: "Notes & <Comments>", kind: "text", target: "payload" },
    ] as unknown as typeof CANONICAL_FIELDS;
    const text = new TextDecoder().decode(buildLeadTemplate(awkward));
    expect(text).toContain("Notes &amp; &lt;Comments&gt;");
  });

  it("numbers columns past Z", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(51)).toBe("AZ");
  });
});
