import { useEffect, useRef, useState } from "react";
import { maskPersonName } from "@/lib/field-mask";
import {
  BENEFICIARY_LABELS,
  MAX_BENEFICIARIES,
  RELATIONSHIPS,
  parseBeneficiaries,
  serializeBeneficiaries,
  stripStructure,
  type Beneficiary,
  type BeneficiaryValues,
} from "@/lib/beneficiaries";

const OTHER = "__other__";

/**
 * The beneficiaries on both intake forms: one row per person, saved into the
 * same three payload keys the single fields used. Controlled by those three
 * strings alone (parse in, serialize out), so a form reset — all three empty —
 * returns it to one blank row with no extra bookkeeping.
 *
 * The forms keep the three fields in their `SECTIONS`, so the labels stay the
 * payload keys, the Sheet headers and the import targets; they render this
 * once, in place of those three.
 */
export function BeneficiaryGroup({
  values,
  onChange,
}: {
  values: BeneficiaryValues;
  onChange: (patch: BeneficiaryValues) => void;
}) {
  const list = parseBeneficiaries(values);
  // Rows whose relationship is being typed under "Other". A stored relationship
  // that is not in the list counts as Other too, so reopening never drops it.
  const [otherRows, setOtherRows] = useState<boolean[]>([]);
  const nameRefs = useRef<(HTMLInputElement | null)[]>([]);
  const focusRow = useRef<number | null>(null);

  const isEmpty = BENEFICIARY_LABELS.every((label) => !(values[label] ?? "").trim());
  useEffect(() => {
    if (isEmpty) setOtherRows([]);
  }, [isEmpty]);

  useEffect(() => {
    if (focusRow.current === null) return;
    nameRefs.current[focusRow.current]?.focus();
    focusRow.current = null;
  });

  const write = (next: Beneficiary[]) => onChange(serializeBeneficiaries(next));

  const update = (index: number, patch: Partial<Beneficiary>) =>
    write(list.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  const add = () => {
    if (list.length >= MAX_BENEFICIARIES) return;
    focusRow.current = list.length;
    write([...list, { name: "", relationship: "", info: "" }]);
  };

  const remove = (index: number) => {
    focusRow.current = Math.max(0, index - 1);
    setOtherRows((prev) => prev.filter((_, i) => i !== index));
    write(list.filter((_, i) => i !== index));
  };

  const setOther = (index: number, on: boolean) =>
    setOtherRows((prev) => {
      const next = [...prev];
      while (next.length < list.length) next.push(false);
      next[index] = on;
      return next;
    });

  return (
    <div className="flex flex-col gap-1.5 sm:col-span-2">
      <div className="grid grid-cols-[1fr_1fr_1.75rem] gap-x-2">
        <span className="field-label">
          Beneficiary Name<span className="text-accent"> *</span>
        </span>
        <span className="field-label">
          Beneficiary Relationship<span className="text-accent"> *</span>
        </span>
      </div>

      {list.map((entry, index) => {
        const known = (RELATIONSHIPS as readonly string[]).includes(entry.relationship);
        const showOther = Boolean(otherRows[index]) || (entry.relationship.trim() !== "" && !known);
        const selectValue = showOther ? OTHER : entry.relationship;
        const n = index + 1;

        return (
          <div
            key={index}
            className="grid grid-cols-[1fr_1fr_1.75rem] items-start gap-x-2 gap-y-1.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
          >
            <input
              ref={(node) => {
                nameRefs.current[index] = node;
              }}
              type="text"
              value={entry.name}
              onChange={(event) =>
                update(index, { name: maskPersonName(stripStructure(event.target.value)) })
              }
              onBlur={(event) => update(index, { name: maskPersonName(event.target.value).trim() })}
              placeholder="Full name"
              aria-label={`Beneficiary ${n} name`}
              autoComplete="off"
              className="field-input"
            />

            <div className="flex flex-col gap-1.5">
              <select
                value={selectValue}
                onChange={(event) => {
                  const picked = event.target.value;
                  if (picked === OTHER) {
                    setOther(index, true);
                    if (known) update(index, { relationship: "" });
                  } else {
                    setOther(index, false);
                    update(index, { relationship: picked });
                  }
                }}
                aria-label={`Beneficiary ${n} relationship`}
                className="field-input"
              >
                <option value="">Select…</option>
                {RELATIONSHIPS.map((relationship) => (
                  <option key={relationship} value={relationship}>
                    {relationship}
                  </option>
                ))}
                <option value={OTHER}>Other…</option>
              </select>
              {showOther ? (
                <input
                  type="text"
                  value={entry.relationship}
                  onChange={(event) =>
                    update(index, { relationship: stripStructure(event.target.value) })
                  }
                  placeholder="Relationship"
                  aria-label={`Beneficiary ${n} relationship, other`}
                  autoComplete="off"
                  className="field-input"
                />
              ) : null}
            </div>

            {list.length > 1 ? (
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label={`Remove beneficiary ${n}`}
                className="chip h-[1.9rem] justify-center px-0"
              >
                ×
              </button>
            ) : (
              <span />
            )}

            <textarea
              rows={1}
              value={entry.info}
              onChange={(event) => update(index, { info: stripStructure(event.target.value) })}
              onKeyDown={(event) => {
                // One line of free text per person; Enter would add a break the
                // sheet cell has to carry.
                if (event.key === "Enter") event.preventDefault();
              }}
              placeholder={
                index === 0
                  ? "Info (required): DOB, share, notes"
                  : "Info (optional): DOB, share, notes"
              }
              aria-required={index === 0}
              aria-label={`Beneficiary ${n} info`}
              className="field-input col-span-2 resize-none [field-sizing:content]"
            />
          </div>
        );
      })}

      <div className="flex items-center justify-between text-[0.68rem] text-muted-foreground">
        <button
          type="button"
          onClick={add}
          disabled={list.length >= MAX_BENEFICIARIES}
          className="font-semibold underline-offset-2 hover:underline disabled:no-underline disabled:opacity-50"
        >
          + Add beneficiary
        </button>
        <span>
          {list.length} of {MAX_BENEFICIARIES}
        </span>
      </div>
    </div>
  );
}
