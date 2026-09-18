import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FlipNumber } from "@/components/flip-number";

/**
 * Sheets sync queue health, for the admin Overview tab.
 *
 * `decisions/0006` moved Sheets sync to a durable queue so a failed write
 * retries instead of vanishing. That trade has a cost it names explicitly: a
 * stuck row now *accumulates* rather than disappearing, so a silently growing
 * queue is the same failure as a silent drop, only slower. This card is the
 * thing that makes it not silent — it is the reason the queue is safe to rely
 * on, not a status decoration.
 *
 * Read-only by design. The cron drains every 60s and retries with exponential
 * backoff already, so a button here would mostly duplicate what the system
 * does on its own.
 */

export const SHEET_SYNC_BACKLOG_KEY = ["sheet-sync-backlog"] as const;

/** Rows retried this many times are failing, not merely waiting their turn. */
const STRUGGLING_ATTEMPTS = 5;

/**
 * How long a queue may lag before it reads as stalled rather than busy.
 *
 * Throughput is ~25 rows/minute (one batch, one at a time — Apps Script
 * serialises itself), and 0006 explicitly accepts lagging "by minutes" under
 * sustained peak. Ten minutes is past that: long enough not to cry wolf during
 * a burst of 100 submissions, short enough that a genuine stall is caught the
 * same morning.
 */
const STALLED_SECONDS = 600;

type Backlog = {
  queued: number;
  in_flight: number;
  struggling: number;
  oldest_seconds: number;
  sample_error: string | null;
};

/** "1.6h" / "12m" / "45s" — compact enough to sit under a number. */
function age(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

export function SheetSyncBacklogCard() {
  const backlog = useQuery({
    queryKey: SHEET_SYNC_BACKLOG_KEY,
    queryFn: async (): Promise<Backlog> => {
      const { data, error } = await supabase.rpc("sheet_sync_backlog_status");
      if (error) throw error;
      return data as unknown as Backlog;
    },
    // The drain runs every 60s; refreshing twice that often means the number
    // on screen is never more than one cycle stale.
    refetchInterval: 30_000,
  });

  if (backlog.isPending) {
    return (
      <section className="panel gap-1">
        <h2 className="panel-title">Sheets sync</h2>
        <span className="text-xs text-muted-foreground">Loading…</span>
      </section>
    );
  }

  // `sheet_sync_backlog_status` raises "not authorized" for anyone but an
  // admin. Falling through to the empty state would draw a healthy-looking
  // card reading zero — which is not "no backlog", it is "you were refused",
  // and here the two would say opposite things about whether leads are stuck.
  if (backlog.isError) {
    return (
      <section className="panel gap-1">
        <h2 className="panel-title">Sheets sync</h2>
        <span className="text-xs text-destructive">{(backlog.error as Error).message}</span>
      </section>
    );
  }

  // `sample_error` is deliberately not rendered. Apps Script returns its
  // exceptions in the script owner's own locale, so the string arrives in a
  // language the admin reading this card may not speak — unreadable text under
  // a red number is noise, not a diagnosis. The RPC still returns it for
  // SQL/ops use, where whoever is debugging can translate it.
  const { queued, in_flight, struggling, oldest_seconds } = backlog.data;

  const stalled = oldest_seconds >= STALLED_SECONDS;
  const bad = struggling > 0 || stalled;

  return (
    /* A panel, not a grid holding a panel — the Overview tab pairs this with
       the CX coverage card and decides the width. */
    <section className="panel gap-1">
      <h2 className="panel-title">Sheets sync</h2>

      <span className={`flex items-end gap-1.5 ${bad ? "text-destructive" : ""}`}>
        <FlipNumber value={queued} size="hero" />
        <span className="pb-0.5 text-base font-normal text-muted-foreground">
          queued
          {in_flight > 0 ? ` · ${in_flight} sending` : ""}
        </span>
      </span>

      {queued === 0 ? (
        <span className="text-[0.66rem] text-muted-foreground">
          Every lead has reached the Sheet.
        </span>
      ) : (
        <span className="text-[0.66rem] text-muted-foreground">
          {struggling > 0 ? (
            <span className="text-destructive">
              {struggling} failing after {STRUGGLING_ATTEMPTS}+ attempts.{" "}
            </span>
          ) : null}
          {/* Age is the tell a count alone misses: a big queue that is moving
              is just a busy morning, a small one that is not is a fault. */}
          <span className={stalled && struggling === 0 ? "text-destructive" : ""}>
            Oldest {age(oldest_seconds)}.
          </span>{" "}
          {bad ? "These leads are not in the Sheet yet." : "Draining normally — about 25 a minute."}
        </span>
      )}
    </section>
  );
}
