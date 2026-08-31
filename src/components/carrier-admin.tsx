import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { CARRIERS_KEY, useCarriers, type Carrier } from "@/lib/carriers";
import { carrierKey } from "@/lib/normalize";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The carrier list, managed.
 *
 * There is deliberately no delete. `carrier_declines` holds foreign keys to
 * these rows, so removing one would either fail or take a lead's decline
 * history with it — and that history is the only reason the feature exists.
 * Deactivating drops a carrier out of the decline dialog and leaves every
 * recorded decline exactly as it stands, still named in the queue badges and
 * still counted in the report.
 *
 * The order here is the order of the checkboxes in the decline dialog, which is
 * why reordering is a first-class action rather than a number to guess at.
 * Moving a row rewrites the whole list as 10, 20, 30…, so the sequence stays
 * gap-free however many times it is shuffled.
 *
 * Aliases are the other half of the job. The closer and validator forms only
 * ever store a canonical name, but uploaded files spell carriers however the
 * source felt like ("GW's", "Trans America"), and the normaliser flags anything
 * it cannot match. Recording a spelling here is what stops that flag coming
 * back on every future file — it changes nothing about the leads already
 * imported.
 *
 * Writes go straight at `carriers`; RLS restricts that to admin. There is no
 * carrier RPC — this is vocabulary, not workflow, and nothing about it needs
 * the ordering guarantees the submission RPCs exist to provide.
 */

const ORDER_STEP = 10;

