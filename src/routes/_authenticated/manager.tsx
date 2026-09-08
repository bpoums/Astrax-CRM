import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ReportingDashboard } from "@/components/reporting";
import { requireRole, useAuth } from "@/lib/auth";
import {
  AppHeader,
  DispositionBadge,
  FlagBadge,
  OriginBadge,
  QueueStatusBadge,
  StatusBadge,
  closerName,
  customerName,
  dataFlags,
  dispositionLabel,
  formatClock,
  isOnHold,
  relativeTime,
  remainingMs,
  useNow,
  useReviewSettings,
  type Disposition,
  type LeadSource,
  type SubmissionRow,
} from "@/components/ops";
import { formatDate } from "@/lib/format-date";
import { PaymentPanel } from "@/components/payment-panel";
import { DataFlagList } from "@/components/data-flags";
import { LeadPayload } from "@/components/lead-editor";
import { acceptBlockedReason, ValidatorFields } from "@/components/validator-fields";
import { PayloadEditHistory, payloadHistoryKey } from "@/components/payload-history";
import { validationTimelineKey } from "@/components/validation-timeline";
import {
  CarrierDeclineList,
  DeclinedCarriersBadge,
  DeclinedCarriersCallout,
} from "@/components/carrier-declines";
import { DeclineDialog } from "@/components/decline-dialog";
import { PendingImports, PENDING_IMPORTS_KEY } from "@/components/pending-imports";
import { DraftDateDesk } from "@/components/draft-date-desk";
import { carrierSummary, useDeclinedCarrierMap } from "@/lib/carriers";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated/manager")({
  beforeLoad: () => requireRole(["manager", "admin"]),
  head: () => ({
    meta: [
      { title: "Manager Queue | ASTRAX" },
      {
        name: "description",
        content: "Review incoming closer submissions, assign them to validators and dispose them.",
      },
      { property: "og:title", content: "Manager Queue | ASTRAX" },
      {
        property: "og:description",
        content: "Review incoming closer submissions and assign validators.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ManagerPage,
});

type ManagerRow = SubmissionRow & {
  closer: { full_name: string | null } | null;
  uploader: { full_name: string | null } | null;
  assignee: { full_name: string | null } | null;
  timeout_by: { full_name: string | null } | null;
  rejected_by: { full_name: string | null } | null;
  disposed: { full_name: string | null } | null;
};

const OPEN_STATUSES = ["pending_manager", "returned_timeout", "assigned", "in_review"] as const;

/**
 * The two queues, split by origin rather than by workflow state.
 *
 * There is deliberately no combined view. One table cannot serve both shapes:
 * a live lead is identified by the closer who took it, an uploaded one by the
 * centre that supplied it and the day the file arrived, and showing all four
 * columns at once leaves half of them blank on every row.
 *
 * Both queues hold the same OPEN statuses and offer the same actions — this is
 * about which columns a queue draws, never about what a manager may do.
 */
type QueueTab = "live" | "offline";

const QUEUE_TABS: { id: QueueTab; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "offline", label: "Offline" },
];

/**
 * Tab to stored value. The tab is named for the reader, the column for the
 * database, and mapping them here is what stops a rename in either place from
 * quietly matching nothing.
 */
const TAB_SOURCE: Record<QueueTab, LeadSource> = { live: "live", offline: "sheet" };

function isQueueTab(value: string): value is QueueTab {
  return QUEUE_TABS.some((tab) => tab.id === value);
}

// Rows a manager may hand to a validator. `in_review` is excluded: a validator
// is inside their window on it, and reassigning would yank it out from under them.
const ASSIGNABLE = new Set<ManagerRow["status"]>([
  "pending_manager",
  "returned_timeout",
  "assigned",
]);

/**
 * Where a lead stands, exactly as the Operations queue has always drawn it: the
 * shared badge chain, who is holding it, and how long they have left.
 *
 * Extracted so the Live and Offline queues cannot drift. The two tables differ
 * in which columns they carry; they must never differ in how a status reads.
 */
function QueueStatusCell({
  row,
  declinedCarriers,
  now,
  showCountdown,
  windowMs,
}: {
  row: ManagerRow;
  declinedCarriers: string[];
  now: number;
  showCountdown: boolean;
  windowMs: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* A hold is the one state that outranks the shared chain: it only ever
          applies to `assigned`, which the chain does not speak for. */}
      {isOnHold(row) ? (
        <DispositionBadge disposition={row.disposition} onHold />
      ) : (
        <QueueStatusBadge
          row={row}
          declinedCarriers={declinedCarriers}
          /* Rows the chain leaves to "anything else" — a lead carrying an
             outcome from an earlier pass that has since been reassigned. The
             queue has no disposition column, so this cell is the only place
             that outcome can be seen. */
          fallback={
            declinedCarriers.length > 0 ? (
              <DeclinedCarriersBadge names={declinedCarriers} />
            ) : row.disposition === "declined" ? (
              <Badge variant="destructive">
                {dispositionLabel("declined")} by {row.disposed?.full_name ?? "validator"}
              </Badge>
            ) : row.disposition === "pending" ? (
              <Badge variant="secondary" className="text-muted-foreground">
                {dispositionLabel("pending")} — {row.disposed?.full_name ?? "validator"}
              </Badge>
            ) : (
              <StatusBadge status={row.status} />
            )
          }
        />
      )}
      {row.status === "in_review" ? (
        <span className="text-xs text-muted-foreground">
          {row.assignee?.full_name ?? "validator"}
          {showCountdown ? (
            <>
              {" · "}
              <span className="font-semibold text-primary">
                {formatClock(remainingMs(row.claimed_at, now, windowMs))}
              </span>
            </>
          ) : null}
        </span>
      ) : null}
      {row.status === "assigned" ? (
        <span className="text-xs text-muted-foreground">
          → {row.assignee?.full_name ?? "validator"}
        </span>
      ) : null}
      {/* A form being parked repeatedly is worth seeing here. */}
      {row.hold_count > 0 && (row.status === "in_review" || row.status === "assigned") ? (
        <Badge variant="secondary" className="text-muted-foreground">
          Held ×{row.hold_count}
        </Badge>
      ) : null}
      <FlagBadge count={dataFlags(row.data_flags).length} />
    </div>
  );
}

