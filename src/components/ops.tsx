import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { BrandLogo } from "@/components/brand-logo";
import { carrierSummary } from "@/lib/carriers";
import { useAuth } from "@/lib/auth";

/**
 * The whole of the `sub_status` enum, in flow order. Spelled once so a filter
 * offering every state cannot drift from the states that exist.
 */
export const SUB_STATUSES = [
  // Imported leads only, and ahead of everything else: a sheet batch waits for
  // a manager to accept it before its leads become ordinary queue rows. A
  // closer submission never passes through this state.
  "pending_import_approval",
  "pending_manager",
  "assigned",
  "in_review",
  "returned_timeout",
  "closed",
] as const;

export type SubStatus = (typeof SUB_STATUSES)[number];

/**
 * 'accepted' is shown as "Submit" throughout the UI. The stored value and the
 * value sent to dispose_submission stay 'accepted' — this is a label change
 * only, and this map is the single place it is spelled. Anything rendering an
 * outcome goes through dispositionLabel() rather than hardcoding the word.
 */
export const DISPOSITIONS = ["accepted", "declined", "pending"] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

const DISPOSITION_LABEL: Record<Disposition, string> = {
  accepted: "Submitted",
  declined: "Declined",
  pending: "Pending",
};

export function dispositionLabel(value: Disposition | null | undefined) {
  return value ? DISPOSITION_LABEL[value] : null;
}

/**
 * Where a lead came into the system. 'sheet' rows were normalised out of a
 * spreadsheet by a data uploader and have no closer behind them — this is an
 * origin, not a workflow state, so it never joins the status badge chain.
 *
 * These two strings are the whole of `submissions_source_chk`; the database
 * rejects anything else, so they are the only values that can ever arrive.
 */
export type LeadSource = "live" | "sheet";

export type DataFlag = { field: string; issue: string; raw: string };

export type SubmissionRow = {
  id: string;
  /**
   * NULLABLE. An offline lead has no closer. Every read of a closer name has to
   * cope with that — use `closerName()` rather than reaching for full_name.
   */
  closer_id: string | null;
  /**
   * The centre the lead was taken in, stamped at submission. `center_name` is
   * the name as it stood then — read it rather than joining `centers` through
   * `center_id`, so a renamed or reassigned centre cannot rewrite what the
   * history says. Both are null on leads that predate the column.
   */
  center_id: string | null;
  center_name: string | null;
  source: LeadSource;
  source_ref: string | null;
  uploaded_by: string | null;
  import_id: string | null;
  data_flags: unknown;
  payload: Record<string, unknown>;
  status: SubStatus;
  assigned_to: string | null;
  assigned_at: string | null;
  claimed_at: string | null;
  last_timeout_by: string | null;
  timeout_count: number;
  hold_count: number;
  rejection_count: number;
  last_rejected_by: string | null;
  last_held_at: string | null;
  archived_at: string | null;
  archived_by: string | null;
  disposition: Disposition | null;
  disposed_by: string | null;
  disposed_at: string | null;
  created_at: string;
  /**
   * Which form the lead came in on. Null on rows written before the column
   * existed, which are closer submissions — only an explicit 'validator' is
   * treated as validator-originated anywhere.
   */
  submitted_by_role: "closer" | "validator" | null;
  /**
   * Set during review, not at submission — see `ValidatorFields`. The carrier
   * the lead was actually placed with, which is a different question from the
   * carrier the closer expected in `payload`, and `dispose_submission` will not
   * accept a closer-originated lead until all three are set.
   */
  final_carrier_id: string | null;
  agent_name: string | null;
  policy_number: string | null;
};

export const REVIEW_WINDOW_MS = 10 * 60 * 1000;

export type ReviewSettings = { enabled: boolean; minutes: number };

const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { enabled: true, minutes: 10 };

