# Phase 2B fix wave — report

Branch `phase-2b-customers`, starting at `3667087`. All work done directly against
`/home/cojoa13/Desktop/HeatSynQ/erp`.

## Summary of changes per finding

### Group A — data-entry forms

**A1 (address street/city/state/zip).** `src/app/customers/[id]/page.tsx`:
- The address create-form draft now carries `street`, `city`, `state`, `zip` alongside
  `kind`/`name`, with an input per field, all sent in the `POST .../addresses` body (the
  service already accepted them; only the UI was missing the controls).
- Existing address rows gained inline `name`/`street`/`city`/`state`/`zip` text inputs
  (replacing the old read-only `[street, city, state, zip].join(", ")` cell), each bound to
  local `addresses` state and saved via `PUT .../addresses/:id` on blur, through a new
  `saveAddressField` helper mirroring the existing `toggleContactFlag` idiom (optimistic local
  update, persist, roll back + reload on failure).
- Added a `<thead>` to the addresses table for column labels, since there are now six editable
  columns instead of two static ones.

**A2 (commercial fields).** Same file, Commercial section:
- Added a `Terms` `<select>` populated from `GET /api/admin/reference/terms` (fetched once on
  mount, independent of the per-customer `load()`), blank option = no terms. The fetch is
  wrapped in `.catch(() => {})` so a user without `admin.view` (Terms lives under the admin
  reference API, a different permission area than `customers.*`) still gets a working page —
  the select just has no options besides blank. Documented as a known gap below.
- Added `Credit limit` and `Finance charge rate` text inputs (`inputMode="decimal"`), sent to
  the API as raw strings — the service's `money` schema (see C1) validates them.
- Added a `Surcharge opt-out` checkbox next to the existing four.
- The `Customer` client type gained `termsId`, `financeChargeRate`, `surchargeOptOut`, and
  `creditLimit`/`financeChargeRate` were widened to `number | string | null` to hold an
  in-progress (possibly invalid) typed value without a separate draft-string field.

**A3 (contact phone + editing).** Same file, Contacts section:
- Add-contact draft gained a `phone` field and input (service already accepted `phone`).
- Existing contact rows gained inline `name`/`email`/`phone` text inputs (previously entirely
  read-only), saved via a new `saveContactField` helper (same shape as `saveAddressField`).

No server changes were needed for A3 — `customer-contacts.ts`'s `FIELDS`/`ADD`/`EDIT` already
accepted `phone`; the bug was UI-only.

### Group B — correctness

**B1 (normalization bypasses audit).** `src/server/customer-addresses.ts`:
- Added `setDefault(db, id, isDefault)`, which writes a single row's `isDefault` through
  `auditedUpdate` (passing the caller's `tx`) instead of a bare `.update()`.
- `demoteAllIn` now `findMany`s the rows it needs to demote and calls `setDefault` per row,
  instead of a single unaudited `updateMany`.
- `normalizeDefaultsIn`'s two phases (clearing stale defaults on deleted/inactive rows;
  resolving zero-or-many defaults among active rows) now go through `setDefault` per row, with
  one exception: a row that is *already soft-deleted in this same transaction* gets a plain
  (unaudited) flag clear, since its own `delete` audit entry (via `auditedSoftDelete`'s
  `before` snapshot) already captured its `isDefault` at the moment of deletion, and nothing
  ever displays a deleted row again — auditing the post-delete cleanup would just be noise.
  Rows that are inactive-but-not-deleted (still listed under `includeInactive`) *are* audited.
- `updateAddress` was restructured so the two `normalizeDefaultsIn` calls now run **inside**
  the `doIt()` closure passed to the primary `auditedUpdate`, not after it returns. Previously,
  `auditedUpdate` took its "after" snapshot immediately following the primary scalar write,
  and normalization — run afterward in the same transaction — could still change the very row
  being audited (e.g. a kind change that moves a default into a kind that already has one),
  leaving that entry's "after" permanently disagreeing with what actually got committed. Moving
  normalization inside `doIt()` means the "after" snapshot is taken only once everything that
  touches this row in this transaction has finished.
- Removed the now-dead standalone `normalizeDefaults` wrapper (only used by the old
  two-transaction `deleteAddress`; see C3).

