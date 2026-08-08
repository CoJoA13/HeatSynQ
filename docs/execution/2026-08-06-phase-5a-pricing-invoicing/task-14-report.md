# Task 14 — Credits — Report

## What I implemented

`createCredit(invoiceId: string): Promise<InvoiceDetail>` in `src/server/invoices.ts`, plus one
required correctness fix to Task 13's finalize path and one anti-drift refactor.

1. **`createCredit`** — derives a DRAFT `CREDIT` from a live `FINALIZED` `INVOICE`:
   - Claims the order row, then locks the **source invoice** row `FOR UPDATE`, then re-reads —
     reusing the existing `claimInvoiceRow(tx, invoiceId)` helper (the same claim discipline every
     mutator in this file uses). The guarded state (the source's `kind`/`status`) is read off a row
     the transaction holds.
   - Refuses, naming the blocker: order **voided** (`Order.deletedAt`), source is a credit **not an
     invoice** (`kind !== "INVOICE"`), source **not finalized** (`status !== "FINALIZED"`). A
     discarded source (`deletedAt`) is 404'd by `claimInvoiceRow` before these run.
   - `allocateNumber("credit_number_next", tx)` **inside the claim** (never hand-rolled).
   - Copies every header snapshot (orderId, customerId, invoiceDate, poNumber, termsName, billTo,
     shipTo, materialName, processNames, taxRate) and sets `kind='CREDIT'`, `status='DRAFT'`,
     `sourceInvoiceId`, `creditNumber` (NOT `invoiceNumber`).
   - Copies every line with **`amount` negated and `qty`/`weight` left as billed**; totals come from
     `totalsFromLines(lineData)` over the already-negated lines, so header totals and lines share one
     sign (a credit's `total` is negative). Parents (OPERATION → PART) rewired via `wirePayloadParents`.
   - `withDbErrors → Serializable $transaction → auditedCreate → writes on tx`; `assertLineRefs`
     guards every FK the copied lines carry (FK-writer pattern).

2. **`finalizeInvoiceInTx` kind branch** — the existing finalize wrote `Order.status = "INVOICED"`
   **unconditionally**. The brief requires a CREDIT finalize to write **no** order status. I wrapped
   the order write in `if (invoice.kind === "INVOICE")`. An INVOICE finalize is unchanged (still
   writes INVOICED); a CREDIT finalize now touches only the credit. This was NOT already true in the
   code despite the brief's "verify the existing path already does this" — it needed the fix.

3. **`wirePayloadParents` signature widened** from `LineInput[]` to
   `readonly { key?: string; parentKey?: string | null }[]` so the credit copy reuses it (keyed off
   the source rows' own ids) instead of forking a second parent-wiring path. `LineInput[]` still
   satisfies the narrower structural type, so `replaceInvoiceLines` is untouched.

## TDD evidence (RED → GREEN)

Wrote 11 tests in `tests/invoices.test.ts` (`describe("createCredit")`) first.

- **RED:** `Tests 11 failed | 39 skipped (50)` — all 11 failed with `TypeError: createCredit is not
  a function` before implementation.
- **GREEN:** after implementing, `Tests 11 passed | 39 skipped (50)`. (One test — the order-audit
  delta — was corrected first: it initially asserted an absolute count of 0, but the order already
  carries an update entry from shipping, so it now measures the delta around the credit finalize.)
- **Discrimination check on the kind branch:** temporarily reverting the `if (invoice.kind ===
  "INVOICE")` guard (making the order write unconditional) turned both kind-branch tests RED
  (`"...without touching the order status"` expected SHIPPED got INVOICED; `"...writes no
  order-status audit entry"` delta expected 1 got 2). Restored, back to GREEN.

## Sign-flip and lifecycle decisions

- **Sign flip:** money negates, quantity/weight do not. `negateMoney(d)` normalizes a zero line
  (PART lines carry `amount = 0`) to `+0` — Postgres reads `-0` back as `+0` and `toBe` uses
  `Object.is`, so storing `-0` would be a foot-gun. Decimal(12,2) round-trips through `toNumber()`
  exactly (max 9999999999.99 « 2^53), so negating the number keeps the column scale on write.
- **Header copy including `invoiceDate`:** the brief says "copy every header snapshot," so the credit
  copies the source's `invoiceDate` verbatim rather than stamping today. Faithful to the instruction;
  not tested by the brief. Flagged as a decision in case the owner wants issue-date semantics later.
- **`assertLineRefs` on the copy:** per the brief ("reuse the assertRefExists guard set"), a credit
  refuses if a GL account / step code / surcharge the source pointed at was soft-deleted since it
  finalized — consistent with create/replace. No cert extra-step-code id: a credit copies the stored
  CERT line (its gl rides on the line), it does not re-resolve the cert charge from BillingConfig.
- **Coexistence:** the `one-live-invoice-per-order` partial index is scoped to `kind='INVOICE'`, so a
  CREDIT never collides with its source; an invoice can be credited more than once. Proven by a test
  asserting 2 live invoices on the order and the source still FINALIZED.
- **Credit number never freed:** `creditNumber` is plain `@unique` (sweep-exempt, not partial), and
  `allocateNumber` bumps the counter under the claim, so discarding a draft credit does not reissue
  its number.

## Anti-drift (reuse, not fork)

The credit reuses `claimInvoiceRow` (claim discipline), `assertLineRefs` (FK guard), `totalsFromLines`
(integer-cent totals), and `wirePayloadParents` (parent wiring). It does not fork a second mapping.
`mapComputedLines` is deliberately NOT used — it maps `PricingResult` (engine output); a credit's
lines come from the STORED source invoice, so the copy maps `LineRow → write` directly and negates.

## Files changed

- `src/server/invoices.ts` — `createCredit` (new export), `finalizeInvoiceInTx` kind branch,
  `wirePayloadParents` signature widened, `allocateNumber` added to the settings import,
  `negateMoney` helper.
- `tests/invoices.test.ts` — `createCredit` import + `describe("createCredit")` (11 tests).

## Gates

- `npm test` — **1641 passed (106 files)**.
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm run build` — succeeds.
- E2E **not run**: service-layer only, no UI/flow touched (per the brief).

## Self-review

- Sign flip proven: OPERATION `amount = -937.44`, PART `qty = 144` (positive), `total = -937.44`,
  plus a line-for-line reuse test (`amount` negated, `qty`/`weight`/`kind`/`gl` unchanged).
- FINALIZED-source-only proven: refuses a DRAFT source (`/finalized/i`); also refuses crediting a
  credit (`/not an invoice/i`) and a voided order (`/voided/i`).
- Credit finalize leaves order status untouched: proven discriminating (order stays SHIPPED; zero
  order-audit delta) — both RED with the kind branch removed.
- No-drift proven: credit lines equal source lines position-for-position, only money flipped.

## Concerns

- **`invoiceDate` copied, not re-stamped** — see decisions above. Trivial to change to `todayDateOnly()`
  if the owner wants a credit's own issue date; the brief's "copy every header snapshot" says copy.
- The brief's "Task 13's finalize branches on kind" was aspirational — the branch did not exist and
  I added it. Existing Task 13 tests remain green (INVOICE finalize still writes INVOICED).
