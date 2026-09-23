import { useEffect, useState } from "react";
import { useTransferClients } from "@/lib/transfer-clients";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Which client is this lead being transferred to?
 *
 * The closer's "External Transfer" button opens this instead of submitting.
 * Picking a client is required — `submit_form_parked` raises 'select a client
 * to transfer to' if one somehow reaches it without, and the confirm button is
 * disabled until one is chosen — because an unattributed parked lead is
 * exactly the state Parked Leads was built to stop.
 *
 * This dialog owns no mutation. It hands the chosen id back and the form
 * submits, so there is one submit path and one place that reports success or
 * failure — the form's own header message.
 *
 * Only active clients are offered. A deactivated one stays on every lead
 * already transferred to it (the name is stamped on the row) and simply stops
 * being offerable here.
 */
export function TransferClientDialog({
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  /** The form's own in-flight state, so the dialog cannot be double-fired. */
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (client: { id: string; name: string }) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  // A fresh dialog every time it opens: carrying the last lead's pick over to
  // the next one is how a lead gets transferred to the wrong client.
  useEffect(() => {
    if (open) setSelected(null);
  }, [open]);

  const clients = useTransferClients(true, open);
  const options = clients.data ?? [];
  const chosen = options.find((client) => client.id === selected) ?? null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer to which client?</DialogTitle>
          <DialogDescription>
            The lead is parked against this client instead of going to the manager&apos;s queue. It
            waits in Parked Leads until someone moves it into validation.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1">
          <span className="field-label">Client</span>
          {/* A refused read is not an empty client list: printing "no clients
              configured" over an authorisation error sends the closer to ask
              an admin to fix something that is not broken. */}
          {clients.isError ? (
            <p className="text-xs text-destructive">{(clients.error as Error).message}</p>
          ) : clients.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : options.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No active clients. An admin adds them in Settings.
            </p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {options.map((client) => (
                <label
                  key={client.id}
                  htmlFor={`transfer-client-${client.id}`}
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-accent/5"
                >
                  <input
                    type="radio"
                    id={`transfer-client-${client.id}`}
                    name="transfer-client"
                    className="accent-accent"
                    disabled={busy}
                    checked={selected === client.id}
                    onChange={() => setSelected(client.id)}
                  />
                  <span className="text-xs text-foreground">{client.name}</span>
                </label>
              ))}
            </div>
          )}
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
            className="btn-submit"
            disabled={busy || !chosen}
            onClick={() => {
              if (!chosen) return;
              onConfirm({ id: chosen.id, name: chosen.name });
            }}
          >
            {busy ? "Transferring…" : "Transfer"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
