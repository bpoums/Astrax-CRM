import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/lib/auth";
import { invalidateCarrierDeclines, useCarriers } from "@/lib/carriers";
import {
  carriersForImo,
  imoCarrierLink,
  imosForAgency,
  invalidatePlacement,
  placementBlockReason,
  placementWarningReason,
  usePlacementBlocks,
  usePlacementLinks,
  usePlacementList,
  usePlacementRuleEnabled,
} from "@/lib/placement";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * What a validator fills in before a lead can be accepted: where it was
 * placed — Agency, IMO, Final Carrier, Agent — and the policy it became.
 *
 * They are columns on `submissions`, not payload keys. `payload` is what the
 * sheet-sync trigger pushes to Google Sheets and what the closer typed; these
 * are the outcome of the review. The closer's expected carrier stays where it
 * is, in Lead Details above, and nothing here touches it.
 *
 * Each dropdown only offers what the one before it allows (the mapping an
 * admin keeps in Settings), and a carrier this customer may not be placed with
 * is shown disabled with the reason — see `placementBlockReason`. Both are
 * conveniences: `set_validator_fields` re-checks the whole chain and the
 * placement rule, and `dispose_submission` checks again on accept.
 *
 * Two outcomes, not one. The SAME carrier a customer was rejected by is
 * blocked under every IMO. A DIFFERENT carrier under the same IMO as an earlier
 * rejection is allowed but warned about (`placementWarningReason`), and Save
 * stays off until the validator ticks "I understand"; the server enforces the
 * tick too and records it on the lead.
 */

/**
 * Who may see and set these. A closer never reaches a detail sheet at all, and
 * the CX roles' pipeline sheet is about what happened after approval, so
 * neither has any business here.
 */
const ALLOWED_ROLES: AppRole[] = ["manager", "validator", "admin", "general_manager"];

/**
 * Who may let one lead through a blocked carrier. `override_placement_block`
 * checks the same two roles; this only decides who is shown the button. Two
 * roles rather than one so the approvals are shared, not queued on admins.
 */
const OVERRIDE_ROLES: AppRole[] = ["admin", "general_manager"];

/** Who may record a carrier rejection that arrived after the lead was accepted. */
const AFTER_SUBMIT_ROLES: AppRole[] = ["manager", "admin"];

/** The fields, in the order they are shown and named in the blocked message. */
const FIELDS = [
  { key: "agency_id", label: "agency" },
  { key: "imo_id", label: "IMO" },
  { key: "final_carrier_id", label: "final carrier" },
  { key: "agent_id", label: "agent" },
  { key: "policy_number", label: "policy number" },
] as const;

