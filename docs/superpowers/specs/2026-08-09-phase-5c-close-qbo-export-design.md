# Phase 5C — Month-End Close & QuickBooks Online Summary Export: Design Specification

**Date:** 2026-08-09
**Status:** Approved by owner in the design session of 2026-08-09 (§3 records every ruling taken)
**Branch:** `phase-5c-close-qbo-export`
**Supersedes, in part:** spec §7.6 (the close/QBO half — guided month-end close, the summary GL export)
**Depends on:** Phase 5A (`Invoice`/`InvoiceLine.glAccountId`+`glAccountName`, `BillingConfig`, the frozen-invoice snapshot rule, the claim/audit/document/render patterns), Phase 5B (`Payment`/`PaymentType.glAccountId`, the typed `Application` ledger, `ar-balances.ts`, `aging.ts`, `invoice-guards.ts`, the `hasReceivableActivity` cross-phase guard), Phase 2A (the `GlAccount` maintained reference table, the §5.14 delete-blocker registry)

---

## 1. Goal

Turn Phase 5A's finalized invoices/credits and Phase 5B's receipts ledger into a **guided month-end close** and a **QuickBooks Online summary journal export**. The close shows **invoiced / paid / ending A/R side-by-side** for a month, reconciles the A/R sub-ledger's roll-forward against the point-in-time aging, and saves a frozen close record. The export produces a **downloadable summary-journal file** (plus a human-readable posting register) that the bookkeeper imports into QBO — accrual double-entry, summarized by GL account, detail left in the ERP, **idempotent** so a re-run can never double-post, and **refusing to export** rather than posting a line with no GL account.

This is the third and final slice of the roadmap's Phase 5 (5A pricing/invoicing → 5B accounts receivable → 5C close/QBO, split by 5A §3.1 ruling 1). Reaching the end of 5C is what makes the roadmap's **parallel-run acceptance criterion** testable: "one full month closed in the new system — A/R aging and the QuickBooks summary export agreeing with the books" (spec §13). 5C's own testable outcome: **close a month and export a balanced summary journal the bookkeeper can import.**

## 2. Scope

**In:** a per-month **close record** (the invoiced/paid/ending-A/R continuity schedule, frozen at close); a **preliminary closing report** (the same schedule, read-only, before committing); a **soft, reopenable close** that **locks its month** against backdated posting; the **accrual summary journal** — sales side (finalized invoices/credits → A/R + revenue + tax) and cash side (posted payments → cash + A/R; discounts and write-offs → their accounts + A/R); a **downloadable export file** + a stored **posting register**, both byte-for-byte reprintable; **delta / mark-sent idempotency** across re-runs and reopen-and-re-close corrections; a **readiness check** that names every account-less step code / surcharge / payment type / missing plant default and blocks the export until resolved; three new plant-default GL accounts on `BillingConfig`, editable in Admin → Billing; a `/receivables/close` UI; two named special permissions (`close_ar_period`, `run_qbo_export`).

**Out (later phases or deliberate — §16):** any **live QuickBooks Online / Intuit API** connection (file only — deferred, owner ruling 2026-08-09); **posting finance charges** to the GL (they stay informational-only, spec §14.2 / 5B); **cash-basis** journals (QBO derives cash-basis reports from accrual entries); **opening-balance entry** for pre-HeatSynQ A/R (chain-from-zero, ruling 5); **write-off flavor** accounts (one write-off account, ruling 3); multi-currency; a report-painter for the register (it is a fixed layout, spec §8 boundary).

**The frozen-paper rule carries forward.** The close reads 5A's frozen `InvoiceLine`/`Invoice` snapshots and 5B's `Application`/`Payment` rows; it **never restates** any of them. A closed month's exported journal is frozen on its export batch and is never recomputed from live state — the same choice invoices (5A §5.4) and statements (5B §8) already make.

## 3. Owner decisions, 2026-08-09 (this design session)

