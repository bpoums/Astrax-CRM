import { SECTIONS } from "@/components/closer-form";
import type { CanonicalField, DetectorKind, FieldTarget, PaymentKey } from "@/lib/normalize";

/**
 * The canonical destination fields for an imported lead.
 *
 * The list is READ from the closer form definition rather than restated here,
 * so a label change on the form moves the import target with it — those labels
 * are the jsonb keys and the Sheet column headers, and they are spelled in one
 * place only. This module adds the two things a form field cannot say by
 * itself: what kind of value the detectors should expect, and whether it
 * belongs in the payload or in payment_details.
 *
 * The card fields at the bottom exist only for imports. The closer and
 * validator forms keep their card data in submissions.payload exactly as they
 * do today; nothing here changes that.
 */

type Annotation = {
  key: string;
  kind: DetectorKind;
  target?: FieldTarget;
  paymentKey?: PaymentKey;
  aliases?: string[];
  birthDate?: boolean;
  donate?: boolean;
};

/** Keyed by the form label, which is the payload key. */
const ANNOTATIONS: Record<string, Annotation> = {
  "Full Name": {
    key: "full_name",
    kind: "name",
    donate: true,
    aliases: ["name", "customer", "customer name", "client name", "insured", "lead name"],
  },
  Gender: { key: "gender", kind: "text", aliases: ["sex", "m f"] },
  "Date of Birth": {
    key: "date_of_birth",
    kind: "date",
    birthDate: true,
    donate: true,
    aliases: ["dob", "d o b", "birth date", "birthdate", "date of birth"],
  },
  Age: { key: "age", kind: "text", aliases: ["age"] },
  State: { key: "state", kind: "state", donate: true, aliases: ["st", "state code", "us state"] },
  "Residential State": { key: "residential_state", kind: "state", aliases: ["res state"] },
  "Birth State": { key: "birth_state", kind: "state", aliases: ["state of birth"] },
  "Birth Country": { key: "birth_country", kind: "text", aliases: ["country of birth"] },
  "SSN Number": {
    key: "ssn",
    kind: "ssn",
    donate: true,
    aliases: ["ssn", "social security", "social security number", "ss no", "social"],
  },
  "Phone Number": {
    key: "phone",
    kind: "phone",
    donate: true,
    aliases: ["phone", "mobile", "cell", "contact number", "telephone", "primary phone"],
  },
  "Email Address": {
    key: "email",
    kind: "email",
    donate: true,
    aliases: ["email", "e mail", "email id"],
  },
  Height: { key: "height", kind: "text" },
  Weight: { key: "weight", kind: "text", aliases: ["lbs"] },
  "Residential Address": {
    key: "residential_address",
    kind: "text",
    aliases: ["address", "street address", "mailing address", "home address"],
  },
  "Customer Zip Code": {
    key: "zip",
    kind: "zip",
    donate: true,
    aliases: ["zip", "zipcode", "postal code", "postcode", "zip code"],
  },
  "Smoker or Non Smoker": {
    key: "smoker",
    kind: "text",
    aliases: ["smoker", "tobacco", "smoking status"],
  },
  // Keyed off the closer form's label, which is now "Proposed Carrier". The
  // internal `key` stays `carrier_name` — it is the normaliser's own slug, not
  // a payload key, and renaming it would churn every rule and test for nothing.
  // "carrier name" is an alias rather than a casualty of the rename: real
  // uploader spreadsheets still carry that header, and dropping it would
  // silently stop mapping the column on every file sent before today.
  "Proposed Carrier": {
    key: "carrier_name",
    kind: "carrier",
    donate: true,
    aliases: [
      "carrier",
      "carrier name",
      "proposed carrier",
      "company",
      "insurance company",
      "provider",
    ],
  },
  "Coverage Amount": {
    key: "coverage_amount",
    kind: "currency",
    aliases: ["coverage", "face amount", "benefit amount", "sum assured"],
  },
  Premium: {
    key: "premium",
    kind: "currency",
    donate: true,
    aliases: ["premium", "monthly premium", "monthly", "draft amount", "payment amount"],
  },
  "Doc Name": { key: "doc_name", kind: "name", aliases: ["doctor", "physician", "doctor name"] },
  "Doc Phone": { key: "doc_phone", kind: "phone", aliases: ["doctor phone", "physician phone"] },
  "Plan Type": { key: "plan_type", kind: "text", aliases: ["plan", "product", "policy type"] },
  "Doc Address": { key: "doc_address", kind: "text", aliases: ["doctor address"] },
  "Beneficiary Name": { key: "beneficiary_name", kind: "name", aliases: ["beneficiary", "bene"] },
  "Beneficiary Relationship": {
    key: "beneficiary_relationship",
    kind: "text",
    aliases: ["relationship", "bene relationship"],
  },
  "Beneficiary Info": { key: "beneficiary_info", kind: "text", aliases: ["bene info"] },
  "Draft Date": {
    key: "draft_date",
    kind: "date",
    aliases: ["draft date", "payment date", "billing date"],
  },
  "Bank Draft": { key: "bank_draft", kind: "text", aliases: ["draft", "bank draft"] },

  // --- payment_details, never the payload -------------------------------
  "Account Title": {
    key: "account_title",
    kind: "name",
    target: "payment",
    paymentKey: "account_title",
    aliases: ["account holder", "name on account", "acct title"],
  },
  "Bank Name": {
    key: "bank_name",
    kind: "bank",
    target: "payment",
    paymentKey: "bank_name",
    donate: true,
    aliases: ["bank", "bank name", "institution"],
  },
  "Routing Number": {
    key: "routing_number",
    kind: "routing",
    target: "payment",
    paymentKey: "routing_number",
    donate: true,
    aliases: ["routing", "aba", "rtn", "routing no", "aba routing"],
  },
  "Account Number": {
    key: "account_number",
    kind: "account",
    target: "payment",
    paymentKey: "account_number",
    donate: true,
    aliases: ["account", "acct", "acct no", "account no", "bank account"],
  },

  "Notes & Comments": {
    key: "notes",
    kind: "text",
    aliases: ["notes", "comments", "remarks", "note"],
  },
};

