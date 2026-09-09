import { createFileRoute } from "@tanstack/react-router";
import { AppHeader } from "@/components/ops";
import { DataUploader } from "@/components/data-uploader";
import { ImportHistory } from "@/components/import-history";
import { requireRole } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/upload")({
  beforeLoad: () => requireRole(["data_uploader", "admin"]),
  head: () => ({
    meta: [
      { title: "Lead Uploader | ASTRAX" },
      {
        name: "description",
        content:
          "Upload a manual lead file, normalise it against the closer form fields and import it into the queue.",
      },
      { property: "og:title", content: "Lead Uploader | ASTRAX" },
      {
        property: "og:description",
        content: "Normalise and import manual lead files.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: UploadPage,
});

function UploadPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-8 lg:py-5">
        <AppHeader title="Lead Uploader" subtitle="Data" />
        <DataUploader />
        <ImportHistory />
      </div>
    </main>
  );
}
