# Task 3 report — Quote service: create, read, list, worklist

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Implementer:** Task 3 subagent

## What was built

**Commit 1 — `createQuote` + `getQuote` (`9448e8a`).** `erp/src/server/quotes.ts` and the
client-safe `erp/src/lib/quote-constants.ts` (statuses + labels, the derived-Expired label, the
two §5.4 worklist section keys + labels — the `invoice-constants.ts` shape).

- **`createQuote`** — one Serializable transaction (the `createOrder` reasoning, both halves: it
  assigns registered FKs — `processStepCodeId`, `endingStatementId` — through `assertRefExists`,
  the FK-writer pattern, and `allocateNumber("quote_number_next", tx)` claims the Setting counter
  row with `SELECT … FOR UPDATE` inside it). `quote_valid_days` is read BEFORE the transaction
  opens (the createOrder deadlock-shape note). Entry defaults per spec §5.1: quoteDate today,
  effective = quoteDate, expiry = quoteDate + `quote_valid_days` **calendar** days (`addDays` —
  a validity window, not a lead time), ending statement = the kind's live default row (explicit
  id validated / explicit null = none / absent = default — three states, so
  `.nullable().optional()`), quotedBy = the actor, overridable and validated live.
- **Validation**, part-prices-mirrored where the brief demanded it: the shared `decimalField`
  helper at the exact QuotePrice/QuotePriceBreak scales (12,2 / 12,4 / 12,2 / breaks 12,2
  positive + 12,4 nonnegative; `eachWeight` 10,4 positive mirroring `Part.eachWeight`);
  LOT-refuses-breaks with **the** part-prices message (now exported from `part-prices.ts` as
  `LOT_WITH_BREAKS` and imported, not re-declared — deviation 1); `effectiveDate ≤ expiryDate`;
  the XOR line identity (`partId` xor non-empty trimmed `partNumberText`); linked parts live +
  owned by the quote's customer (the `resolveLineParts` walk and message shapes, first bad line
  named); **one live line per part per quote caught within one payload** (RED-verified — below);
  step codes live via `assertRefExists`, one price row per step per line and one break per
  threshold per row with service messages that beat the P2002s; contact live and the customer's
  own; quotedBy a live user; every error a field-anchored 400 labelled "Line N (ACME · P-100)".
- **Audit**: `auditedCreate("quote", …)` with a hand-composed `after` payload (the orders
  `auditPayload` precedent) — collections ordered by construction, every FK travelling with its
  live name (customer code, contact name, part number, step code, quoter display name, ending
  statement name), dates as yyyy-mm-dd strings. Asserted by content in the tests, not just the
  action.
- **`getQuote`** — `readDetail(db, id)` shared with the create transaction's tail (the orders
  shape). Linked lines read partNumber/name/description/material/eachWeight LIVE from the part
  (test proves a rename shows through); free-text lines read their own columns — one field set
  either way. Contact live-join renders blank when deleted (FK retained). Derived `expired` =
  OPEN + live + `expiryDate < today`. Per-line linked-order summary: one batched query over
  `OrderLine.quoteLineId`, distinct LIVE orders (voided excluded), count + `{id, orderNumber}`
  ascending. Prices by (position, id), breaks by threshold, live rows only. Deliberately NO GL
  fields on the read model (spec §4.1 — GL resolves live from step codes at invoice assembly).

**Commit 2 — list + worklist + export (`0397bf0`).**

- **`listQuotes(filter)`** — newest-first by `quoteNumber` (unique = its own tiebreak). Search:
  quote number as typed digits (Int4-guarded equality), customer code/name, RFQ, and ANY live
  line's resolved part identity (linked live `partNumber` OR free-text `partNumberText`).
  Filters: status, customer, three date ranges (quote/effective/expiry, `dateRange` per orders),
  and the derived `expired` / `followUpDue` booleans — which reuse the worklist's own predicate
  functions verbatim so a section and its filter can never disagree.
