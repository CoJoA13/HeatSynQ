# Phase 5B — Accounts Receivable: Design Specification

**Date:** 2026-08-08
**Status:** Approved by owner in the design session of 2026-08-08 (§3 records every ruling taken)
**Branch:** `phase-5b-accounts-receivable`
**Supersedes, in part:** spec §7.6 (the A/R half — receipts, aging, statements, finance charges)
**Depends on:** Phase 5A (`Invoice`/`InvoiceLine`, `BillingConfig`, `invoice-guards.ts`, `createCredit`, the claim/audit/document patterns), Phase 4 (`order-locks.ts`, `documents.ts`, the void-with-reason shape), Phase 2B (`Customer.parentId`, `Customer.financeChargeRate`, `Terms`, `PaymentType`)

---

## 1. Goal

Turn the finalized invoices and credits Phase 5A produces into a working **accounts-receivable ledger**: receive customer payments in balanced deposit batches, apply them to invoices (with partial payments, early-pay discounts, write-offs, and on-account cash), apply credit memos, age the open balances at any as-of date, and print (and archive) customer statements with an aging summary and an optional finance-charge line.

Phase 5 as the roadmap wrote it is eleven subsystems. The owner split it (5A §3.1) into **5A pricing and invoicing** (merged `359c707`, PR #58), **5B accounts receivable** (this document), and **5C month-end close and the QuickBooks Online summary export**. The roadmap's testable outcome — "invoice shipped orders and reconcile a month" — is reached at the end of 5C. 5B's own testable outcome is **"apply a payment, age a balance, print a statement."**

## 2. Scope

**In:** payment deposit batches (check/card/ACH) with a live balancing total; applying a payment across one or more invoices, including across the divisions of a parent customer; partial payments, terms-based early-pay discounts, write-offs (small residual and full bad-debt), and on-account (unapplied) cash; applying finalized credit memos to invoices or leaving them on account; due dates from payment terms; aging at any as-of date, point-in-time reconstructable; open-item statements (single or a run, combined or per-division for a family), archived byte-for-byte; an informational, opt-in finance-charge line.

**Out (5C or later — §16):** month-end close; the QuickBooks Online summary export; posting finance charges or applications to the GL; emailing statements/invoices (`CustomerContact.getsStatements` stays unread); printing refund cheques; pre-invoice deposits/prepayments; scheduled/automatic statement mailing.

The A/R document is 5A's `Invoice` (§16 of the 5A spec): 5B records payments, applications, and balances **against** it and **never restates its totals**. `Invoice.total` is the amount owed at finalize.

## 3. Owner decisions, 2026-08-08 (this design session)

| # | Decision | Ruling |
|---|---|---|
| 1 | Cash-application primitives | **All four in:** partial payments; terms-based early-pay discounts (offered sometimes); write-offs in both flavors (small residual **and** full bad-debt); on-account/unapplied cash |
| 2 | Payment → invoices | One payment can settle **multiple invoices** (some customers); a **parent** payment can settle its **children's** invoices (some customers) |
| 3 | Payment methods | **Check/card/ACH all supported**, checks the common case — the method is the existing `PaymentType` reference row (carries a GL account for 5C) |
| 4 | Prepayments/deposits | **None** — money is never taken before an invoice exists. On-account cash is therefore only ever an **unapplied payment remainder**, appliable to a later invoice |
| 5 | Credits | A finalized 5A credit memo **applies to an invoice** (usually the customer's next) **or sits open on account**, owner's choice each time |
| 6 | Credit date | **A credit takes its own creation (raise) date** — resolves the ruling 5A left open (5A §16). `createCredit` changes to stamp today, not the source invoice's date |
| 7 | Terms | Mostly **Net 30**, but support any; **early-pay discounts are terms-based** ("2% 10, Net 30" = 2 / 10 / 30) |
| 8 | Aging | Standard **Current / 1–30 / 31–60 / 61–90 / 90+** by **due date**; **unapplied credits/on-account in a separate column**, not folded into a bucket |
| 9 | Finance charges | **Informational statement line only** — no posting, no aging, no compounding (only original invoices accrue), no grace, no minimum; **not frequent**, so **opt-in per statement run** |
| 10 | Statements | **Open-item**; parent roll-up **both on demand** (combined or per-division); show the **aging summary, the finance-charge line, and a remit-to block**; **archive** each printed statement |

## 4. Data model

### 4.1 New: the receipts ledger

Three new tables. Balances are **never stored** on them or on `Invoice`; every balance is derived from the live `Application` rows (§5.2).

- **`ReceiptBatch`** — a deposit session. `batchNumber` (allocated from a new `receipt_batch_next` counter, never reissued), `depositDate @db.Date`, `controlTotal Decimal? @db.Decimal(12, 2)` (what the operator says the deposit is — for balancing), `status` (`OPEN` → `POSTED`; POSTED locks the payment list), `notes`, `deletedAt` (void-with-reason), timestamps. Live balance = `controlTotal − Σ payments`.
- **`Payment`** — one per check/card/ACH. `batchId → ReceiptBatch`, `customerId → Customer` (the payer), `paymentTypeId → PaymentType`, `amount Decimal @db.Decimal(12, 2)`, `reference` (check #), `receivedDate @db.Date`, `notes`, `deletedAt`, timestamps. On-account = `amount − Σ its PAYMENT-type applications`.
- **`Application`** — one reduction of one invoice's open balance. `invoiceId → Invoice` (the target, always a **finalized** `INVOICE`), `amount Decimal @db.Decimal(12, 2)`, `type` (`ApplicationType`: `PAYMENT` | `DISCOUNT` | `WRITE_OFF` | `CREDIT`), `reason` (required for `WRITE_OFF`/`DISCOUNT`), `paymentId → Payment?`, `creditInvoiceId → Invoice?` (a finalized `CREDIT`), `deletedAt` (void), `createdAt`, `appliedDate @db.Date` (the A/R effective date, for point-in-time aging — §6). A hand-written DB `CHECK` (`Application_source_check`, in the migration SQL — Prisma has no check syntax, the 5A `StoredDocument` precedent) enforces the source per type: `PAYMENT`/`DISCOUNT`/`WRITE_OFF` ⇒ `creditInvoiceId IS NULL`; `CREDIT` ⇒ `paymentId IS NULL AND creditInvoiceId IS NOT NULL`; a standalone bad-debt `WRITE_OFF` may carry a null `paymentId`.

`ApplicationType` is a new Prisma enum. `Application` is the single write path for cash, discounts, write-offs, and credit application — one table, one balance rule, no drift (Approach A, chosen 2026-08-08).

### 4.2 The balance rule — everything derives from `Application`

- **Invoice open balance** = `Invoice.total − Σ (live Application.amount where invoiceId = this)`.
- **Payment on-account** = `Payment.amount − Σ (live Application.amount where paymentId = this AND type = PAYMENT)` (discounts/write-offs reduce the invoice, not the payment's cash).
- **Credit remaining** = `|Invoice.total|` (kind = CREDIT) `− Σ (live Application.amount where creditInvoiceId = this)`.

Nothing is cached on `Invoice`; a voided (soft-deleted) `Application` drops out of every sum, restoring the balances it touched.

### 4.3 Changes to existing models

| Model | Change |
|---|---|
| `Terms` | **gains** `netDays Int` (required going forward; the migration backfills existing rows to `30`), `discountPercent Decimal? @db.Decimal(5, 2)`, `discountDays Int?` (a null discount pair = no early-pay discount) |
| `Invoice` | **gains** `dueDate DateTime? @db.Date` (set at finalize for an `INVOICE` = `invoiceDate + the customer's terms.netDays`; a `CREDIT` gets none), `financeChargeExempt Boolean @default(false)` (the per-invoice dispute/exempt flag) |
| `BillingConfig` | **gains** `financeChargeRate Decimal? @db.Decimal(6, 4)` — the plant default monthly rate; `Customer.financeChargeRate` (Decimal(6,4), already modelled) overrides it |
| `Customer` | consumes existing `financeChargeRate` and `parentId` — no schema change |
| `PaymentType` | consumed by `Payment.paymentTypeId`; its existing `glAccountId` is the 5C payment-GL hook — no schema change |
| `StoredDocument` | **gains** the `STATEMENT` document kind (§8), owner = `customerId`; the kind→owner `CHECK` and the `DocumentOwner`/`AREA_FOR_KIND` maps extend (CLAUDE.md's `DocumentKind` rule) |

### 4.4 The `createCredit` date change (5A §16 ruling 6)

`createCredit` (`invoices.ts`) currently copies the source invoice's `invoiceDate`. It changes to stamp the credit's **own** date (`todayDateOnly()` / the service boundary's date), so a credit ages from when it was raised. This is the one 5A code change 5B makes; no data migration (the column exists), covered by an updated `createCredit` test.

## 5. Rules and the concurrency contract

### 5.1 Locks

Applying, discounting, writing off, or applying a credit **mutates an invoice's open balance**, and that balance is read (for the over-application check) in the same breath. Per CLAUDE.md ("row locks, not isolation levels"; "the guarded state must be locked with the claimed row"):

- Every application **claims the target invoice row** through 5A's `claimInvoiceRow` discipline (the order row first, then the `Invoice` row `FOR UPDATE`) before it reads the open balance and writes.
- A payment settling **several invoices at once** claims them all in **one sorted `SELECT … FOR UPDATE` statement** (the `claimOrdersInOrder` shape — the orders behind the invoices, deduplicated and ascending), never a per-invoice loop, so no ABBA window opens. Cross-customer (parent-group) application is the same single statement.
- A credit application claims **both** the target invoice's row and the credit's own row (the credit is a second guarded balance) uniformly after the order claims.
- Void restores balances under the same claims.

### 5.2 What may be applied

- The **target is always a finalized `INVOICE`** with a positive open balance — a draft is not yet A/R.
- A **credit source is a finalized `CREDIT`** with remaining balance.
- **Over-application is refused:** an invoice's applications can never exceed its `total`; a payment's `PAYMENT` applications can never exceed its `amount`; a credit's applications can never exceed its remaining.
- A **discount** appears only when the invoice's terms carry one, the payment's `receivedDate ≤ invoiceDate + discountDays`, **and that payment SETTLES the invoice** — the discount is earned only by a payment that closes the open balance, so a partial payment inside the window earns nothing at all (owner ruling **2026-08-19**, issue #69; spec §15). The system computes the eligible amount (`discountPercent / 100 × the invoice's open balance` — the ruling added the settlement requirement, it did **not** change the basis, and "the amount being settled" this line used to read was the same figure said loosely), the operator chooses to take it. Settlement is judged against what is **still open**, never the original total, so a customer who part-paid earlier may still settle the remainder early and earn the percentage on what remains. Enforced at **both** read sites, which cap independently: the offer (`discountAvailable`, feasibility — `cash ≥ open − eligible`) and the save (`applyPayment`, exactness — the payload's cash + discount must equal the open balance). **Derived, pending owner ratification** (the implementation's reading of "cash + discount", not the owner's words, flagged the same way in spec §15): a `WRITE_OFF` in the same payload does **not** count toward settling, because the discount is earned by a full early *payment* and absorbing a short-pay is the opposite of being paid early — and because counting it would let `PAYMENT 500 + DISCOUNT 20 + WRITE_OFF 480` earn a discount. A `DISCOUNT` application carries the reason "early-pay terms".
- A **write-off** always requires a reason (small residual or bad-debt), gated on `write_off` (§9).
- **On-account** is any un-applied payment cash; it is appliable to a later invoice from the same payment at any time (even after its batch is `POSTED`).

### 5.3 New cross-phase guard (via `invoice-guards.ts`)

The 5A leaf `invoice-guards.ts` gains `hasReceivableActivity(tx, invoiceId)` (a live-`Application` existence check), built as a dependency-free leaf before any import cycle (Phase 4 lesson 3). 5A's **`unlockInvoice` and `discardInvoice` refuse** an invoice with live A/R activity — paper that has been paid against cannot be edited or discarded; the correction is to void the application first. `voidOrder` likewise refuses through the same leaf.

## 6. Aging

- **Bucketing:** each open finalized `INVOICE`'s open balance is placed by its `dueDate` against the **as-of date** — `dueDate ≥ asOf` → **Current**; else `asOf − dueDate` → **1–30 / 31–60 / 61–90 / 90+**.
- **Unapplied column:** open credit remaining and payment on-account show in a **separate "Unapplied" column** (negative), not folded into a bucket; `buckets − unapplied = net owed` (ruling 8).
- **Point-in-time:** the as-of date reconstructs balances **as they stood then** — only invoices finalized on/before `asOf`, only applications with `appliedDate ≤ asOf`. A month-end aging re-run later reproduces the same figures (the §13 parallel-run acceptance test depends on this).
- **Scope:** a per-customer report with a **parent-family roll-up**, filterable by customer and as-of date, **Excel-exportable** (spec §7.8). One pure aging function (`aging.ts`) serves both the report and the statement's summary.
- Finance charges never age (§7).

## 7. Finance charges

- **Informational only** (ruling 9): computed at statement time, never posted, never an owed/aging item.
- **Amount** = `pastDue × (rate / 100)`, where `pastDue` is the sum of the non-exempt, past-due open invoice balances, and `rate` is a **monthly percentage** (e.g. `1.5` = 1.5%/month — the same percent convention as `discountPercent`) from `Customer.financeChargeRate` (override) else `BillingConfig.financeChargeRate` (plant default). No grace, minimum, or compounding.
- **Exempt/disputed** invoices (`Invoice.financeChargeExempt`) drop out of `pastDue`.
- **Opt-in per statement run** — a run carries an "assess finance charges" flag; off by default. Pure function (`finance-charges.ts`), no persistence.

## 8. Statements

- **Open-item, as-of a date:** customer header + remit-to block; every open item (finalized invoices with a balance; open credits and on-account as negatives) with its date, due date, and open amount; a **total owed**; the **aging summary** (five buckets + Unapplied); and, when the run assesses them, the **finance-charge line**.
- **Family, on demand:** **combined** (one statement across every division, rolled to a family total) or **per-division** (separate), chosen at print (ruling 10).
- **Single or a run:** one customer/family on demand, or a run over **everyone with an open balance** — each as-of the chosen date, each assessing FC or not.
- **Print → archive:** rendered with the 5A print bracket (`renderPdf`, `PdfPrinter`), stored byte-for-byte as a `STATEMENT` `StoredDocument` owned by the customer; reprints reissue stored bytes. The remit-to block reuses `invoicePrintSettings`' company/remit-to (5A §10).
- Because aging is point-in-time (§6), a statement re-run for a past as-of date reproduces exactly what was sent.

## 9. Registry, sweeps, and audit surface

- **Permissions:** a new area **`receivables`** (view/create/edit/delete) — view = A/R, aging, statements; create/edit = batches, payments, applications, statement runs; delete = void — plus a new special action **`write_off`** (gated on top of edit). Added to `permission-constants.ts` and the permissions sweep; money-touching routes gate on `receivables.edit`, write-offs additionally on `write_off`, statements/aging on `receivables.view`.
- **Audit:** `ReceiptBatch`, `Payment`, and `Application` join `AuditableModel` and `SNAPSHOT_INCLUDE`; every mutation goes through `auditedCreate`/`auditedUpdate`/`auditedSoftDelete`; voids record their reason in the audit entry (5A's void/unlock/discard precedent).
- **Sweeps:** `receipt_batch_next` joins the alloc-number guard set; `Application`'s FKs join the reference-link sweep; no partial-unique columns are added (`batchNumber` is allocation-only — a plain `@unique`, the `creditNumber` exemption precedent, documented beside it).

## 10. Services

Leaf and service modules, each a deep unit behind a small interface (the 5A shape):

- `receipts.ts` — batch/payment CRUD, post, void; the live batch balance.
- `applications.ts` — apply/void a payment, discount, write-off, and credit application under the invoice claim; the over-application and discount-window rules.
- `ar-balances.ts` — the pure balance derivations (§4.2), the one place open-balance/on-account/remaining are computed.
- `aging.ts` — the point-in-time aging computation (§6), pure over a snapshot read.
- `finance-charges.ts` — the pure FC computation (§7).
- `statements.ts` — assemble a statement's data, render, archive; the run.
- `invoice-guards.ts` (extend) — `hasReceivableActivity`.
- `terms.ts` (extend) / `billing-config.ts` (extend) — the new columns.

## 11. Routes

`handle(async (req) => …)` throughout, thin (authorize → parse → delegate). `/api/receivables/*` for batches, payments, applications, aging, statements; the customer page's A/R section reads `/api/customers/[id]/receivables`. A 401/403 sweep like 5A's.

## 12. UI

- A new **`/receivables`** area (nav gated on `receivables.view`): a **batch worklist**; a **batch entry + apply** screen (add payments, apply across the payer's — and its family's — open invoices, live batch balance, discount offered when eligible, write-off with reason, on-account remainder); the **aging** report (as-of date, customer/family filter, buckets + Unapplied, Excel export); the **statements** screen (single or run, combined/per-division, FC toggle, print → archive, a documents list).
- The **customer page gains an A/R section** (open items, net balance, apply/statement links) — the order hub's Invoices-section precedent (5A).
- **Admin:** `BillingConfig` (Admin → Billing) gains the plant finance-charge rate; **Terms** admin gains `netDays` and the discount fields.
- Client components against guarded APIs; the 5A bulk-grid/mutation-gate/edit-guard patterns for the apply grid.

## 13. Testing

- **TDD throughout** — the balance derivations; over-application refusal (invoice, payment, credit); discount-window eligibility and amount; write-off-requires-reason; on-account remainder and later re-application; credit application and remaining; aging bucket math; **point-in-time as-of reconstruction**; FC computation and exemption; parent-family roll-up; the unlock/discard/void-order guard; void restoration of balances.
- **Concurrency** — the discriminating races verified **RED with the guard removed** and the competing caller pinned to Read Committed (CLAUDE.md): two applications on one invoice; an application racing `unlockInvoice`; a multi-invoice claim proving `LockRows` above `Sort`.
- **Partial-unique and permission sweeps** stay green with the new columns and area.

## 14. E2E and demo

- The §9 north-star flow into the Playwright suite: **apply a payment, age a balance, print a statement.** Plus a fuller flow — batch → a partial payment + an early-pay discount + a small write-off + an on-account remainder → aging shows the right buckets and Unapplied → a combined family statement with a finance-charge line, printed and archived.
- A demo doc (`docs/2026-08-08-phase-5b-demo.md`) at the closing task, the 5A precedent, flagging any deviations for an owner ruling.

## 15. Task shape (planner refines)

Roughly: invoice-constants/permission-constants + settings; the schema + the two `CHECK`s (Application source, StoredDocument STATEMENT) + `receipt_batch_next`; Terms/BillingConfig column additions + their admin UIs; the `createCredit` date change; `ar-balances.ts`; `receipts.ts` + batch UI; `applications.ts` (payment/discount/write-off/on-account) + the apply grid; credit application; the `invoice-guards` extension + the unlock/discard/void refusals; `aging.ts` + the aging report; `finance-charges.ts`; `statements.ts` + the STATEMENT document + the statements UI; the customer A/R section; routes + the 401/403 sweep; E2E + demo + docs. The plan sequences and sizes these.

## 16. Non-goals (5B)

- **Month-end close** and the **QuickBooks Online summary export** — 5C.
- **Posting** finance charges, applications, discounts, or write-offs to the **GL / journal** — 5C (the GL hooks are named in §17).
- **Emailing** statements or invoices — `CustomerContact.getsInvoices`/`getsStatements` stay stored and unread until email lands.
- **Refund cheque** printing / negative-cash disbursement.
- **Pre-invoice deposits / prepayments** (ruling 4) — on-account is only ever an unapplied receipt.
- **Scheduled / automatic** statement mailing; statements are printed on demand or in an operator-run batch.

## 17. What 5C inherits from 5B

- **`Application` + `Payment.paymentTypeId → PaymentType.glAccountId` are the cash-side GL.** 5C's journal maps applications (cash, discount, write-off) to accounts; 5B records the account-bearing rows but posts nothing.
- **`BillingConfig` is where 5C's remaining GL defaults belong** (A/R account, discount, adjustment, write-off, and the sales/credit accounts) — FK columns on the singleton, not `Setting` strings (5A §16).
- **The month-end close reads 5B's point-in-time aging** (§6) — invoiced / paid / ending-A/R side-by-side as-of the close date, the close record saved. The as-of reconstruction is built for exactly this.
- **Finance charges are excluded from the GL/QBO export** (spec §14 open item 2; Visual Shop excludes them) — 5B keeping FC informational-only means 5C has nothing to post.
- **Write-off flavor (small vs bad-debt)** is a GL distinction 5C resolves via the account it maps a `WRITE_OFF` to; 5B carries the reason, not the account choice.
