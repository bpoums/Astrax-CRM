import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { StatusChip } from "@/components/cx-status-cell";
import {
  CATEGORY_LABEL,
  CX_CATEGORIES,
  CX_STATUS_OPTIONS_KEY,
  STATUS_TONES,
  TONE_LABEL,
  useCxStatusOptions,
  type CxCategory,
  type CxStatusOption,
  type StatusTone,
} from "@/lib/cx-status";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The CX status vocabulary, managed.
 *
 * There is deliberately no delete. `cx_lead_status` holds foreign keys to these
 * rows, so removing one would either fail or strip the status off every lead
 * carrying it — losing work that has already been done. Deactivating takes an
 * option out of the dropdowns and leaves those leads exactly as they are.
 *
 * `category` and `code` are fixed after creation: the code is what the pipeline
 * filters on and what the timeline recorded for every past change, so editing
 * it would rewrite history. Label, tone and sort order are all presentation and
 * are free to change.
 *
 * Writes go straight at `cx_status_options`; RLS restricts that to admin and cxm.
 */

type Draft = { label: string; tone: StatusTone; sort_order: string };

/** Codes are uppercase snake case, matching the seeded vocabulary. */
function toCode(label: string) {
  return label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function CxStatusAdmin() {
  const queryClient = useQueryClient();
  // All of them, not just active — this is where an option is brought back.
  const vocabulary = useCxStatusOptions(false);
  const byCategory = vocabulary.byCategory;

  const [category, setCategory] = useState<CxCategory>("policy");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [tone, setTone] = useState<StatusTone>("muted");
  const [sortOrder, setSortOrder] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ label: "", tone: "muted", sort_order: "" });

  function refresh() {
    // Both the active and the full list are cached under this prefix, and the
    // pipeline reads the active one.
    queryClient.invalidateQueries({ queryKey: CX_STATUS_OPTIONS_KEY });
  }

  const create = useMutation({
    mutationFn: async (values: {
      category: CxCategory;
      code: string;
      label: string;
      tone: StatusTone;
      sort_order: number;
    }) => {
      const { error } = await supabase.from("cx_status_options").insert(values);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Status option created");
      setLabel("");
      setCode("");
      setTone("muted");
      setSortOrder("");
      refresh();
    },
    // UNIQUE (category, code) surfaces here as a duplicate-key message.
    onError: (error: Error) => toast.error(error.message),
  });

  const update = useMutation({
    mutationFn: async (vars: {
      id: string;
      values: { label?: string; tone?: StatusTone; sort_order?: number; active?: boolean };
    }) => {
      const { error } = await supabase
        .from("cx_status_options")
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

  const busy = create.isPending || update.isPending;

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;
    const finalCode = (code.trim() || toCode(trimmedLabel)).toUpperCase();
    if (!finalCode) {
      toast.error("That label does not produce a usable code — enter one explicitly.");
      return;
    }
    create.mutate({
      category,
      code: finalCode,
      label: trimmedLabel,
      tone,
      // Blank means "put it at the end of its category" rather than "first".
      sort_order: sortOrder.trim() ? Number(sortOrder) : nextSortOrder(byCategory[category]),
    });
  }

  function startEditing(option: CxStatusOption) {
    setEditingId(option.id);
    setDraft({ label: option.label, tone: option.tone, sort_order: String(option.sort_order) });
  }

  function saveEdit(id: string) {
    const trimmed = draft.label.trim();
    if (!trimmed) {
      toast.error("A status option needs a label.");
      return;
    }
    const order = Number(draft.sort_order);
    update.mutate(
      {
        id,
        values: {
          label: trimmed,
          tone: draft.tone,
          sort_order: Number.isFinite(order) ? order : 0,
        },
      },
      { onSuccess: () => toast.success("Status option updated") },
    );
  }

  return (
    <section className="panel">
      <h2 className="panel-title">CX status options ({vocabulary.options.length})</h2>

      <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="flex flex-col gap-1">
          <span className="field-label">Category</span>
          <Select value={category} onValueChange={(value) => setCategory(value as CxCategory)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CX_CATEGORIES.map((option) => (
                <SelectItem key={option} value={option} className="text-xs">
                  {CATEGORY_LABEL[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="option-label" className="field-label">
            Label<span className="text-accent"> *</span>
          </label>
          <input
            id="option-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className="field-input"
            required
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="option-code" className="field-label">
            Code
          </label>
          <input
            id="option-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={label.trim() ? toCode(label) : "FROM_LABEL"}
            className="field-input"
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="field-label">Tone</span>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_TONES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTone(option)}
                aria-pressed={tone === option}
                className={tone === option ? "chip chip-active" : "chip"}
              >
                {TONE_LABEL[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="option-order" className="field-label">
            Sort order
          </label>
          <input
            id="option-order"
            type="number"
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
            placeholder={String(nextSortOrder(byCategory[category]))}
            className="field-input"
          />
        </div>

        <div className="sm:col-span-2 lg:col-span-5">
          <button type="submit" className="btn-submit" disabled={busy || !label.trim()}>
            {create.isPending ? "Creating…" : "Add status option"}
          </button>
        </div>
      </form>

      {CX_CATEGORIES.map((group) => (
        <div key={group} className="flex flex-col gap-1">
          <h3 className="panel-title">
            {CATEGORY_LABEL[group]} ({byCategory[group].length})
          </h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Option</TableHead>
                <TableHead className="w-40">Code</TableHead>
                <TableHead className="w-36">Tone</TableHead>
                <TableHead className="w-20 text-right">Order</TableHead>
                <TableHead className="w-20">Active</TableHead>
                <TableHead className="w-52 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byCategory[group].map((option) =>
                editingId === option.id ? (
                  <TableRow key={option.id}>
                    <TableCell>
                      <input
                        value={draft.label}
                        onChange={(event) => setDraft((d) => ({ ...d, label: event.target.value }))}
                        className="field-input"
                        aria-label="Option label"
                        autoFocus
                      />
                    </TableCell>
                    <TableCell className="font-mono text-[0.66rem] text-muted-foreground">
                      {option.code}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={draft.tone}
                        onValueChange={(value) =>
                          setDraft((d) => ({ ...d, tone: value as StatusTone }))
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_TONES.map((value) => (
                            <SelectItem key={value} value={value} className="text-xs">
                              {TONE_LABEL[value]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <input
                        type="number"
                        value={draft.sort_order}
                        onChange={(event) =>
                          setDraft((d) => ({ ...d, sort_order: event.target.value }))
                        }
                        className="field-input text-right"
                        aria-label="Sort order"
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {option.active ? "Yes" : "No"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="chip px-2.5 py-0.5 text-[0.66rem]"
                          disabled={busy}
                          onClick={() => saveEdit(option.id)}
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
                  <TableRow key={option.id}>
                    <TableCell>
                      <span className={option.active ? "" : "opacity-60"}>
                        <StatusChip label={option.label} tone={option.tone} />
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-[0.66rem] text-muted-foreground">
                      {option.code}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {TONE_LABEL[option.tone]}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {option.sort_order}
                    </TableCell>
                    <TableCell
                      className={option.active ? "text-muted-foreground" : "text-destructive"}
                    >
                      {option.active ? "Yes" : "No"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="chip px-2.5 py-0.5 text-[0.66rem]"
                          disabled={busy}
                          onClick={() => startEditing(option)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="chip px-2.5 py-0.5 text-[0.66rem] text-muted-foreground"
                          disabled={busy}
                          title={
                            option.active
                              ? "Hides it from the status dropdowns; leads already carrying it keep it"
                              : "Puts it back in the status dropdowns"
                          }
                          onClick={() =>
                            update.mutate(
                              { id: option.id, values: { active: !option.active } },
                              {
                                onSuccess: () =>
                                  toast.success(
                                    option.active ? "Option deactivated" : "Option reactivated",
                                  ),
                              },
                            )
                          }
                        >
                          {option.active ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              )}
              {byCategory[group].length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {vocabulary.isLoading ? "Loading…" : "No options in this category yet."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      ))}
    </section>
  );
}

function nextSortOrder(options: CxStatusOption[]) {
  return options.reduce((max, option) => Math.max(max, option.sort_order), 0) + 10;
}
