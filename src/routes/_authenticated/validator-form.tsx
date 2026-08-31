import { createFileRoute } from "@tanstack/react-router";
import { requireRole } from "@/lib/auth";
import { ValidatorForm } from "@/components/validator-form";

export const Route = createFileRoute("/_authenticated/validator-form")({
  beforeLoad: () => requireRole(["validator", "manager", "admin"]),
  head: () => ({
    meta: [
      { title: "Validator's Form | ASTRAX" },
      {
        name: "description",
        content:
          "Per-carrier validator intake form — customer, banking and policy details in one view.",
      },
      { property: "og:title", content: "Validator's Form | ASTRAX" },
      {
        property: "og:description",
        content: "Per-carrier validator intake form for ASTRAX.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ValidatorForm,
});