/**
 * Mapping targets an uploaded file can carry that no form has a field for.
 *
 * `after` names the form label each one sits behind, so City lands beside the
 * address it belongs to and Secondary Phone beside the first phone, rather than
 * at the bottom of a list where nobody thinks to look. If a form label is later
 * renamed the anchor simply stops matching and the field is appended — a
 * cosmetic edit on the form must never make a mapping target disappear.
 *
 * NONE of these are added to the closer or validator form. They exist so the
 * uploader has somewhere to put a column the forms never asked for.
 */
const IMPORT_ONLY_FIELDS: { after: string; field: CanonicalField }[] = [
  {
    after: "SSN Number",
    field: {
      /*
       * ONE field, not two, and the label is spelled exactly as the validator
       * form spells it.
       *
       * A label IS the payload key and the Sheet column header, so splitting
       * this into "Driving License" and "State ID" would file one document
       * under three different keys — the validator form's combined one plus
       * two that only imported leads ever carry. The aliases below take both
       * spellings into the single key instead. A file that genuinely carries
       * both columns can only map one of them; the other stays visibly
       * unmapped in the mapping step rather than being silently dropped.
       *
       * The closer form has no identity-document field at all, which is why
       * this is declared here rather than inherited from SECTIONS.
       */
      key: "drivers_license",
      label: "Driving License or State ID",
      kind: "text",
      target: "payload",
      aliases: [
        "dl",
        "drivers license",
        "driver license",
        "driving license",
        "drivers licence",
        "license",
        "licence",
        "license number",
        "state id",
        "state id number",
        "id card",
      ],
    },
  },
  {
    after: "Phone Number",
    field: {
      key: "secondary_phone",
      label: "Secondary Phone",
      kind: "phone",
      target: "payload",
      /*
       * Deliberately NOT `donate`. "Phone Number" claims the phone kind, so a
       * loose phone number detected inside some other column still lands
       * there; this field only ever takes the column mapped to it.
       *
       * "phone 2" is what `slug` makes of the header "phone (2)" — the exact
       * column that went unmapped in the sample file.
       */
      aliases: [
        "phone 2",
        "alt phone",
        "secondary number",
        "alternate phone",
        "second phone",
        "other phone",
        "mobile 2",
      ],
    },
  },
  {
    after: "Residential Address",
    field: {
      key: "city",
      label: "City",
      kind: "text",
      target: "payload",
      aliases: ["city", "town", "city name"],
    },
  },
  {
    after: "Smoker or Non Smoker",
    field: {
      key: "health_condition",
      label: "Health Condition",
      kind: "text",
      target: "payload",
      aliases: [
        "health",
        "medical condition",
        "health issues",
        "health conditions",
        "medical history",
      ],
    },
  },
  {
    after: "Smoker or Non Smoker",
    field: {
      key: "medications",
      label: "Medications",
      kind: "text",
      target: "payload",
      aliases: ["meds", "medication", "current medications", "prescriptions"],
    },
  },
];

