import { createFileRoute, redirect } from "@tanstack/react-router";
import { loadAuthSnapshot, roleHome } from "@/lib/auth";

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
    const { user, profile } = await loadAuthSnapshot();
    if (!user) throw redirect({ to: "/login" });

    const role = profile?.role ?? "closer";
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
