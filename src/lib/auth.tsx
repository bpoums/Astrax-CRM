import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { redirect, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

/**
 * Read from the generated enum rather than restated, so adding a role in the
 * database and running `npm run types` makes the compiler point at every map
 * and guard that has not accounted for it yet.
 */
export type AppRole = Database["public"]["Enums"]["app_role"];

export type Profile = {
  id: string;
  full_name: string | null;
  role: AppRole;
  active: boolean;
};

type AuthValue = {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue>({
  session: null,
  profile: null,
  loading: true,
  signOut: async () => {},
});

export const roleHome: Record<AppRole, string> = {
  closer: "/closer",
  manager: "/manager",
  validator: "/validator",
  admin: "/admin",
  data_uploader: "/upload",
  // Both CX roles land on the same screen for now. When the CX manager gets
  // their own view this is the one line that has to move.
  cxm: "/cx",
  cxa: "/cx",
  closing_manager: "/closing",
};

export const ROLE_LABEL: Record<AppRole, string> = {
  closer: "closer",
  manager: "manager",
  validator: "validator",
  admin: "admin",
  data_uploader: "data uploader",
  cxm: "CX manager",
  cxa: "CX agent",
  closing_manager: "closing manager",
};

/**
 * Route guard for `beforeLoad`. RLS is still what actually protects the data;
 * this keeps a role out of a screen that would only ever show them an empty one
 * — and it is what confines a data uploader to /upload.
 */
export async function requireRole(allowed: AppRole[]) {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw redirect({ to: "/login" });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  const role = (profile?.role as AppRole | undefined) ?? "closer";
  if (!allowed.includes(role)) throw redirect({ to: roleHome[role], replace: true });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    let active = true;

    async function loadProfile(userId: string | undefined) {
      if (!userId) {
        if (active) setProfile(null);
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, role, active")
        .eq("id", userId)
        .maybeSingle();
      if (active) setProfile((data as Profile) ?? null);
    }

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      await loadProfile(data.session?.user.id);
      if (active) setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      setSession(nextSession);
      void loadProfile(nextSession?.user.id);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    navigate({ to: "/login", replace: true });
  };

  return (
    <AuthContext.Provider value={{ session, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
