# Task 7 report — Admin → Surcharges page + routes

> **CONTROLLER CORRECTION — parts of this report describe code that no longer exists.** It was
> committed in `39a3372` and contradicted by `daf1cfd` in the same wave, so read it as the
> as-first-built record, not as a description of the tree.
>
> **The permission gates changed by owner ruling (2026-08-07).** Everywhere below that says POST
> and DELETE gate on `admin.edit` — including the rationale paragraph and the "every mutating
> control gates on `canEdit`" line — is superseded:
>
> - `POST   /api/admin/surcharges`      → `admin.create`
> - `PUT    /api/admin/surcharges/[id]` → `admin.edit`
> - `DELETE /api/admin/surcharges/[id]` → `admin.delete`
>
> matching every other admin CRUD list; the page's Add and Delete controls gate to match. The
> "Concerns: none outstanding" line covering the single-gate deviation is likewise superseded — the
> deviation was real, was escalated, and was ruled against.
>
> Two further changes landed after this text: saves are serialized through a `saveQueue`
> (`daf1cfd`), and `rowsRef` is now written unconditionally so a superseded load still hands queued
> runs fresh server truth (`cfe2d45`). Evidence for both is in `task-7-fix-wave-1-note.md`.
>
> The original wording is left intact rather than edited — it is the record of what the implementer
> built and why. (Re-review Minor 4.)

## What was implemented

Five routes under `src/app/api/admin/surcharges/**`, all thin `handle(...)` wrappers over Task
6's `src/server/surcharges.ts` (unmodified — this task only consumes it):

- `route.ts` — `GET` (`admin.view`, `listSurcharges({ includeInactive })`) / `POST` (`admin.edit`,
  `createSurcharge`).
- `[id]/route.ts` — `PUT` (`admin.edit`, `updateSurcharge` — hands the body straight through, no
  merge) / `DELETE` (`admin.edit`, `deleteSurcharge`).
- `[id]/step-codes/route.ts` — `PUT` (`admin.edit`, `assertRecord` then `setSurchargeStepCodes(id,
  body.stepCodeIds)`; the array shape itself is validated by the service's own zod parse, not
  re-checked in the route).
- `[id]/blockers/route.ts` / `[id]/blockers/export/route.ts` — straight copies of
  `step-codes/[id]/blockers(/export)/route.ts` with `"processStepCode"` swapped for `"surcharge"`,
  gated `admin.view`.

**Permission shape deviates from the step-codes precedent on purpose.** `step-codes/route.ts`
splits POST/PUT/DELETE across `admin.create`/`admin.edit`/`admin.delete`. The brief's Step 1
explicitly specifies a single `admin.edit` gate for POST/PUT/DELETE here, matching the newer
`/api/admin/billing` shape (`GET admin.view` / `PUT admin.edit`, no separate create/delete grant).
I followed the brief verbatim rather than the older step-codes pattern; billing is the closer,
more recent precedent for a small maintained-list admin screen.

`src/app/admin/surcharges/page.tsx` (new) — list-left/detail-right layout modelled on
`step-codes/page.tsx`'s structure (list, inline edit, needs-GL badge, blocker panel, history
panel), but the **save mechanics are deliberately different**, per the dispatch's Fix-1 warning.

`src/components/Shell.tsx` — added `{ label: "Surcharges", href: "/admin/surcharges" }` to the
`ADMIN` array (after "Billing"). No `/admin` index page exists or was created (per the dispatch's
resolution #1).

`src/lib/surcharge-percent.ts` (new) — `percentToDecimal`/`decimalToPercentText`, pulled out as
pure, unit-testable functions rather than inlined in the page, specifically so the round-trip
claim ("4 on screen stores 0.040000") has a test that would actually fail if it regressed.

## Design decision: the editor always posts the whole row

Every save on the detail pane goes through one function, `save(id, patch)`, which reads the
**freshest known row** from `rowsRef.current` (mirrors `rows` state, updated synchronously —
the `step-codes/page.tsx` `codesRef` precedent), merges in only the field(s) that actually
changed (`buildBody`, `src/app/admin/surcharges/page.tsx:56-72`), and PUTs the complete result.
`buildBody` also re-derives `rate`/`amount` from the row's *current* `kind` on every save (nulling
whichever the kind forbids) — see "Kind flips" below.

