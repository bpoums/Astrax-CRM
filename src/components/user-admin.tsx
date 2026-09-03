import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ROLE_LABEL, useAuth, type AppRole } from "@/lib/auth";
import { centerRequired, useCenters, type Center } from "@/lib/centers";
import { readFunctionError } from "@/lib/function-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Drives both the Add User chips and the inline role select, so a role added
// here appears in both places.
const ROLES: AppRole[] = [
  "closer",
  "validator",
  "manager",
  "closing_manager",
  "data_uploader",
  "cxa",
  "cxm",
  "admin",
];

const PROFILES_KEY = ["admin", "profiles"];

/**
 * Radix will not take an empty string as a Select value, and "no centre" is a
 * real choice on the inline editor — a uuid column can never collide with it.
 */
const NO_CENTER = "none";

type ProfileRow = {
  id: string;
  full_name: string | null;
  role: AppRole;
  staff_id: string | null;
  org_name: string | null;
  center_id: string | null;
  active: boolean;
};

/**
 * The invite function does not set the centre.
 *
 * `invite-user` holds the service role key and takes email, name, staff id and
 * role; `center_id` is not one of its arguments, so it is written straight to
 * `profiles` afterwards — the same admin-only update the role select beside it
 * uses. That makes the invite two writes, and the second one is reported on its
 * own: an account that exists without its centre is recoverable from the table
 * below, but only if whoever sent the invite is told.
 */
function invitedUserId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>)["user_id"];
  return typeof id === "string" ? id : null;
}

/**
 * Invites go through the `invite-user` edge function, which holds the service
 * role key server-side and re-checks that the caller is an admin. The browser
 * never creates accounts itself.
 */
