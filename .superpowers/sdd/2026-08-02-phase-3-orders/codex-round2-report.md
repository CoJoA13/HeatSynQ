# Phase 2B round-2 fix wave — report

Branch `phase-2b-customers`, starting commit `896d454`. Six findings from the automated review
of the previous fix wave; all six addressed below.

## F1 (P2) — decimal validation didn't match column precision

**Root cause.** The shared `money` validator in `src/server/customers.ts` checked that a value
*was* a decimal (regex `^-?\d{1,10}(\.\d{1,4})?$`, magnitude ≤ 999,999,999.9999) but never that
it *fit the specific column it was headed for*. `creditLimit` is `@db.Decimal(12,2)` and
`financeChargeRate` is `@db.Decimal(6,4)` — two different precisions sharing one validator sized
for the looser of the two.

**Failing-before repro** (captured before any fix, via `npx vitest run tests/customers.test.ts -t
"..."` against the pre-fix code):

```
 × rejects a finance charge rate that overflows Decimal(6,4) ... 51ms
   → expected PrismaClientUnknownRequestError{ …(5) } to be an instance of ZodError
 × rejects a credit limit with more precision than Decimal(12,2) can hold ... 38ms
   → promise resolved "{ id: 'cms9ey29z000kijyuhlomtlrx' }" instead of rejecting
```

`financeChargeRate: "100"` threw a status-less `PrismaClientUnknownRequestError` (would escape
`handle()` as a bare 500). `creditLimit: "1.005"` was accepted silently — I additionally checked
by hand that this got rounded to `1.01` by Postgres before the fix, confirming the silent-rounding
half of the finding.

**Fix.** Replaced `money` with `decimalField(precision, scale)`, a per-column validator that
builds its regex directly from the column's own precision/scale: integer-digit count bounded to
`precision - scale`, fractional-digit count bounded to `scale`. A value that fails either bound
never reaches Prisma — it becomes a `ZodError`, which `handle()` already turns into a
field-anchored 400 via `readableMessage()` (`"creditLimit: Must be a decimal with at most 10
digits before and 2 digits after the decimal point"`). No rounding path exists: anything with more
fractional digits than the column allows is rejected outright, not truncated.

`creditLimitField = decimalField(12, 2)` and `financeChargeRateField = decimalField(6, 4)` are
declared right next to a comment tying them to the schema, and `prisma/schema.prisma` got a
matching comment on each `Decimal(...)` column pointing back at `decimalField` in
`src/server/customers.ts`, so the two can't silently drift.

**Files:** `src/server/customers.ts`, `prisma/schema.prisma`.

## F2 (P2) — updating/deleting a soft-deleted customer silently succeeded

**Root cause.** `customer-addresses.ts::updateAddress` and `customer-contacts.ts::updateContact`
both do `findFirst({ where: { id, deletedAt: null } })` before mutating and 404 if nothing comes
back. `customers.ts::updateCustomer` never got the same guard — it went straight to
`prisma.customer.update`, which happily updates a soft-deleted row and returns 200. I also checked
`deleteCustomer` per the task's instruction and found the identical gap: nothing stopped a second
delete of an already-deleted row from re-stamping `deletedAt` and minting a duplicate audit
"delete" entry. (This second gap was already listed as a known, deferred backlog item in
`docs/HANDOFF.md` §6 — "a second DELETE re-stamps `deletedAt` and writes another audit row" — so
fixing it here also closes that backlog line.)

**Failing-before repro:**

```
 × 404s when updating a soft-deleted customer instead of silently mutating the hidden row ... 43ms
   → promise resolved "undefined" instead of rejecting
 × 404s when deleting an already soft-deleted customer ... 41ms
   → promise resolved "undefined" instead of rejecting
```

**Fix.** Both `updateCustomer` and `deleteCustomer` now open with:

```ts
const current = await prisma.customer.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
if (!current) throw new HttpError(404, "Customer not found");
```

**Files:** `src/server/customers.ts`.

## F3 (P2) — optimistic saves could commit out of order

