# Task 1 Report: `invoice-constants.ts` + the two new settings

## What changed and why

**Created `erp/src/lib/invoice-constants.ts`** — pure, client-safe constants for Phase 5A's
invoice/credit domain, mirroring the existing `cert-constants.ts` / `permission-constants.ts`
pattern exactly (no `src/server/**` imports, so client components can import it without dragging
Prisma / `node:async_hooks` into the browser bundle per CLAUDE.md). Contains, verbatim from the
brief:

- `INVOICE_KINDS` (`INVOICE`, `CREDIT`) + `INVOICE_KIND_LABELS`
- `INVOICE_STATUSES` (`DRAFT`, `FINALIZED`) + `INVOICE_STATUS_LABELS`
- `INVOICE_LINE_KINDS` (`PART`, `OPERATION`, `SURCHARGE`, `FREIGHT`, `CHARGE`, `CERT`, `TAX`) +
  `INVOICE_LINE_KIND_LABELS`
- `PRICE_SOURCES` (`PART_PRICE`, `MANUAL`) + `PRICE_SOURCE_LABELS`
- `SURCHARGE_KINDS` (`PERCENT`, `FLAT`) + `SURCHARGE_KIND_LABELS`
- `SURCHARGE_SCOPES` (`ALL`, `INCLUDE`, `EXCLUDE`) + `SURCHARGE_SCOPE_LABELS`

Each `as const` array carries a matching `Record<Value, string>` label map. Left a comment noting
these arrays must stay member-for-member and order-for-order with the Prisma enums Task 2 adds —
Task 2 was explicitly out of scope here (told not to add the enums myself).

**Modified `erp/src/server/settings.ts`** — added two keys to the `Numbering` group of the
`SETTINGS` registry, reusing the existing `numberSeed` (int, min 1, max INT4_MAX) and `int`
helpers rather than redefining anything:

- `credit_number_next: { schema: numberSeed, default: 1000, label: "Next credit number", group: "Numbering" }`
  — placed directly beside `order_number_next` / `shipper_number_next`, the active counters, since
  credit numbers will actually be allocated (unlike `invoice_number_next`).
- `invoice_number_prefix: { schema: z.string(), default: "", label: "Invoice number prefix", group: "Numbering" }`
  — placed immediately after `credit_number_next`, with the brief's exact comment explaining that
  the invoice's number IS the order number (spec §3.2) and this is only the printed prefix.

Also **widened and relocated** the existing "intentionally unused" comment so it now covers both
`invoice_number_next` and `cert_number_next`, and **moved `invoice_number_next` to sit beside
`cert_number_next`** under that shared comment (previously `invoice_number_next` sat above the
comment, separated from `cert_number_next`, with the comment covering only the latter). Both keys
stay in the registry, unwired, exactly as instructed. Final order in the `Numbering` group:
`order_number_next`, `shipper_number_next`, `credit_number_next`, `invoice_number_prefix`, then
the widened comment, `invoice_number_next`, `cert_number_next`, `quote_number_next`,
`bol_number_next`.

**Appended tests** (no new test files, per the brief and the CLAUDE.md instruction to append to
the existing ones):
- `erp/tests/allocate-number.test.ts`: `"allocates credit numbers from the new counter"` — two
  sequential `allocateNumber("credit_number_next", tx)` calls return 1000, then 1001.
- `erp/tests/settings.test.ts`: `"round-trips the invoice number prefix"` (set `"7"`, read back
  `"7"`) and `"rejects a zero credit number seed"` (asserts the `numberSeed` min-1 guard rejects
  `0` with an `Invalid|Too small`-matching message, same pattern as the existing
  `order_number_next` boundary tests).

## Test commands run, with output summary

