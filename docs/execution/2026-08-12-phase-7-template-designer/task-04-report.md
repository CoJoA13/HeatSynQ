# Task 4 report — The template service: lifecycle, publish, delete

**Implementer:** fresh subagent, 2026-08-13
**Branch:** `phase-7-template-designer`
**Commits:** `6924a67` (the three pre-steps), `bf92e6d` (the service + image-sniff extraction),
`4c8f0e0` (the routes), `ccefcf9` (claimTemplate exported for Task 5)

## Pre-steps (carried from Task 3's review)

1. **jsonb_set path pins** — `template-seed.test.ts` gains one test pinning all five target
   paths (`'{textBlocks,cert_statement}'` ×1, `shipper_liability_text` ×2, the two quote keys ×1
   each) AND `occurrences("jsonb_set(") === 5`, so no copy can target an unpinned path.
2. **The seed-id helpers exported once** — `templateId()` / `templateVersionId()` now live in
   `tests/helpers/db.ts` (used by `truncateAll()` itself); the drift guard and this task's two
   suites import them. The drift guard's local copy is deleted.
3. **(Optional carry) the `"1-30"` ban scoped** — now runs against the raw STATEMENT literal
   (`rawConfigLiteral`, which `configLiteral` reuses), not the whole SQL file.

## Service shape (`erp/src/server/templates.ts`)

- **Every mutation:** `withDbErrors` → `$transaction` → `audited*` on `tx`, claiming the template
  row FIRST via `claimTemplate` — the `claimQuote`/`lockCurrentRevision` shape (raw
  `SELECT … FOR UPDATE`, full row read back through the client once the lock is held; missing and
  soft-deleted both 404). All transactions run at DEFAULT (Read Committed) isolation — the claim
  is the guard, nothing relies on SSI. `claimTemplate` is **exported** (`ccefcf9`) so Task 5's
  assignment writer claims through the same path (one claim shape, per the plan's
  assign-vs-delete constraint).
- **`createTemplate`** opens the v1 DRAFT in the same transaction, config from `DEFAULT_CONFIG`;
  live-name uniqueness by `findFirst` pre-check + P2002 backstop (`conflictField: "name"`), never
  `findUnique` on the partial column.
- **`openDraft`**: refuse-while-draft-exists (named 400) → `versionNumber` = max+1 under the
  claim (discarded numbers never reused; gaps deliberate) → config AND logo copied from the
  explicit `fromVersion` (must be a PUBLISHED version of THIS template — DRAFT/DISCARDED/foreign
  all get the named 400), else the current published version, else `DEFAULT_CONFIG`. The copy is
  **verbatim** — the §5.3 backfill happens at parse time, never by rewriting stored history.
- **`editDraft`**: the `updatedAt` precondition is checked BEFORE validation (a stale editor
  deserves the truthful 409, not a config nitpick); mismatch → named 409 "The draft changed since
  you loaded it…". `validateConfig`'s **backfilled result is what's stored**;
  `TemplateConfigError` maps to a 400 carrying the offending element's own lock/budget message;
  shape problems stay `ZodError` for `handle`. An unchanged save (canonical-JSON compare — jsonb
  normalizes key order) is skipped: no write, no before===after audit junk.
- **`discardDraft`**: status flip to DISCARDED via `auditedUpdate`. No delete path exists.
- **`publishDraft`**: under the claim — status flip + `publishedAt`/`publishedById`
  (`currentActor().id`) + `publishedVersionId` pointer move, one transaction. The double-publish
  loser re-reads under the claim, finds no draft, gets the named 400, and never re-stamps the
  winner.
