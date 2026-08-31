import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { relativeTime } from "@/components/ops";
import { Switch } from "@/components/ui/switch";

/**
 * The operational settings an admin can change without a redeploy.
 *
 * Every value in `app_config` is stored as text, so these are strings all the
 * way through — `set_admin_setting` parses and validates each one and raises a
 * message written to be read ("CVV must be purged within 30 days"). Those
 * messages are surfaced exactly as raised rather than replaced with a generic
 * one, because they are the only place the real rule is stated.
 *
 * Each field saves on its own. A batch save would have to decide what to do
 * when three succeed and one is rejected; one field at a time has no such
 * question, and the error lands next to the input that caused it.
 */

const SETTINGS_KEY = ["admin", "settings"] as const;
const RETENTION_STATUS_KEY = ["admin", "retention-status"] as const;

type SettingsMap = Record<string, string>;

/**
 * The last run of the nightly retention sweep, as `reporting_retention_status`
 * reports it. Every field is null until the job has executed once — it runs at
 * 04:11, so a setting changed during the day shows nothing new until tomorrow.
 */
type RetentionStatus = {
  last_run: string | null;
  last_status: string | null;
  last_archived_count: number | null;
};

/** The RPC returns jsonb, so it arrives as unknown. */
function readRetentionStatus(value: unknown): RetentionStatus {
  if (!value || typeof value !== "object") {
    return { last_run: null, last_status: null, last_archived_count: null };
  }
  const raw = value as Record<string, unknown>;
  return {
    last_run: typeof raw["last_run"] === "string" ? raw["last_run"] : null,
    last_status: typeof raw["last_status"] === "string" ? raw["last_status"] : null,
    last_archived_count:
      typeof raw["last_archived_count"] === "number" ? raw["last_archived_count"] : null,
  };
}

/** The six keys `admin_settings` returns and `set_admin_setting` accepts. */
const KEYS = {
  enabled: "review_timeout_enabled",
  minutes: "review_timeout_minutes",
  holds: "max_holds",
  retention: "reporting_retention_days",
  cvv: "cvv_purge_days",
  card: "card_purge_days",
} as const;

function readSettings(value: unknown): SettingsMap {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: SettingsMap = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === "string") out[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
  }
  return out;
}

