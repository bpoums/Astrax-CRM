import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Pencil, Power } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCarriers } from "@/lib/carriers";
import {
  PLACEMENT_LABEL,
  carriersForImo,
  imosForAgency,
  invalidatePlacement,
  usePlacementLinks,
  usePlacementList,
  type PlacementItem,
  type PlacementKind,
} from "@/lib/placement";
import {
  FilterInput,
  InactiveTag,
  ListBody,
  ListCard,
  ListRow,
  RowAction,
} from "@/components/admin-list";

/**
 * Agencies, IMOs and agents.
 *
 * Carriers stay in their own panel (`CarrierAdmin`); this one adds the other
 * three lists. The Agency -> IMO and IMO -> Carrier mapping (`PlacementMapping`,
 * below) is mounted on the admin Agencies tab. Agents are just a list — they
 * are not mapped to anything. There is no delete — a lead keeps pointing at the
 * agency, IMO and agent it was placed with, so they are deactivated instead.
 */
export function PlacementAdmin() {
  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Agencies, IMOs and agents</h2>
        <span className="text-[0.66rem] text-muted-foreground">
          These feed the Agency, IMO and Agent Name dropdowns under &quot;To Be Filled By
          Validator&quot;.
        </span>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <ItemList kind="agency" />
        <ItemList kind="imo" />
        <ItemList kind="agent" />
      </div>
    </section>
  );
}

type UpsertArgs = {
  p_kind: PlacementKind;
  p_id?: string;
  p_name?: string;
  p_active?: boolean;
  p_sort_order?: number;
  p_npn?: string;
};

function useUpsertItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: UpsertArgs) => {
      const { error } = await supabase.rpc("placement_upsert_item", args);
      if (error) throw error;
    },
    onSuccess: () => invalidatePlacement(queryClient),
    // Duplicate names and the authorisation refusal arrive worded by the RPC.
    onError: (error: Error) => toast.error(error.message),
  });
}

const ORDER_STEP = 10;
/** Lists longer than this get a filter box. */
const FILTER_FROM = 8;

