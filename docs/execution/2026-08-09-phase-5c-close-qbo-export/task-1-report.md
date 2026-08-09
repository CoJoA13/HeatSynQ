# Task 1 report — Data model, migration, audit + counter registration

**Status:** DONE
**Commit:** `e283b65` — `feat(5c): close + GL-export data model, migration, audit + counter registration`
**Branch:** `phase-5c-close-qbo-export`
**Base:** `d0be935` (docs: start execution ledger)

## What was implemented

Followed the brief's 9 steps verbatim, no deviations in code shape:

1. **`erp/prisma/schema.prisma`** — appended `ClosePeriod`, `GlExportBatch`, `GlPosting` (new
   "Phase 5C: month-end close + GL export" section at the end of the file, after `Application`);
   extended `BillingConfig` with `arGlAccountId`/`discountGlAccountId`/`writeOffGlAccountId` (each
   a nullable FK to `GlAccount` with its own named relation, mirroring the existing
   `BillingSalesTaxGl` pair); added the three matching back-relations
   (`billingAr`/`billingDiscount`/`billingWriteOff`) plus `glPostings GlPosting[]` on `GlAccount`;
   added `closedPeriods ClosePeriod[]` / `glExports GlExportBatch[]` on `User`. Ran `npx prisma
   format` after editing (column alignment only — no semantic change; diffed to confirm).
2. **Migration** — `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma
   --script`, read in full, matched the brief's expected shape exactly (3 `CREATE TABLE`s, 6
   `CreateIndex`, 3 `BillingConfig` `ADD COLUMN`/`ADD CONSTRAINT` pairs, the `ClosePeriod`/
   `GlExportBatch`/`GlPosting` FKs). Hand-written verbatim into
   `erp/prisma/migrations/20260809130000_phase_5c_close_and_gl_export/migration.sql`. No CHECK, no
   enum — confirmed statuses/sourceType/side are all plain `String` columns per the brief.
3. Applied to both databases (`npx prisma migrate deploy` against `erp`, then against `erp_test`
   with `DATABASE_URL` override) — both succeeded, `npx prisma migrate status` confirms "Database
   schema is up to date!" against dev. `npx prisma generate` regenerated the client.
4. **`erp/src/server/audit.ts`** — appended `| "closePeriod" | "glExportBatch"` to
   `AuditableModel`, and `closePeriod: undefined` / `glExportBatch: { postings: true }` to
   `SNAPSHOT_INCLUDE`. `GlPosting` deliberately excluded from `AuditableModel` per the brief (never
   independently mutated; snapshotted only through its parent batch's `{ postings: true }`
   include).
5. **`erp/src/server/settings.ts`** — added `gl_export_batch_number_next` beside
   `receipt_batch_number_next` in the `SETTINGS` registry (same shape: `numberSeed`, default
   `1000`, `group: "Numbering"`). Key ends in `_number_next`, so `NumberSettingKey` (a template-
   literal `Extract`) picks it up automatically — no separate type edit needed.
6. **`erp/tests/partial-unique-sweep.test.ts`** — added `"GlExportBatch.exportNumber"` to the
   `ALLOWED` set with the documented allocation-only rationale, beside `ReceiptBatch.batchNumber`.
7. **`erp/tests/close-periods.test.ts`** (new) — the brief's smoke test verbatim: creates a
   `ClosePeriod`, a `GlExportBatch` under it, and a `GlPosting` under the batch, then asserts the
   posting count.
8. Gates run (below).
9. Committed per the brief's exact file list and message, no attribution trailer.

## Gate results

Brief's Step 8 (scoped gates):
```
npx vitest run tests/close-periods.test.ts tests/partial-unique-sweep.test.ts
```
```
 ✓ tests/partial-unique-sweep.test.ts (2 tests)
 ✓ tests/close-periods.test.ts (1 test)
 Test Files  2 passed (2)
      Tests  3 passed (3)
```
Also ran `tests/certs-schema.test.ts` (the `SNAPSHOT_INCLUDE is a valid Prisma include for every
audited model` sweep) since it directly exercises the new `AuditableModel`/`SNAPSHOT_INCLUDE`
entries end-to-end (`findFirst({ include: SNAPSHOT_INCLUDE["glExportBatch"] })` against the live
`postings` relation) — passed, 13/13.

`npx tsc --noEmit` — **PASS**, no output.

