import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCarriers } from "@/lib/carriers";
import { usePlacementLinks, usePlacementList } from "@/lib/placement";

/**
 * Agency -> IMO -> Carrier, drawn as one map.
 *
 * Read-only: the mapping is edited in Settings (`PlacementAdmin`). This is the
 * same data from the same hooks, laid out so that which IMO sits under which
 * agency, and which carriers it is contracted with, can be read without opening
 * a dropdown. IMOs are the middle column because every connection runs through
 * one.
 *
 * Selecting (or hovering) a name lights its whole path — an agency's IMOs and
 * their carriers, or a carrier's IMOs and their agencies — and dims the rest.
 */

type Kind = "agency" | "imo" | "carrier";
type Node = { id: string; name: string; active: boolean };
type Focus = { kind: Kind; id: string };
type Edge = { key: string; from: string; to: string };
type DrawnEdge = Edge & { d: string };

const nodeKey = (kind: Kind, id: string) => `${kind}:${id}`;

function addTo(map: Map<string, Set<string>>, key: string, value: string) {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function union(map: Map<string, Set<string>>, keys: Iterable<string>) {
  const out = new Set<string>();
  for (const key of keys) for (const value of map.get(key) ?? []) out.add(value);
  return out;
}

export function AgencyMap() {
  const agencies = usePlacementList("agency");
  const imos = usePlacementList("imo");
  const carriers = useCarriers(false);
  const links = usePlacementLinks();

  const [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState<Focus | null>(null);
  const [hovered, setHovered] = useState<Focus | null>(null);

  const error = [agencies, imos, carriers, links].find((query) => query.isError)?.error;
  const loading = [agencies, imos, carriers, links].some((query) => query.isLoading);

  const model = useMemo(() => {
    const keep = (rows: Node[]) => rows.filter((row) => showInactive || row.active);
    const agencyNodes = keep(agencies.data ?? []);
    const imoNodes = keep(imos.data ?? []);
    const carrierNodes = keep(carriers.data ?? []);
    const agencyIds = new Set(agencyNodes.map((n) => n.id));
    const imoIds = new Set(imoNodes.map((n) => n.id));
    const carrierIds = new Set(carrierNodes.map((n) => n.id));

    const agencyToImos = new Map<string, Set<string>>();
    const imoToAgencies = new Map<string, Set<string>>();
    const imoToCarriers = new Map<string, Set<string>>();
    const carrierToImos = new Map<string, Set<string>>();
    const agencyImoEdges: Edge[] = [];
    const imoCarrierEdges: Edge[] = [];

    for (const link of links.data?.agencyImos ?? []) {
      if (!link.active || !agencyIds.has(link.agency_id) || !imoIds.has(link.imo_id)) continue;
      addTo(agencyToImos, link.agency_id, link.imo_id);
      addTo(imoToAgencies, link.imo_id, link.agency_id);
      agencyImoEdges.push({
        key: `ai:${link.agency_id}:${link.imo_id}`,
        from: nodeKey("agency", link.agency_id),
        to: nodeKey("imo", link.imo_id),
      });
    }
    for (const link of links.data?.imoCarriers ?? []) {
      if (!link.active || !imoIds.has(link.imo_id) || !carrierIds.has(link.carrier_id)) continue;
      addTo(imoToCarriers, link.imo_id, link.carrier_id);
      addTo(carrierToImos, link.carrier_id, link.imo_id);
      imoCarrierEdges.push({
        key: `ic:${link.imo_id}:${link.carrier_id}`,
        from: nodeKey("imo", link.imo_id),
        to: nodeKey("carrier", link.carrier_id),
      });
    }

    return {
      agencyNodes,
      imoNodes,
      carrierNodes,
      agencyToImos,
      imoToAgencies,
      imoToCarriers,
      carrierToImos,
      edges: [...agencyImoEdges, ...imoCarrierEdges],
      agencyImoCount: agencyImoEdges.length,
      imoCarrierCount: imoCarrierEdges.length,
    };
  }, [agencies.data, imos.data, carriers.data, links.data, showInactive]);

  const focus = hovered ?? selected;

  /** Everything on the focused node's path, or null when nothing is focused. */
  const lit = useMemo(() => {
    if (!focus) return null;
    const { agencyToImos, imoToAgencies, imoToCarriers, carrierToImos } = model;
    let agencySet: Set<string>;
    let imoSet: Set<string>;
    let carrierSet: Set<string>;
    if (focus.kind === "agency") {
      agencySet = new Set([focus.id]);
      imoSet = new Set(agencyToImos.get(focus.id) ?? []);
      carrierSet = union(imoToCarriers, imoSet);
    } else if (focus.kind === "imo") {
      imoSet = new Set([focus.id]);
      agencySet = new Set(imoToAgencies.get(focus.id) ?? []);
      carrierSet = new Set(imoToCarriers.get(focus.id) ?? []);
    } else {
      carrierSet = new Set([focus.id]);
      imoSet = new Set(carrierToImos.get(focus.id) ?? []);
      agencySet = union(imoToAgencies, imoSet);
    }
    const keys = new Set<string>();
    for (const id of agencySet) keys.add(nodeKey("agency", id));
    for (const id of imoSet) keys.add(nodeKey("imo", id));
    for (const id of carrierSet) keys.add(nodeKey("carrier", id));
    return keys;
  }, [focus, model]);

  // --- Measuring the nodes so the curves can be drawn between them ----------
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [drawn, setDrawn] = useState<DrawnEdge[]>([]);

  const setNodeRef = useCallback((key: string, element: HTMLElement | null) => {
    if (element) nodeRefs.current.set(key, element);
    else nodeRefs.current.delete(key);
  }, []);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const origin = container.getBoundingClientRect();
    const next: DrawnEdge[] = [];
    for (const edge of model.edges) {
      const a = nodeRefs.current.get(edge.from)?.getBoundingClientRect();
      const b = nodeRefs.current.get(edge.to)?.getBoundingClientRect();
      if (!a || !b) continue;
      const x1 = a.right - origin.left;
      const y1 = a.top + a.height / 2 - origin.top;
      const x2 = b.left - origin.left;
      const y2 = b.top + b.height / 2 - origin.top;
      const mid = (x1 + x2) / 2;
      next.push({ ...edge, d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` });
    }
    setDrawn(next);
  }, [model.edges]);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  if (error) {
    return (
      <section className="panel">
        <h2 className="panel-title">Agencies</h2>
        <p className="text-xs text-destructive">{(error as Error).message}</p>
      </section>
    );
  }

  const toggle = (kind: Kind, id: string) =>
    setSelected((current) => (current?.kind === kind && current.id === id ? null : { kind, id }));

  const nodeProps = (kind: Kind, node: Node, detail: string, empty: boolean) => {
    const key = nodeKey(kind, node.id);
    const isLit = lit ? lit.has(key) : false;
    const isSelected = selected?.kind === kind && selected.id === node.id;
    return {
      node,
      detail,
      empty,
      dimmed: lit ? !isLit : false,
      lit: isLit,
      selected: isSelected,
      setRef: (element: HTMLElement | null) => setNodeRef(key, element),
      onToggle: () => toggle(kind, node.id),
      onEnter: () => setHovered({ kind, id: node.id }),
      onLeave: () => setHovered(null),
    };
  };

  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;

  return (
    <section className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-title">Agency → IMO → Carrier</h2>
        <div className="flex items-center gap-1.5">
          {selected ? (
            <button
              type="button"
              className="chip px-2.5 py-0.5 text-[0.66rem]"
              onClick={() => setSelected(null)}
            >
              Clear selection
            </button>
          ) : null}
          <button
            type="button"
            aria-pressed={showInactive}
            onClick={() => setShowInactive((value) => !value)}
            className={`chip px-2.5 py-0.5 text-[0.66rem] ${showInactive ? "chip-active" : ""}`}
          >
            Show inactive
          </button>
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        <Stat label="Agencies" value={model.agencyNodes.length} />
        <Stat label="IMOs" value={model.imoNodes.length} />
        <Stat label="Carriers" value={model.carrierNodes.length} />
        <Stat label="Agency–IMO links" value={model.agencyImoCount} />
        <Stat label="IMO–carrier links" value={model.imoCarrierCount} />
      </dl>

      <p className="text-[0.66rem] text-muted-foreground">
        Select a name to trace its connections. Edit the mapping under Settings.
      </p>

      {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}

      {/* Wide screens: the map. */}
      <div ref={containerRef} className="relative hidden py-1 lg:block">
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        >
          {drawn.map((edge) => {
            const on = lit ? lit.has(edge.from) && lit.has(edge.to) : false;
            return (
              <path
                key={edge.key}
                d={edge.d}
                fill="none"
                strokeWidth={on ? 2 : 1.25}
                className={`transition-[opacity,stroke] duration-150 ${
                  on ? "stroke-accent" : "stroke-border"
                } ${lit && !on ? "opacity-20" : ""}`}
              />
            );
          })}
        </svg>

        <div className="relative z-10 grid grid-cols-3 gap-x-24">
          <Column title="Agencies" count={model.agencyNodes.length}>
            {model.agencyNodes.map((node) => {
              const count = model.agencyToImos.get(node.id)?.size ?? 0;
              return (
                <NodeButton
                  key={node.id}
                  {...nodeProps("agency", node, plural(count, "IMO", "IMOs"), count === 0)}
                />
              );
            })}
          </Column>
          <Column title="IMOs" count={model.imoNodes.length}>
            {model.imoNodes.map((node) => {
              const a = model.imoToAgencies.get(node.id)?.size ?? 0;
              const c = model.imoToCarriers.get(node.id)?.size ?? 0;
              return (
                <NodeButton
                  key={node.id}
                  {...nodeProps(
                    "imo",
                    node,
                    `${plural(a, "agency", "agencies")} · ${plural(c, "carrier", "carriers")}`,
                    a === 0 || c === 0,
                  )}
                />
              );
            })}
          </Column>
          <Column title="Carriers" count={model.carrierNodes.length}>
            {model.carrierNodes.map((node) => {
              const count = model.carrierToImos.get(node.id)?.size ?? 0;
              return (
                <NodeButton
                  key={node.id}
                  {...nodeProps("carrier", node, plural(count, "IMO", "IMOs"), count === 0)}
                />
              );
            })}
          </Column>
        </div>
      </div>

      {/* Narrow screens: no room for curves, so one card per IMO. */}
      <div className="flex flex-col gap-2 lg:hidden">
        {model.imoNodes.map((imo) => {
          const agencyNames = [...(model.imoToAgencies.get(imo.id) ?? [])]
            .map((id) => model.agencyNodes.find((n) => n.id === id)?.name)
            .filter((name): name is string => !!name);
          const carrierNames = [...(model.imoToCarriers.get(imo.id) ?? [])]
            .map((id) => model.carrierNodes.find((n) => n.id === id)?.name)
            .filter((name): name is string => !!name);
          return (
            <div key={imo.id} className="flex flex-col gap-1.5 rounded-md border border-border p-3">
              <span
                className={`font-display text-sm font-semibold ${
                  imo.active ? "" : "text-muted-foreground line-through"
                }`}
              >
                {imo.name}
              </span>
              <ChipRow label="Agencies" names={agencyNames} />
              <ChipRow label="Carriers" names={carrierNames} />
            </div>
          );
        })}
      </div>

      {!loading && model.imoNodes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No IMOs yet — add them under Settings → Agencies, IMOs and agents.
        </p>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="field-label">{label}</dt>
      <dd className="font-display text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="field-label pb-0.5">
        {title} ({count})
      </h3>
      <div className="flex flex-1 flex-col justify-center gap-1.5">{children}</div>
    </div>
  );
}

function NodeButton({
  node,
  detail,
  empty,
  dimmed,
  lit,
  selected,
  setRef,
  onToggle,
  onEnter,
  onLeave,
}: {
  node: Node;
  detail: string;
  empty: boolean;
  dimmed: boolean;
  lit: boolean;
  selected: boolean;
  setRef: (element: HTMLElement | null) => void;
  onToggle: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <button
      type="button"
      ref={setRef}
      aria-pressed={selected}
      onClick={onToggle}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className={`flex min-w-0 items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left transition-[opacity,border-color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        lit ? "border-accent/60 bg-accent/10" : "border-border bg-card/40 hover:border-accent/40"
      } ${selected ? "ring-1 ring-accent" : ""} ${dimmed ? "opacity-30" : ""}`}
    >
      <span
        className={`truncate text-xs font-medium ${
          node.active ? "" : "text-muted-foreground line-through"
        }`}
      >
        {node.name}
      </span>
      <span
        className={`shrink-0 text-[0.66rem] tabular-nums ${
          empty ? "italic text-muted-foreground/70" : "text-muted-foreground"
        }`}
      >
        {detail}
      </span>
    </button>
  );
}

function ChipRow({ label, names }: { label: string; names: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="field-label w-16 shrink-0">{label}</span>
      {names.length === 0 ? (
        <span className="text-xs italic text-muted-foreground">None linked</span>
      ) : (
        names.map((name) => (
          <span key={name} className="rounded-full border border-border px-2 py-0.5 text-[0.66rem]">
            {name}
          </span>
        ))
      )}
    </div>
  );
}
