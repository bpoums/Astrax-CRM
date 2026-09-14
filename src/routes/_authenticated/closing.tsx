import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { requireRole, useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/ops";
import { ClosingDesk } from "@/components/closing-desk";
import { ParkedLeads, PARKED_LEADS_KEY } from "@/components/parked-leads";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The closing manager's only screen, and the general manager's.
 *
 * `requireRole` sends every other role back to its own home, which is what
 * confines a closing manager here — `roleHome` points them at this URL and
 * every other guard turns them away. Admin is allowed in alongside them, as on
 * every other route.
 *
 * A general manager gets exactly this desk and exactly these edit controls.
 * The two differ only in what the `submissions` read policy hands back — a
 * closing manager's own centre and closer-originated leads, a general
 * manager's every centre and both origins — so the difference is settled
 * server-side and there is nothing here to branch on.
 *
 * Parked Leads is the one exception, and it is about which SCREEN a role gets
 * rather than which rows: `move_to_validation` accepts only an admin or a
 * general manager, so offering a closing manager a tab whose every button
 * raises "not authorized" would be worse than not offering it.
 */

const DESK_TAB = "desk";
const PARKED_TAB = "parked";

type ClosingTab = typeof DESK_TAB | typeof PARKED_TAB;

function isClosingTab(value: unknown): value is ClosingTab {
  return value === DESK_TAB || value === PARKED_TAB;
}

export const Route = createFileRoute("/_authenticated/closing")({
  beforeLoad: () => requireRole(["closing_manager", "general_manager", "admin"]),
  /**
   * The active tab lives in the URL so a refresh keeps it and a tab can be
   * linked to (/closing?tab=parked). Anything unrecognised falls back to the
   * desk rather than erroring — a stale bookmark should still open the page.
   */
  validateSearch: (search: Record<string, unknown>): { tab: ClosingTab } => ({
    tab: isClosingTab(search["tab"]) ? search["tab"] : DESK_TAB,
  }),
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
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { profile } = useAuth();

  const canMoveParked = profile?.role === "general_manager" || profile?.role === "admin";
  // A closing manager reaching ?tab=parked by a stale link gets the desk, not
  // an empty tab whose trigger is not even on screen.
  const active: ClosingTab = canMoveParked ? tab : DESK_TAB;

  /**
   * Just the count, so it can sit on the "Parked Leads" tab trigger itself —
   * Radix leaves an inactive tab's content unmounted, so `ParkedLeads` never
   * queries anything until that tab is actually opened, and a general
   * manager currently has no way to know anything is waiting there without
   * clicking in. Disabled entirely for a closing manager, who never sees
   * this tab anyway. Shares `PARKED_LEADS_KEY` as the prefix, so
   * `move_to_validation`'s existing invalidation of that key (in
   * `parked-leads.tsx`) refreshes this for free.
   */
  const parkedCount = useQuery({
    queryKey: [...PARKED_LEADS_KEY, "count"],
    enabled: canMoveParked,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("status", "parked")
        .is("archived_at", null);
      if (error) throw error;
      return count ?? 0;
    },
  });

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-8 lg:py-5">
        <AppHeader title="Closing Desk" subtitle="Closing" />

        {canMoveParked ? (
          <Tabs
            value={active}
            onValueChange={(value) => {
              if (isClosingTab(value)) void navigate({ search: { tab: value } });
            }}
            className="flex flex-col gap-4"
          >
            <TabsList className="w-fit">
              <TabsTrigger value={DESK_TAB}>Closing Desk</TabsTrigger>
              <TabsTrigger value={PARKED_TAB}>Parked Leads ({parkedCount.data ?? "…"})</TabsTrigger>
            </TabsList>

            <TabsContent value={DESK_TAB} className="flex flex-col gap-4">
              <ClosingDesk />
            </TabsContent>

            <TabsContent value={PARKED_TAB} className="flex flex-col gap-4">
              <ParkedLeads />
            </TabsContent>
          </Tabs>
        ) : (
          <ClosingDesk />
        )}
      </div>
    </main>
  );
}
