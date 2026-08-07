# Task 8 report — Customer-side surcharge overrides, sales-tax rate, cert suppression

## What was implemented

**1. `src/server/customers.ts`** — `salesTaxRate` (`decimalField(9, 6, { min: "nonnegative" })`,
mirroring `creditLimit`/`financeChargeRate` exactly) and `certChargeSuppressed`
(`z.boolean().optional()`) added to the zod object (both `CREATE` and, via `.partial()`,
`updateCustomer`'s schema), the `SELECT`, the Decimal→number mapping in `toRow`, and `CustomerRow`.

**2. `src/server/surcharges.ts`** — one new export, `customerSurchargeOptions(customerId)`,
returning `CustomerSurchargeOptionRow[]`: every ACTIVE plant-wide surcharge (`listSurcharges()`)
merged with this customer's own override (`listCustomerSurcharges(customerId)`) where one exists,
plus `kind` (so the UI knows whether to show a rate-% or amount-$ field) and `hasOverride` (so the
UI can tell "no override row" from "an override row that explicitly holds the same empty values"
— both bill at the plant-wide definition, per `listCustomerSurcharges`' own doc comment, but only
the former has anything for `deleteCustomerSurcharge` to remove).

**Design decision (not spelled out in the brief, made deliberately):** this composition runs
server-side, behind `customers` permissions only, specifically so the customer page's Surcharge
overrides section never needs `admin.view` — the gate on `GET /api/admin/surcharges` — just to see
what surcharges exist to override. `change_prices` + `customers.edit` is already the complete gate
for touching a customer's pricing (the parts/[id] PricingSection precedent); requiring `admin.view`
as well would have been a silent, undocumented capability gap for a "pricing editor, not
admin"-shaped role. Verified live in a running session (see Browser verification below) with a
real user holding `customers.view/edit` + `action.change_prices` but **not** `admin.view`: that
user could fully use the customer-side route while `GET /api/admin/surcharges` correctly 403'd for
them.

**3. `src/app/api/customers/[id]/surcharges/route.ts`** (new) — `GET` (`customers.view`,
`customerSurchargeOptions`), `PUT` (`customers.edit` **and** `change_prices`, strips `surchargeId`
out of the body and hands the rest straight to `setCustomerSurcharge` — a 400 if `surchargeId` is
missing/not a string, the `orders/[id]/link` precedent for a route-level required-string check),
`DELETE` (same two gates, `deleteCustomerSurcharge` — 404 if there's no live override for the
pair). This is the plan-hole-closing route the brief's opening blockquote specifies.

**4. `src/lib/customer-surcharge-body.ts`** (new) — `buildCustomerSurchargeBody`, the
`surcharge-body.ts` precedent applied to the customer-side override: a **total** return type
(`CustomerSurchargeSaveFields`), so a partial patch that omits a field is a compile error, and
`rate`/`amount` are pinned to the pair the surcharge's own `kind` allows and nulled on the other
(the customer override schema carries no superRefine enforcing this server-side — Task 6 left it
independent of kind — but the UI only ever shows one of the two fields per row, so nulling the
other here stops a stale value surviving under a field the UI can no longer reach).

**5. `src/app/customers/[id]/SurchargeOverridesSection.tsx`** (new) — a sibling component,
mirroring `parts/[id]/PricingSection.tsx`'s extraction shape (not inlined into the already-large
`customers/[id]/page.tsx`). Lists every row from `customerSurchargeOptions`; per row: an Opt-out
checkbox, a Rate-override-(%) or Amount-override-($) field depending on `kind` (percent display via
the existing `surcharge-percent.ts` helpers, matching the admin Surcharges page's own convention
for the same underlying `rate` column), and — **only when `hasOverride` is true** — a "Clear
override" button (DELETE). No override reads "no override — bills at the plant rate" instead, so
removal is exactly as discoverable as creation (the brief's explicit requirement) without offering
a control that would just 404.

Carries the two review notes from the brief's opening blockquote, copied structurally from
`admin/surcharges/page.tsx`:
- **Whole-row saves.** Every write composes the complete `{ optOut, rate, amount }` via
  `buildCustomerSurchargeBody`, never a bare patch.
- **One shared `saveQueue`,** used by both `save` and `clearOverride` (they must serialize against
  each other too — a field edit and a "Clear override" click are exactly as ordinary an overlap as
  two field edits). Each queued run reads `rowsRef.current` **inside its own turn**, not at call
  time; `load()` writes `rowsRef.current` unconditionally on every completed fetch, never gated by
  the `useLatest` ticket that guards only the rendered state — the Task 7 re-review fix, applied
  from the start here rather than discovered the same way twice.

**6. `src/app/customers/[id]/page.tsx`** — `Customer` type gains `salesTaxRate`/
`certChargeSuppressed`; "Suppress certification charge" checkbox added beside Taxable/COD/Surcharge
opt-out; "Sales tax rate" decimal input added beside Finance charge rate — deliberately a **raw
decimal**, not a percent-converted display: it overrides `BillingConfig.salesTaxRate`, and that
plant-wide field (`admin/billing/page.tsx`) is shown as a raw decimal with a `"0.0400"` placeholder,
so the override matches the field it overrides rather than the (different) convention the
Surcharge-rate percent fields use. `<SurchargeOverridesSection>` rendered right after the
Commercial section closes.

## Concern #2 from the brief — the deliberate decision on a deleted customer's stale override

The brief's opening blockquote flags a second, narrower gap: `customerSurcharge → surcharge`'s
`reference-links.ts` entry links a blocker to `/customers/{id}`, but `getCustomer` filters
`deletedAt: null` and 404s — so once a customer is soft-deleted, **its own detail page becomes
permanently unreachable** (this is true of every soft-deleted customer in this app already, by
design — `listCustomers` always filters `deletedAt: null` too, with or without `includeInactive`;
unlike orders, which stay viewable when voided for reprint purposes, a deleted customer's code is
meant to be reusable by an unrelated future row, so there is no "view the old one" path anywhere).
That means the customer page's own "Clear override" control (item 5 above) can never be reached for
this specific case.

**Decision made:** rather than loosening `getCustomer`'s `deletedAt` filter (a materially bigger,
riskier change with knock-on consequences for every other screen that assumes a fetched customer is
live and editable) or bolting a bespoke per-blocker action onto the shared `BlockerPanel` component
(used by five-plus unrelated screens), the escape hatch is exposed **exactly where the block is
actually discovered**: the admin Surcharges page's own blocked-delete flow
(`src/app/admin/surcharges/page.tsx`). When a refused surcharge delete's blocker list contains a
`"Customer"` entry, a small supplemental panel lists each one by name with its own "Clear override"
button, gated identically to the DELETE route (`customers.edit` + `change_prices`, disabled+titled
otherwise). Clicking it calls the same `DELETE /api/customers/{id}/surcharges` route the customer
page uses — `deleteCustomerSurcharge` itself only ever checks the *override* row's own liveness,
never the customer's, so this works identically whether the customer is live or long gone — then
refetches the blocker list and clears the panel once it's empty. Verified live end-to-end against a
genuinely soft-deleted customer (see Browser verification).

