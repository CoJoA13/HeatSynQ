# Task 7 report — Cross-entity §5.14 blocks

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Implementer:** subagent (task-07)

**Commits:** `a70fcfb` (parts side), `245eff1` (customers side), `c6fb2a8` (generic-walk + contact verification tests), plus this report's docs commit.

## Each delete path, before → after

### 1. `deletePart` — the gap this task existed to close

**Before:** only live orders blocked (Task 15's guard, `src/server/parts.ts`). A part referenced by a live quote line deleted cleanly — hollowing out the agreement, since a part-linked quote line reads its printed identity (number/name/description/material/each weight) live from the part (spec §4.1).

**After:** `deletePart` refuses with `That part is quoted on N live quote(s)` — a second in-tx count directly after the order count, same Serializable transaction (`parts.ts`). The count's filter is the exact predicate the new `partQuoteBlockers` lists — live line AND live quote (`deletedAt` at both levels, the QUOTE_VIA_PRICE chain rule one level up), counted per QUOTE, not per line, so refusal and panel can never disagree. `status` is deliberately not consulted: a CLOSED quote is a live record and blocks (pinned by test); a deleted quote, a line edited out of a live quote, and a live-looking line under a dead quote all block nothing (each pinned).

- Blocker naming follows the one convention a Quote already has everywhere (`reference-links.ts`'s two registry entries): `{ entityLabel: "Quote", name: "Quote · #1006", href: "/quotes/<id>" }`. The href is emitted now; the page it lands on arrives with Task 8, exactly as the Task 1 registry entries already do.
- `/api/parts/[id]/blockers` and `/blockers/export` now serve the **order+quote union** (the customers-route precedent: the panel must show every category regardless of which guard threw first). The export test reads the workbook back and asserts the Quote row's Type/Name/Link cells.
- `src/app/parts/[id]/page.tsx`'s delete handler matches the new refusal (`live quote(s)`) alongside `live order(s)`, so the existing BlockerPanel renders it — no new UI.
- SSI pairing (stated in the guard's comment): `createQuote`/`updateQuote`/`attachPart` (quotes.ts) each read their lines' parts live on their own Serializable tx before writing `QuoteLine.partId`, so the delete-vs-quote race forms the read-write cycle Serializable aborts — the createOrder/addLine pairing one writer over.

Tests: `tests/parts.test.ts` ("deletePart is guarded by live quotes", 4 tests — refusal incl. CLOSED, count-vs-panel agreement via a raw two-lines-one-quote fixture the service itself would refuse to produce, both dead-chain complements with clean deletes after); `tests/parts-routes.test.ts` (union JSON + workbook rows).

### 2. `deleteReference` → `deleteStepCode` (processStepCode)

**Before = after — zero new code.** Task 1's `QUOTE_VIA_PRICE` registry entry (`src/lib/reference-links.ts`) already put `QuotePrice.processStepCodeId` inside the generic `findBlockers` walk, which `deleteStepCode` (process-step-codes.ts) runs in-tx. Task 7's deliverable here was behavioral proof:

- A step code priced on a live quote → `findBlockers("processStepCode")` returns the QUOTE, once (two price rows on two lines dedupe to one blocker), named `Quote · #1000` with the `/quotes/<id>` href; `deleteStepCode` refuses `still in use by 1 record(s)`.
- **From the grave, all three chain levels pinned separately:** dead price row / dead line / dead quote with deliberately live-looking children → no block, and the step code then deletes. **RED-verified:** temporarily dropping the quote-level liveness from `liveWhere` made the dead-quote case fail exactly as designed (blocker leaked from the grave); restored, green. The chain walk is load-bearing, not decorative.

Tests: `tests/process-step-code-blockers.test.ts` (+2).

### 3. `deleteReference("endingStatement")`

**Before = after — zero new code.** Task 1 registered `quote.endingStatementId` (default `liveWhere: { deletedAt: null }` — Quote holds the FK itself), Task 2 made `endingStatement` a genuine ReferenceKind, so the generic `deleteReference` guard covers it. Pinned both directions in `tests/reference-blockers.test.ts` (+1): live quote → refused `still in use by 1 record(s)`, blocker named `Quote · #1000` linked, statement survives (refused-not-cleared); quote soft-deleted (it keeps its `endingStatementId` forever) → no blocker, statement deletes.

### 4. `deleteCustomer`

**Before:** children → parts → orders guards (customers.ts). A customer with only quotes deleted cleanly, orphaning agreements whose `customerId` is immutable (spec §4.1 — no re-point escape exists).

**After:** fourth in-tx count, after orders, same Serializable transaction: `That customer still has N live quote(s)`. Liveness is the quote row alone (`deletedAt`, never status — CLOSED blocks, pinned; lines are irrelevant, free-text and part-linked alike). `customerQuoteBlockers` names each quote the standard way; both customer blocker routes serve the **three-way part+order+quote union**; the customer page matcher gains `live quote(s)` (the Task 15 precedent — the unrelated "still has child customers" refusal still falls through to the plain banner). **A customer with only DELETED quotes deletes cleanly** — pinned (the brief's "pin whichever the existing service does": nothing else blocks it, so it deletes).

Tests: `tests/customers.test.ts` (+2, free-text-line fixtures so the parts guard stays at zero and the quotes guard is unambiguously under test); `tests/customer-routes.test.ts` (three-way union JSON + workbook rows for all three categories).

### 5. Contact deletion — deliberately NOT blocked (spec §4.1)

Task 3's test proved the surviving READ (raw-update soft-delete → `getQuote` renders contact blank). Coverage for the delete PATH itself was missing: nothing exercised the real `deleteContact` service against a referencing quote, so a future "helpful" §5.14 guard on contacts would have broken the ruling without failing a test. Added one (`tests/quotes.test.ts` +1): `deleteContact` succeeds while a live quote references the contact; the stored FK survives; the render goes blank. The test's comment names the ruling it defends.

## How parts-side enforcement is guaranteed going forward

**The deletePart blocker list IS the enforcement — there is no sweep, and that is a stated decision, not a gap.** The §5.14 registry is structurally reference-kind-only (`BlockerTarget = ReferenceKind | "processStepCode" | "surcharge"`); making `part` a BlockerTarget would force registering every Part-targeting FK in the schema (orderLine, partSpecification, partInspection, partPrice, …) and rewiring `deletePart` wholesale (Task 1 report, deviation 4). Instead:

- `src/lib/reference-links.ts` (the `quote.endingStatementId` entry's comment) now states outright: parts.ts's hand-built list is the enforcement, and **a new Part-referencing FK must be added there by hand**.
- `tests/reference-links-sweep.test.ts`'s expected-list comment says the same from the sweep's side, pointing at the behavior tests that pin what the sweep can't.
- The behavioral guarantee is the paired tests: refusal-with-names AND deletes-cleanly complements, both directions, per path.

## Deviations from the brief

1. **"Live" ruled as `deletedAt: null`, status ignored — a CLOSED quote blocks part and customer deletion.** The brief says "live quote lines"/"live quotes" without defining live against `status`. Every precedent (orders block regardless of status; the registry entries never consult status; spec §5.1 "closing … takes nothing with it") points the same way, and closing being reversible means a closed quote's lines still render from the part. Pinned by tests in both suites; flagged for owner ratification since it is owner-visible behavior.
2. **One test added for contact deletion** (brief: "add one only if coverage is missing") — the delete-path half genuinely was missing; only the read half existed. Detailed under path 5.
3. **The two pre-existing export route tests were strengthened to read workbook contents** (previously they asserted only headers/content-type) — the brief demands "the §5.14 Excel export of blockers must include the quote rows", which only a content read can prove. Applied to both parts and customers export tests.
4. **No new dangerous-direction concurrency test for the two new counts.** Both guards run inside the deletes' existing Serializable transactions and pair with quote-side Serializable in-tx reads that already exist (verified by reading quotes.ts, cited in the guard comments); the plan's RED-verify rule is about concurrency tests that exist. The from-the-grave RED-verification (path 2) is this task's genuine dangerous-direction exercise.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **129 files passed, 2094 tests passed, 0 failed** (was 129 / 2084 after Task 6; +10: parts ×4, customers ×2, step-code blockers ×2, reference-blockers ×1, quotes ×1) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; 74/74 static pages |
| `npm run test:e2e` | **18/18 flows passed** (run because both detail pages' delete handlers changed — the blocked-delete panels are E2E-exercised surfaces); dev-DB fixtures cleaned ("cleanup ok") |

## For the reviewer to scrutinize

- **The CLOSED-quote-blocks ruling** (deviation 1) — the one judgment call with owner-visible consequences.
- **The deliberate liveness asymmetry between the two deletePart counts:** the order count has no line-level filter (`OrderLine` has no `deletedAt`), the quote count filters `lines: { some: { partId, deletedAt: null } }` (`QuoteLine` has one, and updateQuote's array-replace stamps removed lines). Confirm neither side over- or under-counts.
- **The SSI pairing claims** in the two new guard comments (deletePart↔createQuote/updateQuote/attachPart; deleteCustomer↔createQuote) — verified by reading quotes.ts's isolation section, not by a new test (deviation 4).
- **The RED-verification narrative** for the from-the-grave case: drop `quote: { is: { deletedAt: null } }` from `QUOTE_VIA_PRICE.liveWhere` and `tests/process-step-code-blockers.test.ts`'s dead-quote case goes red. Repeatable in one edit.
- **The union ordering** on both blocker routes (orders before quotes; parts before orders before quotes) — asserted exactly in the route tests; the UI renders in that order.
