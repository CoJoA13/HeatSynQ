# Task 7 report — Order drafts (unaudited scratch) + saved board views

Branch: `phase-3-orders`. One commit:
- `fc00ccb` — `feat: order drafts (unaudited scratch) and saved board views`

Files touched:
- `erp/src/server/order-drafts.ts` (new, 66 lines) — `getDraft`, `putDraft`, `clearDraft`
- `erp/src/server/saved-views.ts` (new, 137 lines) — `listViews`, `createView`, `updateView`, `deleteView`
- `erp/tests/order-drafts.test.ts` (new, 85 lines, 9 tests)
- `erp/tests/saved-views.test.ts` (new, 163 lines, 14 tests)
- `erp/tests/permissions-sweep.test.ts` (+5 lines) — `EXCEPT` allowlist entry
- `erp/tests/partial-unique-sweep.test.ts` (+20/-1 lines) — `ALLOWED_CALLS` allowlist entry

No schema/migration changes — `OrderDraft`/`SavedView` tables already existed from the
`orders_and_loads` migration (Tasks 1–6). No routes, no UI — per the brief.

## 1. What was implemented

### `order-drafts.ts` — the documented unaudited exception

`getDraft(userId)` / `putDraft(userId, payload)` / `clearDraft(userId)`, all writing
`prisma.orderDraft` directly. The file header quotes the design spec's authorization verbatim
(§4, "Data model," the OrderDraft model) rather than paraphrasing it, and cites design spec §12.7
("Draft lifecycle") for the no-audit-rows assertion.

- `getDraft`: `findUnique({ where: { userId } })` — safe because `OrderDraft.userId` is a plain
  `@unique` (the model has no `deletedAt` at all, so it isn't in the soft-deletable-column danger
  zone the partial-unique sweep exists for). Returns `null` only when the user has no row at all;
  once a row exists it returns `{ payload, updatedAt }` forever (payload itself can be `null`
  after a clear).
- `putDraft`: measures `Buffer.byteLength(JSON.stringify(payload), "utf8")` against a 256 KB cap
  and throws `HttpError(400, "Draft payload exceeds the 256 KB limit")` **before** touching the
  database — nothing is written on the oversize path. Under the cap, `upsert`s on `userId`. A bare
  JS `null`/`undefined` payload is normalized to `Prisma.JsonNull` (Prisma throws on a literal
  `null` for a Json column — it's ambiguous between SQL NULL and the JSON value null — so this
  guard exists to keep a degenerate input a clean write rather than a raw Prisma error).
- `clearDraft`: `updateMany({ where: { userId }, data: { payload: Prisma.DbNull } })` — the exact
  statement `createOrder` already runs inline on save (`src/server/orders.ts:515`). `updateMany`,
  not `update`, so a user with no draft row yet clears silently (0 rows matched, no error) instead
  of 404ing.

### `saved-views.ts` — audited normally, own-rows-only, one default per user

`listViews(userId)` / `createView(userId, input)` / `updateView(userId, id, input)` /
`deleteView(userId, id)`. Every query is scoped by `userId`; `id`-based lookups (`updateView`,
`deleteView`) additionally filter `deletedAt: null`, so a wrong-owner id and a missing id produce
the identical `HttpError(404, "Saved view not found")` — structurally, not by convention.

- **Validation**: `name` — `.trim().min(1).max(80)`. `config` — `z.unknown()` (opaque, per the
  brief: the client owns its internal shape) plus a `.refine(v => v !== undefined)` presence
  check, so a missing `config` on create fails as a clean `ZodError` rather than surfacing later
  as an unlabeled Prisma "argument missing" error (`config` is a non-nullable `Json` column).
- **Duplicate name**: `createView` pre-checks via `findFirst({ where: { userId, name,
  deletedAt: null } })` before opening its transaction — the `reference.ts`/`process-step-codes.ts`
  house pattern — then `withDbErrors({ conflictField: "name" })` is the backstop for the create-
  create race. `updateView` relies on that same backstop alone for a rename collision (no separate
  pre-check), matching `updateReference`/`updateStepCode`'s precedent exactly.
