import { describe, expect, it } from "vitest";
import {
  closeAllFields,
  closeField,
  closeFreeName,
  closePersonName,
  maskField,
  maskFreeName,
  maskPersonName,
} from "./field-mask";
import { fieldWarning } from "./form-warnings";
import { forceTitleCaseName } from "./normalize/text";

const NOW = new Date(2026, 9, 14);

describe("forceTitleCaseName", () => {
  it("re-cases whatever came in, including mixed case", () => {
    expect(forceTitleCaseName("joHN dOE")).toBe("John Doe");
    expect(forceTitleCaseName("JOHN DOE")).toBe("John Doe");
    expect(forceTitleCaseName("john doe")).toBe("John Doe");
    expect(forceTitleCaseName("  john   doe  ")).toBe("John Doe");
  });

  it("keeps Mc, hyphens and apostrophes right", () => {
    expect(forceTitleCaseName("mcdonald")).toBe("McDonald");
    expect(forceTitleCaseName("MCCOY")).toBe("McCoy");
    expect(forceTitleCaseName("smith-jones")).toBe("Smith-Jones");
    expect(forceTitleCaseName("o'brien")).toBe("O'Brien");
    expect(forceTitleCaseName("d'angelo")).toBe("D'Angelo");
  });

  it("capitalises particles instead of lowercasing them", () => {
    expect(forceTitleCaseName("ana de la cruz")).toBe("Ana De La Cruz");
  });

  it("accepts the documented cost of forcing the case", () => {
    expect(forceTitleCaseName("MacLeod")).toBe("Macleod");
    expect(forceTitleCaseName("DeVito")).toBe("Devito");
  });

  it("keeps suffixes and initials sensible", () => {
    expect(forceTitleCaseName("john smith iii")).toBe("John Smith III");
    expect(forceTitleCaseName("john smith jr.")).toBe("John Smith Jr.");
    expect(forceTitleCaseName("sharon s turner")).toBe("Sharon S Turner");
    expect(forceTitleCaseName("sharon s. turner")).toBe("Sharon S. Turner");
  });
});

describe("Full Name, live", () => {
  it("fixes a paste the moment it lands", () => {
    expect(maskField("Full Name", "  JOHN \u00a0\tDOE  ", "")).toBe("John Doe ");
    expect(maskField("Full Name", "joHN\u200b dOE", "")).toBe("John Doe");
    expect(maskPersonName("O\u2019BRIEN")).toBe("O'Brien");
  });

  it("lets a space be typed between the names", () => {
    expect(maskPersonName("john ")).toBe("John ");
    expect(maskPersonName("john d")).toBe("John D");
  });

  it("builds McDonald as it is typed", () => {
    let value = "";
    for (const key of "mcdonald") value = maskPersonName(value + key);
    expect(value).toBe("McDonald");
  });

  it("returns an empty value for nothing", () => {
    expect(maskPersonName("")).toBe("");
    expect(maskPersonName("   ")).toBe("");
  });
});

describe("Full Name, on blur", () => {
  it("trims and cases", () => {
    expect(closeField("Full Name", "  jane   doe ")).toBe("Jane Doe");
  });

  it("flips 'Last, First' and leaves a suffix alone", () => {
    expect(closePersonName("DOE, JOHN")).toBe("John Doe");
    expect(closePersonName("Smith, Jr")).toBe("Smith Jr");
    expect(closePersonName("john smith, jr")).toBe("John Smith Jr");
    expect(closePersonName("john,")).toBe("John");
  });
});

describe("Doc Name", () => {
  it("cleans paste noise but never re-cases or adds a prefix", () => {
    expect(closeField("Doc Name", "  St.  Mary's \u200bHospital \t")).toBe("St. Mary's Hospital");
    expect(closeField("Doc Name", "WATSON JAMES")).toBe("WATSON JAMES");
    expect(closeField("Doc Name", "north valley clinic")).toBe("north valley clinic");
    expect(closeField("Doc Name", "N/A")).toBe("N/A");
  });

  it("lets a trailing space be typed", () => {
    expect(maskFreeName("Dr. Watson ")).toBe("Dr. Watson ");
    expect(closeFreeName("Dr. Watson ")).toBe("Dr. Watson");
  });
});

describe("closeAllFields", () => {
  it("applies every blur rule once, and again changes nothing", () => {
    const once = closeAllFields({
      "Full Name": " JOHN  DOE ",
      "Doc Name": " Dr.  Watson ",
      Premium: "$25.",
      "Phone Number": "2145550142",
    });
    expect(once).toEqual({
      "Full Name": "John Doe",
      "Doc Name": "Dr. Watson",
      Premium: "$25",
      "Phone Number": "2145550142",
    });
    expect(closeAllFields(once)).toEqual(once);
  });
});

describe("Full Name warning", () => {
  it("warns about a digit or a slash, never about plain names", () => {
    expect(fieldWarning("Full Name", "Saul A Flores/Saul Aguilar", {}, NOW)?.tone).toBe("warn");
    expect(fieldWarning("Full Name", "John Doe 2", {}, NOW)?.tone).toBe("warn");
    expect(fieldWarning("Full Name", "John Doe", {}, NOW)).toBeNull();
    expect(fieldWarning("Full Name", "Mary-Ann O'Brien Jr.", {}, NOW)).toBeNull();
  });
});