`npx eslint src/server/audit.ts src/server/settings.ts tests/partial-unique-sweep.test.ts
tests/close-periods.test.ts` — **PASS**, no output.

I also ran the full `npm test` suite as a diligence check beyond what the brief's Step 8 asked
for. Result: **120/121 files, 1879/1881 tests pass.** The one failing file is
`tests/reference-links-sweep.test.ts` (2 tests) — see Concerns below; this is expected and is why
the brief's own Step 8 deliberately scopes gates to the smoke test + partial-unique-sweep + tsc
rather than the full suite.

## Self-review

- **Schema diffed against the brief line-for-line** — model bodies, column types, defaults,
  indexes, and relation names all match; `prisma format`'s realignment is whitespace-only (checked
  via `git diff`).
- **Migration SQL is the tool's own unedited output** — no hand-added CHECK/enum, matching the
  brief's explicit "no hand-written CHECK or enum is needed" note. The `BillingConfig` FK
  constraint text matches the brief's quoted precedent verbatim.
- **`GlPosting` correctly excluded from `AuditableModel`** — confirmed no `auditedCreate`/
  `auditedUpdate`/`auditedSoftDelete` call references `"glPosting"` anywhere (none exist yet; no
  service code was added this task).
- **Counter key convention respected** — `gl_export_batch_number_next` ends in `_number_next`,
  matches `NumberSettingKey`'s `Extract<SettingKey, \`${string}_number_next\`>` pattern with no
  additional plumbing.
- **No business logic added** — grepped `src/server/` for new imports of the three models outside
  `audit.ts`; none found. Task 1 stays schema/migration/audit/counter only, as scoped.

## Concerns

**Not blocking Task 1, but worth flagging for the controller and for whoever picks up the FKs
next:**

1. **`tests/reference-links-sweep.test.ts` currently fails on `main` HEAD of this branch** (2 of
   its tests) because the new `BillingConfig.arGlAccountId`/`discountGlAccountId`/
   `writeOffGlAccountId` foreign keys point at `glAccount` (a reference kind) and aren't yet in
   `REFERENCE_LINKS`. This is **expected and by design** — Task 2 ("BillingConfig GL defaults —
   service, delete-blocker registry, admin UI", plan lines 280–371) explicitly registers exactly
   these three FKs in `src/lib/reference-links.ts` and updates this sweep's hard-coded
   expected-offenders list. The brief's own Step 8 deliberately runs only the smoke test +
   partial-unique-sweep + `tsc`, not the full suite, which is consistent with this being a known
   transient gap between Task 1 and Task 2.

2. **A fourth, unplanned FK also trips the same sweep: `GlPosting.glAccountId -> glAccount`.**
   Unlike the three `BillingConfig` FKs, this one is **not** mentioned anywhere in the Phase 5C
   plan's Task 2 section (which only lists "3 registry entries") or in any other task I could find
   by searching the plan for `glPosting`/`GlPosting`. Someone — most likely whoever implements
   Task 6 (`gl-export.ts`, the task that actually writes `GlPosting` rows) — will need to add a
   fourth `REFERENCE_LINKS` entry for it. Two things worth flagging for whoever does that: (a) it
   follows the same "billed history is permanent" pattern already applied uniformly to every other
   FK targeting `glAccount` (`processStepCode.glAccountId`, `paymentType.glAccountId`,
   `surcharge.glAccountId`, `invoiceLine.glAccountId`), so blocking `GlAccount` deletion once it
   has live postings is consistent with existing design; but (b) **`GlPosting` has no `deletedAt`
   column at all**, so a registration that omits `liveWhere: {}` (the `BillingConfig`/
   `SurchargeStepCode` precedent in `reference-links.ts`) would make `findBlockers("glAccount",
   …)` throw at runtime the first time anyone tries to delete a GL account with any posting
   history — a worse failure than the test gap it would be closing. I deliberately did **not**
   add this registration myself: it requires a `displayName`/`entityLabel` design call for an
   entity with no detail page yet (the `Payment.paymentTypeId` entry is the precedent for
   "register now, no `detailPath`, add the link once the UI task lands"), and per the project's
   "do not make assumptions" directive I left it for the task that owns `GlPosting`'s write path
   and can make that call with full context, rather than inventing UI-adjacent copy in a
   schema-only task.

No other concerns. Migration applied cleanly to both databases; client regenerated; all files
committed exactly as the brief's Step 9 lists.
