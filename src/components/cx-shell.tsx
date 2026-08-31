import type { ReactNode } from "react";
import { AppHeader } from "@/components/ops";

/**
 * The CX workspace shell.
 *
 * The four pipelines are tabs, not a sidebar: they are facets of one workspace,
 * and the rail cost the table about fourteen rems it needed for its columns.
 * The segmented control sits directly under the header, the same place and the
 * same .chip treatment the manager dashboard uses, and the panel below it runs
 * the full width of the page.
 *
 * The active tab lives in the URL as ?tab= so a refresh or a pasted link lands
 * where it should.
 */

export const CX_TABS = [
  { id: "customers", label: "Customers Pipeline" },
  { id: "transfer", label: "Transfer Pipeline" },
  { id: "chargeback", label: "Chargeback Pipeline" },
  { id: "analytics", label: "Analytics" },
] as const;

export type CxTab = (typeof CX_TABS)[number]["id"];

const TAB_IDS = CX_TABS.map((tab) => tab.id) as readonly string[];

export function isCxTab(value: unknown): value is CxTab {
  return typeof value === "string" && TAB_IDS.includes(value);
}

export function CxShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-8 lg:py-5">
        <AppHeader title="Customer Experience" subtitle="CX" />
        {children}
      </div>
    </main>
  );
}

export function CxTabs({ active, onSelect }: { active: CxTab; onSelect: (tab: CxTab) => void }) {
  return (
    <nav aria-label="CX pipelines" className="flex flex-wrap items-center gap-1.5">
      {CX_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onSelect(tab.id)}
          aria-current={active === tab.id ? "page" : undefined}
          className={active === tab.id ? "chip chip-active" : "chip"}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

/** The three pipelines that are routed but not built. */
export function CxPlaceholder({ title }: { title: string }) {
  return (
    <section className="panel items-center justify-center gap-1 py-16 text-center">
      <h2 className="panel-title">{title}</h2>
      <p className="text-xs text-muted-foreground">Coming soon</p>
    </section>
  );
}
