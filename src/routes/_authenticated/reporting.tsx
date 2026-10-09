import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { requireRole, useAuth } from "@/lib/auth";
import { AppHeader } from "@/components/ops";
import { OverviewPanels } from "@/components/overview-panels";
import { PeriodPicker } from "@/components/period-picker";
import { ValidatorsTeamDashboard } from "@/components/reporting";
import { SalesBreakdown } from "@/components/sales-breakdown";
import { usePeriod } from "@/lib/period-range";
import { useOverviewStats } from "@/lib/overview-stats";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The Reporting Manager's only screen: read-only, business-wide, nothing to
 * assign/dispose/edit anywhere on it — the role has no write RPC granted to
 * it at all (see `docs/database.md`).
 *
 * "Reporting" is exactly four pieces named at this role's creation —
 * All-time Submissions, Submissions Outcome, L.A. Operations (all three are
 * `OverviewPanels`, shared with the admin Overview and the manager's
 * Reporting tab) and the Validators Team Dashboard (pulled out of
 * `ReportingStats` into its own export for this). Deliberately NOT included:
 * `TotalsPanel` ("the record" strip) and `SubmissionsExplorer` (the
 * searchable lead table) — neither was asked for, and `AdminOverview`
 * already mounts `OverviewPanels` without `TotalsPanel` beside it.
 *
 * The window defaults to `usePeriod()`'s "All time" and is changeable through
 * the shared `PeriodPicker` chips (Today / 7 Days / 30 Days / All Time /
 * Custom); it applies to the three overview panels and the validators table.
 *
 * "Sales Breakdown" is `SalesBreakdown` unchanged, the same component the
 * admin tab of that name mounts — it fetches its own data and manages its
 * own period chips independently of the Reporting tab's window.
 */

const REPORTING_TAB = "reporting";
const SALES_TAB = "sales-breakdown";

type ReportingManagerTab = typeof REPORTING_TAB | typeof SALES_TAB;

function isReportingManagerTab(value: unknown): value is ReportingManagerTab {
  return value === REPORTING_TAB || value === SALES_TAB;
}

export const Route = createFileRoute("/_authenticated/reporting")({
  beforeLoad: () => requireRole(["reporting_manager", "admin"]),
  validateSearch: (search: Record<string, unknown>): { tab: ReportingManagerTab } => ({
    tab: isReportingManagerTab(search["tab"]) ? search["tab"] : REPORTING_TAB,
  }),
  head: () => ({
    meta: [
      { title: "Reporting | ASTRAX" },
      {
        name: "description",
        content: "Business-wide submissions, validator performance and sales breakdown.",
      },
      { property: "og:title", content: "Reporting | ASTRAX" },
      {
        property: "og:description",
        content: "Business-wide submissions, validator performance and sales breakdown.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ReportingManagerPage,
});

function ReportingManagerPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { profile } = useAuth();

  const period = usePeriod();
  const { heading } = period;
  const stats = useOverviewStats(period);
  const { validatorStats, centerTotals } = stats;

  const perValidator = useMemo(() => validatorStats.data ?? [], [validatorStats.data]);
  const perCenter = useMemo(() => centerTotals.data ?? [], [centerTotals.data]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-8 lg:py-5">
        <AppHeader
          title="Reporting"
          subtitle="Reporting"
          actions={
            /* The way back, and only for an admin — a reporting manager has no
               /admin to return to and the route would bounce them straight back. */
            profile?.role === "admin" ? (
              <Link to="/admin" search={{ tab: "overview" }} className="chip inline-block">
                Back to Admin
              </Link>
            ) : null
          }
        />

        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isReportingManagerTab(value)) void navigate({ search: { tab: value } });
          }}
          className="flex flex-col gap-4"
        >
          <TabsList className="w-fit">
            <TabsTrigger value={REPORTING_TAB}>Reporting</TabsTrigger>
            <TabsTrigger value={SALES_TAB}>Sales Breakdown</TabsTrigger>
          </TabsList>

          <TabsContent value={REPORTING_TAB} className="flex flex-col gap-4">
            <PeriodPicker period={period} />
            <OverviewPanels period={period} stats={stats} centers={perCenter} />
            <ValidatorsTeamDashboard
              perValidator={perValidator}
              isLoading={validatorStats.isLoading}
              heading={heading}
            />
          </TabsContent>

          <TabsContent value={SALES_TAB} className="flex flex-col gap-4">
            <SalesBreakdown />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
