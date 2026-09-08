import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { draftDateWarning, fieldWarning } from "@/lib/form-warnings";
import { duplicateSsnWarning, SSN_FIELD, useDuplicateSsn } from "@/lib/duplicate-ssn";
import { calcAge, formatExpDate, formatSSN, zodiacSign } from "@/lib/form-fields";
import { closeField, maskField } from "@/lib/field-mask";
import { roleHome, useAuth } from "@/lib/auth";
import { useCarriers } from "@/lib/carriers";
import { BrandLogo } from "./brand-logo";

type FieldType = "text" | "number" | "date" | "radio" | "textarea";

type Field = {
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  span?: string;
};

type Section = { title: string; fields: Field[] };

/**
 * The validator's intake form — one form for every carrier.
 *
 * It used to be four, one per carrier, each with its own field list. They
 * overlapped almost entirely, drifted apart field by field, and a new carrier
 * could not be worked at all until someone shipped a fifth layout. The carrier
 * is now an ordinary field on one shared form: adding a carrier in Settings is
 * all it takes for a validator to write for them.
 *
 * Every label below is the jsonb payload key AND the Google Sheet column
 * header, matched by literal string, so each one is spelled here and nowhere
 * else. They deliberately keep the wording the old forms used — "Residential
 * Address", "Customer Zip Code", "Exp Date" — so the existing Sheet columns
 * keep filling and the shared warning rules, which are keyed by these exact
 * labels, keep firing.
 *
 * Both payment methods are collected together and both are required. That is
 * intentional: these carriers take a bank draft AND card details on the same
 * application, so there is no payment-type choice to make and no conditional
 * half of the panel.
 */
const SECTIONS: Section[] = [
  {
    title: "Customer",
    fields: [
      { label: "Full Name", type: "text", required: true },
      { label: "Phone Number", type: "number", required: true },
      { label: "Date of Birth", type: "date", required: true },
      { label: "Age", type: "number" },
      { label: "Gender", type: "radio", required: true, options: ["Male", "Female"] },
      {
        label: "Smoker or Non Smoker",
        type: "radio",
        required: true,
        options: ["Smoker", "Non Smoker"],
      },
      { label: "Height", type: "text" },
      { label: "Weight", type: "text" },
      { label: "Residential Address", type: "textarea", required: true, span: "sm:col-span-2" },
      { label: "Birth State", type: "text" },
      { label: "Email Address", type: "text" },
      { label: "SSN Number", type: "text", required: true },
      { label: "Driving License or State ID", type: "text" },
      { label: "Doc Name", type: "text" },
      { label: "Doc Phone", type: "number" },
      { label: "Doc Address", type: "textarea", span: "sm:col-span-2" },
      { label: "Beneficiary Name", type: "text", required: true },
      { label: "Beneficiary Relationship", type: "text", required: true },
      // { label: "State", type: "text", required: true },
      // { label: "Customer Zip Code", type: "number", required: true },
    ],
  },
  {
    // The policy itself first, then the two parties named on it — the doctor
    // and the beneficiary. Neither is long enough to be worth a panel of its
    // own, and both belong to the policy rather than to the customer's details.
    title: "Policy",
    fields: [
      {
        label: "Plan Type",
        type: "radio",
        span: "sm:col-span-2",
        options: ["Level", "Graded", "MOD", "G.I"],
      },
      { label: "Coverage Amount", type: "number", required: true },
      { label: "Premium", type: "text", required: true },
      { label: "Agent Name", type: "text", required: true },
      { label: "Policy Number", type: "text", required: true },
      { label: "Draft Date", type: "date", required: true },
      { label: "Future Draft Date", type: "date", required: true },
    ],
  },
  {
    title: "Banking",
    fields: [
      { label: "Bank Name", type: "text" },
      { label: "Bank Type", type: "radio", options: ["Checking", "Saving"] },
      { label: "Account Title", type: "text" },
      { label: "Routing Number", type: "number" },
      { label: "Account Number", type: "text" },
      { label: "Card Number", type: "number" },
      { label: "Exp Date", type: "text" },
      { label: "CVC", type: "number" },
    ],
  },
];

/**
 * The carrier's payload key. The Apps Script routes a submission to its Google
 * Sheet tab off this exact key, so it is spelled once and never paraphrased.
 */
const AGENCY = "Agency";

const DOB = "Date of Birth";
const AGE = "Age";
const SSN = "SSN Number";
const EXPIRY = "Exp Date";
const DRAFT_DATES = ["Draft Date", "Future Draft Date"];

