import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { invalidateCarrierDeclines, useCarriers } from "@/lib/carriers";
import {
  invalidatePlacement,
  usePlacementBlocks,
  usePlacementLinks,
  usePlacementList,
} from "@/lib/placement";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type DeclineKind = "carrier_rejected" | "fixable";

const KINDS: Array<{ value: DeclineKind; label: string; hint: string }> = [
  {
    value: "carrier_rejected",
    label: "Carrier rejected",
    hint: "Underwriting, medical, eligibility, age, duplicate with the carrier",
  },
  {
    value: "fixable",
    label: "Fixable issue",
    hint: "Bank, card or account details, premium, identity",
  },
];

/**
 * Declining a lead: which IMO -> carrier contracts it was declined on, and
 * whether the carrier rejected the customer or the problem can be fixed.
 *
 * The kind matters. A carrier rejection blocks this customer from that
 * carrier under every IMO, and puts a warning on every other carrier under that
 * IMO — that is the placement rule. A fixable issue blocks nothing, so the lead
 * can be corrected and sent to the same carrier again. `decline_with_carriers` writes the rows
 * and disposes the lead in one call; the outcome and the return to the
 * manager's queue are unchanged.
 *
 * Nothing is pre-checked. A carrier this customer has already been rejected by
 * is shown struck through. Ticking a carrier under one IMO disables the same
 * carrier under the others — one application per carrier, which the RPC also
 * enforces.
 */