export function AdminSettings() {
  const queryClient = useQueryClient();
  const [failures, setFailures] = useState<Record<string, string>>({});

  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("admin_settings");
      if (error) throw error;
      return readSettings(data);
    },
  });

  /**
   * Fetched once when this tab mounts. Radix leaves an inactive tab unmounted,
   * so opening Settings is what runs it; a sweep that fires at 04:11 has
   * nothing to say in realtime.
   */
  const retentionStatus = useQuery({
    queryKey: RETENTION_STATUS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("reporting_retention_status");
      if (error) throw error;
      return readRetentionStatus(data);
    },
  });

  const save = useMutation({
    mutationFn: async (vars: { key: string; value: string }) => {
      const { error } = await supabase.rpc("set_admin_setting", {
        p_key: vars.key,
        p_value: vars.value,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      setFailures((current) => {
        const next = { ...current };
        delete next[vars.key];
        return next;
      });
      toast.success("Setting saved");
      queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      // The review window is cached with a long staleTime wherever a countdown
      // is drawn, so changing it here has to retire that entry too — otherwise
      // this admin's own session keeps clocking the old window.
      queryClient.invalidateQueries({ queryKey: ["review-settings"] });
    },
    onError: (error: Error, vars) =>
      setFailures((current) => ({ ...current, [vars.key]: error.message })),
  });

  const values = settings.data ?? {};
  const enabled = values[KEYS.enabled] === "true";
  // Anything unparseable is treated as 0 — "keep forever" is the safe reading
  // of a value nobody can make sense of, since it archives nothing.
  const retentionDays = Number(values[KEYS.retention] ?? "0") || 0;

  if (settings.isLoading) {
    return (
      <section className="panel">
        <h2 className="panel-title">Operational settings</h2>
        <p className="text-xs text-muted-foreground">Loading…</p>
      </section>
    );
  }

  if (settings.isError) {
    return (
      <section className="panel">
        <h2 className="panel-title">Operational settings</h2>
        <p className="text-xs text-destructive">
          {settings.error instanceof Error ? settings.error.message : "Could not load settings."}
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Operational settings</h2>
        <span className="text-[0.66rem] text-muted-foreground">
          Changes take effect immediately — no redeploy needed.
        </span>
      </div>

      <div className="divide-y divide-border rounded-md border border-border">
        <SettingRow
          label="Review timeout"
          description={
            enabled
              ? "A validator's review expires when the window below runs out."
              : "Off — validators keep a form open indefinitely; nothing expires."
          }
          failure={failures[KEYS.enabled]}
        >
          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              disabled={save.isPending}
              aria-label="Review timeout enabled"
              onCheckedChange={(next) =>
                save.mutate({ key: KEYS.enabled, value: next ? "true" : "false" })
              }
            />
            <span className="text-xs text-muted-foreground">{enabled ? "On" : "Off"}</span>
          </div>
        </SettingRow>

        <NumberSetting
          settingKey={KEYS.minutes}
          label="Review window (minutes)"
          description="How long a validator has once they confirm they're ready. At least 1."
          value={values[KEYS.minutes] ?? ""}
          min={1}
          failure={failures[KEYS.minutes]}
          busy={save.isPending}
          onSave={(value) => save.mutate({ key: KEYS.minutes, value })}
        />

        <NumberSetting
          settingKey={KEYS.holds}
          label="Maximum holds"
          description="How many times a validator can pause and restart the timer on one lead. 0 means unlimited."
          value={values[KEYS.holds] ?? ""}
          min={0}
          failure={failures[KEYS.holds]}
          busy={save.isPending}
          onSave={(value) => save.mutate({ key: KEYS.holds, value })}
        />

        <NumberSetting
          settingKey={KEYS.retention}
          label="Reporting retention (days)"
          description={
            <>
              <span className="block">
                {retentionDays > 0
                  ? `A closed lead is archived ${retentionDays} ${
                      retentionDays === 1 ? "day" : "days"
                    } after it is disposed, and leaves the manager's Reporting queue and the admin Submissions table.`
                  : "Off — closed leads stay in Reporting and in Submissions for good. 0 keeps everything."}
              </span>
              <span className="mt-1 block">
                Only <span className="text-foreground">closed, disposed</span> leads age out. Open
                work — pending, in review, or declined and waiting to be reassigned — is never
                auto-archived, whatever this is set to.
              </span>
              <span className="mt-1 block">
                Archiving is the same action as pressing Remove by hand: the lead moves to the
                archived view and can be restored from there. Nothing is deleted.
              </span>
              <SweepStatus query={retentionStatus} />
            </>
          }
          /* An absent key means the setting has never been written, which is
             the same thing as 0 — keep forever. Showing it blank would read as
             "unknown" for what is really the default. */
          value={values[KEYS.retention] ?? "0"}
          min={0}
          failure={failures[KEYS.retention]}
          busy={save.isPending}
          onSave={(value) => save.mutate({ key: KEYS.retention, value })}
        />

        {/* <NumberSetting
          settingKey={KEYS.cvv}
          label="CVV purge (days)"
          description="Backstop for clearing CVVs; they are also cleared as soon as a lead is disposed. 30 days at most."
          value={values[KEYS.cvv] ?? ""}
          min={0}
          max={30}
          failure={failures[KEYS.cvv]}
          busy={save.isPending}
          onSave={(value) => save.mutate({ key: KEYS.cvv, value })}
        /> */}

        {/* <NumberSetting
          settingKey={KEYS.card}
          label="Card purge (days)"
          description="Days after a lead is disposed before stored card numbers are cleared."
          value={values[KEYS.card] ?? ""}
          min={0}
          failure={failures[KEYS.card]}
          busy={save.isPending}
          onSave={(value) => save.mutate({ key: KEYS.card, value })}
        /> */}
      </div>
    </section>
  );
}

/**
 * When the sweep last ran and what it did.
 *
 * A refused read is not "not yet run": this RPC is admin-only, and reporting a
 * refusal as "the job has never fired" would send someone looking for a broken
 * cron job that is running perfectly well. The error is printed as raised.
 *
 * Anything other than 'succeeded' is drawn destructive and named — a sweep that
 * failed last night is the whole reason to look at this line.
 */
function SweepStatus({
  query,
}: {
  query: {
    data?: RetentionStatus | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
  };
}) {
  if (query.isLoading) {
    return <span className="mt-1 block">Checking when the sweep last ran…</span>;
  }

  if (query.isError) {
    return (
      <span className="mt-1 block text-destructive">
        {query.error instanceof Error ? query.error.message : "Could not read the sweep status."}
      </span>
    );
  }

  const status = query.data;

  if (!status?.last_run) {
    return <span className="mt-1 block">Not yet run — the sweep runs nightly at 04:11.</span>;
  }

  const failed = status.last_status !== "succeeded";
  const count = status.last_archived_count ?? 0;

  return (
    <span className={`mt-1 block ${failed ? "text-destructive" : ""}`}>
      Last ran {relativeTime(status.last_run, Date.now())} — archived {count}{" "}
      {count === 1 ? "lead" : "leads"}
      {failed ? ` · ${status.last_status ?? "did not report success"}` : ""}
    </span>
  );
}

function SettingRow({
  label,
  description,
  failure,
  children,
}: {
  label: string;
  /** A node, not a string: some rules take more than one sentence to state. */
  description: ReactNode;
  failure?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="field-label">{label}</span>
        <span className="text-[0.68rem] text-muted-foreground">{description}</span>
        {failure ? <span className="text-xs text-destructive">{failure}</span> : null}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * Held as a draft until Save. The min/max here mirror what the RPC enforces so
 * the input can hint at the rule, but the server is what decides — a value the
 * browser lets through still comes back refused, with its reason.
 */
function NumberSetting({
  settingKey,
  label,
  description,
  value,
  min,
  max,
  failure,
  busy,
  onSave,
}: {
  settingKey: string;
  label: string;
  description: ReactNode;
  value: string;
  min?: number;
  max?: number;
  failure?: string | undefined;
  busy: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const current = draft ?? value;
  const dirty = current.trim() !== value.trim();

  return (
    <SettingRow label={label} description={description} failure={failure}>
      <input
        id={`setting-${settingKey}`}
        type="number"
        value={current}
        min={min}
        max={max}
        aria-label={label}
        className="field-input w-24 text-right"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && dirty && !busy) {
            event.preventDefault();
            onSave(current.trim());
          }
          if (event.key === "Escape") setDraft(null);
        }}
      />
      <button
        type="button"
        className="chip px-2.5 py-0.5 text-[0.66rem]"
        disabled={!dirty || busy}
        onClick={() => onSave(current.trim())}
      >
        Save
      </button>
      {dirty ? (
        <button
          type="button"
          className="chip px-2.5 py-0.5 text-[0.66rem] text-muted-foreground"
          disabled={busy}
          onClick={() => setDraft(null)}
        >
          Reset
        </button>
      ) : null}
    </SettingRow>
  );
}