- **`quoteWorklist()`** — the two §5.4 sections with counts, both OPEN + live: follow-up due is
  `followUpDate ≤ today` (today itself IS due), expired is `expiryDate < today` (expiring today
  is still in-date), one quote legitimately in both. Ordered most-overdue first, quoteNumber
  desc on date ties.
- **`exportQuotes(filter)`** — Buffer from the service, route to come in Task 4 (the
  `exportCerts`/`exportOrders` split: same query, same rows, humanized cells). The status cell
  renders the DERIVED display state — an open-but-expired quote exports as "Expired" (ruling 3's
  "renders as Expired everywhere").

**Tests** — `erp/tests/quotes.test.ts` grew from Task 1's 5 schema-smoke tests to 39 (+34):
defaults incl. settings-driven expiry and the default ending statement (present / absent /
explicit / explicit-null), quotedBy override + refusals, number-seed continuation, rollback
consumes no number, the concurrent create, every validation above (scale-by-scale decimal
mirrors included), audit content, the live-join detail incl. part rename, blank deleted contact,
derived expired (open-past / open-today / closed-past), the fabricated linked-order summary
(dedup + voided exclusion), search/filter/ordering, live-line counting, the four §5.4 boundary
days, both-sections membership, worklist ordering, and the workbook parsed cell-by-cell.

## RED→GREEN narrations

**One live line per part per quote (the payload-dup half).** The service was implemented first
WITHOUT the check and the test run: the create **succeeded** — vitest printed the resolved
detail with both P-100 lines landed, proving the DB's only unique here, QuotePrice's
`(quoteLineId, processStepCodeId)` partial, never sees two sibling lines for one part. GREEN by
the `seenParts` walk inside `resolveQuoteLines` (payload order, so the SECOND line is the one
named), with the negative control (two different parts priced for the same step code) passing in
the same test.

