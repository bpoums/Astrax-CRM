import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { roleHome, type AppRole } from "@/lib/auth";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "ASTRAX" },
      {
        name: "description",
        content: "Operations console for ASTRAX closers, managers, validators and admins.",
      },
      { property: "og:title", content: "ASTRAX" },
      {
        property: "og:description",
        content: "Operations console for ASTRAX closers, managers, validators and admins.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .maybeSingle();

    const role = (profile?.role as AppRole | undefined) ?? "closer";
    throw redirect({ to: roleHome[role], replace: true });
  },
  component: RedirectPage,
});

function RedirectPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <p className="text-xs text-muted-foreground">Routing you to your queue…</p>
    </main>
  );
}
