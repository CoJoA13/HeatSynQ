# PR #104 — Codex review fixes (three correctness findings)

**Date:** 2026-08-14 · **Branch:** `phase-7-template-designer`
**Source:** Codex review of PR #104 (Phase 7 template designer). Three findings — one P1
concurrency/data-integrity, two P2 UI (§5.12 remount, §5.13 stale-response). All fixed on-branch
with tests.

**Commits**

| # | Finding | Commit |
|---|---------|--------|
| 1 | assignTemplate not Serializable-paired with deleteCustomer | `f70d1c8` |
| 2 | template editor not keyed by route id (§5.12) | `6419dcb` |
| 3 | template-detail fetch not stale-gated (§5.13) | `2f96191` |
| — | this report | (committed with the report) |

---

## Finding 1 (P1 — concurrency / data-integrity)

**The defect.** `assignTemplate` (`erp/src/server/template-assignments.ts`) ran at the service
default (Read Committed) and, after claiming the TEMPLATE row, checked customer liveness with a
plain `findFirst` (`{ id, deletedAt: null }`). Nothing locked the customer row. Concurrent with
`deleteCustomer` (which soft-deletes the customer and cascades its assignments), the two calls each
pass their own pre-check before either commits: the assign reads the customer LIVE, the delete finds
no live assignment to cascade, and both commit — leaving a **LIVE `CustomerTemplateAssignment` on a
soft-deleted customer**. It is invisible on the customer page (that page only lists live customers)
and blocks that template's §5.14 deletion forever (the blocker scan counts live assignments), with
no later request able to reach it.

**The fix (mirror the createPart↔deleteCustomer precedent).** Run the `assignTemplate` transaction
Serializable (`{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }`) with the customer
read kept **inside** it. That read is the SSI-conflicting half:

- `assignTemplate` reads the customer row (pre-delete version) → `deleteCustomer` writes it
  (soft delete): a read-write antidependency out of the assign.
- `deleteCustomer`'s `findMany` over this customer's assignments (a predicate read) → the assign's
  `create` inserts a matching row: a read-write antidependency out of the delete.

Two antidependencies form the dangerous cycle Postgres SSI aborts (P2034 → 409 "retry" via
`withDbErrors`). This is exactly `createPart` (`erp/src/server/parts.ts:172-177`) reading the
customer live inside its Serializable transaction, one writer over; `deleteCustomer`
(`erp/src/server/customers.ts:328+`, `403`) is already Serializable and its cascade
reads/soft-deletes the customer's assignments (Task 5). `Prisma` was already imported.

**`clearAssignment` — considered, left unchanged.** A clear-vs-`deleteCustomer` race has both sides
soft-deleting assignment rows; every interleaving lands on the same end state (no live row). Benign,
so no pairing is needed. Noted in the service header comment.

**Side effect on the two existing template-row race tests (404 → 409).** Making `assignTemplate`
Serializable changed the *error surface* (not the invariant) of the assign-vs-delete-TEMPLATE and
replace-vs-clear races. When the assign loses the row-claim race to a template soft-delete (or an
assignment clear) that commits **after** the assign's snapshot, the claimed/updated row was modified
post-snapshot, so the `FOR UPDATE` re-check / UPDATE raises a serialization abort (P2034 → **409**)
instead of the old Read-Committed **404**/P2025. The safety invariant is identical — no orphan row is
written, the dead row's `templateId` is never rewritten — and the 404 arrives on the caller's retry.
This mirrors `createPart`'s accepted tradeoff. The two tests and their comments, plus the service
header/inline comments, were updated to state the Serializable reality.

### RED-verify (the house rule — a concurrency test that passes is not evidence)

Added a dangerous-direction test to `erp/tests/template-assignments.test.ts` (the `concurrency`
describe): a Read-Committed GATE holds the TEMPLATE row `FOR UPDATE`, so the REAL `assignTemplate`
fixes its Serializable snapshot at `claimTemplate` and blocks there (before its customer read); the
REAL `deleteCustomer` then runs to completion and commits; the gate releases; the assign proceeds on
its stale snapshot (customer still reads LIVE, so the liveness 404 does not fire) and only SSI stops
the write at commit. Asserts: the assign rejects with a 409, the customer is soft-deleted, and **no
live assignment survives** on it.

**GREEN (fix in place):**

