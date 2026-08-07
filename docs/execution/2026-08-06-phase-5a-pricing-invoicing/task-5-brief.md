### Task 5: Part page — the Pricing section rebuilt on price rows

> **Carried in from Task 4's review (2026-08-06) — this task owns the UI half of it.**
> `updatePartPrice` will move a price row's basis among the **non-LOT** units (EACH → LB →
> PER_1000) while that row still has live breaks, and a break's `threshold` is defined as being
> expressed *in the parent row's price-per unit* (`schema.prisma:490`). So changing the basis
> silently changes what every existing threshold means — a 500-piece break becomes a 500-pound
> break with no warning and no re-statement. The LOT case is already refused in the service
> (LOT cannot carry breaks at all); this is the unguarded gap among the other three units. The old
> flat-column surface behaved the same way, and no requirement covers it, so it was deliberately
> NOT fixed in Task 4.
>
> **Decide and implement the UI behavior here:** warn on the basis change, refuse it while live
> breaks exist, or offer to re-state the thresholds. If you believe the right answer is a service
> guard rather than a UI one, say so and stop — that is a plan change, not your call. Task 9 owns
> what the pricing engine does with a row whose breaks predate a basis change.

**Files:**
- Modify: `src/app/parts/[id]/PricingSection.tsx` (full rewrite), `src/app/parts/[id]/page.tsx` (the `Part` type loses the four pricing fields)
- Test: browser verification (below) — this component has no vitest seam

**Interfaces:**
- Consumes: `listPartPrices` / `addPartPrice` / `updatePartPrice` / `deletePartPrice` / `addPriceBreak` / `updatePriceBreak` / `deletePriceBreak` via the Task 4 routes; `PartPriceRow` (shape above); `gate` / `gateDo` (`src/lib/permission-ui.ts:13,19`); `PRICE_PER_LABELS` (`src/lib/part-constants.ts`).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Rewrite the component.** Keep everything the old one got right — it is being replaced for its *shape*, not its behaviour:
  - the **double gate** computed once (`const disabled = canEdit.disabled || priceGate.disabled; const title = canEdit.disabled ? canEdit.title : priceGate.title;`) — a user holding `change_prices` but not `parts.edit` must see the edit gate's reason, not the pricing one (the existing comment explains why; carry it over);
  - the single `focusedValue` ref + `noteFocus` / blur-save idiom, so a blur that changed nothing issues no request;
  - **roll back to server truth FIRST, then report why** (§5.13) on a failed optimistic save;
  - server messages surfaced verbatim — no client re-paraphrasing of `"A LOT-priced operation cannot carry price breaks"`.

  What changes: instead of four part-level inputs plus one flat break table, render **one card per price row** — a step-code select (options from `/api/picklists/processStepCode`), setup / unit price / minimum / price-per, and that row's own nested break table with its own add-row. Plus an **Add operation** button and a per-row **Remove operation**. Row order follows `position`; give each row up/down buttons that PATCH `position` rather than a drag handle (the codebase has no drag idiom and the invoice prints in this order).

- [ ] **Step 2: Update `src/app/parts/[id]/page.tsx`** — delete `setupCharge` / `unitPrice` / `minimumCharge` / `pricePer` from the `Part` type and from anything that spreads it into `save()`. `PricingSection` no longer needs `save` or `patchDraft` props at all; it owns its own fetches. **Task 2 deleted the old `PricingSection.tsx` outright and removed its usage** — you are creating the file fresh and re-adding the `<PricingSection …>` element, not editing a stub. There is no marker to remove.

- [ ] **Step 3: Verify in a real browser** — vitest cannot see a rendering or state bug, and this section has no server seam left to test through. Drive the bundled Chromium directly per HANDOFF §5a (`npx playwright install chromium` once, then a small `.mjs` against `npm run dev`). Confirm: two priced operations save and reload in position order; a break added under one row does not appear under the other; switching a row to **Lot** while it holds a break shows the server's refusal and leaves the row unchanged; and a user without `change_prices` sees every control **disabled with a title**, not hidden. **Clear the fixtures out of the DEV database afterwards** (`erp`, not `erp_test`).

- [ ] **Step 4: Gates + commit** — `feat(parts): pricing section rebuilt on per-operation price rows`

---