- **Default normalizer** (`demoteOtherDefaults`): when `isDefault: true` is being written, every
  *other* live view of that user with `isDefault: true` is demoted first, in the same transaction,
  through `auditedUpdate` (so the demotion itself shows up in that view's own history rather than
  going stale there silently) — the `customer-addresses.ts` `demoteAllIn` pattern, without the
  address service's kind-partitioning (a user has one flat namespace of views) and without its
  full "always exactly one default, auto-repromote on delete" invariant — the brief's own test
  list names only "setting B default clears A," and the design doc gives no basis for inventing
  auto-first-default or repromote-on-delete behavior, so neither was added (owner's prime
  directive: don't assume features the spec didn't ask for).
- **`updateView`'s two-layer 404 guard**: a fast pre-check `findFirst` before the transaction,
  *and* an `updateMany({ where: { id, userId, deletedAt: null } })` count-check inside
  `auditedUpdate`'s `doIt` — the `updateAddress` precedent for the exact race it defends against
  (a concurrent delete landing between the pre-check and the write). The updated row is read back
  inside the same transaction (`findUniqueOrThrow({ where: { id } })`, safe post-guard) to build
  the returned `SavedViewRow`, since `updateMany` itself returns no row data.
- **`deleteView`**: `findFirst({ id, userId, deletedAt: null })` for ownership scoping (the
  generic `auditedSoftDelete` helper has no `userId` concept), then `auditedSoftDelete("savedView",
  id, undefined, tx)` — no reason required, per HANDOFF §5.17's classification (a per-user view
  name is not the kind of shared/cascading identifier that rule requires a reason for).
- **Isolation level**: plain `prisma.$transaction` — no `Serializable`. Per the brief: no
  registered-FK write, no revision claim here, so overriding isolation would be cargo-culting the
  order save's own reason onto a service that doesn't share it.

## 2. Decisions made where the brief was silent

**Two existing sweeps needed extending, not just two new files.** Both were genuine consequences
of implementing exactly what the brief asked for, not scope creep:

1. `permissions-sweep.test.ts`'s "no service mutates Prisma outside an audit helper" test flagged
   `order-drafts.ts` — correctly, by its own design (a file-level proxy: mutates + no `audited*`
   call anywhere in the file = offender). This is precisely what the brief's exception describes,
   so `order-drafts.ts` was added to the test's existing `EXCEPT` allowlist, alongside the already-
   present `sessions.ts` entry (a different, pre-existing documented non-audited mutation).

2. `partial-unique-sweep.test.ts`'s offender scan flagged `order-drafts.ts`'s `findUnique`/`upsert`
   on `userId` — a **false positive**: `partialUniqueColumns()` collects bare column names
   schema-wide, not scoped per model (a text sweep with no type information can't easily tie a
   call site back to which model it targets). `SavedView`'s own
   `@@unique([userId, name], where: ...)` contributes the bare name `"userId"` to that set, which
   then also (mis)matches `OrderDraft.userId` — a plain `@unique` on a model with no `deletedAt`
   at all, so it cannot have the soft-delete-revival bug this sweep exists to catch. Two ways to
   respond were considered and rejected: rewriting `putDraft` to avoid `upsert` (traded away real
   correctness — `upsert`'s atomicity is what keeps two browser tabs of the same user autosaving
   every ~2s from racing into a duplicate-key error or a lost write; a `findFirst` + branch
   reintroduces exactly that race), and loosening the sweep's detection regex to be model-aware
   (higher risk — the regex would need to recognize every receiver shape in the codebase,
   including non-literal ones like `delegate(kind, tx).findFirst(...)`, and a mistake there risks
   *silently* missing a real future offender reached through a receiver shape not accounted for).
   The change actually made — two exact call sites named in a narrow `ALLOWED_CALLS` set, fully
   documented inline — mirrors the file's own existing `ALLOWED` precedent for `User.username`/
   `Order.orderNumber` in the sibling test in the same file, touches no detection logic, and so
   carries no risk of hiding an unrelated future offender.

**`SavedViewRow` shape**: `{ id, name, config, isDefault, updatedAt }` — the brief specifies the
service signatures but not this type's fields. Chose the minimal set a client needs to render a
list, apply a view, and show which one is default; omitted `createdAt` (nothing in the brief or
design doc calls for surfacing it) and `userId` (redundant — the caller already knows whose views
these are, since they supplied that `userId`).

