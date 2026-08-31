import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { roleHome, type AppRole } from "@/lib/auth";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Set your password | ASTRAX" },
      {
        name: "description",
        content: "Set a new password for your ASTRAX operations console account.",
      },
      { property: "og:title", content: "Set your password | ASTRAX" },
      {
        property: "og:description",
        content: "Set a new password for your ASTRAX account.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ResetPasswordPage,
});

type Phase = "checking" | "ready" | "expired";

/**
 * Supabase reports a dead recovery link in the URL fragment rather than by
 * failing a request, e.g. #error=access_denied&error_code=otp_expired.
 */
function linkErrorFromHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  if (!params.get("error") && !params.get("error_code")) return null;
  return params.get("error_description") ?? "This link is no longer valid.";
}

/**
 * Password recovery only. The recovery token in the fragment is exchanged for a
 * session by the client automatically, and updateUser sets the password on that
 * already-existing account. Nothing here creates an account.
 */
function ResetPasswordPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const linkError = linkErrorFromHash();
      if (linkError) {
        if (active) {
          setPhase("expired");
          setError(linkError);
        }
        return;
      }
      // getSession() waits for the client to finish reading the fragment, so a
      // session here means the recovery token was accepted.
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      if (data.session) {
        setPhase("ready");
      } else {
        setPhase("expired");
        setError("This reset link has expired or has already been used.");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    const { data, error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError || !data.user) {
      setError(updateError?.message ?? "Could not set your password.");
      setBusy(false);
      return;
    }
    const { data: prof } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .maybeSingle();
    const role = (prof?.role as AppRole | undefined) ?? "closer";
    navigate({ to: roleHome[role], replace: true });
  }

  async function sendNewLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    // Deliberately ignores the result: confirming whether an address exists
    // would turn this form into an account-enumeration oracle.
    setBusy(false);
    setNotice("If that email has an account, a new link is on its way.");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="panel w-full max-w-sm">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.35em] text-accent">
          ASTRAX
        </p>
        <h1 className="font-display mt-1 text-2xl font-semibold tracking-tight">
          {phase === "expired" ? "Link expired" : "Set your password"}
        </h1>

        {phase === "checking" ? (
          <p className="mt-5 text-xs text-muted-foreground">Checking your link…</p>
        ) : null}

        {phase === "ready" ? (
          <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="password" className="field-label">
                New password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="field-input"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="confirm" className="field-label">
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="field-input"
              />
            </div>
            {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
            <button type="submit" className="btn-submit mt-1" disabled={busy}>
              {busy ? "Saving…" : "Save password"}
            </button>
          </form>
        ) : null}

        {phase === "expired" ? (
          <form onSubmit={sendNewLink} className="mt-5 flex flex-col gap-3">
            <p className="text-xs text-destructive">{error}</p>
            <div className="flex flex-col gap-1">
              <label htmlFor="email" className="field-label">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="field-input"
              />
            </div>
            {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
            <button type="submit" className="btn-submit mt-1" disabled={busy}>
              {busy ? "Sending…" : "Send me a new link"}
            </button>
          </form>
        ) : null}
      </div>
    </main>
  );
}
