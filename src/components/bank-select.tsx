import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BANKS_KEY, findBank, formatBankName, useBanks } from "@/lib/banks";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * The Bank Name field on both intake forms: a searchable list with a way to add
 * a bank that is not in it.
 *
 * The value is the bank NAME, as a plain string, because that string is the
 * Sheet cell; the field's label stays the payload key. Typing filters on the
 * name and on the aliases, so "Chase" finds "Chase Bank" and "Wels Fargo" finds
 * "Wells Fargo". When what was typed is not in the list, the last row offers to
 * add it: the name is written in Title Case, saved for everyone through the
 * `add_bank` RPC, and selected.
 */
export function BankSelect({
  id,
  value,
  onChange,
  allowClear = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The validator form's Bank Name is optional, so it can be emptied again. */
  allowClear?: boolean;
}) {
  const queryClient = useQueryClient();
  const banks = useBanks(true);
  const list = banks.data ?? [];

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState("");

  const typed = query.trim();
  const formatted = formatBankName(typed);
  // Offered only for text that is not already a bank, by name or by alias.
  const canAdd = typed.length >= 2 && !findBank(list, typed);

  function close() {
    setOpen(false);
    setQuery("");
    setProblem("");
  }

  function choose(name: string) {
    onChange(name);
    close();
  }

  async function addNew() {
    if (adding || !canAdd) return;
    setAdding(true);
    setProblem("");
    const { data, error } = await supabase.rpc("add_bank", { p_name: formatted });
    setAdding(false);
    if (error) {
      // The RPC's own sentence ("that is not a bank name"), not a generic one.
      setProblem(error.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: BANKS_KEY });
    choose(data?.name ?? formatted);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close();
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          className="field-input flex items-center justify-between gap-2 text-left"
        >
          <span className={value ? "truncate" : "truncate text-muted-foreground"}>
            {value || "Select bank"}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <Command>
          <CommandInput
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              setProblem("");
            }}
            placeholder="Search or type a new bank"
            aria-label="Search banks"
          />
          <CommandList>
            {banks.isLoading ? (
              <p className="px-3 py-2 text-[0.72rem] text-muted-foreground">Loading banks…</p>
            ) : banks.isError ? (
              <p className="px-3 py-2 text-[0.72rem] font-semibold text-destructive">
                {(banks.error as Error).message}
              </p>
            ) : list.length === 0 && !canAdd ? (
              <p className="px-3 py-2 text-[0.72rem] text-muted-foreground">
                No banks yet — type a name to add one.
              </p>
            ) : null}

            <CommandGroup>
              {list.map((bank) => (
                <CommandItem
                  key={bank.id}
                  // The name is the value; the aliases are what else it answers to.
                  value={bank.name}
                  keywords={bank.aliases}
                  // The row's own name, not cmdk's value argument, which is
                  // lower-cased in some versions and is the Sheet cell here.
                  onSelect={() => choose(bank.name)}
                >
                  {bank.name}
                </CommandItem>
              ))}
            </CommandGroup>

            {canAdd || (allowClear && value) ? (
              <CommandGroup>
                {canAdd ? (
                  <CommandItem forceMount value="__add_new_bank__" onSelect={addNew}>
                    {adding ? "Adding…" : `+ Add “${formatted}” as a new bank`}
                  </CommandItem>
                ) : null}
                {allowClear && value ? (
                  <CommandItem forceMount value="__clear_bank__" onSelect={() => choose("")}>
                    Clear selection
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}

            {problem ? (
              <p className="px-3 py-2 text-[0.72rem] font-semibold text-destructive">{problem}</p>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