**Root cause.** `save()`, `toggleContactFlag()`, `saveAddressField()`, and `saveContactField()` in
`src/app/customers/[id]/page.tsx` all apply an optimistic local update, then fire an unawaited PUT.
Two rapid clicks on the same checkbox fire two independent PUTs concurrently; if the first request
happens to resolve *after* the second on the network, the database ends up holding the first
click's value even though the UI (which applied the second click's optimistic update last) shows
the opposite.

**Fix.** Added a per-key request queue (`serial(key, fn)`, a `Map<string, Promise<unknown>>` held
in a `useRef`) and routed every one of those four save paths through it, keyed by field name (plus
row id for address/contact rows). `serial` chains each new call onto the *settlement* (success or
failure) of the previous call for the same key, so request N+1 for a key is never dispatched until
request N has already resolved. Requests to the same field can therefore never race on the
network — they always complete in the order they were queued, so the last one dispatched is
always the last one to reach the database, matching whatever the UI's last optimistic update
shows. The queue lives in a `ref`, not `state`, since it's request plumbing, not render state.

`saveParent()` (new, for F4) also routes through `save()` so parent-hierarchy changes get the same
guarantee.

**Files:** `src/app/customers/[id]/page.tsx`.

## F4 (P2) — no UI control for the parent/child hierarchy

**Fix.** Added a "Parent" `<select>` to the Commercial section of the customer detail page,
alongside the existing Terms select (same pattern: fetched once via a `useEffect`, saved through
`save()`). Options come from `GET /api/customers` (no `includeInactive`, so — per `listCustomers`'s
default — only active, non-deleted customers), rendered as `code — name`; a blank option means no
parent. The current customer is excluded from its own option list via `customers.filter((x) =>
x.id !== id)`.

Selecting an option calls a new `saveParent(parentId)`, which calls `save({ parentId: parentId ||
null })` (so the PUT payload is exactly `{ parentId }`, same shape the server already accepts) and
then reloads the customer so the header's "Division of X" text (a value the service doesn't return
from a PUT, only from a full customer fetch) picks up the new `parentCode`. Server-side rejections
— self-parent, cycle, deleted parent — are **not** re-implemented client-side; they surface as
whatever `HttpError` message the service already throws, via `save()`'s existing catch-and-display
path (the top-of-page red error banner).

Verified against the live service (see "Manual verification" below) that self-parent and cycle
attempts both come back as field-anchored 400s with the service's own messages, unchanged.

**Files:** `src/app/customers/[id]/page.tsx`.

## F5 (P2) — `HistoryPanel` falsely reported "No history"

**Root cause.** `HistoryPanel` called `/api/admin/audit` (gated on `admin.view`, a permission-model
decision recorded in `docs/HANDOFF.md` §6 for Phase 2C — deliberately **not** touched here) and
`.catch(() => {})`'d any failure, leaving `entries` at its initial `[]`. A user who can view the
customer but lacks `admin.view` therefore saw "No history" for a record that may have plenty.

**Fix.** Added a `status: "loading" | "ok" | "error"` state. `"loading"` renders "Loading
history…"; `"error"` renders "History unavailable (you may not have permission to view it)."; only
`"ok"` with zero entries renders "No history." The panel now never renders "No history" for a
request that didn't succeed.

**Files:** `src/components/HistoryPanel.tsx`.

## F6 (P2) — child drafts cleared before the POST resolved

**Root cause.** The "Add address" and "Add contact" buttons called `void call(...)` (fire-and-
forget) and reset the draft state on the very next line, unconditionally — so a failed save wiped
whatever the user had typed, before the response even came back.

**Fix.** `call()` now returns `Promise<boolean>` (true on success, false on failure — it already
had try/catch, this just surfaces the outcome instead of only using it for `setError`). The two
button handlers became `async`, `await call(...)`, and only reset the draft
(`setAddrDraft(emptyAddrDraft)` / `setContactDraft(emptyContactDraft)`) when that resolves `true`.
A failed save leaves the draft (all six address fields, or all three contact fields) exactly as
typed, so the user can correct and resubmit without retyping.

**Files:** `src/app/customers/[id]/page.tsx`.

---

## Regression tests (F1, F2)

Added to `tests/customers.test.ts`, confirmed failing against the pre-fix code (output above),
now passing:

