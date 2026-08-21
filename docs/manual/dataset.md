# The manual dataset

The demonstration dataset behind the user manual and the pre-acceptance-month walkthrough. Built by
`erp/prisma/manual-seed.ts`, which layers onto the demo slice and drives **only the real service
entrypoints** — no `createMany`, no hand-written `*_number_next` bump, no direct write that dodges a
claim. Every document number below was allocated by `allocateNumber` inside the service that
consumed it, and every mutation is in the audit log.

**Sign in as `admin` / `heatsynq-demo`.**
The seeded default password (`admin`) is changed by the last step of the seed, because
`install-readiness.ts` carries a live §5.7 check for it that otherwise keeps a standing warning on
every screen. The first-run setup checklist is dismissed by the same step.

Built and verified: 2026-08-19.

---

## Rebuilding it

From `erp/`. **This is destructive to the dev database — it drops it.**

```bash
docker compose exec -T db psql -U erp -d postgres \
  -c 'DROP DATABASE IF EXISTS erp WITH (FORCE);' -c 'CREATE DATABASE erp OWNER erp;'
npx prisma migrate deploy
npm run db:seed
npx tsx -e "import('./prisma/demo-seed.ts').then(m => m.seedDemoSlice()) \
  .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })"
npx tsx prisma/manual-seed.ts
```

Every count in this document is what that exact sequence produced, run end to end from an empty
database.

Two things about the sequence worth knowing:

- **The drop is not optional.** `manual-seed.ts` is additive and deliberately **not** idempotent:
  every customer, part and reference code it creates is unique among live rows, so a second run
  against an already-seeded database fails on the first duplicate rather than quietly doubling the
  dataset. There is no reset mode in the script — the reset *is* dropping the database.
- **Step 4 calls `seedDemoSlice`, the unguarded internal orchestration**, because `npm run
  db:seed:demo` runs the practice-guarded entry (`seedPracticeDemo`), which refuses on `erp` by
  design. That guard is correct and was not weakened. There is no npm script for seeding the demo
  slice into the dev database, which is why this is a `tsx -e` one-liner.

### The guard on `manual-seed.ts`

It refuses unless `current_database()` is exactly `erp` **and** the `DATABASE_URL` host is
localhost. The host half is load-bearing and must not be "simplified" away: `docker-compose.yml`'s
prod profile runs the app against `postgresql://erp:…@db:5432/erp` — the *same database name* — so a
guard reading only `current_database()` would wave a production URL straight through while calling
itself proof. That is the `e2e/lib/db-fixtures.ts` `assertDevDb` lesson, reused rather than
re-derived. There is deliberately no override flag.

---

## What it contains

Order numbers 1000–1049, shippers 1000–1027, quotes 1000–1004. Closed period: 2026-07.

### Customers

| Code | Name | Notes |
|---|---|---|
| AERO | Aerospace Dynamics Corp | parent |
| AERO-MW | — Midwest Division | division of AERO |
| AERO-SE | — Southeast Division | division of AERO |
| CASC | Cascade Spring Co | **on credit hold**, Due on Receipt |
| HARB | Harbor Marine Works | taxable @ 6.5%, opted out of the energy surcharge |
| MIDST | Midstate Fabricators | Net 45 |
| PREC | Precision Gear Works | 2% 10 Net 30 |
| TITAN | Titan Tool & Die | 2% 10 Net 30, reduced energy-surcharge rate |
| VALLEY | Valley Machine Works | blanket `surchargeOptOut` |

### Counts by entity

| Entity | Count | |
|---|---|---|
| Customer (live) | 9 | 2 divisions, 1 on credit hold |
| CustomerAddress | 11 | all 3 kinds; **1 inactive** |
| CustomerContact | 9 | incl. 1 phone-only (no email) |
| CustomerSurcharge override | 3 | reduced rate / flat amount / single opt-out |
| Part | 12 | incl. `3541720C3` under **two** customers |
| PartProcessStep | 24 | recipes of 1–5 steps |
| PartProcessStepValue | 7 | typed step-field values |
| PartPrice / PartPriceBreak | 15 / 8 | break tiers on 5 price rows |
| PartSpecification / PartInspection | 7 / 11 | |
| PartFieldDef / PartFieldValue | 5 / 10 | TEXT, NUMBER, DATE, CHECKBOX |
| ProcessStepCode | 9 | 2 carry typed field defs (7 defs) |
| ProcessTemplate / steps | 3 / 8 | |
| Reference rows | — | all **11** kinds populated, incl. `commentSnippet` (3) |
| Surcharge | 3 | 2 percent, 1 flat |

