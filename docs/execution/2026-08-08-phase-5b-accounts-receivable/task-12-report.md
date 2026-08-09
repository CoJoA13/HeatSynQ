# Task 12 report — `statements.ts` + `pdf/statement.ts` + STATEMENT document + route

**Brief:** `task-12-brief.md`. **Global constraints:** `global-constraints.md`.

## Summary

Added `src/server/pdf/statement.ts` (the pure pdfmake definition builder, owning `StatementData`
— the `pdf/invoice.ts` precedent: the pdf module owns its own input type so the dependency stays
one-directional), `src/server/statements.ts` (`buildStatement`/`printStatement`/`runStatements`),
and the two route files (`src/app/api/receivables/statements/route.ts` — GET build / POST print,
`.../run/route.ts` — POST run). Widened `FinanceChargeInput.rate` to `number | null` in
`finance-charges.ts` (Task 11's carried type note). Tests: `tests/statements.test.ts` (18 cases —
assembly, finance charge, family roll-up, print/archive, run), `tests/statement-pdf.test.ts` (4
pure-builder cases), plus a new describe block in `tests/receivables-routes.test.ts` (403+200 for
all three routes).

## buildStatement's assembly

Reuses `aging.ts`'s exported `bucketAging` — the spec's own instruction ("one pure aging function
serves both the report and the statement's summary," §6) — over a locally-read `Snapshot`. Because
`aging.ts`'s own `readSnapshot`/`Snapshot`/`sumRows`/`liveAsOf`/`parseAsOf` are all private
(unexported), I duplicated their shapes in `statements.ts` (`readFamilySnapshot`, `appsAsOf`,
`sumAgingRows`, `parseAsOf`) rather than reaching into another module's internals — the repo's own
copy-small-helpers-per-file convention (`parseDate` is duplicated the same way across
invoices.ts/shippers.ts/orders.ts). `readFamilySnapshot` widens the aging snapshot with the extra
per-document fields the open-item table and the finance-charge base need
(`financeChargeExempt`/`creditNumber`/`orderNumber`/`invoiceDate`) that `bucketAging` itself
doesn't touch; since the object is a typed *variable*, not an inline literal, TypeScript's
excess-property check doesn't fire when it's handed straight to `bucketAging`.

Per-invoice/credit open items are built from the SAME point-in-time-filtered snapshot
(`finalizedAt ≤ asOf`, applications `appliedDate ≤ asOf` — mirroring `aging.ts`'s own
`liveAsOf`/inclusion filters exactly, so a statement re-run for a past `asOf` reproduces the same
figures the aging report would): an open INVOICE becomes a positive `open` item; an open CREDIT
becomes its OWN item with `open` **negative** (its `original` is also negative — the schema's own
sign convention for a credit's `total`). An on-account (unapplied payment) never gets its own
`openItems` row — `openItems[].kind` is strictly `"INVOICE" | "CREDIT"` per the brief's own type,
so on-account cash is captured only in `aging.unapplied` (which already rolls in credit remaining
+ on-account together, per `bucketAging`'s existing rule). `totalDue = aging.net` exactly, per the
brief's own definition ("buckets − unapplied, the net owed").

**Family roll-up:** `combineFamily` reads the requested customer's LIVE children and feeds the
whole family into `bucketAging`, summing the per-member rows into one combined `AgingRow`
(`sumAgingRows`, the `aging.ts` `sumRows` shape) when there's more than one member. Unlike
`agingReport`, which always rolls a parent-with-children into family mode, `buildStatement` is
driven by the caller's own `combineFamily` flag — a parent-with-children statement built with
`combineFamily: false` reports only its own activity (spec §8's "per-division" choice is made per
print). Verified with a dedicated family test (parent + one child, combined totalDue 300 vs.
per-division totalDue 100).

## The finance-charge gating + the type decision

`pastDueBalances` accumulates only OPEN, non-settled INVOICE lines whose `dueDate < asOf`
(`bucketFor`'s own `daysPastDue > 0` line), carrying each one's `financeChargeExempt` flag —
collected unconditionally so the assessment gate stays one branch. When `opts.assessFinanceCharges`
is true, `financeChargeRateFor(customer.financeChargeRate?.toNumber() ?? null,
billingConfig.financeChargeRate)` resolves the rate (customer override wins, else the plant
default, else `null`), and `financeCharge({ pastDueBalances, rate })` computes the amount;
`financeCharge` is `null` whenever `assessFinanceCharges` is false, OR the computed amount is
exactly 0 (nothing non-exempt is past due, or no rate is set) — a computed `$0.00` line collapses
to the same `null` the "not assessed" case produces, so `buildStatementDefinition` has one
condition (`financeCharge !== null`) for "print the line."

**Type decision (Task 11's carried note):** widened `FinanceChargeInput.rate` from `number` to
`number | null` in `finance-charges.ts`, rather than null-coalescing at the statements.ts call
site. `financeCharge`'s own guard (`if (!input.rate) return 0;`) already treats `null` and `0`
identically — only the type annotation was ever wrong. This lets `financeChargeRateFor`'s real
`number | null` return value flow straight through with no cast and no `?? 0` at the call site
(which would have silently turned "no rate configured anywhere" into the same code path as "rate
is deliberately zero," a distinction the function doesn't actually need to make, but the honest
signature is the widened one). `finance-charges.test.ts` (Task 11's file, untouched) still passes
unmodified — its `rate: null as unknown as number` cast still type-checks under the wider type.

## The print bracket

`printStatement` follows the invoice/cert four-print bracket shape: `invoicePrintSettings()` read
OUTSIDE the transaction, then one Serializable `prisma.$transaction` running
`printStatementInTx` — `buildStatementInTx(tx, ...)` (the SAME assembly function `buildStatement`
uses, parameterized on `Db` so it runs on either the top-level client or a `tx`) →
`renderPdf(buildStatementDefinition(data))` → `storeDocument(tx, { kind: "STATEMENT", customerId
}, pdf)`.

**Deliberately no row claim**, unlike `printInvoice`/`printCert`/`printTraveler`. Those claim their
owning order/invoice row because a concurrent WRITE to that specific row (a discard, a void) could
otherwise race the archive insert and leave "printed" and "discarded" in an order no serial
schedule could produce — the print-vs-discard hazard CLAUDE.md documents. A statement has no
single owning row of that kind to claim: it's a read-only composition over many invoices/credits/
payments, nothing else in the system checks "has this customer's statement been printed" as a gate
on any other operation, and Serializable isolation alone is sufficient here because the ONLY
invariant that matters is "the archived output reflects some real, individually-consistent
committed state" — exactly what SSI already guarantees for a transaction that performs no
conflicting write of its own. I documented this reasoning in the file header rather than silently
omitting the claim, since CLAUDE.md's rule is "row locks, not isolation levels, guard
cross-transaction invariants" — the point being there is no such invariant here, not that the rule
doesn't apply.

`runStatements` never opens more than one print transaction at a time (a sequential loop, not
`Promise.all`) — deliberately conservative, matching the conservative default elsewhere in this
codebase for anything that opens N Serializable transactions from one call.

## The byte-exact reprint test

Per global-constraints.md: pin content on the pdfmake DEFINITION, never `Buffer.compare` two fresh
`renderPdf` calls.

- **Content** — `tests/statement-pdf.test.ts` builds a `sampleData()` `StatementData` fixture and
  asserts on `allText(buildStatementDefinition(sampleData()))` (the `tests/cert-pdf.test.ts` copy):
  customer code/name, Remit To block, each open item's document number and money-formatted
  original/open, the aging bucket label and Unapplied/Total Due labels, and — a dedicated case —
  that "Finance Charge" appears ONLY when `financeCharge` is non-null.
- **Reprint bytes** — `tests/statements.test.ts`'s `printStatement` describe block: `printStatement`
  is called ONCE; `getDocument(documentId)` is called TWICE, and both results are
  `Buffer.compare`d against `printed.pdf` (the ONE buffer `renderPdf` actually produced) — never
  against each other via a second render. This is exact by construction (the stored bytes ARE that
  buffer, reissued), the identical shape `tests/invoice-pdf.test.ts`'s own reprint test uses.
- **Structure** — the `%PDF-` header on the one real `renderPdf` call in the pure-builder test
  (no page-count pin needed here; nothing about a statement's layout claims a fixed page count the
  way the invoice/cert tests pin one against a specific fixture).

## TDD RED/GREEN

Given the scope (two new modules + two new route files + three test files), I wrote each test file
complete against the not-yet-existing `src/server/pdf/statement.ts`/`src/server/statements.ts` and
route files first, confirmed the whole set failed for the expected reason (module not found /
export not found — `npx vitest run tests/statement-pdf.test.ts tests/statements.test.ts` before
either implementation file existed), then wrote `pdf/statement.ts` and `statements.ts` together
(the pdf module has no dependents until the service imports it, so there is no meaningful
intermediate RED/GREEN split between them), reran to GREEN on the first pass. The
`receivables-routes.test.ts` additions followed the same pattern: written against the not-yet-
existing route files (RED — import failure), then the two route files, GREEN on the first pass.
Every RED failure was the expected "module has no exported member" / "Cannot find module" shape,
never a runtime assertion failure masking a typo in the test itself.

## Gate results (all foreground)

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/statement-pdf.test.ts tests/statements.test.ts` — 16/16 passed (first run).
- `npx vitest run tests/receivables-routes.test.ts` — 13/13 passed (first run).
- `npm test` (full suite) — **120 files / 1832 tests passed**, 169.7s.
- `npx eslint src tests` — clean.
- `npm run build` — clean; both new routes (`/api/receivables/statements`,
  `/api/receivables/statements/run`) appear in the route manifest as dynamic (`ƒ`).
- `npm run test:e2e` — **16/16 flows passed** (run per CLAUDE.md's "touches any function" rule;
  no existing flow reaches the new code, since there is no UI wired to it yet — Task 13/15 do
  that — but nothing pre-existing was behaviorally changed either, only `finance-charges.ts`'s
  type annotation).

## Self-review

- **Print bracket** — settings read outside the transaction in both `buildStatement` (no
  transaction at all — a plain read, the `agingReport`/`getInvoice` precedent) and `printStatement`
  (outside its own `$transaction` call); `printStatementInTx` never re-reads settings inside the
  loop.
- **Reprint reissues stored bytes, never re-renders** — `getDocument` is a pure `findUnique` +
  `Buffer.from`; `printStatement` calls `renderPdf` exactly once per call.
- **Content pinned on the definition, not two renders** — confirmed above; grepped both new test
  files for `Buffer.compare` — the only two call sites compare STORED bytes against the ONE
  `printed.pdf`, never against a second `renderPdf` output.
- **Decimal→number everywhere** — every `Prisma.Decimal` crossing into `ar-balances`/`bucketAging`/
  `financeCharge` is `.toNumber()`'d at the snapshot boundary (`readFamilySnapshot`) or the
  customer read (`financeChargeRate?.toNumber()`); `getBillingConfig`/`ar-balances` already return
  plain numbers.
- **FC only when assessed + non-exempt past-due exists** — four dedicated tests (assessed with
  plant rate, customer override wins, exempt invoice excluded, nothing past due even when
  assessed).
- **`pdf/statement.ts` is plain-data-in/definition-out** — no Prisma import, no `Date.now()`/clock
  read, `JSON.parse(JSON.stringify(def))` round-trip asserted equal to the original definition.

## Concerns / deviations from a literal brief reading

- **No row claim in `printStatement`** — the brief's own bracket description ("settings outside
  the tx → buildStatement data → render → storeDocument … on tx") does not mention one, and I
  could not find an invariant in the spec or CLAUDE.md that a statement print needs to guard
  against concurrently. Flagged explicitly (file header + this report) rather than silently
  omitted, in case the owner/reviewer wants one added defensively anyway (e.g., to make a family
  statement's read of several customers' rows mutually consistent against a concurrent cross-
  customer credit application — Serializable already provides this via SSI, so I judged an
  explicit claim unnecessary, but it is a judgment call worth a second look).
- **`runStatements`'s "nonzero net" gate treats a customer who OWES us money and a customer we owe
  money TO identically** (`cents(row.net) === 0` is the only skip condition) — i.e. a pure
  credit-balance customer (net negative, we owe them) still gets a statement. This matches the
  literal instruction ("every customer with a NONZERO net balance") and is arguably correct
  behavior (a customer sitting on account credit likely still wants to see it on a statement), but
  it's a judgment call the brief doesn't spell out either way.
- **GET `/api/receivables/statements`'s boolean query params** (`combineFamily`/
  `assessFinanceCharges`) use a plain `=== "true"` string check — there's no existing boolean-query
  parsing precedent in this codebase to match against (checked; every other GET route with a
  boolean-shaped filter doesn't have one), so I picked the simplest explicit form rather than
  invent a shared helper for a two-call-site need.