function ItemList({ kind }: { kind: PlacementKind }) {
  const label = PLACEMENT_LABEL[kind];
  const list = usePlacementList(kind);
  const links = usePlacementLinks(kind !== "agent");
  const upsert = useUpsertItem();
  const rows = list.data ?? [];

  const [name, setName] = useState("");
  const [npn, setNpn] = useState("");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftNpn, setDraftNpn] = useState("");

  const busy = upsert.isPending;
  const filtering = query.trim() !== "";
  const visible = filtering
    ? rows.filter((row) => row.name.toLowerCase().includes(query.trim().toLowerCase()))
    : rows;

  /** What each name is connected to, from the same links the mapping edits. */
  function detail(item: PlacementItem): string | null {
    if (kind === "agent" || !links.data) return null;
    if (kind === "agency") {
      const count = imosForAgency(links.data, item.id).size;
      return `${count} ${count === 1 ? "IMO" : "IMOs"}`;
    }
    const count = carriersForImo(links.data, item.id).size;
    return `${count} ${count === 1 ? "carrier" : "carriers"}`;
  }

  function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const args: UpsertArgs = { p_kind: kind, p_name: trimmed };
    if (kind === "agent" && npn.trim()) args.p_npn = npn.trim();
    upsert.mutate(args, {
      onSuccess: () => {
        toast.success(`${label.one} added`);
        setName("");
        setNpn("");
      },
    });
  }

  function saveEdit(item: PlacementItem) {
    const trimmed = draftName.trim();
    if (!trimmed) {
      toast.error(`${label.one} needs a name.`);
      return;
    }
    const args: UpsertArgs = { p_kind: kind, p_id: item.id, p_name: trimmed };
    // An empty string clears the NPN; the RPC treats it as "set to nothing".
    if (kind === "agent") args.p_npn = draftNpn.trim();
    upsert.mutate(args, {
      onSuccess: () => {
        toast.success(`${label.one} saved`);
        setEditingId(null);
      },
    });
  }

  /** Rewrites the sequence as 10, 20, 30… so ties never stop a row moving. */
  async function move(index: number, direction: -1 | 1) {
    const current = rows[index];
    const neighbour = rows[index + direction];
    if (!current || !neighbour) return;
    const next = [...rows];
    next[index] = neighbour;
    next[index + direction] = current;
    for (const [position, item] of next.entries()) {
      const sortOrder = (position + 1) * ORDER_STEP;
      if (item.sort_order === sortOrder) continue;
      await upsert.mutateAsync({ p_kind: kind, p_id: item.id, p_sort_order: sortOrder });
    }
  }

  return (
    <ListCard title={label.many} count={rows.length}>
      <form onSubmit={handleAdd} className="flex items-center gap-1.5">
        <input
          id={`placement-${kind}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="field-input h-8 min-w-0 flex-1 text-xs"
          placeholder={`New ${label.one.toLowerCase()} name`}
          aria-label={`New ${label.one} name`}
        />
        {kind === "agent" ? (
          <input
            id="placement-agent-npn"
            value={npn}
            onChange={(event) => setNpn(event.target.value)}
            className="field-input h-8 w-20 text-xs"
            placeholder="NPN"
            aria-label="New agent NPN (optional)"
          />
        ) : null}
        <button type="submit" className="chip h-8 px-3" disabled={busy || !name.trim()}>
          Add
        </button>
      </form>

      {rows.length > FILTER_FROM ? (
        <FilterInput value={query} onChange={setQuery} label={label.many} />
      ) : null}

      {list.isError ? (
        <p className="text-xs text-destructive">{(list.error as Error).message}</p>
      ) : (
        <ListBody>
          {visible.map((item) => {
            const index = rows.indexOf(item);
            if (editingId === item.id) {
              return (
                <ListRow
                  key={item.id}
                  actions={
                    <>
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => saveEdit(item)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  }
                >
                  <input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    className="field-input h-7 min-w-0 flex-1 text-xs"
                    aria-label={`${label.one} name`}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        saveEdit(item);
                      }
                      if (event.key === "Escape") setEditingId(null);
                    }}
                  />
                  {kind === "agent" ? (
                    <input
                      value={draftNpn}
                      onChange={(event) => setDraftNpn(event.target.value)}
                      className="field-input h-7 w-20 text-xs"
                      aria-label="NPN"
                      placeholder="NPN"
                    />
                  ) : null}
                </ListRow>
              );
            }
            const meta = kind === "agent" ? item.npn : detail(item);
            return (
              <ListRow
                key={item.id}
                muted={!item.active}
                actions={
                  <>
                    <RowAction
                      label={`Move ${item.name} up`}
                      disabled={busy || filtering || index === 0}
                      onClick={() => void move(index, -1)}
                    >
                      <ChevronUp />
                    </RowAction>
                    <RowAction
                      label={`Move ${item.name} down`}
                      disabled={busy || filtering || index === rows.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      <ChevronDown />
                    </RowAction>
                    <RowAction
                      label={`Edit ${item.name}`}
                      disabled={busy}
                      onClick={() => {
                        setEditingId(item.id);
                        setDraftName(item.name);
                        setDraftNpn(item.npn ?? "");
                      }}
                    >
                      <Pencil />
                    </RowAction>
                    <RowAction
                      label={
                        item.active
                          ? `Deactivate ${item.name} — removes it from the dropdowns; leads already placed with it keep it`
                          : `Reactivate ${item.name} — puts it back in the dropdowns`
                      }
                      disabled={busy}
                      onClick={() =>
                        upsert.mutate(
                          { p_kind: kind, p_id: item.id, p_active: !item.active },
                          {
                            onSuccess: () =>
                              toast.success(
                                `${label.one} ${item.active ? "deactivated" : "reactivated"}`,
                              ),
                          },
                        )
                      }
                    >
                      <Power />
                    </RowAction>
                  </>
                }
              >
                <span
                  className={`truncate text-xs ${item.active ? "font-medium" : "line-through"}`}
                >
                  {item.name}
                </span>
                {item.active ? null : <InactiveTag />}
                {meta ? (
                  <span className="shrink-0 text-[0.66rem] tabular-nums text-muted-foreground">
                    {meta}
                  </span>
                ) : null}
              </ListRow>
            );
          })}
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {list.isLoading
                ? "Loading…"
                : filtering
                  ? `No ${label.many.toLowerCase()} match “${query.trim()}”.`
                  : `No ${label.many.toLowerCase()} yet.`}
            </p>
          ) : null}
        </ListBody>
      )}
    </ListCard>
  );
}

type LinkKind = "agency_imo" | "imo_carrier";

function useSetLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      p_kind: LinkKind;
      p_parent: string;
      p_child: string;
      p_active: boolean;
    }) => {
      const { error } = await supabase.rpc("placement_set_link", args);
      if (error) throw error;
    },
    onSuccess: () => invalidatePlacement(queryClient),
    onError: (error: Error) => toast.error(error.message),
  });
}

type Option = { id: string; name: string; active: boolean };

/**
 * The two mappings, each "pick the parent, toggle its children".
 *
 * Inactive children are offered only while they are still linked, so a link to
 * something since retired can be seen and switched off rather than lingering
 * invisibly.
 */
export function PlacementMapping() {
  const agencies = usePlacementList("agency");
  const imos = usePlacementList("imo");
  const carriers = useCarriers(false);
  const links = usePlacementLinks();
  const setLink = useSetLink();

  const [agencyId, setAgencyId] = useState("");
  const [imoId, setImoId] = useState("");

  const error = [agencies, imos, carriers, links].find((query) => query.isError)?.error;

  const imoOptions = imos.data ?? [];
  const carrierOptions = carriers.data ?? [];

  const agencyImoIds = agencyId ? imosForAgency(links.data, agencyId) : new Set<string>();
  const imoCarrierIds = imoId ? carriersForImo(links.data, imoId) : new Set<string>();

  function toggle(kind: LinkKind, parent: string, child: string, active: boolean) {
    setLink.mutate({ p_kind: kind, p_parent: parent, p_child: child, p_active: active });
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="panel-title">Mapping</h2>
      {error ? <p className="text-xs text-destructive">{(error as Error).message}</p> : null}
      <div className="grid gap-3 xl:grid-cols-2">
        <MappingPane
          title="Agency → IMOs"
          parentLabel="agency"
          childLabel="IMOs"
          parents={agencies.data ?? []}
          parentId={agencyId}
          onParent={setAgencyId}
          linkedCount={(id) => imosForAgency(links.data, id).size}
          options={imoOptions.filter((imo) => imo.active || agencyImoIds.has(imo.id))}
          checked={agencyImoIds}
          disabled={setLink.isPending}
          empty="No IMOs yet — add one in Settings."
          onToggle={(child, active) => toggle("agency_imo", agencyId, child, active)}
        />
        <MappingPane
          title="IMO → Carriers"
          parentLabel="IMO"
          childLabel="carriers"
          parents={imoOptions}
          parentId={imoId}
          onParent={setImoId}
          linkedCount={(id) => carriersForImo(links.data, id).size}
          options={carrierOptions.filter((c) => c.active || imoCarrierIds.has(c.id))}
          checked={imoCarrierIds}
          disabled={setLink.isPending}
          empty="No carriers — add them in the Settings Carriers panel."
          onToggle={(child, active) => toggle("imo_carrier", imoId, child, active)}
        />
      </div>
    </div>
  );
}

/**
 * Parents down the left, the selected parent's children as toggles on the
 * right: a linked child is a lit pill, so what a parent is connected to reads
 * at a glance instead of from a column of ticked boxes.
 */
function MappingPane({
  title,
  parentLabel,
  childLabel,
  parents,
  parentId,
  onParent,
  linkedCount,
  options,
  checked,
  disabled,
  empty,
  onToggle,
}: {
  title: string;
  parentLabel: string;
  childLabel: string;
  parents: Option[];
  parentId: string;
  onParent: (id: string) => void;
  linkedCount: (id: string) => number;
  options: Option[];
  checked: Set<string>;
  disabled: boolean;
  empty: string;
  onToggle: (child: string, active: boolean) => void;
}) {
  const selected = parents.find((parent) => parent.id === parentId);
  const linked = options.filter((option) => checked.has(option.id)).length;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card/30 p-3">
      <span className="font-display text-sm font-semibold">{title}</span>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div
          role="listbox"
          aria-label={`Choose an ${parentLabel}`}
          className="no-scrollbar flex max-h-64 flex-col gap-0.5 overflow-y-auto sm:border-r sm:border-border sm:pr-3"
        >
          {parents.map((parent) => (
            <button
              key={parent.id}
              type="button"
              role="option"
              aria-selected={parent.id === parentId}
              onClick={() => onParent(parent.id)}
              className={`flex items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                parent.id === parentId
                  ? "bg-accent/15 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/5 hover:text-foreground"
              } ${parent.active ? "" : "line-through"}`}
            >
              <span className="truncate">{parent.name}</span>
              <span className="shrink-0 text-[0.66rem] tabular-nums">{linkedCount(parent.id)}</span>
            </button>
          ))}
          {parents.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">None yet.</p>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          {selected ? (
            <>
              <span className="text-[0.66rem] text-muted-foreground">
                <span className="font-medium text-foreground">{selected.name}</span> — {linked} of{" "}
                {options.length} {childLabel} linked. Click to link or unlink.
              </span>
              {options.length === 0 ? (
                <p className="text-xs text-muted-foreground">{empty}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {options.map((option) => {
                    const on = checked.has(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={on}
                        disabled={disabled}
                        onClick={() => onToggle(option.id, !on)}
                        className={`chip px-2.5 py-1 text-xs ${on ? "chip-active" : ""} ${
                          option.active ? "" : "line-through"
                        }`}
                      >
                        {option.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <p className="py-2 text-xs text-muted-foreground">
              Pick an {parentLabel} to see and change its {childLabel}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