| # | Decision | Ruling |
|---|---|---|
| 1 | QBO delivery | **Downloadable file only.** 5C generates a summary-journal file the bookkeeper imports/keys into QBO; **no live Intuit API** (deferred to a later phase). Fits the self-hosted, no-external-dependency design and needs no credentials to build |
| 2 | Close behavior on a backdated correction | **Soft, VS-style close.** Closing **freezes and stores** the month's figures + exported journal and **locks the month**; fixing a closed month means an **audited, reasoned reopen** → correct → re-close, which emits a new export **delta**. Matches Visual Shop's "invoices closed after the cutoff may be reopened and marked Not Closed" |
| 3 | Write-off GL | **One write-off account** (`BillingConfig.writeOffGlAccountId`); a bad debt needing reclassification is the bookkeeper's move in QBO. No change to 5B's `Application` (no flavor field) |
| 4 | Finance charges & sales tax | **FC excluded** from the export (informational-only, 5B); **sales tax** flows to the existing `BillingConfig.salesTaxGlAccountId` — zero if the shop doesn't tax heat-treating. Neither is an open question |
| 5 | Opening A/R during parallel run | **Chain from zero.** Each close's beginning A/R = the prior close's ending; the first close starts at $0. The acceptance test compares the month's **activity** to QBO, not the absolute company A/R total. No opening-balance entry mechanism is built |
| 6 | GL account list | **Data, not design.** GL accounts are the existing maintained reference table (editable in admin); the three new plant defaults are editable in Admin → Billing. The dev **seed** wires sensible accounts so the demo path works. The build proceeds without the real list; the export **refuses** until accounts are keyed (spec §15) |
| 7 | Correction JE date | **Period-end for the time being** — a reopened-and-re-closed month's delta is dated that month's end. Whether corrections into a QBO-closed month should instead date in the current open period is **bookkeeper homework** (owner checking 2026-08-10); the export dates period-end until told otherwise |

## 4. Data model

### 4.1 New tables

