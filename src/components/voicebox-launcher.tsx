import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";

/**
 * Launches the real Voice Clone Studio interface at astrax.live/voicebox,
 * admin-only, in a new tab — see `docs/features/voice-clone-studio.md` and
 * `src/lib/voicebox.ts` for the full mechanism. Replaces the hand-built form
 * that used to live in this tab: this app's Supabase session lives in
 * `localStorage`, not a cookie, so a plain click first exchanges the current
 * session for a short-lived signed cookie server-side, then opens the tab —
 * a bare link would arrive with no way to prove who's asking.
 */
export function VoiceboxLauncher() {
  const { session } = useAuth();
  const [opening, setOpening] = useState(false);

  async function open() {
    if (!session?.access_token) {
      toast.error("Your session has expired — sign in again and retry.");
      return;
    }
    setOpening(true);
    try {
      const response = await fetch("https://astrax.live/api/voicebox/session", {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Could not open Voice Clone Studio (${response.status})`);
      }
      window.open("https://astrax.live/voicebox", "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open Voice Clone Studio");
    } finally {
      setOpening(false);
    }
  }

  return (
    <section className="panel flex flex-col gap-3">
      <h2 className="panel-title">Voice Clone Studio</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        Create and manage AI voice clones for your campaigns. Use the Voice Clone app to generate a personalized voice and access the available voice tools in one place.

Click the button below to open the Voice Clone app.
      </p>
      <div>
        <button type="button" className="btn-submit" disabled={opening} onClick={() => void open()}>
          {opening ? "Opening…" : "Open Voice Clone Studio"}
        </button>
      </div>
    </section>
  );
}