/**
 * The review window is configured server-side. Expiry is still enforced by the
 * pg_cron job and the validator SELECT policy — this only tells the UI how long
 * a clock should run and whether to show one at all.
 *
 * `ready` is false until the RPC settles. Consumers must not draw a countdown or
 * act on one before then, or a longer configured window reads as already
 * expired against the 10-minute default. If the RPC fails we fall back to those
 * defaults and still show a clock, which is the behaviour that predates this
 * setting — better than silently hiding a window the server is still enforcing.
 */
export function useReviewSettings() {
  const query = useQuery({
    queryKey: ["review-settings"],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("review_settings");
      if (error) throw error;
      const raw = (data ?? {}) as Partial<ReviewSettings>;
      return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_REVIEW_SETTINGS.enabled,
        minutes:
          typeof raw.minutes === "number" && raw.minutes > 0
            ? raw.minutes
            : DEFAULT_REVIEW_SETTINGS.minutes,
      } satisfies ReviewSettings;
    },
  });

  const settings = query.data ?? DEFAULT_REVIEW_SETTINGS;
  return {
    ...settings,
    windowMs: settings.minutes * 60 * 1000,
    ready: !query.isPending,
  };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * "3d ago". A difference between two instants, so it needs no timezone — and
 * must not be routed through `format-date`, which formats a wall clock.
 */
export function relativeTime(iso: string, now: number) {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function remainingMs(claimedAt: string | null, now: number, windowMs = REVIEW_WINDOW_MS) {
  if (!claimedAt) return 0;
  return new Date(claimedAt).getTime() + windowMs - now;
}

/**
 * The payload keys that hold a carrier, in the order they are looked at.
 *
 * Exported so the server-side search matches on exactly the keys the column
 * displays — a search that looked at one key while the cell rendered the other
 * would report "no results" over rows the reader can see.
 */
export const CARRIER_KEYS = ["Carrier Name", "Agency"] as const;

export function customerName(payload: Record<string, unknown>) {
  const value = payload?.["Full Name"];
  return typeof value === "string" && value.trim() ? value : "—";
}

/**
 * The carrier a lead was written for, as it was typed.
 *
 * TWO keys, because the two forms disagree and always have. A closer submission
 * and an imported lead carry "Carrier Name"; a validator submission carries
 * "Agency", which is the key the Apps Script routes a Google Sheet tab off and
 * so cannot be renamed. Reading only one of them left every row on one of the
 * Reporting tabs showing a dash.
 *
 * The value is trimmed for display and nothing more. The stored values are
 * whatever the operator typed — "Fidelity Life", "Fidelity Life ", " Fidelity "
 * are all real rows today — and this is a record of what was written, not a
 * name resolved against the `carriers` table. Leads taken before the field
 * existed have no value at all, which is why the dash is a common case rather
 * than an exception.
 */
export function carrierName(payload: Record<string, unknown>) {
  for (const key of CARRIER_KEYS) {
    const value = payload?.[key];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return "—";
}

/**
 * The closer's name, or the reason there isn't one. Sheet leads have a null
 * closer_id, so anything that renders `closer.full_name` directly will render
 * "undefined" at best and throw at worst.
 */
export function closerName(row: {
  source?: LeadSource | null;
  closer?: { full_name: string | null } | null;
  uploader?: { full_name: string | null } | null;
}) {
  if (row.source === "sheet") return row.uploader?.full_name ?? "Offline lead";
  return row.closer?.full_name ?? "—";
}

/**
 * Is this lead sitting on a validator's hold right now?
 *
 * `hold_submission` does not write a disposition — it puts the row back to
 * `assigned`, clears `claimed_at` and stamps `last_held_at` — so being on hold
 * is a shape rather than a stored flag, and this is the one place that shape is
 * spelled out.
 *
 * The `last_held_at > assigned_at` test is what keeps it honest. `last_held_at`
 * is never cleared, so a lead that was held, reclaimed, timed out and then
 * reassigned still carries the old stamp; comparing it against the current
 * assignment is what separates "held now" from "was held once".
 */
export function isOnHold(row: {
  status: SubStatus;
  claimed_at: string | null;
  assigned_at: string | null;
  last_held_at: string | null;
}) {
  if (row.status !== "assigned" || row.claimed_at || !row.last_held_at) return false;
  if (!row.assigned_at) return true;
  return new Date(row.last_held_at).getTime() > new Date(row.assigned_at).getTime();
}

/**
 * How a `form_events` type is spelled in a timeline.
 *
 * Only the ones whose stored name reads badly to an operator are listed;
 * anything else shows its own type, which is usually the clearest thing to say.
 * 'submitted' is the sale being closed, so it is labelled as that rather than
 * as the database verb.
 */
const EVENT_LABEL: Record<string, string> = {
  submitted: "Sale Closed By",
  // Written by `set_validator_fields`, so the change already lands in the
  // validation timeline and needs no history panel of its own.
  validator_fields_set: "Validator Fields Set",
};

export function eventLabel(type: string) {
  return EVENT_LABEL[type] ?? type;
}

/** submissions.data_flags is jsonb, so it arrives as unknown. */
export function dataFlags(value: unknown): DataFlag[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const flag = entry as Record<string, unknown>;
    const field = typeof flag["field"] === "string" ? flag["field"] : null;
    if (!field) return [];
    return [
      {
        field,
        issue: typeof flag["issue"] === "string" ? flag["issue"] : "needs review",
        raw: typeof flag["raw"] === "string" ? flag["raw"] : "",
      },
    ];
  });
}

