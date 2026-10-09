import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { loadAuthSnapshot } from "@/lib/auth";
import { isActiveSuspension } from "@/lib/crm-suspension";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { user, profile, suspension } = await loadAuthSnapshot();
    if (!user) throw redirect({ to: "/login" });

    if (profile?.role !== "admin" && isActiveSuspension(suspension)) {
      throw redirect({ to: "/suspended", replace: true });
    }

    return { user };
  },
  component: () => <Outlet />,
});
