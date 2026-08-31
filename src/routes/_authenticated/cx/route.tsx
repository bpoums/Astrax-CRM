import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireRole } from "@/lib/auth";
import { CxShell } from "@/components/cx-shell";

/**
 * The CX workspace layout. Every pipeline is a child route, so the sidebar and
 * the guard are declared once and the three unbuilt pipelines are already
 * routable.
 *
 * Admin is allowed in alongside the two CX roles: they administer the tag
 * vocabulary these screens consume, and they are currently the only role whose
 * RLS lets the lead timeline resolve.
 */
export const Route = createFileRoute("/_authenticated/cx")({
  beforeLoad: () => requireRole(["cxa", "cxm", "admin"]),
  component: CxLayout,
});

function CxLayout() {
  return (
    <CxShell>
      <Outlet />
    </CxShell>
  );
}
