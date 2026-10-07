import type { ReactNode } from "react";

/**
 * The pieces the Settings list panels (agencies, IMOs, agents, carriers) are
 * built from, so they look and behave the same.
 *
 * Presentation only. A row's actions sit quietly on the right and show on hover
 * or keyboard focus, and always on touch screens, where there is no hover —
 * four chips on every row of a 25-name list was most of what made these panels
 * hard to read.
 */

export function ListCard({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  /** Beside the title, e.g. a link. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2">
          <span className="font-display text-sm font-semibold">{title}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.66rem] tabular-nums text-muted-foreground">
            {count}
          </span>
        </h3>
        {action}
      </div>
      {children}
    </div>
  );
}

/** The scrolling region, capped so a long list does not stretch the page. */
export function ListBody({ children }: { children: ReactNode }) {
  return (
    <div className="no-scrollbar -mx-1 flex max-h-[26rem] flex-col overflow-y-auto px-1">
      {children}
    </div>
  );
}

export function ListRow({
  muted = false,
  actions,
  children,
}: {
  muted?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`group flex min-h-9 items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-accent/5 focus-within:bg-accent/5 ${
        muted ? "text-muted-foreground" : ""
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function RowAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

export function InactiveTag() {
  return (
    <span className="shrink-0 rounded border border-border px-1 text-[0.6rem] text-muted-foreground">
      Inactive
    </span>
  );
}

export function FilterInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="field-input h-7 text-xs"
      placeholder={`Filter ${label.toLowerCase()}…`}
      aria-label={`Filter ${label}`}
      autoComplete="off"
    />
  );
}
