# Task 5 report — Assignment + print-time resolution

**Implementer:** fresh subagent, 2026-08-13
**Branch:** `phase-7-template-designer`
**Commit:** `a9c4fb1` (service + cascade + routes + tests, one coherent unit — the suite spans both
layers, so a split commit would not stand alone)

## What landed

**`erp/src/server/template-assignments.ts`** — the assignment service:

- **`assignTemplate(customerId, docType, templateId)`** — claims the template row FIRST through
  the exported `claimTemplate` (templates.ts — one claim path, per the plan's assign-vs-delete
  constraint; missing/soft-deleted 404 inside the claim), then in order: the never-published
  named 400 (the `setDefault` mirror — `publishedVersionId === null`), the docType-mismatch
  named 400 (names both types), the live-customer 404. Upsert semantics on the partial-unique
  pair by `findFirst` + create/update (never `findUnique`/`upsert` — the house rule): a live
  assignment is REPLACED via `auditedUpdate` (before→after template ids in the snapshots), else
  `auditedCreate`. Two same-pair assigns naming DIFFERENT templates claim different rows and
  don't serialize on them — the partial-unique index is the documented P2002 backstop
  (`withDbErrors`, `conflictField: "document type"`).
- **`clearAssignment(customerId, docType)`** — `findFirst` live → 404 if none →
  `auditedSoftDelete` with `undefined` reason (§5.17 classification, spec §7 — a pure
  preference; commented in the code). No template claim: clearing creates no reference, so it
  participates in no §5.14 race.
- **`listAssignments(customerId)`** — live rows with template names, ordered by docType (Task 20
  consumes).
- **`listTemplateNames()`** — live templates' `{id, name, docType}` and nothing else, the §5.15
  names read's projection.
- **`resolveTemplateForPrint(tx, docType, customerId)`** — on the CALLER's tx, opens none of its
  own. Walks `parentId` toward the root, self-bounded on a visited-id set (stop on repeat or
  null — `assertNoCycle` guards writes; the read must terminate on corrupt data regardless); at
  each hop takes the live assignment for the pair **whose template is itself live** (BOTH
  `deletedAt`s filtered — Task 4's binding note: `deleteTemplate` refuses only on LIVE
  assignments, so a soft-deleted assignment row can still name a dead template); first hit wins,
  else the docType's live default. Returns `{ templateId, versionId, config, logoImage,
  logoMimeType }` where config is the **backfilled** `validateConfig` parse of the published
  version's stored JSON. **Never null** — a missing default or a null published pointer throws a
  plain `Error` (a broken seed/§4.1 invariant, a bug for `handle` to 500 on, not an `HttpError`);
  the test pins both the throw and the not-`HttpError` half.

**`erp/src/server/customers.ts`** — `deleteCustomer` cascade: `customerTemplateAssignment` joins
the addresses/contacts `Promise.all` + `auditedSoftDelete` loop verbatim ("parent customer
deleted" per row), commented with the spec §4.1 pure-preference rationale.

**Routes:**

- `api/customers/[id]/template-assignments/route.ts` — GET (`customers.view`), PUT (assign;
  `customers.edit` + `mustDo("edit_templates")` — the change_prices pattern, commented),
  DELETE (clear; same gates; `docType` from the query string, absent → zod 400). `.strict()`
  zod; thin.
- `api/templates/names/route.ts` — **`requireUser()` ONLY** with the §5.15 reasoning commented at
  the gate line (the customers.edit-without-templates.view silently-empty-dropdown case), the
  picklists precedent followed exactly: the call bound to a variable (`const user =
  requireUser(); void user;`) so the permission sweep's `= requireUser()` shape matches — the
  sweep was **not** touched.

## RED evidence

Suite written first; failed at module resolution before any implementation existed:

```
 FAIL  tests/template-assignments.test.ts [ tests/template-assignments.test.ts ]
Error: Cannot find module '@/server/template-assignments' imported from '…/tests/template-assignments.test.ts'.
 Test Files  1 failed (1)
      Tests  no tests
```

### The delete-vs-assign race — RED with the claim removed, competitors pinned to Read Committed

The competitors are the REAL public service calls (`assignTemplate`, `deleteTemplate`), whose
transactions run at default Read Committed — no isolation is ever passed, so SSI is structurally
off the table. Each holder hand-scripts the rival's exact effect under precisely the
template-row `FOR UPDATE` claim, held uncommitted. Guard removal = `claimTemplate`'s
`$queryRaw … FOR UPDATE` line deleted (the assign path claims through that shared function —
"remove the claim from the assign path" guts it at the one claim site both routes through):

```
 × assign-after-delete: parked on the claim, the assign wakes to the committed delete → 404, no row
   AssertionError: promise resolved "{ …(7) }" instead of rejecting
   + Received
   + {
   +   "customerId": "cmsr3ztv10001af278552u9gs",
   +   "deletedAt": null,
   +   "docType": "TRAVELER",
   +   "templateId": "cmsr3ztva0002af27xcs2h8rw",   ← the template the holder deleted
   +   ... }
 × delete-after-assign: parked on the claim, the delete wakes to the committed assignment → §5.14 blocked-and-named
   AssertionError: promise resolved "undefined" instead of rejecting