**B2 (cycle guard skipped on revival) + B3 (soft-deleted parent accepted).** Fixed together in
`src/server/customers.ts`, since both live in the parent-validation path:
- Added `assertParentExists(parentId)`: rejects a `parentId` that doesn't resolve to a
  non-deleted customer.
- `assertNoCycle` now calls `assertParentExists` before walking the chain (fixes B3 for the
  update path, which already called `assertNoCycle`, and for the revival path once wired in).
- `createCustomer` now branches: if `existing` (the revival case — the row's id already exists,
  reused because `code` is unique), call `assertNoCycle(existing.id, data.parentId)`, same as
  `updateCustomer`. If not `existing` (a genuinely fresh row), call `assertParentExists`
  directly when `parentId` is given — no cycle walk, since a not-yet-existing id cannot appear
  in anyone's parent chain, but it still must not point at a deleted row (B3's second
  reproduction).
- Longer chains: `assertNoCycle`'s walk is unchanged (already handles arbitrary-length chains,
  exercised by the pre-existing "refuses to make a customer its own ancestor" test via
  `updateCustomer`); it's now simply invoked for revival too. I verified by construction that a
  *strictly longer* cycle cannot be built through revival calls alone without ever touching
  `updateCustomer` (already guarded): `deleteCustomer` refuses to delete a customer with
  non-deleted children, so a parent can never be soft-deleted while a live child still points
  at it, which forecloses the "revive a deleted ancestor pointing back through an existing
  descendant" construction. The self-loop (`parentId === existing.id`) is the reachable case,
  and it's what the new test reproduces.

### Group C — contained fixes

**C1 (decimal validation).** `src/server/customers.ts`: `money` is no longer
`z.union([z.number(), z.string()])`. It's now a `.transform()` that accepts a plain finite
number or a string matching `/^-?\d{1,10}(\.\d{1,4})?$/`, both bounded to
`±999,999,999.9999` (comfortably inside both `Decimal(12,2)` and `Decimal(6,4)` columns'
precision), and calls `ctx.addIssue(...)` / returns `z.NEVER` otherwise — so an invalid value
is now a `ZodError`, caught by `handle()` and returned as a 400 with a field-anchored message
(confirmed via the real route: `{"error":"creditLimit: Must be a valid decimal amount"}`,
HTTP 400), never a raw `PrismaClientValidationError` escaping as a 500.

