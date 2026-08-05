# Task 15 report: Certifications worklist page

## Addendum — review fix round (Important + Minor)

Review verdict came back **Needs fixes**: one Important (the four non-negotiables and the new
test file's genuine-incremental-coverage claim were all confirmed correct against the code), one
Minor.

**Important — the pass/fail summary reported "passed" for readings nobody has entered yet.**
`CertList.tsx` derived a passed count as `readingCount - failCount`. A reading with no value has
`passed === null`, not `false`, so that subtraction silently counted it as passed the moment
there were zero failures — the normal state of every cert before data entry finishes (a few
requirements filled in and passing, the rest still blank), not an edge case, and it overstated
completeness to exactly the audience (quality) this page exists for.

Fix:
- `src/server/certs.ts`'s `CertRow` gained `passedCount`, computed in `rowsToCertRows` the same
  explicit-equality way `failCount` always was (`readings.filter((r) => r.passed === true).length`,
  not "not false"). `CertDetail` extends `CertRow`, so `src/server/cert-results.ts`'s
  `toCertDetail` needed the matching field too, or the object literal no longer satisfied the
  type — `tsc` caught this immediately.
- `src/app/certs/CertList.tsx`'s local `CertRow` mirror and its Results-column rendering were
  rewritten: `resultSegments()` now renders up to two independent segments — `"N of M failed"`
  (red, when `failCount > 0`) or `"P passed"` (slate, when `passedCount > 0`), plus a `", Q
  pending"` suffix (amber) whenever `readingCount - passedCount - failCount > 0` — instead of
  inferring one count from the other. A mid-entry cert with one pass and one still-blank reading
  now reads **"1 passed, 1 pending"**, never "2 passed" or a bare "1 passed" that hides the
  pending state.
- `tests/cert-list.test.ts`: the existing failCount test now also asserts `passedCount`. Added a
  new test, `"a pending reading (no value entered, passed === null) counts toward neither
  passedCount nor failCount, even with zero fails"`, seeding a cert with one passed reading and
  one reading with `value: null` — asserting `passedCount` (1) `!== readingCount` (2), which is
  exactly the invariant the bug violated. **Verified RED**: temporarily changed
  `certs.ts`'s `passedCount` computation to `readings.length - readings.filter((r) => r.passed
  === false).length` (the buggy inference, restated for `passedCount` directly) and reran —
  the new test failed (`expected 2 to be 1`); the pre-existing three tests stayed green.
  Reverted (byte-identical to the pre-edit file, confirmed with `diff`), reran — 5/5 green.
- Also verified live in the browser (fresh `PORT=3001 npm run dev`, an isolated tab pinned to
  port 3001, fixture data under customer code `ZZLANEB3`, cleaned up afterward — `remaining
  ZZLANEBCustomers: 0` confirmed by direct query): a cert with one pass + one pending (zero
  fails) rendered **"1 passed, 1 pending"**; a second cert on the same order with one pass + one
  fail + one pending rendered **"1 of 3 failed, 1 pending"**. A DOM query of the rendered `<span>`
  elements confirmed the three segment classes independently: `text-red-700` for the failed
  segment, `text-slate-600` for the passed segment, `text-amber-700` for the pending segment.

**Minor — a comment cited a precedent that does not exist.** `src/app/certs/page.tsx` claimed the
page.tsx/CertList.tsx split followed "the customers/parts precedent." It doesn't — every other
`page.tsx` in this app is itself `"use client"` with its component inline; this page is the only
Server-Component wrapper. Corrected the comment to say the split is this task's own two-file
brief, not an existing pattern, and corrected the equivalent claim above in this report's "What
was implemented" section is now superseded by this note (the original text is left below
unedited per the append-only instruction, but should be read with this correction: there is no
customers/parts precedent for the page.tsx/CertList.tsx split itself — only for the *contents* of
CertList.tsx, which do follow the customers/parts list-page pattern as described).

Gates re-run after the fix, both clean:
```
npm test              → 92 files, 1275 tests passed (cert-list.test.ts now 5 tests)
npx tsc --noEmit       → clean
npx eslint src tests   → clean
```

New commit on `phase-4-lane-b`: `3acd9b5` `fix(ui): certifications worklist reports pending
readings, not "passed"`.

## What was implemented

- `src/app/certs/page.tsx` — thin server-route entry point that renders `<CertList />` (the
  customers/parts precedent: page.tsx stays a wrapper, the "use client" component lives in its
  own file).
- `src/app/certs/CertList.tsx` — the worklist itself. Columns per spec §11: order label
  (`#72036-3` for a SHIPMENT-scope cert — order number + that order's own shipment sequence, per
  §3.19's "a cert has no number of its own"; bare `#<orderNumber>` for ORDER/LOAD), customer
  (`CODE · name`), scope (`By order`/`By load`/`By shipment`), load-or-shipment subject, printed
  yes/no, and a pass/fail summary (`—` with no readings, `N of M failed` in red when `failCount >
  0`, `M passed` otherwise). Filters: search (order #, PO, customer code/name — all four fields
  `certListWhere`'s `certSearchWhere` already matches), customer (gated on `customers.view` via
  `src/lib/permission-ui.ts`'s `gate()`, disabled+tooltip when absent), scope, printed/unprinted,
  and "Show voided" (default off). Excel export is a plain link to `/api/certs/export` carrying
  the same query string. A voided row gets a small "voided" badge plus the whole row dimmed
  (`text-slate-400`), matching the order board's own treatment of voided rows.
- `tests/cert-list.test.ts` — service-level coverage for `listCerts`, the function this page
  depends on entirely (no new server code was needed or written — `listCerts`/`exportCerts`
  already existed complete from Task 5, and `/api/certs`, `/api/certs/export` already existed
  from Task 11).

**Not touched, on purpose:** `src/components/Shell.tsx` (the outer task instructions said the
other lane owns both nav entries; the nav entry for Certifications was already live in Shell.tsx
when this task started) and `src/server/certs.ts` (no changes needed — see below).

## Tests and results — TDD evidence

`tests/certs.test.ts` (Task 5, pre-existing) already had thorough `describe("listCerts")`
coverage: scope/customerId/printed filters (one at a time), `includeVoided` default-off vs. on,
search over order number/PO/customer code/name, newest-first ordering. Writing the same
assertions again in `tests/cert-list.test.ts` would have been pure duplication with no real RED
step (the implementation already existed and was already correct), so instead this file targets
what the worklist page specifically needs and what nothing else in the suite exercised:

1. **Combined filters in one query** — customer + scope + printed + search together, the shape
   the filter bar actually sends (existing tests only ever set one filter key per call).
2. **`includeVoided` omitted vs. `true`**, combined with another filter.
3. **`sequence` through `listCerts` itself** (not just through `createCert`'s own return value,
   which is all `certs.test.ts` checked) — this is the field the page's `#72036-3` label reads,
   and `listCerts`'s own `sequenceMap` batching path had zero coverage before this.
4. **`failCount` with genuine failing readings**, across two requirements on one cert — the one
   assertion in the whole suite (`getCert`'s test only asserted `failCount === 0`, the trivial
   empty case).

Ran `npx vitest run tests/cert-list.test.ts` after writing it: all 4 passed immediately, since
`certs.ts`/`cert-results.ts` (Task 5/6) already implement the exact contract correctly — there was
no bug to discover. To confirm the tests are real (not tautological), I temporarily changed
`certs.ts`'s `failCount` computation from `passed === false` to `passed === true` and reran just
that file:

```
❯ tests/cert-list.test.ts (4 tests | 1 failed)
   × failCount counts only readings whose passed is exactly false...
     → expected 1 to be 2
```

Reverted (`diff` against a pre-edit backup confirmed byte-identical, `git status` showed no
diff), reran — 4/4 green again. That RED/GREEN cycle is the evidence this task's TDD step
produced, given the service layer under test predates this task.

Full suite before each commit:

```
npm test        → 92 files, 1274 tests passed
npx tsc --noEmit → clean
npx eslint src tests → clean
npm run build    → succeeds; /certs listed as ○ (Static)
```
All four ran twice (once before the first commit, once after the self-review fixup commit),
green both times.

## Verified in the browser

The MCP Browser pane could not produce an actual screenshot in this environment
(`screenshot failed: ... the Browser pane is not displayed, so the page is not compositing
frames` — an environment limitation, not a page bug). Verification was instead done with
`get_page_text`/`javascript_tool` DOM inspection against a real `npm run dev` instance, which
gives exact text assertions rather than a visual snapshot.

Ran the dev server manually via `PORT=3001 npm run dev` (bypassing this session's `preview_start`
tool, which kept reusing an already-running server at port 3000 — cwd
`/home/cojoa13/Desktop/HeatSynQ`, i.e. the **other lane's** server — regardless of the config name
passed to it; using it would have risked driving Lane A's session). Logged in as admin/admin on a
freshly-opened, isolated browser tab pinned to `http://localhost:3001`, double-checking
`tabs_context`'s reported origin before every interaction after one earlier mix-up where the tab
drifted back to port 3000 mid-session (caught before any state-changing action landed there — the
only thing that ran against it was one read-only DOM query listing input placeholders).

Created fixture data directly via the app's own service functions (`createOrder`, `createCert`,
`replaceReadings`, `voidCert` — the same functions the test suite calls) against the **dev**
database (`erp`), under customer code `ZZLANEB1`/`ZZLANEB2` for easy identification, and deleted
every row afterward (verified with a `customer.count({ code: { startsWith: "ZZLANEB" } })` query
returning 0 both times). Observed:

- Empty state before any fixture existed: **"No certifications match these filters."**
- With fixture data (one order, three certs — ORDER/printed/all-pass, LOAD/unprinted/one-fail,
  SHIPMENT/voided with sequence 4):
  - `#1029 · By load · Load 1 · no · 1 of 2 failed` — correct pass/fail arithmetic (one 20.0
    reading below a 28–32 bound, one 30.0 inside it).
  - `#1029 · By order · (blank) · yes · 1 passed`.
  - With "Show voided" checked: `#1029-4 · By shipment · Shipper #987654 · no · —` appears, with
    the `-4` suffix (from `ShipperOrder.sequence`) and the "voided" badge; row `className` was
    `"border-t text-slate-400"` confirming the dimming applied.
- **Filters, tested individually and combined**: customer select, scope select (narrowed to just
  the LOAD-scope row), search (matched on `ZZLANEB-PO-1`; a non-matching term correctly produced
  the empty-state row; compounded correctly with the scope filter still active — confirming AND
  semantics across filters, not just each one alone). One real trap from HANDOFF §5a bit this
  verification exactly as documented: `input[placeholder*="Search"]` matched the Shell's own
  global search box first, not the page's field — re-targeted with the page's exact placeholder
  string and confirmed working.
- **`includeVoided` default-off**: confirmed the voided cert is absent until the checkbox is
  checked.
- **Export**: `fetch('/api/certs/export')` returned `200`, `content-type:
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
  `content-disposition: attachment; filename="Certifications.xlsx"`.
- **Failed-request handling (the non-negotiable)**: monkey-patched `window.fetch` to reject on
  `/api/certs` calls, triggered a reload via the search box, and confirmed the error banner
  ("Failed to fetch (simulated)") rendered **and the previously-loaded rows stayed on screen**
  rather than being wiped to an empty table — the exact behavior the "no `.catch(() => {})`"
  rule and the `useLatest` gate exist to guarantee.

Dev server stopped and both temporary fixture/cleanup scripts deleted afterward; `git status`
confirmed a clean tree apart from the intended source files.

## Files changed

- `erp/src/app/certs/page.tsx` (new)
- `erp/src/app/certs/CertList.tsx` (new)
- `erp/tests/cert-list.test.ts` (new)

Two commits on `phase-4-lane-b`:
- `3cbc141` `feat(ui): certifications worklist`
- `d4f80e6` `refactor(ui): trim unused cert row fields, dim voided rows in the worklist`
  (self-review fixup: dropped `orderId`/`shipperId` from the local `CertRow` mirror since neither
  is read anywhere in the component, and added row-dimming for voided rows to match the order
  board's existing convention, on top of the badge)

## Self-review findings

- Confirmed `src/server/certs.ts` and `src/components/Shell.tsx` are untouched (`git diff
  --stat` against both empty) — the two files this task was explicitly told to stay out of.
- The local `CertRow` type originally mirrored every field on the server's `CertRow`, including
  two (`orderId`, `shipperId`) nothing in the component reads — trimmed to match the parts/
  page.tsx precedent ("only the columns this list renders").
- Voided rows initially had only the badge; added the same text-dimming the order board applies
  to its own voided rows, for visual consistency across the two list pages.
- No `.catch(() => {})` anywhere in the new file; both fetches (`load` and the customer picker)
  report failures through the shared `error` state.
- `useLatest` gates both the success and rejection paths of `load`, per the issue #5/#15
  precedent this project already hit twice.
- Permission gating: the customer filter dropdown is disabled with a "Requires customers.view"
  tooltip when the caller lacks it, rather than silently sitting empty. The list itself has no
  create/edit affordance to gate — certs aren't created from this screen (spec §11 doesn't
  describe one; they're created via order/shipment flows) — so `certs.view` gating is left
  entirely to the existing `/api/certs`/`/api/certs/export` routes' own `mustCan` calls, the same
  as every other list page in this codebase.

## Concerns

- The row's detail link points at `/certs/{id}`, which does not exist yet — Task 16 builds it.
  That's the expected, sequential build order (confirmed against
  `docs/superpowers/plans/2026-08-04-phase-4-certs-shipping.md`), not a defect, but the link will
  404 until Task 16 lands.
- `tests/cert-list.test.ts` substantially overlaps in *intent* (though not in literal assertions)
  with `tests/certs.test.ts`'s own `listCerts` coverage from Task 5. I chose not to re-derive
  that coverage verbatim since it would have been dead weight with no real RED step; the new file
  instead adds combined-filter and `sequence`/`failCount` coverage that was genuinely absent. Flag
  this if a reviewer expected literal per-field duplication of the brief's list instead.
- No component-level (rendered) tests exist for `CertList.tsx` — this repository has no
  jsdom/testing-library setup at all (`vitest.config.ts` is `environment: "node"`), so the page is
  covered only by this manual browser verification now and by Task 20's E2E later, exactly as the
  outer task description anticipated.
