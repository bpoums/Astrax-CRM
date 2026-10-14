import { describe, expect, it } from "vitest";
import { bankKey, findBank, formatBankName } from "./banks";

describe("formatBankName", () => {
  it("title-cases whatever came in", () => {
    expect(formatBankName("CHASE BANK")).toBe("Chase Bank");
    expect(formatBankName("wells fargo bank")).toBe("Wells Fargo Bank");
    expect(formatBankName("  fifth   third bank ")).toBe("Fifth Third Bank");
  });

  it("keeps acronyms upper-case", () => {
    expect(formatBankName("us bank")).toBe("US Bank");
    expect(formatBankName("PNC bank")).toBe("PNC Bank");
    expect(formatBankName("td bank")).toBe("TD Bank");
    expect(formatBankName("m&t bank")).toBe("M&T Bank");
    expect(formatBankName("usaa federal savings bank")).toBe("USAA Federal Savings Bank");
    expect(formatBankName("state employees cu")).toBe("State Employees CU");
  });

  it("keeps small words lower-case unless they open the name", () => {
    expect(formatBankName("BANK OF AMERICA")).toBe("Bank of America");
    expect(formatBankName("the bank of princeton")).toBe("The Bank of Princeton");
    expect(formatBankName("republic bank & trust company")).toBe("Republic Bank & Trust Company");
  });

  it("reads a bracketed two-letter word as a state", () => {
    expect(formatBankName("farmers bank & trust in arkansas (ar)")).toBe(
      "Farmers Bank & Trust in Arkansas (AR)",
    );
  });

  it("handles apostrophes, hyphens and paste noise", () => {
    expect(formatBankName("people\u2019s bank")).toBe("People's Bank");
    expect(formatBankName("southern bank - tarboro")).toBe("Southern Bank - Tarboro");
    expect(formatBankName("first\u00a0national\tbank\u200b")).toBe("First National Bank");
  });

  it("returns an empty string for nothing", () => {
    expect(formatBankName("")).toBe("");
    expect(formatBankName("   ")).toBe("");
  });
});

const BANKS = [
  { name: "Chase Bank", aliases: ["Chase", "JPMorgan Chase Bank"] },
  { name: "US Bank", aliases: ["U.S. Bank"] },
  { name: "State Employees Credit Union (SECU)", aliases: ["State Employees' Credit Union"] },
];

describe("bankKey and findBank", () => {
  it("ignores case, punctuation and apostrophes", () => {
    expect(bankKey("U.S. Bank")).toBe(bankKey("us bank"));
    expect(bankKey("State Employees\u2019 Credit Union")).toBe(
      bankKey("state employees credit union"),
    );
  });

  it("finds a bank by name or by alias", () => {
    expect(findBank(BANKS, "chase bank")?.name).toBe("Chase Bank");
    expect(findBank(BANKS, "Chase")?.name).toBe("Chase Bank");
    expect(findBank(BANKS, "jpmorgan chase bank")?.name).toBe("Chase Bank");
    expect(findBank(BANKS, "u.s. bank")?.name).toBe("US Bank");
    expect(findBank(BANKS, "State Employees Credit Union")?.name).toBe(
      "State Employees Credit Union (SECU)",
    );
  });

  it("finds nothing for an unknown or empty name", () => {
    expect(findBank(BANKS, "Brand New Bank")).toBeNull();
    expect(findBank(BANKS, "   ")).toBeNull();
  });
});
