# Task 1 Report: `allocateNumber` key guard (issue #34) + five new settings

## Summary

Implemented exactly the interfaces the brief specified:

- `NumberSettingKey = Extract<SettingKey, \`${string}_number_next\`>` in `src/server/settings.ts`, and narrowed `allocateNumber`'s `key` parameter to it, with the runtime `typeof SETTINGS[key].default !== "number"` backstop for callers that reach the function through a cast or `any`.
- `src/lib/cert-constants.ts` — `CERT_SCOPES`, `CertScopeValue`, `CERT_SCOPE_LABELS`, `FREIGHT_TERMS`, `FreightTermsValue`, `FREIGHT_TERMS_LABELS`. No server imports.
- Five new `SETTINGS` keys: `bol_number_next`, `cert_required_default`, `cert_scope_default`, `cert_statement`, `shipper_liability_text`.
- `cert_number_next` left in place with a comment marking it intentionally unused (spec §3.19).

## Certification / shipping text transcription

Both source PDFs (`docs/samples/Certification Sample.pdf`, `docs/samples/Shipping Ticket Sample.pdf`) were fully legible — no illegible passages, so no placeholder/shortened default was needed.

- `cert_statement` default transcribed verbatim from the certification sample's boilerplate paragraph, including the company name exactly as printed: "American Heat Treating - Alabama, LLC."
- `shipper_liability_text` default transcribed verbatim from the shipping ticket's two-paragraph liability block (joined with a blank line between paragraphs, matching the source layout).

One transcription note worth flagging explicitly: the shipping ticket's middle paragraph reads "...SUBJECT TO THE **AMERICAN HEAT TREAT** - ALABAMA TERMS AND CONDITIONS..." — missing the "ING" that appears everywhere else in the same document (header, first paragraph, final paragraph all say "AMERICAN HEAT TREATING - ALABAMA"). This reads like a typo/inconsistency in the owner's original printed document. Per the task instructions ("do NOT invent wording"), I transcribed it exactly as printed rather than "fixing" it, and left an inline comment in `settings.ts` calling this out so it isn't mistaken for a transcription error later.

## Files changed

- `erp/src/server/settings.ts` — added `CERT_STATEMENT_DEFAULT`/`SHIPPER_LIABILITY_DEFAULT` constants, five new `SETTINGS` entries, `NumberSettingKey` type, narrowed `allocateNumber` signature + runtime guard, `cert_number_next` comment.
- `erp/src/lib/cert-constants.ts` (new) — pure constants per the brief's `Produces` block.
- `erp/tests/allocate-number.test.ts` — added the two brief-specified tests (`bol_number_next` allocation, `company_name` runtime refusal via `@ts-expect-error`); updated the two pre-existing "rejects an unknown key" tests' cast from `as SettingKey` to `as NumberSettingKey` (required by the narrower parameter type — see Self-review below).
- `erp/tests/settings.test.ts` — added `bol_number_next` to the existing Int4-max `it.each` list, plus five new round-trip/validation tests for the five new settings (brief Step 7).

## TDD evidence

### RED

Command:
```
cd erp && npx vitest run tests/allocate-number.test.ts
```
Relevant output (after adding only the two new tests from the brief, before any implementation):
```
 × allocateNumber > allocates from a new numbering key 23ms
   → Unknown setting: bol_number_next
 × allocateNumber > refuses a non-numbering key at runtime 23ms
   → promise resolved "''" instead of rejecting
```
Why expected: `bol_number_next` did not exist yet in `SETTINGS`, so `allocateNumber` hit its existing `Object.hasOwn` guard and threw "Unknown setting: bol_number_next" — matching the brief's Step 2 expectation exactly. The second test failed because `allocateNumber("company_name", ...)` succeeded (returned `""`, `company_name`'s string default) instead of throwing, since the "not a numbering key" runtime guard didn't exist yet.