/**
 * The profile behind `uploaded_by`. Optional `org_name` so a query that has not
 * asked for the column still type-checks — it just falls back to the name.
 */
export type UploaderRef = { full_name: string | null; org_name?: string | null } | null;

/**
 * Where a lead came from, in words an operator recognises.
 *
 * A closer's own submission is "Live". An imported one is named for the centre
 * that supplied it — `org_name` if the uploading account has one, otherwise the
 * person's own name, which is the most specific thing left to say.
 *
 * "Offline" survives as the last fallback for the rows that predate any of
 * this: sheet leads with no `uploaded_by` at all. It is not a default for rows
 * that simply have not been given an org_name — those name the uploader.
 */
export function sourceLabel(row: { source?: LeadSource | null; uploader?: UploaderRef }) {
  if (row.source !== "sheet") return "Live";
  const org = row.uploader?.org_name?.trim();
  if (org) return org;
  const name = row.uploader?.full_name?.trim();
  return name || "Offline";
}

/**
 * Origin, kept visually quiet and separate from StatusBadge: where a lead came
 * from says nothing about where it is in the workflow.
 *
 * Live and imported keep the one muted outline between them — the label is what
 * carries the difference, and giving a centre its own colour would turn a
 * provenance note into an alert.
 */
export function OriginBadge({
  row,
}: {
  row: { source?: LeadSource | null; uploader?: UploaderRef };
}) {
  return (
    <Badge variant="outline" className="max-w-[10rem] border-border text-muted-foreground">
      <span className="truncate">{sourceLabel(row)}</span>
    </Badge>
  );
}

export function FlagBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge variant="outline" className="border-destructive text-destructive">
      {count === 1 ? "1 flag" : `${count} flags`}
    </Badge>
  );
}

export const STATUS_LABEL: Record<SubStatus, string> = {
  pending_import_approval: "Awaiting import approval",
  pending_manager: "Unassigned",
  assigned: "Assigned",
  in_review: "Attempting",
  returned_timeout: "Returned",
  closed: "Completed",
};

/**
 * Outcome colours: Declined red and Pending amber both come from the palette
 * (`destructive` and `accent`). The green on 'accepted' does NOT — there is no
 * green token, so it is the one hardcoded colour in the app, added deliberately
 * because a green/amber/red outcome scale was asked for.
 */
const DISPOSITION_BADGE: Record<Disposition, string> = {
  accepted: "border-transparent bg-emerald-600 text-white hover:bg-emerald-600/80",
  declined: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
  pending: "border-transparent bg-accent text-accent-foreground hover:bg-accent/80",
};