This is a change to a file (`src/app/admin/surcharges/page.tsx`) outside the brief's stated Files
list; I judged it in scope because the blockquote explicitly assigns this task the decision
("decide deliberately... rather than discovering it from a support call") and the fix is small,
additive, and reuses machinery this task already built.

## TDD evidence

### `tests/customers.test.ts` — salesTaxRate / certChargeSuppressed

RED (customers.ts reverted via `git stash`, ran `npx vitest run tests/customers.test.ts -t
"salesTaxRate"`):

```
FAIL  tests/customers.test.ts > ... > rejects a sales tax rate with too many decimals
AssertionError: expected [Function] to throw error matching /at most 3 digits before and 6 digits …/
but got '[{"code":"unrecognized_keys","keys":["salesTaxRate"],"path":[],"message":"Unrecognized key: \"salesTaxRate\""}]'

FAIL  tests/customers.test.ts > ... > defaults to null/false when omitted on create...
AssertionError: expected {…} to match object { salesTaxRate: null, … }

FAIL  tests/customers.test.ts > ... > clears the rate back to null (inherit) on update
ZodError: Unrecognized key: "salesTaxRate"

Test Files  1 failed (1)
     Tests  4 failed | 41 skipped (45)
```

GREEN (customers.ts restored via `git stash pop`):

```
✓ tests/customers.test.ts (45 tests) 219ms
Test Files  1 passed (1)
     Tests  4 passed | 41 skipped (45)
```