- `rejects a finance charge rate that overflows Decimal(6,4) as a field-anchored validation error, not a 500`
- `rejects a credit limit with more precision than Decimal(12,2) can hold, rather than silently rounding it`
- `404s when updating a soft-deleted customer instead of silently mutating the hidden row`
- `404s when deleting an already soft-deleted customer`

## Manual verification of F3–F6

**No browser was reachable in this sandbox.** I loaded both the Playwright MCP tools and the
chrome-devtools MCP tools and attempted real interactive verification; both failed with the same
root cause: they require Google Chrome at `/opt/google/chrome/chrome`, which does not exist and
cannot be created (`/opt` is root-owned, no passwordless `sudo` is configured — confirmed with
`sudo -n -l` → "a password is required"). `npx playwright install chrome` also requires switching
to root to install OS dependencies and fails the same way. `npx playwright install chromium`
succeeded (self-contained, no root needed), but the installed MCP tools are hardcoded to the
`chrome` channel/path, not `chromium`, so that download didn't help. A Google Chrome binary does
exist on the machine via Flatpak (`/var/lib/flatpak/app/com.google.Chrome/.../files/bin/chrome`),
but I have no way to redirect the already-running MCP server processes to it without restarting
them with different configuration, which isn't available to me. I am reporting this plainly
rather than claiming a browser-verified pass I did not perform.

What I did instead, to get the most rigorous evidence available without a DOM:

- **Ran `npm run dev`** against the real `erp` Postgres database (container `erp-db-1`), seeded an
  admin user (`npm run db:seed`), and logged in via `curl` to get a real session cookie.