### Orders — every status

| Status | Count |
|---|---|
| OPEN | 22 |
| INVOICED | 15 |
| SHIPPED | 8 |
| PARTIAL_SHIPPED | 3 |
| REOPENED | 1 |
| *voided (soft-deleted)* | 1 |

50 orders in total.

**`OrderStatus` has no `VOIDED` member.** The five values above are the whole enum. Voiding an order
is a **soft delete** — `deletedAt` is set, the order keeps its number, stays readable, and renders
read-only with the reason in its `auditedSoftDelete` entry. The manual's Orders chapter must
describe voiding as a soft delete, not as a status.

**`REOPENED` is written in exactly one place** — `shippers.ts` during shipment reversal — and only
when the order carries a **finalized invoice**. The dataset builds that pair deliberately: order
1013 is shipped, invoiced, finalized, and then its shipment reversed. A reversal is a live
negative-quantity shipment that never voids the original, so both pieces of paper stay readable.

Supporting rows: 51 order lines (9 quote-linked), 93 auto-split loads, 6 serials, 2 container rows,
1 charge. Received dates span ~165 days, so the backlog's received-month slices, the traffic-light
colouring and the turnaround measure all have a real distribution.

### Quotes

| State | Count |
|---|---|
| OPEN | 3 |
| CLOSED | 2 (one won, one lost) |
| *expired* (derived) | 1 |
| *follow-up due* | 1 |

**"Expired" is derived, never stored.** A quote's status column is only ever `OPEN` or `CLOSED`; an
expired quote is an OPEN, live quote whose `expiryDate` has passed, and it renders as Expired
everywhere without any status flip. Won/lost is likewise not an enum — it is the `closeReason` text
on a CLOSED quote. The won quote's line is linked to an order line, priced through the link.

### Shipping and certification

| | Count |
|---|---|
| Shipper (live) | 27 |
| — multi-order (one shipment, two orders) | 1 |
| — voided | 1 |
| — reversal | 1 |
| — BOL printed | 1 |
| ShipperLine / ShipperContainer / ShipperSerial | 25 / 1 / 6 |
| Cert — ORDER / LOAD / SHIPMENT scope | 10 / 2 / 3 |
| — printed | 1 |
| CertRequirement / CertReading | 23 / 7 |

Cert states: pending (requirements seeded, no readings), results entered, and printed.

### Invoicing

| | Count |
|---|---|
| Invoice — FINALIZED | 16 |
| Invoice — DRAFT | 1 |
| Credit memo — FINALIZED | 1 (partly applied) |
| InvoiceLine | 114 |
| — MANUAL override | 1 |
| — PART / OPERATION / SURCHARGE | 18 / 25 / 44 |
| — FREIGHT / CERT / TAX | 4 / 6 / 17 |