```

Read: **assign-after-delete commits an orphan** — the unclaimed assign's Read Committed reads
can't see the holder's uncommitted `deletedAt`, so a LIVE assignment row (visible in the diff)
lands pointing at a template the commit order says is deleted — exactly the state no screen can
show and no §5.14 guard can ever refuse retroactively. **delete-after-assign resolves
`undefined`** — the unparked delete's `findBlockers` reads an empty set and the template
soft-deletes under the just-committed assignment; the §5.14 refusal never fires. Claim restored
(`git diff` on templates.ts empty against HEAD — byte-identical) → 32/32 green: the winner's
state is what the loser sees (assign-after-delete → the claim's own 404, zero rows ever written;
delete-after-assign → the named 400 `/assigned to 1 customer.*AC1/`, template alive, assignment
live).

One honest note on the transcript: in the guard-removed run the `provesBlocked` pre-assertion
happened to pass (the unblocked competitor settled just past its 200ms window on transaction
startup latency), so the failures surfaced at the outcome discriminators rather than the
parked-check. The discriminators are the load-bearing assertions either way — both went red in
the dangerous direction, and both assert states (the orphan row / the un-fired refusal) that no
timing coincidence can fake.

### The rest

All feature behavior (lifecycle audits with before→after ids, the no-op skip, the four refusals,
the resolution chain incl. the raw-written dead-template and cycle states, the backfill proof —
`pageFooter` stripped from the stored seed config comes back `false`, the cascade, the route
gates, the names projection) landed test-first inside the same module-resolution RED file.

## Gate results (watched to completion, from the runs' own output, on final HEAD `a9c4fb1`)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2330/2330, 135 files** (baseline 2298/134 — +32: the template-assignments suite) | 243.0s |
| `npx tsc --noEmit` | clean | 1.9s |
| `npx eslint src tests` | clean | 10.0s |
| `npm run build` | exit 0; `/api/customers/[id]/template-assignments` and `/api/templates/names` both in the manifest | 16.5s |
| E2E | not run — routes only, no UI, no existing Playwright flow touches them (per brief) | — |

(The tsc/eslint/build runs post-date the last source edit — a TS7022 fix and a test-import
cleanup, below — and the full vitest run executed on the committed HEAD itself.)

## Decisions and deviations

1. **Re-assigning the same template is a no-op** (no write, no audit entry) — not in the brief,
   but the brief's "REPLACED (audited update)" read literally would write a before===after junk
   entry for an idempotent PUT; the house no-junk-audit precedent (`renameTemplate` no-op,
   `setDefault` already-default, `editDraft` unchanged-save) applies directly. Tested.
2. **`listTemplateNames` lives in `template-assignments.ts`, not `templates.ts`** — it exists
   solely for the §5.15 customer-page picker this task builds, and placing it here leaves Task
   4's approved file untouched (the export of `claimTemplate` is this task's only dependency on
   it). It deliberately does NOT filter to published-only: the brief pins the projection to "live
   templates"; the assign-time named 400 is the never-published guard, and a picker that silently
   hid an unpublished template would recreate the §5.15 silent-empty problem one row at a time.
3. **`clearAssignment` takes no template claim** — deliberate, documented in the service header:
   clearing creates no reference, so there is no §5.14 race to close, and claiming would add a
   lock-ordering surface for nothing.
4. **DELETE carries `docType` as a query parameter** (`?docType=TRAVELER`), not a body — the
   house has both shapes (`reasonFromBody` deletes vs. query-param reads); a no-body DELETE with
   a query discriminator keeps the reason-free §5.17 classification visible in the route shape
   itself.
5. **One TS7022 annotation** in the resolution walk (`const customer: { parentId: string | null }
   | null = …`): the generic `findFirst` return type is otherwise inferred from `current`, whose
   control-flow narrowing depends on that very assignment — a compile-time circularity vitest
   never sees. Commented at the site.

## Notes for Task 6 (render runtime — independent)

- Nothing here touches `render.ts`, builders, fonts, or `package.json`; no interaction expected.

## Notes for Task 7 (traveler conversion — the first resolution consumer)

- Call shape: `resolveTemplateForPrint(tx, "TRAVELER", order.customerId)` inside the print's own
  claimed transaction (the tests exercise it via `prisma.$transaction((tx) => …)`); the returned
  `versionId` is what `storeDocument`'s new `templateVersionId` stamp takes, and `config` is
  already backfilled — pass it straight to `buildTravelerDefinition(data, config)`.
- `printTraveler` runs at default isolation under its order claim (spec §5.1, deliberately
  unchanged) — the resolver is correct at any isolation by §5.1's immutability argument; do not
  add a template claim to the print path.
- `logoImage` comes back as raw bytes (`Uint8Array | null`) with `logoMimeType` beside it —
  Task 6's JPEG data-uri helper + the existing `pngDataUri` are the embedding path.
- The resolver throws plain `Error` (500) only on a genuinely broken DB invariant; no print-side
  catch should wrap it into a user-facing refusal.
