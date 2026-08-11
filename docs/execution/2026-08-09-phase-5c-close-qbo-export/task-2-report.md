# Task 2 report — BillingConfig GL defaults: service, delete-blocker registry, admin UI

**Status:** DONE
**Commit:** `156fafc` — `feat(5c): BillingConfig A/R, discount, write-off GL defaults + admin UI`
**Branch:** `phase-5c-close-qbo-export`
**Base:** `4d5c52a` (docs(5c): Task 1 complete (review clean); Task 2 brief)

## What was implemented

Followed the brief's 9 steps verbatim, no deviations in code shape.

1. **`erp/tests/billing-config.test.ts`** — added the brief's three tests verbatim (round-trip +
   blocker for the three new GL defaults, refuse-nonexistent-account, and the `GlPosting`-blocks-
   deletion runtime test built directly against `ClosePeriod`/`GlExportBatch`/`GlPosting`). Also
   updated the pre-existing `"returns the seeded singleton with everything unset"` test's `toEqual`
   fixture to include the three new `null` fields — `BillingConfigRow` now has three more keys, so
   that test's exact-match assertion would otherwise fail on the extra properties `getBillingConfig`
   now returns. This one line wasn't spelled out in the brief's Step 1 snippet but follows directly
   from extending `BillingConfigRow`/`EMPTY` in Step 3, and is needed for Step 6's "run the service
   + sweep tests green" to actually hold for the whole file, not just the new tests.
2. **Ran red** (`npx vitest run tests/billing-config.test.ts -t "round-trips the three 5C GL
   defaults"`) — failed exactly as predicted: `ZodError: Unrecognized key: "arGlAccountId"`.
3. **`erp/src/server/billing-config.ts`** — extended in the five lockstep spots exactly as
   specified: `BillingConfigRow` type (+3 `string | null` fields), `EMPTY` fallback (+3 nulls),
   `SAVE` zod (+3 `z.string().nullable().optional()`), `getBillingConfig`'s return mapping (+3 raw
   string passthroughs, no `.toNumber()` — they're not decimals), and `setBillingConfig`'s `assigns`
   boolean (+3 `!= null` disjuncts) plus three `assertRefExists("glAccount", …, tx)` guards inside
   the transaction, positioned after the existing four guards.
4. **`erp/src/lib/reference-links.ts`** — added `"glPosting"` to the `ReferenceLinkModel` union;
   added the `GL_POSTING_BLOCKER` const verbatim (right after `BILLING_CONFIG_BLOCKER`, `liveWhere:
   {}` since `GlPosting` has no `deletedAt`); added the four registry entries verbatim (three
   `billingConfig` GL-default entries reusing `BILLING_CONFIG_BLOCKER`, plus `glPosting.glAccountId`
   using `GL_POSTING_BLOCKER`), placed after the existing `billingConfig.certChargeStepCodeId` entry
   and before the Phase 5B `payment.paymentTypeId` entry/comment.