```
$ npx vitest run tests/template-assignments.test.ts -t "DANGEROUS direction"
 ✓ tests/template-assignments.test.ts (41 tests | 40 skipped) 504ms
   ✓ concurrency (RED-verified — see task report) > DANGEROUS direction: an assign whose
     snapshot predates a committed deleteCustomer is aborted — no LIVE assignment orphaned
     on the soft-deleted customer  503ms
 Test Files  1 passed (1)
      Tests  1 passed | 40 skipped (41)
```

**RED (competitor pinned to Read Committed — dropped `deleteCustomer`'s `isolationLevel`):**

```
$ npx vitest run tests/template-assignments.test.ts -t "DANGEROUS direction"
 × concurrency (RED-verified — see task report) > DANGEROUS direction: an assign whose snapshot
   predates a committed deleteCustomer is aborted — no LIVE assignment orphaned on the
   soft-deleted customer 397ms
   → expected 'resolved' not to be 'resolved' // Object.is equality

 FAIL  tests/template-assignments.test.ts:600
    598|     const outcome = await assignProm;
    599|     expect(outcome).not.toBe("resolved"); // it must NOT have written an assignment ...
       |                         ^
 Test Files  1 failed (1)
      Tests  1 failed | 40 skipped (41)
```

With the competitor at Read Committed the soft-delete leaves SSI's view, nothing aborts the
still-Serializable assign, and it **commits the orphan** (`outcome === "resolved"`) — the exact
data-integrity breach the fix closes. `deleteCustomer` was restored to Serializable immediately
after (its git diff is net-zero; verified with `git diff --stat`).

---

## Finding 2 (P2 — §5.12 remount)

**The defect.** `erp/src/app/admin/templates/[id]/edit/page.tsx` rendered
`<TemplateEditor templateId={id} />` **without a `key`**. Navigating `/edit/[A]` → `/edit/[B]`
reuses the same component instance, so B inherits A's stale `config` / `dirty` / `conflict` state and
A's `updatedAt` save token — a Save after navigation would PATCH B's draft with A's token and config.

**The fix.** `<TemplateEditor key={id} templateId={id} />` — the house §5.12 idiom (the same
`key={id}` every other detail page uses, e.g. `QuoteDetail`). Verified that **all** editor state
(`detail`, `config`, `updatedAt`, `logoMimeType`, `dirty`, `saving`, `savedTick`, `error`,
`conflict`, `stashed`) lives inside `TemplateEditor` via `useState` and none is hoisted into the
page wrapper, so the key remount is the complete fix.

---

## Finding 3 (P2 — §5.13 stale-response)

**The defect.** In `erp/src/app/admin/templates/page.tsx`, the template-detail fetch triggered by
selection was not stale-gated. Selecting A then B before A completes let A's response overwrite B
while B stayed highlighted; because the lifecycle / rename / delete handlers act on `detail.id`, a
subsequent publish / rename / **DELETE** could hit the wrong template.

**The fix.** Applied the QuoteDetail §5.13 stale-gate idiom (`let stale = false; …; return () => {
stale = true }`) to the selection effect: only the latest selection's response is adopted; an
abandoned effect instance's response **and** its error are ignored; success never clears the error
banner (§5.13 — a reload must not erase a live failure). The effect now inlines the fetch (keyed on
`[selected]`) so the gate wraps it; the post-mutation `refresh` path keeps using `loadDetail`, which
always targets the currently-open `detail.id` and so is not part of the selection race.

---

## Gates — all five watched (green)

| Gate | Command | Result |
|------|---------|--------|
| Unit/integration | `npm test` | **2744 passed** (149 files) — +1 new dangerous-direction test |
| Types | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint src tests` | exit 0 |
| Build | `npm run build` | exit 0 |
| E2E | `timeout --signal=KILL 600 npm run test:e2e` | **20/20 flows passed** (sentinel `e2e-prfix.done` → `EXIT=0`) |

E2E ran detached from the start against the DEV database; the sentinel file was polled (never
`pgrep`). All 20 flows passed, including `close-month-end` (no Phase-5C flake this run) and
`templates-admin` (which exercises the two UI screens touched by findings 2 & 3). The harness
cleaned up its own dev-DB fixtures ("cleanup ok"); the sentinel file was removed after.

## Files changed

- `erp/src/server/template-assignments.ts` — Serializable + in-tx customer read (Finding 1);
  header/inline comments updated for the Serializable reality.
- `erp/tests/template-assignments.test.ts` — new RED-verified dangerous-direction test; two
  existing template-row race tests updated 404 → 409 with comments.
- `erp/src/app/admin/templates/[id]/edit/page.tsx` — `key={id}` (Finding 2).
- `erp/src/app/admin/templates/page.tsx` — stale-gate the selection fetch (Finding 3).