Also present: one invoice **unlocked and re-finalized**, and one carrying a **manual override line**
that survives a subsequent `recalculateInvoice` (the #61 rule — a manual line is an override that
takes the derived line's slot, not an addition beside it).

### Receivables

| | Count |
|---|---|
| ReceiptBatch — POSTED / OPEN | 3 / 1 |
| Payment | 10 |
| Application — PAYMENT / DISCOUNT / WRITE_OFF / CREDIT | 3 / 1 / 2 / 1 |
| — standalone bad-debt write-off (no payment behind it) | 1 |
| ClosePeriod — CLOSED | 1 (2026-07) |
| GlExportBatch / GlPosting | 1 / 6 |

Includes a settling payment that **takes the 2% early-pay discount**, a short pay whose **residual is
written off** in the same act, a **standalone bad-debt write-off** left live so the manual can show
the flagged row and its Void control, and on-account cash.

Aging, as of the build date — all five buckets populated, and **every customer shows a positive
Net**:

| Bucket | Open |
|---|---|
| current | 14,635.96 |
| 1–30 | 6,595.19 |
| 31–60 | 434.96 |
| 61–90 | 1,416.68 |
| 90+ | 1,753.52 |
| **Total receivables** | **24,836.31** |
| less unapplied cash | 11,334.96 |
| **Net** | **+13,501.35** |

The balance of those two figures is deliberate and was tuned, because it is easy to get wrong in a
way that is arithmetically perfect and pedagogically backwards. **Net = bucketed receivables −
unapplied cash**, so a seed that creates more cash than invoiced work shows every customer with a
*negative* net — a shop that owes its customers money — on one of the manual's most-read screens.

The fix is **not** to apply more of the cash. An application reduces the open invoice and the
unapplied cash by the same amount, so Net does not move at all. The only two levers are more
invoiced work and less cash, and the seed uses both: seven shipped-complete orders are billed in the
current month, and the on-account payments are sized modestly. Receivables now cover unapplied cash
about 2.2×, with enough still on account that the concept — and the closed-month freeze ruled on in
#159, section 4 below — stay demonstrable.

Per customer:

| | Receivables | Unapplied | Net |
|---|---|---|---|
| AERO-MW | 2,667.87 | 2,500.00 | +167.87 |
| AERO-SE | 4,637.25 | 0.00 | +4,637.25 |
| HARB | 1,180.46 | 834.96 | +345.50 |
| MIDST | 6,360.89 | 3,600.00 | +2,760.89 |
| TITAN | 4,901.99 | 2,900.00 | +2,001.99 |
| VALLEY | 5,087.85 | 1,500.00 | +3,587.85 |

### Month end — use August's preview as the teaching figure

July is closed and structurally cash-only (see the limits section). The better illustration is the
**current month's preliminary report**, where every line is populated:

| | |
|---|---|
| Beginning A/R | −6,750.00 |
| Invoiced | 33,282.39 |
| Credits | 834.96 |
| Payments | 10,353.49 |
| Discounts | 50.42 |
| Write-offs | 542.17 |
| Ending A/R | 14,751.35 |
| Aging ending A/R | 13,501.35 |
| **Variance** | **1,250.00** |

The variance is **not** a fault, and the screen says so itself: *"1 open receipt batch dated in this
month is not yet posted."* That is the OPEN batch, left deliberately unposted — it makes the preview
teach the reconciliation rather than just show a clean zero. Do not post it while capturing.

The negative beginning A/R is July's ending balance: on-account cash and no invoices, for the reason
given below.

### Admin, documents, audit

| | Count |
|---|---|
| Role | 5 (Admin, Office Clerk, Shipping Lead, Read-only, Controller) |
| User | 5 |
| UserPermissionOverride | 2 (one GRANT, one DENY, on the same user) |
| DocumentTemplate | 12 |
| DocumentTemplateVersion — PUBLISHED / DRAFT | 11 / 3 |
| CustomerTemplateAssignment | 3 |
| StoredDocument | 18 across **all 8 kinds** |
| Backup archive | 1 (integrity-verified, health green) |
| AuditLog | 501 |

The four extra roles carry genuinely different permission sets, not graded copies of one another —
Office Clerk holds no special actions at all, Shipping Lead holds the shop-floor ones and nothing
financial, Controller holds the money actions, Read-only holds view bits only.

Two templates carry a **published v1 plus an open v2 draft**, so `/admin/templates/[id]/edit` has
something to render: `Invoice — Aerospace layout` and `Traveler — Tool room`. The traveler one is
there deliberately — §5.6's locked-element padlock ("this element cannot be hidden, and here is
why") exists **only on the traveler contract**, whose typed step fields and barcode are
non-removable, so a traveler draft is the only way the Templates chapter can show that behaviour at
all. A third (`Quote — Expedited`) has never been published, so the draft-only state is visible too.

### Backups

The seed runs **one real backup** through `runBackupNow()` with its defaults — the real `pg_dump`,
spawned via argv, size-checked before gzipping, integrity-verified after. So the Backups page opens
populated and the indicator is **green** rather than red.

That red state is not a bug: the indicator is green only on a recent integrity-passing archive *and*
a clean last run *and* a readable status file, and **absence is failure** by design (Phase 8C), so a
never-backed-up database correctly reads as overdue. It simply should not ride on every screenshot
in the manual.

The archive lands in `BACKUP_DIR` — `./backups` on a dev machine, resolved against the process cwd,
which is why the rebuild must be run from `erp/`. `erp/backups` is gitignored, so the archive is not
committed; a rebuild produces a fresh one. Backups are production-only (`assertNotPracticeDatabase`),
and the dev database is not the practice copy, so the guard permits this.

One compatibility note, since the test suite goes out of its way to avoid it: `runBackupNow` takes an
injectable dump command because CI's `pg_dump` major can be older than the server, and `pg_dump`
refuses a newer server. That does not apply here — host `pg_dump` 18.4 against server 18.6, same
major — and the seed deliberately uses the real binary, since using the injectable would defeat the
point of proving the real path works.

Stored documents: TRAVELER 7, SHIPPER 2, BOL 1, CERT 1, INVOICE 2, CREDIT 1, STATEMENT 2, QUOTE 2.

---

## What this dataset cannot show, and why

Everything here was built through the app's own front door. Where a state is unreachable that way,
it is **absent** rather than faked. These are the gaps, and each is a real property of the system.

### 1. A multi-month Sales report

**The Sales report will only ever show one month.** `finalizeInvoice` stamps `finalizedAt = now()`
and takes no date input — the period lock guards the *finalize* date, deliberately (owner ruling 8:
an invoice is recognized in the month it is finalized, not the month it is dated). Sales recognizes
on `finalizedAt`. So every invoice in a freshly-built dataset is recognized in the month of the
build, and a month-over-month sales comparison cannot be demonstrated from seeded data at all.

`invoiceDate` *is* back-datable, and is — that is what spreads the aging buckets and gives the
comparison scoreboard (which counts by `invoiceDate`) multiple months. But Sales does not read
`invoiceDate`, by design, and no amount of seeding changes that. **Demonstrating a multi-month Sales
comparison requires a database that has genuinely been used across months.**

### 2. A prior month with invoice activity

Following from the above: the closed month (2026-07) carries **cash only**. Its roll-forward shows
zero invoiced and zero credited, because nothing can be finalized into a past month.

This also constrains what the closed month may contain. The close refuses any variance between its
roll-forward and the aging at month end, and those two agree in a prior month only while that
month's cash stays **unapplied**: apply a prior-month payment and its application (whose
`appliedDate` follows the payment's `receivedDate`) lands in the prior month too, so the roll-forward
subtracts the cash while the aging nets it against an invoice it cannot see — variance, close
refused. The prior month therefore holds exactly one posted batch of on-account cash. The OPEN batch
is dated in the *current* month for the mirror-image reason: the roll-forward counts only POSTED
payments while the aging counts all of them.

### 3. A visibly REOPENED accounting period

The seed closes 2026-07, exports its GL batch, reopens it and re-closes it — but **re-closing
updates the row in place and clears `reopenedAt`/`reopenReason`**, so the end state is `CLOSED` and
the reopen survives only in the audit log. With one prior month available there is no way to show
both a re-closed month and a currently-reopened one. The manual's month-end chapter should point at
the audit history for the reopen.

(Not to be confused with `OrderStatus.REOPENED`, which is present and unrelated — see Orders above.)

### 4. Prior-month on-account cash, frozen by its closed month — on purpose

The three prior-month payments are on account permanently: `applyPayment` dates an application at
the payment's `receivedDate`, and `assertPeriodOpen` refuses one dated into a closed month, so once
the month closes that cash cannot be applied without reopening the period.

**This is the period lock working, not a defect and not a seeding artefact** — owner ruling
2026-08-19 on #159, option (a), now closed. The cash-journal entry belongs to the date the cash
arrived, and a late allocation genuinely *does* change a closed month's aging; the reopen is the
correct, visible, audited route rather than a workaround. So the $6,750 sitting frozen in closed
2026-07 is **correct data, and a deliberate demonstration** of the lock — one of the few places the
dataset can show it biting.

The office procedure that follows is the thing to teach: **allocate on-account cash before the month
closes.** Cash that cannot be allocated the day it lands should be allocated before month end, not
left to outlive its period. The manual's Receivables and Month-end chapters state it that way.

Also deliberate, and asked about every time the two are read side by side: `applyPayment` dates at
`receivedDate` while `applyCredit` dates at `todayDateOnly()`. For cash the date is when the money
arrived; for a credit it is when the allocation happened. Both functions carry the answer.

---

## Rough edges found driving the real services

Building this drove essentially every entrypoint back to back, which surfaced things a single-path
test does not. None of it blocked the dataset. Ordered roughly by how much they would cost a user.

1. **`applyPayment` and `applyCredit` disagree on how to type an amount.** In the same file:
   `applyPayment`'s lines take a zod-parsed `decimalField` (a *string*), while `applyCredit` takes a
   hand-typed object with `amount: number`. Two adjacent money entrypoints with different input
   contracts is a trap for any new caller; the compiler catches it, but only after you have written
   it the other way.

2. **~~"no early-pay discount applies" covers three different causes.~~ FIXED, #175 (2026-08-20).**
   Out of the discount window, no discount terms on the invoice at all, and entitlement already
   consumed used to produce the identical message; I hit the first and had to read `discountFor` to
   find out which. Each now names its own cause, and the offer read and the save refusal derive that
   cause from one composition, so they cannot disagree about the same invoice. The richer wording
   wished for here — naming the deadline, not just that it passed — is filed as
   [#178](https://github.com/CoJoA13/HeatSynQ/issues/178); it needs the deadline threaded out of the
   single `addDays` rather than computed a second time.

3. **`process-templates.ts` and `templates.ts` both export `createTemplate`.** They are unrelated
   concepts — a reusable step recipe versus a document layout — and importing both in one module
   forces an alias. A rename would be cheap and would remove a genuine footgun.

4. **There is no supported way to seed the demo slice into the dev database.** `npm run db:seed:demo`
   runs the practice-guarded entry, which correctly refuses on `erp`; the only route is importing
   `seedDemoSlice` through `tsx -e`. The guard is right — the missing piece is a dev-side script. It
   is the one step of the rebuild that looks like a workaround, because it is one.

5. **`postBatch` requires the control total to match entered payments to the cent**, which means any
   programmatic caller must compute payment amounts *before* opening the batch. Correct behaviour
   (it is the point of a control total), but it inverts the natural order of writing the code, and
   the failure arrives late — at post time, after every payment is already keyed.

6. **A blind `createCert` collides with the eager §6.2 cert.** A part whose effective resolution is
   *required* + ORDER scope already has its cert created at order save, so `createCert` answers "This
   order already has a certification for that scope". Correct, and the seed now reuses the eager cert
   instead — but the error does not hint that a cert already exists and could simply be used.

7. **`createQuote` needs a real user in the actor context.** `Quote.quotedById` is NOT NULL and falls
   back to `currentActor().id`, so `demo-seed.ts`'s `{ id: null }` system actor cannot create a
   quote — it would fail with "Quoted by is required when no user is signed in". This seed runs as
   the admin user for that reason. Anything later extending the demo slice with quotes will hit it.

8. **A cross-customer part on an order line is refused** ("that part belongs to another customer") —
   correct and well-worded, and worth recording as a modelling fact for the manual: a multi-line
   order cannot borrow another customer's part however similar the work is. Part numbers are unique
   *per customer*, which is why `3541720C3` legitimately exists under two of them here.

Nothing in the above is a correctness or data-integrity defect. Every guard that fired, fired
correctly; items 1–4 are ergonomics, and 5–8 are places where a correct refusal could explain itself
better.
