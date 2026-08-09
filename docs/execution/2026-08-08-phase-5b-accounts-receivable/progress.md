# Phase 5B SDD progress ledger

**Plan:** `docs/superpowers/plans/2026-08-08-phase-5b-accounts-receivable.md` (17 tasks)
**Spec:** `docs/superpowers/specs/2026-08-08-phase-5b-accounts-receivable-design.md` (10 owner rulings, §3)
**Branch:** `phase-5b-accounts-receivable`
**Started:** 2026-08-08
**Branch base (merge-base main):** `ba76269`
**Docs commits before Task 1:** `8aaf8f1` design spec, `e242ca7` implementation plan. Task 1 BASE = `e242ca7`.

Execution driven by `superpowers:subagent-driven-development`: fresh implementer subagent per task,
the repo's `task-reviewer` agent gating each on two verdicts (spec compliance + code quality), fix
loops until clean, then a whole-branch review before merge. Briefs and reports live in this
directory (committed — CLAUDE.md's execution-record rule); the regenerable `review-*.diff` packages
stay under `.superpowers/sdd/` (git-ignored).

## Pre-flight plan scan (2026-08-08)

Scanned all 17 tasks once for task-vs-task and task-vs-Global-Constraints contradictions and for
anything the plan mandates that the review rubric treats as a defect. **Clean** — no blocking
contradiction requiring an owner ruling before execution. One subtlety noted for the task loop:
Task 9 asks for a `discardInvoice`-refuses-with-A/R-activity test, but applications only ever target
*finalized* invoices/credits while `discardInvoice` operates on drafts, so the guard may be
defense-in-depth with no natural fixture. Left for the Task 9 implementer/reviewer to surface rather
than pre-litigated.

## Process decisions

- **Host crashes during Tasks 13 (2026-08-08+).** The host crashed twice mid-Task-13 (environmental — resource contention from another program/VM, per owner). The Task 13 implementer finished the code but the crash lost its commit/report/gate-run. Recovery: the uncommitted tree survived intact; the controller verified no stubs, read the backend additions, ran all four gates green, committed as `ffd6139`, wrote a controller recovery report, and ran the normal review → fix → re-review loop. **Resource discipline going forward:** avoid re-running heavy gates when nothing changed; prefer committing early (durable against crashes); browser verification of UI tasks 13/14/15 is deferred to Task 17's E2E (which covers the whole `/receivables` flow) rather than spinning up a dev server + browser preview per task.
- **OWNER RULING (2026-08-08) — applying a payment is gated on `receivables.create`.** The Task 13 brief said "money controls gated on `receivables.edit`," but `POST /api/receivables/applications` (Task 7) enforces `receivables.create`. Owner ruled `create` governs (consistent with add-payment/create-batch — all entity-creation gate on create; post-batch=edit; voids=delete). UI aligned to the route in `1ce9a82`; the route was already correct.

- **E2E sequencing.** Per-task gates are `npm test` + `tsc` + `eslint` (+`build` before review). The full Playwright suite (`npm run test:e2e`, dev server + DEV db) is sequenced at **Task 17** and the **closing gate run before the PR** — the plan's explicit ordering, and the 5A precedent. CLAUDE.md's "run E2E whenever a change touches a flow" is honored at those two points (the phase-completion claims), not per-task, because spinning a dev server 17× in the loop is impractical and E2E covers whole flows the mid-loop server state can't yet exercise. If a task makes a high-risk change to an existing 5A flow, E2E is run for it specifically.
- **Implementer stall pattern.** General-purpose implementer subagents in this environment tend to background `npm test` and pause on it. Every dispatch from Task 3 on says: run ALL gates in the FOREGROUND, never background/poll — a ~2-min block is expected.

## Task ledger

- [x] Task 1 — `ar-constants.ts`, `receivables` permission area + `write_off`, `receipt_batch_number_next` counter — **complete** (code `492bffe`, report `ac4680b`; review clean)
- [x] Task 2 — schema: 3 tables, column additions, 2 CHECKs, migration, registry/audit/sweeps — **complete** (code `2d639e2`; review clean, 2 deviations confirmed correct)
- [x] Task 3 — `createCredit` own-date + `Invoice.dueDate` at finalize — **complete** (code `3a0e8e9`; review clean)
- [x] Task 4 — Terms & BillingConfig columns + admin UIs — **complete** (code `6ec3a3c`, fix `fbfe9f5`; review Approved after 1 fix round; browser-verified)
- [x] Task 5 — `ar-balances.ts` (pure) — **complete** (code `81beb71`; review clean)
- [x] Task 6 — `receipts.ts` + routes — **complete** (code `1acfc41`; review Approved, 2 correct deviations, 1 owner-ruling item)
- [x] Task 7 — `applications.ts` payment/discount/write-off/on-account + routes — **complete** (code `34fe94a`; review Approved — opus, concurrency verified RED)
- [x] Task 8 — credit application — **complete** (code `2928082`; review Approved — opus; audit enhancement landed)
- [x] Task 9 — `invoice-guards` A/R-activity + unlock/discard/void refusals — **complete** (code `1b7210b`, fix `2483bd0`; review Approved after 1 fix round — opus caught a real voidOrder gap)
- [x] Task 10 — `aging.ts` (pure) + route — **complete** (code `2caaeec`; review Approved — opus, point-in-time verified)
- [x] Task 11 — `finance-charges.ts` (pure) — **complete** (code `36bccd8`; review clean)
- [x] Task 12 — `statements.ts` + `pdf/statement.ts` + STATEMENT document + route — **complete** (code `a2c6bde`; review Approved — opus, byte-exact reprint verified)
- [x] Task 13 — `/receivables` batch entry + apply UI — **complete** (code `ffd6139`, fix `1ce9a82`; review Approved after 1 fix round; recovered from a host crash, gate-verified; browser check deferred to Task 17 E2E)
- [x] Task 14 — aging report UI — **complete** (code `15513f3`; review Approved; 2 Task-10 minors closed)
- [x] Task 15 — statements UI + customer A/R section — **complete** (code `d916dc4`, fix `5253423`; review Approved after 1 fix round — sonnet caught a real division-scope leak)
- [x] Task 16 — routes 401/403 sweep — **complete** (code `14ff4fa`; review Approved; write_off gating added)
- [ ] Task 17 — E2E + demo + docs
- [ ] Whole-branch review + fix wave

## Owner rulings owed (surface at the Task 17 demo)

- **POSTED batch lifecycle (Task 6).** The brief mandates `voidPayment` refuse on a POSTED batch, but the (also-mandated) refusal message "This batch is posted — reopen or void a payment to change it" promises an escape hatch that does not exist — there is no `reopen`, and `voidBatch` has no POSTED guard. Net asymmetry as built: a POSTED **empty** batch is voidable, but a POSTED **non-empty** batch is fully frozen (can't void its payments, can't void the batch). On-account cash on those payments is still appliable to invoices (spec §5.2). The plan already earmarks the POSTED lifecycle for an owner ruling at the demo (Task 17 Step 3). **Options for the owner:** (a) allow `voidPayment` on POSTED (the message's implied behavior); (b) add a `reopen` (POSTED→OPEN); (c) reword the message; (d) leave frozen-by-design. No code change until the owner rules.

- **Discount basis (Task 7) — owner ruling at demo.** `discountAvailable` computes the early-pay discount on the invoice's OPEN BALANCE (self-consistent between `discountAvailable` and the DISCOUNT-line guard). The correct basis (open balance vs the amount actually paid vs the original invoice total) is a billing-policy choice the plan already earmarks for the Task 17 demo (Task 17 Step 3: "discount-on-partial-payment basis"). No code change until the owner rules.

- **runStatements → credit-balance customers (Task 12) — owner ruling.** `runStatements` skips only zero-net customers, so a customer with a NEGATIVE net (a pure credit balance — we owe them) still gets a statement. Spec §8 ("everyone with an open balance") is ambiguous on whether a credit balance qualifies. Arguably correct (they should see their credit). Surface at the demo; positive-net-only is a one-line change if the owner prefers it.

## Deferred minors (fix-wave / whole-branch-review triage input)

- **Task 13 minors (sonnet review):** (a) `documentNumber` prefix formatting duplicated across `applications.ts`/`invoices.ts`/`statements.ts` (all private) — safe (INVOICE-only usage here) but a DRY candidate; (b) `ApplyPanel.load()` does one `?customerId=` fetch + N parallel `?paymentId=&invoiceId=` fetches (one per candidate invoice) just to read `discount`, discarding the `open` each also returns — an N+1 shape fine at this shop's scale, but a single batched endpoint would avoid it if families grow large. Whole-branch triage.
- **Task 12 minors (opus review):** (a) **snapshot-reader drift risk** — `statements.ts`'s `readFamilySnapshot`/`appsAsOf`/`sumAgingRows`/`parseAsOf` are line-for-line copies of `aging.ts`'s private helpers (only the shared pure `bucketAging` is actually reused). Filters match today, but a future change to `aging.ts`'s inclusion filters would silently desync the statement figures from the report — breaking the §6 reproducibility invariant 5C depends on. **Cheap guard: a test asserting statement aging == `agingReport` for a shared fixture, or export the snapshot reader. Good whole-branch fix-wave candidate.** (b) the store audit-content test pins exclusion+existence, not the `after` kind/customerId (verified elsewhere) — coverage polish.

- **Task 7 minors (opus review, all doc/hardening — behavior correct):** (a) the post-claim invoice re-read omits `deletedAt`/`status`/`kind` — safe (a concurrent void → 40001 → retry → 404) but rests on SSI+retry rather than a post-claim recheck like `claimCertsOrder`; either re-select+re-assert or tighten the comment; (b) the added Payment-row claim's cross-invoice (same-payment/two-invoice) guarantee is actually SSI, not the lock, and has no discriminating test — correct because the public path is always Serializable, but the report's "serialize here" framing overstates it; (c) `applications-concurrency.test.ts:692-693` comment mis-predicts the RED failure mode (says timeout fails first; actually the competitor blocks at INSERT and the final `rejects` fails) — test still discriminates, comment wrong. **Cheap doc fixes; candidates for the whole-branch fix wave.**

- ~~**Task 2 (audit snapshot coverage)** — `Application`'s `SNAPSHOT_INCLUDE` pulls only the target invoice, not the source credit.~~ **CLOSED in Task 8** — `SNAPSHOT_INCLUDE.application` now includes `creditInvoice` (covered by a void-snapshot content test). (`Payment.customer` still not in Payment's snapshot — trivial, whole-branch triage if wanted.)
- **Task 10 minors (opus review, all non-defects):** (a) untested family edges — parent-with-own-invoices (`parentOwnRow`) and cross-customer credit inside aging; both trace correct, want regression pins for the §13 guarantee; (b) **all-zero rows at a past `asOf`** — the customer-set queries (`invoicedCustomers`/`paidCustomers`) carry no date filter, so a customer whose only activity postdates `asOf` surfaces as an all-zero row (figures correct, row set padded); **flag to Task 14 (aging UI) — filter empty rows in the source `agingReport` or the UI**; (c) export headers hardcode ASCII `"1-30"` instead of reusing `AGING_BUCKET_LABELS` (en-dash) — a visible mismatch with the on-screen labels; cheap to fix, **candidate for the Task 14/whole-branch pass**; (d) `readSnapshot` queries outside a transaction — a concurrent void/create mid-read could give a momentarily inconsistent cut (read-only, no corruption; a repeatable-read `$transaction` would match the reproducibility the task stresses).
- **Task 8 minor** — `APPLICATIONS_LITE_SELECT` (applications.ts) duplicates the inline `{ amount, type, deletedAt }` select `applyPayment` still inlines; share one const. Trivial DRY. Whole-branch triage.
- **Task 6 minors** — (a) no per-route 401 (missing-cookie) test in receivables-routes.test.ts (403+200 covered; brief mandated only 403; `handle` enforces 401 uniformly); (b) no test that `getBatch` returns a voided batch (readBatchDetail deliberately omits the deletedAt filter — behavior unasserted); (c) `paymentType` double round-trip (assertRefExists then findFirst for name — redundant read, harmless). Whole-branch triage.
- **Task 5 (Decimal→number at call sites) — CARRY to consuming tasks 6/7/10/12.** `ar-balances.ts`'s `ApplicationLite`/`total`/`amount` are typed `number` (per the brief) but live `Application.amount`/`Invoice.total` are Prisma `Decimal`. Whoever wires this module to real rows MUST convert via `.toNumber()` at every call site (and map `deletedAt`/`type`). Not a defect in Task 5; a call-site obligation for the services. (Also Task 5 Minor #1 `Math.abs(cents(total))` vs `cents(Math.abs(total))` — unreachable given Decimal(12,2); no action.)

## Task detail

### Task 16 — complete (BASE `e5ea19e`, code `14ff4fa`; review Approved — sonnet)
- **`write_off` route gating added (Task 7 deferred):** `POST /applications` now does `mustCan(create)` → parse → `if hasWriteOffLine(body) mustDo(user, "write_off")` → `applyPayment` (single `requireUser()`, reused). `hasWriteOffLine` is a defensive type-guard (false on malformed, never over-matches — a bad body still 400s via applyPayment's zod). A `create`-but-no-`write_off` session submitting a WRITE_OFF (even mixed with PAYMENT) → 403, whole body rejected before the claim; PAYMENT/DISCOUNT-only bypasses. `credit-applications` correctly ungated (hard-codes type CREDIT, no smuggle path).
- **401/403 sweep complete:** all 13 route files / 19 route+verb combos have non-vacuous 401 (no session) + 403 (a session holding a DIFFERENT permission that excludes the gated one). `permissions-sweep.test.ts` provably untouched/unweakened; the new `const user = requireUser()` shape still matches its regex.
- Gates: `npm test` 1860, tsc/eslint/build clean. Reviewer (sonnet): Spec ✅, Approved. Minor: test-style mix (cosmetic).

### Task 15 — complete (BASE `b56b202`, code `d916dc4` + fix `5253423`; review Approved after 1 fix round — sonnet)
- `Statements.tsx` (customer/family + as-of + combined/per-division + assess-FC toggle OFF by default; Print [view] + Run [create]; archived-STATEMENT documents list → /api/documents/<id>). `ReceivablesSection.tsx` on the customer page (net + open items + aging strip + Statement/Apply links, InvoicesSection precedent), mounted in customers/[id]/page.tsx. `ReceivablesNav.tsx` sub-nav (worklist/aging/statements) on all three /receivables screens — closes Task 14's nav-link gap. Two new read endpoints: `GET /api/customers/[id]/receivables` (via `customer-receivables.ts`) and `GET /api/receivables/statements/documents` (via `listDocumentsForCustomer`), both `receivables.view`, tested.
- **Review round 1 (Needs fixes → fixed `5253423`):** (Important) `customerReceivablesSummary` composed `agingReport` (child = own row) with `openInvoicesForPayer` (child = whole family) → a division's page showed its own net above the parent+siblings' open items, unlabeled + non-reconciling. **Fixed:** added `customerOwnAgingRow` (aging.ts, non-rollup) + `openInvoicesForCustomer` (applications.ts, via shared private `openInvoicesForCustomerIds`; `openInvoicesForPayer`/`agingReport` provably unchanged for Task 10/13 callers); customer section now single-customer own A/R for parent/child/standalone alike. Non-vacuous parent+child regression test (both directions). Re-review: Approved, zero outstanding.
- Gates: tsc/eslint/build clean; `npm test` 1854 + fix covering tests 103 passed. Browser check deferred to Task 17 E2E.
- **Owner note (potential enhancement):** the customer A/R section is scoped to that customer's OWN A/R. If the owner wants a family roll-up on a parent's page, that's a follow-up (needs a Customer column to label rows) — surface at demo.

### Task 14 — complete (BASE `b3b4c38`, code `15513f3`; review Approved — sonnet)
- `AgingReport.tsx` (client, `receivables.view`): as-of date picker (default today), customer/family filter (§5.16 disabled-with-tooltip on `customers.view`), AgingRow table driven by `AGING_BUCKETS.map` (headers + data can't drift), totals `<tfoot>`, Excel export `<a>` sharing the exact same `query` string as the JSON fetch. Uses `AGING_BUCKET_LABELS` (en-dash), no src/server import, `page.tsx` thin wrapper.
- **Closed both Task-10 minors:** (1) the export route (`aging/export/route.ts`) headers now use `AGING_BUCKET_LABELS` (match the UI); (2) all-zero rows filtered client-side (`isAllZero` over all 7 money fields, before body + totals), `aging.ts` untouched.
- **Nav-link gap flagged (→ Task 15):** nothing links to `/receivables/aging` yet — folding a `/receivables` sub-nav (worklist / aging / statements) into Task 15.
- Gates: tsc/eslint/build clean; `npm test` 1849 (export-header test still green). Reviewer (sonnet): Spec ✅, Approved. Minors → deferred (object-spread-in-reduce; picker omits inactive customers).

### Task 13 — complete (BASE `f2f693c`, code `ffd6139` + fix `1ce9a82`; review Approved after 1 fix round; crash-recovered)
- `/receivables` worklist (`ReceivablesList.tsx`) + batch-entry/apply screen (`BatchDetail.tsx`, 31 KB) following 5A `InvoiceDetail` binding-state (`key={id}`, useMutationGate/useEditGuard/useBulkGrid, gate/gateDo). Nav: dead "A/R"→/ar repurposed to "Receivables"→/receivables (one entry, `receivables.view`). Backend read endpoints the UI needed (Tasks 6–8 built only mutations): `listBatches`, `openInvoicesForPayer` (family = `parentId ?? self` + children), `invoiceOpenBalanceById`, 2 GET routes (`receivables.view`), `RECEIPT_BATCH_STATUS_LABELS` — read-only, reuse ar-balances, Decimal→number, `deletedAt:null`, tested.
- **Crash recovery:** the implementer finished but a host crash lost its commit/report/gate-run; controller verified the uncommitted tree (no stubs, gates green — tsc/eslint/build clean, `npm test` 1845), committed `ffd6139`, wrote a recovery report.
- **Review round 1 (Needs fixes → fixed `1ce9a82`):** (Important) apply money-control gate was `receivables.edit` but the route enforces `create` → **owner ruled `create`**, UI aligned (only that gate moved; post=edit, add-payment=create, voids=delete untouched; write-off keeps its `gateDo(write_off)` layer). (Important) added 4 non-vacuous 401/403 tests for `GET /api/receivables/applications` (both modes). Re-review: Approved, zero outstanding.
- Gates: tsc/eslint/build clean; `npm test` 1845 (pre-fix) + fix covering tests 29 passed. Reviewers (sonnet): Spec ✅, Approved. Minors → deferred (documentNumber dup; ApplyPanel N+1 discount fetch). Browser check deferred to Task 17 E2E.

### Task 12 — complete (BASE `7d79440`, code `a2c6bde`; review Approved — opus)
- `statements.ts` (366) + `pdf/statement.ts` (204) + 2 routes + 3 test files. `buildStatement` (open items: invoices +, credits/on-account −; aging via shared `bucketAging`; totalDue = net; FC gated on assess AND non-exempt past-due, base on gross past-due; remit-to via `invoicePrintSettings`), `printStatement` (the 5A print bracket: settings outside tx → render → audited `storeDocument({STATEMENT, customerId})` on tx), `runStatements` (nonzero-net customers).
- **Byte-exact reprint (the trap) handled correctly:** reprint compares STORED bytes (`Buffer.compare` on two `getDocument`s) — never two fresh renders; content pinned on the pdfmake DEFINITION via `allText`; structure via `%PDF-`. Fixture reproduced exactly (open 400 / credit −200 / d31_60 400 / unapplied 200 / net 200 / totalDue 200 / FC null→6.00 assessed).
- **No row claim — correct by first principles:** a statement allocates no sequence, flips no status, has no one-live-per-scope rule; storeDocument mutates no A/R state, so no cross-tx invariant to guard (reviewer agreed; contrast printInvoice's `claimOrder`). Retained Serializable pairs with the audited insert.
- Widened `FinanceChargeInput.rate` to `number | null` (the Task 11 review note; semantics unchanged, null→0). Decimal→number throughout; `pdf/statement.ts` pure.
- Gates: `npm test` 1832, tsc/eslint/build clean, E2E 16/16. Reviewer (opus): Spec ✅, Approved. 2 Minors → deferred (snapshot-drift guard worth doing); 1 owner note (credit-balance statements).

### Task 11 — complete (BASE `a77077b`, code `36bccd8`; review clean)
- Pure `finance-charges.ts` (33 lines): `financeCharge({ pastDueBalances, rate })` = `round(Σ non-exempt open × rate/100)`, 0 when rate null/0 or nothing past-due; `financeChargeRateFor(customerRate, plantRate)` = override-else-plant via `??` (an explicit customer `0` is a valid opt-out → 0, consistent with financeCharge's zero-rate short-circuit). Integer-cent, same `cents` helper as ar-balances/aging (reviewer spot-checked 56 combos — no drift).
- Gates: `npm test` 1812, tsc/eslint/build clean. Reviewer: Spec ✅, Approved. Minor: `FinanceChargeInput.rate` typed `number` but a test passes `null` via cast → widen to `number | null` **at Task 12** (helps the call site pass a resolved-but-possibly-null rate). Inherited from the brief's interface.

### Task 10 — complete (BASE `dcd2d0e`, code `2caaeec`; review Approved — opus)
- Pure `bucketAging(snap, asOf, customers)` + service `agingReport(filter)` + JSON/Excel-export routes. Point-in-time: only invoices `finalizedAt ≤ asOf`, reduced by only live apps `appliedDate ≤ asOf`. Buckets by dueDate (≥asOf→current, 1-30/31-60/61-90/>90); Unapplied = credit remaining + on-account (separate column); net = buckets − unapplied. Integer-cent, UTC-midnight-drift-free. Family roll-up = per-child rows + parent-keyed family total.
- **Point-in-time verified:** the same-fixture-two-asOf test discriminates both filters (late-finalized invoice excluded; future-dated app doesn't reduce). Payment-side point-in-time (implementer addition) is provably consistent — PAYMENT `appliedDate = receivedDate`, so invoice-side and payment-side filters key on the same date, can't desync. Cross-customer credit in the family query is correct (each side caught from its own side, no double-count).
- Export reuses `parts/export`'s `toXlsx`; both routes gated `receivables.view`; 403/404 covered. Decimal→number at the snapshot boundary. Read-only (no claim/audit; asserts auditLog.count()===0).
- Gates: `npm test` 1804, tsc/eslint/build clean. Reviewer (opus): Spec ✅, Approved. 4 Minors → deferred list (2 for Task 14).

### Task 9 — complete (BASE `cfc1827`, code `1b7210b` + fix `2483bd0`; review Approved after 1 fix round — opus)
- `hasReceivableActivity(tx, invoiceId)` added to the `invoice-guards.ts` LEAF (imports only `type Prisma`; a live Application where `invoiceId = this` OR `creditInvoiceId = this`). `unlockInvoice`/`discardInvoice` (invoices.ts) + `voidOrder` (orders.ts) refuse under their existing claim, no new lock. `unlockInvoice` gained an optional `tx` param (finalizeInvoice precedent) for the concurrency test.
- **discardInvoice guard is defense-in-depth** (a DRAFT can't carry real A/R activity — applications require finalized); proved wired via a raw-inserted Application against a DRAFT credit, documented.
- **Concurrency test (mandated, RED-verified):** apply racing unlock; competitor pinned to Read Committed; guard removed → both commit an unlocked invoice with a live application (RED); restored → refuses (GREEN). Implementer also ran full E2E 16/16 (touches void-order/unlock flows).
- **Review round 1 (opus caught a real Important gap):** `voidOrder` checked A/R activity only on the finalized INVOICE, missing a reachable applied-CREDIT-on-order case (inv_O finalized → credit_C → applyCredit cross-order → unlock inv_O → voidOrder(O) orphaned the credit). **Fixed** (`2483bd0`): added leaf-safe `hasReceivableActivityForOrder(tx, orderId)` (any live Application where `invoice.orderId` OR `creditInvoice.orderId` = O); voidOrder uses it (strictly stronger than the per-invoice check). Regression test builds the exact sequence via real services, RED-verified. Re-review: Approved, zero outstanding (the prior Minor also resolved).
- Gates: `npm test` 1785, tsc/eslint/build clean, E2E 16/16.

### Task 8 — complete (BASE `1598876`, code `2928082`; review Approved — opus)
- `applyCredit` added to `applications.ts` (129 lines) + route + the Task 2 audit enhancement. Reuses Task 7's claim: unlocked stubs (target = live FINALIZED INVOICE; source = live FINALIZED CREDIT) → `claimOrdersInOrder([both orders])` → ONE sorted `FOR UPDATE` over BOTH invoice rows (target + credit). The **credit's own row is locked** in that statement, so two concurrent `applyCredit(sameCredit → diff invoices)` serialize on the credit row and the second sees the first's app — race closed by the LOCK, not SSI (reviewer-confirmed). Global order Order<Invoice, a prefix of applyPayment's — no ABBA.
- Both over-application checks read after the claims (credit remaining via `creditRemaining(|total|)`; invoice open reuses applyPayment's message/invariant). Application `{ type: CREDIT, paymentId: null, creditInvoiceId, appliedDate: today }` satisfies `Application_source_check`.
- **Audit enhancement landed (Task 2 carry closed):** `SNAPSHOT_INCLUDE.application` gains `creditInvoice`; a void-snapshot test asserts real content (before.creditInvoice.kind + order.orderNumber) — also the live exercise of the include.
- Gates: `npm test` 1778, tsc/eslint/build clean. Reviewer (opus): Spec ✅, Approved. Minors: no credit-path concurrency test (brief scoped out; lock proven identical to Task 7); `APPLICATIONS_LITE_SELECT` vs applyPayment's inline select DRY drift → deferred.

### Task 7 — complete (BASE `cc824e8`, code `34fe94a`; review Approved — opus)
- `applications.ts` (297 lines) + 2 routes + 3 test files (610 lines). `applyPayment` applies PAYMENT/DISCOUNT/WRITE_OFF across ≥1 invoices under ONE claim; `voidApplication`; `discountAvailable`. On-account is the unapplied remainder by construction (no write).
- **Lock shape (correct, reviewer-verified acyclic):** unlocked stub read → `claimOrdersInOrder(tx, orderIds)` (sorted) → sorted invoice-row `FOR UPDATE` (`ANY(...) ORDER BY id`) → **added** Payment-row `FOR UPDATE` last (closes same-payment/two-invoice over-application). Global order Order<Invoice<Payment, consistent with `voidApplication` (Order<Invoice; no payment lock needed — on-account is derived). Reviewer cross-checked `receipts.ts voidPayment` locks ReceiptBatch only → no counterparty inverts the order.
- **Concurrency test (mandated, RED-verified):** two apps race on a 1000 invoice, 700 each; competitor pinned to Read Committed; claim removed → double-commit to 1400 (RED); restored → second refuses "exceeds the invoice's open balance of 300" (GREEN). Reviewer confirmed it genuinely discriminates.
- Over-application both sides (invoice Σ≤total; payment Σ PAYMENT≤amount); Decimal→number everywhere; discount window (`2/10/30`, receivedDate ≤ invoiceDate+discountDays); WRITE_OFF reason required+audited; appliedDate = payment.receivedDate. No CREDIT logic (Task 8).
- Gates: `npm test` 1766, tsc/eslint/build clean. Reviewer (opus): Spec ✅, Approved, no Critical/Important. 4 Minors (doc/hardening) → deferred list; discount-basis → owner rulings.

### Task 6 — complete (BASE `f15974e`, code `1acfc41`; review Approved — opus)
- `receipts.ts` (319 lines): `createBatch`/`getBatch`/`addPayment`/`voidPayment`/`postBatch`/`voidBatch` + live balance, 4 route files. Canonical nesting (withDbErrors → Serializable $transaction → `claimBatch` FOR UPDATE → audited* → writes on tx). `enteredTotal` = Σ live payments; `balance` = `(controlTotal ?? enteredTotal) − enteredTotal`; per-payment `onAccount` via `ar-balances.paymentOnAccount`.
- **Deviation (correct):** `assertRefExists("customer", …)` doesn't exist (customer isn't a reference kind) — implementer used a direct `tx.customer.findFirst({ deletedAt: null })` INSIDE the Serializable tx (SSI read-set participation), clean 400, matching orders.ts. `paymentType` uses `assertRefExists` (it IS a reference kind). Reviewer confirmed correct.
- **Decimal discipline (Task 5 carry honored):** single `.toNumber()` boundary, integer-cent balance math, no raw-Decimal JS arithmetic, no Decimal leaks into number fields. Reviewer: "airtight."
- The batch claim is a real parameterized `$queryRaw … FOR UPDATE` (no injection), taken first in all four post/void/add paths.
- Gates: `npm test` 1739, tsc/eslint/build clean. Reviewer (opus): Spec ✅, Approved, no Critical/Important.
- **Owner-ruling item:** POSTED lifecycle asymmetry → see "Owner rulings owed" above.
- Minors → deferred list (no 401 route test; no getBatch-returns-voided test; paymentType double round-trip).

### Task 5 — complete (BASE `6cbc7e8`, code `81beb71`; review clean)
- Pure `ar-balances.ts` (36 lines): `invoiceOpenBalance` (subtracts all live types), `paymentOnAccount` (live PAYMENT only), `creditRemaining` (`|total|` − live). Voided-exclusion centralized in one `isLive`/`sumCents` helper (all three inherit it). Integer-cent math via a used `cents` helper; the `0.3 − 0.1 === 0.2` float-drift case passes. Only import is `type ApplicationTypeValue` from ar-constants (pure).
- Gates: `npm test` 1718, tsc/eslint/build clean. Reviewer (sonnet): Spec ✅, Approved. Minors → deferred list (Decimal→number call-site obligation carried to consuming tasks).

### Task 4 — complete (BASE `8ed9792`, code `6ec3a3c` + fix `fbfe9f5`; review Approved after 1 fix round; browser-verified)
- Terms gains `netDays`/`discountPercent`/`discountDays` via `reference.ts`'s `EXTRA_SCHEMAS.terms`; both-or-neither enforced merge-safely by `requireDiscountPair` on the composed create/update schema (NOT a `.refine` on the ZodObject entry, which would break `.merge`/`.partial` for every kind). `netDays` left zod-optional (DB `@default(30)` fills on create; a partial PATCH never resets it). `BillingConfig.financeChargeRate` added to the FIELDS registry + type + EMPTY + read/write. Admin UIs: reference editor gained a new `"decimal"` field kind (blank-drops cleanly, unlike bare text); billing page gained the finance-charge input.
- **Review round 1 (Needs fixes → fixed):** (Important) `discountPercent` was `kind:"text"` so a typed-then-cleared value sent `""` → cryptic decimalField 400; fixed with the `"decimal"` kind + widened blank-drop. (Important) added the netDays-unchanged-on-partial-update regression test. Plus 3 Minors (paste numberColumns test, EMPTY-fallback financeChargeRate assertion, paste.ts Number() consistency) and a report/comment accuracy fix (the both-or-neither guard does NOT mirror surcharges.ts). Re-review: Approved, zero outstanding.
- **Browser-verified (controller):** `/admin/billing` renders "Finance charge (monthly %)"; `/admin/reference` → Terms renders Net days / Discount % / Discount days with the both-or-neither hint; a valid `2/10/30` Term created via the UI (POST 200) and persisted as 30/2/10. Dev-DB test fixture cleaned up. (Pane not composited → screenshots unavailable; verified via read_page/network.)
- Gates: `npm test` 1711, tsc/eslint/build clean.

### Task 3 — complete (BASE `3d3e855`, code `3a0e8e9`; review clean)
- `createCredit` stamps `todayDateOnly()` in both the create data and the auditData (credit ages from its raise date). `finalizeInvoiceInTx` sets `dueDate = addDays(invoiceDate, terms.netDays)` for INVOICE only, keyed on `terms` presence (netDays is never null — `@default(30)`); read within the existing invoice claim, no new lock. New calendar `addDays` in business-days.ts (distinct from `addBusinessDays`).
- Brief's "amend the existing source-date assertion" had no such assertion; implementer added a dedicated non-vacuous test (30-days-ago source → credit dated today, `!==` source) + audit-content check. Reviewer verified it's a real regression guard.
- Gates: `npm test` 1704, tsc/eslint/build clean. Reviewer (sonnet): Spec ✅, quality Approved. Minors (both non-defects): an `orderBy`-less audit lookup fine today; dueDate computed-then-discarded for CREDIT via spread guard (cosmetic).

### Task 2 — complete (BASE `c0332a1`, code `2d639e2`; review clean)
- Three new tables (`ReceiptBatch`/`Payment`/`Application`), `ApplicationType` enum, column additions to Terms/Invoice/BillingConfig/StoredDocument, two hand-written CHECKs, audit/documents wiring.
- **Migration split (controller-corrected vs brief):** `20260808230000_document_kind_statement_value` (ADD VALUE 'STATEMENT' only) + `20260808230100_accounts_receivable` (everything else). The brief's Step 4 wrongly cited the older `20260804122700` file for the CHECK source and didn't call out the enum-split; I supplied the exact extended CHECK SQL (sourced from 5A's `20260806221500`, `customerId IS NULL` added to every prior arm + STATEMENT arm, SHIPPER stays loose on orderId) and mandated the two-dir split per CLAUDE.md. Both migrations applied to both DBs; 28 migrations, status clean, zero drift.
- **`Application_source_check`** verbatim to spec §4.1 (does not require paymentId on non-credit arms — standalone bad-debt write-off).
- **CLAUDE.md** updated in step (repoints the current CHECK definition to the new migration, documents STATEMENT + the customerId-null tightening, adds the new dir to the ADD VALUE list) — the mandatory docs-in-step convention.
- **Deviation A (correct):** only `Payment.paymentTypeId` registered in `reference-links.ts` — the other five FKs target non-reference-kind models (`BlockerTarget` type + the sweep only cover reference kinds); the brief's Step 7 over-listed. Reviewer independently confirmed from `REFERENCE_KINDS`.
- **Deviation B (correct):** `DocumentMeta` gained required `customerId`, forcing one-token `customerId: null` on three hand-built meta literals (certs/shippers print, traveler) + a `"STATEMENT"` enum-pin in `invoicing-schema.test.ts`. All forced, no scope creep.
- Tests: schema round-trip + a real negative asserting the DB rejects a CREDIT-with-paymentId (SQLSTATE 23514, count stays 0). Gates: `npm test` 1696, tsc/eslint/build clean.
- Reviewer (opus): Spec ✅, quality Approved. One Minor (snapshot coverage) → deferred list above.

### Task 1 — complete (BASE `c0af0a8`, code `492bffe`, report `ac4680b`; review clean)
- Added `src/lib/ar-constants.ts` (pure/client-safe: `APPLICATION_TYPES`, `RECEIPT_BATCH_STATUSES`, `AGING_BUCKETS` + label maps), `"receivables"` to `AREAS`, `"write_off"` to `SPECIAL_ACTIONS`, and the `receipt_batch_number_next` counter (default 1000) to the settings registry.
- Tests: permissions area/action case; `allocateNumber` returns 1000→1001; `partial-unique-sweep` allow-list gains `"ReceiptBatch.batchNumber"` (allocation-only exemption, inert until Task 2's schema adds the column — reviewer traced the sweep to confirm it is not a false-pass).
- Gates: `npm test` 1694/1694, `tsc`/`eslint`/`build` clean (all foreground).
- Reviewer verdict: Spec ✅, quality Approved, zero findings. Byte-diffed `ar-constants.ts` (incl. en-dash label bytes) and hand-counted 13 areas / 12 specials.
- Process note: the first implementer dispatch stalled polling a backgrounded `npm test`; redirected via SendMessage to run gates foreground, which completed cleanly. It also self-recovered a stray `git stash` mid-task — verified afterward: clean tree, empty stash list, no lost work.
