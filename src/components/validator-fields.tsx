import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/lib/auth";
import { useCarriers } from "@/lib/carriers";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The three things a validator fills in before a lead can be accepted.
 *
 * They are columns on `submissions`, not payload keys, and that is the point.
 * `payload` is what the sheet-sync trigger pushes to Google Sheets and what the
 * closer typed; these are the outcome of the review — the carrier the lead was
 * actually placed with, the agent who placed it, and the policy it became. The
 * closer's expected carrier stays exactly where it is, in Lead Details above,
 * and nothing here touches it.
 *
 * `dispose_submission` now refuses to accept a closer-originated lead until all
 * three are set, so this section is also the answer to a blocked Accept button.
 * The gate is enforced server-side; `acceptBlockedReason` below only lets the
 * button say why in advance instead of letting someone press it and go hunting.
 */

/**
 * Who may see and set these. A closer never reaches a detail sheet at all, and
 * the CX roles' pipeline sheet is about what happened after approval, so
 * neither has any business here.
 */
const ALLOWED_ROLES: AppRole[] = ["manager", "validator", "admin", "general_manager"];

/** The fields, in the order they are shown and named in the blocked message. */
const FIELDS = [
  { key: "final_carrier_id", label: "final carrier" },
  { key: "agent_name", label: "agent name" },
  { key: "policy_number", label: "policy number" },
] as const;

export type ValidatorFieldsRow = {
  id: string;
  /**
   * Null on rows written before the column existed, which are closer
   * submissions — only an explicit 'validator' is exempt.
   */
  submitted_by_role: "closer" | "validator" | null;
  final_carrier_id: string | null;
  agent_name: string | null;
  policy_number: string | null;
};

/**
 * Validator submissions auto-accept on submission and are never assigned, so
 * neither the section nor the gate means anything for them.
 */
function isCloserOriginated(row: ValidatorFieldsRow) {
  return row.submitted_by_role !== "validator";
}

/** "a", "a and b", "a, b and c" — the missing fields, read as a sentence. */
function listPhrase(words: string[]) {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function missingFields(row: ValidatorFieldsRow) {
  return FIELDS.filter((field) => !(row[field.key] ?? "").trim()).map((field) => field.label);
}

/**
 * Why Accept is unavailable, or null when it is available.
 *
 * Decline, Pending and Hold are deliberately NOT consulted against this: a lead
 * that cannot be placed is exactly the one that has no policy number, and
 * gating the way out of it would strand it.
 */
export function acceptBlockedReason(row: ValidatorFieldsRow): string | null {
  if (!isCloserOriginated(row)) return null;
  const missing = missingFields(row);
  if (missing.length === 0) return null;
  return `Set the ${listPhrase(missing)} under "To Be Filled By Validator" before accepting.`;
}

export function ValidatorFields({
  row,
  onSaved,
}: {
  row: ValidatorFieldsRow;
  /** Refetch the lead — the Accept gate reads the saved values, not the draft. */
  onSaved?: () => void;
}) {
  const { profile } = useAuth();
  const allowed = !!profile && ALLOWED_ROLES.includes(profile.role);

  // All of them, inactive included: a lead already placed with a carrier that
  // has since been retired still has to render its own name rather than a blank
  // trigger. The dropdown offers the active ones plus that one.
  const carriers = useCarriers(false, allowed);

  const [carrierId, setCarrierId] = useState(row.final_carrier_id ?? "");
  const [agent, setAgent] = useState(row.agent_name ?? "");
  const [policy, setPolicy] = useState(row.policy_number ?? "");

  // Re-seeded when a different lead is opened, and when a refetch brings back
  // what was just saved. Keyed on the stored values rather than on the row
  // object, which is a new reference on every refetch.
  useEffect(() => {
    setCarrierId(row.final_carrier_id ?? "");
    setAgent(row.agent_name ?? "");
    setPolicy(row.policy_number ?? "");
  }, [row.id, row.final_carrier_id, row.agent_name, row.policy_number]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("set_validator_fields", {
        p_sub: row.id,
        p_final_carrier_id: carrierId,
        p_agent_name: agent.trim(),
        p_policy_number: policy.trim(),
      });
      // The RPC raises its own wording, including its authorisation message.
      // Show it as written rather than replacing it with a generic failure.
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Validator fields saved");
      onSaved?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!allowed || !isCloserOriginated(row)) return null;

  const options = (carriers.data ?? []).filter(
    (carrier) => carrier.active || carrier.id === row.final_carrier_id,
  );

  const complete = !!carrierId && !!agent.trim() && !!policy.trim();
  const changed =
    carrierId !== (row.final_carrier_id ?? "") ||
    agent.trim() !== (row.agent_name ?? "") ||
    policy.trim() !== (row.policy_number ?? "");

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">To Be Filled By Validator</h3>
        <span className="text-[0.66rem] text-muted-foreground">Required to accept</span>
      </div>

      <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="field-label">Final Carrier</span>
          <Select value={carrierId} onValueChange={setCarrierId} disabled={save.isPending}>
            <SelectTrigger className="h-8 text-xs" aria-label="Final carrier">
              <SelectValue placeholder="Select a carrier…" />
            </SelectTrigger>
            <SelectContent>
              {options.map((carrier) => (
                <SelectItem key={carrier.id} value={carrier.id} className="text-xs">
                  {carrier.name}
                  {carrier.active ? "" : " (inactive)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[0.62rem] text-muted-foreground">
            Where the lead was actually placed — not the carrier the closer expected.
          </span>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`agent-${row.id}`} className="field-label">
              Agent Name
            </label>
            <input
              id={`agent-${row.id}`}
              value={agent}
              disabled={save.isPending}
              onChange={(event) => setAgent(event.target.value)}
              className="field-input"
              autoComplete="off"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`policy-${row.id}`} className="field-label">
              Policy Number
            </label>
            <input
              id={`policy-${row.id}`}
              value={policy}
              disabled={save.isPending}
              onChange={(event) => setPolicy(event.target.value)}
              className="field-input"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* A chip, not the amber button: the sheet's one emphasis belongs to
              the action that disposes the lead. */}
          <button
            type="button"
            className="chip px-2.5 py-0.5 text-[0.66rem]"
            disabled={save.isPending || !complete || !changed}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <span className="text-[0.62rem] text-muted-foreground">
            {carriers.isError
              ? (carriers.error as Error).message
              : !complete
                ? "All three are needed before this lead can be accepted."
                : changed
                  ? "Unsaved changes."
                  : "Saved."}
          </span>
        </div>
      </div>
    </div>
  );
}
