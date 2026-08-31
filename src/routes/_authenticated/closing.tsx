import { createFileRoute } from "@tanstack/react-router";
import { requireRole } from "@/lib/auth";
import { AppHeader } from "@/components/ops";
import { ClosingDesk } from "@/components/closing-desk";

/**
 * The closing manager's only screen.
 *
 * `requireRole` sends every other role back to its own home, which is what
 * confines a closing manager here — `roleHome` points them at this URL and
 * every other guard turns them away. Admin is allowed in alongside them, as on
 * every other route.
 */
export const Route = createFileRoute("/_authenticated/closing")({
  beforeLoad: () => requireRole(["closing_manager", "admin"]),
  head: () => ({
    meta: [
      { title: "Closing Desk | ASTRAX" },
      {
        name: "description",
        content:
          "Every closer-originated lead, its validation and customer statuses, and the payload behind it.",
      },
      { property: "og:title", content: "Closing Desk | ASTRAX" },
      {
        property: "og:description",
        content: "Closer leads at every stage, with the payload editable in place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ClosingPage,
});

function ClosingPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-8 lg:py-5">
        <AppHeader title="Closing Desk" subtitle="Closing" />
        <ClosingDesk />
      </div>
    </main>
  );
}
