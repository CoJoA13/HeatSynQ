# Task 3 report — Schema, migrations, seeds, and registrations

**Implementer:** fresh subagent, 2026-08-12
**Branch:** `phase-7-template-designer`
**Commits:** `bc887a4` (the two pre-steps), `8868112` (schema + the two migrations),
`e4a960c` (registrations + the drift guard)

## Pre-steps (before any seed literal froze)

1. **`"MMM D, YYYY"` → `"MMMM D, YYYY"`** across `types.ts` (`DATE_FORMATS` + comment),
   `invoice.ts`, `statement.ts`, and the two test pins — TDD'd (tests updated first, 2 failed,
   then the rename). The token is bound to the FULL-month `longDate` ("July 29, 2026"); nothing
   was stored anywhere yet, so the rename was free — the seed literals now carry the fixed token.
2. **`quote_source` defaultLabel** now references `PRICE_SOURCE_LABELS.QUOTE`
   (`src/lib/invoice-constants.ts`, client-safe) instead of duplicating `"Quote"`; the test pins
   both the constant identity and the literal value. Pure refactor (values identical), so this
   half has no RED — the anti-drift pin is the test's new constant-equality assertion.

## What was built

- **Schema** (`prisma/schema.prisma`): `TemplateDocType` (8 values, §8's list verbatim);
  `DocumentTemplate` (partial-unique `[docType, name]`; `publishedVersionId` commented with the
  null-only-between-create-and-first-publish invariant); `DocumentTemplateVersion` (NO
  `deletedAt`, no delete path — status-flip discard and published-rows-immutable stated in
  comments; plain `@@unique([templateId, versionNumber])`, deliberate; `templateId` is
  `onDelete: Cascade` — an owned child, see the sweep note below); `CustomerTemplateAssignment`
  (partial-unique `[customerId, docType]`, indexes on both FKs); `Part.processName` (ruling 4
  comment); `StoredDocument.templateVersionId` + index, with the schema comment saying why the
  kind→owner CHECK is untouched (render metadata on every kind, not a seventh owner). Back-
  relations on `Customer`/`User`/version↔template (named relations — two FK pairs between the
  same two models). `prisma format` re-aligned column whitespace in the touched models
  (User/Customer/Part/StoredDocument/InvoiceLine) — cosmetic only.
- **Migration 1 — `20260812233706_document_templates`**: `migrate diff` output read in full,
  purely additive, hand-written with a house header. No enum ADD VALUE anywhere → one directory.
- **Migration 2 — `20260812233950_seed_standard_templates`**: 8 × "Standard", `isDefault`, v1
  `PUBLISHED`, `publishedVersionId` pointed at it. Applied to BOTH DBs; `npx prisma generate`;
  `migrate status` clean on both (34 migrations, "Database schema is up to date!" twice).
- **Registrations:** `AuditableModel` + `SNAPSHOT_INCLUDE` (`documentTemplate` pulls live
  assignments ordered with customer code/name — the customerSurcharge precedent;
  `customerTemplateAssignment` names both ends; `documentTemplateVersion` projects through a new
  **`SNAPSHOT_SELECT`** entry = every scalar except `logoImage`); `redact()` gains `"logoimage"`.
  `truncateAll()` re-seeds the 8 templates from the TS `DEFAULT_CONFIG` constants (3 statements:
  two `createMany` + one `UPDATE … FROM` pointer move; fixed ids matching the migration's).
  §5.14: `BlockerTarget` gains `"documentTemplate"` (+`TARGET_LABELS`), and
  `customerTemplateAssignment.templateId` joins `REFERENCE_LINKS` (blocker = the CUSTOMER,
  customerSurcharge shape). The partial-unique sweep picked the two new columns up from the
  schema automatically (no `src` offenders; every `@@unique(` single-line).
- **The drift guard** (`tests/template-seed.test.ts`, 12 tests): parses the per-type
  dollar-quoted config literals out of the seed migration's SQL FILE (never the DB) and
  deep-equals each against `defaultConfigFor(docType)`; asserts the COALESCE fallbacks equal the
  code defaults (BOTH `SETTINGS[key].default` and the contract's `defaultText`), the
  quote-literal `pageFooter: true` (and false for the other seven), the present-key-empty-string
  `quote_liability_text`, the JSON-encoded `\n\n`, structural inserts/updates per type, plus the
  DB smoke, the SNAPSHOT_SELECT exclusion, redact, and the assignments-include behavior.

## Migration SQL decisions

- **Id minting:** fixed readable literal ids — `standard-<doctype>` / `standard-<doctype>-v1` —
  the `BillingConfig` `'singleton'` precedent (the repo's only prior seed INSERT; no migration
  mints cuids in SQL). `truncateAll()` re-uses the same ids, so tests and dev rows agree.
  `publishedById` stays NULL (no User row is guaranteed at migrate time; the column is nullable).
- **JSON encoding:** each config literal is the type's `DEFAULT_CONFIG` serialized
  (`JSON.stringify`) inside a **per-type dollar-quoted tag** (`$traveler_config$…`), cast
  `::jsonb` — no quote-escaping, backslash-`n` decodes to real newlines at cast time, and the
  per-type tags are what make the drift guard's extraction grammar-free. The literals were
  GENERATED from the TS constants by a scratchpad script (reviewed in full afterwards) rather
  than transcribed by hand — the guard's job is catching future drift, and hand-typing 30KB of
  JSON would only manufacture present drift. Verified on the dev DB after deploy: real `\n\n` in
  the decoded shipper text, and the BOL's `†`/`§` survived UTF-8 end to end.
- **The COALESCE shape:** `Setting.value` is **jsonb**, so the copy operates at the jsonb level —
  `jsonb_set(<literal>::jsonb, '{textBlocks,<key>}', COALESCE((SELECT "value" FROM "Setting"
  WHERE "key" = '<key>'), $<key>_default$"<code default>"$<key>_default$::jsonb))`, nested twice
  for the quote's two keys. The base literal already carries the code default, so a fresh
  install and an upgraded one converge; `quote_liability_text`'s fallback is `'""'::jsonb` — a
  present key holding the empty string, never an absent key. Verified both COALESCE directions
  on the dev DB (a live Setting row wins; absent falls back). **The `Setting` rows are NOT
  deleted and `settings.ts` is untouched** — the print paths read them until Tasks 9/11/14;
  retirement is Task 14's (stated in the migration header).

## RED evidence

Pre-step cycle (the token rename, tests first):

```
 FAIL  tests/template-contracts.test.ts > … > declares today's formats and fonts …
  {
-   "dateFormat": "MMMM D, YYYY",
+   "dateFormat": "MMM D, YYYY",
      Tests  2 failed | 91 passed (93)
```

Main cycle (template-seed.test.ts written before the `truncateAll` re-seed and audit
registrations existed):

```
 FAIL  tests/template-seed.test.ts > truncateAll() re-seeds the eight Standard templates …
AssertionError: expected [] to have a length of 8 but got +0
 FAIL  tests/template-seed.test.ts > audit registration (spec §4.2) > redact() scrubs logoImage …
AssertionError: expected { logoImage: 'QUJDRA==', …(1) } to deeply equal { logoImage: '[redacted]', …(1) }
      Tests  4 failed | 8 passed (12)
```

Sweep cycle (the `kinds.add("documentTemplate")` + fixtures landed before the registry entry):

```
 FAIL  tests/reference-links-sweep.test.ts > … > every schema foreign key … is registered
AssertionError: These foreign keys point at a reference table but are missing from
REFERENCE_LINKS … expected [ Array(1) ] to deeply equal []
      Tests  1 failed | 13 passed (14)
```

## Gate results (watched to completion, from the runs' own output)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2240/2240, 132 files** (baseline 2226/131 — +14: 12 template-seed + 2 sweep fixtures) | 220.9s |
| `npx tsc --noEmit` | clean | 1.7s |
| `npx eslint src tests` | clean | 9.1s |
| `npm run build` | exit 0 | 15.8s |
| `migrate status` | clean on BOTH DBs — 34 migrations, "Database schema is up to date!" ×2 | — |
| E2E | not run — no UI/function/flow touched (schema, migrations, registries, tests; nothing in the print or route paths consumes the new tables yet), per the brief | — |

## Deviations from the brief

1. **The en-dash does not appear in any seed literal — by construction, not omission.**
   `DEFAULT_CONFIG` carries `label: null` for every field (null = the contract's
   `defaultLabel`), so the statement's "1–30" lives only in `AGING_BUCKET_LABELS`, exactly where
   the anti-drift rule wants it. The brief's "the en-dash survives the SQL encoding" assertion
   is therefore pinned two ways instead: (a) the UTF-8-survival check runs on the non-ASCII the
   literals actually carry (the BOL's `†` and `§`, verified decoded on the dev DB too), and
   (b) a dedicated test asserts the statement literal's labels are ALL null and that neither
   "1-30" nor "1–30" is baked anywhere in the SQL — the failure mode the en-dash worry encodes.
2. **`DocumentTemplateVersion.templateId` is `onDelete: Cascade`** (not in the brief's schema
   list): making `documentTemplate` a sweep-visible `BlockerTarget` (which the brief's "the
   registry entry keeps the FK sweep green" requires) also surfaces the version→template FK, and
   registering THAT would let every template's own versions block its deletion. The cascade
   annotation is the sweep's established owned-child marker (`SurchargeStepCode.surchargeId`
   shape); it only ever fires on test hard-deletes since templates soft-delete. Exemption scoped
   + two new bite-proof fixtures.
3. **The seed literals were generated from the TS constants, then reviewed in full** — see the
   JSON-encoding note above. The migration SQL itself is still hand-assembled (header, structure,
   COALESCE shape) and was applied via the skill's deploy/verify steps.
4. **`redact()` behavioral tests + the assignments-include test live in `template-seed.test.ts`**
   rather than `audit.test.ts` — the brief names only the new test file for this task; the
   assertions mirror `audit.test.ts`'s signatureImage test one-for-one.

## Notes for Task 4 (the template service)

- `TemplateDocType`'s Prisma values are 1:1 with `TEMPLATE_DOC_TYPES`, so the service can
  dispatch `validateConfig`/`defaultConfigFor` on the enum directly.
- The seeded/re-seeded fixed ids (`standard-traveler` …) are stable in every test DB after
  `truncateAll()` — fixtures can reference them instead of querying.
- `versionNumber` allocation must run under the template row's `SELECT … FOR UPDATE` claim; the
  seeded v1 means every draft the service opens on a Standard template starts at 2.
- The delete guard should walk `linksTargeting("documentTemplate")` (the registry entry is live)
  and additionally refuse deleting the current default; `TARGET_LABELS.documentTemplate` =
  "document template" for `assertRefExists`-style messages if reused.
- `SNAPSHOT_SELECT.documentTemplateVersion` lists every scalar except `logoImage` — if Task 4
  adds columns to the version model, extend that select in the same breath (the storedDocument
  precedent comment states the rule).
- `truncateAll()` now issues 3 extra statements per test; if a Task 4+ suite needs a
  templates-free world (e.g. to test the no-default fallback error), delete the rows in the test
  itself rather than touching the helper.
