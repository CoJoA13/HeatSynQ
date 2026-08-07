# Task 11 report — `invoices.ts`: candidates and creation

## Status: DONE

## What I implemented

`src/server/invoices.ts` (new) and `tests/invoices.test.ts` (new).

Exports, matching the brief's Produces block:

- `listInvoiceCandidates(filter)` — orders at `SHIPPED` with no live `INVOICE`, plus the customer
  and ship-date-range filters, ordered by order number; `lastShipDate` = max `shipDate` across the
  order's live shipments.
- `readInvoiceDetail(db, id)` / `getInvoice(id)` — read side on `readShipperDetail`'s shape
  (`DETAIL_INCLUDE` + `toInvoiceDetail`). Reads the snapshot columns UNCONDITIONALLY (§5.4 / ruling
  24 — frozen paper reads its own snapshot, never a live join). `documentNumber` is computed from
  the `invoice_number_prefix` setting. No `deletedAt` filter — a discarded draft stays readable.
- `createInvoice(input, tx?)` — the DRAFT create. Reads plant deps outside the transaction, then
  `claimOrder` → refuse (missing / voided / not-SHIPPED / already-invoiced) → read customer +
  addresses + lines → `buildPricingInput` → `priceOrder` (the pure engine) → write header + lines
  (PART/OPERATION self-relation patched in a second pass) through `auditedCreate("invoice", …)`.
- `invoiceWarnings(detail)` — pure over the detail: one entry per `needsPrice` line, one per
  operation line whose step code has no GL account (advisory in 5A; 5C's export refuses).

`createInvoiceInTx(tx, data, deps)` is the internal worker; the public `createInvoice` opens the
Serializable transaction (or uses a caller-supplied `tx`, the `createCert` shape, which the
discriminating concurrency test needs).

## TDD evidence

**RED (module not found), Step 2:**

```
FAIL  tests/invoices.test.ts [ tests/invoices.test.ts ]
Error: Cannot find module '@/server/invoices' imported from '.../tests/invoices.test.ts'.
 Test Files  1 failed (1)
      Tests  no tests
```

First implementation run surfaced two real RED failures I then fixed:
- `returns the first invoice for a repeated clientRequestId` → `Order #1000 already has an
  invoice …` (the one-invoice-per-order refusal fired before the nonce replay — fixed by making the
  existing-invoice check clientRequestId-aware; see idempotency below).
- `never bills a line whose net shipped total is zero` → `expected 600 to be 100` (my own fixture
  bug: line A carried a $600 minimum over $100 extended, so line A itself billed $600 — fixed the
  fixture to give line A no minimum).

**GREEN (Step 7), full focused file after fixes + self-review additions:**

```
 ✓ tests/invoices.test.ts (17 tests) 1671ms
 Test Files  1 passed (1)
      Tests  17 passed (17)
```

**Step 8 — the concurrency test discriminates.** Replaced `claimOrder(tx, …)` with a bare
`tx.order.findFirst(…)` and re-ran just that test:

RED (claim removed):
```
FAIL  … blocks a concurrent create under Read Committed … (row-lock discipline)
+ Database error. Code: `40P01`. Message: `deadlock detected`   (Prisma P2039)
 Tests  1 failed | 14 skipped (15)
```
Without the row lock the two creates race into the partial-unique index and DEADLOCK — not the
clean `/already has an invoice/i` 400 the test asserts. Restored `claimOrder` and re-ran:

GREEN (claim restored):
```
 ✓ … blocks a concurrent create under Read Committed … (row-lock discipline)  494ms
 Tests  1 passed | 14 skipped (15)
```

## The three inherited seams

1. **CHARGE GL account.** The engine leaves every CHARGE line's `glAccountId` null (`ChargeInput`
   carries no `GlRef`). In `createInvoiceInTx`'s line-mapping I override CHARGE lines with
   `BillingConfig.otherChargeGlAccountId` and that account's name. Tested:
   `byKind.get("CHARGE").glAccountName === "4400"`. I did NOT widen `ChargeInput` — pricing.ts stays
   pure.
2. **`glAccountName ?? ""`.** `SurchargeRow.glAccountName` is `string | null`; the engine's
   `SurchargeInput.glAccountName` and `InvoiceLine.glAccountName` are NOT NULL `string`. The `?? ""`
   is done deliberately in `buildSurcharges`, and it is compile-enforced (the types do not unify, so
   it cannot be silently skipped). I added a surcharge test (self-review) so the whole path — not
   just the type — is exercised: a real percent surcharge bills $5 with its GL name "4500".
3. **Zero-net line filtered before pricing.** `buildPricingInput` skips any order line whose shipped
   totals are `qty === 0 && weight === 0`, so a fully-returned / never-really-shipped line marked
   complete never reaches the engine's `max(extended, minimum) + setup`. Tested with a two-line
   SHIPPED order where line B ships zero-but-complete and carries a $600 minimum: the total is line
   A's $100, never $700, and no invoice line references line B.