**List ordering**: `orderBy: { name: "asc" }`, matching `listAddresses`/`listContacts`'s existing
convention. Not specified by the brief; alphabetical is the simplest deterministic choice and
introduces no new business rule.

## 3. TDD evidence

**RED**: both test files written first, importing the not-yet-created service modules; ran them
before writing any implementation:

```
npx vitest run tests/order-drafts.test.ts tests/saved-views.test.ts
 FAIL  tests/order-drafts.test.ts — Cannot find module '@/server/order-drafts'
 FAIL  tests/saved-views.test.ts  — Cannot find module '@/server/saved-views'
 Test Files  2 failed (2)
      Tests  no tests
```
Genuine RED (missing module), not a typo in the test.

**GREEN**: implemented both services; all 22 tests passed on the first real run:
```
npx vitest run tests/order-drafts.test.ts tests/saved-views.test.ts
 ✓ tests/order-drafts.test.ts (9 tests) 336ms
 ✓ tests/saved-views.test.ts (13 tests) 491ms
 Test Files  2 passed (2)
      Tests  22 passed (22)
```

**Then two more rounds surfaced by the full suite, both fixed and reverified** (see §1 decision
log above for the reasoning):
- `permissions-sweep.test.ts` flagged `order-drafts.ts` → added to `EXCEPT` → resweep green.
- `partial-unique-sweep.test.ts` flagged the same file's `findUnique`/`upsert` on `userId` →
  added the two exact call sites to a new `ALLOWED_CALLS` set → resweep green.