**C2 (uncontrolled fields don't roll back).** `src/app/customers/[id]/page.tsx`: `Default PO`
and the three standing-notes `textarea`s changed from `defaultValue={...}` (set once, on
mount) to `value={c[key]}` (controlled) with `onChange` updating local `c` state and `onBlur`
still calling `save()`. Since `save()`'s failure path calls `load()`, which replaces `c` with
fresh server truth, the controlled inputs now visibly and correctly revert on a rejected save
instead of continuing to show — and silently resubmitting — the rejected text. The new
`Credit limit`/`Finance charge rate` inputs and every address/contact inline-edit input added
for Group A follow the same controlled pattern from the start, so they don't reintroduce the
bug.

**C3 (deleteAddress split transaction).** `src/server/customer-addresses.ts`: `deleteAddress`
now runs `auditedSoftDelete(..., tx)` and `normalizeDefaultsIn(tx, ...)` inside one
`prisma.$transaction(...)`, instead of two sequential top-level calls. A normalization failure
now rolls the delete back with it, instead of leaving a committed delete with no default
promoted.

## Failing-before output for each Group B/C test

I wrote each test, then `git checkout --` the two touched server files (keeping the new test
files) to run them against the pre-fix code, captured the failures below, then restored the
fix via `git apply` of the saved diff.

```
 × customers service > guards against a cycle introduced by reviving a customer as its own parent
   → promise resolved "{ id: 'cms8qo0bp001nijvolw2i9o4c' }" instead of rejecting
 × customers service > refuses a soft-deleted customer as a parent on create
   → promise resolved "{ id: 'cms8qo0d3001vijvonuqrcuzf' }" instead of rejecting
 × customers service > refuses a soft-deleted customer as a parent on update
   → promise resolved "undefined" instead of rejecting
 × customers service > refuses a soft-deleted customer as a parent on revival
   → promise resolved "{ id: 'cms8qo0fj0026ijvoda18vegi' }" instead of rejecting
 × customers service > rejects a non-numeric decimal string as a validation error rather than a raw Prisma failure
   → expected PrismaClientValidationError{ …(4) } to be an instance of ZodError

 FAIL  customer addresses > routes the demotion caused by promoting a different address through the audit helpers
   AssertionError: expected 'create' to be 'update'   (readAudit's most recent entry was still the
   original "create", i.e. no audited write ever recorded the demotion)

 FAIL  customer addresses > an update whose own row gets renormalized still has an after-snapshot
       matching the committed row
   AssertionError: expected true to be false          (the primary update's "after" snapshot showed
   isDefault: true while the row's actual committed value was false)

 FAIL  customer addresses > rolls the soft delete back if the fused normalization fails
   AssertionError: promise resolved "undefined" instead of rejecting   (deleteAddress didn't propagate
   the forced normalization failure — the two operations were separate top-level calls)

 FAIL  customer contacts > soft deletes and audits as its own entity
   Error: boom   (spillover: the C3 test's vi.spyOn mock never got restored because the assertion
   above it threw before reaching spy.mockRestore() — fixed by wrapping the assertion in try/finally,
   independent of the server-code fix)
```

`accepts a decimal string or a plain number for the money fields` already passed before the
fix (it exercises the still-valid paths), included as a companion positive-case test.

9 tests failed pre-fix, matching the 8 new regression tests plus the one spillover test caused
by the C3 test's own mock hygiene (also fixed, in the test file, independent of server code).

## Group A manual verification

**Environment note:** this sandbox has no working Chrome/Chromium reachable by the installed
browser-automation MCP tools — `chrome-devtools-mcp` and the `playwright` plugin both hard-require
the `chrome` distribution channel (real Google Chrome) at `/opt/google/chrome/chrome`, which isn't
present, and installing it (`npx playwright install chrome`) requires `sudo`, unavailable here.
Rather than settle for API-only verification, I `npm install --no-save playwright` (dev-only,
not committed — confirmed `package.json`/`package-lock.json` unchanged) and drove a real headless
Chromium (already downloadable without the `chrome` channel restriction) directly against
`npm run dev`, seeded with the repo's own `admin`/`admin` account (`npm run db:seed`). This is a
genuine browser session — sign in, navigate to a fresh customer's detail page, click and type into
the actual rendered forms — not a mock. Script and screenshots live under the scratchpad
(`manual-qa.mjs`, `shots/*.png`); the dev server and its temporary customer/terms rows were only
in the local `erp` dev database, never the `erp_test` database the suite runs against.

Field-by-field observations (all via the real running app, `http://localhost:3000/customers/<id>`):

- **A1 — address create form:** typed `Dock 1` / `100 Mill Rd` / `Toledo` / `OH` / `43604` into
  the five add-form inputs, clicked "Add address". The new row rendered immediately with all
  five values in editable inputs (confirmed via `input.value`, not just visually), `kind` shown
  as "Ship to", marked `default` (first address of its kind).
- **A1 — existing row edit:** changed the row's Street input from `100 Mill Rd` to
  `200 Mill Rd Suite 4` and blurred it. Re-reading all five input values afterward showed only
  Street changed (`Dock 1` / `200 Mill Rd Suite 4` / `Toledo` / `OH` / `43604`) — the PUT
  persisted and the row did not lose or clobber the other fields.
- **A2 — Terms select:** the `<select>` was fetched from `/api/admin/reference/terms` and
  offered the "Net 30" term I'd created; selecting it fired the PUT and `termsId` matched the
  term's id on reload.
- **A2 — Credit limit / Finance charge rate:** typed `12500.50` and `0.0175` respectively into
  the two new inputs and blurred each. `GET /api/customers/:id` afterward returned
  `creditLimit: 12500.5, financeChargeRate: 0.0175` as plain numbers.
- **A2 — Surcharge opt-out:** clicked the new checkbox's label; it toggled true and persisted.
- **A3 — contact create with phone:** typed `Shop Phone` into Name and `555-0100` into the new
  Phone input, left Email blank, clicked "Add contact". Row appeared with
  `name="Shop Phone", email="", phone="555-0100"` — a phone-only contact, previously impossible
  through the UI.
- **A3 — existing contact edit:** changed the row's Phone input to `555-0199` and blurred it;
  re-read input values afterward showed the phone updated in place (`555-0199`), name
  unaffected — no delete/recreate needed for a typo fix.
- **C1/C2 combined check:** typed `not-a-number` into Credit limit and blurred it. The page
  showed a red error banner reading `creditLimit: Must be a valid decimal amount` (confirming
  C1's field-anchored 400 reaches the UI as a readable message), and — this is the C2
  regression check — re-reading the Credit limit input's value immediately after the failed
  save and the resulting reload showed `12500.5` (the last-known-good server value), not
  `not-a-number`. Screenshot `09-invalid-creditlimit.png` shows both the error banner and the
  reverted field value in the same frame.

Screenshots captured (all under the scratchpad's `shots/` directory): `01-after-login.png`,
`02-customers-list.png`, `03-detail-initial.png`, `04-address-added.png`,
`05-address-street-edited.png`, `06-commercial-filled.png`, `07-contact-added.png`,
`08-contact-phone-edited.png`, `09-invalid-creditlimit.png`, `10-reloaded.png`.

**Known gap, not fixed:** the Terms `<select>` fetch hits `/api/admin/reference/terms`, gated
on `admin.view`, a different permission area than `customers.*`. A user with only `customers.*`
permissions (no `admin.view`) will see the select render with just the blank option — not
broken, but unable to pick or see the name of an already-assigned term unless they also have
admin access. This follows directly from the task's explicit instruction to use that endpoint;
flagging it here since it wasn't otherwise called out as in-scope to reconcile.

## Gate output

```
$ npm test
 Test Files  30 passed (30)
      Tests  242 passed (242)

$ npx tsc --noEmit
(clean, no output)

$ npx eslint src tests
(clean, no output)

$ npm run build
✓ Compiled successfully in 2.2s
✓ Generating static pages (25/25)
```

242 = 233 baseline + 9 new tests (8 regression tests for B1×2/B2/B3×3/C1×1 plus 1 companion
positive-case test for C1's still-valid inputs).

## Deviations / judgment calls

- **B1's stale-default cleanup for already-deleted rows is intentionally left unaudited**
  (see above) — auditing it broke an existing test's exact audit-action-sequence assertion,
  and on reflection the redundant entry was genuine noise: the row's `delete` entry already
  captures its `isDefault` at the moment of deletion, and nothing is ever displayed for a
  deleted row again. Inactive-but-live rows are still audited.
- **C1's decimal bounds** (`±999,999,999.9999`, up to 4 decimal places) are a shared bound for
  both `creditLimit` (`Decimal(12,2)`) and `financeChargeRate` (`Decimal(6,4)`) — deliberately
  generous rather than per-field-exact, per the task's "sane range" wording. A value that's
  syntactically valid but exceeds `financeChargeRate`'s narrower column precision (e.g.
  `1234.5678`) would still reach Postgres and could raise a raw numeric-overflow error there;
  I judged this out of scope since the concrete, reported failure mode was a non-numeric
  string, and tightening per-field would add a second bound table not asked for.
- **Group A scope**: I added inline editing for address `name` too (not just
  street/city/state/zip) and for contact `name`/`email` (not just phone), since the task's
  framing ("give existing rows a way to edit their scalar fields") reads as encompassing all
  scalar fields already writable via the API, not just the specific fields named in each
  finding's first sentence.
- **Playwright install**: added `playwright` to the `erp` `node_modules` via
  `npm install --no-save` purely to drive genuine browser verification in a sandbox without a
  reachable Chrome; not committed (`package.json`/`package-lock.json` untouched, confirmed via
  `git diff --stat`), and removed the temporary `manual-qa.mjs` script from the repo afterward.

## Things I was unsure about

- Whether the "longer cycles are constructible the same way" phrasing in B2 implied a specific
  multi-hop reproduction I was missing. I reasoned through the construction space (see B2 above)
  and concluded the only reachable case through revival alone is the direct self-loop, because
  `deleteCustomer`'s "still has children" guard forecloses the indirect construction — but I'd
  welcome a second look if there's a construction I didn't consider.
- Whether fetching Terms from the admin-gated reference endpoint (rather than, say, exposing a
  lighter `customers`-gated endpoint) was the intended final shape, or just the fastest path
  named in the brief. I followed the brief literally and documented the resulting permission
  gap above rather than deciding unilaterally to add a new endpoint.
