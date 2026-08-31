import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ROLE_LABEL, useAuth, type AppRole } from "@/lib/auth";
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

type ProfileRow = {
  id: string;
  full_name: string | null;
  role: AppRole;
  staff_id: string | null;
  org_name: string | null;
  active: boolean;
};

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

  const users = useQuery({
    queryKey: PROFILES_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, role, staff_id, org_name, active")
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
    }) => {
      const { error } = await supabase.functions.invoke("invite-user", { body });
      if (error) throw new Error(await readFunctionError(error, "Could not send the invite."));
    },
    onSuccess: () => {
      toast.success(`Invite sent to ${email.trim()}`);
      setEmail("");
      setFullName("");
      setStaffId("");
      setOrgName("");
      setRole("closer");
      queryClient.invalidateQueries({ queryKey: PROFILES_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
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
    invite.mutate({
      email: email.trim(),
      full_name: fullName.trim(),
      staff_id: staffId.trim(),
      org_name: orgName.trim(),
      role,
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
              <TableHead className="w-52">Center / Organisation</TableHead>
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
                <TableCell colSpan={5} className="text-center text-muted-foreground">
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
 * The centre, edited in place.
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