/**
 * Outlined amber, so a hold reads as a pause rather than as an outcome — the
 * three solid badges above are decisions, this is the absence of one.
 */
const ON_HOLD_BADGE = "border-accent/70 bg-accent/10 text-accent hover:bg-accent/20";

export function DispositionBadge({
  disposition,
  onHold = false,
}: {
  disposition: Disposition | null | undefined;
  /**
   * Takes precedence over a stored disposition. A lead can carry an outcome
   * from an earlier pass and still be on hold in this one; what the reader
   * needs from this column is where it stands now, and the superseded outcome
   * is still in the timeline.
   */
  onHold?: boolean;
}) {
  if (onHold) return <Badge className={ON_HOLD_BADGE}>On Hold</Badge>;
  const label = dispositionLabel(disposition);
  if (!disposition || !label) return <span className="text-muted-foreground">—</span>;
  return <Badge className={DISPOSITION_BADGE[disposition]}>{label}</Badge>;
}

/**
 * Where a lead stands in the queue, in one badge.
 *
 * Two leads can both be `pending_manager` with nobody assigned and mean
 * completely different things: one has never been touched, the other came back
 * from a validator needing a different carrier. `disposition` is the only thing
 * that separates them — null on a fresh lead, 'declined' on a returned one — so
 * they are drawn as destructive red and muted grey rather than as the one
 * "Unassigned" badge they used to share.
 *
 * The precedence, highest first:
 *
 *   1. returned_timeout                    "Unsubmitted by {name}"  destructive
 *   2. pending_manager + rejections        "Rejected by {name}"     destructive
 *   3. pending_manager + declined          "Unassigned!"            destructive
 *   4. pending_manager + no disposition    "Unassigned"             muted
 *   5. anything else                       `fallback`, or StatusBadge
 *
 * Every view that lists leads renders this same component, so the three of them
 * cannot drift; `fallback` is how a view keeps badges of its own for the rows
 * the chain does not decide.
 */
export function QueueStatusBadge({
  row,
  declinedCarriers = [],
  fallback,
}: {
  /**
   * Structural, not `SubmissionRow`: the three tables that draw this select
   * different columns. A view that does not fetch `rejection_count` or the
   * actor names simply cannot reach the branches that need them, which is why
   * they are optional rather than required and defaulted.
   */
  row: {
    status: SubStatus;
    disposition: Disposition | null;
    rejection_count?: number;
    timeout_by?: { full_name: string | null } | null;
    rejected_by?: { full_name: string | null } | null;
  };
  /** From `submission_declined_carriers`. Empty where none are recorded. */
  declinedCarriers?: string[];
  /** Drawn instead of StatusBadge when nothing above matched. */
  fallback?: ReactNode;
}) {
  if (row.status === "returned_timeout") {
    return (
      <Badge variant="destructive">Unsubmitted by {row.timeout_by?.full_name ?? "validator"}</Badge>
    );
  }

  if (row.status === "pending_manager" && (row.rejection_count ?? 0) > 0) {
    return (
      <Badge variant="destructive">Rejected by {row.rejected_by?.full_name ?? "validator"}</Badge>
    );
  }

  if (row.status === "pending_manager" && row.disposition === "declined") {
    // The carriers already ruled out, so the manager knows what is left to try
    // without opening the row. Two names, then "+N".
    return (
      <Badge variant="destructive" className="max-w-[18rem]">
        <span className="truncate">
          {STATUS_LABEL.pending_manager}!
          {declinedCarriers.length > 0 ? ` · ${carrierSummary(declinedCarriers)}` : ""}
        </span>
      </Badge>
    );
  }

  if (row.status === "pending_manager" && !row.disposition) {
    // Muted on purpose. A lead nobody has touched yet is the quiet case; it is
    // the returned one above that wants the eye.
    return (
      <Badge variant="secondary" className="text-muted-foreground">
        {STATUS_LABEL.pending_manager}
      </Badge>
    );
  }

  return <>{fallback ?? <StatusBadge status={row.status} />}</>;
}