- **Exercised every route the new/changed UI code calls, over HTTP, end-to-end through the real
  Next.js route handlers and the real database** — this covers everything the browser would have
  done except the actual click/keystroke:
  - F4: created two customers, `PUT` one's `parentId` to the other (what the new `<select>`'s
    `onChange` sends) and confirmed `GET` on the child now returns `"parentCode":"ACME"` (what the
    header's "Division of X" line reads); confirmed a self-parent attempt returns `400 {"error":"A
    customer cannot be its own ancestor"}` and a cycle attempt returns `400 {"error":"That parent
    would create a circular relationship"}` — the exact messages `save()`'s catch block would
    display in the error banner, un-reimplemented.
  - F1 (route level, on top of the unit tests above): `POST` with `financeChargeRate: "100"` →
    `400 {"error":"financeChargeRate: Must be a decimal with at most 2 digits before and 4 digits
    after the decimal point"}`; `creditLimit: "1.005"` → `400` with the equivalent message for
    that column. Neither a 500 nor a silent round.
  - F2 (route level): soft-deleted a customer, then `PUT` a rename → `404 {"error":"Customer not
    found"}`; a second `DELETE` on the same id → `404`.
  - F6 (server contract only — the draft-retention itself is pure client state I could not observe
    without a DOM): confirmed `POST /addresses` with an invalid `kind` fails with `400` (the
    `call()` branch that must return `false` and leave the draft alone) and a valid payload
    succeeds with `200` (the branch that must return `true` and clear the draft). Read the diff to
    confirm the reset is inside `if (await call(...))` for both the address and contact buttons.
  - Cleaned up the customers/addresses I created during this pass afterward via `DELETE`.
- **F3 (pure client-side timing logic, nothing to hit over HTTP):** extracted the exact `serial()`
  algorithm added to `page.tsx` into a standalone Node script
  (`/tmp/.../scratchpad/f3-serial-demo.mjs`) and ran it. It simulates the reported scenario
  precisely: click 1 (`creditHold: true`) dispatched first but with a slow (50ms) simulated
  network; click 2 (`creditHold: false`) dispatched immediately after with a fast (5ms) simulated
  network — the exact shape of an ordinary double-click race.

  ```
  WITHOUT serialization: UI shows false, DB ends up with true <-- MISMATCH (the bug)
  WITH serialization:    UI shows false, DB ends up with false <-- MATCH (fixed)
  ```

  This confirms the specific mechanism (chaining onto the previous request's settlement before
  dispatching the next) actually prevents the mismatch, using the identical code that's in the
  component — not a browser click, but a concrete demonstration of the fix's correctness rather
  than a code-reading assertion.

I'm confident in F1/F2/F4/F6's server-side correctness (verified end-to-end over real HTTP against
a real database) and in F3's algorithmic correctness (verified by running the actual logic). What I
could **not** verify is the DOM-level experience — e.g., that clicking the actual checkbox twice in
a real browser triggers exactly the code path I traced, that the select renders visually as
expected, or that the error banner text is legible/positioned sensibly. That gap is the sandbox's,
not a shortcut I chose to take.

## Gates

All four run from `/home/cojoa13/Desktop/HeatSynQ/erp` after all six fixes:

```
$ npm test
 Test Files  30 passed (30)
      Tests  246 passed (246)
```

Baseline was 242; **246** now (242 + 4 new regression tests for F1/F2). No baseline test changed
behavior or was modified — only additions.

```
$ npx tsc --noEmit
(no output — clean)
```

```
$ npx eslint src tests
(no output — clean)
```

```
$ npm run build
 ✓ Compiled successfully in 2.3s
   Linting and checking validity of types ...
 ✓ Generating static pages (25/25)
(full route table printed, no errors)
```

## Constraint checks

- **No schema changes.** `prisma/schema.prisma` only gained two comments (precision/scale facts
  next to `creditLimit`/`financeChargeRate`); no column, type, or migration changed. Confirmed no
  new migration was generated.
- **`src/server/errors.ts` has zero imports** — unchanged, still 0 `import` statements (verified
  with `head src/server/errors.ts | grep -c '^import'` → `0`).
- **`audit.ts` is the sole writer of audit rows** — `grep -rln "auditLog.create" src` → only
  `src/server/audit.ts`.
- **Client components never import from `src/server/**`** — `grep -rn "from \"@/server"
  src/app src/components` returns only files under `src/app/api/**/route.ts` (server route
  handlers, not `"use client"` components); `src/app/customers/[id]/page.tsx`,
  `src/app/customers/page.tsx`, and `src/components/*.tsx` import nothing from `@/server`.

## Deviations / judgment calls

- **F3 scope.** The task called out credit hold and taxable as "the reachable cases under an
  ordinary double-click," but I applied the same `serial()` queue to all four optimistic-save
  functions (`save`, `toggleContactFlag`, `saveAddressField`, `saveContactField`), not just the
  customer-level checkboxes. They share the identical bug shape (optimistic update + unawaited
  fetch), so leaving the other three unfixed would have left the same race reachable through, e.g.,
  a contact's "gets shippers" checkbox or rapid edits to an address field. This is strictly
  additive safety, not a scope expansion of *what* gets fixed — same mechanism, same file, applied
  uniformly instead of cherry-picked.
- **`saveParent`'s extra reload.** Because a PUT to `/api/customers/:id` only echoes `{ok:true}`
  (no updated row), and the header's "Division of X" text and the select's own option pool are
  both derived from *other* customers' data that a bare parentId PUT can't refresh, `saveParent`
  does `await save(...)` and then an unconditional extra `load()`. On the failure path this means
  one redundant reload (`save()`'s own catch already reloads once to roll back the optimistic
  update). I chose the simple, always-correct shape over threading a success/failure signal through
  `save()` just to skip one harmless extra fetch.
- **No browser available**, documented plainly above rather than glossed over.

## Files touched

- `src/server/customers.ts` — F1 (`decimalField`/`creditLimitField`/`financeChargeRateField`
  replacing the shared `money` validator), F2 (`deletedAt` guards on `updateCustomer` and
  `deleteCustomer`).
- `prisma/schema.prisma` — F1 (precision/scale comments only, no schema change).
- `src/app/customers/[id]/page.tsx` — F3 (`serial()` queue), F4 (parent selector + `saveParent`),
  F6 (draft reset moved into `call()`'s success branch for both add-address and add-contact).
- `src/components/HistoryPanel.tsx` — F5 (loading/ok/error status instead of swallowing errors).
- `tests/customers.test.ts` — new regression tests for F1 and F2.
