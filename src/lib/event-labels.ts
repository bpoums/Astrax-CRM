import { dispositionLabel, payloadDisplayLabel, type Disposition } from "@/components/ops";

/**
 * What a `form_events` row says, in words an operator reads.
 *
 * The timeline used to render `event_type` raw, so a lead's history was a list
 * of database identifiers — "claimed", "held", "payload_edited". Worse, the
 * `detail` jsonb beside each one was fetched and thrown away, when it is where
 * the useful part lives: which attempt, which carrier declined, which field was
 * corrected.
 *
 * So every type is spelled here once, and the detail is read into the sentence.
 * Anything unrecognised is humanised rather than dropped — a new event type
 * added in the database appears as "Some new event" instead of vanishing or
 * printing a slug, and this file is where it gets its proper wording.
 *
 * PURE: no React, no I/O. The two words it does not own are the disposition
 * labels (`accepted` reads as "Submitted", and `DISPOSITION_LABEL` is the one
 * place that is decided) and the payload field names (`Agency` reads as
 * "Carrier Name"), both of which are read through ops.tsx rather than restated.
 */

/**
 * Four tones, mapped to the palette in `styles.css` — no new colour is
 * introduced. `positive` is the same hardcoded emerald `DispositionBadge` uses
 * for an accepted lead: the one documented exception, reused rather than a
 * second one.
 */
export type EventTone = "muted" | "accent" | "positive" | "destructive";

export type EventPresentation = {
  /** The sentence on the row. */
  text: string;
  tone: EventTone;
  /** Free text the actor wrote — a decline reason, a rejection note. */
  note: string | null;
};

export type TimelineEvent = {
  event_type: string;
  detail: Record<string, unknown> | null;
};

function text(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(detail: Record<string, unknown>, key: string): number | null {
  const value = detail[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The carriers on a decline, which `decline_with_carriers` writes as an array. */
function carriers(detail: Record<string, unknown>): string[] {
  const value = detail["carriers"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
}

/**
 * The field a payload edit touched.
 *
 * Two shapes exist in the table: `{ field }` from `update_payload_field`, and
 * `{ fields: [...] }` from the bulk RPC that used to write these. Both are read
 * so an older lead's history is not blank, and both resolve through
 * `payloadDisplayLabel` so an edit to `Agency` reads as "Carrier Name".
 */
function editedFields(detail: Record<string, unknown>): string[] {
  const single = text(detail, "field");
  if (single) return [payloadDisplayLabel(single)];
  const many = detail["fields"];
  if (!Array.isArray(many)) return [];
  return many.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [payloadDisplayLabel(entry.trim())] : [],
  );
}

/** "a", "a and b", "a, b and c". */
function list(words: string[]) {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * An unknown event type, made readable rather than printed as a slug.
 *
 * `some_new_event` becomes "Some new event". It is a fallback and not a
 * substitute for wording an event properly below — but it degrades in the right
 * direction the moment the database grows a type this file has not met.
 */
export function humanizeEventType(eventType: string) {
  const words = eventType.replace(/_/g, " ").trim();
  if (!words) return "Event";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isDisposition(value: unknown): value is Disposition {
  return value === "accepted" || value === "declined" || value === "pending";
}

/**
 * One event, presented.
 *
 * `cx_status_changed` is deliberately NOT worded here. It carries a from/to
 * pair that the customer-lifecycle panel draws as two chips, and flattening it
 * to a sentence would lose the tone that says whether the lead got better or
 * worse. The timeline renders it through its own branch; this returns a plain
 * fallback so nothing breaks if it arrives anyway.
 */
export function presentEvent(event: TimelineEvent): EventPresentation {
  const detail = event.detail ?? {};
  const note = text(detail, "reason");
  const plain = (text: string, tone: EventTone = "muted"): EventPresentation => ({
    text,
    tone,
    note,
  });

  switch (event.event_type) {
    case "submitted":
      // "Sale closed", not "Submitted": this is the closer's own word for
      // what they just did, and it is what the timeline has always called it.
      // It also keeps this row distinct from the `disposed` row further down,
      // where 'accepted' renders as "Submitted".
      return plain("Sale closed");

    case "parked":
      return plain("Parked for external transfer", "accent");

    case "moved_to_validation":
      return plain("Moved to validation");

    case "assigned":
      return plain("Assigned to a validator");

    case "claimed": {
      const attempt = count(detail, "attempt");
      return plain(!attempt || attempt === 1 ? "Started review" : `Resumed, attempt ${attempt}`);
    }

    case "held": {
      const held = count(detail, "hold_number");
      return plain(held && held > 1 ? `Held, ${held} times so far` : "Held", "accent");
    }

    case "timeout":
      return plain("Timed out — window elapsed", "destructive");

    case "rejected": {
      const number = count(detail, "rejection_number");
      return plain(
        number && number > 1 ? `Returned by validator, ${number} times` : "Returned by validator",
        "destructive",
      );
    }

    case "disposed": {
      const value = detail["disposition"];
      if (!isDisposition(value)) return plain("Outcome recorded");
      // Never spelled here: 'accepted' reads as "Submit"/"Submitted" and
      // DISPOSITION_LABEL is the only place that is decided.
      const label = dispositionLabel(value) ?? value;
      const refused = carriers(detail);
      const suffix = refused.length > 0 ? ` — ${list(refused)}` : "";
      const tone: EventTone =
        value === "accepted" ? "positive" : value === "declined" ? "destructive" : "accent";
      return plain(`${label}${suffix}`, tone);
    }

    case "validator_fields_set":
      return plain("Final carrier, agent and policy number set");

    case "payload_edited": {
      const fields = editedFields(detail);
      return plain(fields.length > 0 ? `Edited ${list(fields)}` : "Lead details edited");
    }

    case "payment_edited": {
      const field = text(detail, "field");
      return plain(field ? `Edited banking — ${field.replace(/_/g, " ")}` : "Banking edited");
    }

    case "flag_cleared": {
      const field = text(detail, "field");
      return plain(field ? `Flag resolved on ${payloadDisplayLabel(field)}` : "Flag resolved");
    }

    case "reopened_from_cx": {
      const status = text(detail, "policy_status");
      return plain(
        status ? `Returned from CX — policy ${status.toLowerCase()}` : "Returned from CX",
        "destructive",
      );
    }

    case "archived":
      return plain("Archived", "destructive");

    case "unarchived":
      return plain("Restored from archive");

    case "import_approved":
      return plain("Approved from import batch");

    case "import_lead_rejected":
      return plain("Rejected from import batch", "destructive");

    case "import_batch_rejected":
      return plain("Import batch rejected", "destructive");

    case "tag_added": {
      const tag = text(detail, "tag");
      return plain(tag ? `Tagged ${tag}` : "Tagged");
    }

    case "tag_removed": {
      const tag = text(detail, "tag");
      return plain(tag ? `Tag removed — ${tag}` : "Tag removed");
    }

    default:
      return plain(humanizeEventType(event.event_type));
  }
}
