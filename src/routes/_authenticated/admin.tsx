import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { requireRole } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/ops";
import { SubmissionsExplorer } from "@/components/reporting";
import { AdminOverview } from "@/components/admin-overview";
import { CustomersPipeline, RemovedFromPipeline } from "@/components/customers-pipeline";
import { CxStatusBreakdown, CxCoverageCard } from "@/components/cx-status-breakdown";
import { UserAdmin } from "@/components/user-admin";
import { DataUploader } from "@/components/data-uploader";
import { ImportHistory } from "@/components/import-history";
import { CardAccessLog } from "@/components/card-access-log";
import { SettingsAudit } from "@/components/settings-audit";
import { AdminSettings } from "@/components/admin-settings";
import { CxStatusAdmin } from "@/components/cx-status-admin";
import { CarrierAdmin } from "@/components/carrier-admin";
import { DraftDateDesk } from "@/components/draft-date-desk";
import { CenterAdmin } from "@/components/center-admin";
import { TransferClientAdmin } from "@/components/transfer-client-admin";
import { VoiceCloneStudio } from "@/components/voice-clone-studio";
import { CarrierDeclineReport } from "@/components/carrier-declines";
import { ParkedLeads, PARKED_LEADS_KEY } from "@/components/parked-leads";
import { SheetSyncBacklogCard } from "@/components/sheet-sync-backlog";
import { Exports } from "@/components/exports";
import { SalesBreakdown } from "@/components/sales-breakdown";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "submissions", label: "Submissions" },
  // External transfers nobody has released yet. An admin can move one along
  // for the same reason they can do anything a general manager can.
  { id: "parked", label: "Parked Leads" },
  { id: "pipeline", label: "Customer Pipeline" },
  // The same screen the manager gets, mounted here because an admin sees
  // everything a manager does.
  { id: "draft-dates", label: "By Draft Date" },
  { id: "exports", label: "Exports" },
  { id: "sales-breakdown", label: "Sales Breakdown" },
  { id: "users", label: "Users" },
  { id: "uploads", label: "Uploads" },
  // { id: "imports", label: "Imports" },
  { id: "settings", label: "Settings" },
  // { id: "audit", label: "Audit" },
  { id: "voice-clone", label: "Voice Clone" },
] as const;

type AdminTab = (typeof TABS)[number]["id"];

const DEFAULT_TAB: AdminTab = "overview";

function isAdminTab(value: unknown): value is AdminTab {
  return typeof value === "string" && TABS.some((tab) => tab.id === value);
}

