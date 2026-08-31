import { createFileRoute } from "@tanstack/react-router";
import { requireRole } from "@/lib/auth";
import { ForwardedLeads } from "@/components/forwarded-leads";

// The same roles that can reach /closer, since this is the other half of that
// screen: whoever may enter a lead may look up what became of the ones they
// entered. A data uploader is still confined to /upload.
export const Route = createFileRoute("/_authenticated/forwarded-leads")({
  beforeLoad: () => requireRole(["closer", "manager", "validator", "admin"]),
  head: () => ({
    meta: [
      { title: "Forwarded Leads | ASTRAX" },
      {
        name: "description",
        content: "Every lead you have forwarded, and where each one got to.",
      },
      { property: "og:title", content: "Forwarded Leads | ASTRAX" },
      {
        property: "og:description",
        content: "Track the leads you have forwarded for review.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ForwardedLeads,
});
