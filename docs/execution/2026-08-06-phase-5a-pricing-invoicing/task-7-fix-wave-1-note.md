# Task 7 — Fix wave 1 (controller-authored note)

**Why this file exists:** the fix-wave implementer completed the code and the gates but never
appended its `## Fix wave 1` section to `task-7-report.md` — it looped waiting on the E2E run
instead of reporting. The controller verified the work directly, then asked the implementer for its
evidence in text. Both are recorded below, labelled by source.

Commit: `daf1cfd` — "fix(admin): serialize surcharge saves and split the create/delete gates"

## Gates — run by the controller, not taken on report

- `npm test` — **1483 passed, 102 files** (up from 1476/100)
- `npx tsc --noEmit` — exit 0
- `npx eslint src tests` — exit 0
- `npm run build` — clean
- `npm run test:e2e` — **15/15 flows PASS**

## Fix 1 (save serialization) — REPRODUCED BEFORE THE FIX, both cases

**Controller note on this section:** an earlier draft of this file recorded Fix 1 as "reasoned, not
empirically demonstrated," because the implementer had not written its evidence down at the time.
That was wrong, and is corrected here. The evidence below came back on request and is specific
enough to check — real audit timestamps, real response codes. **Absence of a report is not absence
of verification; ask before concluding.**

Method (implementer): temporarily restored the pre-fix page (`git show
689d698:erp/src/app/admin/surcharges/page.tsx`), drove real DOM events against the live dev server
(native value-setter plus `input`/`focusin`/`focusout`, real `.click()` — the Browser pane cannot
composite frames here), read state back via `fetch()` and the audit API, then restored the fixed
page and repeated the identical sequence.

**(a) Type a rate, then click Active.** Starting state `rate: 0.02, active: true`.

*Before the fix* — two `update` audit entries 6ms apart:
- PUT #1 `11:58:13.026Z`: before `{rate:0.02, active:true}` → after `{rate:0.04, active:true}`
- PUT #2 `11:58:13.032Z`: before `{rate:0.02, active:true}` → after `{rate:0.02, active:false}`
- Final GET: `rate: 0.02, active: false` — **the typed "4" was silently reverted.** PUT #2 composed
  its payload from a `rowsRef` that never saw the typed value, because it lives only in
  `textDrafts`.

*After the fix* — same sequence, fresh row:
- PUT #1 `12:00:31.036Z`: before `{rate:0.02, active:true}` → after `{rate:0.04, active:true}`
- PUT #2 `12:00:31.205Z`: before `{rate:**0.04**, active:true}` → after `{rate:0.04, active:false}`
- Final GET: `rate: 0.04, active: false` — **both edits landed.** PUT #2's *before* snapshot is the
  tell: it read the already-updated rate because it only ran after PUT #1's `load()` completed.

**(b) Check two step codes in succession** — the brief's own Step 4 scenario. Scope EXCLUDE, two
step codes, starting `stepCodeIds: []`.

*Before the fix:* two PUTs to `.../step-codes` — one `200`, one **`409 Conflict`**. Final GET held
TST1 only; the second click never took effect. Worth noting the mechanism was not merely
last-writer-wins here: the two concurrent Serializable transactions collided outright, so the
overlap surfaced as a serialization failure rather than a silent overwrite.

*After the fix:* both PUTs returned `200` (the queue means the second transaction starts only after
the first commits). Final GET held both codes.

Fixtures (`RaceTest`, `RaceTestFixed`, step codes TST1/TST2) were soft-deleted through the real
DELETE routes afterward — `GET /api/admin/surcharges?includeInactive=1` returned `[]`. Soft, per the
house rule; no hard deletes outside tests.

## Fix 2 (owner ruling — split gates) — VERIFIED BY THE CONTROLLER, and the 403s discriminate

Checked by reading the tree directly, independently of the implementer's claim:

- `POST /api/admin/surcharges` → `mustCan(requireUser(), "admin", "create")`; `GET` → `"view"`
- `PUT /api/admin/surcharges/[id]` → `"edit"`; `DELETE` → `"delete"`
- `tests/surcharges.test.ts:383-387` — subject holds `["admin.view","admin.edit"]`, POST refused
  403. A subject lacking *all* admin grants would prove nothing about which gate fired; this one
  isolates `admin.create`.
- `tests/surcharges.test.ts:429-432` — same shape for DELETE, with a comment stating the intent;
  `:443-446` confirms `admin.delete` then succeeds **and** that the delete is soft (`deletedAt` is
  a `Date`).

## Fix 5 (`buildBody` extracted) — VERIFIED

`src/lib/surcharge-body.ts` with `tests/surcharge-body.test.ts` beside it; its header records why it
left the component (a client component cannot import `src/server/**`, so the whole-row guarantee
could not otherwise be asserted by any test).

## Minors 3, 4, 6, 7

Present in the diff — kind-override cleared on selection change; `position` routed through
`textDrafts`; the export route's 403 case; `blocked` cleared in `save`'s catch, and the money-string
rendering. Verified by reading the diff; no independent test evidence beyond the green suite.

## Standing gap — nothing fences this page's write path

Both loss cases are now fixed and were demonstrated, but **no automated check would catch a
regression**: `page.tsx` has no vitest seam, and no E2E flow drives a surcharge save. The
demonstration above was manual and is not repeatable in CI.

**Recommended follow-up, filed for whole-branch triage rather than folded in** (it is new coverage,
not a fix): an E2E case firing two overlapping surcharge saves and asserting both survive. That
would be the only automated protection this write path has.