export const Route = createFileRoute("/_authenticated/admin")({
  beforeLoad: () => requireRole(["admin"]),
  /**
   * The active tab lives in the URL so a refresh keeps it and a tab can be
   * linked to (/admin?tab=users). Anything unrecognised falls back to Overview
   * rather than erroring — a stale bookmark should still open the page.
   */
  validateSearch: (search: Record<string, unknown>): { tab: AdminTab } => ({
    tab: isAdminTab(search["tab"]) ? search["tab"] : DEFAULT_TAB,
  }),
  head: () => ({
    meta: [
      { title: "Admin | ASTRAX" },
      {
        name: "description",
        content:
          "Volume, dispositions, validator performance, users, imports, settings and the full audit trail.",
      },
      { property: "og:title", content: "Admin | ASTRAX" },
      {
        property: "og:description",
        content: "Volume, dispositions and validator performance across the queue.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AdminPage,
});

/**
 * The admin dashboard.
 *
 * Each panel lives in its own TabsContent, which Radix does not mount while
 * inactive — so only the visible tab's queries run, and opening /admin does not
 * fire six tabs' worth of requests. Switching tabs writes to the URL rather
 * than to local state, which is what makes the choice survive a refresh.
 */
function AdminPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();

  /**
   * Just the count, so it can sit on the "Parked Leads" tab trigger itself —
   * Radix leaves an inactive tab's content unmounted, so `ParkedLeads` never
   * queries anything until that tab is actually opened. Shares
   * `PARKED_LEADS_KEY` as the prefix, so `move_to_validation`'s existing
   * invalidation of that key (in `parked-leads.tsx`) refreshes this for free.
   */
  const parkedCount = useQuery({
    queryKey: [...PARKED_LEADS_KEY, "count"],
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
        <AppHeader
          title="Admin"
          subtitle="Admin"
          actions={
            <>
              {/* Not a read-only copy of the queue — /manager already admits
                  admins, so this lands on the real screen with assign, dispose
                  and archive all live. */}
              <Link to="/manager" className="chip inline-block">
                Manager View
              </Link>
              {/* Unlike Manager View, these two render read-only for admin —
                  a way to check field layout and order without logging in as
                  a closer or validator. See the `readOnly` prop on each form. */}
              <Link to="/closer" className="chip inline-block">
                Closer Form
              </Link>
              <Link to="/validator-form" className="chip inline-block">
                Validator Form
              </Link>
            </>
          }
        />

        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isAdminTab(value)) void navigate({ search: { tab: value } });
          }}
          className="flex flex-col gap-4"
        >
          <TabsList className="w-fit">
            {TABS.map((entry) => (
              <TabsTrigger key={entry.id} value={entry.id}>
                {entry.id === "parked"
                  ? `${entry.label} (${parkedCount.data ?? "…"})`
                  : entry.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview" className="flex flex-col gap-4">
            <AdminOverview />
            {/* The closing row: two health checks, side by side. Rendered here
                rather than inside ReportingStats, which the manager's Reporting
                tab also mounts — both cards are admin-only. Each is a plain
                panel and is placed from here, so neither sits alone on a
                two-sevenths-wide row of its own as they both used to. */}
            <div className="grid gap-4 md:grid-cols-2">
              <CxCoverageCard />
              {/* Whether leads are actually reaching Google Sheets. The queue in
                  decisions/0006 retries instead of dropping, which only works if
                  somebody sees a backlog that stops draining — this is that. */}
              <SheetSyncBacklogCard />
            </div>
            {/* Which carriers are turning leads away, and how often. */}
            {/* <CarrierDeclineReport /> */}
          </TabsContent>

          <TabsContent value="submissions" className="flex flex-col gap-4">
            <SubmissionsExplorer />
          </TabsContent>

          <TabsContent value="parked" className="flex flex-col gap-4">
            <ParkedLeads />
          </TabsContent>

          {/* Read-only: an admin needs to see where the submitted leads are,
              but moving one along is the CXA's job and set_cx_status refuses
              anyone outside the CX roles anyway. */}
          <TabsContent value="pipeline" className="flex flex-col gap-4">
            <CxStatusBreakdown />
            <CustomersPipeline readOnly showUpdatedBy />
            {/* Removing a lead from the pipeline is the CXA's own housekeeping,
                and restoring one is admin-only — so this is the one place the
                undo lives. */}
            <RemovedFromPipeline />
          </TabsContent>

          <TabsContent value="draft-dates" className="flex flex-col gap-4">
            <DraftDateDesk />
          </TabsContent>

          <TabsContent value="exports" className="flex flex-col gap-4">
            <Exports />
          </TabsContent>

          <TabsContent value="sales-breakdown" className="flex flex-col gap-4">
            <SalesBreakdown />
          </TabsContent>

          <TabsContent value="users" className="flex flex-col gap-4">
            <UserAdmin />
          </TabsContent>

          {/* The same component the /upload route mounts, not a second copy of
              it. The route stays for data_uploader accounts, which reach
              nothing else; this is the admin's way in. Radix leaves an inactive
              tab unmounted, so the parser and its worker only load if an admin
              actually opens this. */}
          <TabsContent value="uploads" className="flex flex-col gap-4">
            <DataUploader />
            <ImportHistory allUploaders />
          </TabsContent>

          {/* <TabsContent value="imports" className="flex flex-col gap-4">
            <ImportHistory allUploaders />
          </TabsContent> */}

          <TabsContent value="settings" className="flex flex-col gap-4">
            <AdminSettings />
            <CenterAdmin />
            <TransferClientAdmin />
            <CarrierAdmin />
            <CxStatusAdmin />
          </TabsContent>

          {/* <TabsContent value="audit" className="flex flex-col gap-4">
            <CardAccessLog />
            <SettingsAudit />
          </TabsContent> */}

          <TabsContent value="voice-clone" className="flex flex-col gap-4">
            <VoiceCloneStudio />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
