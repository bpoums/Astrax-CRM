import { calcAge, formatSSN } from "@/lib/form-fields";

/**
 * Sample leads for the dev-only "Fill test data" button.
 *
 * Pure, like `src/lib/normalize/`: no React, no I/O, and `now` / `random` are
 * parameters so a test can pin them. Every key is a form label, which is the
 * payload key, and every value is written in the final form the field masks
 * produce — `123-45-6789`, `$25,000`, `5'8"` — so filling never trips an inline
 * warning and nothing is re-masked afterwards.
 *
 * Card Number, Exp Date and CVC are left blank on purpose: they are optional,
 * and a lead without them is exactly what the manager's "Card details" screen is
 * for. Health Conditions and Medications are blank for the same reason.
 *
 * The name starts with `Test`, because the dev server talks to the same
 * database as production and a submitted test lead is a real row. It is `Test`
 * and not `TEST` since the form Title-cases a name; search case-insensitively.
 */

export type TestDataOptions = {
  /** The first active carrier's name, from the form's own carrier query. */
  carrier: string | null;
  now?: Date;
  random?: () => number;
};

const FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery"];
const LAST_NAMES = ["Tester", "Sample", "Example", "Demo", "Fakename", "Placeholder"];

/** State and a ZIP inside it, so the form's state/ZIP cross-check stays quiet. */
const STATE_ZIPS: { state: string; zip: string; city: string }[] = [
  { state: "TX", zip: "75001", city: "Addison" },
  { state: "FL", zip: "33101", city: "Miami" },
  { state: "CA", zip: "90001", city: "Los Angeles" },
  { state: "NY", zip: "10001", city: "New York" },
];

/** A routing number that passes the ABA checksum the form checks. */
const ROUTING_NUMBER = "021000021";

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T;
}

function digits(count: number, random: () => number) {
  let out = "";
  for (let i = 0; i < count; i += 1) out += String(Math.floor(random() * 10));
  return out;
}

/** A well-formed SSN the form's own check accepts, different on nearly every call. */
function ssn(random: () => number) {
  const area = 100 + Math.floor(random() * 560); // 100–659: never 000, 666 or 9xx
  const group = 10 + Math.floor(random() * 90); // never 00
  const serial = 1000 + Math.floor(random() * 9000); // never 0000
  return formatSSN(`${area}${group}${serial}`);
}

function isoDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The first weekday on or after `from`; the form warns on a Saturday or Sunday draft. */
function nextWeekday(from: Date) {
  const date = new Date(from);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  return date;
}

