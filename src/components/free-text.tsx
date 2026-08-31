import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Rendering text somebody typed into a box.
 *
 * Two problems, both caused by the same thing. A flex or grid child defaults to
 * `min-width: auto`, so an unbroken string refuses to let its container shrink
 * and pushes the whole layout past the viewport. And a tooltip is a flex child
 * too, so a tooltip showing that same string overflows exactly the same way.
 *
 * `.free-text` (min-width:0 + overflow-wrap:anywhere) is the fix for both; the
 * components here apply it consistently and add the clamp-plus-tooltip
 * treatment that lists and timelines want.
 */

/**
 * The styled tooltip body: panel colours, a real max-width, and text that wraps
 * inside it. Every tooltip in the app should go through this rather than
 * shadcn's default amber block.
 */
export function TooltipBody({
  children,
  side = "top",
  align = "start",
}: {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  return (
    <TooltipContent
      side={side}
      align={align}
      // max-w-xs is what stops the tooltip inheriting the same overflow bug.
      className="max-w-xs border border-border bg-card p-0 text-foreground shadow-lg"
    >
      <div className="free-text flex flex-col gap-1 px-2.5 py-2">{children}</div>
    </TooltipContent>
  );
}

/** A tooltip heading. Not .field-label — that truncates and never wraps. */
export function TooltipHeading({ children }: { children: ReactNode }) {
  return (
    <span className="free-text text-[0.66rem] font-medium uppercase tracking-[0.04em] text-foreground">
      {children}
    </span>
  );
}

/**
 * Free text in a list or timeline: wrapped, clamped to two lines, with the whole
 * of it in the tooltip.
 *
 * Carries its own TooltipProvider. Radix throws when a tooltip is mounted
 * without one, and this is used in six different sheets and tables — making
 * each caller remember is how one of them ends up broken. Providers nest
 * harmlessly, so a page that already has one loses nothing.
 */
export function ClampedText({
  text,
  heading,
  meta,
  className = "",
  lines = 2,
}: {
  text: string;
  /** Optional tooltip heading — what this text belongs to. */
  heading?: string;
  /** Optional second line — who wrote it and when. */
  meta?: string;
  className?: string;
  lines?: 1 | 2;
}) {
  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`free-text block ${lines === 1 ? "line-clamp-1" : "line-clamp-2"} ${className}`}
          >
            {text}
          </span>
        </TooltipTrigger>
        <TooltipBody>
          {heading ? <TooltipHeading>{heading}</TooltipHeading> : null}
          {meta ? (
            <span className="free-text text-[0.62rem] text-muted-foreground">{meta}</span>
          ) : null}
          <p className="free-text whitespace-pre-wrap text-xs leading-snug text-foreground">
            {text}
          </p>
        </TooltipBody>
      </Tooltip>
    </TooltipProvider>
  );
}