export function CarrierAdmin() {
  const queryClient = useQueryClient();
  // All of them, not just active — this is where a carrier is brought back.
  const carriers = useCarriers(false);

  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const rows = carriers.data ?? [];

  function refresh() {
    // Both the active and the full list are cached under this prefix, and the
    // decline dialog reads the active one.
    queryClient.invalidateQueries({ queryKey: CARRIERS_KEY });
  }

  const create = useMutation({
    mutationFn: async (values: { name: string; sort_order: number }) => {
      const { error } = await supabase.from("carriers").insert(values);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Carrier added");
      setName("");
      refresh();
    },
    // A duplicate name surfaces here as the unique-constraint message.
    onError: (error: Error) => toast.error(error.message),
  });

  const update = useMutation({
    mutationFn: async (vars: {
      id: string;
      values: { name?: string; active?: boolean; aliases?: string[] };
    }) => {
      const { error } = await supabase.from("carriers").update(vars.values).eq("id", vars.id);
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
   * A swap breaks the moment two carriers share a sort_order — they never move
   * past each other, because exchanging equal numbers changes nothing. Writing
   * the whole list resolves any such tie on the first move, and only the rows
   * whose number actually changed are sent.
   */
  const reorder = useMutation({
    mutationFn: async (ordered: Carrier[]) => {
      const changed = ordered
        .map((carrier, index) => ({ carrier, sort_order: (index + 1) * ORDER_STEP }))
        .filter((entry) => entry.carrier.sort_order !== entry.sort_order);
      for (const entry of changed) {
        const { error } = await supabase
          .from("carriers")
          .update({ sort_order: entry.sort_order })
          .eq("id", entry.carrier.id);
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

  /**
   * Aliases are matched with punctuation and case stripped, so "GW's" and "gws"
   * are the same entry — and one equal to the carrier's own name adds nothing,
   * because the name always matches itself. Both are refused rather than stored
   * as a duplicate nobody can tell apart in the list.
   */
  function addAlias(carrier: Carrier, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = carrierKey(trimmed);
    if (!key) {
      toast.error("That spelling has no letters or digits in it.");
      return;
    }
    if (key === carrierKey(carrier.name)) {
      toast.error(`"${trimmed}" already matches ${carrier.name} on its own.`);
      return;
    }
    if ((carrier.aliases ?? []).some((alias) => carrierKey(alias) === key)) {
      toast.error(`${carrier.name} already has that spelling.`);
      return;
    }
    update.mutate(
      { id: carrier.id, values: { aliases: [...(carrier.aliases ?? []), trimmed] } },
      { onSuccess: () => toast.success(`"${trimmed}" now matches ${carrier.name}`) },
    );
  }

  function removeAlias(carrier: Carrier, alias: string) {
    update.mutate({
      id: carrier.id,
      values: { aliases: (carrier.aliases ?? []).filter((entry) => entry !== alias) },
    });
  }

  function saveEdit(id: string) {
    const trimmed = draft.trim();
    if (!trimmed) {
      toast.error("A carrier needs a name.");
      return;
    }
    update.mutate(
      { id, values: { name: trimmed } },
      { onSuccess: () => toast.success("Carrier renamed") },
    );
  }

  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Carriers ({rows.length})</h2>
        <span className="text-[0.66rem] text-muted-foreground">
          Active carriers, in this order, are what the forms and the decline dialog offer.
        </span>
      </div>

      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
          <label htmlFor="carrier-name" className="field-label">
            Carrier name<span className="text-accent"> *</span>
          </label>
          <input
            id="carrier-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="field-input"
            placeholder="TransAmerica"
            required
          />
        </div>
        <button type="submit" className="btn-submit" disabled={busy || !name.trim()}>
          {create.isPending ? "Adding…" : "Add carrier"}
        </button>
      </form>

      <p className="text-[0.66rem] text-muted-foreground">
        A spelling listed against a carrier is one the uploaded files use for it. The importer
        matches on them — punctuation and capitals are ignored, so &quot;GW&apos;s&quot; already
        matches &quot;GWS&quot; — and adding one here stops the importer flagging that spelling from
        the next file on. Existing leads keep whatever carrier name they were saved with.
      </p>

      {carriers.isError ? (
        <p className="text-xs text-destructive">{(carriers.error as Error).message}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Carrier</TableHead>
              <TableHead>Spellings seen in uploaded files</TableHead>
              <TableHead className="w-20 text-right">Order</TableHead>
              <TableHead className="w-20">Active</TableHead>
              <TableHead className="w-64 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((carrier, index) =>
              editingId === carrier.id ? (
                <TableRow key={carrier.id}>
                  <TableCell>
                    <input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      className="field-input"
                      aria-label="Carrier name"
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          saveEdit(carrier.id);
                        }
                        if (event.key === "Escape") setEditingId(null);
                      }}
                    />
                    {/* The warning belongs beside the action, not in a help
                        panel nobody opens — this is the moment it matters. */}
                    <p className="mt-1 text-[0.66rem] text-destructive">
                      Renaming starts a NEW Google Sheet tab from the next submission on: the Apps
                      Script names the tab from the Agency value stored on each lead. Leads already
                      submitted keep the old name and stay on the old tab.
                    </p>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <AliasChips carrier={carrier} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {carrier.sort_order}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {carrier.active ? "Yes" : "No"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => saveEdit(carrier.id)}
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
                <TableRow key={carrier.id}>
                  <TableCell className={carrier.active ? "font-medium" : "text-muted-foreground"}>
                    {carrier.name}
                  </TableCell>
                  <TableCell>
                    <AliasEditor
                      carrier={carrier}
                      busy={busy}
                      onAdd={(value) => addAlias(carrier, value)}
                      onRemove={(alias) => removeAlias(carrier, alias)}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {carrier.sort_order}
                  </TableCell>
                  <TableCell
                    className={carrier.active ? "text-muted-foreground" : "text-destructive"}
                  >
                    {carrier.active ? "Yes" : "No"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem]"
                        disabled={busy || index === 0}
                        aria-label={`Move ${carrier.name} up`}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem]"
                        disabled={busy || index === rows.length - 1}
                        aria-label={`Move ${carrier.name} down`}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(carrier.id);
                          setDraft(carrier.name);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem] text-muted-foreground"
                        disabled={busy}
                        title={
                          carrier.active
                            ? "Takes it out of the decline dialog; declines already recorded against it are untouched"
                            : "Puts it back in the decline dialog"
                        }
                        onClick={() =>
                          update.mutate(
                            { id: carrier.id, values: { active: !carrier.active } },
                            {
                              onSuccess: () =>
                                toast.success(
                                  carrier.active ? "Carrier deactivated" : "Carrier reactivated",
                                ),
                            },
                          )
                        }
                      >
                        {carrier.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ),
            )}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  {carriers.isLoading ? "Loading…" : "No carriers yet."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** Read-only, for the row being renamed — one editable thing at a time. */
function AliasChips({ carrier }: { carrier: Carrier }) {
  const aliases = carrier.aliases ?? [];
  if (aliases.length === 0) return <span className="text-[0.66rem]">—</span>;
  return <span className="text-[0.66rem]">{aliases.join(", ")}</span>;
}

/**
 * One carrier's alternate spellings: remove with the ×, add by typing.
 *
 * Each edit writes immediately rather than collecting into a draft — there is
 * nothing to weigh up about a spelling, and a Save button on every row of a
 * list this dense is more to click than the change is worth.
 */
function AliasEditor({
  carrier,
  busy,
  onAdd,
  onRemove,
}: {
  carrier: Carrier;
  busy: boolean;
  onAdd: (value: string) => void;
  onRemove: (alias: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const aliases = carrier.aliases ?? [];

  function submit() {
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {aliases.map((alias) => (
        <span
          key={alias}
          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[0.66rem] text-muted-foreground"
        >
          {alias}
          <button
            type="button"
            disabled={busy}
            aria-label={`Remove the spelling ${alias} from ${carrier.name}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(alias)}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") setDraft("");
        }}
        onBlur={submit}
        disabled={busy}
        aria-label={`Add a spelling for ${carrier.name}`}
        placeholder="add spelling…"
        className="field-input h-6 w-28 px-2 py-0 text-[0.66rem]"
      />
    </div>
  );
}

function nextSortOrder(carriers: Carrier[]) {
  return carriers.reduce((max, carrier) => Math.max(max, carrier.sort_order), 0) + ORDER_STEP;
}