A patch never partially resembles a row: `buildBody` falls back to the row's stored value only
when the caller's `patch` key is `undefined` (not merely falsy), so a deliberate `null` (e.g.
clearing `glAccountId`) is never silently overwritten by the old value.

**Verification that this actually works** (not just "the code looks right" — traced through
network bodies against the running DEV server): I set `minimumAmount` to `75` and `active` to
`false` on a surcharge that also carried `rate: 0.04`, `scope: EXCLUDE`, and two step-code links.
I then edited **only** the unrelated `position` field (1 → 5) and re-fetched
`GET /api/admin/surcharges?includeInactive=1`. Result:

```json
{"rate":0.04,"minimumAmount":75,"scope":"EXCLUDE","position":5,"active":false,
 "stepCodeIds":["cmsiiv7cx...","cmsiivkh8..."]}
```

`minimumAmount` and `active` (and everything else) survived the position-only edit untouched —
this is the exact scenario the dispatch called out as Task 6's headline defect, now closed off at
the UI layer by never sending a partial patch.

## Kind flips are local-only until the paired field is edited

Switching `kind` (PERCENT ↔ FLAT) cannot be a valid save by itself — `SAVE`'s superRefine
(surcharges.ts) rejects a PERCENT row with no rate or a FLAT row with no amount. Rather than fire
a guaranteed-to-fail PUT on every kind toggle, `setKindLocal` updates `rows`/`rowsRef` only
(`page.tsx:142-153`, no network call). The next time the user edits the now-visible rate/amount
field, `save` reads the already-updated `kind` back off `rowsRef` and submits both together in one
PUT. `buildBody` still nulls the field the current `kind` forbids regardless of what's sitting in
`rows`, so a stale opposite-kind value can never leak onto the wire.

## Percent ↔ decimal conversion, and the "draft" bug this caught during implementation

`rate` is `Decimal(9,6)` (4% = `0.040000`); the screen shows and accepts a percent. My first draft
reformatted the displayed percent text on every keystroke by round-tripping it through
`percentToDecimal`/`decimalToPercentText`. That silently strips a typed trailing decimal point
(typing "4." immediately became "4" again before the next digit could land), making any non-integer
percent effectively untypeable. Caught this before it reached the browser by reasoning through the
render cycle, not by observing it live.

Fixed with a small `textDrafts: Record<string, string>` — literally only what the user has typed
for a field but not yet blurred, keyed by `${rowId}.${field}`, composed with the server value at
render time (`draftValue`, `page.tsx:91-93`) rather than held as a parallel editable copy of the
row. Applied to `rate`, `amount`, and `minimumAmount` (the three free-typed decimal fields);
`amount`/`minimumAmount` are sent to the wire as the **raw typed string**, not `Number(...)` —
`decimalField` on the server accepts a string directly, so no reformatting is needed on that side
at all. Cleared on selection change and after every save settles (success or failure).

### Percent round-trip — unit test (`tests/surcharge-percent.test.ts`, 4 tests, all pass)

- The brief's literal example both ways: `percentToDecimal("4") === 0.04`,
  `decimalToPercentText(0.04) === "4"`.
- A representative set (`"4", "2.5", "0.25", "100", "0.0001", "12.3456", "0"`) round-tripped
  decimal → percent → decimal and asserted **exactly equal** at each hop — this is the
  save-reload-save check, run as a fast unit test instead of only through the browser.
- Empty/unparseable input → `null`, not `NaN` or a thrown error.
- A percent with more precision than `rate`'s 6 fractional digits allows is fixed to 6, not passed
  through raw (`"12.34567"` → `0.123457`).

### Percent round-trip — browser (live DEV server, network bodies read directly)

