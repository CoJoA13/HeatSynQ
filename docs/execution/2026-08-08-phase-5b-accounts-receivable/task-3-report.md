# Phase 5B — Task 3 report: credit's own date, and invoice `dueDate` at finalize

**Task:** the two 5A `invoices.ts` changes 5B makes — `createCredit` stamps its OWN raise date
instead of copying the source invoice's `invoiceDate`, and `finalizeInvoiceInTx` sets a finalized
INVOICE's `dueDate = invoiceDate + terms.netDays`.

**Status:** DONE. All four gates green. Commit `3a0e8e9` — "feat(5b): credit takes its own date;
invoice dueDate set at finalize from terms.netDays".

---

## 1. `addDays` — the missing calendar-day helper

`src/lib/business-days.ts` only had `addBusinessDays` (Mon–Fri skip). Added:

```ts
export function addDays(start: Date, n: number): Date {
  if (!Number.isInteger(n)) {
    throw new Error(`addDays: n must be an integer, got ${n}`);
  }
  return new Date(start.getTime() + n * DAY_MS);
}
```

Plain calendar-day arithmetic, no weekend skip (a due date is a calendar date), on the same
UTC-midnight `Date` convention `parseDateOnly`/`formatDateOnly` use. Unlike `addBusinessDays`, `n`
may be negative (a back-dated offset) — only integrality is enforced; there's no non-negative /
max-offset cap because there's no untrusted-input day-at-a-time loop involved here (this is a single
addition, not the `addBusinessDays` weekend-skip loop the 3650-day cap protects).

**TDD (RED confirmed by temporarily reverting the implementation via `git stash` on just that one
file, running the test, then restoring):**
- RED: `npx vitest run tests/business-days.test.ts -t "addDays"` → 4 failed (`(0 , addDays) is not a
  function`), 1 incidentally passed (the "rejects a non-integer n" case, since calling a
  non-function also throws).
- GREEN (after restoring the implementation): 5 passed.

New `describe("addDays", …)` block in `tests/business-days.test.ts`: month-boundary cross
(`2026-08-01 + 30 = 2026-08-31`, the case the brief named explicitly), no-weekend-skip control case,
`n = 0` unchanged, negative `n`, non-integer `n` rejected.

## 2. `createCredit` — the credit's own date

`src/server/invoices.ts`, inside the transaction, right after allocating `creditNumber`:

```ts
const creditDate = todayDateOnly();
```

