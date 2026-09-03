import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { roleHome, useAuth } from "@/lib/auth";
import { draftDateWarning, fieldWarning } from "@/lib/form-warnings";
import { calcAge, formatSSN, zodiacSign } from "@/lib/form-fields";
import { useCarriers } from "@/lib/carriers";
import type { Carrier } from "@/lib/carriers";
import { AppHeader } from "./ops";
import { BrandLogo } from "./brand-logo";

/**
 * `carrier` renders the same chip toggles as `radio`, but its options are the
 * active rows of the `carriers` table rather than a list written here. The
 * canonical NAME is what lands in the payload — an id would reach Google Sheets
 * and mean nothing to anyone reading the tab.
 */
type FieldType = "text" | "number" | "date" | "radio" | "textarea" | "carrier";

export type Field = {
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  span?: string;
};

export type Section = { title: string; fields: Field[] };

/**
 * The closer intake form. The carrier is a field here, not a step: unlike the
 * validator form it does not swap the schema, so a closer always gets the same
 * fixed set of fields. Every label below is the jsonb payload key and
 * therefore the Google Sheet column header, so it is spelled here and nowhere
 * else. The server stamps ID and Submitted By Role; the client never sends them.
 */
export const SECTIONS: Section[] = [
  {
    title: "Customer",
    fields: [
      { label: "Full Name", type: "text", required: true },
      { label: "Gender", type: "radio", required: true, options: ["Male", "Female"] },
      { label: "Date of Birth", type: "date", required: true },
      { label: "Age", type: "number", required: true },
      { label: "State", type: "text", required: true },
      { label: "Residential State", type: "text", required: true },
      { label: "Birth State", type: "text", required: true },
      { label: "Birth Country", type: "text", required: true },
      { label: "SSN Number", type: "number", required: true },
      { label: "Phone Number", type: "number", required: true },
      { label: "Email Address", type: "text", span: "sm:col-span-2" },
      { label: "Height", type: "text", required: true },
      { label: "Weight", type: "text", required: true },
      {
        label: "Residential Address",
        type: "textarea",
        required: true,
        span: "sm:col-span-2",
      },
      { label: "Customer Zip Code", type: "number" },
      {
        label: "Smoker or Non Smoker",
        type: "radio",
        required: true,
        options: ["Smoker", "Non Smoker"],
      },
    ],
  },
  {
    title: "Policy",
    fields: [
      // { label: "Carrier Name", type: "carrier", required: true }, if type = carrier than carrier name will be selectable
      { label: "Carrier Name", type: "text", required: true },
      { label: "Coverage Amount", type: "number", required: true },
      { label: "Premium", type: "text", required: true },
      { label: "Doc Name", type: "text" },
      { label: "Doc Phone", type: "number" },
      {
        label: "Plan Type",
        type: "radio",
        required: true,
        // span: "sm:col-span-2",
        options: ["Level", "Graded" , "Mod" , "G.I"],
      },
      { label: "Doc Address", type: "textarea", span: "sm:col-span-2" },
      { label: "Beneficiary Name", type: "text", required: true },
      { label: "Beneficiary Relationship", type: "text", required: true },
      { label: "Beneficiary Info", type: "textarea", span: "sm:col-span-2" },
      // { label: "Relationship", type: "text", required: true },
    ],
  },
  {
    title: "Banking",
    fields: [
      { label: "Draft Date", type: "date", required: true },
      { label: "Bank Draft", type: "radio", required: true, options: ["Yes", "No"] },
      { label: "Account Title", type: "text", required: true },
      { label: "Bank Name", type: "text", required: true },
      { label: "Bank Type", type: "radio", required: true, options: ["Checking", "Saving"] },
      { label: "Routing Number", type: "number", required: true },
      { label: "Account Number", type: "text", required: true },
      { label: "Card Number", type: "number" },
      { label: "Exp Date", type: "text" },
      { label: "CVC", type: "number" },
      { label: "Notes & Comments", type: "textarea", span: "sm:col-span-2" },
    ],
  },
];

const DOB = "Date of Birth";
const AGE = "Age";
const SSN = "SSN Number";
const DRAFT_DATE = "Draft Date";
const ZIP = "Customer Zip Code";

const ALL_FIELDS = SECTIONS.flatMap((section) => section.fields);

function emptyForm(): Record<string, string> {
  return Object.fromEntries(ALL_FIELDS.map((field) => [field.label, ""]));
}

