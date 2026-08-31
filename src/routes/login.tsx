import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { roleHome, useAuth, type AppRole } from "@/lib/auth";
import { BrandLogo } from "@/components/brand-logo";

export const Route = createFileRoute("/login")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in | ASTRAX" },
      {
        name: "description",
        content:
          "Sign in to the ASTRAX operations console for closers, managers, validators and admins.",
      },
      { property: "og:title", content: "Sign in | ASTRAX" },
      {
        property: "og:description",
        content: "Sign in to the ASTRAX operations console.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LoginPage,
});

/**
 * How long any auth call may run before the form gives up on it.
 *
 * Generous — a slow connection should not be cut off — but finite. An auth
 * request can hang indefinitely for reasons entirely outside this app: during a
 * Supabase incident the gateway accepts the request and the auth service never
 * answers, so the promise simply never settles. Waiting for ever is the one
 * outcome that tells the person nothing, so the wording below blames nobody and
 * says only what is known — the server could not be reached.
 */
const AUTH_TIMEOUT_MS = 20_000;

function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), AUTH_TIMEOUT_MS);
    }),
  ]);
}

function LoginPage() {
  const navigate = useNavigate();
  const { profile, session } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session && profile) {
      navigate({ to: roleHome[profile.role], replace: true });
    }
  }, [session, profile, navigate]);

  async function handleForgotPassword() {
    setError("");
    setNotice("");
    if (!email.trim()) {
      setError("Enter your email address first.");
      return;
    }
    setBusy(true);
    try {
      await withTimeout(
        supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/reset-password`,
        }),
        "Could not reach the server. Please try again in a moment.",
      );
      // Whether the address exists is never surfaced: a different message for a
      // known address would let anyone test which emails have accounts. A
      // transport failure is a different thing and is reported below — it says
      // nothing about the account.
      setNotice("If that email has an account, a reset link is on its way.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the reset email.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Every path out of here either navigates or says why it did not.
   *
   * `busy` was previously cleared only when the call came back carrying an
   * error, so a call that threw — or never settled — left the button reading
   * "Signing in…" indefinitely with nothing reported. That is indistinguishable
   * from a frozen page, and it hides the one detail worth knowing.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { data, error: signInError } = await withTimeout(
        supabase.auth.signInWithPassword({ email, password }),
        "Sign-in could not reach the server. Please try again in a moment.",
      );
      if (signInError || !data.user) {
        setError(signInError?.message ?? "Could not sign in.");
        return;
      }
      const { data: prof } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", data.user.id)
        .maybeSingle();
      const role = (prof?.role as AppRole | undefined) ?? "closer";
      navigate({ to: roleHome[role], replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.");
    } finally {
      // Runs on the success path too, which costs nothing — the component is
      // on its way out — and guarantees the button can never stay stuck.
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      {/* Logo and card as one centred stack, so the lockup sits directly above
          the form rather than pinned to the corner of the viewport. The width
          cap moves to the stack so both share it. */}
      <div className="flex w-full max-w-sm flex-col items-center gap-10">
        <BrandLogo className="h-15 w-auto max-w-none shrink-0" />
        <form onSubmit={handleSubmit} className="panel w-full">
          {/* <p className="text-[0.65rem] font-semibold uppercase tracking-[0.35em] text-accent">
          ASTRAX
        </p> */}

          {/* <h1 className="font-display mt-1 text-2xl font-semibold tracking-tight">Ops console</h1> */}
          <div className="mt-5 flex flex-col gap-3">
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
            <div className="flex flex-col gap-1">
              <label htmlFor="password" className="field-label">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="field-input"
              />
            </div>
            {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
            {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
            <button type="submit" className="btn-submit mt-1" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button
              type="button"
              onClick={handleForgotPassword}
              disabled={busy}
              className="self-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Forgot password?
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