1. Created a surcharge, rate `"4"` → `GET` showed `"rate":0.04`. ✓ (brief's exact example)
2. Reloaded the page fresh, re-selected the row: rate input displayed exactly `"4"`, not `"4.0"`
   or `"4.00"`.
3. Changed rate to `"2.5"` → stored `0.025`. Reloaded → input displayed exactly `"2.5"`.
4. Changed rate to `"12.3456"` (full 6-decimal precision) → stored `0.123456`. Reloaded → input
   displayed exactly `"12.3456"`, not `12.345600...` or any drifted value. This is the save →
   reload → save-again path the dispatch called out as the most likely real bug, and it held
   exactly across three consecutive round trips.

## Browser verification (live DEV server — see method note below)

**The Browser pane could not composite frames** (`screenshot` timed out: "the Browser pane is not
displayed, so the page is not compositing frames"), a known limitation of this environment stated
in the dispatch. Coordinate-based `computer` clicks and `type` actions were also unreliable against
this page's controlled React inputs — text landed on the wrong field or accumulated across fields,
and (more informatively) synthetic `.focus()`/`.blur()` calls did not reliably fire React's
`onBlur` at all, apparently because the tab is not OS-focused in this headless setup (native
`blur`/`focus` don't bubble; I confirmed the fix was dispatching explicit `focusin`/`focusout`
events, which is what React actually listens for). Once I switched to driving the DOM directly —
native input-value setter + `input`/`focusin`/`focusout` events, real `.click()` on
buttons/checkboxes/`<li>` rows — every interaction became reliable and I could read exact request
bodies and server state via `fetch()` from the page's own origin (real authenticated requests, not
mocked). All of the following are concrete, verified observations, not inference from reading the
code:

1. **Nav entry present**: `/admin/surcharges` link renders under "Admin" in `Shell.tsx`'s sidebar,
   between "Billing" and "Audit log".
2. **Create**: name "Energy Surcharge", kind PERCENT, rate "4" → `POST /api/admin/surcharges` 200,
   row appeared in the list with the "needs GL" badge (no GL account set).
3. **Scope + step codes, persistence across reload**: set scope to `EXCLUDE` (select's `onChange`
   fired a `PUT` immediately — `scope: "ALL" → "EXCLUDE"` in the audit log confirmed it), which
   revealed the "Applies to all operations except these" checklist. Checked two step codes (had to
   activate two pre-existing but inactive seed codes, AN/HT, since the picklist route is
   active-only and none were active — restored afterward, see Cleanup). Each checkbox toggle PUT
   `/api/admin/surcharges/{id}/step-codes` with the **whole** intended list. **Full page reload**,
   re-selected the row: `GET` showed `"stepCodeIds":["...HT...","...AN..."]` and both checkboxes
   rendered `checked: true` — confirmed via direct DOM read, not just the network body.
4. **Delete blocked by a customer rule, panel names and links it**: created a real customer (ACME)
   through `POST /api/customers`. No HTTP route exists yet for a customer's surcharge override
   (that's Task 8's scope), so I called the real `setCustomerSurcharge` **service function**
   directly (via a one-off `tsx` script, not raw Prisma — same audit trail and validation a route
   would produce) to opt ACME out of the surcharge. Clicked Delete (patched `window.confirm` to
   auto-accept, since a native `confirm()` dialog can't be driven by this tool): the delete was
   refused and the page rendered:
   `Cannot delete surcharge "Energy Surcharge Renamed" — 1 record(s) use it: Customer ACME · Acme Heat Treating`,
   with `Export list to Excel` and `dismiss`. Read the actual anchor elements: customer link
   `href="/customers/{ACME's real id}"`, export link
   `href="/api/admin/surcharges/{id}/blockers/export"`. Fetched the export URL directly:
   `200`, `content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
   `content-disposition: attachment; filename="Blockers.xlsx"`.
5. **Whole-row save, the dispatch's required check**: see "Design decision" above — confirmed with
   live network bodies against the running server, not inferred.
6. **Gating**: `canEdit = gate(perms, "admin.edit")` disables every mutating control with a title
   naming the missing permission (`§5.16`); not separately re-verified in the browser beyond the
   route-level 401/403/200 tests (`tests/surcharges.test.ts`), which do assert this precisely.

## Cleanup

Removed the delete-block: soft-deleted the `CustomerSurcharge` override via the real
`deleteCustomerSurcharge` service, then deleted the surcharge itself through the app's own Delete
button (soft-deleted — `deletedAt` set, confirmed the row disappeared from
`GET ?includeInactive=1`). Restored the two pre-existing seed step codes (AN, HT) to their
original `active: false` — I had flipped them to `true` only so the picklist route (active-only)
would return them for the multi-select test. Soft-deleted the ACME customer fixture through the
real `DELETE /api/customers/{id}` route with a reason. Final state: `surcharges: []`, `stepCodes`
both `active: false` (as found), customer no longer in the active list. No hard deletes were used
anywhere — every fixture went out the way the app itself removes/deactivates a row.

## TDD evidence

**RED** (`npx vitest run tests/surcharges.test.ts`, before the five route files existed):

```
Error: Cannot find module '@/app/api/admin/surcharges/route' imported from
'/home/cjones/Desktop/HeatSynQ/erp/tests/surcharges.test.ts'.
 Test Files  1 failed (1)
      Tests  no tests
```

**GREEN** (same command, after implementing the five routes):

```
✓ tests/surcharges.test.ts (25 tests) 1921ms
 Test Files  1 passed (1)
      Tests  25 passed (25)
```

The 8 new route tests (401 unauthenticated / 403 without the right permission / 200 with it, for
GET+POST on the collection, PUT+DELETE on `[id]`, PUT on `[id]/step-codes`, GET on
`[id]/blockers(/export)`) live in two new top-level `describe` blocks appended to
`tests/surcharges.test.ts`, following the `billing-config.test.ts` route-test template
(`getReq`/`bodyReq`/`noBodyReq`/`withParams` helpers, `signInWith`).

## Gates

| Gate | Result |
|---|---|
| `npx vitest run tests/surcharges.test.ts` | 25/25 pass |
| `npx vitest run tests/surcharge-percent.test.ts` | 4/4 pass |
| `npm test` (full suite) | **1476/1476 pass**, 101 files |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean — `/admin/surcharges` (static) and all five `/api/admin/surcharges/**` routes (dynamic) present in the route manifest |
| `npm run test:e2e` | **15/15 flows pass** |

## Files changed

- `src/app/api/admin/surcharges/route.ts` (new)
- `src/app/api/admin/surcharges/[id]/route.ts` (new)
- `src/app/api/admin/surcharges/[id]/step-codes/route.ts` (new)
- `src/app/api/admin/surcharges/[id]/blockers/route.ts` (new)
- `src/app/api/admin/surcharges/[id]/blockers/export/route.ts` (new)
- `src/app/admin/surcharges/page.tsx` (new)
- `src/lib/surcharge-percent.ts` (new)
- `src/components/Shell.tsx` (modified — one nav entry)
- `tests/surcharges.test.ts` (modified — 8 route tests appended)
- `tests/surcharge-percent.test.ts` (new)

## Self-review findings (fixed before reporting)

- Initial `SaveFields` type derived via `Pick<Surcharge, ...>` couldn't represent "send the raw
  typed string for a decimal field" without `Surcharge` itself lying about its own shape (server
  responses are always `number | null`). Redefined `SaveFields` as its own type
  (`number | string | null` for `rate`/`amount`/`minimumAmount`) and rewrote `buildBody` to merge
  field-by-field with explicit `!== undefined` checks instead of an object spread, which also
  sidesteps a TS inference trap where a spread of a `Partial<T>` patch widens the merged type to
  include `undefined`.
- Caught and fixed the reformat-while-typing bug (see "textDrafts" above) during implementation,
  before it ever reached the browser — verified afterward that typing "12.3456" actually lands
  correctly rather than losing its decimal point mid-entry.
- `position`'s onBlur originally read `current.position` (a stale render-time closure value)
  instead of parsing the blur event's own `e.target.value`; changed to parse directly from the
  event, matching every other field's pattern, so it can't be one render behind.

## Concerns

- None outstanding. The one deliberate deviation from the literal step-codes precedent (a single
  `admin.edit` gate for POST/PUT/DELETE, versus step-codes' split create/edit/delete) is called
  out above with its reasoning; it matches the brief's explicit route-test spec and the more
  recent `/api/admin/billing` precedent, so I read it as intentional rather than an error to flag
  back.