/** Card fields the closer form has no equivalent for. Imports only. */
const CARD_FIELDS: CanonicalField[] = [
  {
    key: "card_number",
    label: "Card Number",
    kind: "card",
    target: "payment",
    paymentKey: "card_number",
    donate: true,
    aliases: ["card", "card no", "cc", "credit card", "debit card", "card detail"],
  },
  {
    key: "card_exp",
    label: "Card Expiry",
    kind: "expiry",
    target: "payment",
    paymentKey: "card_exp",
    donate: true,
    aliases: ["exp", "expiry", "expiration", "exp date", "valid thru"],
  },
  {
    key: "cvv",
    label: "CVV",
    kind: "cvv",
    target: "payment",
    paymentKey: "cvv",
    donate: true,
    aliases: ["cvv", "cvc", "cid", "security code"],
  },
];

function annotate(label: string, formType: string): Annotation {
  const known = ANNOTATIONS[label];
  if (known) return known;
  // A label the form gained since this table was written still imports; it just
  // falls back to the form's own type rather than a detector-specific kind.
  const kind: DetectorKind = formType === "date" ? "date" : "text";
  return {
    key: label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, ""),
    kind,
  };
}

function buildCatalog(): CanonicalField[] {
  // Grouped first so two fields sharing an anchor keep the order they were
  // declared in rather than the reverse.
  const queued = new Map<string, CanonicalField[]>();
  for (const entry of IMPORT_ONLY_FIELDS) {
    const bucket = queued.get(entry.after);
    if (bucket) bucket.push(entry.field);
    else queued.set(entry.after, [entry.field]);
  }

  const fromForm = SECTIONS.flatMap((section) => section.fields).flatMap((field) => {
    const annotation = annotate(field.label, field.type);
    const canonical: CanonicalField = {
      key: annotation.key,
      label: field.label,
      kind: annotation.kind,
      target: annotation.target ?? "payload",
    };
    if (annotation.paymentKey) canonical.paymentKey = annotation.paymentKey;
    if (annotation.aliases) canonical.aliases = annotation.aliases;
    if (annotation.birthDate) canonical.birthDate = true;
    if (annotation.donate) canonical.donate = true;
    if (field.options) canonical.options = field.options;

    const following = queued.get(field.label) ?? [];
    queued.delete(field.label);
    return [canonical, ...following];
  });

  // Whatever is left lost its anchor to a renamed form label. It still has to
  // exist as a mapping target, so it goes on the end rather than nowhere.
  const unanchored = [...queued.values()].flat();
  return [...fromForm, ...unanchored, ...CARD_FIELDS];
}

export const CANONICAL_FIELDS: CanonicalField[] = buildCatalog();

export const PAYLOAD_FIELDS = CANONICAL_FIELDS.filter((field) => field.target === "payload");

export const PAYMENT_FIELDS = CANONICAL_FIELDS.filter((field) => field.target === "payment");

/**
 * There is deliberately no masked-field list here.
 *
 * The pre-import review grid shows card numbers and CVVs in full because the
 * operator already has the source file open beside it — see the note on `Cell`
 * in `upload-review.tsx`. After import the card is reachable only through the
 * `card_details` RPC, which is role-checked and logged server-side, so nothing
 * on the client decides who may see it.
 */
