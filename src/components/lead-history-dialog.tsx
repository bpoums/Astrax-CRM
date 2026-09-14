import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ValidationTimeline } from "@/components/validation-timeline";
import { CxLifecycleHistory } from "@/components/cx-lifecycle-history";

/**
 * A lead's full history — validation workflow and, where relevant, customer
 * lifecycle — as its own dedicated view rather than two of several sections
 * squeezed into the bottom of a 576-672px-wide detail sheet.
 *
 * That sheet is where every other screen already showed these two panels
 * inline, stacked under payload/payment/data-flag sections; a lead with real
 * history (many validator hand-offs, several CX status changes) made that
 * sheet scroll a long way, in a column too narrow to read comfortably. This
 * dialog is opened by a "View History" button in that same spot instead.
 *
 * Deliberately a `Dialog` (centered, wide) rather than a second, wider
 * `Sheet` — the point is width the side panel doesn't have room to give.
 *
 * When both stories exist, they're tabbed rather than laid out side by side:
 * a two-column split at this dialog's width would give each timeline LESS
 * width than it already has in the sheet today, and would still stack two
 * long timelines into one shared scroll region. A tab keeps each story at
 * the dialog's full width with its own scroll region.
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
      <DialogContent className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:rounded-xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="font-display">Lead History</DialogTitle>
          {customerName ? <DialogDescription>{customerName}</DialogDescription> : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {showCxLifecycle ? (
            <Tabs defaultValue="validation">
              <TabsList>
                <TabsTrigger value="validation">Validation</TabsTrigger>
                <TabsTrigger value="lifecycle">Customer Lifecycle</TabsTrigger>
              </TabsList>
              <TabsContent value="validation">
                <ValidationTimeline submissionId={submissionId} seconds={seconds} comfortable />
              </TabsContent>
              <TabsContent value="lifecycle">
                {submissionId ? (
                  <CxLifecycleHistory submissionId={submissionId} comfortable />
                ) : null}
              </TabsContent>
            </Tabs>
          ) : (
            <ValidationTimeline submissionId={submissionId} seconds={seconds} comfortable />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
