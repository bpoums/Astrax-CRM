import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { fetchCrmSuspension, isActiveSuspension } from "@/lib/crm-suspension";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .maybeSingle();

    if (profile?.role !== "admin") {
      const suspension = await fetchCrmSuspension();
      if (isActiveSuspension(suspension)) throw redirect({ to: "/suspended", replace: true });
    }

    return { user: data.user };
  },
  component: () => <Outlet />,
});
