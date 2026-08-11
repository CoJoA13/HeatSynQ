# Task 4 report — Quote service: update, close/reopen, delete, attach-part + routes

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Implementer:** Task 4 subagent

## What was built

**Commit 1 — the mutation half of `erp/src/server/quotes.ts` (`832c6ec`).** `updateQuote`,
`attachPart`, `closeQuote`/`reopenQuote`, `deleteQuote`, `quoteOrderBlockers`, plus the shared
`claimQuote` (the `claimOrder` shape: raw `SELECT … FOR UPDATE`, full row read back under the
lock) and `requireLiveQuote` (missing OR soft-deleted → 404 for every mutator; `getQuote` stays
the one shown-never-hidden reader). `createQuote`'s nested line/price/break create was refactored
into `lineCreateData`/`priceCreateData` so update's create-branch shares it instead of copying it
— no behavior change, the Task 3 suite pins it. Tests: `tests/quotes.test.ts` 43 → **67** (+24).

**Commit 2 — ALL `/api/quotes*` routes except `print`/`eligible` (`3568dd3`).**
`api/quotes/route.ts` (GET list + `worklist=1`, POST create — wires Task 3), `api/quotes/[id]/
route.ts` (GET/PATCH/DELETE), `close`, `reopen`, `attach-part`, `[id]/blockers/export` (the
`parts/[id]/blockers/export` shape end-to-end), `export` (wires Task 3's `exportQuotes`), and
`query.ts` (`parseQuoteFilter`, the orders `query.ts` precedent — list and export share one
parse). Permissions: `view` on GETs/exports, `create`/`edit`/`delete` per method; every handler
is `mustCan(requireUser(), …)` first line; reasons ride `reasonFromBody` (the voidOrder route
shape) and are trimmed in the service. Tests: `tests/quote-routes.test.ts`, 11 tests, ctx passed
everywhere, a permission-denied case per route; the permissions sweep picks the tree up.

## The isolation decision for update (and its siblings)

**`updateQuote` runs Serializable exactly when the payload can assign a registered FK — the
`assignsFk` pattern (`reference.ts:311`): `data.lines !== undefined || data.endingStatementId
!= null`.** A `lines` array can write `QuoteLine.partId` and `QuotePrice.processStepCodeId`, and
a non-null `endingStatementId` writes the third registered column — those payloads pair
`assertRefExists`/`resolveQuoteLines`' live reads with the write inside one Serializable
transaction (the FK-writer pattern). A header-only patch assigns none and runs at default
isolation: the row claim alone is its guard, and per Task 3's warning the create transaction's
SECOND Serializable master (`allocateNumber`) simply does not apply here — update allocates
nothing. The `lines` arm of the conditional is doing deliberate double duty: the §5.14 guard is
a *predicate over `OrderLine` rows* ("no order line references this quote line" — rows that may
not exist, the period-lock shape, unclaimable by `FOR UPDATE`), and every writer of
`OrderLine.quoteLineId` (the Phase 3 one-transaction order save, which Task 5 extends) runs
Serializable — so any payload that can drop or re-point a line is Serializable and SSI aborts
the link-vs-line-delete interleaving. **Standing note for Task 5: the order-side link writers
must stay Serializable** (they are — `createOrder`/`addLine`/`updateLine` all run it), or claim
the quote row, for that pairing to keep holding. `attachPart` is always Serializable (assigns
`QuoteLine.partId`); `deleteQuote` is always Serializable (same OrderLine predicate as its
blocker read); `closeQuote`/`reopenQuote` ride the claim at default isolation — they read and
write only the Quote row's own columns, and the warn list guards nothing (ruling 6: it never
blocks, so a stale read there costs nothing). All documented in the section comment above
`claimQuote`.

## The reopen-fields decision

**Reopen CLEARS the close fields** — `closedAt`/`closedById` → null, `closeReason` → `""` —
rather than leaving them as a tombstone. Three reasons, documented on `reopenQuote`: the schema
deliberately has no reopen columns (unlike `ClosePeriod`'s `reopenedAt`/`reopenReason`, the one
model that keeps both sides); the detail read renders the close fields unconditionally, so a
stale reason surviving onto an OPEN quote would print state that is no longer true; and nothing
is lost — the reopen's audit entry carries the reason arg AND a before snapshot holding the
whole close story (test-asserted), and a later re-close stamps fresh values.

## "Not-yet-fully-invoiced", defined and cited

An order is listed in the close warning iff it is **live** (`Order.deletedAt IS NULL` — voided
blocks/warns nothing, the house rule) **and no live FINALIZED INVOICE covers it** —
`finalizedInvoicesFor`'s FROZEN predicate (`invoice-guards.ts:24`: `kind: "INVOICE"` — a CREDIT
freezes nothing; `status: "FINALIZED"` — a DRAFT owns nothing yet; `deletedAt: null`).
Deliberately NOT `Order.status !== "INVOICED"`: `INVOICED` and `REOPENED` are both
*invoice-owned* status values (`ship-ledger.ts:19`) that `recomputeOrderStatus`/unlock move on
and off — the status is a cached derivation, while the Invoice row is the fact itself and is
what every §5.3/§5.7 guard already reads. Consequence: an order at `REOPENED` (reversing
shipment over finalized paper) is NOT listed — its finalized invoice exists and the credit path
owns that correction. Everything ship-side but not yet finalized (OPEN, PARTIAL_SHIPPED,
SHIPPED, and DRAFT-invoiced orders) IS listed — the orders whose future invoicing the operator
most needs to know about. Deduped per order, ascending by number; read under the quote claim.

## RED narration — the close-vs-update race