- **`ClosePeriod`** — one row per calendar month. `year Int`, `month Int` (1–12), `@@unique([year, month])` (a plain unique — a close is never soft-deleted, only reopened, so no partial index and no sweep exemption). `status String` (`CLOSED` ↔ `REOPENED`). The **frozen continuity schedule**, all `Decimal @db.Decimal(12, 2)`: `beginningAr`, `invoicedTotal`, `creditTotal`, `paymentTotal`, `discountTotal`, `writeOffTotal`, `endingAr`. `agingEndingAr Decimal @db.Decimal(12, 2)` (the point-in-time aging's net-owed at period-end, stored beside `endingAr` for the reconciliation proof, §6). `closedAt`, `closedById → User`, `reopenedAt DateTime?`, `reopenReason String @default("")`, `notes String @default("")`, timestamps. There is no `OPEN` status: a `ClosePeriod` **is** the act of closing — an un-closed month simply has no row.
- **`GlExportBatch`** — append-only, one per export run, `closePeriodId → ClosePeriod` (the close it was produced for). `exportNumber Int @unique` (from a new `gl_export_batch_number_next` counter, never reissued — the `receipt_batch_next`/`creditNumber` allocation-only precedent, documented sweep exemption). `emittedAt`, `emittedById → User`, `periodEnd DateTime @db.Date` (the JE date on every line in this batch, ruling 7). Its **postings** (`GlPosting[]`, §4.3) and the **stored artifacts**: `file Bytes` + `fileName`/`fileContentType` (the CSV the bookkeeper imports) and `register Bytes` + `registerContentType` (the posting-register PDF) — both stored **byte-for-byte and reprintable**, the invoice/statement storage pattern, but **not** a `StoredDocument`: a GL export is none of spec §8's eight document types, so it owns its own bytes and the `StoredDocument` kind→owner `CHECK` is left untouched (no new document-kind migration).
- **`GlPosting`** — the **append-only posting ledger**: one row per (export batch, source event, GL account) contribution. `batchId → GlExportBatch`, `sourceType String` (`INVOICE` | `CREDIT` | `PAYMENT` | `DISCOUNT` | `WRITE_OFF`), `sourceId String` (the invoice/payment/application id), `glDate DateTime @db.Date` (the event's GL date — §4.3), `glAccountId → GlAccount?` + `glAccountName String` (frozen text, the `InvoiceLine.glAccountName` precedent; FK nullable `ON DELETE SET NULL` so a later account delete never rewrites sent paper), `debit Decimal @db.Decimal(12, 2)`, `credit Decimal @db.Decimal(12, 2)`, `side String` (`SALES` | `CASH`), `isReversal Boolean @default(false)`. `@@index([sourceType, sourceId])`, `@@index([batchId])`, `@@index([glDate])`. This **is** the "detail stays in the ERP" (spec §7.6): the exported **file** is `GlPosting` aggregated by account for the batch (dated `periodEnd`), while these per-event rows stay in the ERP and drive the delta detection. There is no separate summary-line table — the frozen `file Bytes` preserve the exact emitted summary, and the register re-aggregates the batch's postings.

### 4.2 Changes to existing models

| Model | Change |
|---|---|
| `BillingConfig` | **gains** three nullable FKs to `GlAccount` — `arGlAccountId` (the A/R control account; **required** for any export), `discountGlAccountId` (sales discounts taken), `writeOffGlAccountId` (write-offs). Each needs a **named** relation (three FKs to one model, the existing `BillingSalesTaxGl`/`BillingFreightGl`/`BillingOtherChargeGl` precedent). Editable in Admin → Billing |
| `GlAccount` | gains the three back-relations for the above; **no** functional change. Its existing partial-unique `name` and soft-delete are unchanged |
| `Invoice`, `InvoiceLine`, `Payment`, `Application`, `PaymentType` | **no schema change** — 5C only *reads* them. The sales-side GL is `InvoiceLine.glAccountId`; the cash-side GL is `Payment.paymentTypeId → PaymentType.glAccountId`; discount/write-off accounts are the new `BillingConfig` defaults |

No column is ever added to cache a balance or a posted-flag on `Invoice`/`Payment`/`Application` — the export's mark-sent state lives entirely in the append-only `GlPosting` ledger (§4.3), keeping 5B's "balances derive from `Application`, nothing cached" invariant intact.

### 4.3 The export contract — delta, mark-sent, idempotent

A **postable event** and the balanced journal lines it implies (§5):

| Event | GL date | Side |
|---|---|---|
| A finalized `INVOICE` / `CREDIT` (not discarded) | `invoiceDate` | SALES |
| A posted (`ReceiptBatch.status = POSTED`), non-voided `Payment` | `receivedDate` | CASH |
| A live `DISCOUNT` / `WRITE_OFF` `Application` | `appliedDate` | CASH |

*(A `PAYMENT`/`CREDIT`-type `Application` posts nothing — the cash was booked when the payment posted, the credit when it was raised, §5.)*

**The delta contract — export is per-event, bounded STRICTLY to the period's own month.** Exporting close period *P* (month `[monthStart, monthEnd]`) works entirely within events **dated in that month** — not cumulatively `≤ monthEnd`. Per-period bounds are sound because the period lock (§6) guarantees a closed month's postable events can't change, so each month's export is self-contained; a cumulative bound would let a *later* month's export (if run first) vacuum an earlier month's events under the later date and then double-post them when the earlier month exports. Per event, keyed by `(sourceType, sourceId)`:

- **In-scope live events** = the current postable events (finalized non-discarded invoices/credits; posted non-void payments; live discount/write-off applications) whose GL-date falls **within the month**.
- **Net prior postings** = the `GlPosting` rows with `glDate` **within the month** (all of this period's postings are stamped `monthEnd`), grouped by `(sourceType, sourceId)`, with reversals cancelling originals.
- **New** = in-scope live events with **no** net prior posting → emit their §5 lines; write positive `GlPosting` rows.
- **Reversed** = events with a net prior posting that are **no longer** in-scope-live (voided/unlocked/discarded — reachable only after a reopen, §6) → emit reversing lines; write `isReversal` `GlPosting` rows negating the original.
- The batch's exported **file** is this batch's new + reversed postings **aggregated by account** (and side), one summary journal dated E.

This gives the three spec guarantees directly: **idempotent** — a re-run with nothing changed finds no new and no reversed events, so an empty, no-op export ("once marked sent, can never double-post", spec §12); **correction-safe** — a post-reopen void becomes a reversing delta automatically, no manual reversal, no double-count; **reproducible** — a past batch's `GlPosting` rows and `file` bytes are frozen, so reading a past period reads the batch, not live state. Reproducibility is 5C's own guarantee and does **not** lean on issue #78's live-aging weakness: the close and its export are read from the frozen record, and the **period lock** (§6) keeps a closed month's postable state from drifting at all.

## 5. The two journals (the accrual model)

Every batch is one summary journal, balanced (Σ debits = Σ credits), dated `periodEnd` (ruling 7). Amounts are sums of already-rounded 5A/5B line amounts.

**Sales side — from finalized invoices/credits, grouped by account:**

| Line | Debit | Credit | Source |
|---|---|---|---|
| A/R control | `Invoice.total` | | `BillingConfig.arGlAccountId` |
| Revenue (per account) | | each group's amount | `InvoiceLine.glAccountId` — operations (step-code GL), surcharges (surcharge GL), cert (cert-step GL), freight (`freightGlAccountId`), other charges (`otherChargeGlAccountId`) |
| Sales Tax Payable | | `Invoice.taxTotal` | `BillingConfig.salesTaxGlAccountId` |

A `CREDIT` posts the mirror image (CR A/R, DR revenue/tax). Balance holds because `Invoice.total = subtotal + surchargeTotal + chargeTotal + certTotal + freightTotal + taxTotal`, and every non-A/R, non-tax line resolves to a revenue account (or the readiness check blocks the export, §7).

**Cash side — from posted payments and discount/write-off applications:**

| Line | Debit | Credit | Source |
|---|---|---|---|
| Cash / bank (per payment type) | `Payment.amount` | | `PaymentType.glAccountId` |
| Sales discounts | `Application.amount` (DISCOUNT) | | `BillingConfig.discountGlAccountId` |
| Write-offs | `Application.amount` (WRITE_OFF) | | `BillingConfig.writeOffGlAccountId` |
| A/R control | | payment + discount + write-off | `BillingConfig.arGlAccountId` |

A `PAYMENT`-type application posts nothing (cash already booked at the payment); a `CREDIT`-type application posts nothing (the credit was booked when raised). An on-account (unapplied) payment still books its full cash and A/R credit, correctly leaving a customer credit balance. Balance holds: DR (cash + discount + write-off) = CR A/R.

**Finance charges post nothing** (ruling 4). This is the whole GL surface — there is no inventory, COGS, or job-cost posting (all out of scope, spec §3).

## 6. The close lifecycle and the period lock

1. **Preliminary Closing Report** — read-only, any month, any time. The continuity schedule (§4.1 figures) computed live, plus the point-in-time aging at period-end and a **variance line** (`endingAr − agingEndingAr`, expected 0). It also **flags** un-posted (`OPEN`) receipt batches with payments dated in the month (their cash is not yet postable) and any account-less postable events (the §7 readiness list). Mirrors VS's *Preliminary Closing Report*.
2. **Close** (`close_ar_period`) — requires the **prior month closed** (or this is the first close), a **zero variance** (the roll-forward reconciles to the aging, else the close is refused with the variance named), and an empty readiness list is **not** required to close but **is** required to export. Writes the `ClosePeriod` with `status = CLOSED` and the frozen figures. Beginning A/R = the prior close's `endingAr`, else $0.
3. **The period lock** — a new cross-phase guard, `assertPeriodOpen(date)` (the `hasReceivableActivity` precedent, in a dependency-free leaf so 5A/5B services can call it without an import cycle). Any mutation whose GL date falls in a **closed** month is refused: finalizing/unlocking an invoice, raising/discarding a credit, posting/voiding a payment or receipt batch, creating/voiding an application. The refusal names the closed period and points at reopen. This is what makes the close trustworthy and makes issue #78 moot for closed months — a closed month's postable state cannot change.
4. **Export** (`run_qbo_export`) — computes the delta (§4.3), refuses if the readiness list is non-empty (§7), renders the file + register, and writes a new `GlExportBatch` with its `GlPosting` rows (the mark-sent). Re-exporting a period with no change finds no new/reversed events and is a no-op (idempotent).
5. **Reopen** (`close_ar_period`, **reason required**, audited) — flips the `ClosePeriod` to `REOPENED`, lifting the lock for that month. **Any** closed month may be reopened, not only the latest: the `glDate ≤ E` bound (§4.3) keeps a re-export of the reopened month from touching any later month's postings. After the correction, re-close recomputes the frozen figures and a subsequent export emits only that month's delta. Prior `GlExportBatch`/`GlPosting` rows are never mutated (the sent journal is history — a correction is a new reversing posting, never an edit).

## 7. Refuse-to-export: the readiness check

Spec §15's "refuse to export rather than post without an account" is the **§5.14 name-the-blockers** pattern applied to the GL. Before an export, the readiness resolver returns the **unresolved set: EVERY in-scope finalized invoice line (any kind except `TAX`) with no GL account**, plus account-less payment types and missing plant defaults. Concretely: an `OPERATION` line → its step code's GL; a `SURCHARGE` line → its surcharge's GL; a `FREIGHT` line → `freightGlAccountId`; a `CHARGE` line → `otherChargeGlAccountId`; a `CERT` line → its cert step code's GL; a postable payment → its payment type's GL; and the plant defaults (`arGlAccountId` absent blocks everything; `discountGlAccountId`/`writeOffGlAccountId` only if a discount/write-off is in the delta; **`salesTaxGlAccountId` if any in-scope invoice carries tax**). The reason every account-bearing line kind must be covered: a line's amount is folded into the invoice's A/R-debit total, so a *dropped* account-less credit line would leave the batch **unbalanced** — never silently drop, always refuse (gl-mapping's "refuse, do not silently drop"). As a hard backstop, `exportClose` also **asserts Σ debit = Σ credit before persisting** and refuses otherwise, so no unbalanced batch can ever be written even if a readiness case is missed. Each entry links to the record that fixes it and the whole list is **Excel-exportable**. The export button is disabled with the count until the list is empty; the close is not blocked by it (you can close a month and key the accounts before exporting).

## 8. Registry, sweeps, audit, permissions

- **Permissions:** two new named special actions (spec §9) in `permission-constants.ts` and the permissions sweep — **`close_ar_period`** (close, reopen) and **`run_qbo_export`** (export). Close/preliminary/register **views** gate on `receivables.view`; the two actions gate on their specials on top of `receivables.edit`. No new permission *area* (the "nothing to grant, nothing to forget" reasoning, §5.15) — the close is A/R-adjacent and lives under `receivables`.
- **Audit:** `ClosePeriod` and `GlExportBatch` join `AuditableModel` and `SNAPSHOT_INCLUDE`; close, reopen, and export all go through `auditedCreate`/`auditedUpdate`; the reopen reason is in the audit entry (the 5A/5B void/unlock precedent). `GlExportBatch` and its `GlPosting` rows are append-only (no update/delete path — a correction is a later reversing posting); the export's audit entry is the `GlExportBatch` create, `SNAPSHOT_INCLUDE` pulling its postings.
- **Sweeps:** the export-batch counter `gl_export_batch_number_next` joins the allocation-number guard set (the `settings.ts` `NumberSettingKey` must end in `_number_next`); `GlExportBatch.exportNumber` carries the documented allocation-only `@unique` exemption beside `creditNumber`/`batchNumber`. The three new `BillingConfig → GlAccount` FKs join the **§5.14 delete-blocker registry**, so deleting a GL account wired as a plant default is refused and names the blocker. `ClosePeriod`/`GlExportBatch`/`GlPosting` are not soft-deletable → no partial-unique columns, no findUnique/upsert exposure.

## 9. Services

Deep leaf units behind small interfaces (the 5A/5B shape):

- **`gl-mapping.ts`** (leaf, dependency-free) — the pure event→journal-line mapping (§5) and the readiness resolver (§7). Takes already-read rows; throws nothing; imports no service. The `invoice-guards.ts` leaf precedent.
- **`close-periods.ts`** — the close/reopen lifecycle (§6), the continuity-schedule computation, the roll-forward-vs-aging reconciliation, and `assertPeriodOpen` (exported for 5A/5B callers). Reads 5B's `aging.ts` and `ar-balances.ts`.
- **`gl-export.ts`** — the delta computation (new/reversed against the `GlPosting` ledger, §4.3), the file (CSV) and register (PDF via the 5A `PdfPrinter` bracket) render, the `GlExportBatch` + `GlPosting` write.
- **Period-lock wiring** — the existing 5A/5B mutation services (`invoices.ts` finalize/unlock/credit, `receipts.ts` post/void, `applications.ts` apply/void) call `assertPeriodOpen(glDate)` under their existing claims. A dependency-free leaf keeps this import-cycle-free (the `invoice-guards.ts` lesson).
- **`billing-config.ts`** (extend) — the three new default accounts.

## 10. Routes

`handle(async (req) => …)` throughout, thin (authorize → parse → delegate). `/api/receivables/close/preliminary` (GET, `receivables.view`), `/api/receivables/close` (POST close, `close_ar_period`), `/api/receivables/close/[id]/reopen` (POST, `close_ar_period` + reason), `/api/receivables/close/[id]/export` (POST, `run_qbo_export`), `/api/receivables/close/export/[batchId]/file` and `/register` (GET the stored bytes, `receivables.view`), `/api/receivables/close/readiness` (GET the blocker list + its Excel export). A 401/403 sweep like 5A/5B's.

## 11. UI

- A **`/receivables/close`** area (nav under Receivables, gated on `receivables.view`): a **month picker + preliminary report** (the continuity schedule, aging, variance, un-posted-batch and readiness flags); a **Close** action (disabled with reason when the prior month is open or the variance is non-zero); a **closed-periods list** with each period's frozen figures, its export batches, **reopen** (reason dialog), and **export** (disabled with the readiness count until clear); download links for each batch's **file** and **register**.
- **Admin → Billing** gains the three plant-default GL account pickers (reusing the existing GL-account picker, the salesTax/freight/other precedent).
- Client components against guarded APIs; the 5A/5B mutation-gate/edit-guard patterns; every state-disabled control names why (§5.16).

## 12. Testing

- **TDD throughout** — the journal mapping and its **balance** (Σ debit = Σ credit) for invoice, credit, payment, discount, write-off, on-account, and mixed cases; the **delta/idempotency** contract (re-run → 0; reopen→correct→re-close → reversing delta; re-exporting an earlier month after a later one has closed leaves the later month's postings untouched — the `glDate ≤ E` bound, §4.3); the **roll-forward-vs-aging reconciliation** (variance 0 on clean data, non-zero refuses the close); the **readiness** refusal (each unresolved-account class blocks and lists); beginning-A/R **chaining** (first = $0); the file's shape and the register's pinned content (never `Buffer.compare` two fresh renders — the `renderPdf` non-determinism rule; stored-byte reprints stay exact).
- **Concurrency** — the close **and** the posting mutations both run **Serializable**, so Postgres SSI's predicate locks catch the posting-vs-close phantom (a finalize that read "month open" then a close that inserts the CLOSED row form an rw-cycle → one aborts). A Read-Committed close would strip that backstop (SSI tracks only all-Serializable transactions) and let a finalize whose snapshot predates the close **leak into the closed month** — so the close stays Serializable and absorbs the two-concurrent-closes conflict with a **serialization/unique retry** (`retryOnSerializationConflict`), not by dropping isolation. `lockMonth` (advisory, per `(year,month)`) orders closes to reduce thrash. Tested in the **dangerous direction** — the real Serializable `finalizeInvoice` racing a close that wins the lock first, asserted to refuse-or-abort (never leak), **RED-verified by reverting the close to Read Committed** — plus the two-closes case (neither errors), RED-verified by removing the retry. Periods-close-in-order and single-close-per-month proven under contention.
- **Sweeps** — partial-unique, permissions (the two new specials), the delete-blocker registry (the three new FKs), and the allocation-number guard (`gl_export_batch_number_next`) stay green.

## 13. E2E and demo

- A Playwright flow: enter a small month (finalize an invoice, take a payment with a discount, a write-off, an on-account remainder), run the preliminary report, **close** the month, **export**, and assert the downloaded file **balances** and the register renders. Plus a **reopen → correct → re-close → re-export** delta check.
- A demo doc (`docs/2026-08-09-phase-5c-demo.md`) at the closing task (the 5A/5B precedent), flagging any deviation for an owner ruling — and specifically surfacing the two owner-homework items (§14) so the demo names what the bookkeeper still owes.

## 14. Owner homework — gates the demo, not the spec or build

1. **The GL account list** keyed in — operations (step codes), surcharges, payment types, and the three plant defaults (A/R, discount, write-off). It is data; the build and every test proceed on seeded accounts. The export **refuses** (§7) until the real accounts are entered, so this gates a *real* export, not the code.
2. **The bookkeeper's QBO import method** — confirms the file's exact column shape (a summary-journal CSV is the working default) and settles ruling 7 (period-end vs current-open-period dating for corrections into a QBO-closed month). Until confirmed, the file is a documented CSV and corrections date at period-end.

## 15. Task shape (the planner refines)

Roughly, in dependency order: permission-constants (the two specials) + the permissions sweep; the schema + `gl_export_batch_number_next` + the `BillingConfig` FKs + their Admin → Billing UI + the seed accounts; `gl-mapping.ts` (mapping + readiness) with its balance tests; `close-periods.ts` (schedule, reconciliation, `assertPeriodOpen`) + the period-lock wiring into 5A/5B services (RED-verified); the preliminary report route + UI; the close/reopen routes + the closed-periods UI; `gl-export.ts` (delta + file + register) + the export route + stored-bytes routes; the readiness route + its Excel export + the disabled-until-clear button; the E2E flow + the reopen/re-export delta check + the demo doc + the doc updates (HANDOFF §4/§9, spec §15 if the contract shifts, CLAUDE.md if a new house rule lands). The plan sequences and sizes these.

## 16. Non-goals (5C)

- **Live QuickBooks Online / Intuit API** posting (ruling 1) — file export only; the API is a later phase.
- **Posting finance charges** to the GL (ruling 4) — informational-only stays informational-only.
- **Cash-basis** journals — the export is accrual; QBO derives cash-basis reports itself.
- **Opening-balance entry** for pre-HeatSynQ A/R (ruling 5) — chain from zero.
- **Write-off flavor** (small-adjustment vs bad-debt) GL split (ruling 3) — one write-off account.
- **Multi-currency**, inventory/COGS/job-cost posting, and a report-painter for the register.

## 17. What a later phase inherits from 5C

- **The `ClosePeriod` roll-forward and `GlExportBatch` history** are the data behind Phase 8's **parallel-run comparison scoreboard** (spec §13) — invoiced/paid/ending-A/R per month, ready to diff against Visual Shop's reports.
- **`assertPeriodOpen`** is the general period lock; any later posting subsystem (were one ever added) refuses backdated writes through it.
- **The live QBO/Intuit API** — if ever wanted — replaces `gl-export.ts`'s file sink with an API sink over the same delta contract (§4.3); the mapping, readiness, and mark-sent machinery are unchanged. The idempotency contract is what makes an API safe to add.