export function StatusBadge({ status }: { status: SubStatus }) {
  const variant =
    status === "returned_timeout"
      ? "destructive"
      : status === "in_review" || status === "pending_manager"
        ? "default"
        : "secondary";
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(key: string, text: string) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
    } catch {
      setCopied(null);
    }
  }

  return { copied, copy };
}

/**
 * The order the review panels list a lead's fields in.
 *
 * A payload is jsonb, so `Object.entries` hands back whatever key order that
 * particular row happens to carry — which differs between a closer submission,
 * a validator submission and an imported lead. Reading three leads side by side
 * meant re-finding the same field in three different places each time.
 *
 * These are the STORED keys, not the labels a form shows. Eight of them read
 * differently on screen than they do in the payload ("Doc Phone" is the doctor's
 * number, "CVC" the card's security code), and a near-miss here fails silently:
 * the key simply never matches and quietly drops to the tail of the list.
 *
 * Display only. It changes nothing about what is stored, what is submitted, or
 * how either form is laid out.
 */
export const PAYLOAD_ORDER = [
  "ID",
  "Full Name",
  "Phone Number",
  "Secondary Phone",
  "Date of Birth",
  "Age",
  "Smoker or Non Smoker",
  "Health Condition",
  "Medications",
  "Gender",
  "Height",
  "Weight",
  "Residential Address",
  "City",
  "Birth State",
  "Plan Type",
  "Coverage Amount",
  "Premium",
  "Email Address",
  "SSN Number",
  "Driving License or State ID",
  "Doc Name",
  "Doc Phone",
  "Doc Address",
  "Beneficiary Name",
  "Beneficiary Relationship",
  "Bank Name",
  "Bank Type",
  "Routing Number",
  "Account Number",
  "Draft Date",
  "Card Number",
  "Exp Date",
  "CVC",
  "Agent Name",
  "Policy Number",
] as const;

const PAYLOAD_ORDER_INDEX = new Map(PAYLOAD_ORDER.map((key, index) => [key as string, index]));

/**
 * One lead's fields, in PAYLOAD_ORDER, then everything else.
 *
 * Two rules do the work. A key in the order that this lead does not carry is
 * simply absent — no empty row is invented for a card number on a closer's
 * lead. A key the order has never heard of still renders, appended in the order
 * the payload itself carried it, so an older submission or an imported column
 * cannot silently vanish from the only screen that shows it.
 */
export function orderedPayloadEntries(payload: Record<string, unknown>) {
  const ordered: [string, unknown][] = [];
  const rest: [string, unknown][] = [];
  for (const entry of Object.entries(payload ?? {})) {
    (PAYLOAD_ORDER_INDEX.has(entry[0]) ? ordered : rest).push(entry);
  }
  ordered.sort(
    (a, b) => (PAYLOAD_ORDER_INDEX.get(a[0]) ?? 0) - (PAYLOAD_ORDER_INDEX.get(b[0]) ?? 0),
  );
  return [...ordered, ...rest];
}

/**
 * The payload keys holding a calendar date.
 *
 * A date input yields YYYY-MM-DD, so that is what both forms store and what
 * goes to the Sheet. Nobody on a call reads a date that way, and the importer
 * already normalises its own dates to US order, so a form lead and an imported
 * lead otherwise sit in the same table in two different formats.
 */
const DATE_KEYS = new Set(["Date of Birth", "Draft Date", "Future Draft Date"]);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * What a payload value looks like on screen — MM-DD-YYYY for a date, the stored
 * text for everything else.
 *
 * DISPLAY ONLY. Nothing here is written back: `payload` still holds YYYY-MM-DD,
 * the Sheet column is untouched, and the editors deliberately do not use this —
 * a date input only accepts YYYY-MM-DD, so reformatting there would empty the
 * field and one careless save would wipe the value.
 *
 * Anything that is not exactly YYYY-MM-DD is passed through as-is, which leaves
 * imported leads (already MM/DD/YYYY) and free text alone rather than mangling
 * them.
 */