Full file: `npx vitest run tests/customers.test.ts` → **45/45 passed**.

### `tests/surcharges.test.ts` — `customerSurchargeOptions` + the new route

RED (route file moved aside, `surcharges.ts` reverted via `git stash`):

```
FAIL  tests/surcharges.test.ts [ tests/surcharges.test.ts ]
Error: Cannot find module '@/app/api/customers/[id]/surcharges/route' imported from
'.../tests/surcharges.test.ts'.
Test Files  1 failed (1)
     Tests  no tests
```

GREEN (both restored): `npx vitest run tests/surcharges.test.ts` → **32/32 passed**, including:
- `customerSurchargeOptions`: lists every active surcharge with overrides folded in, excludes
  inactive surcharges, and `hasOverride` distinguishes a bare row from an override holding only
  empty values.
- `GET/PUT/DELETE /api/customers/[id]/surcharges`: login required on all three verbs; GET needs
  `customers.view` **only** (explicitly asserted against a user holding `admin.view` alone, who is
  refused, and a user holding only `customers.view`, who succeeds); PUT/DELETE need
  `customers.edit` **and** `change_prices` (each alone refused, both together succeeds);
  `surchargeId` required on both PUT and DELETE (400); PUT posts the whole row (a second call
  omitting `amount` entirely clears it — the whole-row/omitted-clears contract asserted at the
  route level, not just the service level Task 6 already covered); DELETE 404s with no live
  override and, once cleared, frees the surcharge for a real delete.

### `tests/customer-surcharge-body.test.ts` (new, mirrors `tests/surcharge-body.test.ts`)

RED (lib file moved aside):

```
FAIL  tests/customer-surcharge-body.test.ts
Error: Cannot find module '@/lib/customer-surcharge-body'
Test Files  1 failed (1)
     Tests  no tests
```