export function CloserForm() {
  const { profile, signOut } = useAuth();
  // The one source of carrier names. Active only, in the admin's order.
  const carriers = useCarriers(true);
  const [values, setValues] = useState<Record<string, string>>(emptyForm);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  // Age is derived from the date of birth but stays a normal field, so a closer
  // can correct it when the customer disputes the arithmetic.
  const set = (label: string, value: string) =>
    setValues((prev) => {
      if (label === SSN) return { ...prev, [label]: formatSSN(value) };
      if (label === DOB) {
        const age = calcAge(value);
        return { ...prev, [label]: value, [AGE]: age === null ? "" : String(age) };
      }
      return { ...prev, [label]: value };
    });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Chip groups are buttons, so the browser never validates them for us.
    const missing = ALL_FIELDS.find((field) => field.required && !values[field.label]?.trim());
    if (missing) {
      setStatus("error");
      setMessage(`${missing.label} is required.`);
      return;
    }

    setStatus("sending");
    setMessage("");
    try {
      const { error } = await supabase.rpc("submit_form", { p_payload: values });
      if (error) throw new Error(error.message);
      setStatus("sent");
      setMessage("Submission saved to the sheet.");
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
            <h1 className="font-display text-2xl font-semibold tracking-tight lg:text-3xl">
              {/* Closer&apos;s Form */}
              <BrandLogo className="h-10 w-auto max-w-none shrink-0" />
            </h1>
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
            ) : (
              <span className="text-xs text-muted-foreground">
                {/* All fields sync directly to Google Sheets */}
              </span>
            )}
            <button type="submit" className="btn-submit" disabled={status === "sending"}>
              {status === "sending" ? "Submitting…" : "Submit entry"}
            </button>
            <Link to="/forwarded-leads" className="chip inline-block">
              Forwarded Leads
            </Link>
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

        <div className="grid flex-1 gap-3 lg:min-h-0 lg:grid-cols-12 lg:gap-4">
          {SECTIONS.map((section) => (
            <section key={section.title} className="panel lg:col-span-4">
              <h2 className="panel-title">{section.title}</h2>
              <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
                {section.fields.map((field) => (
                  <FieldControl
                    key={field.label}
                    field={field}
                    value={values[field.label] ?? ""}
                    values={values}
                    carriers={carriers.data ?? []}
                    carriersLoading={carriers.isLoading}
                    carriersError={carriers.isError ? (carriers.error as Error).message : null}
                    onChange={(v) => set(field.label, v)}
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

type ZipInfo = { place: string; state: string; temp: number; time: string };

/** Public read-only lookups for the zip hint. Nothing is written anywhere. */
function useZipInfo(zip: string, enabled: boolean) {
  const [info, setInfo] = useState<ZipInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !/^\d{5}$/.test(zip)) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const geoRes = await fetch(`https://api.zippopotam.us/us/${zip}`);
        if (!geoRes.ok) throw new Error("zip");
        const geo = await geoRes.json();
        const p = geo.places?.[0];
        if (!p) throw new Error("place");
        const lat = p.latitude;
        const lon = p.longitude;
        const wRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&temperature_unit=fahrenheit&timezone=auto`,
        );
        if (!wRes.ok) throw new Error("weather");
        const w = await wRes.json();
        const local = new Date(w.current.time);
        const time = local.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
        if (!cancelled)
          setInfo({
            place: p["place name"],
            state: p["state"],
            temp: Math.round(w.current.temperature_2m),
            time,
          });
      } catch {
        if (!cancelled) setInfo(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zip, enabled]);

  return { info, loading };
}

function FieldControl({
  field,
  value,
  values,
  carriers,
  carriersLoading,
  carriersError,
  onChange,
}: {
  field: Field;
  value: string;
  /** The whole form — the zip/state cross-check needs a second field. */
  values: Record<string, string>;
  /** Only a `carrier` field reads these; every other type ignores them. */
  carriers: Carrier[];
  carriersLoading: boolean;
  carriersError: string | null;
  onChange: (value: string) => void;
}) {
  const id = field.label.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
  const isZip = field.label === ZIP;
  const { info: zipInfo, loading: zipLoading } = useZipInfo(value, isZip);

  // Checked on blur, not per keystroke: a half-typed routing number is not a
  // mistake, and saying so while it is still being typed is pure noise.
  const [touched, setTouched] = useState(false);
  const warning = touched ? fieldWarning(field.label, value, values) : null;

  type Hint = { tone: "info" | "warn" | "danger" | "ok"; text: string };
  const hints = (() => {
    const out: Hint[] = [];
    if (isZip) {
      if (zipLoading) out.push({ tone: "info", text: "Looking up location…" });
      else if (zipInfo)
        out.push({
          tone: "info",
          text: `${zipInfo.temp}°F in ${zipInfo.place}, ${zipInfo.state} — ${zipInfo.time} local time`,
        });
      return out;
    }
    if (!value) return out;

    // Rapport prompt only — the sign is never part of the payload.
    if (field.label === DOB) {
      const sign = zodiacSign(value);
      if (sign) out.push({ tone: "info", text: `${sign.symbol} ${sign.name}` });
    }
    if (field.label === DRAFT_DATE) {
      // The same weekend check the validator form runs on both of its draft
      // dates, rather than a second copy of it here.
      const weekend = draftDateWarning(value);
      if (weekend) out.push(weekend);
    }
    return out;
  })();

  if (warning) hints.push(warning);

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
          onBlur={() => setTouched(true)}
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
      ) : field.type === "carrier" ? (
        <div className="flex flex-wrap gap-1.5">
          {carriers.map((carrier) => (
            <button
              key={carrier.id}
              type="button"
              /* The NAME, not the id: this string is the Sheet cell. */
              onClick={() => onChange(carrier.name)}
              aria-pressed={value === carrier.name}
              className={value === carrier.name ? "chip chip-active" : "chip"}
            >
              {carrier.name}
            </button>
          ))}
          {/* A carrier saved before it was renamed or deactivated still has to
              show, or reopening a draft silently drops the closer's choice. */}
          {value && !carriers.some((carrier) => carrier.name === value) ? (
            <button type="button" aria-pressed className="chip chip-active">
              {value}
            </button>
          ) : null}
          {carriersError ? (
            <span className="text-[0.68rem] font-semibold text-destructive">{carriersError}</span>
          ) : carriersLoading ? (
            <span className="text-[0.68rem] text-muted-foreground">Loading carriers…</span>
          ) : carriers.length === 0 ? (
            <span className="text-[0.68rem] text-muted-foreground">
              No carriers set up — ask an admin to add them in Settings.
            </span>
          ) : null}
        </div>
      ) : (
        <input
          id={id}
          type={field.type === "number" ? "text" : field.type}
          inputMode={field.type === "number" ? "numeric" : undefined}
          required={field.required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          className="field-input"
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
                : hint.tone === "ok"
                  ? "text-muted-foreground"
                  : "text-accent"
          }`}
        >
          {hint.text}
        </span>
      ))}
    </div>
  );
}
