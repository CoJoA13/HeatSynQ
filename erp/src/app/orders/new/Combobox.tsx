"use client";
import { useId, useState } from "react";

// Generic keyboard-first typeahead: a plain <select> can't satisfy the design spec's "autocomplete
// pickers (customer by code/name; part by number)" requirement (no substring filter as you type),
// so this is a small self-built combobox rather than a native control. Reused for both the
// customer picker and every line's part picker (orders/new/page.tsx, OrderLineCard.tsx).
//
// `disabled`/`disabledReason` per option (not the same as the whole-combobox `disabled` prop
// below): a disabled OPTION is still visible and findable by search — §5.16's "say why, never
// hide" rule applied to a single choice rather than the whole control — it just can't be
// committed. Used by OrderLineCard to show "No process steps" on a part in the LEAD slot (spec
// §11) while leaving it perfectly selectable as a rider.
export type ComboboxOption = { value: string; label: string; disabled?: boolean; disabledReason?: string };

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

  // WAI-ARIA editable-combobox semantics (#37) — attributes only, the keyboard/commit machinery
  // above and below is untouched. One useId per instance keys the listbox and its options'
  // stable ids; the expanded/activedescendant pair tracks exactly the condition the dropdown
  // actually renders under, so a screen reader is never told about a popup that isn't there.
  const listboxId = useId();
  const showList = open && filtered.length > 0;
  const activeId = showList && filtered[highlight] ? `${listboxId}-${highlight}` : undefined;

  function commit(opt: ComboboxOption) {
    if (opt.disabled) return; // belt to the native `disabled` attribute below, which already
    // blocks the mouse path — this closes the keyboard path (Enter on a highlighted-but-disabled
    // option calls commit() directly, with no per-element disabled check of its own).
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
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
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
      {showList && (
        <ul role="listbox" id={listboxId}
            className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded border bg-white text-sm shadow-lg">
          {/* role="presentation" on the li: the option role lives on the button (the element that
              carries the native `disabled` this pattern keeps), and a bare listitem is not a
              valid child of a listbox. */}
          {filtered.map((opt, i) => (
            <li key={opt.value} role="presentation">
              {/* onMouseDown + preventDefault, not onClick: preventing the mousedown's default
                  stops the input from ever blurring, so there is no blur-closes-before-click race
                  to work around with a timer. A native `disabled` button fires neither mousedown
                  nor click in the first place — commit()'s own `if (opt.disabled) return` above
                  is what closes the keyboard (Enter) path, which never touches this element. */}
              <button type="button" role="option" id={`${listboxId}-${i}`}
                      aria-selected={opt.value === value}
                      aria-disabled={opt.disabled || undefined}
                      disabled={opt.disabled} title={opt.disabled ? opt.disabledReason : undefined}
                      onMouseDown={(e) => { e.preventDefault(); commit(opt); }}
                      className={`block w-full px-2 py-1 text-left ${i === highlight ? "bg-slate-100" : ""} ${opt.disabled ? "cursor-not-allowed text-slate-400" : ""}`}>
                {opt.label}{opt.disabled && opt.disabledReason ? ` — ${opt.disabledReason}` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