- **`setDefault`**: refuses `publishedVersionId === null` (§4.1's never-published invariant);
  already-default is a no-op (no junk audit); demote-then-promote, each side audited
  (the address-default precedent). **Claims every live template of the docType in ONE ordered
  statement** — see deviations.
- **`deleteTemplate`**: reason trimmed/required in the service (§5.17); refused while
  `isDefault`; §5.14-blocked via `findBlockers("documentTemplate", …, tx)` under the claim,
  **naming** the customers ("AC1 · Acme", capped at 5 + "and N more"); `auditedSoftDelete` with
  the reason; versions untouched. Default isolation deliberately — Task 5's assignment writer
  claims the same row, so assign-vs-delete serializes on the claim (its race test lands there).
- **Logo**: MIME allowlist → 512KB cap → magic-byte sniff, all before the transaction (the
  `setSignature` shape); DRAFT-only (named 400s); audited with a byte-free snapshot
  (`SNAPSHOT_SELECT` from Task 3). The sniff was **extracted to `src/server/image-sniff.ts`**
  (dependency-free leaf) and `users.ts` rewired onto it — one copy of #49's magic numbers.
- **Reads**: `listTemplates(docType?)` (default flag, published version number, draft presence,
  **live**-filtered assignment `_count`), `getTemplate` (draft WITH config; history WITHOUT
  config bodies — separate selects, so old configs never even leave Postgres),
  `getTemplateVersion` (the ONE config-bearing version read, verbatim). Every version select
  excludes `logoImage`; `logoMimeType` stands proxy for `hasLogo`.

**Routes** (all thin — gate first line, `.strict()` zod, delegate): `api/templates`
(GET view / POST create), `[id]` (GET view / PATCH edit / DELETE delete + `reasonFromBody`),
`[id]/draft` (POST open with optional `fromVersion` / PATCH edit with `z.coerce.date()`
updatedAt / DELETE discard — all `templates.edit`), `[id]/publish` + `[id]/default`
(`templates.edit` **+ `mustDo("edit_templates")`**), `[id]/logo` (POST `parseUploadFile` /
DELETE), `[id]/blockers/export` (GET view — the surcharge export shape verbatim),
`[id]/versions/[versionNumber]` (GET view). Preview and assignments deliberately absent
(Tasks 19/5).

## RED evidence

Both suites written first; both failed at module resolution before implementation:

```
 FAIL  tests/templates.test.ts [ tests/templates.test.ts ]
Error: Cannot find module '@/server/templates' imported from '…/tests/templates.test.ts'.
 FAIL  tests/template-routes.test.ts [ tests/template-routes.test.ts ]
Error: Cannot find module '@/app/api/templates/route' imported from '…'
```

### Concurrency guards — RED with the claim removed, competitor pinned to Read Committed

The competitors are the REAL public service calls, whose transactions already run at Read
Committed (no isolation level is ever passed) — SSI is structurally off the table. Each holder is
hand-scripted to take precisely the template-row `FOR UPDATE` claim and perform its effect
uncommitted. Guard removal = `claimTemplate`'s `FOR UPDATE` replaced with a plain `findFirst`:

```
 × (a) two concurrent openDraft → exactly one DRAFT and the loser's refusal is the NAMED 400
   AssertionError: expected Error: A template with that value already… to match object
   { status: 400, message: StringMatching /already has an open draft/ }
 × (b) concurrent publishDraft × 2 → one wins, one named 400, the winner's stamp survives
   AssertionError: promise resolved "{ …(2) }" instead of rejecting
 × (c) publish-vs-openDraft → the new draft copies the JUST-published version, never a stale one
   AssertionError: expected 'settled' to be Symbol(timed out)
```

Read: (a) the loser degrades to a P2002 constraint surprise instead of the named refusal (and
with a discarded-number history it would have allocated a torn duplicate); (b) **both publishes
commit** — the loser overwrites the winner's `publishedAt`/`publishedById` (the test stamps the
holder with a different user id precisely to catch this); (c) the competitor never parks — it
acts on the pre-publish state instead of waking to the just-published version. Claim restored →
45/45 green. ((d) also failed in that run, but as collateral — (c)'s expected-block assertion
failing meant its holder was never released, and the NEXT test's `truncateAll` hook timed out
behind the stranded lock. (d)'s own guard got its own RED, below.)

### (d) publish atomicity for readers — RED with the transaction split

Guard removal = `publishDraft` re-shaped to commit the pointer move in its OWN transaction, 50ms
before the status flip (each half still claiming/auditing normally):

```
 × (d) publish atomicity for readers: no reader ever observes the pointer at a non-PUBLISHED row
   AssertionError: expected true to be false   // observations.some(Boolean)
```

The committed test also carries a deterministic non-vacuity step: it hand-writes the torn state
(pointer at the still-DRAFT v2) in an autocommit write and proves the polling probe SEES it,
before asserting the real publish never shows it. Restored → green.

### The updatedAt 409 and the rest

Feature behavior (the 409, the lock-refusal mapping, discard-as-flip, blocker naming, the sniff,
byte-free audits, config-free history) all landed test-first inside the same RED file; the
module-level RED above is their failing run. The grep-level immutability test
(`documentTemplateVersion.update` count === `where: { id: draft.id }`-keyed count; no
`updateMany`/`delete` on versions) was verified non-vacuous against the implementation.

## Gate results (watched to completion, from the runs' own output, on final HEAD `ccefcf9`)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2298/2298, 134 files** (baseline 2240/132 — +58: 45 templates + 12 template-routes + 1 seed-path pin) | 250.4s |
| `npx tsc --noEmit` | clean | 1.8s |
| `npx eslint src tests` | clean | 10.0s |
| `npm run build` | exit 0; all 8 template routes in the manifest | 17.0s |
| E2E | not run — routes only, no UI, no existing Playwright flow touches them (per brief) | — |

(A first watched pass of the same four gates ran green at `4c8f0e0` — 2298/2298 in 230.3s /
1.9s / 9.2s / 15.7s; the table above is the re-run on final HEAD after `ccefcf9`'s
export-keyword-and-comment change, per the watched-gate rule.)

## Deviations from the brief

1. **`setDefault` claims the whole docType, not just the target row.** The brief says "under the
   claim"; a single-row claim cannot serialize two concurrent set-defaults of *different*
   templates in one type — both demote the old default, both promote themselves, and the type
   ends with two defaults, breaking §4.1's "exactly one live default per docType, always". The
   fix is the house multi-row rule (`claimOrdersInOrder`): one
   `SELECT … WHERE "docType" = … ORDER BY "id" FOR UPDATE` statement over the type's live rows
   (sets stay tiny — a handful of templates per type). Single-row claimers can't deadlock with it
   (they hold one lock and never take a second template lock).
2. **One route beyond the brief's list:** `GET api/templates/[id]/versions/[versionNumber]`
   (gated `templates.view`). The brief's own reads bullet requires "a version-detail read returns
   one config" and the history list is config-free by design, so the config has to be reachable
   somewhere; Task 16's "open draft from version N" UI will need it.
3. **Blocker naming capped at 5 (+ "and N more")** in the delete refusal — an unbounded customer
   list in an error message; the Excel export carries the complete set.
4. **`editDraft` skips unchanged saves** (canonical-JSON compare) — not asked for, but the
   part-process-steps no-junk-audit precedent applies directly to an editor that autosaves.
5. **The sniff extraction landed as a new leaf** (`src/server/image-sniff.ts`) rather than an
   export from `users.ts` — templates importing the users service for a byte check would be a
   dependency in the wrong direction; the leaf shape is the `errors.ts`/`order-locks.ts`
   precedent. `users.ts` behavior is unchanged (its suite re-run green).

## Notes for Task 5 (assignment + resolution)

- **Claim through `claimTemplate` (exported)** before writing any assignment — that shared claim
  is what closes assign-vs-delete; the race test (delete-vs-assign, RED-verified) is yours.
- The never-published refusal for assignment mirrors `setDefault`'s: check
  `template.publishedVersionId !== null` on the row `claimTemplate` returns.
- `deleteTemplate` reads blockers with `findBlockers("documentTemplate", id, tx)` — your writer
  creating a live assignment under the claim makes that read race-safe at default isolation; do
  not add Serializable "for safety" (the claim is the guard, CLAUDE.md).
- `listTemplates` already returns live `assignmentCount` (filtered `_count`); the customer-page
  names read (`api/templates/names`, `requireUser`-only per §5.15) is yours, as is
  `deleteCustomer`'s assignment cascade.
- `resolveTemplateForPrint` should skip assignments whose template is soft-deleted
  (belt-and-braces per the plan) — note `deleteTemplate` refuses only on LIVE assignments, so a
  cleared-then-deleted template can still be named by a *soft-deleted* assignment row; your
  resolution must filter both `deletedAt`s.
- Seeded fixtures: `templateId()`/`templateVersionId()` from `tests/helpers/db.ts`; a Standard
  template's first service-opened draft is v2.