Also confirmed the brief's expectation that the `@ts-expect-error` directive should itself be flagged as unused before the type narrowing:
```
cd erp && npx tsc --noEmit
```
```
tests/allocate-number.test.ts(55,64): error TS2345: Argument of type '"bol_number_next"' is not assignable to parameter of type '"company_name" | ... | "session_timeout_minutes"'.
tests/allocate-number.test.ts(57,68): error TS2345: Argument of type '"bol_number_next"' is not assignable to parameter of type '"company_name" | ... | "session_timeout_minutes"'.
tests/allocate-number.test.ts(64,9): error TS2578: Unused '@ts-expect-error' directive.
```
(The first two errors are `bol_number_next` not yet existing in `SETTINGS`; the third is the brief's called-out "no `@ts-expect-error` needed yet" signal — `company_name` was still a valid `SettingKey` accepted by the pre-narrowing `allocateNumber`.)

### GREEN

After implementing `cert-constants.ts`, the five settings, and the `NumberSettingKey` narrowing + runtime guard:
```
cd erp && npx vitest run tests/allocate-number.test.ts tests/settings.test.ts
```
```
 ✓ tests/settings.test.ts (25 tests) 469ms
 ✓ tests/allocate-number.test.ts (10 tests) 288ms

 Test Files  2 passed (2)
      Tests  29 passed (29)
```
(29 at that point; grew to 35 after Step 7's five additional settings tests — see Full suite below.)

```
cd erp && npx tsc --noEmit
```
Clean — no output beyond the npm notice lines, confirming the `@ts-expect-error` directive is now required and satisfied, and `bol_number_next` type-checks.

## Full suite / gates (final, before commit)

```
npm test        → Test Files  76 passed (76); Tests  1018 passed (1018)
npx tsc --noEmit → clean
npx eslint src tests → clean
npm run build    → succeeded (ran as an extra check per global-constraints.md; not one of the three required gates)
```

Baseline before this task was 1010 tests; this task adds 8 (2 in `allocate-number.test.ts`, 6 in `settings.test.ts` — 1 added to the existing `it.each` list + 5 new tests), landing at 1018.

## Self-review

**Completeness against brief**: all Produces-block interfaces implemented with the exact names specified. All 8 steps of the brief followed in order (failing tests → verify RED → create cert-constants.ts → add settings → narrow allocateNumber → verify GREEN → extend settings.test.ts → gates + commit).

**Naming**: `NumberSettingKey`, `CERT_SCOPES`, `CertScopeValue`, `CERT_SCOPE_LABELS`, `FREIGHT_TERMS`, `FreightTermsValue`, `FREIGHT_TERMS_LABELS` — all verbatim from the brief's interface block.

**Unplanned but necessary fix**: narrowing `allocateNumber`'s parameter to `NumberSettingKey` broke type-checking on the two *pre-existing* "rejects an unknown key" tests in `allocate-number.test.ts`, which cast `"bogus_key" as SettingKey` — `SettingKey` (the full union) is no longer assignable to the narrower `NumberSettingKey` parameter. Fixed by changing the cast to `as NumberSettingKey` (and the import accordingly) since that's now the actual parameter type; the test's intent (exercising the `Object.hasOwn` "genuinely unknown key" backstop) is unchanged. This was required for `tsc` to pass — not optional.

**YAGNI**: no speculative code. `FREIGHT_TERMS`/`FREIGHT_TERMS_LABELS` are unused by anything yet, but they're explicitly named in the brief's Produces block as interfaces for later tasks, not something I invented. I did add `bol_number_next` to the existing Int4-max `it.each` parameterized test (not explicitly listed in brief Step 7) — this is test-coverage-only, extends an existing convention documented as covering "every other `*_number_next` consumer," and required zero production code changes; I judged it in-scope as completing existing test intent rather than new scope.

**Test quality**: new tests assert real behavior (actual allocated numbers, actual thrown-message content via regex, actual 400 status, actual round-tripped values) rather than just "doesn't throw." The two transcription round-trip tests assert both a content anchor (first-line regex) and a distinguishing substring, without being brittle to exact whitespace/wrapping of the full transcribed block.

**Pristine test output**: confirmed — full `npm test` run shows no console warnings, no `console.error` noise, no skipped/todo tests.

## Concerns

- **Not a defect in this task, but worth flagging for whoever next touches the generic settings UI** (`src/app/admin/settings/page.tsx`, `erp/src/app/api/admin/settings/route.ts`): that page's `save()` handler branches only on `typeof row.value === "number"` vs. treating everything else as a raw string — it has no boolean-aware path. `cert_required_default` is the first boolean-typed setting in `SETTINGS`; saving it through that generic page would submit the string `"true"`/`"false"` rather than an actual boolean, and `setSetting`'s `z.boolean()` schema would reject it with a 400. This task's file list (`src/server/settings.ts`, `src/lib/cert-constants.ts`, two test files) doesn't include that page, so I left it untouched — flagging it here rather than silently fixing UI code outside the brief's scope. Also cosmetic: `cert_statement` and `shipper_liability_text` are multi-hundred-character strings that will render in that page's single-line `<input>` — usable but not pleasant; likely something a later Phase 4 task addresses directly (a proper settings UI for these appears to be out of this task's scope).
- No concerns about the PDF transcription itself — both samples were fully legible; the one deliberate verbatim inconsistency ("AMERICAN HEAT TREAT" vs. "AMERICAN HEAT TREATING") is called out above and in an inline code comment.
