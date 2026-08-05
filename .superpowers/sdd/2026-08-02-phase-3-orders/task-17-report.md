# Task 17 Report: E2E flows + demo walkthrough + docs

**Branch:** `phase-3-orders`
**Commits:**
- `2d56d3b` — `feat: phase 3 E2E flows`
- `e85dab6` — `docs: phase 3 demo walkthrough + handoff close-out`

**Baseline:** HEAD `125ea43` (Tasks 1–16 merged, suite 904, E2E 6/6)
**Result:** suite **904** (unchanged — this task adds no `tests/` files), `tsc` clean, `eslint`
clean, `npm run build` clean, **`npm run test:e2e` 10/10, run three times consecutively** (the
required "twice in a row" plus one more after the docs commit, for good measure). Both databases
report no pending migrations.

---

## 1. What was built

### Four new Playwright flows (`erp/e2e/flows/`)

- **`order-entry-full`** — keys a two-line lead+rider order for a credit-hold customer, exercises
  serials via the `{001-005}` range shorthand, reloads mid-flow to exercise the autosave
  draft-resume banner (Resume, then spot-checks two representative fields survived the round
  trip), saves through the credit-hold **save-with-warnings interstitial** ("Order #N saved." +
  the warning, "Go to order" — never an immediate redirect past it), and lands on the hub showing
  **"Lead · Rev 1 locked."** Sets `ctx.created.orderId`/`orderNumber` for the three flows below.
- **`board-search-scan`** — confirms the board shows the order with its traffic light (a colored
  `rounded-full` dot, distinct from the plain word "Voided" a voided row shows instead), then
  types the exact order number into the Shell's global search and presses Enter, landing directly
  on the same order's hub (the barcode-scan path).
- **`loads-after-print`** — prints the traveler, confirms the documents archive grows from empty to
  one row, archives the rendered PDF's own bytes (fetched via `page.request`, same session) as
  `traveler.pdf` next to the screenshots, then edits the order's one auto-split load and confirms
  the amber **"A traveler has already printed — print a fresh one"** warning.
- **`void-order`** — arms a `window.prompt` response, voids with a reason, asserts the exact prompt
  copy and the resulting "Voided — {reason}" banner, then confirms the board hides the order until
  "Include voided" is checked (at which point it shows as the plain word "Voided" with no light).

All four run `as: "admin"` (the fixture restricted user holds only `parts.view`/`processes.view`,
no `orders.*`/`void_order`), appended to `FLOWS` after the six existing flows.

### `erp/e2e/lib/db-fixtures.ts`

- A **second customer + lead/rider part pair** (`E2EORDCUST` / `E2E-ORD-LEAD` / `E2E-ORD-RIDER`),
  deliberately separate from the process-suite's own `E2ECUST`/`E2E-PART-1` — those get mutated
  (revision cut, lock) over the course of a run by the pre-existing flows, and coupling the order
  flows to that same part would make them depend on exactly where in that history the earlier
  flows left it. The order customer carries `creditHold: true` so `order-entry-full`'s save
  deterministically returns a non-empty `warnings[]`. The lead part's `PartProcessRevision`/
  `PartProcessStep` are written directly in the fixture (reusing `stepCodeB`, not `stepCodeA` —
  see the bug below) so it is orderable from the moment the harness starts; the real,
  audited `lockCurrentRevision` path is exercised by the flow itself, through the actual app, not
  by this script.
