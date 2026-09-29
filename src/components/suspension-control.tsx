import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CRM_SUSPENSION_KEY,
  isActiveSuspension,
  setCrmSuspension,
  useCrmSuspension,
} from "@/lib/crm-suspension";
import { formatClock, useNow } from "@/components/ops";

/**
 * The CRM-wide kill switch. Separate from `AdminSettings` because it talks to
 * its own table (`crm_suspension`), not the single-table `app_config` model
 * `AdminSettings`/`set_admin_setting` are built around — see
 * `docs/decisions/0008-crm-suspension-via-my-role.md`.
 *
 * Every non-admin role is force-signed-out the moment this flips (realtime,
 * in `AuthProvider`) and blocked from signing back in until it clears
 * (`my_role()`, server-side) — this panel is only the admin's remote for
 * that switch, not the enforcement itself.
 */
export function SuspensionControl() {
  const queryClient = useQueryClient();
  const now = useNow();
  const suspension = useCrmSuspension();
  const [duration, setDuration] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: setCrmSuspension,
    onSuccess: () => {
      setError("");
      toast.success("Suspension state updated");
      queryClient.invalidateQueries({ queryKey: CRM_SUSPENSION_KEY });
    },
    onError: (caught: Error) => setError(caught.message),
  });

  const row = suspension.data;
  const active = isActiveSuspension(row);
  const remaining = row?.resumes_at ? new Date(row.resumes_at).getTime() - now : null;

  function handleSuspend() {
    const trimmed = duration.trim();
    if (trimmed && (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0)) {
      setError("Duration must be a positive number of minutes, or blank for indefinite.");
      return;
    }
    mutation.mutate({
      suspended: true,
      durationMinutes: trimmed ? Number(trimmed) : null,
      message: message.trim() || null,
    });
  }

  function handleResume() {
    mutation.mutate({ suspended: false, durationMinutes: null, message: null });
  }

  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">System suspension</h2>
        <span className="text-[0.66rem] text-muted-foreground">
          Every non-admin role is signed out immediately and blocked until this clears.
        </span>
      </div>

      <div className="mt-3 rounded-md border border-border p-3">
        {suspension.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : active ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-destructive">
              Suspended
              {remaining !== null && remaining > 0
                ? ` — resumes in ${formatClock(remaining)}`
                : " — indefinitely, until manually resumed"}
            </p>
            {row?.message ? (
              <p className="text-[0.68rem] text-muted-foreground">"{row.message}"</p>
            ) : null}
            <button
              type="button"
              className="chip px-2.5 py-0.5 text-[0.66rem] self-start"
              disabled={mutation.isPending}
              onClick={handleResume}
            >
              Resume now
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">Not suspended.</p>
            <div className="flex flex-col gap-1">
              <label htmlFor="suspend-duration" className="field-label">
                Duration (minutes)
              </label>
              <input
                id="suspend-duration"
                type="number"
                min={1}
                placeholder="Blank = indefinite, until manually resumed"
                value={duration}
                disabled={mutation.isPending}
                onChange={(event) => setDuration(event.target.value)}
                className="field-input w-full"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="suspend-message" className="field-label">
                Message shown to users
              </label>
              <textarea
                id="suspend-message"
                rows={2}
                placeholder="The system is temporarily suspended for maintenance."
                value={message}
                disabled={mutation.isPending}
                onChange={(event) => setMessage(event.target.value)}
                className="field-input w-full"
              />
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <button
              type="button"
              className="chip px-2.5 py-0.5 text-[0.66rem] self-start"
              disabled={mutation.isPending}
              onClick={handleSuspend}
            >
              Suspend now
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