const ALL_FIELDS = SECTIONS.flatMap((section) => section.fields);

function emptyForm(): Record<string, string> {
  return Object.fromEntries(ALL_FIELDS.map((field) => [field.label, ""]));
}

export function ValidatorForm() {
  const { profile, signOut } = useAuth();
  // The one source of carrier names, active only and in the admin's order.
  const carriers = useCarriers(true);
  const [agency, setAgency] = useState("");
  const [values, setValues] = useState<Record<string, string>>(emptyForm);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  // Age is derived from the date of birth but stays an ordinary field, so a
  // validator can correct it when the customer disputes the arithmetic.
  const set = (label: string, value: string) =>
    setValues((prev) => {
      if (label === SSN) return { ...prev, [label]: formatSSN(value) };
      if (label === EXPIRY) return { ...prev, [label]: formatExpDate(value) };
      if (label === DOB) {
        const age = calcAge(value);
        return { ...prev, [label]: value, [AGE]: age === null ? "" : String(age) };
      }
      // The shared masks. This form has Height, Premium, Coverage Amount and
      // Birth State; anything else comes back untouched.
      return { ...prev, [label]: maskField(label, value, prev[label] ?? "") };
    });

  /**
   * A value written exactly as given, with no mask applied — the blur pass has
   * already produced the final string, and re-masking `5'6"` would reopen it.
   */
  const commit = (label: string, value: string) =>
    setValues((prev) => ({ ...prev, [label]: value }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Chip groups are buttons, so the browser never validates them for us.
    if (!agency) {
      setStatus("error");
      setMessage("Choose the carrier you are writing for.");
      return;
    }
    const missing = ALL_FIELDS.find((field) => field.required && !values[field.label]?.trim());
    if (missing) {
      setStatus("error");
      setMessage(`${missing.label} is required.`);
      return;
    }

    setStatus("sending");
    setMessage("");
    try {
      // Agency first so it leads the payload; the rest keep form order, which
      // is the order the Sheet columns are in.
      const payload = { [AGENCY]: agency, ...values };
      const { error } = await supabase.rpc("submit_form", { p_payload: payload });
      if (error) throw new Error(error.message);
      setStatus("sent");
      setMessage("Submission saved.");
      // The carrier is kept: a validator writing a run of applications for one
      // carrier should not have to re-pick it every time.
      setValues(emptyForm());
      window.setTimeout(() => setStatus("idle"), 4000);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not submit.");
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground lg:h-screen lg:overflow-hidden">
      <form
        onSubmit={handleSubmit}
        className="mx-auto flex h-full max-w-[1500px] flex-col gap-3 px-4 py-4 lg:gap-4 lg:px-8 lg:py-5"
      >
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <div>
            {/* <h1 className="font-display text-2xl font-semibold tracking-tight lg:text-3xl">
              Validator&apos;s Form
            </h1> */}
            <BrandLogo className="h-10 w-auto max-w-none shrink-0" />
          </div>
          <div className="flex items-center gap-3">
            {message ? (
              <span
                className={
                  status === "error"
                    ? "text-xs font-medium text-destructive"
                    : "text-xs font-medium text-accent"
                }
              >
                {message}
              </span>
            ) : null}
            <button type="submit" className="btn-submit" disabled={status === "sending"}>
              {status === "sending" ? "Submitting…" : "Submit entry"}
            </button>
            {profile && profile.role !== "closer" ? (
              <Link to={roleHome[profile.role]} className="chip inline-block">
                Back to queue
              </Link>
            ) : null}
            <button type="button" onClick={signOut} className="chip">
              Sign out
            </button>
          </div>
        </header>

        {/* A field like any other now, not a step that swaps the form. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <span className="field-label">
            Carrier<span className="text-accent"> *</span>
          </span>
          {(carriers.data ?? []).map((carrier) => (
            <button
              key={carrier.id}
              type="button"
              /* The NAME, not the id: this string becomes the Sheet tab. */
              onClick={() => setAgency(carrier.name)}
              aria-pressed={agency === carrier.name}
              className={agency === carrier.name ? "chip chip-active" : "chip"}
            >
              {carrier.name}
            </button>
          ))}
          {carriers.isError ? (
            <span className="text-xs font-medium text-destructive">
              {(carriers.error as Error).message}
            </span>
          ) : carriers.isLoading ? (
            <span className="text-xs text-muted-foreground">Loading carriers…</span>
          ) : (carriers.data ?? []).length === 0 ? (
            <span className="text-xs text-muted-foreground">
              No carriers set up — ask an admin to add them in Settings.
            </span>
          ) : null}
        </div>

        {/* Three columns on a wide screen, the same shape as the closer form.
            `.panel` already scrolls itself with the scrollbar hidden, so a
            column with more fields than fit — Customer, at fifteen — scrolls
            inside its own card rather than growing the page and being clipped
            by the one-screen main. `lg:min-h-0` is what lets a grid item
            shrink below its content; without it the panel refuses to and the
            overflow has nowhere to go. Below lg the columns stack and the page
            scrolls normally. */}
        <div className="grid flex-1 gap-3 lg:min-h-0 lg:grid-cols-12 lg:gap-4">
          {SECTIONS.map((section) => (
            <section key={section.title} className="panel lg:col-span-4 lg:min-h-0">
              <h2 className="panel-title">{section.title}</h2>
              <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
                {section.fields.map((field) => (
                  <FieldControl
                    key={field.label}
                    field={field}
                    value={values[field.label] ?? ""}
                    values={values}
                    onChange={(v) => set(field.label, v)}
                    onCommit={(v) => commit(field.label, v)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </form>
    </main>
  );
}

const ISO_DATE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(["date"]);

function FieldControl({
  field,
  value,
  values,
  onChange,
  onCommit,
}: {
  field: Field;
  value: string;
  /** The whole form — the zip/state cross-check needs a second field. */
  values: Record<string, string>;
  onChange: (value: string) => void;
  /** Writes verbatim, bypassing the keystroke mask. Blur only. */
  onCommit: (value: string) => void;
}) {
  const id = field.label.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();

  // Checked on blur, not per keystroke: a half-typed routing number is not a
  // mistake, and saying so while it is still being typed is pure noise.
  const [touched, setTouched] = useState(false);

  // Inert on every field but the SSN — nothing is asked until `check` is called
  // on blur, and only that field calls it.
  const duplicate = useDuplicateSsn(value);

  /**
   * Blur marks the field checked and closes any mask that could not finish
   * live — here, the " on a height shorter than three digits.
   */
  function handleBlur() {
    setTouched(true);
    const closed = closeField(field.label, value);
    if (closed !== value) onCommit(closed);
    // Advisory only, and only ever from here: a partial SSN asks nothing, and
    // the check never runs on a keystroke. See useDuplicateSsn.
    if (field.label === SSN_FIELD) duplicate.check(closed);
  }

  // Every check here is the shared one the closer form uses — ABA checksum,
  // Luhn, SSN shape, zip against state — reached by this field's label.
  const sign = field.label === DOB ? zodiacSign(value) : null;
  const hints = [
    // Rapport prompt only — the sign is never part of the payload.
    ...(sign ? [{ tone: "ok" as const, text: `${sign.symbol} ${sign.name}` }] : []),
    // The weekend note lands as soon as a date is picked rather than on blur,
    // and applies to both draft dates.
    ...(DRAFT_DATES.includes(field.label) ? [draftDateWarning(value)] : []),
    touched ? fieldWarning(field.label, value, values) : null,
    // Last, so it reads after the shape check rather than in front of it: "this
    // isn't a valid SSN" and "this SSN is already sold" are different questions
    // and the first one comes first.
    duplicateSsnWarning(duplicate.hit, Date.now()),
  ].filter((hint) => hint !== null);

  return (
    <div className={`flex flex-col gap-1 ${field.span ?? ""}`}>
      <label htmlFor={id} className="field-label">
        {field.label}
        {field.required ? <span className="text-accent"> *</span> : null}
      </label>

      {field.type === "textarea" ? (
        <textarea
          id={id}
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={handleBlur}
          className="field-input resize-none"
        />
      ) : field.type === "radio" ? (
        <div className="flex flex-wrap gap-1.5">
          {field.options?.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              aria-pressed={value === option}
              className={value === option ? "chip chip-active" : "chip"}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <input
          id={id}
          type={ISO_DATE_TYPES.has(field.type) ? "date" : "text"}
          inputMode={field.type === "number" ? "numeric" : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={handleBlur}
          className="field-input"
          autoComplete="off"
        />
      )}

      {hints.map((hint) => (
        <span
          key={hint.text}
          className={`text-[0.68rem] font-semibold ${
            hint.tone === "danger"
              ? "text-destructive"
              : hint.tone === "warn"
                ? "text-primary"
                : "text-muted-foreground"
          }`}
        >
          {hint.text}
        </span>
      ))}
    </div>
  );
}
