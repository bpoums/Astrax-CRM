import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { roleHome, useAuth } from "@/lib/auth";
import { useNow, formatClock } from "@/components/ops";
import { isActiveSuspension, useCrmSuspension } from "@/lib/crm-suspension";

export const Route = createFileRoute("/suspended")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "System suspended | ASTRAX" },
      { name: "description", content: "The ASTRAX operations console is temporarily suspended." },
    ],
  }),
  component: SuspendedPage,
});

/**
 * Public, outside the auth gate — reachable by a just-kicked session or a
 * never-authenticated visitor alike, same as `reset-password.tsx`. Reads
 * `crm_suspension` itself rather than trusting router state handed off by
 * whichever redirect landed here, so a direct visit or a page reload also
 * resolves correctly. `my_role()` is the real gate; this page is display only.
 */
function SuspendedPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const now = useNow();
  const suspension = useCrmSuspension();

  const active = isActiveSuspension(suspension.data);

  useEffect(() => {
    if (suspension.isLoading) return;
    // Admins never land here via the app's own redirects, but if one does
    // (e.g. a stale tab), send them home rather than stranding them.
    if (profile?.role === "admin") {
      navigate({ to: roleHome.admin, replace: true });
      return;
    }
    // Once the suspension lifts, leave for the signed-in role's home, or
    // /login for a session that was already force-signed-out.
    if (!active) navigate({ to: profile?.role ? roleHome[profile.role] : "/login", replace: true });
  }, [suspension.isLoading, active, profile, navigate]);

  const resumesAt = suspension.data?.resumes_at;
  const remaining = resumesAt ? new Date(resumesAt).getTime() - now : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center gap-10">
        <BrandLogo className="h-15 w-auto max-w-none shrink-0" />
        <section className="panel w-full text-center">
          <h1 className="font-display text-lg font-semibold tracking-tight">
            System temporarily suspended
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {suspension.data?.message ?? "The system is temporarily suspended for maintenance."}
          </p>
          {remaining !== null && remaining > 0 ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Expected back in <span className="text-foreground">{formatClock(remaining)}</span>
            </p>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground">
              An admin will resume the system shortly.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
