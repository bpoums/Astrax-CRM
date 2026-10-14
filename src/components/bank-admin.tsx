import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BANKS_KEY, bankKey, formatBankName, useBanks } from "@/lib/banks";
import { formatDate } from "@/lib/format-date";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The bank list behind the Bank Name dropdown, managed.
 *
 * Closers and validators add a bank themselves when theirs is missing, so this
 * is where a typo one of them saved gets renamed or retired. There is no delete:
 * a lead keeps the bank name it was saved with, and removing a row would only
 * hide a bank from the list. Deactivating takes it out of the dropdown;
 * renaming changes what the dropdown offers and does not rewrite leads that
 * already carry the old spelling.
 *
 * Every write is an RPC (`add_bank`, `admin_rename_bank`,
 * `admin_set_bank_active`) that re-checks the caller is an admin.
 */
export function BankAdmin() {
  const queryClient = useQueryClient();
  // All of them, not just active: this is where a bank is brought back.
  const banks = useBanks(false);
  const rows = banks.data ?? [];

  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: BANKS_KEY });

  const create = useMutation({
    mutationFn: async (value: string) => {
      const { error } = await supabase.rpc("add_bank", { p_name: value });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Bank added");
      setName("");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rename = useMutation({
    mutationFn: async (vars: { id: string; name: string }) => {
      const { error } = await supabase.rpc("admin_rename_bank", {
        p_id: vars.id,
        p_name: vars.name,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Bank renamed");
      setEditingId(null);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const setActive = useMutation({
    mutationFn: async (vars: { id: string; active: boolean }) => {
      const { error } = await supabase.rpc("admin_set_bank_active", {
        p_id: vars.id,
        p_active: vars.active,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.active ? "Bank reactivated" : "Bank deactivated");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const busy = create.isPending || rename.isPending || setActive.isPending;

  const needle = bankKey(search);
  const shown = needle
    ? rows.filter(
        (bank) =>
          bankKey(bank.name).includes(needle) ||
          bank.aliases.some((alias) => bankKey(alias).includes(needle)),
      )
    : rows;

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formatted = formatBankName(name);
    if (formatted) create.mutate(formatted);
  }

  function saveEdit(id: string) {
    const trimmed = draft.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      toast.error("A bank needs a name.");
      return;
    }
    rename.mutate({ id, name: trimmed });
  }

  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Banks ({rows.length})</h2>
        <span className="text-[0.66rem] text-muted-foreground">
          The list behind the Bank Name dropdown on the closer and validator forms.
        </span>
      </div>

      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
          <label htmlFor="bank-name" className="field-label">
            Bank name<span className="text-accent"> *</span>
          </label>
          <input
            id="bank-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="field-input"
            placeholder="Example Federal Credit Union"
            autoComplete="off"
            required
          />
        </div>
        <button type="submit" className="btn-submit" disabled={busy || !name.trim()}>
          {create.isPending ? "Adding…" : "Add bank"}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
          <label htmlFor="bank-search" className="field-label">
            Search
          </label>
          <input
            id="bank-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="field-input"
            placeholder="Filter the list"
            autoComplete="off"
          />
        </div>
      </form>

      <p className="text-[0.66rem] text-muted-foreground">
        A closer or validator can add a bank from the form itself; it appears here straight away so
        a typo can be fixed. A bank cannot be deleted. Deactivating takes it out of the dropdown,
        and renaming changes what the dropdown offers; leads already saved keep the name they were
        saved with.
      </p>

      {banks.isError ? (
        <p className="text-xs text-destructive">{(banks.error as Error).message}</p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bank</TableHead>
                <TableHead className="w-32">Added</TableHead>
                <TableHead className="w-20">Active</TableHead>
                <TableHead className="w-44 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((bank) =>
                editingId === bank.id ? (
                  <TableRow key={bank.id}>
                    <TableCell>
                      <input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        className="field-input"
                        aria-label="Bank name"
                        autoFocus
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            saveEdit(bank.id);
                          }
                          if (event.key === "Escape") setEditingId(null);
                        }}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {bank.created_by ? formatDate(bank.created_at) : "Seeded"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {bank.active ? "Yes" : "No"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="chip px-2.5 py-0.5 text-[0.66rem]"
                          disabled={busy}
                          onClick={() => saveEdit(bank.id)}
                        >
                          {rename.isPending ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          className="chip px-2.5 py-0.5 text-[0.66rem]"
                          disabled={busy}
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={bank.id}>
                    <TableCell className={bank.active ? "font-medium" : "font-medium opacity-50"}>
                      {bank.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {bank.created_by ? formatDate(bank.created_at) : "Seeded"}
                    </TableCell>
                    <TableCell
                      className={bank.active ? "text-muted-foreground" : "text-destructive"}
                    >
                      {bank.active ? "Yes" : "No"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="chip px-2.5 py-0.5 text-[0.66rem]"
                          disabled={busy}
                          onClick={() => {
                            setEditingId(bank.id);
                            setDraft(bank.name);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="chip px-2.5 py-0.5 text-[0.66rem] text-muted-foreground"
                          disabled={busy}
                          title={
                            bank.active
                              ? "Takes it out of the dropdown; leads already saved are untouched"
                              : "Puts it back in the dropdown"
                          }
                          onClick={() => setActive.mutate({ id: bank.id, active: !bank.active })}
                        >
                          {bank.active ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              )}
              {shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    {banks.isLoading ? "Loading…" : search ? "No bank matches." : "No banks yet."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
