"use client";
import { useState } from "react";

// Generic keyboard-first typeahead: a plain <select> can't satisfy the design spec's "autocomplete
// pickers (customer by code/name; part by number)" requirement (no substring filter as you type),
// so this is a small self-built combobox rather than a native control. Reused for both the
// customer picker and every line's part picker (orders/new/page.tsx, OrderLineCard.tsx).
export type ComboboxOption = { value: string; label: string };

export function Combobox({
  value, options, onSelect, placeholder, disabled, title, ariaLabel,
}: {
  value: string | null;
  options: ComboboxOption[];
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const selected = options.find((o) => o.value === value);
  const normalized = query.trim().toLowerCase();
  const filtered = normalized ? options.filter((o) => o.label.toLowerCase().includes(normalized)) : options;

  function commit(opt: ComboboxOption) {
    onSelect(opt.value);
    setQuery("");
    setOpen(false);
  }

  // Selecting an option keeps the input focused on purpose (the dropdown option commits via
  // onMouseDown + preventDefault below, precisely so focus never leaves) — but that means a
  // second click on the SAME already-focused input, to change a decision, fires no new "focus"
  // event at all (the DOM only fires focus on an actual transition). Without this, the very next
  // keystroke lands inside the still-displayed old label instead of starting a fresh search
  // (caught live in this task's dev-server smoke test, re-picking a lead part after an initial
  // wrong pick). onClick fires on every click, focused-already or not, so wiring the same reset
  // there closes it; it is a harmless no-op duplicate on a genuine fresh-focus click.
  function openFresh() {
    setOpen(true);
    setQuery("");
    setHighlight(0);
  }

  return (
    <div className="relative">
      <input
        value={open ? query : (selected?.label ?? "")}
        placeholder={placeholder}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        onFocus={openFresh}
        onClick={openFresh}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter") { const opt = filtered[highlight]; if (opt) { e.preventDefault(); commit(opt); } }
          else if (e.key === "Escape") { setOpen(false); setQuery(""); }
        }}
        className="w-full rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded border bg-white text-sm shadow-lg">
          {filtered.map((opt, i) => (
            <li key={opt.value}>
              {/* onMouseDown + preventDefault, not onClick: preventing the mousedown's default
                  stops the input from ever blurring, so there is no blur-closes-before-click race
                  to work around with a timer. */}
              <button type="button" onMouseDown={(e) => { e.preventDefault(); commit(opt); }}
                      className={`block w-full px-2 py-1 text-left ${i === highlight ? "bg-slate-100" : ""}`}>
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
