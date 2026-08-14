# Task 20 report — The customer-page template-assignment picker

**Implementer:** fresh subagent, 2026-08-14
**Branch:** `phase-7-template-designer` (Tasks 1–19 approved; second-to-last task)
**Commits:** `c7cebfd` pure display lib, `13c9d63` display-resolution read + names widening, `6065a28` picker component + page wiring, `c2747fa` E2E extension + teardown fix

## What landed

### Pre-step — the names projection widened (carried Task 5 → 20, re-affirmed Task 19)

`listTemplateNames()` (`src/server/template-assignments.ts`) now selects `publishedVersionId` and
maps it to a derived **`published: publishedVersionId !== null`** boolean per row; the raw pointer
is never exposed. `TemplateName` gains the field; `GET /api/templates/names` is unchanged (still
`requireUser`-only, still the narrow `{id, name, docType, published}` projection). This lets the
picker disable a never-published template with its §5.16 tooltip instead of surfacing the
assign-time 400.

### The §5.2 walk, extracted once — no reimplementation of resolution

`resolveTemplateForPrint`'s own→ancestor→default walk is lifted into a shared **`resolveAssignment(tx,
docType, customerId)`** that returns the winning template PLUS `source` (`own` / `inherited` /
`default`) and the matched ancestor id. `resolveTemplateForPrint` now delegates to it and
dereferences the result — its external behaviour is byte-identical (its whole 3-deep-tree / cycle /
dead-template / backfill / never-null suite stays green, proving the refactor). This is what
satisfies the brief's "do NOT reimplement resolution": print and picker are driven by ONE walk, so
the picker can never show a template the print wouldn't use.

### The display-resolution read (the genuine minimal gap)

**`resolveAssignmentsForCustomer(customerId)`** returns one `AssignmentDisplay` per docType (all 8,
never blank), built by calling the shared `resolveAssignment` once per type inside ONE
`RepeatableRead` read-only snapshot (the `getTemplate` precedent — a concurrent assign mid-walk
can't tear the chain across docTypes; no claim, a stale DISPLAY is harmless by §5.1's immutability
argument). Each row carries `source`, `resolvedTemplateName`, the customer's `ownTemplateId` (for
the select + whether a Clear is offered), and the ancestor an inherited assignment came from. This
is the gap the brief anticipated: no existing read yields the display resolution (source + ancestor
identity + default name) without the component re-deriving the walk. Served by the new
`GET /api/customers/[id]/template-assignments/resolved` (gated `customers.view`, like the plain
assignment-list GET beside it). Task 5's `GET .../template-assignments` (listAssignments) is left
untouched.

### The picker — pure display logic + the component

- **`src/lib/template-assignment-picker.ts`** (client-safe, node-testable): `buildPickerRow(display,
  names)` maps a docType's resolved state to its never-blank state label (§5.15), the select's
  selected value, `hasOwnAssignment`, and the option list — this docType's live templates, each
  never-published one `disabled` with the `UNPUBLISHED_OPTION_TITLE` (§5.16). `stateLabelFor`
  renders "Assigned: X" / "Inherited from CODE — Name: X" / "<Type> default (Standard)". Pure — no
  DB, no React.
- **`src/app/customers/[id]/TemplateAssignmentsSection.tsx`**: the section, wired into the customer
  page after Surcharge overrides. Both gates (`customers.edit` + `edit_templates`,
  disabled-with-reason naming whichever is missing — the SurchargeOverridesSection two-gate
  precedent). Names from the `requireUser`-only read, resolved state from the customers.view resolved
  read, both loaded on mount (mount-failure reported through the page's `optionsError` channel, not
  the shared banner it would clear itself). Selecting a template PUTs; the "Use default / inherit"
  option DELETEs (only when an own assignment exists); mutations serialize through one queue and
  reload the resolved state on their own turn (§5.13 reload-then-report on failure).

### §5.15 / §5.16 handling

- §5.15 (never silent-empty, never blank): the state is served by the `customers.view` resolved read
  and the names by the `requireUser`-only read, so a `customers.edit`-without-`templates.view` user
  still sees every docType's state and dropdown. Every docType always shows a state (own / inherited
  / default) — the resolved read returns all 8.
- §5.16 (disabled-with-reason): the whole control is disabled naming the missing permission; a
  never-published template's option is disabled with its tooltip. The routes ENFORCE both — the UI
  matches, it is not the gate.

## RED evidence

- **Pure display logic** (`tests/template-assignment-picker.test.ts`): first run failed at module
  resolution (`Cannot find module '@/lib/template-assignment-picker'`), then 7/7 green after the lib
  landed.
- **Service + routes** (`tests/template-assignments.test.ts`): the added `resolvedRoute` import
  failed module resolution (whole file RED — "Cannot find module
  '@/app/api/customers/[id]/template-assignments/resolved/route'"); the names-projection assertion
  was tightened to require `published` (RED against the 3-key projection) and a never-published
  `published:false` case added. After implementing: 40/40 in this file — including the 6 new
  cases (published boolean present + false-for-never-published, the resolved route's
  view/403/401 gates, and the display resolver's own/inherited/default/shared-walk-parity tests).
  The refactor kept every existing `resolveTemplateForPrint` test green.

## Gate results (watched to completion, from each run's own output)

All on final HEAD `c2747fa` (the docs/report commit is additive `.md` only — no code gate moves).

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2741/2741, 148 files** (baseline 2728/147 — +13 tests: 7 pure picker + 6 in template-assignments; +1 file) | 266.0s |
| `npx tsc --noEmit` | clean | 2.1s |
| `npx eslint src tests` | clean | 10.3s |
| `npm run build` | exit 0; `/api/customers/[id]/template-assignments/resolved` in the manifest | 21.4s |
| E2E | **20/20 PASS, EXIT:0** (detached from the start, per-task sentinel `e2e-task20.done`; result read from the run's own log — 20 PASS lines + "All 20 flows passed" + `templates-admin PASS` + "cleanup ok") | ~4.5 min |

Dev-DB fixture hygiene verified after the run: 0 customers, 0 `E2E Doc Template` templates, 0
`CustomerTemplateAssignment` rows (live OR soft-deleted — the teardown sweep worked), 0 `ClosePeriod`
rows, 8 seeded defaults intact.

## Decisions and deviations

1. **The display resolver is new service logic — the brief-sanctioned genuine gap.** It reuses the
   §5.2 rule via the shared `resolveAssignment` (extracted from the print resolver) rather than
   composing `listAssignments` client-side, because a client composition only reaches ONE ancestor
   hop and can't name the default template — the spec wants nearest-ANCESTOR (deep trees sensible).
   The extraction is what keeps resolution defined once.
2. **A separate `.../resolved` endpoint, not a change to Task 5's GET.** The plain
   `GET .../template-assignments` (listAssignments) is left byte-identical so its Task 5 tests stay
   exactly green; the richer display read is additive.
3. **The E2E teardown reap now sweeps `CustomerTemplateAssignment` first.** The flow now creates one
   (RESTRICT FK into both DocumentTemplate and Customer); `deleteDocumentTemplatesByName` clears it
   (scoped by fixture template id, soft-deleted rows included) before the version/template delete and
   before `deletePartsAndCustomers`, so assigned-then-cleared and crash-mid-assign both come out
   clean.

## Notes for Task 21 (restyle E2E flow, docs, final gates)

- The restyle flow (create draft from Standard traveler → upload logo + rename a label → preview →
  publish → print a real order's traveler → assert stored PDF markers + the `templateVersionId`
  stamp) is the roadmap's testable outcome; the picker E2E added here is separate (it exercises
  assign/clear, not print).
- Docs pass still owed: HANDOFF §4, CLAUDE.md's standing conventions, and closing #36/#43/#87/#97/#98
  from the branch. Carried Task-4 minor: CLAUDE.md's sample handler shape is stale (`requireUser()`
  is no-arg/synchronous — `mustCan(requireUser(), …)`, which this task's new routes already use).
- The customer page now has a `Document templates` section between Surcharge overrides and Standing
  notes; the picker's aria-labels are `Template for <Type>` (E2E selector).
