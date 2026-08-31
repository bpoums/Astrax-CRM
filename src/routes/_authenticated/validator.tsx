import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { requireRole, useAuth } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import {
  AppHeader,
  FlagBadge,
  OriginBadge,
  PayloadTable,
  StatusBadge,
  closerName,
  customerName,
  dataFlags,
  dispositionLabel,
  formatClock,
  relativeTime,
  remainingMs,
  useNow,
  useReviewSettings,
  type Disposition,
  type SubmissionRow,
} from "@/components/ops";
import { PaymentPanel } from "@/components/payment-panel";
import { DataFlagList } from "@/components/data-flags";
import { CarrierDeclineList } from "@/components/carrier-declines";
import { DeclineDialog } from "@/components/decline-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

export const Route = createFileRoute("/_authenticated/validator")({
  beforeLoad: () => requireRole(["validator", "admin"]),
  head: () => ({
    meta: [
      { title: "Validator Queue | ASTRAX" },
      {
        name: "description",
        content:
          "Review the forms assigned to you inside the review window and accept or decline them.",
      },
      { property: "og:title", content: "Validator Queue | ASTRAX" },
      {
        property: "og:description",
        content: "Review assigned forms inside the review window.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ValidatorPage,
});

type ValidatorRow = SubmissionRow & {
  closer: { full_name: string | null } | null;
  uploader: { full_name: string | null } | null;
};

const QUEUE_KEY = ["validator", "submissions"];
const OPEN_STATUSES = ["assigned", "in_review"] as const;

function ValidatorPage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  // Declining is a two-step now: the button opens the carrier dialog, and
  // decline_with_carriers is what disposes the lead.
  const [declineId, setDeclineId] = useState<string | null>(null);
  const validatorId = profile?.id;
  const { enabled: timeoutEnabled, minutes, windowMs, ready: settingsReady } = useReviewSettings();
  const showCountdown = settingsReady && timeoutEnabled;

  const submissions = useQuery({
    queryKey: QUEUE_KEY,
    enabled: !!validatorId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select(
          "*, closer:profiles!submissions_closer_id_fkey(full_name), uploader:profiles!submissions_uploaded_by_fkey(full_name, org_name)",
        )
        .eq("assigned_to", validatorId!)
        .in("status", OPEN_STATUSES)
        .is("archived_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ValidatorRow[];
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel("validator-submissions")
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, () => {
        queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const claim = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("claim_submission", { p_sub: id });
      if (error) throw error;
    },
    onSuccess: (_data, id) => {
      closeConfirm();
      setOpenId(id);
      queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
    },
    onError: (error: Error) => {
      closeConfirm();
      toast.error(error.message);
    },
  });

  // Hold releases the claim without giving the form up: it stays assigned to
  // this validator, but claimed_at is cleared and the row drops back to
  // 'assigned'. Reopening goes through claim_submission, which restarts the
  // whole window — there is no partial-timer resume.
  const hold = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("hold_submission", { p_sub: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Form held — timer resets when you reopen it");
      setOpenId(null);
      queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
    },
    // A hold limit may be configured server-side; the message carries the count.
    onError: (error: Error) => toast.error(error.message),
  });

  const reject = useMutation({
    mutationFn: async (vars: { id: string; reason: string | null }) => {
      // p_reason is an optional arg with a SQL-side default, not a nullable one:
      // omit the key entirely rather than sending null.
      const { error } = await supabase.rpc(
        "reject_assignment",
        vars.reason === null ? { p_sub: vars.id } : { p_sub: vars.id, p_reason: vars.reason },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Assignment rejected — back to the manager");
      closeConfirm();
      queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const dispose = useMutation({
    mutationFn: async (vars: { id: string; disposition: Disposition }) => {
      const { error } = await supabase.rpc("dispose_submission", {
        p_sub: vars.id,
        p_disposition: vars.disposition,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      // Phrased so it reads for every label. The old template lowercased the
      // label into a sentence ("Submission approved"), which breaks the moment
      // a label is a verb — "Submission submit".
      toast.success(`Submission marked as ${dispositionLabel(vars.disposition)}`);
      setOpenId(null);
      queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = useMemo(() => submissions.data ?? [], [submissions.data]);
  const selected = rows.find((row) => row.id === openId) ?? null;
  const selectedFlags = selected ? dataFlags(selected.data_flags) : [];
  const pending = rows.find((row) => row.id === confirmId) ?? null;
  const declining = rows.find((row) => row.id === declineId) ?? null;
  const remaining =
    showCountdown && selected?.status === "in_review"
      ? remainingMs(selected.claimed_at, now, windowMs)
      : null;
  const busy = claim.isPending || dispose.isPending || hold.isPending || reject.isPending;

  function closeConfirm() {
    setConfirmId(null);
    setRejecting(false);
    setReason("");
  }

  // Expiry itself belongs to the server (pg_cron + the validator SELECT policy).
  // This only walks the reviewer out of a detail view whose window has run out.
  // With timeouts disabled `remaining` stays null, so the form is never closed
  // from under the validator — only a row that has actually left the queue is
  // cleaned up.
  useEffect(() => {
    if (!openId) return;
    if (remaining === null) {
      if (!submissions.isFetching && !rows.some((row) => row.id === openId)) setOpenId(null);
      return;
    }
    if (remaining > 0) return;
    setOpenId(null);
    queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
    toast.error("Form returned to the manager");
  }, [openId, remaining, rows, submissions.isFetching, queryClient]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-8 lg:py-5">
        <AppHeader
          title="Validator Queue"
          subtitle="Validator"
          actions={
            <Link to="/validator-form" className="chip inline-block">
              New submission
            </Link>
          }
        />

        <section className="panel">
          <h2 className="panel-title">Assigned to me ({rows.length})</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Closer</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Validation Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{customerName(row.payload)}</TableCell>
                  <TableCell>
                    <OriginBadge row={row} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{closerName(row)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {relativeTime(row.created_at, now)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={row.status} />
                      <FlagBadge count={dataFlags(row.data_flags).length} />
                      {row.hold_count > 0 ? (
                        <Badge variant="secondary" className="text-muted-foreground">
                          Held ×{row.hold_count}
                        </Badge>
                      ) : null}
                      {showCountdown && row.status === "in_review" ? (
                        <span className="text-xs font-semibold tabular-nums text-primary">
                          {formatClock(remainingMs(row.claimed_at, now, windowMs))}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {row.status === "assigned" ? (
                      <button
                        type="button"
                        className="chip"
                        disabled={busy}
                        onClick={() => setConfirmId(row.id)}
                      >
                        Start review
                      </button>
                    ) : (
                      <button type="button" className="chip" onClick={() => setOpenId(row.id)}>
                        Open review
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {submissions.isLoading ? "Loading…" : "Nothing assigned to you."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </section>
      </div>

      <AlertDialog open={!!pending} onOpenChange={(open) => !open && closeConfirm()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you ready to review this form?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending ? customerName(pending.payload) : ""} —{" "}
              {timeoutEnabled
                ? `confirming starts a ${minutes}-minute window. If it runs out the form goes back to the manager.`
                : "confirming opens the form for review. It stays yours until you accept or decline it."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Rejecting is not the same as cancelling: Cancel leaves the form in
              this queue, rejecting hands it back to the manager. */}
          {rejecting ? (
            <div className="flex flex-col gap-1">
              <label htmlFor="reject-reason" className="field-label">
                Reason (optional)
              </label>
              <input
                id="reject-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Conflict of interest, already spoke to this customer…"
                className="field-input"
                maxLength={500}
                autoFocus
              />
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            {rejecting ? (
              <button
                type="button"
                className="chip justify-center"
                disabled={busy}
                onClick={() => {
                  if (pending) reject.mutate({ id: pending.id, reason: reason.trim() || null });
                }}
              >
                {reject.isPending ? "Rejecting…" : "Reject assignment"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="chip justify-center"
                  disabled={busy}
                  onClick={() => setRejecting(true)}
                >
                  Can&apos;t take this
                </button>
                <AlertDialogAction
                  disabled={busy}
                  onClick={(event) => {
                    event.preventDefault();
                    if (pending) claim.mutate(pending.id);
                  }}
                >
                  {claim.isPending ? "Starting…" : "Yes, I'm ready"}
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

              {showCountdown ? (
                <div className="flex items-baseline justify-between gap-3 border-y border-border px-4 py-3">
                  <span className="field-label">Time remaining</span>
                  <span
                    className={`font-display text-3xl font-semibold tabular-nums ${
                      remaining !== null && remaining <= 60_000
                        ? "text-destructive"
                        : "text-primary"
                    }`}
                  >
                    {formatClock(remaining ?? 0)}
                  </span>
                </div>
              ) : null}

              <div className="flex min-w-0 max-w-full flex-col gap-4 px-4">
                <PayloadTable payload={selected.payload} />

                {/* Full card details are one explicit, logged click away, and
                    only while this review is open and the lead is theirs. */}
                <PaymentPanel
                  submissionId={selected.id}
                  canRevealCard={selected.status === "in_review"}
                />

                {/* Read-only here: correcting a lead's data is the manager's
                    job, not something to do mid-review. */}
                <DataFlagList
                  submissionId={selected.id}
                  payload={selected.payload}
                  flags={selectedFlags}
                />

                {/* Which carriers have already refused this lead, before the
                    validator spends a call finding out the hard way. */}
                <CarrierDeclineList submissionId={selected.id} />
              </div>

              <div className="flex gap-2 border-t border-border p-4">
                <button
                  type="button"
                  className="btn-submit flex-1"
                  disabled={busy}
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
                <button
                  type="button"
                  className="chip flex-1 justify-center"
                  disabled={busy}
                  onClick={() => hold.mutate(selected.id)}
                >
                  {hold.isPending ? "Holding…" : "Hold"}
                </button>
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
          queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
        }}
      />
    </main>
  );
}
