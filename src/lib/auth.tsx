import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { redirect, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import {
  fetchCrmSuspension,
  isActiveSuspension,
  subscribeToCrmSuspension,
  type CrmSuspension,
} from "@/lib/crm-suspension";

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
  /**
   * The centre this person belongs to, null where none has been set. Nothing
   * client-side is allowed to scope a query with it — the submissions read
   * policy already does that server-side — but a closing manager whose desk is
   * empty because this is unset needs to be told which of the two it is.
   */
  center_id: string | null;
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
  // The same desk, with a wider scope. The difference between the two is the
  // submissions read policy, not the screen, so there is one route for both.
  general_manager: "/closing",
  // Read-only, business-wide reporting — no queue, no edit controls.
  reporting_manager: "/reporting",
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
  general_manager: "general manager",
  reporting_manager: "reporting manager",
};

export type AuthSnapshot = {
  user: User | null;
  profile: Profile | null;
  suspension: CrmSuspension | null;
};

/**
 * Who is signed in, their profile, and whether the CRM is suspended — read once
 * and shared. Every route guard, `index.tsx` and `AuthProvider` used to fetch
 * these three facts independently and *sequentially* (`getUser()` is a network
 * round trip, then `profiles`, then `crm_suspension`, repeated by the parent and
 * again by the child route), which put several seconds of serial requests in
 * front of every page load. Now: the session is read locally, `profiles` and
 * `crm_suspension` go out in parallel, concurrent callers share the in-flight
 * promise, and the result is reused for a few seconds.
 *
 * The guards that use this are cosmetic (RLS is the boundary — see
 * `docs/decisions/0001-rls-as-the-only-boundary.md`), so reading the session
 * locally instead of asking the auth server to validate it on every navigation
 * does not weaken anything. A role change or deactivation is picked up within
 * the TTL, and sign-in/out/user-update events drop the cache immediately.
 */
const SNAPSHOT_TTL_MS = 10_000;
let snapshotPromise: Promise<AuthSnapshot> | null = null;
let snapshotAt = 0;

export function invalidateAuthSnapshot() {
  snapshotPromise = null;
}

export function loadAuthSnapshot(): Promise<AuthSnapshot> {
  if (snapshotPromise && Date.now() - snapshotAt < SNAPSHOT_TTL_MS) return snapshotPromise;

  snapshotAt = Date.now();
  const promise = (async (): Promise<AuthSnapshot> => {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user ?? null;
    // A signed-out answer is never worth reusing: the next call is probably
    // the one that follows a sign-in.
    if (!user) return { user: null, profile: null, suspension: null };

    const [profileRes, suspension] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, role, center_id, active")
        .eq("id", user.id)
        .maybeSingle(),
      fetchCrmSuspension(),
    ]);
    return { user, profile: (profileRes.data as Profile | null) ?? null, suspension };
  })();

  snapshotPromise = promise;
  promise.then(
    (snapshot) => {
      if (!snapshot.user || !snapshot.profile) {
        if (snapshotPromise === promise) snapshotPromise = null;
      }
    },
    () => {
      if (snapshotPromise === promise) snapshotPromise = null;
    },
  );
  return promise;
}

// Registered at module load, so it runs before any listener `AuthProvider`
// adds and a guard can never see the previous user's snapshot after a switch.
// The callback only clears a variable — supabase-js must not be called from
// inside it.
if (typeof window !== "undefined") {
  supabase.auth.onAuthStateChange((event) => {
    if (
      event === "SIGNED_IN" ||
      event === "SIGNED_OUT" ||
      event === "USER_UPDATED" ||
      event === "TOKEN_REFRESHED"
    ) {
      invalidateAuthSnapshot();
    }
  });
}

/**
 * Route guard for `beforeLoad`. RLS is still what actually protects the data;
 * this keeps a role out of a screen that would only ever show them an empty one
 * — and it is what confines a data uploader to /upload.
 */
export async function requireRole(allowed: AppRole[]) {
  const { user, profile, suspension } = await loadAuthSnapshot();
  if (!user) throw redirect({ to: "/login" });

  const role = profile?.role ?? "closer";

  if (role !== "admin" && isActiveSuspension(suspension)) {
    throw redirect({ to: "/suspended", replace: true });
  }

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
      let snapshot = await loadAuthSnapshot();
      if (snapshot.user?.id !== userId) {
        // Another user's (or an empty) snapshot — never show their profile.
        invalidateAuthSnapshot();
        snapshot = await loadAuthSnapshot();
      }
      if (active) setProfile(snapshot.user?.id === userId ? snapshot.profile : null);
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
    invalidateAuthSnapshot();
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    navigate({ to: "/login", replace: true });
  };

  /**
   * Force-logout on a live suspension. `my_role()` already blocks every read
   * and write server-side the moment `crm_suspension` flips, but a signed-in
   * non-admin sitting on a page would otherwise just watch it go silently
   * empty. Individual deactivation gets the same treatment below, via its
   * own effects. Refs, not state, so the subscription is set up once and
   * reads the latest session/profile without resubscribing on every profile
   * change.
   */
  const sessionRef = useRef(session);
  const profileRef = useRef(profile);
  sessionRef.current = session;
  profileRef.current = profile;

  useEffect(() => {
    const kickIfSuspended = (row: CrmSuspension) => {
      if (!sessionRef.current) return;
      if (profileRef.current?.role === "admin") return;
      if (!isActiveSuspension(row)) return;
      void signOut().then(() => navigate({ to: "/suspended", replace: true }));
    };

    void loadAuthSnapshot().then(({ suspension }) => {
      if (suspension) kickIfSuspended(suspension);
    });

    return subscribeToCrmSuspension(queryClient, kickIfSuspended);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The equivalent kick for individual deactivation — same job as the
   * suspension effect above, but there's no separate lookup table to poll:
   * `profiles.active` is already part of the profile this provider loads.
   * A full `window.location` redirect, not the router's `navigate`, because
   * `/login` has no typed search schema for the `?reason=` flag and a hard
   * reload is fine (arguably safer) for a forced security sign-out.
   */
  useEffect(() => {
    if (profile && !profile.active) {
      void signOut().then(() => {
        window.location.href = "/login?reason=deactivated";
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    const uid = session?.user.id;
    if (!uid) return;
    const channel = supabase
      .channel(`profile-deactivation-${uid}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${uid}` },
        (payload) => {
          const row = payload.new as { active: boolean };
          if (!row.active) {
            void signOut().then(() => {
              window.location.href = "/login?reason=deactivated";
            });
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  return (
    <AuthContext.Provider value={{ session, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
