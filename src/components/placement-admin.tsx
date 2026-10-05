import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCarriers } from "@/lib/carriers";
import {
  PLACEMENT_LABEL,
  agentsForLink,
  carriersForImo,
  imoCarrierLink,
  imosForAgency,
  invalidatePlacement,
  usePlacementLinks,
  usePlacementList,
  type PlacementItem,
  type PlacementKind,
} from "@/lib/placement";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Agencies, IMOs and agents, and which of them belong together.
 *
 * Carriers stay in their own panel (`CarrierAdmin`); this one adds the other
 * three lists and maps Agency -> IMO, IMO -> Carrier, and agents onto one
 * IMO -> Carrier contract. There is no delete — a lead keeps pointing at the
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
      <PlacementMapping />
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

function ItemList({ kind }: { kind: PlacementKind }) {
  const label = PLACEMENT_LABEL[kind];
  const list = usePlacementList(kind);
  const upsert = useUpsertItem();
  const rows = list.data ?? [];

  const [name, setName] = useState("");
  const [npn, setNpn] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftNpn, setDraftNpn] = useState("");

  const busy = upsert.isPending;

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
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
      <h3 className="field-label">
        {label.many} ({rows.length})
      </h3>
      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
        <input
          id={`placement-${kind}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="field-input min-w-0 flex-1"
          placeholder={`New ${label.one.toLowerCase()} name`}
          aria-label={`New ${label.one} name`}
        />
        {kind === "agent" ? (
          <input
            id="placement-agent-npn"
            value={npn}
            onChange={(event) => setNpn(event.target.value)}
            className="field-input w-24"
            placeholder="NPN"
            aria-label="New agent NPN (optional)"
          />
        ) : null}
        <button type="submit" className="chip" disabled={busy || !name.trim()}>
          Add
        </button>
      </form>

      {list.isError ? (
        <p className="text-xs text-destructive">{(list.error as Error).message}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              {kind === "agent" ? <TableHead className="w-20">NPN</TableHead> : null}
              <TableHead className="w-36 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((item, index) =>
              editingId === item.id ? (
                <TableRow key={item.id}>
                  <TableCell colSpan={kind === "agent" ? 2 : 1}>
                    <div className="flex flex-wrap gap-1.5">
                      <input
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                        className="field-input min-w-0 flex-1"
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
                          className="field-input w-24"
                          aria-label="NPN"
                          placeholder="NPN"
                        />
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
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
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={item.id}>
                  <TableCell
                    className={item.active ? "font-medium" : "text-muted-foreground line-through"}
                  >
                    {item.name}
                  </TableCell>
                  {kind === "agent" ? (
                    <TableCell className="tabular-nums text-muted-foreground">
                      {item.npn ?? "—"}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        className="chip px-1.5 py-0.5 text-[0.66rem]"
                        disabled={busy || index === 0}
                        aria-label={`Move ${item.name} up`}
                        onClick={() => void move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="chip px-1.5 py-0.5 text-[0.66rem]"
                        disabled={busy || index === rows.length - 1}
                        aria-label={`Move ${item.name} down`}
                        onClick={() => void move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem]"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(item.id);
                          setDraftName(item.name);
                          setDraftNpn(item.npn ?? "");
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="chip px-2 py-0.5 text-[0.66rem] text-muted-foreground"
                        disabled={busy}
                        title={
                          item.active
                            ? "Removes it from the dropdowns; leads already placed with it keep it"
                            : "Puts it back in the dropdowns"
                        }
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
                        {item.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ),
            )}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={kind === "agent" ? 3 : 2}
                  className="text-center text-muted-foreground"
                >
                  {list.isLoading ? "Loading…" : `No ${label.many.toLowerCase()} yet.`}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

type LinkKind = "agency_imo" | "imo_carrier" | "agent_appointment";

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
 * The three mappings, each "pick the parent, tick its children".
 *
 * Inactive children are offered only while they are still linked, so a link to
 * something since retired can be seen and switched off rather than lingering
 * invisibly.
 */
function PlacementMapping() {
  const agencies = usePlacementList("agency");
  const imos = usePlacementList("imo");
  const agents = usePlacementList("agent");
  const carriers = useCarriers(false);
  const links = usePlacementLinks();
  const setLink = useSetLink();

  const [agencyId, setAgencyId] = useState("");
  const [imoId, setImoId] = useState("");
  const [apptImoId, setApptImoId] = useState("");
  const [apptCarrierId, setApptCarrierId] = useState("");

  const error = [agencies, imos, agents, carriers, links].find((query) => query.isError)?.error;

  const imoOptions = imos.data ?? [];
  const carrierOptions = carriers.data ?? [];
  const agentOptions = agents.data ?? [];

  const agencyImoIds = agencyId ? imosForAgency(links.data, agencyId) : new Set<string>();
  const imoCarrierIds = imoId ? carriersForImo(links.data, imoId) : new Set<string>();
  const apptCarrierIds = apptImoId ? carriersForImo(links.data, apptImoId) : new Set<string>();
  const apptLink =
    apptImoId && apptCarrierId ? imoCarrierLink(links.data, apptImoId, apptCarrierId) : undefined;
  const appointedIds =
    apptLink && apptLink.active ? agentsForLink(links.data, apptLink.id) : new Set<string>();

  function toggle(kind: LinkKind, parent: string, child: string, active: boolean) {
    setLink.mutate({ p_kind: kind, p_parent: parent, p_child: child, p_active: active });
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="panel-title">Mapping</h3>
      {error ? <p className="text-xs text-destructive">{(error as Error).message}</p> : null}
      <div className="grid gap-3 lg:grid-cols-3">
        <MappingBox title="Agency → IMOs">
          <ParentSelect
            label="Agency"
            value={agencyId}
            onChange={setAgencyId}
            options={(agencies.data ?? []).filter((a) => a.active || a.id === agencyId)}
          />
          {agencyId ? (
            <ChildChecklist
              idPrefix="agency-imo"
              options={imoOptions.filter((imo) => imo.active || agencyImoIds.has(imo.id))}
              checked={agencyImoIds}
              disabled={setLink.isPending}
              empty="No IMOs yet — add one above."
              onToggle={(child, active) => toggle("agency_imo", agencyId, child, active)}
            />
          ) : null}
        </MappingBox>

        <MappingBox title="IMO → Carriers">
          <ParentSelect
            label="IMO"
            value={imoId}
            onChange={setImoId}
            options={imoOptions.filter((imo) => imo.active || imo.id === imoId)}
          />
          {imoId ? (
            <ChildChecklist
              idPrefix="imo-carrier"
              options={carrierOptions.filter((c) => c.active || imoCarrierIds.has(c.id))}
              checked={imoCarrierIds}
              disabled={setLink.isPending}
              empty="No carriers — add them in the Carriers panel."
              onToggle={(child, active) => toggle("imo_carrier", imoId, child, active)}
            />
          ) : null}
        </MappingBox>

        <MappingBox title="Agent appointments (IMO + carrier)">
          <ParentSelect
            label="IMO"
            value={apptImoId}
            onChange={(value) => {
              setApptImoId(value);
              setApptCarrierId("");
            }}
            options={imoOptions.filter((imo) => imo.active || imo.id === apptImoId)}
          />
          {apptImoId ? (
            <ParentSelect
              label="Carrier"
              value={apptCarrierId}
              onChange={setApptCarrierId}
              options={carrierOptions.filter((c) => apptCarrierIds.has(c.id))}
              placeholder={
                apptCarrierIds.size === 0 ? "Map carriers to this IMO first" : "Select a carrier…"
              }
            />
          ) : null}
          {apptLink && apptLink.active ? (
            <ChildChecklist
              idPrefix="agent-appt"
              options={agentOptions.filter((agent) => agent.active || appointedIds.has(agent.id))}
              checked={appointedIds}
              disabled={setLink.isPending}
              empty="No agents yet — add one above."
              onToggle={(child, active) => toggle("agent_appointment", apptLink.id, child, active)}
            />
          ) : null}
        </MappingBox>
      </div>
    </div>
  );
}

function MappingBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
      <span className="field-label">{title}</span>
      {children}
    </div>
  );
}

function ParentSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs" aria-label={label}>
        <SelectValue placeholder={placeholder ?? `Select ${label.toLowerCase()}…`} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id} className="text-xs">
            {option.name}
            {option.active ? "" : " (inactive)"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChildChecklist({
  idPrefix,
  options,
  checked,
  disabled,
  empty,
  onToggle,
}: {
  idPrefix: string;
  options: Option[];
  checked: Set<string>;
  disabled: boolean;
  empty: string;
  onToggle: (child: string, active: boolean) => void;
}) {
  if (options.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {options.map((option) => (
        <label
          key={option.id}
          htmlFor={`${idPrefix}-${option.id}`}
          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-accent/5"
        >
          <Checkbox
            id={`${idPrefix}-${option.id}`}
            checked={checked.has(option.id)}
            disabled={disabled}
            onCheckedChange={(value) => onToggle(option.id, value === true)}
          />
          <span className={`text-xs ${option.active ? "" : "text-muted-foreground line-through"}`}>
            {option.name}
          </span>
        </label>
      ))}
    </div>
  );
}
