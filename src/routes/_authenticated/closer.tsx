import { createFileRoute } from "@tanstack/react-router";
import { requireRole } from "@/lib/auth";
import { CloserForm } from "@/components/closer-form";

export const Route = createFileRoute("/_authenticated/closer")({
  beforeLoad: () => requireRole(["closer", "manager", "validator", "admin"]),
  head: () => ({
    meta: [
      { title: "Closer's Form | ASTRAX" },
      {
        name: "description",
        content:
          "Single-screen closer intake form — customer, policy and banking details in one view.",
      },
      { property: "og:title", content: "Closer's Form | ASTRAX" },
      {
        property: "og:description",
        content: "Single-screen closer intake form for ASTRAX.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CloserForm,
});