Called once and reused in both the `invoice.create` `data.invoiceDate` and the `auditData.invoiceDate`
(via `formatDateOnly(creditDate)`), replacing the two places that previously read
`source.invoiceDate` / `formatDateOnly(source.invoiceDate)`. `createCredit` has no `deps` object (the
`createInvoiceInTx`/`deps.today` precedent doesn't apply here), so `todayDateOnly()` is called
directly at the service boundary, as the brief specified — computed once so the create and audit
snapshots can't disagree across a UTC-midnight boundary mid-transaction.

Everything else in the credit's header — PO, terms, addresses, material, process names, tax rate —
still copies verbatim from the source; only `invoiceDate` changed.

### Test-file discrepancy (flagged, not silently resolved)

The brief said Step 1 "amends the existing 'copies the header' test — that one currently expects the
source date." I checked the actual `tests/invoices.test.ts` before touching it: the "copies the
header and reuses the invoice's exact lines" test (`createCredit` describe block) has **no**
`invoiceDate` assertion at all — it was never in the "copied verbatim" list to begin with. There was
nothing literal to amend.

What I did instead, in the same step: added a comment to that test explaining `invoiceDate` is the
deliberate exception to "copied verbatim," and added a **new**, dedicated test ("stamps the credit's
own creation date, not the source invoice's date") that:
- creates an invoice dated 30 days ago (`addDays(todayDateOnly(), -30)`), finalizes it, and credits it;
- asserts `credit.invoiceDate === formatDateOnly(todayDateOnly())` and `!== thirtyDaysAgo`;
- asserts the audit `after` snapshot also carries the credit's own date, not the source's.

I deliberately did **not** add a `credit.invoiceDate !== source.invoiceDate` assertion to the
existing "copies the header" test — with that test's `finalizedFixture()` (default `createInvoice`
with no `invoiceDate` override), the source invoice is itself dated "today," same as the credit, so
that assertion would be trivially (and confusingly) false-flaky rather than meaningful. The 30-days-
ago setup in the new dedicated test is exactly why the brief specified that gap.

## 3. `finalizeInvoiceInTx` — `dueDate` at finalize

Extended the shared `DETAIL_INCLUDE.customer` select (used by `claimInvoiceRow`, and hence every
invoice mutator including finalize) to carry `terms: { select: { netDays: true } }` — no new lock,
reading it off the row `claimInvoiceRow` already claims and re-reads:

```ts
const DETAIL_INCLUDE = {
  customer: { select: { code: true, name: true, terms: { select: { netDays: true } } } },
  order: { select: { orderNumber: true } },
  lines: { orderBy: { position: "asc" } },
} satisfies Prisma.InvoiceInclude;
```

In `finalizeInvoiceInTx`, after the `needsPrice` guard, before the `auditedUpdate`:

```ts
const netDays = invoice.customer.terms?.netDays ?? null;
const dueDate = netDays === null ? null : addDays(invoice.invoiceDate, netDays);
await auditedUpdate("invoice", id,
  () => tx.invoice.update({
    where: { id },
    data: {
      status: "FINALIZED", finalizedAt: new Date(), finalizedById: actor.id,
      ...(invoice.kind === "INVOICE" ? { dueDate } : {}),
    },
  }), { tx });
```

**No-terms case:** `Terms.netDays` is `Int @default(30)` — never null now (Task 2's migration
backfilled it). So `netDays === null` here means the customer has **no terms assigned at all**
(`Customer.termsId` null → `invoice.customer.terms` is `null`), never a null `netDays` on an assigned
Terms row. Keyed on `terms` presence, exactly as the brief specified.

**CREDIT never gets a due date:** the `dueDate` key is only spread into the update `data` when
`invoice.kind === "INVOICE"`; a CREDIT's `dueDate` column is never touched at finalize and stays at
its create-time `null` (Task 6 owner ruling: a credit ages from its own `invoiceDate`).

**`InvoiceDetail`/`toInvoiceDetail`:** the type had no `dueDate` field at all before this task (Task 2
added the column but no TS surface for it), and the finalize test needs to read `done.dueDate` off the
returned detail. Added `dueDate: string | null` to `InvoiceDetail` (right after `invoiceDate`) and
populated it in `toInvoiceDetail`: `dueDate: row.dueDate ? formatDateOnly(row.dueDate) : null`. This
wasn't explicitly called out in the brief's "Files" list but is required for the finalize return value
to expose the column at all; `tsc` confirmed no other hand-built `InvoiceDetail` literal needed
updating (the only builder is `toInvoiceDetail`).

## 4. TDD evidence — dueDate + credit-date tests in `tests/invoices.test.ts`

**RED** (`npx vitest run tests/invoices.test.ts -t "own creation date|Net 30 terms|no terms
assigned|can be reduced to a partial amount"`, run before any `invoices.ts` change): 4 failed —
- `sets dueDate = invoiceDate + terms.netDays for a customer on Net 30 terms` → `expected undefined
  to be '2026-08-31'`
- `leaves dueDate null when the customer has no terms assigned` → `expected undefined to be null`
- `stamps the credit's own creation date, not the source invoice's date` → `expected '2026-07-09' to
  be '2026-08-08'` (source date vs. today — confirms the fixture's 30-days-ago setup actually differs
  from today)
- `can be reduced to a partial amount and finalized without touching the order status` → `expected
  undefined to be null` (the added `finalized.dueDate` check)

**GREEN** (after implementing): `npx vitest run tests/invoices.test.ts` → **54 passed**, 0 failed.

New/changed tests, by location:
- `finalizeInvoice` describe block: two new tests — Net 30 → `dueDate === "2026-08-31"` for an
  invoice dated `2026-08-01`; no-terms customer → `dueDate === null`. Both build the customer/Terms
  fixture inline (`prisma.terms.create` + `prisma.customer.update({ termsId })`) rather than
  threading a new option through `savedOrder`/`shippedOrder`/`pricedShippedOrder`, to avoid widening
  those shared fixture signatures for one test.
- `createCredit` describe block: one new dedicated test for the credit's own date (§2 above); a
  one-line addition to "can be reduced to a partial amount and finalized" asserting the finalized
  credit's `dueDate` stays `null`; a comment-only addition to "copies the header…" noting the
  deliberate `invoiceDate` exception.

## 5. Gates (all foreground, per the branch's constraint — none backgrounded/polled by choice)

| Gate | Result |
|---|---|
| `npm test` (full suite) | PASS — **1704 passed**, 109 files (156.99s) |
| `npx tsc --noEmit` | PASS (clean) |
| `npx eslint src tests` | PASS (clean) |
| `npm run build` | PASS (clean) |

Note on `npm test`: the harness's default 120s Bash timeout auto-moved the ~157s run to a background
task before I could raise the timeout up front (I did not pass `run_in_background: true` myself). I
did not poll it; I waited for its own completion notification (which landed with exit code 0 and the
full "1704 passed" summary) rather than re-running or guessing at a result. Every other gate ran with
an explicit longer timeout and stayed genuinely foreground.

Also ran the specific affected test files individually before the full suite, to isolate any
knock-on breakage from widening the shared `DETAIL_INCLUDE`/`InvoiceDetail` type: `invoice-guards.test.ts`,
`invoice-pdf.test.ts`, `invoice-routes.test.ts`, `invoicing-schema.test.ts`, `schema.test.ts`,
`documents.test.ts`, `surcharges.test.ts` — all green (140 tests) before the full run.

E2E (`npm run test:e2e`) intentionally **not** run — batched at Task 17 per the plan, and this task
touches no route/UI surface (no new endpoint, no changed request/response shape a Playwright flow
would exercise — `dueDate` is additive to `InvoiceDetail` and unconsumed by any route logic beyond
pass-through JSON serialization).

## 6. Self-review

- **Scope discipline:** touched exactly `src/server/invoices.ts`, `src/lib/business-days.ts`,
  `tests/invoices.test.ts`, `tests/business-days.test.ts` — the four files the brief's commit command
  named. Did not touch UI, routes, or other services. Left two pre-existing unstaged/unrelated
  modifications (`.superpowers/sdd/.gitignore`, `docs/execution/.../progress.md`) out of the commit —
  they predate this task and aren't mine to fold in.
- **`addDays` cap/sign choice:** deliberately did NOT copy `addBusinessDays`' non-negative-and-3650-cap
  guard onto `addDays`. That cap exists specifically for `addBusinessDays`' O(n) day-at-a-time loop
  over an *untrusted* `requestDaysOverride`-style input (spec §7.1's chain). `addDays` is O(1)
  (`start.getTime() + n * DAY_MS`, no loop) and `n` here is always a small, code-controlled
  `terms.netDays` (`Int @default(30)`), not a large or hostile input — so there's no equivalent
  event-loop-stall risk to cap against, and forbidding a negative `n` would rule out legitimate
  back-dated-offset callers for no safety benefit.
  Only integrality is checked, matching a plain calendar-day-add contract.
- **`invoice.customer.terms` extension is additive-only:** widening the shared `DETAIL_INCLUDE`
  touches every reader of `claimInvoiceRow`/`readInvoiceDetail` (updateInvoice, discardInvoice,
  unlockInvoice, createCredit, finalizeInvoiceInTx), but only by adding a field nothing previously
  destructured — confirmed via full-suite green plus a clean `tsc`.
  `createInvoiceInTx`'s own separate `tx.customer.findFirst` (used at create time, not finalize) was
  intentionally left untouched — it already selects `terms: { select: { name: true } }` for its own
  purpose (`termsName` snapshot) and has nothing to do with the finalize-time `dueDate` computation.
- **Order of `dueDate` computation vs. `kind` check:** I compute `netDays`/`dueDate` unconditionally
  (even for a CREDIT, where the result is simply discarded by the `...(kind === "INVOICE" ? … : {})`
  spread) rather than branching earlier. This is a few wasted CPU cycles for a CREDIT finalize, never
  a correctness issue — no side effects, no extra query (the `terms` select rides the row already
  read under the claim). Left it this way for readability; happy to gate it behind the kind check if
  a reviewer prefers.
- **No new lock, no isolation-level change:** confirmed by inspection — `finalizeInvoiceInTx` and
  `createCredit` both still open exactly the claims they did before (`claimInvoiceRow`'s single
  `Order` claim + `Invoice` row `FOR UPDATE`), Serializable as before. The `terms` read is a plain
  join inside the same `findFirst` the claim already issues, not a second `SELECT`.
- **Did not touch `Terms` service/validation code:** `netDays` has no zod/service layer yet anywhere
  in the codebase (grepped — zero hits outside the schema and this task's own reads); that's later
  A/R task territory (Terms CRUD isn't Task 3's job), so I only *read* the column, never validate or
  write it.

## 7. Concerns

- None blocking. The one thing worth a reviewer's eye: the brief's Step 1 premise (an existing
  source-date assertion to amend) didn't match the actual test file — documented in §2 above as a
  deliberate, reasoned deviation rather than a silent skip. The functional requirement (a credit
  takes its own date, proven with a genuinely-different 30-days-ago fixture) is fully covered by the
  new dedicated test either way.
