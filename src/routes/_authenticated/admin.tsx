import { createFileRoute, Link } from "@tanstack/react-router";
import { requireRole } from "@/lib/auth";
import { AppHeader } from "@/components/ops";
import { ReportingStats, SubmissionsExplorer } from "@/components/reporting";
import { CustomersPipeline } from "@/components/customers-pipeline";
import { CxStatusBreakdown, CxCoverageCard } from "@/components/cx-status-breakdown";
import { UserAdmin } from "@/components/user-admin";
import { DataUploader } from "@/components/data-uploader";
import { ImportHistory } from "@/components/import-history";
import { CardAccessLog } from "@/components/card-access-log";
import { SettingsAudit } from "@/components/settings-audit";
import { AdminSettings } from "@/components/admin-settings";
import { CxStatusAdmin } from "@/components/cx-status-admin";
import { CarrierAdmin } from "@/components/carrier-admin";
import { CenterAdmin } from "@/components/center-admin";
import { CarrierDeclineReport } from "@/components/carrier-declines";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "submissions", label: "Submissions" },
  { id: "pipeline", label: "Customer Pipeline" },
  { id: "users", label: "Users" },
  { id: "uploads", label: "Uploads" },
  // { id: "imports", label: "Imports" },
  { id: "settings", label: "Settings" },
  // { id: "audit", label: "Audit" },
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

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-8 lg:py-5">
        <AppHeader
          title="Admin"
          subtitle="Admin"
          actions={
            /* Not a read-only copy of the queue — /manager already admits
               admins, so this lands on the real screen with assign, dispose
               and archive all live. */
            <Link to="/manager" className="chip inline-block">
              Manager View
            </Link>
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
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview" className="flex flex-col gap-4">
            <ReportingStats showValidatorSubmissions />
            {/* Rendered here rather than inside ReportingStats, which the
                manager's Reporting tab also mounts — this card is admin-only. */}
            <CxCoverageCard />
            {/* Which carriers are turning leads away, and how often. */}
            {/* <CarrierDeclineReport /> */}
          </TabsContent>

          <TabsContent value="submissions" className="flex flex-col gap-4">
            <SubmissionsExplorer />
          </TabsContent>

          {/* Read-only: an admin needs to see where the submitted leads are,
              but moving one along is the CXA's job and set_cx_status refuses
              anyone outside the CX roles anyway. */}
          <TabsContent value="pipeline" className="flex flex-col gap-4">
            <CxStatusBreakdown />
            <CustomersPipeline readOnly showUpdatedBy />
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
            <CarrierAdmin />
            <CxStatusAdmin />
          </TabsContent>

          {/* <TabsContent value="audit" className="flex flex-col gap-4">
            <CardAccessLog />
            <SettingsAudit />
          </TabsContent> */}
        </Tabs>
      </div>
    </main>
  );
}
