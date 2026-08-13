# Task 12 report (fix wave) — Ruling 7's overlap-save warning

**Implementer:** subagent (task-12) · **Date:** 2026-08-12 · **Commit:** `7d5a64d`
(feature, src + tests in one commit per the TDD convention: RED watched → implement → GREEN → commit)

## What was built

Exactly the brief's deliverable, nothing else. Spec §3 ruling 7's second sentence — "Saving a
quote that overlaps an existing open quote for the same part **warns but doesn't block**" — as
the §5.7 `shipmentWarnings` shape:

1. **Service** (`src/server/quotes.ts`): a new `overlapWarnings(tx, quoteId)` helper + exported
   `QuoteMutationResult = QuoteDetail & { warnings: string[] }`. `createQuote`, `updateQuote`
   and `attachPart` now return the fresh detail **plus** `warnings`, computed inside the same
   transaction AFTER the write (so the surface describes exactly the state being committed).
   One warning per (part, other-quote): for each live part-linked line of this quote, every
   OTHER live `OPEN` quote holding a live line for the same part whose
   `[effectiveDate, expiryDate]` window overlaps this quote's — **inclusive both ends** (the
   §5.2 eligibility boundary: `other.effectiveDate ≤ this.expiryDate AND other.expiryDate ≥
   this.effectiveDate`; two windows sharing one day overlap, adjacent-by-one-day do not).
   Free-text lines never warn. Deterministic order: this quote's lines by position, other
   quotes ascending by number. Message (pinned verbatim in two tests):
   `Part P-100 is also quoted on open quote #1000 (effective 2026-08-01 – 2026-08-31,
   overlapping this quote's window) — at order entry, the latest effective date wins`.
   Warns never block: the helper is advisory-only, throws nothing, and no caller turns a
   non-empty result into a refusal. `getQuote` stays a bare detail; close/reopen untouched.

2. **Routes**: zero code changes needed — all three routes serialize the service return, so the
   member rides through. Pinned in `tests/quote-routes.test.ts` (create: quiet + a second
   overlapping create warns naming part and number; PATCH and attach-part: `warnings` present).