1. **TDD Step 2 — verify failure before implementing** (tests added, `settings.ts`/`invoice-constants.ts` not yet touched):
   ```
   npx vitest run tests/allocate-number.test.ts tests/settings.test.ts
   ```
   Result: 3 failed, 35 passed. Failures were exactly as the brief predicted:
   - `allocateNumber > allocates credit numbers from the new counter` → `Unknown setting: credit_number_next`
   - `settings > round-trips the invoice number prefix` → `Unknown setting: invoice_number_prefix`
   - `settings > rejects a zero credit number seed` → got `Unknown setting: credit_number_next`
     instead of the expected `Invalid|Too small` message.
   (I did not separately chase the brief's predicted `tsc` error on `invoice_number_prefix not
   assignable to SettingKey` as its own step — `SettingKey` is a `keyof typeof SETTINGS` string
   union, and `setSetting`'s first parameter is typed as plain `string`, so that particular call
   site doesn't actually produce a compile error; the runtime `Unknown setting` failure above is
   the one that actually fires, and it's what the test assertions catch. This is covered under
   "ambiguity" below.)

2. **After implementation** — same command:
   ```
   npx vitest run tests/allocate-number.test.ts tests/settings.test.ts
   ```
   Result: **38 passed, 0 failed** (2 files).

3. **Full quality gates**, all green:
   - `npm test` → **1409 passed, 0 failed** across 97 test files (~123s). (CLAUDE.md's quoted
     "1010 integration tests" figure is stale relative to the current repo state; not a regression,
     just a pre-existing drift in the doc.)
   - `npx tsc --noEmit` → clean, no output.
   - `npx eslint src tests` → clean, no output.

## Ambiguity and how I resolved it

1. **Where exactly `credit_number_next` / `invoice_number_prefix` sit relative to the other
   counters.** The brief's Step 4 code fences show two separate edits (the new-keys block, and the
   widened-comment-plus-move block) but don't pin their position relative to `quote_number_next` /
   `bol_number_next`. I placed the new active counter (`credit_number_next`) beside the other
   *active* counters (`order_number_next`, `shipper_number_next`), and kept the *unused* pair
   (`invoice_number_next`, `cert_number_next`) grouped together under the shared comment, ahead of
   `quote_number_next`/`bol_number_next`. This reads as the intended grouping (active vs.
   documented-unused) and matches the brief's instruction to "move `invoice_number_next` beside
   [`cert_number_next`]" literally.

2. **The brief's predicted `tsc` failure in Step 2.** The brief says the pre-implementation state
   should fail vitest AND that `tsc` should error because `"invoice_number_prefix" is not
   assignable to SettingKey`. In the actual code, `setSetting(key: string, value: unknown)` takes
   a plain `string`, not `SettingKey`, so passing an unknown literal doesn't trip a compile error —
   only the runtime `Object.hasOwn` guard does, which is exactly what the new tests assert against
   (`HttpError` / message match). I verified this by running `tsc` in the pre-implementation state
   as well; it was clean both before and after. I did not change any typing to force a compile-time
   failure since that would mean weakening `setSetting`'s existing signature, which is out of scope
   for this task and not asked for by the Produces block. Noting it here since it's a discrepancy
   between the brief's description and observed behavior, not something silently swept aside.

3. **Test placement within `settings.test.ts`.** The brief gives the two new `it()` blocks verbatim
   but not a specific insertion point. I placed them after the last "round-trips ..." test
   (`shipper_liability_text`) and before the `allSettings consistency` test, keeping all the
   round-trip-style tests contiguous — consistent with the file's existing organization.

## Verified, not assumed

- `src/lib/settings-ui.ts`: confirmed `widgetKindFor` needs no new entry for either key.
  `invoice_number_prefix` is a plain string, default `""`, not in `SELECT_OPTIONS` or
  `TEXTAREA_KEYS`, so it falls through to `"text"` — correct, single-line input. `credit_number_next`
  is a number, so it already gets the existing `typeof value === "number"` → `"number"` widget
  path, same as every other `*_number_next` key.
- `src/app/admin/settings/page.tsx`: confirmed it groups settings dynamically from
  `allSettings()`'s `group` field rather than a hardcoded group list — `"Numbering"` already
  exists as a group, so no page changes were needed. `tests/settings-ui.test.ts` (9 tests) passed
  unchanged, confirming this.

## Deliberately not done

- Did not touch `prisma/schema.prisma` or add any Prisma enum — Task 2's job, explicitly called out
  as out of scope for this task.
- Did not wire `invoice_number_next` or `cert_number_next` to anything — both remain intentionally
  unused per the (now-widened) comment.
- Did not add a `TEXTAREA_KEYS` or `SELECT_OPTIONS` entry for either new key in
  `settings-ui.ts` — verified neither is needed rather than assuming.
- Did not modify the unrelated pre-existing working-tree change to `../.superpowers/sdd/.gitignore`
  (outside `erp/`, present before this task started, unrelated to settings/invoice work) — left
  untouched and unstaged.

## Commit

Conventional commit, no attribution trailer, staged files: `erp/src/lib/invoice-constants.ts`,
`erp/src/server/settings.ts`, `erp/tests/allocate-number.test.ts`, `erp/tests/settings.test.ts`.

```
feat(settings): add credit numbering and the invoice number prefix
```