export function DeclineDialog({
  submissionId,
  customer,
  onOpenChange,
  onDeclined,
}: {
  /** The lead being declined, or null when the dialog is closed. */
  submissionId: string | null;
  customer: string;
  onOpenChange: (open: boolean) => void;
  onDeclined?: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [kind, setKind] = useState<DeclineKind | null>(null);
  const [reason, setReason] = useState("");

  const open = !!submissionId;
  const carriers = useCarriers(false, open);
  const imos = usePlacementList("imo", open);
  const links = usePlacementLinks(open);
  const blocks = usePlacementBlocks(submissionId, open);

  // A fresh dialog every time it opens: carrying a previous lead's ticks over
  // to the next one is how a carrier gets recorded against the wrong lead.
  useEffect(() => {
    if (!submissionId) return;
    setSelected([]);
    setKind(null);
    setReason("");
  }, [submissionId]);

  const decline = useMutation({
    mutationFn: async (vars: {
      id: string;
      linkIds: string[];
      kind: DeclineKind;
      reason: string;
    }) => {
      // p_reason has a SQL-side default, so an empty box omits the key rather
      // than sending null — exactOptionalPropertyTypes rejects the null.
      const base = { p_sub: vars.id, p_imo_carrier_ids: vars.linkIds, p_kind: vars.kind };
      const { error } = await supabase.rpc(
        "decline_with_carriers",
        vars.reason ? { ...base, p_reason: vars.reason } : base,
      );
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      toast.success(
        vars.linkIds.length === 1
          ? "Decline recorded — back to the manager"
          : `${vars.linkIds.length} declines recorded — back to the manager`,
      );
      invalidateCarrierDeclines(queryClient);
      void invalidatePlacement(queryClient);
      onOpenChange(false);
      onDeclined?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const loadError = [carriers, imos, links, blocks].find((q) => q.isError)?.error as
    Error | undefined;
  const loading = carriers.isLoading || imos.isLoading || links.isLoading;

  const carrierById = new Map((carriers.data ?? []).map((c) => [c.id, c]));
  const rejectedCarriers = new Set((blocks.data?.rejections ?? []).map((r) => r.carrier_id));
  const activeLinks = (links.data?.imoCarriers ?? []).filter(
    (l) => l.active && carrierById.get(l.carrier_id)?.active,
  );
  const groups = (imos.data ?? [])
    .filter((imo) => imo.active)
    .map((imo) => ({
      imo,
      links: activeLinks
        .filter((l) => l.imo_id === imo.id)
        .sort(
          (a, b) =>
            (carrierById.get(a.carrier_id)?.sort_order ?? 0) -
            (carrierById.get(b.carrier_id)?.sort_order ?? 0),
        ),
    }))
    .filter((group) => group.links.length > 0);

  const linkById = new Map(activeLinks.map((l) => [l.id, l]));
  const tickedCarriers = new Set(selected.map((id) => linkById.get(id)?.carrier_id));
  const busy = decline.isPending;

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Which carriers declined?</DialogTitle>
          <DialogDescription>
            {customer} — pick the IMO and carrier for every application that was declined. The lead
            goes back to the manager with these recorded against it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="field-label">Why was it declined?</span>
            <div className="flex flex-col gap-1.5">
              {KINDS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={busy}
                  aria-pressed={kind === option.value}
                  onClick={() => setKind(option.value)}
                  className={`${kind === option.value ? "chip chip-active" : "chip"} flex flex-col items-start rounded-md text-left`}
                >
                  <span className="text-xs font-medium">{option.label}</span>
                  <span className="text-[0.62rem] text-muted-foreground">{option.hint}</span>
                </button>
              ))}
            </div>
            {kind === "carrier_rejected" ? (
              <p className="text-[0.66rem] text-destructive">
                This customer can no longer be placed with these carriers under any IMO. Other
                carriers under the same IMO are still allowed, with a warning.
              </p>
            ) : kind === "fixable" ? (
              <p className="text-[0.66rem] text-muted-foreground">
                Nothing is blocked — once the issue is fixed, the lead can go to the same carrier
                again.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <span className="field-label">IMO → carrier</span>
            {/* A refused read is not an empty carrier list: saying "nothing
                set up" over an authorisation error sends the reader to the
                admin screen to fix something that is not broken. */}
            {loadError ? (
              <p className="text-xs text-destructive">{loadError.message}</p>
            ) : loading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : groups.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No IMOs with carriers are set up. An admin maps them in Settings.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {groups.map(({ imo, links: imoLinks }) => (
                  <div key={imo.id} className="rounded-md border border-border">
                    <div className="table-head-band field-label px-3 py-1">{imo.name}</div>
                    <div className="divide-y divide-border">
                      {imoLinks.map((link) => {
                        const carrier = carrierById.get(link.carrier_id);
                        const spent = rejectedCarriers.has(link.carrier_id);
                        const takenElsewhere =
                          !selected.includes(link.id) && tickedCarriers.has(link.carrier_id);
                        const off = spent || takenElsewhere;
                        return (
                          <label
                            key={link.id}
                            htmlFor={`decline-${link.id}`}
                            className={`flex items-center gap-2 px-3 py-1.5 ${
                              off ? "cursor-default" : "cursor-pointer hover:bg-accent/5"
                            }`}
                          >
                            <Checkbox
                              id={`decline-${link.id}`}
                              disabled={off || busy}
                              checked={selected.includes(link.id)}
                              onCheckedChange={(checked) => toggle(link.id, checked === true)}
                            />
                            <span
                              className={`text-xs ${
                                spent ? "text-muted-foreground line-through" : "text-foreground"
                              }`}
                            >
                              {carrier?.name ?? "Unknown carrier"}
                            </span>
                            {spent ? (
                              <span className="ml-auto text-[0.66rem] text-muted-foreground">
                                already rejected
                              </span>
                            ) : takenElsewhere ? (
                              <span className="ml-auto text-[0.66rem] text-muted-foreground">
                                ticked under another IMO
                              </span>
                            ) : null}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="decline-reason" className="field-label">
              Reason (optional)
            </label>
            <Textarea
              id="decline-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Underwriting decision, invalid account number…"
              className="field-input min-h-20"
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            className="chip justify-center"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="chip justify-center border-destructive text-destructive"
            disabled={busy || selected.length === 0 || !kind || !submissionId}
            onClick={() => {
              if (!submissionId || !kind) return;
              decline.mutate({
                id: submissionId,
                linkIds: selected,
                kind,
                reason: reason.trim(),
              });
            }}
          >
            {busy
              ? "Recording…"
              : selected.length > 1
                ? `Decline (${selected.length} carriers)`
                : "Decline"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