3. **UI**: `quote-form.ts` gains the client mirror `QuoteMutationData`. `QuoteDetail.tsx`: Save
   and attach-part adopt the mutation response AND set a new `overlapWarnings` state, rendered
   as the house amber list (`ShipmentDetail.tsx`'s §5.7 banner, byte-identical classes) above
   the header section. **§5.13 discipline:** the state is written ONLY by the two mutation
   handlers; `load()` and every rollback-reload path never touch it, so no reload that follows
   the save can clear it (audited: writes at lines 274/548 only). Navigation dismisses it
   (`page.tsx` remounts per id); a later save with zero warnings replaces it with the empty
   surface. `Quotes.tsx` (create flow): a create that succeeds WITH warnings stops on a
   NewShipment-precedent panel (green "Quote #N created." + amber warning list + "Go to quote")
   instead of navigating past them; zero warnings navigates immediately, exactly as before.

## RED narration

The 11 new vitest cases (`quotes.test.ts`, "overlap-save warnings (ruling 7)") and the 3
extended route assertions were run and **watched RED before any implementation existed**: after
one pre-RED syntax fix (an `await` inside a non-async arrow, a transform error — not a RED),
the watched run was **11 failed | 68 skipped** in quotes.test.ts and **3 failed | 12 passed**
in quote-routes.test.ts, every failure the same shape — `expected undefined to deeply equal []`
/ "Target cannot be null or undefined" on the `warnings` member of a successful mutation
response — i.e. exactly the absent feature, no fixture noise. GREEN followed from the service
change alone; no test was edited after RED.

Coverage as briefed, all message-content-asserted (part number + other quote's number, two
tests pinning the full string): partial overlap both directions + containment both directions +
the single-shared-day touch (inclusive boundary); NOT warned — disjoint-by-one-day, other quote
CLOSED, other quote deleted, other LINE deleted (surviving other-part lines don't collide),
free-text lines (matching text included), self (create and echo-update); attachPart creating
the overlap warns on its own response while the attach LANDS; a date-only update that shrinks
out of overlap stops warning and re-warns when widened back; one warning per (part, other-quote)
with 2 parts × 2 other quotes = 3 lines in deterministic order.

## Customer-scoping verification (the brief's named claim)

Verified: `Part.customerId` is a required FK (`prisma/schema.prisma`, Part model), and both
writers of `QuoteLine.partId` — `resolveQuoteLines` (quotes.ts, "that part belongs to another
customer" 400) and `attachPart` (same refusal) — enforce the part belongs to the quote's own
customer; therefore two quotes holding live lines for one `partId` are necessarily the same
customer's, and `overlapWarnings` needs no customer filter. Stated in the helper's doc comment.

## Deviations

1. **`updateQuote` computes warnings on EVERY response, not only when `lines` is present.** The
   brief's item 1 parenthetical says "(when `lines` present)", but its own deliverable line
   ("overlap warnings on every mutation that can create an overlap") and its own test list (the
   date-only shrink case) require the superset: a date-only PATCH can itself create (extend) or
   dissolve (shrink) the overlap, and the §5.7 precedent is that every edit response carries the
   full advisory surface. Additive-only; the advisory read rides the caller's existing isolation
   (header-only PATCH stays default isolation — a stale advisory read costs nothing, the
   closeQuote `linkedOpenOrders` precedent).
2. **No response zod extended** — none exists for these routes (they serialize the service
   return); the "type mirrors" half was done (`QuoteMutationData`) and ride-through pinned in
   route tests instead.
3. **Create-flow rendering**: warnings surface on the /quotes page in a stop-panel rather than
   after navigation — the NewShipment `savedShipment` precedent ("shown, never raced past by the
   navigate"), which is the house shape the brief's "mirror the shipment warning banner" names
   for creation. The e2e quotes flow is unaffected (its two creates carry zero warnings and
   navigate immediately — verified in the watched 19/19 run).
4. **Banner lifetime**: on the detail page a save-raised banner persists through a later
   close/reopen until the next save/attach or navigation (mirrors ShipmentDetail's warning
   lifetime; reopen's response carries no warnings to replace it with). Left as-is — scrutiny
   pointer below.

## Gates (all watched to completion, 2026-08-12)

| Gate | Result |
|---|---|
| `npm test` | ✅ 130 files / **2133 tests** passed (+11 over Task 11's 2122) |
| `npx tsc --noEmit` | ✅ clean |
| `npx eslint src tests` | ✅ clean |
| `npm run build` | ✅ compiled, 75/75 pages |
| `npm run test:e2e` | ✅ **19/19 flows PASS**, exit 0, watched to the results table; "cleanup ok" |

Dev DB verified clean after the E2E run (0 quotes, 0 orders, 0 E2E-prefixed
customers/parts/users/step codes, 0 live ending statements).

**Live UI smoke (scripted Playwright one-off against `npm run dev`, dev DB):** all four
behaviors verified in the real browser — no-warning create navigates straight through; the
overlapping create STOPS on the panel naming `T12SMK-P1` and the first quote's number; the
detail save renders the amber banner with the exact service message; a shrink-out-of-overlap
save clears it. Screenshots retained in the session scratchpad. Smoke fixtures purged
afterwards **including the smoke's own 4 quote audit rows** (the Task 11 orphaned-audit-rows
lesson) and `quote_number_next` restored to its pre-smoke 1015; the 4 pre-existing Task-11
orphaned audit rows (dated 2026-08-11) were left untouched as flagged.

## Scrutiny pointers

- `overlapWarnings` (src/server/quotes.ts, after `getQuote`): the two queries and the inclusive
  `lte`/`gte` pair; the `line.part!` non-null assertion is justified by the `partId: { not:
  null }` line filter directly above it.
- The advisory read runs at the caller's isolation (Read Committed on a header-only PATCH) —
  deliberate, documented in `updateQuote`'s doc comment; it guards nothing.
- The warning wording is pinned verbatim in two tests (`quotes.test.ts` create + attachPart
  cases) — a future wording edit must touch those.
- `Quotes.tsx`: the created-with-warnings branch fires `void reloadAll()` (fire-and-forget, the
  bump/close handlers' own shape) so the panel and the refreshed list race benignly.
- Deviation 4 (banner persists through close/reopen) if the demo finds it surprising.
