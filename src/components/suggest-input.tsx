import { useId, useState, type KeyboardEvent } from "react";
import {
  joinList,
  MIN_QUERY,
  splitList,
  useSuggestions,
  type SuggestKind,
} from "@/lib/health-suggest";

/**
 * Chip list + typeahead. The value in and out is ONE comma-separated string so
 * it drops into the form's `Record<string, string>` state and the payload
 * unchanged; a value typed before this control existed simply loads as chips.
 * A term the list does not know is still accepted on Enter or comma.
 */
export function SuggestInput({
  id,
  kind,
  value,
  onChange,
}: {
  id: string;
  kind: SuggestKind;
  value: string;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const items = splitList(value);
  const suggestions = useSuggestions(kind, text).filter(
    (s) => !items.some((item) => item.toLowerCase() === s.toLowerCase()),
  );
  const showList = open && text.trim().length >= MIN_QUERY && suggestions.length > 0;

  function add(raw: string) {
    // A comma inside a name would split into two chips on the next load.
    const clean = raw.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    setText("");
    setActive(-1);
    if (!clean || items.some((item) => item.toLowerCase() === clean.toLowerCase())) return;
    onChange(joinList([...items, clean]));
  }

  function remove(index: number) {
    onChange(joinList(items.filter((_, i) => i !== index)));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && showList) {
      e.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && showList) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
    } else if (e.key === "Enter" || e.key === ",") {
      // Enter must never submit the form from inside this box.
      if (e.key === "Enter") e.preventDefault();
      if (e.key === "," && !text.trim()) {
        e.preventDefault();
        return;
      }
      if (e.key === ",") e.preventDefault();
      const picked = showList && active >= 0 ? suggestions[active] : text;
      if (picked) add(picked);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && !text && items.length > 0) {
      remove(items.length - 1);
    }
  }

  return (
    <div className="relative flex flex-col gap-1.5">
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <button
              key={`${item}-${i}`}
              type="button"
              onClick={() => remove(i)}
              aria-label={`Remove ${item}`}
              className="chip chip-active"
            >
              {item} <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      ) : null}

      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        value={text}
        placeholder={kind === "condition" ? "Type a condition…" : "Type a medication…"}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
        // Typed-but-unpicked text is kept, not dropped, when the box loses focus.
        // The list's own mousedown prevents the blur, so a click still lands.
        onBlur={() => {
          setOpen(false);
          if (text.trim()) add(text);
        }}
        className="field-input"
      />

      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="panel absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto p-1 text-xs"
        >
          {suggestions.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                add(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer rounded px-2 py-1 ${
                i === active ? "bg-accent/15 text-foreground" : "text-muted-foreground"
              }`}
            >
              {s}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