function ManagerPage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkValidator, setBulkValidator] = useState<string>("");
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  // Declining is a two-step now: the button opens the carrier dialog, and
  // decline_with_carriers is what disposes the lead.
  const [declineId, setDeclineId] = useState<string | null>(null);
  const [queueTab, setQueueTab] = useState<QueueTab>("live");
  const { enabled: timeoutEnabled, windowMs, ready: settingsReady } = useReviewSettings();
  const showCountdown = settingsReady && timeoutEnabled;

  const submissions = useQuery({
    queryKey: ["manager", "submissions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select(
          "*, closer:profiles!submissions_closer_id_fkey(full_name), uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name), assignee:profiles!submissions_assigned_to_fkey(full_name), timeout_by:profiles!submissions_last_timeout_by_fkey(full_name), rejected_by:profiles!submissions_last_rejected_by_fkey(full_name), disposed:profiles!submissions_disposed_by_fkey(full_name)",
        )
        .in("status", OPEN_STATUSES)
        // Validator submissions are theirs to work, not the manager's to route.
        // Rows predating the column are null and stay in the queue.
        .or("submitted_by_role.is.null,submitted_by_role.neq.validator")
        .is("archived_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ManagerRow[];
    },
  });

  // One query for the whole queue rather than one per row — the view only
  // holds leads that have been declined at least once.
  const declinedMap = useDeclinedCarrierMap();

  const validators = useQuery({
    queryKey: ["validators"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("role", "validator")
        .eq("active", true)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel("manager-submissions")
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, () => {
        queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
        // An import lands as a batch of inserts, so the same channel is what
        // puts a newly uploaded batch on the Pending Imports tab.
        queryClient.invalidateQueries({ queryKey: PENDING_IMPORTS_KEY });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const dispose = useMutation({
    mutationFn: async (vars: { id: string; disposition: Disposition }) => {
      const { error } = await supabase.rpc("dispose_submission", {
        p_sub: vars.id,
        p_disposition: vars.disposition,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      // Phrased so it reads for every label. The old template lowercased the
      // label into a sentence ("Submission approved"), which breaks the moment
      // a label is a verb — "Submission submit".
      toast.success(`Submission marked as ${dispositionLabel(vars.disposition)}`);
      setOpenId(null);
      queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Archiving pulls the lead out of the manager and validator queues alike.
  const archive = useMutation({
    mutationFn: async (vars: { id: string; reason: string }) => {
      const reason = vars.reason.trim();
      const { error } = await supabase.rpc(
        "archive_submission",
        reason ? { p_sub: vars.id, p_reason: reason } : { p_sub: vars.id },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Submission removed");
      setArchiveId(null);
      setArchiveReason("");
      setOpenId(null);
      queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
      queryClient.invalidateQueries({ queryKey: ["reporting"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // One RPC per submission — the batch is a client-side loop so a single bad row
  // (already claimed, expired) does not take the rest of the selection down.
  const assign = useMutation({
    mutationFn: async (vars: { ids: string[]; validator: string }) => {
      const failures: string[] = [];
      for (const id of vars.ids) {
        const { error } = await supabase.rpc("assign_to_validator", {
          p_sub: id,
          p_validator: vars.validator,
        });
        if (error) failures.push(error.message);
      }
      if (failures.length === vars.ids.length) {
        throw new Error(failures[0] ?? "Could not assign");
      }
      return { assigned: vars.ids.length - failures.length, failures };
    },
    onSuccess: (result, vars) => {
      const name =
        (validators.data ?? []).find((v) => v.id === vars.validator)?.full_name ?? "validator";
      toast.success(
        result.assigned === 1
          ? `Assigned to ${name}`
          : `Assigned ${result.assigned} submissions to ${name}`,
      );
      if (result.failures.length > 0) {
        toast.error(`${result.failures.length} could not be assigned: ${result.failures[0]}`);
      }
      setOpenId(null);
      setSelectedIds([]);
      setBulkValidator("");
      queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const allRows = useMemo(() => submissions.data ?? [], [submissions.data]);
  // One query still feeds both queues — the statuses they draw from are
  // identical, so a second request would only duplicate the realtime work.
  const rows = useMemo(
    () => allRows.filter((row) => (row.source ?? "live") === TAB_SOURCE[queueTab]),
    [allRows, queueTab],
  );
  const selected = rows.find((row) => row.id === openId) ?? null;
  const selectedFlags = selected ? dataFlags(selected.data_flags) : [];
  /**
   * Why Accept is unavailable, or null. Read off the SAVED row rather than the
   * editor's draft: the server gates on what is stored, so anything else would
   * enable a button the RPC then refuses.
   */
  const acceptBlocked = selected ? acceptBlockedReason(selected) : null;
  const declining = rows.find((row) => row.id === declineId) ?? null;
  const declinedBy = (id: string) => declinedMap.data?.get(id) ?? [];
  const selectedDeclines = selected ? declinedBy(selected.id) : [];
  const busy = dispose.isPending || assign.isPending || archive.isPending;
  const canArchive = profile?.role === "manager" || profile?.role === "admin";
  // The same two roles `update_payload_field` accepts. The RPC is what
  // actually enforces it; this only keeps the button off a screen where it
  // would always fail.
  const canEditLead = canArchive;

  const assignableIds = useMemo(
    () => rows.filter((row) => ASSIGNABLE.has(row.status)).map((row) => row.id),
    [rows],
  );
  // Realtime can retire a row mid-selection, so the tick list is always
  // re-derived against what is currently assignable.
  const selection = useMemo(
    () => selectedIds.filter((id) => assignableIds.includes(id)),
    [selectedIds, assignableIds],
  );
  const allSelected = assignableIds.length > 0 && selection.length === assignableIds.length;

  /**
   * The carriers that have already refused something in the current selection.
   *
   * A bulk assign hides the individual leads, so without this the one lead in
   * twenty that TransAmerica has already declined goes back out to it unseen.
   * The names are pooled across the selection — which lead carries which is a
   * question for the detail sheet.
   */
  const selectionDeclines = useMemo(() => {
    const names = new Set<string>();
    let leads = 0;
    for (const id of selection) {
      const declined = declinedMap.data?.get(id) ?? [];
      if (declined.length === 0) continue;
      leads += 1;
      for (const name of declined) names.add(name);
    }
    return { leads, names: [...names] };
  }, [selection, declinedMap.data]);

  // A tick belongs to the queue it was made in. `selection` already intersects
  // with what is assignable on the open tab, so nothing could leak across —
  // this clears the ids too, so returning to a tab does not resurrect a
  // selection the reader has long since moved on from.
  useEffect(() => setSelectedIds([]), [queueTab]);

  const toggleRow = (id: string, checked: boolean) =>
    setSelectedIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id),
    );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-8 lg:py-5">
        <AppHeader
          title="Manager Queue"
          subtitle="Manager"
          actions={
            /* The way back, and only for an admin — a manager has no /admin to
               return to and the route would bounce them straight back here. */
            profile?.role === "admin" ? (
              <Link to="/admin" search={{ tab: "overview" }} className="chip inline-block">
                Back to Admin
              </Link>
            ) : null
          }
        />

        <Tabs defaultValue="operations" className="flex flex-col gap-4">
          <TabsList className="w-fit">
            <TabsTrigger value="operations">Operations</TabsTrigger>
            {/* Deliberately not part of Operations: these leads are not in the
                queue yet and cannot be assigned or disposed until a batch is
                accepted. */}
            <TabsTrigger value="imports">Pending Imports</TabsTrigger>
            {/* Not part of Operations: these leads are all disposed and
                accepted, so none of the queue's actions apply to them. */}
            <TabsTrigger value="draft-dates">By Draft Date</TabsTrigger>
            <TabsTrigger value="reporting">Reporting</TabsTrigger>
          </TabsList>

          <TabsContent value="operations" className="flex flex-col gap-4">
            {/* Two queues rather than one table behind a filter. A live lead and
                an uploaded one answer different questions — who closed it,
                versus which centre supplied it — so each tab carries the columns
                that queue actually needs, instead of a Source column that is
                noise on one and a Closer column that is always empty on the
                other. Both hold OPEN leads only, and the actions are identical:
                an offline lead past the import gate is an ordinary lead. */}
            <Tabs
              value={queueTab}
              onValueChange={(value) => {
                if (isQueueTab(value)) setQueueTab(value);
              }}
              className="flex flex-col gap-4"
            >
              <section className="panel">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="panel-title">Open submissions ({rows.length})</h2>
                    <TabsList>
                      {QUEUE_TABS.map((entry) => (
                        <TabsTrigger key={entry.id} value={entry.id}>
                          {entry.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </div>
                  {/* The bulk bar belongs to whichever queue is open. Crossing
                      to the other tab clears the selection, so an assign can
                      never reach leads the reader is no longer looking at. */}
                  {selection.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {selection.length} selected
                      </span>
                      {selectionDeclines.leads > 0 ? (
                        <span className="text-xs text-destructive">
                          {selectionDeclines.leads === 1
                            ? "1 of these was declined by"
                            : `${selectionDeclines.leads} of these were declined by`}{" "}
                          {carrierSummary(selectionDeclines.names, 3)}
                        </span>
                      ) : null}
                      <Select
                        value={bulkValidator}
                        onValueChange={setBulkValidator}
                        disabled={busy}
                      >
                        <SelectTrigger className="h-8 w-52 text-xs">
                          <SelectValue placeholder="Assign to validator" />
                        </SelectTrigger>
                        <SelectContent>
                          {(validators.data ?? []).map((validator) => (
                            <SelectItem key={validator.id} value={validator.id}>
                              {validator.full_name ?? validator.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <button
                        type="button"
                        className="btn-submit"
                        disabled={busy || !bulkValidator}
                        onClick={() => assign.mutate({ ids: selection, validator: bulkValidator })}
                      >
                        {assign.isPending ? "Assigning…" : `Assign ${selection.length}`}
                      </button>
                      <button type="button" className="chip" onClick={() => setSelectedIds([])}>
                        Clear
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* No Source column here — every row on this tab is live, so
                    the badge would say the same thing on all of them. */}
                <TabsContent value="live" className="m-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8">
                          <Checkbox
                            aria-label="Select all assignable submissions"
                            disabled={assignableIds.length === 0 || busy}
                            checked={
                              allSelected ? true : selection.length > 0 ? "indeterminate" : false
                            }
                            onCheckedChange={(checked) =>
                              setSelectedIds(checked === true ? assignableIds : [])
                            }
                          />
                        </TableHead>
                        <TableHead>Center</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Closer</TableHead>
                        <TableHead>Submitted</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow
                          key={row.id}
                          className="cursor-pointer"
                          onClick={() => setOpenId(row.id)}
                        >
                          <TableCell className="w-8" onClick={(event) => event.stopPropagation()}>
                            {ASSIGNABLE.has(row.status) ? (
                              <Checkbox
                                aria-label={`Select ${customerName(row.payload)}`}
                                disabled={busy}
                                checked={selection.includes(row.id)}
                                onCheckedChange={(checked) => toggleRow(row.id, checked === true)}
                              />
                            ) : null}
                          </TableCell>
                          {/* The stamped name, not a join: a lead keeps the
                              centre it was taken in even after that centre is
                              renamed or the closer is moved to another one. */}
                          <TableCell className="text-muted-foreground">
                            {row.center_name ?? "—"}
                          </TableCell>
                          <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                          <TableCell className="text-muted-foreground">{closerName(row)}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {relativeTime(row.created_at, now)}
                          </TableCell>
                          <TableCell>
                            <QueueStatusCell
                              row={row}
                              declinedCarriers={declinedBy(row.id)}
                              now={now}
                              showCountdown={showCountdown}
                              windowMs={windowMs}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                      {rows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground">
                            {submissions.isLoading ? "Loading…" : "Nothing in the queue."}
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </TabsContent>

                {/* No Closer column here — an imported lead has none. Source
                    names the centre that supplied it instead, and the date is
                    absolute because the column is named for one. */}
                <TabsContent value="offline" className="m-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8">
                          <Checkbox
                            aria-label="Select all assignable submissions"
                            disabled={assignableIds.length === 0 || busy}
                            checked={
                              allSelected ? true : selection.length > 0 ? "indeterminate" : false
                            }
                            onCheckedChange={(checked) =>
                              setSelectedIds(checked === true ? assignableIds : [])
                            }
                          />
                        </TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Uploaded On</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow
                          key={row.id}
                          className="cursor-pointer"
                          onClick={() => setOpenId(row.id)}
                        >
                          <TableCell className="w-8" onClick={(event) => event.stopPropagation()}>
                            {ASSIGNABLE.has(row.status) ? (
                              <Checkbox
                                aria-label={`Select ${customerName(row.payload)}`}
                                disabled={busy}
                                checked={selection.includes(row.id)}
                                onCheckedChange={(checked) => toggleRow(row.id, checked === true)}
                              />
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <OriginBadge row={row} />
                          </TableCell>
                          <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatDate(row.created_at)}
                          </TableCell>
                          <TableCell>
                            <QueueStatusCell
                              row={row}
                              declinedCarriers={declinedBy(row.id)}
                              now={now}
                              showCountdown={showCountdown}
                              windowMs={windowMs}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                      {rows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-muted-foreground">
                            {submissions.isLoading ? "Loading…" : "Nothing in the queue."}
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </TabsContent>
              </section>
            </Tabs>
          </TabsContent>

          {/* Imported batches awaiting a decision. Accepting one moves its
              leads into pending_manager, at which point they appear in the
              Operations queue above. Closer submissions never come through
              here. */}
          <TabsContent value="imports" className="flex flex-col gap-4">
            <PendingImports />
          </TabsContent>

          {/* Radix leaves an inactive tab unmounted, which is half of what
              keeps this from querying until it is opened AND a date is picked. */}
          <TabsContent value="draft-dates" className="flex flex-col gap-4">
            <DraftDateDesk />
          </TabsContent>

          {/* Unfiltered by status, unlike the queue above: a lead stays on
              this tab once it has been disposed. */}
          <TabsContent value="reporting" className="flex flex-col gap-4">
            <ReportingDashboard />
          </TabsContent>
        </Tabs>
      </div>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto overflow-x-hidden sm:max-w-xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{customerName(selected.payload)}</SheetTitle>
                <SheetDescription>
                  {selected.source === "sheet" ? "Offline lead uploaded by" : "Submitted by"}{" "}
                  {closerName(selected)} · {relativeTime(selected.created_at, now)}
                </SheetDescription>
              </SheetHeader>
              <div className="flex min-w-0 max-w-full flex-col gap-4 px-4">
                {/* Editable: a manager correcting a lead is fixing the record
                    the sheet-sync trigger pushes, so every field goes through
                    update_payload_field rather than the table — which is what
                    puts the before/after into the edit history below. */}
                <LeadPayload
                  submissionId={selected.id}
                  payload={selected.payload}
                  editable={canEditLead}
                  onSaved={() => {
                    queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
                    // The edit that was just written is what this panel exists
                    // to show, so it has to be refetched with the lead.
                    queryClient.invalidateQueries({ queryKey: payloadHistoryKey(selected.id) });
                  }}
                />

                {/* Bank fields and the card's last four only — the full number
                    never reaches a manager's browser. */}
                <PaymentPanel submissionId={selected.id} />

                {/* A flag is only cleared once the value behind it has been
                    corrected — see DataFlagList. */}
                <DataFlagList
                  submissionId={selected.id}
                  payload={selected.payload}
                  flags={selectedFlags}
                  editable
                  onChange={() => {
                    queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
                    // A flag fix is a payload edit like any other, and lands in
                    // the same history.
                    queryClient.invalidateQueries({ queryKey: payloadHistoryKey(selected.id) });
                  }}
                />

                {/* The review's own outcome, and what the Accept button
                    below is waiting on. */}
                <ValidatorFields
                  row={selected}
                  onSaved={() => {
                    queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
                    queryClient.invalidateQueries({
                      queryKey: validationTimelineKey(selected.id),
                    });
                  }}
                />

                {/* Every attempt, separate from the validation timeline. */}
                <CarrierDeclineList submissionId={selected.id} />

                {/* The same panel the closing desk draws — what each field was
                    before it was corrected, and who corrected it. */}
                <PayloadEditHistory submissionId={selected.id} />
              </div>
              <div className="flex flex-col gap-2 border-t border-border p-4">
                {/* Said before the click, not after it. `dispose_submission`
                    refuses this anyway; showing the reason up here is what
                    stops someone pressing Accept and going looking for why. */}
                {acceptBlocked ? (
                  <span className="text-[0.68rem] font-semibold text-destructive">
                    {acceptBlocked}
                  </span>
                ) : null}
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-submit flex-1"
                    disabled={busy || !!acceptBlocked}
                    title={acceptBlocked ?? undefined}
                    onClick={() => dispose.mutate({ id: selected.id, disposition: "accepted" })}
                  >
                    {dispositionLabel("accepted")}
                  </button>
                  <button
                    type="button"
                    className="chip flex-1 justify-center border-destructive text-destructive"
                    disabled={busy}
                    onClick={() => setDeclineId(selected.id)}
                  >
                    {dispositionLabel("declined")}
                  </button>
                </div>
                {/* Directly above the validator picker, because this is the
                    moment the lead is about to go back out. */}
                <DeclinedCarriersCallout names={selectedDeclines} />
                <Select
                  onValueChange={(value) => assign.mutate({ ids: [selected.id], validator: value })}
                  disabled={busy}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Assign to validator" />
                  </SelectTrigger>
                  <SelectContent>
                    {(validators.data ?? []).map((validator) => (
                      <SelectItem key={validator.id} value={validator.id}>
                        {validator.full_name ?? validator.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {canArchive ? (
                  <button
                    type="button"
                    className="chip justify-center text-muted-foreground"
                    disabled={busy}
                    onClick={() => setArchiveId(selected.id)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <DeclineDialog
        submissionId={declineId}
        customer={declining ? customerName(declining.payload) : ""}
        onOpenChange={(open) => !open && setDeclineId(null)}
        onDeclined={() => {
          setOpenId(null);
          queryClient.invalidateQueries({ queryKey: ["manager", "submissions"] });
        }}
      />

      <AlertDialog
        open={!!archiveId}
        onOpenChange={(open) => {
          if (!open) {
            setArchiveId(null);
            setArchiveReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this submission?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves the manager queue and the validator queue. An admin can restore it from the
              Reporting tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1">
            <label htmlFor="archive-reason" className="field-label">
              Reason (optional)
            </label>
            <input
              id="archive-reason"
              value={archiveReason}
              onChange={(event) => setArchiveReason(event.target.value)}
              placeholder="Duplicate, test entry, customer withdrew…"
              className="field-input"
              maxLength={500}
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archive.isPending}>Cancel</AlertDialogCancel>
            <button
              type="button"
              className="chip justify-center border-destructive text-destructive"
              disabled={archive.isPending}
              onClick={() => {
                if (archiveId) archive.mutate({ id: archiveId, reason: archiveReason });
              }}
            >
              {archive.isPending ? "Removing…" : "Remove"}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