5. **`erp/tests/reference-links-sweep.test.ts`** — inserted the four new expected-offender strings
   into the `.sort()`-ed exact array at their correct alphabetical positions: `arGlAccountId` before
   `certChargeStepCodeId`, `discountGlAccountId` between `certChargeStepCodeId` and
   `freightGlAccountId`, `writeOffGlAccountId` after `salesTaxGlAccountId`, and
   `glPosting.glAccountId` between `customerSurcharge.surchargeId` and `inspectionCode.
   defaultScaleId` (which also satisfies the brief's "after customerSurcharge.*, before
   invoiceLine.*" — `inspectionCode` itself sorts before `invoiceLine`, so the tighter bound is a
   strict subset of the brief's looser one).
6. **Ran green**: `npx vitest run tests/billing-config.test.ts tests/reference-links-sweep.test.ts`
   — 27/27 passed (15 + 12).
7. **`erp/src/app/admin/billing/page.tsx`** — extended the `Cfg` type with the three new `string |
   null` fields; added three `<select>` blocks copying the "Freight GL account" block verbatim
   (field name in `value`/`onChange`/`savedMark`, label text only differs), inserted after "Other
   charge GL account" and before "Certification charge step code" so all GL-account selects stay
   grouped together. `glAccounts` state and `save()` needed no changes, as the brief predicted.
8. **Verified in the browser + ran E2E.** Started the dev server (`.claude/launch.json`'s
   `erp-dev`), signed in as `admin`/`admin`, navigated to `/admin/billing`: confirmed the page text
   shows "A/R GL account", "Discount GL account", "Write-off GL account" in that order with
   `(none)` selects. Created a scratch GL account (`1200-TEST`) via the existing reference-data API,
   set A/R via the new select (`form_input` + confirmed the resulting `PUT /api/admin/billing`
   returned `arGlAccountId` correctly set), reloaded the page and confirmed the select came back
   pre-selected to that account (proving persistence, not just optimistic UI state), then set
   Discount and Write-off the same way and confirmed `GET /api/admin/billing` returned all three
   set correctly with no transposition. Cleared all three back to `null` and soft-deleted the
   scratch GL account afterward to leave the dev DB clean. Then ran `npm run test:e2e`: **all 17
   flows passed** (unrelated to billing specifically, but per CLAUDE.md's "run E2E whenever a
   change touches any UI, function, or flow" instruction).
9. **Committed** exactly the brief's five files with the brief's exact message, no attribution
   trailer: `156fafc`.

## Gate results

```
npx vitest run tests/billing-config.test.ts tests/reference-links-sweep.test.ts
```
```
 ✓ tests/billing-config.test.ts (15 tests)
 ✓ tests/reference-links-sweep.test.ts (12 tests)
 Test Files  2 passed (2)
      Tests  27 passed (27)
```

Full suite as a diligence check beyond the brief's scoped Step 6: `npm test` — **121/121 files,
1884/1884 tests pass** (this closes the one known gap Task 1's report flagged — the sweep is now
green on the full run, not just the scoped one).

`npx tsc --noEmit` — **PASS**, no output.

`npx eslint src tests` — **PASS**, no output.

`npm run test:e2e` — **PASS**, all 17 flows green (`template-build-and-load`,
`typed-fields`, `revision-cut`, `blocked-code-delete`, `permission-gating`, `processes-list`,
`order-entry-full`, `board-search-scan`, `loads-after-print`, `void-order`,
`ship-partial-then-complete`, `multi-order-shipment`, `cert-results-print`, `void-shipment`,
`credit-hold-block-and-override`, `invoice-shipped-order`, `receivables-apply-age-statement`).

## Self-review

- **All five lockstep spots in `billing-config.ts` verified present and consistent** — grepped for
  `arGlAccountId`/`discountGlAccountId`/`writeOffGlAccountId` across the file: type, `EMPTY`,
  `SAVE`, `getBillingConfig`'s mapping, and `setBillingConfig`'s `assigns` + three guards. No
  `.toNumber()` accidentally applied to the new string fields (they're FK ids, not decimals) —
  double-checked against the brief's explicit "raw string passthrough, NOT `.toNumber()`" note.
- **Route left untouched** — confirmed `src/app/api/admin/billing/route.ts` has no diff; the PUT
  handler already forwards the whole parsed body to `setBillingConfig`, so the three new fields
  flow through for free, matching the brief's Step 7 note.
- **`GL_POSTING_BLOCKER` uses `liveWhere: {}`, not the default** — confirmed by reading the
  registry entry and by the runtime test (`findBlockers` would otherwise throw querying a
  nonexistent `deletedAt` column on `GlPosting`; the test passing is direct proof this didn't
  regress).
- **Sweep's four exact-offenders insertions checked against real alphabetical sort**, not just
  brief comments — ran `unregisteredLinks(SCHEMA, new Set()).sort()` mentally and confirmed via the
  actual green test run rather than trusting the brief's inline comments alone.
- **No unrelated files touched** — `git diff --stat` on the commit shows exactly the five files the
  brief's Step 9 lists; no schema, no route, no other service file.
- **Admin page diff is additive-only** — the three new `<select>` blocks are byte-for-byte copies
  of the existing "Freight GL account" block with only the field name/label swapped; no changes to
  `load()`, `save()`, or any existing field.
- **Browser verification round-tripped through actual HTTP calls**, not just DOM state — read the
  network response bodies of the `PUT`/`GET /api/admin/billing` calls directly rather than trusting
  the "saved" DOM mark (which I could not screenshot in this sandbox — the Browser pane wasn't
  compositing frames for `computer{action:"screenshot"}` — but whose underlying save/reload cycle
  I proved by other means: response payload inspection, and a full page reload with the select
  arriving pre-populated).

## Concerns

1. **Browser-pane screenshot was unavailable in this environment** (`the Browser pane is not
   displayed, so the page is not compositing frames`). I substituted direct verification of the
   underlying behavior — reading the `PUT`/`GET /api/admin/billing` JSON response bodies and
   reloading the page to confirm the `<select>`s come back pre-populated from the server — which
   proves the same thing the "saved" DOM mark would have shown (the `savedMark` helper is unchanged
   copy-paste of the existing, already-proven pattern used by the other six fields on this page, so
   there's no new logic there to be at risk). Not blocking, just noting the screenshot step
   itself couldn't run as literally described.
2. **Pre-existing, out-of-scope items noticed in `git status` that I did not touch:**
   `.superpowers/sdd/.gitignore` shows as modified (reset from its documented header comment back to
   a bare `*` — the exact anti-pattern CLAUDE.md warns about) and
   `docs/execution/2026-08-09-phase-5c-close-qbo-export/task-1-brief.md` is untracked. Both predate
   this task's changes (confirmed via `git diff` scope and file mtimes, which land before my first
   edit) and are outside Task 2's file list, so I left them alone rather than making an unrequested
   change to files owned by a different task's cleanup. Flagging per CLAUDE.md's emphasis on this
   specific failure mode, in case the controller wants Task 1's follow-up (or the next task) to
   commit `task-1-brief.md` and restore the `.gitignore` header before it gets clobbered again.

No other concerns. All service, registry, sweep, and UI changes match the brief exactly; every
gate (vitest scoped, vitest full, tsc, eslint, e2e) is green.