**Extra verification beyond RED→GREEN** (the Task 6 precedent: don't just trust a passing test to
prove what it claims): added a 23rd test after the fact, forcing `auditedUpdate` to reject via
`vi.spyOn` (the exact `customer-children.test.ts` "rolls the soft delete back if the fused
normalization fails" technique) to prove the default normalizer's transaction genuinely rolls back
end-to-end — not just "the code happens to call `tx` everywhere" by inspection:
```
npx vitest run tests/saved-views.test.ts tests/order-drafts.test.ts
 ✓ tests/saved-views.test.ts (14 tests) 446ms
 ✓ tests/order-drafts.test.ts (9 tests) 308ms
 Test Files  2 passed (2)
      Tests  23 passed (23)
```
Passed first try — real evidence the normalizer shares the write's own transaction, not an
inference from reading the code.

## 4. Full gate results (final, on committed HEAD `fc00ccb`)

```
npm test              → Test Files 68 passed (68) / Tests 795 passed (795)   [772 baseline + 23]
npx tsc --noEmit       → clean, no output
npx eslint src tests   → clean, no output
npm run build          → succeeds, standalone build produced; route manifest confirms no new
                          /api/order-drafts or /api/saved-views routes were added
git status --porcelain → clean except pre-existing untracked .claude/ and .vscode/ (present at
                          session start, unrelated to this task)
```

Gates were run green after the initial 22-test commit-candidate state, again after the two sweep
fixes, again after the extra rollback test, and once more on the final committed HEAD.

## 5. Self-review

- **Every brief Step-1 test bullet covered, several by more than one test:**
  - Draft round-trip — covered (`putDraft`/`getDraft`), plus an upsert-keeps-one-row test.
  - Clear nulls payload but keeps the row — covered, with an explicit "row still exists,
    `payload` is `null`" assertion via raw `prisma.orderDraft.findUnique`, plus a no-op-when-no-
    row-exists case.
  - Oversize payload 400, naming the limit — covered: asserts `status: 400`, asserts the message
    matches `/256 ?KB/i`, and asserts nothing was written (`getDraft` still `null` after).
  - No audit rows from any draft call (§12.7) — covered directly (`auditLog.count()` stays 0
    across put/get/clear/put-again) **and** structurally (order-drafts.ts imports nothing from
    `./audit` — grepped to confirm; every "audit" occurrence in the file is inside the header
    comment's authorization quote, not a call).
  - Other users' drafts untouched — covered (`clearDraft` on one user leaves another's payload
    intact).
  - Views CRUD own-rows-only, two users same name OK — covered (create/list/update/delete each
    exercised; a dedicated "two different users use the exact same view name" test).
  - Default normalizer (setting B default clears A) — covered on both `createView` and
    `updateView`, plus a different-user-unaffected case, plus the transactional-rollback proof
    (§3).
  - Soft-deleted name reusable — covered (delete, recreate same name, new id, exactly one live
    row).
  - Audit entries exist for create/update/delete — covered with **content** assertions (before/
    after field values), not just action-name/entry-count checks, per the global constraint
    ("Assert audit content (diffs), not just that entries exist").
- **Draft writes provably unaudited** — both the direct count assertion and the structural import
  check (§ above).
- **Views audited with content** — the audit test asserts `createEntry.after` matches `{name,
  userId}`, `updateEntry.before`/`.after` show the actual name change, `deleteEntry.before` shows
  the pre-delete state.
- **Cross-user isolation, both services** — drafts: isolated-per-user test. Views: the "same 404
  whether wrong-owner or missing" test (both `updateView` and `deleteView`, both id shapes), the
  same-name-different-users test, and the different-user's-default-untouched test.
- **Default normalizer transactional** — proven, not just asserted: the `vi.spyOn` rollback test
  (§3) forces the demotion's own `auditedUpdate` call to fail mid-transaction and confirms neither
  the new view nor the demotion survived.
- **No scope creep** — `git show --stat HEAD` is exactly the 6 files listed at the top: two new
  services, two new test files, two narrowly-scoped and fully-documented sweep-allowlist edits.
  No routes, no UI, no schema/migration changes. `npm run build`'s emitted route list contains no
  `/api/order-drafts` or `/api/saved-views` entries.

## 6. Concerns to carry forward

1. **Two pre-existing sweep tests now carry Task-7-specific allowlist entries.** Both are narrow,
   commented, and reasoned through in §1/§3 above, but a whole-branch review should specifically
   re-examine `tests/partial-unique-sweep.test.ts`'s `ALLOWED_CALLS` addition — it's a *string-
   matched* exemption (`"<file>: .<method>({ where: { <col> … } })"`), not a model-aware fix, so
   it would also (harmlessly, given TypeScript already rejects the shape) exempt a hypothetical
   future `prisma.savedView.findUnique({ where: { userId } })` written by mistake inside
   `order-drafts.ts` specifically. Flagged rather than silently accepted.
2. **`partialUniqueColumns()`'s lack of per-model scoping is a latent sweep imprecision, not
   something this task fixed at the root.** It happened to surface now because `SavedView` and
   `OrderDraft` share a column name; the same collision could recur for any future model pair.
   Worth a dedicated pass (model-aware column matching) if it recurs a second time — not attempted
   here because the fix's blast radius (the regex that decides what the *entire* codebase's
   partial-unique sweep catches) is far larger than this task's two files, and the narrow
   allowlist fully resolves the immediate false positive without that risk.
3. **`updateView`'s duplicate-name handling relies on the DB constraint + `translatePrisma` alone
   (no pre-check `findFirst`), matching `updateReference`/`updateStepCode`'s existing precedent.**
   Untested directly in `saved-views.test.ts` (no "rename to a name already used by another live
   view" case) — the brief's test list didn't call for it, and the mechanism is identical to
   precedent already covered elsewhere in the suite, but noting the gap for completeness.
4. **`SavedViewRow` omits `createdAt`.** If a future UI task wants to show "created N days ago"
   alongside "updated," that's a one-line addition to `toRow`/the type — not built preemptively
   since nothing in this task or the design doc's UI section calls for it.

## 7. Environment notes

Node 26.5.1 via `nvm use 26` (system default was 22.23.1 — switched explicitly per the global
constraints). Postgres 18 container already running and healthy at session start. Both databases
were already at migration `20260803044035_part_load_cap_checks` (up to date) — no new migration
needed; `OrderDraft`/`SavedView` tables came from Tasks 1–6's `orders_and_loads` migration.
Baseline before this task: **772 passing (66 files)**. After: **795 passing (68 files)** —
772 + 23 (9 draft + 14 saved-view), 0 removed, 0 skipped.
