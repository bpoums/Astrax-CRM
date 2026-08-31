import { createFileRoute } from "@tanstack/react-router";
import { CustomersPipeline } from "@/components/customers-pipeline";
import { CxPlaceholder, CxTabs, isCxTab, type CxTab } from "@/components/cx-shell";

/**
 * All four CX pipelines live at this one URL and are switched by ?tab=, so the
 * segmented control can sit under the header without a page change and a link
 * still carries the reader to the right pipeline.
 */
export const Route = createFileRoute("/_authenticated/cx/")({
  validateSearch: (search: Record<string, unknown>): { tab: CxTab } => {
    // noPropertyAccessFromIndexSignature: index access, not dot access.
    const tab = search["tab"];
    return { tab: isCxTab(tab) ? tab : "customers" };
  },
  head: () => ({
    meta: [
      { title: "Customers Pipeline | ASTRAX" },
      {
        name: "description",
        content: "Approved leads, tagged and worked through by the CX team.",
      },
      { property: "og:title", content: "Customers Pipeline | ASTRAX" },
      { property: "og:description", content: "Approved leads worked through by the CX team." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CxWorkspace,
});

function CxWorkspace() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <>
      <CxTabs
        active={tab}
        onSelect={(next) => {
          // replace: switching pipelines is not a step worth a back-button stop.
          void navigate({ search: { tab: next }, replace: true });
        }}
      />

      {tab === "customers" ? <CustomersPipeline /> : null}
      {tab === "transfer" ? <CxPlaceholder title="Transfer Pipeline" /> : null}
      {tab === "chargeback" ? <CxPlaceholder title="Chargeback Pipeline" /> : null}
      {tab === "analytics" ? <CxPlaceholder title="Analytics" /> : null}
    </>
  );
}
