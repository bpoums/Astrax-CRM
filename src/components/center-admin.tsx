import { useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  CENTER_COLORS,
  CENTERS_KEY,
  useCenters,
  type Center,
  type CenterColor,
} from "@/lib/centers";
import { CENTER_COLOR_HEX, CenterBadge } from "@/components/ops";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The centre list, managed.
 *
 * There is deliberately no delete, for the same reason there is none on the
 * carrier list and then some: `profiles.center_id` and `submissions.center_id`
 * both point here, and a closing manager's entire queue is scoped by the first
 * of them. Removing a row would either fail on the foreign key or take a
 * desk's access with it. Deactivating drops a centre out of the pickers and
 * leaves every person and every lead already attached to it exactly as they
 * stand.
 *
 * Renaming is safe in a way it is not for carriers: each lead carries its own
 * `center_name`, stamped when it was submitted, so a rename moves the label on
 * the picker without rewriting what history says about leads already taken.
 *
 * The order here is the order of the Center dropdown in Add User, which is why
 * reordering is a first-class action rather than a number to guess at. Moving
 * a row rewrites the whole list as 10, 20, 30…, so the sequence stays gap-free
 * however many times it is shuffled.
 *
 * Writes go straight at `centers`; RLS restricts that to admin.
 */

const ORDER_STEP = 10;

export function CenterAdmin() {
  const queryClient = useQueryClient();
  // All of them, not just active — this is where a centre is brought back.
  const centers = useCenters(false);

  const [name, setName] = useState("");
  const [color, setColor] = useState<CenterColor>("slate");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftColor, setDraftColor] = useState<CenterColor>("slate");

  const rows = centers.data ?? [];

  function refresh() {
    // Both the active and the full list are cached under this prefix, and the
    // invite form reads the active one.
    queryClient.invalidateQueries({ queryKey: CENTERS_KEY });
  }

  const create = useMutation({
    mutationFn: async (values: { name: string; sort_order: number; color: CenterColor }) => {
      const { error } = await supabase.from("centers").insert(values);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Center added");
      setName("");
      setColor("slate");
      refresh();
    },
    // A duplicate name surfaces here as the unique-constraint message.
    onError: (error: Error) => toast.error(error.message),
  });

  const update = useMutation({
    mutationFn: async (vars: {
      id: string;
      values: { name?: string; active?: boolean; color?: CenterColor };
    }) => {
      const { error } = await supabase.from("centers").update(vars.values).eq("id", vars.id);
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
   * A swap breaks the moment two centres share a sort_order — they never move
   * past each other, because exchanging equal numbers changes nothing. Writing
   * the whole list resolves any such tie on the first move, and only the rows
   * whose number actually changed are sent.
   */
  const reorder = useMutation({
    mutationFn: async (ordered: Center[]) => {
      const changed = ordered
        .map((center, index) => ({ center, sort_order: (index + 1) * ORDER_STEP }))
        .filter((entry) => entry.center.sort_order !== entry.sort_order);
      for (const entry of changed) {
        const { error } = await supabase
          .from("centers")
          .update({ sort_order: entry.sort_order })
          .eq("id", entry.center.id);
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
    create.mutate({ name: trimmed, sort_order: nextSortOrder(rows), color });
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
      toast.error("A center needs a name.");
      return;
    }
    update.mutate(
      { id, values: { name: trimmed, color: draftColor } },
      { onSuccess: () => toast.success("Center updated") },
    );
  }

  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Centers ({rows.length})</h2>
        <span className="text-[0.66rem] text-muted-foreground">
          Active centers, in this order, are what the Add User form offers.
        </span>
      </div>

      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
          <label htmlFor="center-name" className="field-label">
            Center name<span className="text-accent"> *</span>
          </label>
          <input
            id="center-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="field-input"
            placeholder="UMS BPO"
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="field-label">Badge color</span>
          <ColorSwatches value={color} onChange={setColor} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="field-label">Preview</span>
          <CenterBadge name={name.trim() || "Center name"} color={color} />
        </div>
        <button type="submit" className="btn-submit" disabled={busy || !name.trim()}>
          {create.isPending ? "Adding…" : "Add center"}
        </button>
      </form>

      <p className="text-[0.66rem] text-muted-foreground">
        A center cannot be deleted — staff and leads point at it. Deactivating takes it out of the
        Add User dropdown and changes nothing about the people or the leads already attached to it.
        Renaming is safe: each lead keeps the center name it was submitted under.
      </p>

      {centers.isError ? (
        <p className="text-xs text-destructive">{(centers.error as Error).message}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Center</TableHead>
              <TableHead className="w-20 text-right">Order</TableHead>
              <TableHead className="w-20">Active</TableHead>
              <TableHead className="w-56 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((center, index) =>
              editingId === center.id ? (
                <TableRow key={center.id}>
                  <TableCell>
                    <div className="flex flex-col gap-1.5">
                      <input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        className="field-input"
                        aria-label="Center name"
                        autoFocus
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            saveEdit(center.id);
                          }
                          if (event.key === "Escape") setEditingId(null);
                        }}
                      />
                      <ColorSwatches value={draftColor} onChange={setDraftColor} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {center.sort_order}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {center.active ? "Yes" : "No"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => saveEdit(center.id)}
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
                <TableRow key={center.id}>
                  <TableCell className={center.active ? undefined : "opacity-50"}>
                    <CenterBadge name={center.name} color={center.color} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {center.sort_order}
                  </TableCell>
                  <TableCell
                    className={center.active ? "text-muted-foreground" : "text-destructive"}
                  >
                    {center.active ? "Yes" : "No"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem]"
                        disabled={busy || index === 0}
                        aria-label={`Move ${center.name} up`}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem]"
                        disabled={busy || index === rows.length - 1}
                        aria-label={`Move ${center.name} down`}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(center.id);
                          setDraft(center.name);
                          setDraftColor(center.color);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="chip px-2.5 py-0.5 text-[0.66rem] text-muted-foreground"
                        disabled={busy}
                        title={
                          center.active
                            ? "Takes it out of the Add User dropdown; staff and leads already on it are untouched"
                            : "Puts it back in the Add User dropdown"
                        }
                        onClick={() =>
                          update.mutate(
                            { id: center.id, values: { active: !center.active } },
                            {
                              onSuccess: () =>
                                toast.success(
                                  center.active ? "Center deactivated" : "Center reactivated",
                                ),
                            },
                          )
                        }
                      >
                        {center.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ),
            )}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {centers.isLoading ? "Loading…" : "No centers yet."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/**
 * The six fixed swatches, not a free color picker — see `CENTER_COLORS`
 * (`src/lib/centers.ts`) for why the set is closed.
 */
function ColorSwatches({
  value,
  onChange,
}: {
  value: CenterColor;
  onChange: (color: CenterColor) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {CENTER_COLORS.map((option) => (
        <button
          key={option}
          type="button"
          aria-label={option}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`h-6 w-6 rounded-full transition-shadow ${
            value === option ? "ring-2 ring-offset-2 ring-offset-background" : ""
          }`}
          style={{
            backgroundColor: CENTER_COLOR_HEX[option],
            ...(value === option
              ? ({ "--tw-ring-color": CENTER_COLOR_HEX[option] } as CSSProperties)
              : {}),
          }}
        />
      ))}
    </div>
  );
}

function nextSortOrder(centers: Center[]) {
  return centers.reduce((max, center) => Math.max(max, center.sort_order), 0) + ORDER_STEP;
}