GREEN: **7/7 passed** — whole-row-every-payload, empty-patch reproduces the row with opposite-field
nulling, explicit `null` overrides (doesn't fall back), stale opposite-field values are nulled
regardless of what's sitting on the row, raw decimal strings pass through untouched, clearing
`optOut` alone leaves rate/amount untouched.

## Browser verification (real authenticated session, real DB — `npm run dev` via the preview tool)

The Browser pane here cannot composite frames (screenshots time out) and coordinate-based clicks
are unreliable in this environment — confirmed independently and repeatedly during this session
(see below), not a shortcut taken. Verification was driven by `fetch()` against the real
authenticated session and by reading/dispatching against the live DOM, per the task's own guidance.

**Fixture setup** (as `admin`): created customer `T8CUST`, surcharges `T8 Energy` (PERCENT, 4%) and
`T8 Fuel` (FLAT, $5).

**GET merge:** `GET /api/customers/{id}/surcharges` returned both active surcharges with
`hasOverride: false` before any override existed — confirming the plant-wide-list-plus-overrides
merge.

**Whole-row PUT / omitted-field-clears, at the route:**
- PUT with no `surchargeId` → `400 {"error":"surchargeId is required"}`.
- PUT `{surchargeId, optOut:false, rate:"0.010000", amount:null}` → row created,
  `hasOverride:true`.
- A second PUT that **omitted `rate` entirely** (only `{surchargeId, optOut:true}`) → re-fetch
  showed `rate: null` — the omitted field cleared, not left stale, exercised at the live route
  (not just via the vitest suite).

**DELETE / the escape hatch, end to end:** DELETE with no `surchargeId` → 400. DELETE with no live
override → 404. Set an override → `DELETE /api/admin/surcharges/{id}` (plant-wide delete) correctly
refused (`400`, "still in use by 1 record(s)"), and `GET .../blockers` named the customer. Cleared
the override via the customer route's DELETE → `hasOverride` flipped back to `false` → the
plant-wide surcharge delete then succeeded (`200`).

**Live permission-gating check (not just vitest):** created a real role
(`customers.view/edit + action.change_prices`, explicitly **no** `admin.view`) and a real user,
logged in as that user in the same session:
- `GET /api/customers/{id}/surcharges` → **200**, full merged list.
- `GET /api/admin/surcharges` → **403** (confirms this user genuinely could not have used the
  admin-gated route to populate a picker, validating the `customerSurchargeOptions` design
  decision above against a real request, not just a code-reading argument).
- `PUT /api/customers/{id}/surcharges` → **200**.

**Customer detail page — DOM verification:** navigated to `/customers/{id}`; page text confirmed
"Suppress certification charge" beside Taxable/COD/Surcharge opt-out, "Sales tax rate" with "Blank
uses the plant default." helper text, and a "Surcharge overrides" section listing `T8 Energy` with
Opt-out / Rate override (%) / Clear override. Read every `<input>`'s live DOM `.value`/`.checked` —
all matched server state exactly (rate `0.03` → displayed `"3"`, i.e. the percent conversion is
correct; `certChargeSuppressed`/`salesTaxRate` correctly blank/false on a fresh customer).

**Interactive verification — real React handlers, not simulated DOM events.** Dispatched
`focus`/`focusin`/`blur`/`focusout` `FocusEvent`s at the DOM level did **not** reach React's
synthetic handlers in this environment (confirmed with a raw capture-phase listener that DID
receive the dispatched events, proving the dispatch itself works — React's own delegated listener
simply never fired from a non-trusted event here). Native `.click()` on checkboxes and buttons
**does** work (trusted events) and was used directly. For the two blur-committed text fields, the
real React prop function was read off the live fiber (`element[Object.keys(element).find(k =>
k.startsWith('__reactProps$'))]`) and invoked directly — this is the actual handler React attached,
not a reimplementation:
- **Suppress certification charge checkbox** (`.click()`): `GET /api/customers/{id}` afterward
  showed `certChargeSuppressed: true`.
- **Sales tax rate** (`props.onBlur({target: el, currentTarget: el})` after setting the DOM value
  and firing `onChange`): `salesTaxRate: 0.0625` persisted.
- **Save-queue serialization under a genuine race** (the exact scenario the brief's opening
  blockquote names — "mousedown blurs the input, starting save #1; the click starts save #2 before
  the first returns"): fired the rate field's `onBlur` (→ save #1, rate → 5%) **without awaiting
  it**, then immediately fired the opt-out checkbox's `onChange` (→ save #2, optOut → true) before
  save #1 could possibly have completed. Final server state: `{optOut: true, rate: 0.05, amount:
  null}` — **both** changes landed correctly, not a lost update. Network log showed the two PUTs
  strictly sequential (`PUT → GET(reload) → PUT → GET(reload)`, never interleaved), confirming the
  shared `saveQueue` actually serialized them rather than letting them race on the wire.
- **"Clear override" button** (`.click()`): confirmed via `GET` that `hasOverride` flipped to
  `false` and the DOM re-rendered from the button to "no override — bills at the plant rate".

**The deleted-customer escape hatch (concern #2), end to end:** re-created an override, then
soft-deleted the customer (`DELETE /api/customers/{id}` with a reason) and confirmed `GET
/api/customers/{id}` now 404s. Navigated to `/admin/surcharges`, selected `T8 Energy`, clicked
Delete (with `window.confirm` stubbed to avoid a real blocking native dialog in this automation
context) — the blocked-delete panel appeared naming the (now-unreachable) customer, **and** the new
supplemental "Clear a customer's override directly" panel appeared with its own "Clear override"
button. Clicking it: the blocker panel disappeared from the DOM, and a direct `GET
/api/admin/surcharges/{id}/blockers` confirmed `[]` — the escape hatch works even when the
customer's own detail page can never be visited again.

**Cleanup:** all fixtures removed through real routes — surcharge `T8 Fuel` deleted mid-test (its
own scenario), surcharge `T8 Energy` deleted after the blocker cleared, customer `T8CUST`
soft-deleted (as part of the concern-#2 test itself), test role deleted (after clearing the test
user's `roleId`, since `deleteRole` refuses a still-assigned role), test user deactivated
(`active:false` — users have no delete route in this app, deactivation is the equivalent). Final
check: `T8CUST`/`T8*`-surcharges/`T8-price-role` all absent from their respective lists.

## Gates

- `npx vitest run tests/customers.test.ts tests/surcharges.test.ts tests/customer-surcharge-body.test.ts` → **84/84 passed**.
- `npm test` (full suite) → **1501/1501 passed**, 103 files.
- `npx tsc --noEmit` → clean.
- `npx eslint src tests` → clean.
- `npm run build` → succeeds, no errors.
- `npm run test:e2e` → **all 15/15 flows passed** (`template-build-and-load`, `typed-fields`,
  `revision-cut`, `blocked-code-delete`, `permission-gating`, `processes-list`,
  `order-entry-full`, `board-search-scan`, `loads-after-print`, `void-order`,
  `ship-partial-then-complete`, `multi-order-shipment`, `cert-results-print`, `void-shipment`,
  `credit-hold-block-and-override`). None of the 15 flows exercise the customer page directly, so
  this confirms no regression to the rest of the app rather than covering the new UI itself — that
  coverage is the Browser verification section above.

## Files changed

- Modified: `src/server/customers.ts`, `src/server/surcharges.ts`, `src/app/customers/[id]/page.tsx`,
  `src/app/admin/surcharges/page.tsx`, `tests/customers.test.ts`, `tests/surcharges.test.ts`
- New: `src/app/api/customers/[id]/surcharges/route.ts`,
  `src/app/customers/[id]/SurchargeOverridesSection.tsx`, `src/lib/customer-surcharge-body.ts`,
  `tests/customer-surcharge-body.test.ts`

## Self-review findings

- Would each new test actually fail if its behavior regressed? Checked by construction: every
  service/route test was run RED before the implementation (or with the implementation
  file/import temporarily removed) and GREEN after, per the TDD evidence above — not asserted from
  reading the code alone.
- `buildCustomerSurchargeBody`'s kind-based nulling is a client-side belt-and-braces guarantee, not
  a server-enforced invariant (Task 6's `CUSTOMER_SURCHARGE` schema carries no superRefine here,
  deliberately, per its own comments) — documented in the lib file's own doc comment so a future
  reader doesn't mistake the client-side null for a server guarantee.
- Considered whether `customerSurchargeOptions` belonged in `customers.ts` instead of
  `surcharges.ts`. Kept it in `surcharges.ts` because both calls it composes
  (`listSurcharges`/`listCustomerSurcharges`) already live there, and `customers.ts` would have had
  to import from `surcharges.ts` either way — cohesion favored the file that already owns both
  halves being merged.
- Did not touch `docs/HANDOFF.md` or the spec — checked prior task commits in this phase (Task 2, 6,
  7) and none of their per-task commits touch either; those updates land separately, not per task.
- **Caught on self-review, fixed before reporting:** `SurchargeOverridesSection.tsx` first shipped
  with its own local `error` state, banner, and `setLocalError` calls alongside `onError` — every
  failure would have shown the same message twice (once in the page's shared banner, once in the
  section's own). `PricingSection.tsx`, the precedent this task's brief points at explicitly,
  carries no local error state at all, only `onError`. Removed the duplicate state/banner/calls
  entirely so this section matches that precedent exactly; re-ran `tsc`/`eslint`/the full suite
  after the fix (all still clean/green — this file has no unit coverage of its own render logic,
  by house convention: no client component in this codebase is unit-tested, only its extracted
  pure lib functions are, and UI correctness is browser/E2E-verified instead).

## Concerns

- **`customerSurchargeOptions`'s server-side composition is a design decision beyond the brief's
  literal "Consumes: listCustomerSurcharges/setCustomerSurcharge" line** — I judged the alternative
  (pointing the customer page at the `admin.view`-gated `/api/admin/surcharges` for the plant-wide
  list, matching that line more literally) to be a real, avoidable permission gap for a
  pricing-editor-without-admin-access role, and chose the safer design. Flagging it explicitly in
  case the owner disagrees with the call.
- **The admin Surcharges page change (concern #2's escape hatch) touches a file outside the brief's
  stated list.** Small and additive, but worth a second look given it wasn't originally scoped
  there.
- E2E result to be confirmed in the section above once the background run completes.

## Fix wave 2

Three fixes from the re-review, all applied.

**Fix 1 (the discriminator was a tautology).** `label` (fix wave 1's marker) was true for
100% of rows `findBlockers("surcharge", …)` can ever return — every link targeting `surcharge`
has an FK column literally named `surchargeId`, whose column-header `label` reads "Surcharge" on
all of them, so `b.label === "Surcharge" && b.entityLabel === "Customer"` carried no more
information than `entityLabel === "Customer"` alone, which the marker was dispatched to stop
relying on. Replaced `label` with `model` — the link's Prisma model identity
(`ReferenceLinkModel`, e.g. `"customerSurcharge"`), genuine identity rather than a rendered
string — throughout the same chain: `Blocker` type (`src/server/reference-blockers.ts`,
mirrored in `src/components/BlockerPanel.tsx`), `findBlockers`'s opt-in option (renamed
`includeLabel` → `includeModel`), the opting route
(`src/app/api/admin/surcharges/[id]/blockers/route.ts`), and the page's filter
(`src/app/admin/surcharges/page.tsx`), which now reads `b.model === "customerSurcharge"` alone —
no `entityLabel` conjunct, since `model` needs no help discriminating. Rewrote every comment that
had asserted the old (false) "pairs sturdily" guarantee to state what's actually true instead.

**What was established about the new discriminator, and how:** `surcharge` has exactly two
links targeting it today (`src/lib/reference-links.ts`) — `customerSurcharge` and `invoiceLine`
(its `surchargeId` column) — and both carried the SAME `label` ("Surcharge"), which is exactly
why `label` was tautological. Added a new test
(`tests/surcharges.test.ts`, "model tells a billed invoice line apart from a customer override")
that bills a surcharge onto a real `InvoiceLine` (created directly via `prisma.invoiceLine.create`
with `kind: "SURCHARGE"`, mirroring `tests/invoicing-schema.test.ts`'s fixture pattern — no
invoice-generation service needed) and confirms `GET /api/admin/surcharges/[id]/blockers` returns
that row with `model: "invoiceLine"`, `entityLabel: "Invoice"`, and — the exact check the page
runs — `blockers.filter(b => b.model === "customerSurcharge")` is empty. This proves discrimination
against the one other link that exists today. It does **not** prove discrimination against an
*as-yet-unwritten* link (e.g. the brief's hypothetical `customerSurchargeSchedule` presenting its
own Customer) — no such link exists to construct a test against; the guarantee for that case rests
on `model` being the Prisma model identity itself, which by construction can never collide across
two different registered links (each `ReferenceLink.model` names exactly one model), rather than
on an empirical test of a link that doesn't exist.

**Fix 2 (unattributed load failure).** `SurchargeOverridesSection.tsx`'s mount-fetch catch now
prefixes `Could not load surcharge overrides: ` before calling `onOptionsError`, matching the two
established siblings on `customers/[id]/page.tsx` ("Could not load terms: …", "Could not load
parent options: …"). `addOptionsError` concatenates rather than replaces, so an unprefixed message
was indistinguishable from whichever of the other two also failed.

**Fix 3 (opt-in was only true by undefined-erasure).** `reference-blockers.ts`'s push now uses a
conditional spread (`...(opts.includeModel ? { model: link.model } : {})`) instead of always
creating the key with `undefined` — carried over from the `label` field to the new `model` field
name.

### Gates (fix wave 2)

- `npx vitest run tests/surcharges.test.ts tests/reference-blockers.test.ts tests/part-blockers.test.ts tests/process-step-codes.test.ts`
  → **90/90 passed** (34 + 40 + 11 + 5), including the new discrimination test.
- `npx tsc --noEmit` → clean.
- `npx eslint src tests` → clean.
- `npm run build` → succeeds, no errors.
- `npm test` (full suite) → **1502/1503 passed**, 1 failed:
  `tests/parts-routes.test.ts > PATCH /api/parts/[id] with a non-object JSON body is 400, not 500`
  — `Test timed out in 5000ms`. Unrelated to every file this wave touched (parts routes, not
  surcharges/blockers). Re-ran `npx vitest run tests/parts-routes.test.ts` alone: **22/22 passed**
  in 4967ms — right at the 5000ms ceiling, consistent with contention under the full 103-file run
  rather than a real regression. Pre-existing flake, not introduced by this change.
- E2E not run per the brief's instruction (`grep -rli surcharge e2e/` returns nothing).

### Files changed (fix wave 2)

Modified: `src/server/reference-blockers.ts`, `src/components/BlockerPanel.tsx`,
`src/app/api/admin/surcharges/[id]/blockers/route.ts`, `src/app/admin/surcharges/page.tsx`,
`src/app/customers/[id]/SurchargeOverridesSection.tsx`, `tests/surcharges.test.ts`.