- **`deleteOrdersAndChildren(customerIds)`** — new shared deletion helper, scoped through the
  fixture order-customer's id (the same "customer is the gate" reasoning the existing part lookup
  already uses). Hard-deletes the order and every child table (`StoredDocument`, `OrderAttachment`,
  `OrderSerial`, `OrderCharge`, `Load`, `OrderContainer`, `OrderLine`, plus its `order`-entity audit
  rows) — deliberately not filtered on `deletedAt`, since a leftover *voided* fixture order is
  exactly as unwelcome as a live one. This is the same "hard-delete despite the app being
  soft-delete-only" precedent `deleteTemplatesAndSteps`/`deleteStepCodes` already established.
  Wired into both `reapLeftovers()` (name/code-driven lookup, for self-healing) and `cleanup()`
  (id-driven, from the run's own `create()` result).
- **`deleteUsersAndRoles` now also deletes `OrderDraft`/`SavedView` rows** for the given user ids,
  before `Session`/`User`. Both tables have `ON DELETE RESTRICT` from `User` (verified against the
  actual migration SQL, not assumed) and neither existed before Phase 3 gave `e2e_admin` a reason
  to write to them — `createOrder` only ever *nulls* a draft's payload on a successful save, it
  doesn't delete the row, so a leftover `OrderDraft` for the fixture admin is the **normal** case
  after `order-entry-full` runs, not an edge case. Left unfixed, the very first `e2e_admin` User
  delete after this task would have 23503'd and the harness would have reported cleanup as failed
  (the exact failure mode `run.mjs`'s own teardown was hardened to catch, per its own comments).

### `erp/e2e/lib/ui.mjs`

- **`armPrompt(page, responseText)`** — same shape as the existing `armDialog`, but calls
  `dialog.accept(responseText)` for the void reason's `window.prompt` (the app's only `prompt()`).
- **`pickCombobox(page, labelText, filterText, optionNamePattern)`** — drives the app's hand-built
  Combobox component (customer/part pickers), which no existing flow had exercised yet.

### `erp/e2e/run.mjs`

Only the `FLOWS` array (four new entries, all `as: "admin"`) and `state.created`'s initial shape
(`orderId`/`orderNumber` alongside the existing `templateIds`) changed — no changes to the
teardown/signal-handling/self-heal machinery itself.

---

## 2. A real bug found and fixed while stabilizing

**`page.waitForURL(/\/orders\/[^/?]+$/)` also matches the literal route `/orders/new`** — the entry
page itself, still on screen at the instant "Go to order" is clicked. `waitForURL` resolved against
the *current* URL immediately rather than waiting for the click's navigation, so
`created.orderId` ended up literally the string `"new"`, and every downstream flow
(`board-search-scan`, `loads-after-print`, `void-order`) navigated back to the entry page instead
of the hub and failed. Caught by adding temporary diagnostic logging, reproduced with certainty
(`url=http://localhost:3100/orders/new orderId=new`), and fixed by waiting for hub-only content
(the `"Lead · Rev 1 locked"` badge, which can only render once the hub has actually loaded) before
reading the URL, rather than a broader/more specific regex. Recorded in HANDOFF §4a as a general
lesson for Phase 4's own `/new`-suffixed routes.

**A second, unrelated bug** surfaced in the same stabilization pass: the order-lead fixture part
originally reused `stepCodeA` (`E2E-QNCH`) for its one process step — but the pre-existing
`blocked-code-delete` flow asserts an **exact** blocker count ("2 record(s) use it") for that
specific code, and a third live reference silently broke it. Fixed by reusing `stepCodeB`
(`E2E-WASH`) instead, which nothing asserts an exact count against.

Both were caught by the stabilization runs this task's own process calls for ("run repeatedly
until stable — flaky E2E is a finding, not a shrug") — three consecutive 10/10 runs followed both
fixes, on the branch's final committed state.

---

## 3. Documentation

- **`docs/2026-08-03-phase-3-demo.md`** (new) — owner-facing walkthrough: what Phase 3 delivered,
  seed state, the four new flows (each with a "Demonstrates" line and its artifact paths, the
  2C-3 demo doc's own shape), a prose description of the actual printed traveler page (verified by
  opening the archived `traveler.pdf` with `pdftoppm`/visual inspection, not assumed), "Watching it
  live," "What changed for daily use," an **"Owner notes — decisions you may want to revisit"**
  section (the four items specified: global search's unauthenticated exact-order-id match; the
  save-with-warnings panel's extra click; the two traveler mockup deviations — Process cell blank,
  Process ID prints the lead part number, the load-weight grey sub-line; and the one validation
  message with no line number, which is the design spec's own literal required wording), and the
  gate results this doc is based on. Deliberately **text-only, no embedded images** — matches the
  one existing precedent in this repo (`docs/2026-08-02-2c3-demo.md`) exactly; there is no prior
  art anywhere in this repo for committing screenshot binaries into `docs/`, and inventing that
  asset-management pattern unprompted felt like exactly the kind of assumption CLAUDE.md's prime
  directive warns against. I did visually verify every described screenshot and the rendered PDF
  page before writing the prose describing them (see §5 below).
- **`docs/HANDOFF.md`** — §4a gains the "Phase 3 (Orders & Loads) is complete on `phase-3-orders`,
  **not yet merged**" block (gates, what was delivered per task, the 16-tasks-independently-
  reviewed summary, three carried-forward lessons — the sibling-split pattern recurring in the
  bulk-edit grids, the row-lock guarantee holding under `createOrder`'s first real call, and this
  task's own `/orders/new` regex trap — and the owner-rulings recap pointing at spec §3's dated
  amendments). "What to do next" now points at merging Phase 3 then starting Phase 4. §9's kickoff
  prompt is fully replaced with a Phase 4 (Certifications & Shipping) version, carrying forward
  the design spec §16 inheritance list verbatim in structure (reserved statuses + the §5a
  status-tightening hook, `allocateNumber`/`StoredDocument` reuse, the credit-hold shipping gate,
  ship-line-complete as a human decision, the serialization warning's shipping sibling, the
  attachment-story reuse, cert-required columns deferred here, and the §3.9 sampleQty/inspection-
  image outcomes as settled, not open). The top "Updated:" line and the §7 samples-owed item
  (traveler done, shipper/cert/invoice still owed) were also stale relative to Phase 3's actual
  completion and are fixed — pre-existing staleness, not introduced by this task, but the
  self-review's "no stale Phase-3-is-next text anywhere" bar reads as covering the whole document,
  not only the two sections explicitly named.
- **`CLAUDE.md`** — one new bullet under "Constraints that will bite you": pdfmake's browser build
  wants a global `window` and cannot run under Node, so the traveler renderer uses `PdfPrinter`
  fed vfs-decoded font buffers, plus `next.config.ts`'s `serverExternalPackages`.
- **`docs/superpowers/specs/2026-08-02-phase-3-orders-design.md`** — the §9 route table's
  containers/serials/charges row said "POST / PATCH / DELETE"; the actual routes are all
  PUT-replace (verified against every route file directly), matching the loads row's own wording.
  One-line fix, ledgered from Task 9's own review.

---

## 4. Gates

```
npx tsc --noEmit          clean
npx eslint src tests       clean
npm test                   904 passed (73 files) — unchanged; no tests/ files touched
npm run build              succeeded (all order/traveler routes present in the manifest)
npm run test:e2e           10/10, three consecutive runs (the committed final state)
npx prisma migrate status  clean, both erp and erp_test
```

---

## 5. Self-review against the task's checklist

- **10/10 twice in a row**: done — three consecutive full runs, the last one against the final
  committed state (post-docs-commit).
- **Screenshots actually show the claimed states**: verified by opening the actual PNGs (not just
  trusting the flow's assertions) for the credit-hold banner, the five expanded serials, the
  draft-resume prompt, the save-with-warnings panel, the hub's "Lead · Rev 1 locked" badge, the
  board's traffic-light dot, both loads-after-print warnings together, the voided hub banner, and
  both board states (hidden/shown-with-include-voided). Also converted the archived
  `traveler.pdf` to a PNG with `pdftoppm` (a local tool, not a new project dependency — the flow
  itself only writes the raw PDF bytes via portable Node/Playwright APIs) and visually confirmed
  the printed page matches the demo doc's prose description exactly, including both recorded
  mockup deviations (Process ID = lead part number, the load-weight grey sub-line).
- **Demo doc readable by a non-programmer**: written in plain narrative throughout, jargon
  explained inline (e.g., what a traffic light means, what "locks the revision" means in practice)
  rather than assumed.
- **HANDOFF §4a/§9 internally consistent**: grepped the whole file for "Phase 3" after editing —
  every remaining mention is either historical (accurately describing what Phase 3 built or was
  predicted to build, in a context that reads correctly in past tense) or part of this task's own
  new "complete, not yet merged, next is Phase 4" framing. No stale "next work is Phase 3" text
  survives anywhere in the file.
- **Owner-notes section complete**: all four specified items present, each grounded in the actual
  spec text or source code (not paraphrased from memory) — quoted/verified against
  `src/server/search.ts`'s own design-decision comment, the spec's §3 dated amendments, and
  `part-process-steps.ts`'s literal error string.
- **Fixtures cleaned**: verified directly against the dev database after the final run — zero
  `E2EORDCUST`/`E2ECUST` rows, zero orders under the fixture customer, zero `e2e*` users. The only
  `OrderDraft`/`SavedView`/`StoredDocument` rows remaining belong to the real, pre-existing
  `admin` user and pre-existing orders (1000/1001/1012/1013) from earlier tasks' own manual
  dev-server smoke sessions — confirmed by joining each row back to its owning user/order, not
  assumed; entirely outside this task's scope and untouched by it.

## Concerns / carried forward

- The popup-vs-blocked branch of the traveler's `window.open` call is not asserted either way in
  `loads-after-print` (best-effort screenshot only if a popup appears) — this environment's
  headless Chromium did not produce a popup in any of the three runs, consistent with Task 16's
  own dev-smoke observation that this exact call gets blocked in a headless/background pane. The
  flow doesn't depend on which branch fires; it archives the PDF via a direct authenticated
  request regardless.
- HANDOFF's new Phase 3 block doesn't enumerate every minor open item from every task's own
  "Concerns" section (e.g., issue #32, a `pg` DeprecationWarning suppression already
  self-documented in its own code comment) — judged not owner-relevant enough to duplicate into
  HANDOFF on top of where it's already tracked, to keep the block from growing unbounded.

Report path: `/home/cojoa13/Desktop/HeatSynQ/.superpowers/sdd/task-17-report.md`

---

# Fix round 1

**Commit:** `8ffcc28` — `docs: phase 4 kickoff carries the per-load render precedent; count corrections`
**Contract:** docs-only. `npx tsc --noEmit` clean, `npx eslint src tests` clean (both re-run for
safety per the coordinator's instruction; no suite/E2E rerun needed or performed for this round).

Three findings addressed, one refuted:

1. **(Important, fixed) The §9 Phase 4 kickoff had dropped one spec-§16 inherits bullet.**
   `docs/HANDOFF.md`'s inheritance list carried `StoredDocument` as the storage-pattern
   inheritance but not the separate render/layout-approach one spec §16 also names: "the
   traveler's per-load render as the precedent for shipper/BOL documents." Added as its own
   bullet, positioned next to the `linkGroupId` bullet (before cert-required columns), explicitly
   distinguishing it from the storage-pattern bullet so the two don't read as duplicates of each
   other.
2. **(Minor, fixed) Owner-decision count.** `docs/HANDOFF.md` said "§3 records nine owner
   decisions" — re-counted against the spec directly: items 1–10, ten decisions (a plain
   miscount on my part, not a stale reference). Fixed to "ten."
3. **(Minor, fixed) Stability wording.** Both `docs/HANDOFF.md` and
   `docs/2026-08-03-phase-3-demo.md` said the E2E suite was "run twice" for stability — my own
   report already correctly recorded three consecutive 10/10 runs (two during stabilization plus
   one final confirmation against the committed state), so the two docs were understating the
   verification actually performed rather than overstating it. Both now say "three."

**Refuted, not applied, per the coordinator's explicit instruction:** a reviewer finding claimed
"eleven new tables" should read "ten," apparently having missed `PartAttachment` from the count.
`PartAttachment` is a genuinely new Phase 3 table — parts had no attachment story before Task 11
built one service/component serving both part and order owners at once (commit `1b8384b feat:
attachments — one story, part and order owners`) — so the eleven-table count (`Order`,
`OrderLine`, `OrderContainer`, `OrderSerial`, `Load`, `OrderCharge`, `PartAttachment`,
`OrderAttachment`, `OrderDraft`, `SavedView`, `StoredDocument`) matches the design spec §2 exactly
and needed no change. Neither `docs/HANDOFF.md` nor the demo doc enumerates these eleven by name
in one place (both just say "eleven new tables," parenthetically naming a representative subset),
so there was nothing to touch either way.