export function UserAdmin() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [staffId, setStaffId] = useState("");
  const [orgName, setOrgName] = useState("");
  const [role, setRole] = useState<AppRole>("closer");
  const [centerId, setCenterId] = useState("");

  /**
   * All of them, active or not — the table has to name the centre someone is
   * already on even after it has been retired. The invite form takes only the
   * active ones: nobody starting work today should be added to a closed centre.
   */
  const centers = useCenters(false);
  const activeCenters = useMemo(
    () => (centers.data ?? []).filter((center) => center.active),
    [centers.data],
  );
  const centerNeeded = centerRequired(role);

  const users = useQuery({
    queryKey: PROFILES_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, role, staff_id, org_name, center_id, active")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as ProfileRow[];
    },
  });

  const invite = useMutation({
    mutationFn: async (body: {
      email: string;
      full_name: string;
      staff_id: string;
      org_name: string;
      role: AppRole;
      center_id: string;
    }) => {
      const { center_id, ...invited } = body;
      const { data, error } = await supabase.functions.invoke("invite-user", { body: invited });
      if (error) throw new Error(await readFunctionError(error, "Could not send the invite."));
      if (!center_id) return;

      const userId = invitedUserId(data);
      if (!userId) {
        throw new Error("Invited, but the center was not set — set it in the table below.");
      }
      const { error: centerError } = await supabase
        .from("profiles")
        .update({ center_id })
        .eq("id", userId);
      if (centerError) {
        throw new Error(`Invited, but the center was not set: ${centerError.message}`);
      }
    },
    onSuccess: () => {
      toast.success(`Invite sent to ${email.trim()}`);
      setEmail("");
      setFullName("");
      setStaffId("");
      setOrgName("");
      setRole("closer");
      setCenterId("");
    },
    onError: (error: Error) => toast.error(error.message),
    // The account may exist even when this reports a failure — the centre is a
    // second write. Refresh the list either way so the row is there to fix.
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });

  /**
   * The centre, saved on blur.
   *
   * Same direct `profiles` update the role select uses — RLS limits both to an
   * admin. An empty box stores NULL rather than an empty string, so
   * `sourceLabel()` falls through to the person's own name instead of rendering
   * a blank badge.
   */
  const changeOrg = useMutation({
    mutationFn: async (vars: { id: string; org_name: string }) => {
      const { error } = await supabase
        .from("profiles")
        .update({ org_name: vars.org_name.trim() || null })
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Centre updated");
      queryClient.invalidateQueries({ queryKey: PROFILES_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  /**
   * The centre, from the picker in the table.
   *
   * Direct at `profiles`, like the role select — RLS limits both to an admin.
   * It matters most for a closing manager: the submissions read policy compares
   * their `center_id` against each lead's, and a null one matches nothing at
   * all, so correcting it here is what turns their desk back on.
   */
  const changeCenter = useMutation({
    mutationFn: async (vars: { id: string; center_id: string | null }) => {
      const { error } = await supabase
        .from("profiles")
        .update({ center_id: vars.center_id })
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Center updated");
      queryClient.invalidateQueries({ queryKey: PROFILES_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // RLS already limits this to admins; the UI just mirrors that.
  const changeRole = useMutation({
    mutationFn: async (vars: { id: string; role: AppRole }) => {
      const { error } = await supabase
        .from("profiles")
        .update({ role: vars.role })
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      toast.success(`Role set to ${ROLE_LABEL[vars.role]}`);
      queryClient.invalidateQueries({ queryKey: PROFILES_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (profile?.role !== "admin") return null;

  function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A closer stamps their centre on every lead they submit and a closing
    // manager sees only their own centre's leads, so neither account is usable
    // without one. Refused here rather than invited and left half-set.
    if (centerNeeded && !centerId) {
      toast.error(`A ${ROLE_LABEL[role]} needs a center.`);
      return;
    }
    invite.mutate({
      email: email.trim(),
      full_name: fullName.trim(),
      staff_id: staffId.trim(),
      org_name: orgName.trim(),
      role,
      // Only where it means something — nothing reads it for the other roles.
      center_id: centerNeeded ? centerId : "",
    });
  }

  const rows = users.data ?? [];

  return (
    <>
      <section className="panel">
        <h2 className="panel-title">Add user</h2>
        <form onSubmit={handleInvite} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-email" className="field-label">
              Email<span className="text-accent"> *</span>
            </label>
            <input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field-input"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-name" className="field-label">
              Full name
            </label>
            <input
              id="invite-name"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="field-input"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-staff-id" className="field-label">
              Staff ID
            </label>
            <input
              id="invite-staff-id"
              type="text"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              className="field-input"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-org" className="field-label">
              Center / Organisation
            </label>
            <input
              id="invite-org"
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className="field-input"
              autoComplete="off"
            />
            <span className="text-[0.62rem] text-muted-foreground">
              Optional. Shown as the source of any leads this account uploads.
            </span>
          </div>
          {/* Only for the roles it means anything to — a validator's centre is
              read by nothing, and an optional field that changes no behaviour
              is one more box to get wrong. */}
          {centerNeeded ? (
            <div className="flex flex-col gap-1">
              <label htmlFor="invite-center" className="field-label">
                Center<span className="text-accent"> *</span>
              </label>
              <Select value={centerId} onValueChange={setCenterId}>
                <SelectTrigger id="invite-center" className="h-9 text-xs">
                  <SelectValue placeholder="Select a center…" />
                </SelectTrigger>
                <SelectContent>
                  {activeCenters.map((center) => (
                    <SelectItem key={center.id} value={center.id}>
                      {center.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[0.62rem] text-muted-foreground">
                {centers.isError
                  ? (centers.error as Error).message
                  : activeCenters.length === 0 && !centers.isLoading
                    ? "No active centers — add one under Settings first."
                    : role === "closing_manager"
                      ? "The closing desk shows this center's leads and no others."
                      : "Stamped on every lead this closer submits."}
              </span>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <span className="field-label">Role</span>
            <div className="flex flex-wrap gap-1.5">
              {ROLES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setRole(option)}
                  aria-pressed={role === option}
                  className={role === option ? "chip chip-active" : "chip"}
                >
                  {ROLE_LABEL[option]}
                </button>
              ))}
            </div>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" className="btn-submit" disabled={invite.isPending}>
              {invite.isPending ? "Inviting…" : "Send invite"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2 className="panel-title">Users ({rows.length})</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Staff ID</TableHead>
              <TableHead className="w-44">Center</TableHead>
              {/* Free text, and a different thing from the centre beside it:
                  this is the label put on leads the account uploads. */}
              <TableHead className="w-52">Upload Source</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="w-44">Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.full_name ?? user.id}</TableCell>
                <TableCell className="text-muted-foreground">{user.staff_id ?? "—"}</TableCell>
                <TableCell>
                  <CenterCell
                    user={user}
                    centers={centers.data ?? []}
                    disabled={changeCenter.isPending}
                    onChange={(center_id) => changeCenter.mutate({ id: user.id, center_id })}
                  />
                </TableCell>
                <TableCell>
                  <OrgCell
                    id={user.id}
                    value={user.org_name}
                    disabled={changeOrg.isPending}
                    onSave={(org_name) => changeOrg.mutate({ id: user.id, org_name })}
                  />
                </TableCell>
                <TableCell className={user.active ? "text-muted-foreground" : "text-destructive"}>
                  {user.active ? "Yes" : "No"}
                </TableCell>
                <TableCell>
                  <Select
                    value={user.role}
                    disabled={changeRole.isPending}
                    onValueChange={(value) =>
                      changeRole.mutate({ id: user.id, role: value as AppRole })
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((option) => (
                        <SelectItem key={option} value={option}>
                          {ROLE_LABEL[option]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  {users.isLoading ? "Loading…" : "No users yet."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </section>
    </>
  );
}

/**
 * One person's centre, corrected in place.
 *
 * The picker is only drawn for the roles a centre is read for; everyone else
 * gets a dash, because setting one on them would change nothing. Changing a
 * role in the select beside this is what makes the picker appear.
 *
 * A closer or closing manager with no centre is drawn destructive rather than
 * as a quiet dash — for a closing manager it is the whole reason their desk is
 * empty, and that is not a state to leave looking normal. A centre that has
 * since been deactivated still shows its own name: the person really is on it,
 * and rendering a blank would read as "not set".
 */
function CenterCell({
  user,
  centers,
  disabled,
  onChange,
}: {
  user: { role: AppRole; center_id: string | null };
  centers: Center[];
  disabled: boolean;
  onChange: (centerId: string | null) => void;
}) {
  if (!centerRequired(user.role)) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const missing = !user.center_id;
  // The active list, plus whatever this person is already on. A retired centre
  // is not offered to anyone new, but it has to stay in the list of the one
  // account sitting on it or the trigger would render blank.
  const options = centers.filter((center) => center.active || center.id === user.center_id);

  return (
    <div className="flex flex-col gap-0.5">
      <Select
        value={user.center_id ?? NO_CENTER}
        disabled={disabled}
        onValueChange={(value) => onChange(value === NO_CENTER ? null : value)}
      >
        <SelectTrigger className="h-8 text-xs" aria-label="Center">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_CENTER}>Not set</SelectItem>
          {options.map((center) => (
            <SelectItem key={center.id} value={center.id}>
              {center.name}
              {center.active ? "" : " (inactive)"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {missing ? (
        <span className="text-[0.62rem] text-destructive">
          {user.role === "closing_manager" ? "Sees no leads until set" : "No center on their leads"}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The upload source, edited in place.
 *
 * Committed on blur rather than per keystroke — a half-typed name is not a
 * value worth writing, and this is a free text field, not a picker like the
 * role select beside it. The box tracks the stored value so a refetch after
 * someone else's edit is picked up, without discarding what is being typed.
 */
function OrgCell({
  id,
  value,
  disabled,
  onSave,
}: {
  id: string;
  value: string | null;
  disabled: boolean;
  onSave: (value: string) => void;
}) {
  const stored = value ?? "";
  const [draft, setDraft] = useState(stored);

  useEffect(() => {
    setDraft(stored);
  }, [stored, id]);

  return (
    <input
      type="text"
      value={draft}
      disabled={disabled}
      placeholder="—"
      aria-label="Center or organisation"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() === stored.trim()) return;
        onSave(draft);
      }}
      className="field-input h-8 text-xs"
      autoComplete="off"
    />
  );
}