The committed test (`quotes.test.ts`, "close-vs-update race") scripts the CLOSER as a
manually-opened DEFAULT-isolation (Read Committed) transaction running `closeQuote`'s own
claim-then-write sequence — SSI off the table, per the plan's recipe — signals only once its
`FOR UPDATE` is held, and commits the close while a header-only `updateQuote` (itself Read
Committed: no lines, no FK) is provably blocked (the 200 ms probe). RED was verified by
replacing `updateQuote`'s `claimQuote` with a bare `findFirst`: the update read `OPEN` from its
pre-close read, sailed past the status check, blocked at its WRITE on the holder's row lock
instead, and after the close committed the edit **landed on the CLOSED quote** — vitest printed
the resolved detail carrying `notes: "sneaky edit"` beside `status: "CLOSED"`. Restored, the
update blocks at the claim, re-reads CLOSED fresh, refuses with the 400, and writes nothing.

## The array-replace precedent and line-id stability

The brief's named `replacePartPrices` does not exist — `part-prices.ts` edits per-row
(add/update/delete/reorder), and the whole-array replaces in this codebase (`replaceInvoiceLines`,
`replaceCharges`, `replaceShipperLines`) all **delete-and-recreate with reminted ids**, which an
id-stable contract cannot be built on (`OrderLine.quoteLineId` points at `QuoteLine` ids —
ruling 5). So `applyQuoteLines` is a **diff-and-write** merge of the two precedents: the payload
is a whole-array replace (one-save document, positions re-derived index+1 — Task 3 deviation 3),
but rows carrying an `id` (validated against the claimed live tree, never trusted) update **in
place**, rows without one are created, and live rows missing from the payload are soft-deleted —
`applyLoads`' update-in-place-then-trim shape, with per-field "identical value: skip" diffs (the
`linkOrder` no-junk-audit rule) so an untouched row never writes and never churns the snapshot
diff. Two orderings are load-bearing for the live-rows-only partial uniques: a kept price row
whose `processStepCodeId` changed (and a kept break whose `threshold` changed) is **stamped and
re-minted**, never patched — an in-place swap of two rows' codes collides with the sibling's
still-live `(quoteLineId, processStepCodeId)` index mid-sequence (test: the two-row swap) — and
all stamps run before all creates/patches. Price/break ids are kept stable on value-only edits
too (test-asserted), purely for honest audit diffs; only LINE ids are contractual.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **127 files passed, 2040 tests passed, 0 failed** (was 126 / 2005; `quotes.test.ts` 43 → 67, `quote-routes.test.ts` new with 11) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; 73/73 static pages generated |

E2E not run — no UI pages or flows in this task (brief: routes are not flows).

## Deviations

1. **`UPDATE` is a PATCH, not a full-document PUT**: every header key optional (absent = keep,
   the `UPDATE_ORDER` precedent), `lines` optional (absent = tree untouched; present =
   whole-array replace, `min(1)`). The brief specified array-replace for lines and left the
   header shape open; this matches how orders/parts PATCH.
2. **`customerId` present-and-EQUAL is tolerated** (a full-form client echoes it back); only a
   different id 400s. The immutability the spec demands is about changing it.
3. **Absent `endingStatementId` on update keeps the stored value — including a stored null —
   and never re-derives the kind's default** (test-asserted): spec §5.1's default is an *entry*
   default.
4. **`updateQuote` may also ATTACH a part** (null → partId on an unlinked kept line) since the
   array-replace validates exactly what `attachPart` validates; `attachPart` remains the
   dedicated single-action route the spec names. Detach (partId → null) on an UNLINKED line is
   likewise legal; on a linked line every partId change is the §5.14 refusal.
5. **Free-text columns on a part-linked payload line are stored as sent** (Task 3 deviation 10's
   rule carried forward), so an update round-trip of a previously-attached line blanks its
   dormant text history — `linesPayloadFrom` in the tests documents the round-trip shape.
   `attachPart` itself never touches them (spec §4.1's "keep as-is" honored where it was ruled).
6. **A CLOSED quote deletes fine** (no status precondition on delete — spec §5.1 names none;
   the typo case may well have been closed first). Test-asserted.
7. **Dropped lines take their price rows with them only implicitly**: grandchildren are left
   unstamped behind the dead line (the `deletePartPrice` "gone from every live read" rule;
   test-asserted). Same for `deleteQuote`: quote + live LINES stamped, price rows left.
8. **`quoteOrderBlockers` takes an optional `db` param** (default `prisma`): `deleteQuote` reads
   it under its claim on `tx`, the export route reads it bare — one query, two callers, no
   drift between the refusal's list and the exported one.
9. **The delete/§5.14 refusal messages name every blocking order in one sentence** (`order(s)
   #7040 · ACME, #7041 · ACME still price from it`) rather than the first-blocker-only shape
   some shipment refusals use — the brief demanded "the full list with order numbers".

## For the reviewer to scrutinize

- The conditional isolation on `updateQuote` (`assignsFk`) — in particular the argument that
  every payload able to trip the §5.14 guard necessarily carries `lines` and is therefore
  Serializable; and the standing Task 5 requirement it creates (link writers stay Serializable).
- The stamp-then-remint handling of step-code/threshold re-keys in `applyQuoteLines` — the
  partial-unique swap-hazard reasoning, and whether re-minting (rather than a two-phase parking
  scheme) is acceptable given price-row ids are non-contractual.
- `linkedOpenOrdersFor`'s definition of "open" (any live order without finalized paper, SHIPPED
  included, REOPENED excluded) — a judgment call the brief delegated; documented above.
- Deviations 4–6 — each a judgment call the brief's wording left open.
- The reopen-clears-fields decision vs. a tombstone reading of the schema.
- `linesPayloadFrom` (tests) as the presumed Task 8 client round-trip contract.
