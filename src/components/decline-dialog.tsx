import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  invalidateCarrierDeclines,
  isDeclinedBy,
  useCarriers,
  useDeclinedCarriers,
} from "@/lib/carriers";
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

/**
 * Declining a lead, one carrier at a time — or several at once.
 *
 * A decline used to be a single click on `dispose_submission`. It is now a
 * record of WHO refused the lead, because the manager who picks it up next
 * needs to know which carriers are already exhausted. `decline_with_carriers`
 * writes those rows and disposes the lead in one call; the outcome and the
 * return to the manager's queue are unchanged.
 *
 * Nothing is pre-checked. A carrier that has already declined this lead is
 * shown struck through and cannot be picked again — recording the same refusal
 * twice would inflate its decline count and tell the next reader nothing.
 *
 * At least one carrier is required. The button is disabled until one is
 * chosen, but the RPC is what actually enforces it and raises 'select at least
 * one carrier'; that message is surfaced as-is rather than replaced.
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
  const [reason, setReason] = useState("");

  const carriers = useCarriers(true, !!submissionId);
  const declined = useDeclinedCarriers(submissionId);

  // A fresh dialog every time it opens: carrying a previous lead's ticks over
  // to the next one is how a carrier gets recorded against the wrong lead.
  useEffect(() => {
    if (!submissionId) return;
    setSelected([]);
    setReason("");
  }, [submissionId]);

  const decline = useMutation({
    mutationFn: async (vars: { id: string; carrierIds: string[]; reason: string }) => {
      // p_reason has a SQL-side default, so an empty box omits the key rather
      // than sending null — exactOptionalPropertyTypes rejects the null.
      const { error } = await supabase.rpc(
        "decline_with_carriers",
        vars.reason
          ? { p_sub: vars.id, p_carrier_ids: vars.carrierIds, p_reason: vars.reason }
          : { p_sub: vars.id, p_carrier_ids: vars.carrierIds },
      );
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      toast.success(
        vars.carrierIds.length === 1
          ? "Decline recorded — back to the manager"
          : `${vars.carrierIds.length} declines recorded — back to the manager`,
      );
      invalidateCarrierDeclines(queryClient);
      onOpenChange(false);
      onDeclined?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const alreadyDeclined = declined.data?.declined_carriers ?? [];
  const options = carriers.data ?? [];
  const busy = decline.isPending;

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  }

  return (
    <Dialog open={!!submissionId} onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Which carriers declined?</DialogTitle>
          <DialogDescription>
            {customer} — pick every carrier that refused this lead. It goes back to the manager with
            these recorded against it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="field-label">Carriers</span>
            {/* A refused read is not an empty carrier list: saying "no
                carriers configured" over an authorisation error sends the
                reader to the admin screen to fix something that is not
                broken. */}
            {carriers.isError ? (
              <p className="text-xs text-destructive">{(carriers.error as Error).message}</p>
            ) : carriers.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : options.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No active carriers. An admin adds them in Settings.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {options.map((carrier) => {
                  const spent = isDeclinedBy(alreadyDeclined, carrier.name);
                  return (
                    <label
                      key={carrier.id}
                      htmlFor={`decline-${carrier.id}`}
                      className={`flex items-center gap-2 px-3 py-2 ${
                        spent ? "cursor-default" : "cursor-pointer hover:bg-accent/5"
                      }`}
                    >
                      <Checkbox
                        id={`decline-${carrier.id}`}
                        disabled={spent || busy}
                        checked={selected.includes(carrier.id)}
                        onCheckedChange={(checked) => toggle(carrier.id, checked === true)}
                      />
                      <span
                        className={`text-xs ${
                          spent ? "text-muted-foreground line-through" : "text-foreground"
                        }`}
                      >
                        {carrier.name}
                      </span>
                      {spent ? (
                        <span className="ml-auto text-[0.66rem] text-muted-foreground">
                          already declined
                        </span>
                      ) : null}
                    </label>
                  );
                })}
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
              placeholder="Underwriting, age band, existing policy…"
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
            disabled={busy || selected.length === 0 || !submissionId}
            onClick={() => {
              if (!submissionId) return;
              decline.mutate({
                id: submissionId,
                carrierIds: selected,
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
