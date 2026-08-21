import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

const WEBHOOK_URL = "https://umsbpo.app.n8n.cloud/webhook/ums-closer-form";

type FieldType = "text" | "number" | "date" | "radio" | "textarea";

type Field = {
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  span?: string;
};

const SECTIONS: { title: string; fields: Field[] }[] = [
  {
    title: "Customer",
    fields: [
      { label: "Closer ID", type: "text", required: true },
      { label: "Full Name", type: "text", required: true },
      { label: "Customer Phone", type: "number" },
      { label: "Customer D.O.B", type: "date", required: true },
      { label: "Customer Age", type: "number" },
      { label: "Address", type: "textarea", required: true, span: "sm:col-span-2" },
      { label: "City", type: "text", required: true },
      { label: "State", type: "text" },
      { label: "Customer Zip Code", type: "number", required: true },
      { label: "Born in which State?", type: "text", required: true },
    ],
  },
  {
    title: "Policy",
    fields: [
      { label: "Insurance Carrier", type: "text" },
      { label: "Coverage Amount", type: "number" },
      { label: "Ins. Premium", type: "text" },
      {
        label: "Ins. Plan Type",
        type: "radio",
        options: ["Level", "Graded / Mod", "G.I"],
        // span: "sm:col-span-2",
      },
      {
        label: "Tobacco Usage",
        type: "radio",
        required: true,
        options: ["YES", "NO", "Willing to Quit"],
        span: "sm:col-span-2",
      },
      {
        label: "Doctor / Physician - Name(s) + Info",
        type: "textarea",
        span: "sm:col-span-2",
      },
      {
        label: "Beneificiary Name(s) + Info",
        type: "textarea",
        required: true,
        span: "sm:col-span-2",
      },
    ],
  },
  {
    title: "Banking",
    fields: [
      { label: "S.S.N", type: "number", required: true },
      { label: "Draft Date", type: "date", required: true },
      { label: "Bank Name", type: "text", required: true },
      { label: "Routing Number", type: "number", required: true },
      { label: "Account Number", type: "text", required: true , span: "sm:col-span-2"},
      {
        label: "Account Type",
        type: "radio",
        required: true,
        options: ["Checking", "Saving"],
        span: "sm:col-span-2"
      },
      { label: "Note & Comment", type: "textarea", span: "sm:col-span-2" },
    ],
  },
];

const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);

function emptyForm(): Record<string, string> {
  return Object.fromEntries(ALL_FIELDS.map((f) => [f.label, ""]));
}

export function CloserForm() {
  const { signOut } = useAuth();
  const [values, setValues] = useState<Record<string, string>>(emptyForm);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  const set = (label: string, value: string) =>
    setValues((prev) => {
      if (label === "S.S.N") return { ...prev, [label]: formatSSN(value) };
      if (label === "Customer D.O.B") {
        const age = calcAge(value);
        return {
          ...prev,
          [label]: value,
          "Customer Age": age === null ? "" : String(age),
        };
      }
      return { ...prev, [label]: value };
    });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    setMessage("");
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
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
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.35em] text-accent">
              UMS BPO
            </p>
            <h1 className="font-display text-2xl font-semibold tracking-tight lg:text-3xl">
              Closer&apos;s Form
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
                All fields sync directly to Google Sheets
              </span>
            )}
            <button type="submit" className="btn-submit" disabled={status === "sending"}>
              {status === "sending" ? "Submitting…" : "Submit entry"}
            </button>
            <button
              type="button"
              onClick={signOut}
              className="chip"
            >
              Sign out
            </button>
          </div>
        </header>


        <div className="grid flex-1 gap-3 lg:min-h-0 lg:grid-cols-12 lg:gap-4">
          {SECTIONS.map((section, index) => (
            <section
              key={section.title}
              className={`panel ${index === 1 ? "lg:col-span-5" : index === 0 ? "lg:col-span-4" : "lg:col-span-3"}`}
            >
              <h2 className="panel-title">{section.title}</h2>
              <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
                {section.fields.map((field) => (
                  <FieldControl
                    key={field.label}
                    field={field}
                    value={values[field.label] ?? ""}
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

const ZODIAC: { name: string; symbol: string; until: [number, number] }[] = [
  { name: "Capricorn", symbol: "♑", until: [1, 19] },
  { name: "Aquarius", symbol: "♒", until: [2, 18] },
  { name: "Pisces", symbol: "♓", until: [3, 20] },
  { name: "Aries", symbol: "♈", until: [4, 19] },
  { name: "Taurus", symbol: "♉", until: [5, 20] },
  { name: "Gemini", symbol: "♊", until: [6, 20] },
  { name: "Cancer", symbol: "♋", until: [7, 22] },
  { name: "Leo", symbol: "♌", until: [8, 22] },
  { name: "Virgo", symbol: "♍", until: [9, 22] },
  { name: "Libra", symbol: "♎", until: [10, 22] },
  { name: "Scorpio", symbol: "♏", until: [11, 21] },
  { name: "Sagittarius", symbol: "♐", until: [12, 21] },
  { name: "Capricorn", symbol: "♑", until: [12, 31] },
];

function formatSSN(value: string) {
  const d = value.replace(/\D/g, "").slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 5) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

function calcAge(value: string) {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function daysToBirthday(value: string) {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(today.getFullYear(), d.getMonth(), d.getDate());
  if (next < today) next = new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
  return Math.round((next.getTime() - today.getTime()) / 86400000);
}

function zodiacSign(value: string) {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return (
    ZODIAC.find(({ until }) => m < until[0] || (m === until[0] && day <= until[1])) ?? null
  );
}

type ZipInfo = { place: string; state: string; temp: number; time: string };

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
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto`,
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
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = field.label.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
  const isZip = field.label === "Customer Zip Code";
  const { info: zipInfo, loading: zipLoading } = useZipInfo(value, isZip);

  type Hint = { tone: "info" | "warn" | "danger"; text: string };
  const hints = (() => {
    const out: Hint[] = [];
    if (isZip) {
      if (zipLoading) out.push({ tone: "info", text: "Looking up location…" });
      else if (zipInfo)
        out.push({
          tone: "info",
          text: `${zipInfo.temp}°C in ${zipInfo.place}, ${zipInfo.state} — ${zipInfo.time} local time`,
        });
      return out;
    }
    if (!value) return out;

    if (field.label === "Customer D.O.B") {
      const sign = zodiacSign(value);
      if (sign) out.push({ tone: "info", text: `${sign.symbol} ${sign.name}` });
      const days = daysToBirthday(value);
      if (days !== null && days <= 30) {
        out.push({
          tone: "warn",
          text:
            days === 0
              ? "🎂 Birthday is today"
              : days === 1
                ? "🎂 Birthday tomorrow"
                : `🎂 Birthday in ${days} days`,
        });
      }
    }
    if (field.label === "Draft Date") {
      const d = new Date(`${value}T00:00:00`);
      if (Number.isNaN(d.getTime())) return out;
      if (d.getDay() === 6) out.push({ tone: "warn", text: "⚠ It's Saturday" });
      if (d.getDay() === 0) out.push({ tone: "danger", text: "⛔ It's Sunday" });
    }
    return out;
  })();

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
          type={field.type === "number" ? "text" : field.type}
          inputMode={field.type === "number" ? "numeric" : undefined}
          required={field.required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
                : "text-accent"
          }`}
        >
          {hint.text}
        </span>
      ))}
    </div>

  );
}
