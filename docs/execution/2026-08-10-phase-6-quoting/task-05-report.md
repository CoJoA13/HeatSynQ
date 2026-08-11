# Task 5 report — Eligibility leaf + order-side auto-link (rulings 5–7)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Implementer:** Task 5 subagent

## What was built

**Commit 1 — `erp/src/server/quote-links.ts`, the dependency-free LEAF (`d359531`).** The §5.2
eligibility rule stated ONCE (quote OPEN + live; line live + `partId` set; customer match;
`effectiveDate ≤ receivedDate ≤ expiryDate` inclusive BOTH ends), three exports: `eligibleQuoteLines`
(ordered latest-effective-first, tie → higher `quoteNumber` — ruling 7), `resolveAutoLink` (first of
that ordering or null), and `judgeQuoteLine` (the explicit-pick validator — walks the same clauses
in a fixed order and returns `{ ok: false, reason }` naming the FIRST failing one; the leaf throws
nothing and checks no permission, the invoice-guards contract). Imports: Prisma types + the pure
date lib only. The WHERE (set query) and the clause walk are the same rule in two shapes — a
binding comment ties them together and the boundary tests pin both paths at every edge. Tests:
`tests/quote-links.test.ts`, 12 leaf cases (every clause, both boundary days on both paths,
latest-effective ordering, the quoteNumber tie-break, null resolution).

**Commit 2 — the orders.ts integration + audit (`625554c`).** Inside the existing one-transaction
save, not a rewrite:

- `LINE` gains `quoteLineId: z.string().min(1).nullable().optional()` — the three-way semantics
  (explicit id = validated re-pick; explicit null = no link; absent = `resolveAutoLink`), shared by
  `createOrder` and `addLine` through one new walk, `resolveQuoteLinks` (label offset `base`, the
  `resolveLineParts` shape, so a rider's refusal names its real position). Refusals read
  `Line 2 (ACME · P-200): Quote #1051's line quotes a different part`.
- `createOrder`: links resolve after the dates and BEFORE `allocateNumber` (a refused pick consumes
  no number), stored on the nested line create; `addLine` judges against the ORDER's stored
  `receivedDate` (ruling 6 — however backdated).
- `updateLine` gains the same key with EDIT semantics: absent = KEEP the stored link (never
  re-judged — a qty edit must not silently move a line onto a newer quote), null = the deliberate
  unlink, explicit id = re-pick judged against the CURRENT received date (§5.2's re-pick rule).
  The patch type moved to `OrderLineUncheckedUpdateInput` for the scalar FK write.
- Order read payloads: `OrderLineDetail` gains `quoteLineId`/`quoteId`/`quoteNumber` (live-joined
  in `DETAIL_INCLUDE`; safe — §5.14 refuses deleting a referenced quote/line, so the join always
  resolves). Detail-only, deliberately: the board (`BoardRow`) is one row per order with no line
  detail, and Task 9's surfaces read the detail. The create-path `auditPayload` lines gain
  `quoteLineId` + `quoteNumber` so the create entry and later update diffs describe the same fields.
- The MANDATORY comments (see below) and the dangerous-direction test.

**Commit 3 — `GET /api/quotes/eligible` (`b8acf33`).** Thin handler: `mustCan(requireUser(),
"orders", "view")` first line (the §5.15 reasoning cited in its doc comment — a pick-list is
readable with the permission of the SCREEN it serves; this serves order entry, not quote
management), zod `.strict()` query parse with blank-means-absent (the orders `query.ts` rule,
`orUndefined` reused), absent `receivedDate` defaulting to today (createOrder's own default, the
entry-defaults precedent), returning `{ candidates, autoLink }` where `autoLink` is `candidates[0]
?? null` — derived from the same list so the preview and the save's silent pick can never disagree.
Reads the bare client: a preview, never a guard — the save re-judges on its own tx. Tests: 4 new
ctx-passing cases in `quote-routes.test.ts` including the permission INVERSION (quotes.view alone
is 403; orders.view is 200).

## The MANDATORY items (Task 4's review, Important #1)

**1. The orders.ts comments.** `createOrder`'s doc comment (beside its Serializable rationale)
gained: *"⚠️ Since Phase 6, Serializable is ALSO load-bearing for the §5.14 quote-link pairing — no
longer mere uniformity, and never downgrade it: `resolveQuoteLinks`' eligibility read of the quote
line this save links (on this same `tx` — both halves matter, the isolation level AND the
in-transaction read) pairs with `updateQuote`/`deleteQuote`'s Serializable OrderLine-predicate
guard so SSI aborts a link racing a quote-line drop."* The Task 5 mutator section comment (the one
that said "Serializable for uniformity") now carves out `addLine`/`updateLine` — every writer of
`OrderLine.quoteLineId` — as LOAD-BEARING, pointing at createOrder's doc. `resolveQuoteLinks`
carries its own ⚠️ block restating the #60 lesson (the read must run on the tx client, never bare
`prisma`), and the leaf's header states the contract from its side.