function plusDays(from: Date, days: number) {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

/** Fields both forms share, so the two generators cannot drift apart. */
function shared({ now = new Date(), random = Math.random }: TestDataOptions) {
  const first = pick(FIRST_NAMES, random);
  const last = pick(LAST_NAMES, random);
  const place = pick(STATE_ZIPS, random);

  const born = new Date(now.getFullYear() - (55 + Math.floor(random() * 20)), 0, 1);
  born.setMonth(Math.floor(random() * 12), 1 + Math.floor(random() * 28));
  const dob = isoDate(born);

  const draft = nextWeekday(plusDays(now, 5));
  const future = nextWeekday(plusDays(draft, 30));

  return {
    now,
    random,
    place,
    values: {
      // "Test", not "TEST": the form Title-cases a name, so TEST would be
      // rewritten on submit. A case-insensitive search still finds it.
      "Full Name": `Test ${first} ${last}`,
      "Phone Number": `214555${String(100 + Math.floor(random() * 100))}0`.slice(0, 10),
      "Date of Birth": dob,
      Age: String(calcAge(dob) ?? ""),
      Gender: random() < 0.5 ? "Male" : "Female",
      "Smoker or Non Smoker": "Non Smoker",
      Height: `5'${4 + Math.floor(random() * 8)}"`,
      Weight: String(140 + Math.floor(random() * 80)),
      "Residential Address": `${100 + Math.floor(random() * 900)} Test Street, ${place.city}, ${place.state} ${place.zip}`,
      "Birth State": place.state,
      "Email Address": `test.${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      "SSN Number": ssn(random),
      "Doc Name": "Dr. Test Physician",
      "Doc Phone": "2145550142",
      "Doc Address": `1 Clinic Way, ${place.city}, ${place.state} ${place.zip}`,
      "Beneficiary Name": `Test Beneficiary ${last}`,
      "Beneficiary Relationship": "Spouse",
      "Plan Type": "Level",
      "Coverage Amount": "$25,000",
      Premium: `$${60 + Math.floor(random() * 90)}.50`,
      "Draft Date": isoDate(draft),
      "Future Draft Date": isoDate(future),
      "Bank Name": "TEST Bank",
      "Bank Type": "Checking",
      "Account Title": `TEST ${first} ${last}`,
      "Routing Number": ROUTING_NUMBER,
      "Account Number": digits(10, random),
      // Optional on both forms, and the point of the manager's card-entry screen.
      "Card Number": "",
      "Exp Date": "",
      CVC: "",
    } as Record<string, string>,
  };
}

/** Every closer-form label. The closer's `Plan Type` is spelled `Mod`, not `MOD`. */
export function closerTestData(options: TestDataOptions): Record<string, string> {
  const { place, values } = shared(options);
  return {
    "Full Name": values["Full Name"] as string,
    Gender: values["Gender"] as string,
    "Date of Birth": values["Date of Birth"] as string,
    Age: values["Age"] as string,
    State: place.state,
    "Birth State": place.state,
    "Birth Country": "USA",
    "SSN Number": values["SSN Number"] as string,
    "Phone Number": values["Phone Number"] as string,
    "Email Address": values["Email Address"] as string,
    Height: values["Height"] as string,
    Weight: values["Weight"] as string,
    "Residential Address": values["Residential Address"] as string,
    "Customer Zip Code": place.zip,
    "Smoker or Non Smoker": values["Smoker or Non Smoker"] as string,
    "Health Conditions": "",
    Medications: "",
    "Proposed Carrier": options.carrier ?? "",
    "Coverage Amount": values["Coverage Amount"] as string,
    Premium: values["Premium"] as string,
    "Doc Name": values["Doc Name"] as string,
    "Doc Phone": values["Doc Phone"] as string,
    "Plan Type": values["Plan Type"] as string,
    "Doc Address": values["Doc Address"] as string,
    "Beneficiary Name": values["Beneficiary Name"] as string,
    "Beneficiary Relationship": values["Beneficiary Relationship"] as string,
    "Beneficiary Info": "TEST beneficiary details",
    "Draft Date": values["Draft Date"] as string,
    "Future Draft Date": values["Future Draft Date"] as string,
    "Bank Draft": "Yes",
    "Account Title": values["Account Title"] as string,
    "Bank Name": values["Bank Name"] as string,
    "Bank Type": values["Bank Type"] as string,
    "Routing Number": values["Routing Number"] as string,
    "Account Number": values["Account Number"] as string,
    "Card Number": "",
    "Exp Date": "",
    CVC: "",
    "Notes & Comments": "Created with the dev-only Fill test data button.",
  };
}

/** Every validator-form label, plus the carrier, which that form holds separately. */
export function validatorTestData(options: TestDataOptions): {
  agency: string;
  values: Record<string, string>;
} {
  const { values } = shared(options);
  return {
    agency: options.carrier ?? "",
    values: {
      "Full Name": values["Full Name"] as string,
      "Phone Number": values["Phone Number"] as string,
      "Date of Birth": values["Date of Birth"] as string,
      Age: values["Age"] as string,
      Gender: values["Gender"] as string,
      "Smoker or Non Smoker": values["Smoker or Non Smoker"] as string,
      Height: values["Height"] as string,
      Weight: values["Weight"] as string,
      "Residential Address": values["Residential Address"] as string,
      "Birth State": values["Birth State"] as string,
      "Email Address": values["Email Address"] as string,
      "SSN Number": values["SSN Number"] as string,
      "Driving License or State ID": "",
      "Doc Name": values["Doc Name"] as string,
      "Doc Phone": values["Doc Phone"] as string,
      "Doc Address": values["Doc Address"] as string,
      "Beneficiary Name": values["Beneficiary Name"] as string,
      "Beneficiary Relationship": values["Beneficiary Relationship"] as string,
      "Beneficiary Info": "TEST beneficiary details",
      "Plan Type": "MOD",
      "Coverage Amount": values["Coverage Amount"] as string,
      Premium: values["Premium"] as string,
      "Agent Name": "TEST Agent",
      "Policy Number": `TEST-${digits(6, options.random ?? Math.random)}`,
      "Agency Name": "TEST Agency",
      "IMO Name": "TEST IMO",
      "Draft Date": values["Draft Date"] as string,
      "Future Draft Date": values["Future Draft Date"] as string,
      "Bank Name": values["Bank Name"] as string,
      "Bank Type": values["Bank Type"] as string,
      "Account Title": values["Account Title"] as string,
      "Routing Number": values["Routing Number"] as string,
      "Account Number": values["Account Number"] as string,
      "Card Number": "",
      "Exp Date": "",
      CVC: "",
    },
  };
}