## Money / idempotency decisions

- **Idempotency is caught under the claim, not via a clientRequestId P2002.** A replay carries the
  same `orderId`, so the order's live-invoice guard fires first — the createShipper "collide on the
  nonce index at INSERT" shape is unreachable here. So the existing-invoice check selects the live
  invoice's `clientRequestId`: a match is that request's own prior result (return it, `deduped:
  true`); any other/null nonce is a genuine "already invoiced" refusal. The
  `isDuplicateClientRequestId` catch stays as the backstop for a nonce reused across orders.
- **Tax:** `customer.taxable ? (customer.salesTaxRate ?? config.salesTaxRate) : null`; the resolved
  rate is snapshotted on `Invoice.taxRate`. No rate ⇒ no tax line. Freight is excluded from the tax
  base inside the engine (ruling 8) — verified by the $290.40 combined test.
- **Cert charge (§6):** billed only when `order.certRequired` AND the lead part's `billForCert ??
  config.billForCertDefault` AND `!customer.certChargeSuppressed` AND an amount resolves
  (`lead.certCharge ?? config.certChargeDefault`); posts to the config cert **step code's** GL
  account. `certChargeSuppressed` suppression tested.
- **Freight:** summed in integer cents across the order's LIVE, `billFreight` shipments (dedup by
  shipper id); `null` freightAmount contributes nothing; posts to `config.freightGlAccountId`.
- **Decimals → engine numbers → Prisma Decimal columns:** the engine rounds once per line to cents;
  totals are sums of already-rounded lines. `937.44` (144 × 6.51) is exact end to end.
- **Self-relation:** PART/OPERATION `parentLineId` patched in a second pass inside the same
  `auditedCreate` `doIt` (a nested create cannot satisfy a self-FK). Now asserted:
  `op.parentLineId === part.id`.
- **No `assertRefExists`.** Every FK written on the invoice/lines (`glAccountId`, `surchargeId`,
  `processStepCodeId`, `orderLineId`, `orderChargeId`, `customerId`) comes from rows read live in the
  same transaction, and all those targets are soft-deletable (the row never physically leaves), so
  no reference-delete TOCTOU exists — the same reason `createShipper` only guards `carrierId`. The
  transaction is still Serializable per the brief (consistent snapshot + the claim's serialization).

## Files changed

- `erp/src/server/invoices.ts` — new (the service).
- `erp/tests/invoices.test.ts` — new (17 tests: candidacy, snapshot, numbering, one-invoice refusal,
  discard-then-recreate, clientRequestId replay, no-price warning, zero-net filter, freight/charge/
  cert/tax with GL accounts, taxable off, customer-rate-over-plant, cert suppression, audit content,
  surcharge bill + opt-out, and the row-lock concurrency discriminator).

`audit.ts` already carried `invoice` in `AuditableModel` and `SNAPSHOT_INCLUDE` (with the lines
collection ordered by position) from Task 2, so no audit-map change was needed.

## Self-review findings (fixed before reporting)

- Surcharge path had zero createInvoice-level coverage — added two tests (bill with GL + rate; and
  per-customer opt-out). This also exercises seam #2 against a real GL account.
- The self-relation wiring (`parentLineId`) was unasserted — added `op.parentLineId === part.id`.
- Fixture inconsistency in the brief's `pricedShippedOrder`: `minimumCharge: null` was passed by two
  tests but the brief's `?? "600.00"` would have turned null into a $600 minimum, breaking the
  freight/tax math. Corrected the helper so `null` means "no minimum" (distinct from omitting it).
- Two brief-listed Step-1 helpers (`finalizedFixture`, `toLineInput`, `shipMore`, `draftFixture`)
  call Task 12–15 exports (`finalizeInvoice`, `replaceInvoiceLines`) that do not exist yet, so
  including them would not compile. Only the helpers Task 11's tests use are in the file; the later
  ones land with their tasks (the brief says to move them to a shared `tests/helpers/invoicing.ts`
  when a second file needs them).

## Concerns

- **Multi-order freight.** `createInvoice` is per-order and freight rides the whole Shipper. For a
  single-order shipment (all tests, the common case) freight is exact. If one shipment carries
  several orders that are each invoiced separately, summing the shipment's freight onto every order's
  invoice would over-bill. Spec §5 says invoice grouping is configurable (per shipper / order / PO);
  that allocation decision belongs to the grouping task, not here. Flagging it so it is not lost.
- **`billTo` / `shipTo` rendering** is not pinned by any brief test. I render the customer's default
  BILL_TO / SHIP_TO as a multi-line block (name / street / city, state zip), name falling back to
  the customer name — the `certs.ts` `billTo` precedent. If a specific invoice layout is wanted, it
  is a display-string change with no money impact.

## Gates

- `npm test` — 1603 passed (106 files), including the 17 new invoice tests. (Re-run after the two
  self-review test additions: focused file 17/17; full suite green before those additions.)
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean (0 warnings).
- `npm run build` — clean.
- E2E: not run — this is a service-layer task with no UI/flow change.

## Fix wave 1

Four fixes to `src/server/invoices.ts` from the post-approval review. Pricing math, the candidacy
query, idempotency, the three seams, and the row-lock discipline were untouched (out of scope by
the brief).

**Fix 1 (assertRefExists guards) — implemented as specified.** The original "No `assertRefExists`"
rationale in this report (every FK read live in the same transaction, so no TOCTOU) turned out to
miss the actual gap: `loadInvoiceDeps` reads `BillingConfig` and the surcharge list on the
**top-level** client, **before** the Serializable transaction even opens — so a GL account,
surcharge, or step code named there can be soft-deleted in the window between that read and this
transaction's commit, and the in-tx reads (`buildPricingInput`'s `glAccount.findMany`, the cert
step's `processStepCode.findFirst`) don't filter `deletedAt` either. Added, in `createInvoiceInTx`
right after `lineData` is built and before any row is written:

- every distinct non-null `glAccountId` across `lineData` → `assertRefExists("glAccount", id, tx)`
  (covers FREIGHT/CHARGE/TAX from billing config, SURCHARGE from the surcharge row, OPERATION from
  the priced step code, and CERT from the cert step code — whichever actually landed on a line);
- every distinct non-null `processStepCodeId` across `lineData` (OPERATION lines), plus
  `BillingConfig.certChargeStepCodeId` itself when a CERT line was actually computed (`input.cert
  !== null`) — that id never lands on the CERT line's own `processStepCodeId` column (only its GL
  account rides along), so it is invisible to the `lineData` scan and needed a separate check;
- every distinct non-null `surchargeId` across `lineData`.

All three loops run on `tx`, after the order claim, inside the existing Serializable transaction —
isolation level unchanged. Test: soft-delete the GL account behind the priced fixture's operation
line, then `createInvoice` → refused `400` "That gl account does not exist" (assertRefExists's own
message via the `glAccount` `REFERENCE_LABELS` entry). Result: **PASS** —
`tests/invoices.test.ts` "refuses to create an invoice whose GL account was soft-deleted before
creation (assertRefExists)" is green, and `prisma.invoice.count()` confirms nothing was written.

**Fix 2 (CHARGE needsPrice warning) — implemented as specified.** `invoiceWarnings` now branches on
`l.partNumber === ""`: a part-bearing line keeps the original `${partNumber} — ${description}
needs a price` shape; a CHARGE (or any other blank-part-number) line uses `${description} —` in
that slot, so `Line 3 · Rush — needs a price` prints instead of the old `Line 3 ·  — Rush needs a
price`. Pinned by a new test (`replaceCharges` with an amount-less "Rush" charge on a priced,
otherwise-fully-priced order, so it is the only `needsPrice` line).

**Fix 3 (redundant GL-name query) — implemented as specified.** Verified the two reads were
genuinely the same value: `buildPricingInput`'s `glNameById` is built from `glAccount.findMany`
over `[freightGlAccountId, otherChargeGlAccountId, salesTaxGlAccountId]`, so
`otherChargeGlAccountId`'s name was already resolved there. Changed `buildPricingInput`'s return
type to `{ input: PricingInput; otherChargeGlName: string }` and had `createInvoiceInTx` reuse
`otherChargeGlName` instead of a second `tx.glAccount.findFirst`. `buildPricingInput` is a private,
single-caller helper, so the signature change has no other call sites.

**Fix 4 (billTo/shipTo coverage) — implemented as specified, no behavior change.** `renderAddress`
is a private helper, unreachable directly from tests, so coverage runs through `createInvoice`'s
`billTo`/`shipTo` output: two `BILL_TO` rows where the alphabetically-first one is NOT the default
(proves `isDefault` wins over `listAddresses`' name ordering), the default row's own `name` blank
(customer-name fallback) and `zip` blank (blank-line drop inside the city/state/zip join), and a
`SHIP_TO` row with no street/city/state/zip at all (only the name line prints). Both assertions
pass against the exact rendered strings.

## Fix-wave gates

- `npx vitest run tests/invoices.test.ts` — 20/20 passed (17 original + 3 new).
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm test` — 1608/1608 passed (106 files).
- E2E: not run per the fix-wave brief (service-layer only).

No concerns beyond the ones already on record (multi-order freight, deferred `listPartPrices` tx
threading).
