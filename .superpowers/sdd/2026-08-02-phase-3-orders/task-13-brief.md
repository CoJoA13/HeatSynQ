### Task 13: Order entry UI + autosave

**Files:**
- Create: `src/app/orders/new/page.tsx`
- Modify: none elsewhere (uses Task 2 lib utils + Task 9/10 routes)

**Behavior contract:**
- The §11 cascade with keyboard-first tab order; autocomplete pickers (customer by code/name; part by number within the chosen customer, showing which parts lack steps — those disabled with "No process steps" when picked as lead; riders allowed).
- Derived-until-touched (the 2C-3 lesson, stated in §11): weight per line = `eachWeight × qty` recomputing on qty change UNTIL the user edits weight (then theirs wins; a "reset to computed" affordance clears the override); request date = from `/api/orders/entry-defaults` until touched. **Draft stores ONLY typed values + override flags, never server-derived data.**
- Serial entry per line: text input; on Enter/blur, `expandSerialRange` (from `src/lib/serial-range.ts`) appends rows; per-row description input; dupes surfaced inline before save.
- Banners: customer standing order notes; credit hold ("⚠ ACME is on credit hold — orders can be entered; shipping will require release" — exact copy owner-visible, keep calm tone); serialization warning live per flagged line with 0 serials.
- Autosave: 2 s debounce PUT `/api/order-drafts`; on mount GET → if payload, "Draft from {time} — Resume / Discard" (Discard = DELETE). Save success → navigate to `/orders/[id]` (draft already cleared server-side); Save & Print → same, then trigger the hub's print action (Task 16 wires the print; until then the button renders disabled with "Traveler arrives later this phase" — remove that stub in Task 16).
- Save errors render field-anchored (the API's 400 messages) in the standard banner; **no reload-after-error** (§5.13).

- [ ] **Step 1: Build the page.**  **Step 2: Manual smoke: key the mockup's sibling order end-to-end against dev DB; verify draft resume by mid-entry reload.**  **Step 3: Gates.**
- [ ] **Step 4: Commit** — `feat: order entry with autosave drafts`