export function payloadDisplayValue(key: string, value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  if (!DATE_KEYS.has(key)) return text;
  const parts = ISO_DATE.exec(text.trim());
  return parts ? `${parts[2]}-${parts[3]}-${parts[1]}` : text;
}

/**
 * The word a payload key is shown under, where the stored key is not the word
 * an operator should be reading.
 *
 * DISPLAY ONLY, for exactly the reason `payloadDisplayValue` is: the key itself
 * is load-bearing. A validator submission files the carrier under "Agency", and
 * the Apps Script routes the Google Sheet tab off that literal string — rename
 * the key and new submissions land on the wrong tab, quietly, with nothing in
 * the app to show for it. So the key stays exactly as it is and only the label
 * above it changes.
 *
 * Everything that WRITES a field keeps using the raw key: the `p_field`
 * argument to `update_payload_field`, the `FIELD_BY_LABEL` lookup that decides
 * an input's type, and the DOM id built off it. This is the last step before
 * the text reaches the screen and nothing else.
 */
const PAYLOAD_LABEL: Record<string, string> = {
  Agency: "Carrier Name",
};

export function payloadDisplayLabel(key: string) {
  return PAYLOAD_LABEL[key] ?? key;
}

export function PayloadTable({ payload }: { payload: Record<string, unknown> }) {
  const entries = orderedPayloadEntries(payload);
  const { copied, copy } = useCopy();

  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {entries.map(([key, value]) => {
        const isEmpty = value === null || value === undefined || value === "";
        // Reformatted for reading and for copying — what is on screen is what
        // lands on the clipboard, which is the point of showing it this way.
        const text = isEmpty ? "" : payloadDisplayValue(key, value);
        const isCopied = copied === key;
        // The row is still keyed and copied by the stored key — only the word
        // above the value, and what a screen reader announces, is the label.
        const label = payloadDisplayLabel(key);

        return (
          <div
            key={key}
            className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/5"
          >
            <span className="field-label truncate">{label}</span>

            <button
              type="button"
              disabled={isEmpty}
              onClick={() => copy(key, text)}
              title={isEmpty ? undefined : "Click to copy"}
              className="cursor-pointer break-words text-left text-xs text-foreground disabled:cursor-default"
            >
              {isEmpty ? "—" : text}
            </button>

            {isEmpty ? (
              <span className="h-6 w-6" />
            ) : (
              <button
                type="button"
                onClick={() => copy(key, text)}
                aria-label={isCopied ? `${label} copied` : `Copy ${label}`}
                className={`flex h-6 w-6 items-center justify-center rounded transition-opacity hover:bg-accent/10 focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                  isCopied ? "opacity-100" : "opacity-40 group-hover:opacity-100"
                }`}
              >
                {isCopied ? (
                  <Check className="h-3.5 w-3.5 text-accent" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AppHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  const { profile, signOut } = useAuth();
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
      {/* No min-w-0 here on purpose: a flex item defaults to min-width:auto,
          which is what stops this block being squeezed narrower than the
          lockup. The header wraps instead, which is the outcome we want. */}
      <div>
        {/* The lockup replaces the old "ASTRAX" eyebrow; the role keeps that
            line's typography so the pairing still reads as one strip. */}
        <div className="flex items-center gap-2">
          <BrandLogo className="h-10 w-auto max-w-none shrink-0" />
          {/* {subtitle ? (
            <span className="text-[0.65rem] font-semibold uppercase tracking-[0.35em] text-accent">
              · {subtitle}
            </span>
          ) : null} */}
        </div>
        {/* <h1 className="font-display text-2xl font-semibold tracking-tight lg:text-3xl">{title}</h1> */}
      </div>
      <div className="flex items-center gap-3">
        {actions}
        <span className="text-xs text-muted-foreground">
          {profile?.full_name ?? "Signed in"}
          {profile ? ` · ${profile.role}` : ""}
        </span>
        <button type="button" className="chip" onClick={signOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
