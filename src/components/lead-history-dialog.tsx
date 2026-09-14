import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ValidationTimeline } from "@/components/validation-timeline";
import { CxLifecycleHistory } from "@/components/cx-lifecycle-history";

/**
 * A lead's full history — validation workflow and, where relevant, customer
 * lifecycle — as its own dedicated, near-full-screen view rather than two of
 * several sections squeezed into the bottom of a 576-672px-wide detail sheet.
 *
 * Both stories run as horizontally-scrolling rows of cards (see
 * `timeline.tsx`), stacked vertically here rather than tabbed — there is
 * enough width now for both to stay visible at once without either one
 * competing with the other for a shared scroll region.
 */
export function LeadHistoryDialog({
  submissionId,
  open,
  onOpenChange,
  customerName,
  showCxLifecycle = true,
  seconds = false,
}: {
  submissionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerName?: string | null;
  showCxLifecycle?: boolean;
  seconds?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] w-[92vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:rounded-xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="font-display">Lead History</DialogTitle>
          {customerName ? <DialogDescription>{customerName}</DialogDescription> : null}
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-5">
          <ValidationTimeline submissionId={submissionId} seconds={seconds} />
          {showCxLifecycle && submissionId ? (
            <CxLifecycleHistory submissionId={submissionId} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