**2. The sanctioned one-liner** (in createOrder's doc, same paragraph): a link committing
concurrently onto a just-CLOSED quote is **spec-sanctioned** (judged-at-link-time, ruling 6 — the
`OrderLine.quoteLineId` schema comment); `closeQuote` runs claim-only, so isolation does not stop
it, by design — a future "no links to CLOSED quotes" hardening must add its own mechanism.

**3. The dangerous-direction RED narration** (the close-periods STANDING-INVARIANT pattern; the
committed test is `quote-links.test.ts` › "the §5.14 SSI pairing — dangerous direction"). The
committed shape: a Read Committed GATE holds the `order_number_next` Setting row `FOR UPDATE`
(seeded first — after `truncateAll` no counter row exists, the gate would grip nothing, and the
save was measured committing before the drop even started), so the REAL `createOrder` fixes its
Serializable snapshot, runs its eligibility read (sees the target line live), then BLOCKS at
`allocateNumber` — paused after its SSI read, before its writes. The REAL `updateQuote`
(Serializable — its payload drops the linked-to-be line, keeping the quote's free-text keeper, so
`assignsFk` holds) commits the drop mid-pause; the gate releases; the save proceeds on its stale
snapshot and SSI ABORTS it (40001 → the retryable 409). Asserted: outcome 409, zero Order rows,
zero OrderLines referencing the dead line. **RED, actually run** (the one-line
`saveNewOrder` isolation pinned `Serializable → ReadCommitted`): nothing aborted — the save
RESOLVED, and the test-DB post-mortem showed the corruption in one row: order #1000's line holding
`quoteLineId = cmsoap0eu…` while that same QuoteLine's `deletedAt = 2026-08-11T06:44:27Z` — the
link landed pointing at a dead line, both transactions committed, the exact silent-re-price §7.5
exists to prevent. Restored to Serializable: green, deterministically (the drop commits first, so
first-committer-wins pins the abort on the save).

## The SNAPSHOT_INCLUDE.order finding

**Extended — it was needed.** `SNAPSHOT_INCLUDE.order.lines` pulled each line's part number only;
the new `quoteLineId` scalar would have appeared in update diffs as a bare cuid (the exact
unreadable-history shape issue #24 exists to prevent), so the include now also pulls
`quoteLine: { select: { quote: { select: { quoteNumber: true } } } }` — a link/unlink/re-pick reads
"Quote 1080 → 1085" in history. Live join is safe there for the same §5.14 reason as the detail
read. Test-asserted: the updateLine re-pick test checks `before`/`after` snapshots carry the two
quote numbers; the createOrder audit test checks the hand-built create payload carries
`quoteLineId` + `quoteNumber` (the "create entry and update diffs describe the same fields" rule).

## The linkedOpenOrders consolidation decision

**Left quote-side, not moved.** Task 4's `linkedOpenOrdersFor` (close warning) and
`quoteOrderBlockers` (§5.14 delete refusal + export) stay in quotes.ts: the brief sanctions
leaving them, they answer quote-side questions (their semantics — "not-yet-fully-invoiced",
Blocker shapes — are quote-service concerns documented in Task 4's report), and moving them buys
nothing structurally: the eligibility predicate exists once in the leaf either way, and quotes.ts
does not import quote-links today, so no cycle pressure exists. The leaf stays four functions with
one rule.

## Deviations

1. **`updateLine`'s absent-key semantics are KEEP, not auto-resolve** — the brief's "part swap
   clears + re-resolves (absent-field semantics)" has no reachable path: `UPDATE_LINE` has no
   `partId` key (spec §5a's immutability-by-shape), so the only part swap is removeLine + addLine,
   and addLine auto-resolves the fresh line — the clear-and-re-resolve holds by construction.
   Documented on the schema key. Auto-resolve-on-absent for a plain qty edit would violate
   ruling 6 (silently re-judging a stored link), so absent = keep is the only correct reading.
2. **Order-side integration tests live in `tests/quote-links.test.ts`**, not appended to
   orders.test.ts (2,300 lines): the create/addLine/updateLine/replay/audit/SSI cases share the
   quote fixtures with the leaf tests. The plan's "additions to the orders test suite" is read as
   "the suite of tests over orders behavior", which this file now is for links.
3. **`/api/quotes/eligible` defaults an absent/blank `receivedDate` to today** (createOrder's own
   default; the entry-defaults precedent) rather than requiring it — the brief's query-string
   sketch left it unspecified.
4. **Link exposure is detail-only** (`OrderDetail.lines[]`): the board row carries no per-line
   data, and "keep it minimal — Task 9 builds the UI" reads as exactly the three fields on the
   payloads the entry form and hub actually fetch.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **128 files passed, 2070 tests passed, 0 failed** (was 127 / 2040; `quote-links.test.ts` new with 26, `quote-routes.test.ts` 11 → 15) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; 74/74 static pages |
| `npm run test:e2e` | **all 18 flows passed** (order-entry-full, board-search-scan, loads-after-print, void-order and the other 14 all green — run after the order-save change per the standing owner rule); dev-DB fixtures cleaned by the harness ("cleanup ok"). A first attempt died with the session turn mid-run; the recorded result is a clean full rerun watched to completion |

## For the reviewer to scrutinize

- The SSI-pairing reasoning end to end: the gate technique (Setting row, seeded first — the
  measured no-grip failure mode is narrated in the test comment), whether first-committer-wins
  really pins the abort deterministically on the save, and the three ⚠️ comments' claim that the
  in-transaction read + isolation level are jointly sufficient for ALL three writers (createOrder,
  addLine, updateLine — the last two read via the same leaf on the same tx).
- Deviation 1 — absent-means-keep on updateLine is a semantic fork from create/addLine's
  absent-means-auto; the alternative reading (re-resolve on every edit) contradicts ruling 6, but
  the brief's wording left room.
- `judgeQuoteLine` restating the predicate as a clause walk beside the query's WHERE (drift risk
  accepted for nameable refusals; bound by comment + double-path boundary tests).
- The eligible route's today-default (deviation 3) and its `orders`-area gate (the §5.15 argument).
- The audit snapshot's nested `quoteLine.quote.quoteNumber` shape (vs flattening) — chosen to ride
  the generic include machinery untouched.