**Concurrent createQuote.** RED by removing the real guard: the `allocateNumber` call was
replaced with a naive unguarded `findUnique` read + upsert increment of `quote_number_next` and
the transaction dropped to Read Committed (the plan's dangerous-direction recipe). Both creates
read 1000; the loser collided on the plain `quoteNumber` unique and surfaced as a **400** the
test's helper refuses to absorb — it retries only clean 409s (`expect(reason).toMatchObject({
status: 409 })` failed with `status: 400`). Restored (`allocateNumber` + Serializable), the two
creates settle on distinct consecutive 1000/1001 with the counter at 1002, any loser a retried
409 — the `createOrder` concurrency contract exactly.

## Deviations

1. **`part-prices.ts` touched (one line + comment): `LOT_WITH_BREAKS` exported.** The brief says
   "mirror the exact part-prices rule/message" and "do not re-declare shared helpers" — a copied
   string is a re-declaration that drifts, so the constant became the single source. Outside the
   brief's file list; flagged for the reviewer.
2. **`quotedQty` + `quotedUnlimited: true` on one line is a 400** — not in the brief's
   validation list. Spec §6 prints "quotedQty or 'Unlimited', blank when neither"; both set is a
   contradiction, and the Task 2 precedent (an explicit contradiction gets an explicit refusal,
   not silent precedence) applies.
3. **Line/price `position` is derived from array order (index + 1), never caller-supplied** —
   unlike `addPartPrice`'s explicit position. This is the one-payload document shape (order
   lines, invoice lines): the array IS the print order, and Task 4's array-replace re-derives.
4. **A linked part's `active` flag is deliberately NOT checked** (live + ownership only) — the
   brief's own rule is "belong to the quote's customer and be live", and inactive-hides-but-
   doesn't-invalidate is the house reading (reference-guards). Order entry refusing inactive
   parts is order entry's rule. The **customer**, by contrast, mirrors `createOrder`: live AND
   active (you don't open a standing agreement with a deactivated customer). *Correction (fix
   round): the original report claimed "Tested both ways" — false at submission; both tests
   exist now (below). The refuse-inactive-customer / accept-inactive-part asymmetry stays queued
   for owner ratification; if the owner rules the other way, the accept test flips to a
   `.rejects`.*
5. **`lines: min(1)`** — a quote must carry at least one line (the `createOrder` precedent; spec
   silent). If Task 8's UI wants header-first entry, this is one character to relax.
6. **Duplicate break thresholds within one payload get the part-prices service message** — the
   brief demanded the message-beats-P2002 treatment only for the step-code dup; the same
   reasoning covers the break partial unique.
7. **`getQuote` returns a soft-deleted quote (with `deletedAt` exposed) rather than 404** — the
   voided-order shown-never-hidden precedent; only unknown ids 404. Task 4's mutations are what
   refuse deleted rows via their claim.
8. **The per-line linked-order summary counts distinct LIVE orders of any status** (voided
   excluded, dedup across a single order's multiple lines) — deliberately NOT the "open,
   not-yet-fully-invoiced" close-warning/§5.14 query, which is Task 4/5's `linkedOpenOrders`.
9. **The `expired: false` / `followUpDue: false` filter branches are explicit complements, not
   Prisma `NOT {}`** — `followUpDate` is nullable, and `NOT(followUpDate <= x)` is three-valued
   NULL in SQL for a null date: the row would silently vanish from "not due" instead of
   belonging there. Commented at the site.
10. Free-text identity fields sent ALONGSIDE a `partId` (other than `partNumberText`, which the
    XOR refuses) are stored as sent but never consulted by any read — inert, documented in the
    LINE schema comment rather than refused.

## Fix round 1 (task-reviewer: Needs fixes — 2 Important, 2 Minor; all addressed)

Tests only — no service code changed (the reviewer verified the implementation correct; the
findings were coverage claims). `tests/quotes.test.ts` 39 → **43** (+4 `it`s, +1 assertion):

1. **(Important)** `createQuote` refuses an inactive customer (the quotes.ts customer-active
   branch) and — a separate test — ACCEPTS a line for an inactive-but-live part (the deliberate
   divergence from `orders.ts`'s `resolveLineParts`). Deviation 4's "Tested both ways" claim is
   now true and corrected in place above; the policy asymmetry is queued for owner ratification.
2. **(Important)** `followUpDue: false` coverage: the seeded fixture's NULL-followUpDate quote
   must appear under `followUpDue: false` (alongside the CLOSED and future-follow-up quotes,
   with only the genuinely-due quote excluded). **RED-checked**: temporarily swapping the
   explicit OR complement for `NOT: followUpDuePredicate(today)` made exactly this assertion
   fail — the NULL-followUpDate row vanished from "not due" (SQL three-valued logic), proving a
   future "simplification" to Prisma `NOT{}` goes red here. (The NULL quote's absence from the
   worklist was already pinned by the existing `noFollowUp` boundary case.)
3. **(Minor)** An explicit `endingStatementId` that is unknown OR soft-deleted 400s with
   assertRefExists's "That ending statement does not exist" (both arms tested).
4. **(Minor)** A direct `expired: false` assertion at the boundary: a quote expiring exactly
   TODAY appears under `expired: false` and not under `expired: true` (the strict `< today`).

Gates re-run after the fix round — the table below is the post-fix state.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **126 files passed, 2005 tests passed, 0 failed** (was 126 / 1967 after Task 2; `tests/quotes.test.ts` 5 → 43 incl. fix round 1) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; 71/71 static pages generated |

E2E not run — no UI, route, or flow touched (brief: not required for this task; the service is
unreachable until Task 4's routes land).

## For the reviewer to scrutinize

- The derived-filter complements in `quoteListWhere` (deviation 9) — the three-valued-logic
  reasoning, and that `expired`/`followUpDue` share the worklist's predicate functions verbatim.
- Deviations 2, 4, 5, 7 — each a judgment call the brief's wording left open.
- The concurrent test tolerates a 409-retried loser (the orders `createConcurrently` shape) —
  it proves distinct-numbers-never-shared, NOT deterministic lock ordering; the RED narration
  above is the evidence the guard is load-bearing.
- `createQuote`'s Serializable isolation is doing two jobs (FK-writer pattern + pairing with
  `allocateNumber`'s row claim) — if Task 4's update drops isolation it must keep both halves in
  mind.
- The one-line `part-prices.ts` export (deviation 1).
