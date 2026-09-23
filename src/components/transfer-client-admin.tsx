import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  TRANSFER_CLIENTS_KEY,
  useTransferClients,
  type TransferClient,
} from "@/lib/transfer-clients";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The external-transfer client list, managed.
 *
 * There is deliberately no delete, for the same reason there is none on the
 * centre and carrier lists: `submissions.transfer_client_id` points here, and
 * removing a row would either fail on the foreign key or take the Parked Leads
 * tab it groups with it. Deactivating drops a client out of the closer's
 * transfer dialog and leaves every lead already transferred to it untouched.
 *
 * Renaming is safe: each lead carries its own `transfer_client_name`, stamped
 * when it was parked, so a rename moves the label on the picker without
 * rewriting what history says about leads already handed over.
 *
 * The order here is the order of the closer's transfer dialog, which is why
 * reordering is a first-class action rather than a number to guess at. Moving
 * a row rewrites the whole list as 10, 20, 30…, so the sequence stays gap-free
 * however many times it is shuffled.
 *
 * Writes go straight at `transfer_clients`; RLS restricts that to admin.
 */

const ORDER_STEP = 10;

export function TransferClientAdmin() {
  const queryClient = useQueryClient();
  // All of them, not just active — this is where a client is brought back.
  const clients = useTransferClients(false);

  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const rows = clients.data ?? [];

  function refresh() {
    // Both the active and the full list are cached under this prefix, and the
    // closer's transfer dialog reads the active one.
    queryClient.invalidateQueries({ queryKey: TRANSFER_CLIENTS_KEY });
  }

  const create = useMutation({
    mutationFn: async (values: { name: string; sort_order: number }) => {
      const { error } = await supabase.from("transfer_clients").insert(values);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Client added");
      setName("");
      refresh();
    },
    // A duplicate name surfaces here as the unique-constraint message.
    onError: (error: Error) => toast.error(error.message),
  });

  const update = useMutation({
    mutationFn: async (vars: { id: string; values: { name?: string; active?: boolean } }) => {
      const { error } = await supabase
        .from("transfer_clients")
        .update(vars.values)
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setEditingId(null);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  /**
   * Reordering writes the new sequence rather than swapping two values.
   *
   * A swap breaks the moment two clients share a sort_order — they never move
   * past each other, because exchanging equal numbers changes nothing. Writing
   * the whole list resolves any such tie on the first move, and only the rows
   * whose number actually changed are sent.
   */
  const reorder = useMutation({
    mutationFn: async (ordered: TransferClient[]) => {
      const changed = ordered
        .map((client, index) => ({ client, sort_order: (index + 1) * ORDER_STEP }))
        .filter((entry) => entry.client.sort_order !== entry.sort_order);
      for (const entry of changed) {
        const { error } = await supabase
          .from("transfer_clients")
          .update({ sort_order: entry.sort_order })
          .eq("id", entry.client.id);
        if (error) throw error;
      }
    },
    onSuccess: () => refresh(),
    onError: (error: Error) => toast.error(error.message),
  });

  const busy = create.isPending || update.isPending || reorder.isPending;

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate({ name: trimmed, sort_order: nextSortOrder(rows) });
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    const current = rows[index];
    const neighbour = rows[target];
    if (!current || !neighbour) return;
    const next = [...rows];
    next[index] = neighbour;
    next[target] = current;
    reorder.mutate(next);
  }

  function saveEdit(id: string) {
    const trimmed = draft.trim();
    if (!trimmed) {
      toast.error("A client needs a name.");
      return;
    }
    update.mutate(
      { id, values: { name: trimmed } },
      { onSuccess: () => toast.success("Client updated") },
    );
  }

  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Transfer Clients ({rows.length})</h2>
        <span className="text-[0.66rem] text-muted-foreground">
          Active clients, in this order, are what External Transfer offers a closer.
        </span>
      </div>

      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
          <label htmlFor="transfer-client-name" className="field-label">
            Client name<span className="text-accent"> *</span>
          </label>
          <input
            id="transfer-client-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="field-input"
            placeholder="Acme Insurance"
            required
          />
        </div>
        <button type="submit" className="btn-submit" disabled={busy || !name.trim()}>
          {create.isPending ? "Adding…" : "Add client"}
        </button>
      </form>

      <p className="text-[0.66rem] text-muted-foreground">
        A client cannot be deleted — parked leads point at it. Deactivating takes it out of the
        closer&apos;s transfer dialog and changes nothing about the leads already transferred to it.
        Renaming is safe: each lead keeps the client name it was parked under.
      </p>

      {clients.isError ? (
        <p className="text-xs text-destructive">{(clients.error as Error).message}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead className="w-20 text-right">Order</TableHead>
              <TableHead className="w-20">Active</TableHead>
              <TableHead className="w-56 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((client, index) =>
              editingId === client.id ? (
                <TableRow key={client.id}>
                  <TableCell>
                    <input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      className="field-input"
                      aria-label="Client name"
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          saveEdit(client.id);
                        }
                        if (event.key === "Escape") setEditingId(null);
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {client.sort_order}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {client.active ? "Yes" : "No"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => saveEdit(client.id)}
                      >
                        {update.isPending ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={client.id}>
                  <TableCell className={client.active ? "font-medium" : "font-medium opacity-50"}>
                    {client.name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {client.sort_order}
                  </TableCell>
                  <TableCell
                    className={client.active ? "text-muted-foreground" : "text-destructive"}
                  >
                    {client.active ? "Yes" : "No"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem]"
                        disabled={busy || index === 0}
                        aria-label={`Move ${client.name} up`}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem]"
                        disabled={busy || index === rows.length - 1}
                        aria-label={`Move ${client.name} down`}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(client.id);
                          setDraft(client.name);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem] text-muted-foreground"
                        disabled={busy}
                        title={
                          client.active
                            ? "Takes it out of the closer's transfer dialog; leads already on it are untouched"
                            : "Puts it back in the closer's transfer dialog"
                        }
                        onClick={() =>
                          update.mutate(
                            { id: client.id, values: { active: !client.active } },
                            {
                              onSuccess: () =>
                                toast.success(
                                  client.active ? "Client deactivated" : "Client reactivated",
                                ),
                            },
                          )
                        }
                      >
                        {client.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ),
            )}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {clients.isLoading ? "Loading…" : "No clients yet."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function nextSortOrder(clients: TransferClient[]) {
  return clients.reduce((max, client) => Math.max(max, client.sort_order), 0) + ORDER_STEP;
}