export type ValidatorFieldsRow = {
  id: string;
  status: string;
  /**
   * Null on rows written before the column existed, which are closer
   * submissions — only an explicit 'validator' is exempt.
   */
  submitted_by_role: "closer" | "validator" | null;
  agency_id: string | null;
  imo_id: string | null;
  final_carrier_id: string | null;
  agent_id: string | null;
  /** Typed by hand on leads from before agents were a list; kept as written. */
  agent_name: string | null;
  /** Typed while the placement rule is off; the FKs above are set once it is on. */
  agency_name?: string | null;
  imo_name?: string | null;
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

/**
 * With the placement rule off the lead needs only what the server asks for on
 * accept: agency and IMO (typed), final carrier, agent name (typed) and policy number.
 */
const SIMPLE_FIELDS = [
  { key: "agency_name", label: "agency" },
  { key: "imo_name", label: "IMO" },
  { key: "final_carrier_id", label: "final carrier" },
  { key: "agent_name", label: "agent name" },
  { key: "policy_number", label: "policy number" },
] as const;

function missingFields(row: ValidatorFieldsRow, ruleEnabled: boolean) {
  const fields: ReadonlyArray<{ key: keyof ValidatorFieldsRow; label: string }> = ruleEnabled
    ? FIELDS
    : SIMPLE_FIELDS;
  return fields.filter((field) => !String(row[field.key] ?? "").trim()).map((field) => field.label);
}

/**
 * Why Accept is unavailable, or null when it is available.
 *
 * Decline, Pending and Hold are deliberately NOT consulted against this: a lead
 * that cannot be placed is exactly the one that has no policy number, and
 * gating the way out of it would strand it. A placement-rule conflict is not
 * checked here either — the saved fields already passed it, and the server
 * re-checks on accept and says why if anything changed since.
 */
export function acceptBlockedReason(
  row: ValidatorFieldsRow,
  /** `usePlacementRuleEnabled().data`; unknown (still loading) is read as on. */
  ruleEnabled: boolean | undefined = true,
): string | null {
  if (!isCloserOriginated(row)) return null;
  const missing = missingFields(row, ruleEnabled);
  if (missing.length === 0) return null;
  return `Set the ${listPhrase(missing)} under "To Be Filled By Validator" before accepting.`;
}

type Option = { id: string; name: string; active: boolean };

type ValidatorFieldsProps = {
  row: ValidatorFieldsRow;
  /** Refetch the lead — the Accept gate reads the saved values, not the draft. */
  onSaved?: () => void;
};

/**
 * Picks the editor for the current switch: the full placement chain when the
 * rule is on, the original three fields (carrier, typed agent, policy number)
 * while it is off.
 */
export function ValidatorFields(props: ValidatorFieldsProps) {
  const { profile } = useAuth();
  const allowed =
    !!profile && ALLOWED_ROLES.includes(profile.role) && isCloserOriginated(props.row);
  const rule = usePlacementRuleEnabled(allowed);
  if (!allowed) return null;
  if (rule.isError) return <p className="text-xs text-destructive">{rule.error.message}</p>;
  if (rule.data === undefined) return null;
  return rule.data ? <PlacementFields {...props} /> : <SimpleFields {...props} />;
}

/** The original three fields, used while the placement rule is switched off. */
function SimpleFields({ row, onSaved }: ValidatorFieldsProps) {
  const carriers = useCarriers(false);
  const [agency, setAgency] = useState(row.agency_name ?? "");
  const [imo, setImo] = useState(row.imo_name ?? "");
  const [carrierId, setCarrierId] = useState(row.final_carrier_id ?? "");
  const [agent, setAgent] = useState(row.agent_name ?? "");
  const [policy, setPolicy] = useState(row.policy_number ?? "");

  useEffect(() => {
    setAgency(row.agency_name ?? "");
    setImo(row.imo_name ?? "");
    setCarrierId(row.final_carrier_id ?? "");
    setAgent(row.agent_name ?? "");
    setPolicy(row.policy_number ?? "");
  }, [
    row.id,
    row.agency_name,
    row.imo_name,
    row.final_carrier_id,
    row.agent_name,
    row.policy_number,
  ]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("set_validator_fields", {
        p_sub: row.id,
        p_final_carrier_id: carrierId,
        p_agent_name: agent.trim(),
        p_policy_number: policy.trim(),
        p_agency_name: agency.trim(),
        p_imo_name: imo.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Validator fields saved");
      onSaved?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const options: Option[] = (carriers.data ?? []).filter(
    (c) => c.active || c.id === row.final_carrier_id,
  );
  const complete =
    !!agency.trim() && !!imo.trim() && !!carrierId && !!agent.trim() && !!policy.trim();
  const changed =
    agency.trim() !== (row.agency_name ?? "") ||
    imo.trim() !== (row.imo_name ?? "") ||
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
          <label htmlFor={`agency-${row.id}`} className="field-label">
            Agency
          </label>
          <input
            id={`agency-${row.id}`}
            value={agency}
            disabled={save.isPending}
            onChange={(event) => setAgency(event.target.value)}
            className="field-input"
            autoComplete="off"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`imo-${row.id}`} className="field-label">
            IMO
          </label>
          <input
            id={`imo-${row.id}`}
            value={imo}
            disabled={save.isPending}
            onChange={(event) => setImo(event.target.value)}
            className="field-input"
            autoComplete="off"
          />
        </div>
        <FieldSelect
          label="Final Carrier"
          value={carrierId}
          onChange={setCarrierId}
          options={options}
          disabled={save.isPending}
          placeholder="Select a carrier…"
        />
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
        <div className="flex flex-wrap items-center gap-2">
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
              ? carriers.error.message
              : !complete
                ? "All five are needed before this lead can be accepted."
                : changed
                  ? "Unsaved changes."
                  : "Saved."}
          </span>
        </div>
      </div>
    </div>
  );
}

function PlacementFields({ row, onSaved }: ValidatorFieldsProps) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const allowed = !!profile && ALLOWED_ROLES.includes(profile.role) && isCloserOriginated(row);
  const canOverride = !!profile && OVERRIDE_ROLES.includes(profile.role);
  const closed = row.status === "closed";

  // Inactive rows included everywhere: a lead already placed with something
  // since retired still renders its name rather than a blank trigger.
  const agencies = usePlacementList("agency", allowed);
  const imos = usePlacementList("imo", allowed);
  const agents = usePlacementList("agent", allowed);
  const carriers = useCarriers(false, allowed);
  const links = usePlacementLinks(allowed);
  const blocks = usePlacementBlocks(row.id, allowed);

  const [agencyId, setAgencyId] = useState(row.agency_id ?? "");
  const [imoId, setImoId] = useState(row.imo_id ?? "");
  const [carrierId, setCarrierId] = useState(row.final_carrier_id ?? "");
  const [agentId, setAgentId] = useState(row.agent_id ?? "");
  const [policy, setPolicy] = useState(row.policy_number ?? "");
  const [understood, setUnderstood] = useState(false);

  // Re-seeded when a different lead is opened, and when a refetch brings back
  // what was just saved. Keyed on the stored values rather than on the row
  // object, which is a new reference on every refetch.
  useEffect(() => {
    setAgencyId(row.agency_id ?? "");
    setImoId(row.imo_id ?? "");
    setCarrierId(row.final_carrier_id ?? "");
    setAgentId(row.agent_id ?? "");
    setPolicy(row.policy_number ?? "");
  }, [row.id, row.agency_id, row.imo_id, row.final_carrier_id, row.agent_id, row.policy_number]);

  // The tick belongs to one lead, one IMO and one carrier: changing any of
  // them is a different decision, so it has to be made again.
  useEffect(() => {
    setUnderstood(false);
  }, [row.id, imoId, carrierId]);

  const save = useMutation({
    mutationFn: async (vars: { acknowledge: boolean }) => {
      // p_acknowledge_warning defaults to false in SQL, so it is only sent when
      // ticked — exactOptionalPropertyTypes rejects an explicit undefined.
      const { error } = await supabase.rpc("set_validator_fields", {
        p_sub: row.id,
        p_agency_id: agencyId,
        p_imo_id: imoId,
        p_final_carrier_id: carrierId,
        p_agent_id: agentId,
        p_policy_number: policy.trim(),
        ...(vars.acknowledge ? { p_acknowledge_warning: true } : {}),
      });
      // The RPC raises its own wording — the chain it refused, the placement
      // block or warning with its date, or its authorisation message. Show it
      // as written.
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Validator fields saved");
      onSaved?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!allowed) return null;

  const loadError = [agencies, imos, agents, carriers, links, blocks].find((q) => q.isError)
    ?.error as Error | undefined;

  // What each dropdown may offer. A value the lead already holds stays
  // offered while the choices above it are unchanged, matching the server,
  // which always accepts the lead's own current values.
  const sameAsSaved = {
    agency: agencyId === (row.agency_id ?? ""),
    imo: imoId === (row.imo_id ?? ""),
    carrier: carrierId === (row.final_carrier_id ?? ""),
  };
  const agencyOptions: Option[] = (agencies.data ?? []).filter(
    (a) => a.active || a.id === row.agency_id,
  );
  const linkedImos = imosForAgency(links.data, agencyId);
  const imoOptions: Option[] = (imos.data ?? []).filter(
    (i) => (i.active && linkedImos.has(i.id)) || (i.id === row.imo_id && sameAsSaved.agency),
  );
  const linkedCarriers = carriersForImo(links.data, imoId);
  const carrierOptions: Option[] = (carriers.data ?? []).filter(
    (c) =>
      (c.active && linkedCarriers.has(c.id)) || (c.id === row.final_carrier_id && sameAsSaved.imo),
  );
  // Agents are independent of the chain: every active agent, plus the one the
  // lead already holds even if since retired.
  const agentOptions: Option[] = (agents.data ?? []).filter(
    (a) => a.active || a.id === row.agent_id,
  );

  // A closed lead is history being mapped, not a placement: the server skips
  // the rule for it, so nothing is greyed out here either.
  const reasonFor = (cid: string) =>
    closed ? null : placementBlockReason(blocks.data, imoId, cid);
  const blockedHere = carrierOptions
    .map((c) => ({ carrier: c, reason: reasonFor(c.id) }))
    .filter((entry): entry is { carrier: Option; reason: string } => entry.reason !== null);
  const selectedBlock = carrierId ? reasonFor(carrierId) : null;
  // Same exemption for a closed lead as the block. A carrier that is blocked
  // outright has no warning of its own: the block is the one message.
  const warning =
    closed || selectedBlock || !carrierId
      ? null
      : placementWarningReason(blocks.data, imoId, carrierId);

  // Picking a parent keeps each child that is still valid under it, so moving
  // an old lead onto the new fields does not throw away a carrier that fits.
  function chooseAgency(value: string) {
    setAgencyId(value);
    const imosNow = imosForAgency(links.data, value);
    if (!imosNow.has(imoId)) {
      setImoId("");
      setCarrierId("");
    }
  }
  function chooseImo(value: string) {
    setImoId(value);
    const carriersNow = carriersForImo(links.data, value);
    if (!carriersNow.has(carrierId)) setCarrierId("");
  }

  const complete = !!agencyId && !!imoId && !!carrierId && !!agentId && !!policy.trim();
  const changed =
    agencyId !== (row.agency_id ?? "") ||
    imoId !== (row.imo_id ?? "") ||
    carrierId !== (row.final_carrier_id ?? "") ||
    agentId !== (row.agent_id ?? "") ||
    policy.trim() !== (row.policy_number ?? "");
  const legacyAgent = !row.agent_id && row.agent_name?.trim() ? row.agent_name : null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">To Be Filled By Validator</h3>
        <span className="text-[0.66rem] text-muted-foreground">Required to accept</span>
      </div>

      <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <FieldSelect
            label="Agency"
            value={agencyId}
            onChange={chooseAgency}
            options={agencyOptions}
            disabled={save.isPending}
            placeholder={agencyOptions.length ? "Select an agency…" : "No agencies set up"}
          />
          <FieldSelect
            label="IMO"
            value={imoId}
            onChange={chooseImo}
            options={imoOptions}
            disabled={save.isPending || !agencyId}
            placeholder={
              !agencyId
                ? "Choose the agency first"
                : imoOptions.length
                  ? "Select an IMO…"
                  : "No IMOs mapped to this agency"
            }
          />
          <FieldSelect
            label="Final Carrier"
            value={carrierId}
            onChange={setCarrierId}
            options={carrierOptions}
            disabled={save.isPending || !imoId}
            isBlocked={(id) => reasonFor(id) !== null}
            placeholder={
              !imoId
                ? "Choose the IMO first"
                : carrierOptions.length
                  ? "Select a carrier…"
                  : "No carriers mapped to this IMO"
            }
          />
          <FieldSelect
            label="Agent Name"
            value={agentId}
            onChange={setAgentId}
            options={agentOptions}
            disabled={save.isPending}
            placeholder={agentOptions.length ? "Select an agent…" : "No agents set up"}
          />
        </div>
        {legacyAgent ? (
          <span className="text-[0.62rem] text-muted-foreground">
            Agent typed on this lead before agents were a list: {legacyAgent}
          </span>
        ) : null}
        {row.agency_name?.trim() || row.imo_name?.trim() ? (
          <span className="text-[0.62rem] text-muted-foreground">
            Typed before the mapping: agency {row.agency_name?.trim() || "—"}, IMO{" "}
            {row.imo_name?.trim() || "—"}
          </span>
        ) : null}

        {blockedHere.length > 0 ? (
          <BlockedList
            submissionId={row.id}
            imoId={imoId}
            entries={blockedHere}
            canOverride={canOverride}
          />
        ) : null}
        {selectedBlock ? (
          <p className="text-[0.66rem] text-destructive">Blocked: {selectedBlock}</p>
        ) : null}
        {warning ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-accent/60 p-2">
            <span className="field-label text-accent">Warning</span>
            <p className="text-[0.66rem] text-foreground">{warning}</p>
            <label
              htmlFor={`understood-${row.id}`}
              className="flex cursor-pointer items-center gap-2 text-xs"
            >
              <Checkbox
                id={`understood-${row.id}`}
                checked={understood}
                disabled={save.isPending}
                onCheckedChange={(value) => setUnderstood(value === true)}
              />
              I understand
            </label>
          </div>
        ) : null}

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

        <div className="flex flex-wrap items-center gap-2">
          {/* A chip, not the amber button: the sheet's one emphasis belongs to
              the action that disposes the lead. */}
          <button
            type="button"
            className="chip px-2.5 py-0.5 text-[0.66rem]"
            disabled={
              save.isPending ||
              !complete ||
              !changed ||
              !!selectedBlock ||
              (!!warning && !understood)
            }
            onClick={() => save.mutate({ acknowledge: !!warning && understood })}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <span className="text-[0.62rem] text-muted-foreground">
            {loadError
              ? loadError.message
              : !complete
                ? "All five are needed before this lead can be accepted."
                : warning && !understood && changed
                  ? 'Tick "I understand" to save.'
                  : changed
                    ? "Unsaved changes."
                    : "Saved."}
          </span>
        </div>

        {closed && profile && AFTER_SUBMIT_ROLES.includes(profile.role) ? (
          <AfterSubmitRejection
            row={row}
            onRecorded={() => {
              invalidateCarrierDeclines(queryClient);
              void invalidatePlacement(queryClient);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  placeholder,
  isBlocked,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  disabled: boolean;
  placeholder: string;
  isBlocked?: (id: string) => boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="field-label">{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="h-8 text-xs" aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => {
            const blocked = isBlocked?.(option.id) ?? false;
            return (
              <SelectItem
                key={option.id}
                value={option.id}
                disabled={blocked && option.id !== value}
                className="text-xs"
              >
                {option.name}
                {option.active ? "" : " (inactive)"}
                {blocked ? " — blocked" : ""}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The carriers under the chosen IMO that this customer may not be placed
 * with, each with its reason — the dropdown can only say "blocked". An admin
 * or general manager can let this one lead through one of them; the rejection
 * itself stays.
 */
function BlockedList({
  submissionId,
  imoId,
  entries,
  canOverride,
}: {
  submissionId: string;
  imoId: string;
  entries: Array<{ carrier: Option; reason: string }>;
  canOverride: boolean;
}) {
  const queryClient = useQueryClient();
  const [overriding, setOverriding] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const override = useMutation({
    mutationFn: async (carrierId: string) => {
      const { error } = await supabase.rpc("override_placement_block", {
        p_sub: submissionId,
        p_imo_id: imoId,
        p_carrier_id: carrierId,
        p_reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Override recorded for this lead");
      setOverriding(null);
      setReason("");
      void invalidatePlacement(queryClient);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2">
      <span className="field-label text-destructive">Blocked for this customer</span>
      {entries.map(({ carrier, reason: why }) => (
        <div key={carrier.id} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="min-w-0 flex-1 text-[0.66rem] text-muted-foreground">
              <span className="font-medium text-foreground">{carrier.name}</span> — {why}
            </span>
            {canOverride && overriding !== carrier.id ? (
              <button
                type="button"
                className="chip px-2 py-0.5 text-[0.62rem]"
                onClick={() => {
                  setOverriding(carrier.id);
                  setReason("");
                }}
              >
                Override…
              </button>
            ) : null}
          </div>
          {overriding === carrier.id ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                id={`override-${submissionId}-${carrier.id}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="field-input h-7 min-w-0 flex-1 text-[0.66rem]"
                placeholder="Why this lead may be placed here anyway (required)"
                aria-label={`Reason to override the ${carrier.name} block`}
                autoFocus
              />
              <button
                type="button"
                className="chip px-2 py-0.5 text-[0.62rem]"
                disabled={override.isPending || !reason.trim()}
                onClick={() => override.mutate(carrier.id)}
              >
                {override.isPending ? "Saving…" : "Allow for this lead"}
              </button>
              <button
                type="button"
                className="chip px-2 py-0.5 text-[0.62rem]"
                disabled={override.isPending}
                onClick={() => setOverriding(null)}
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * A carrier that said no after the lead was already accepted — its
 * underwriting came back later. Recorded so the placement rule sees it; the
 * lead's own outcome is not changed.
 */
function AfterSubmitRejection({
  row,
  onRecorded,
}: {
  row: ValidatorFieldsRow;
  onRecorded: () => void;
}) {
  const links = usePlacementLinks();
  const imos = usePlacementList("imo");
  const carriers = useCarriers(false);
  const [open, setOpen] = useState(false);
  const [linkId, setLinkId] = useState("");
  const [reason, setReason] = useState("");

  const ownLink =
    row.imo_id && row.final_carrier_id
      ? imoCarrierLink(links.data, row.imo_id, row.final_carrier_id)
      : undefined;

  const record = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc(
        "record_carrier_rejection",
        reason.trim()
          ? { p_sub: row.id, p_imo_carrier_id: linkId, p_reason: reason.trim() }
          : { p_sub: row.id, p_imo_carrier_id: linkId },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Carrier rejection recorded");
      setOpen(false);
      setReason("");
      onRecorded();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!open) {
    return (
      <button
        type="button"
        className="chip self-start px-2.5 py-0.5 text-[0.66rem] text-muted-foreground"
        onClick={() => {
          setOpen(true);
          setLinkId(ownLink?.id ?? "");
        }}
      >
        Carrier rejected this after Submit…
      </button>
    );
  }

  const imoName = new Map((imos.data ?? []).map((i) => [i.id, i.name]));
  const carrierName = new Map((carriers.data ?? []).map((c) => [c.id, c.name]));
  const options = (links.data?.imoCarriers ?? [])
    .filter((l) => l.active || l.id === ownLink?.id)
    .map((l) => ({
      id: l.id,
      label: `${imoName.get(l.imo_id) ?? "?"} → ${carrierName.get(l.carrier_id) ?? "?"}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2">
      <span className="field-label">Carrier rejected this after Submit</span>
      <span className="text-[0.62rem] text-muted-foreground">
        Records the rejection so this customer can no longer be placed with that carrier, or with
        any carrier under that IMO. The lead stays accepted.
      </span>
      <Select value={linkId} onValueChange={setLinkId} disabled={record.isPending}>
        <SelectTrigger className="h-8 text-xs" aria-label="Which IMO and carrier rejected it">
          <SelectValue placeholder="Which IMO → carrier rejected it?" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id} className="text-xs">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input
        id={`after-submit-reason-${row.id}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className="field-input"
        placeholder="Reason (optional) — e.g. underwriting decision"
        aria-label="Reason for the rejection"
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          className="chip border-destructive px-2.5 py-0.5 text-[0.66rem] text-destructive"
          disabled={record.isPending || !linkId}
          onClick={() => record.mutate()}
        >
          {record.isPending ? "Recording…" : "Record rejection"}
        </button>
        <button
          type="button"
          className="chip px-2.5 py-0.5 text-[0.66rem]"
          disabled={record.isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
