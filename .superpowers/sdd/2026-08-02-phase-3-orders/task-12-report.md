# Task 12 Report — Board UI (home) + saved views + Shell search

**Status: Done.** All four quality gates green; manual dev-server smoke test performed end to
end (including live create/apply/delete of a saved view, filter/sort round-trips verified via
the network tab, and the barcode-scan Enter path verified against a real order). One commit on
`phase-3-orders`.

## Commit

`d7d62d2` — `feat: order board home page, saved views, live global search`

Parent: `3c03539` (the documented attachments fix that was expected to land during this task —
confirmed present, unrelated files, not touched).

## Files

- Modified `erp/src/app/page.tsx` — the welcome stub replaced with the order board (client
  component, default export renamed `Home` → `OrdersPage` to match the house `XxxPage` naming
  convention used by every other list page).
- Modified `erp/src/components/Shell.tsx` — the placeholder search box replaced with the live
  global search; "Orders" nav entry now points at `/`; fixed the active-nav-link check (see
  below).
- Modified `erp/src/lib/traffic-light.ts` — added `LIGHT_DOT_CLASS` (a Tailwind class map),
  co-located with the existing `LIGHT_LABELS` it renders beside. No existing export changed.
- New `erp/src/lib/board-columns.ts` — the column model (`BOARD_COLUMNS`, `ColumnState`,
  `ViewConfig`, `BoardFilters`), defensive normalizers for a saved view's opaque `config` (never
  trusted blindly — the server never validates its shape), and `buildOrderQuery`, the single
  place that turns board state into the `GET /api/orders` query string.
- New `erp/src/lib/order-constants.ts` — `ORDER_STATUSES`/`ORDER_STATUS_LABELS`, hand-copied from
  the `OrderStatus` enum (the `customer-constants.ts`/`part-constants.ts` precedent — a client
  file must not import the generated Prisma client).
- `tests/permissions-sweep.test.ts` — **not extended**. It already passes unmodified; none of the
  new/changed files import from `src/server/**` (verified by running the sweep, not by reading it).

## Contract coverage

- **Columns** — all 13 from spec §11, in order, each independently show/hide + reorder (via
  `swapAt`, the `ProcessStepsSection.tsx` precedent). The combined light+status cell renders the
  color dot + text label + status label for a live order, or the single muted word "Voided" (row
  gets `text-slate-400`) when `row.voided` — verified live against a voided order (see Smoke,
  below): cell rendered exactly `Voided`, no dot.
- **Filters** — status multi-select (checkboxes), customer picker (gated `customers.view`,
  §5.16), received/request date ranges, include-voided (default off), search box. Every one
  round-trips through the real `/api/orders` query string — confirmed via the network tab for
  each filter individually (see Smoke).
- **Column picker → `config.columns`** — a saved view captures the full 13-entry
  `{key, visible}[]` array (order + visibility together), not just the visible subset, so a
  re-shown column remembers its old position. Verified live: hid PO and moved Order # to position
  2, saved a view, reloaded the page from scratch, and the arrangement was still applied from the
  server-persisted `config` — this is the "applied on load" behavior, not just in-memory state.
- **Saved views** — dropdown (`Default board` + the user's own), Save-view (name + "set as
  default" checkbox, mirrors task-12-brief.md's literal wording), a second "set as default"
  checkbox on the *selected* existing view (PATCHes only `isDefault`, leaving stored
  columns/filters untouched — exercises the PATCH route the brief's aux-routes task built but
  didn't itself wire a caller for), delete with `confirm()`. All four verified against the real
  API (POST/PATCH/DELETE/GET all hit, all 200).
- **Export** — link href always mirrors the current filter/sort state exactly
  (`/api/orders/export?search=...&status=...&sort=...&dir=...`), confirmed by inspecting the
  live `href` after stacking five different filters.
- **New Order** — gated `orders.create` (disabled+tooltip via the shared `gate()` helper);
  enabled for admin, clicked and confirmed `router.push("/orders/new")` navigates there (404 is
  expected — Task 13 territory, same convention Phase 1 used).
- **Shell search** — 250ms debounce confirmed by timing; grouped Orders/Parts/Customers with
  empty groups omitted (confirmed both the single-group case and all-three-groups case); Escape
  closes; a result click navigates to the right detail route. **Enter with an exact order number
  bypasses the debounce and issues its own immediate ticket-gated search** (barcode scanners type
  digits+Enter faster than 250ms) — verified by typing an order number and dispatching `Enter`
  in the same tool call (no wait), landing on `/orders/<real id>` immediately.
- **Nav fix** — `Shell.tsx`'s active-link check used to be a bare `pathname.startsWith(href)`;
  with "Orders" now pointing at `/`, that predicate is true for every route (`"/anything".startsWith("/")`),
  which would have lit "Orders" up permanently. Added `navIsActive()`: exact match for `/`,
  prefix match for everything else.

## Self-review checklist (per the task's own list)

- **Every contract bullet present** — yes, see above; each was exercised against the running app,
  not just read back from the code.
- **`use-latest` on every fetch that can race** — the board's own row-load and the Shell's
  `runSearch` both use `useLatest`'s ticket gate on success *and* failure (the parts/page.tsx F7
  precedent). The saved-views mount effect and the customers-picker effect deliberately don't —
  each fires at most once per mount/permission-resolution, matching the exact precedent
  `parts/page.tsx` and `usePermissions` already set for that shape of fetch.
- **No `.catch(() => {})`** — grepped for it across all five changed/new files: none.
- **§5.16 gating** — New Order (`orders.create`) and the customer filter (`customers.view`) both
  disabled+tooltip via `gate()`, never hidden.
- **No server imports in client files** — grepped for `@/server` and the generated-client relative
  import path: none; `permissions-sweep.test.ts`'s dedicated check also passes.
- **Column state round-trips through saved views** — see the column-picker bullet above; verified
  with an actual page reload, not just a re-render.
- **Dev-server smoke actually performed** — yes, extensively; see below.

## Gates

```
npx tsc --noEmit        clean
npx eslint src tests     clean
npm test                 871 passed (871), 72 files — same count as the pre-task baseline
npm run build            succeeded (Turbopack), "/" prerenders as static
```
Run twice (before and after a post-smoke cosmetic rename of the page's default export), both
times clean.

## Manual dev-server smoke test

`nvm use 26`; `docker compose ps` confirmed `erp-db-1` healthy; `npx prisma migrate status`
clean on the dev `erp` database; started `npm run dev` via a new `.claude/launch.json` (repo
root — pre-existing `.claude/` dir was already untracked at session start, left that way; did
**not** commit the launch config, since it's local dev tooling, not part of the feature).

Signed in `admin`/`admin`. Concretely, in order:

1. **Empty state** — fresh board, zero orders: rendered "No orders match these filters." under
   the full 13-column header, exactly one `GET /api/orders?sort=orderNumber&dir=desc` fired (not
   two — confirms the `viewsReady` gate correctly avoided a redundant first fetch with the
   built-in default before the saved-views lookup resolves).
2. **Column picker** — hid PO, moved Order # down one slot: table header updated live to
   `Customer | Order # | Lead part | Qty | ...` with PO gone; both re-verified via `get_page_text`.
3. **Save view** — named it, checked "set as default", saved: `POST /api/saved-views` → 200,
   dropdown auto-selected the new view, "Set as default" checkbox reflected `true`.
4. **Applied on load** — full page reload (`navigate` with `force`, not client nav): the board
   came back with the *saved* arrangement already applied and exactly one `/api/orders` call —
   proves the default-view application is real, not an artifact of in-memory state.
5. **Default board / delete** — switched back to "Default board" (arrangement reset correctly,
   "Set as default" checkbox disappeared, Delete-view button correctly disabled via
   `button.disabled`); re-selected the saved view, overrode `window.confirm` to `true`, clicked
   Delete: `DELETE /api/saved-views/<id>` → 200, dropdown back to just "Default board".
6. **Filters round-trip** — stacked search → status checkbox → include-voided → a date input,
   confirming the exact query string after each: `?search=1042`, then `&status=OPEN`, then
   `&includeVoided=1`, then `&receivedFrom=2026-01-01` — each filter both present and additive.
7. **Sort-by-header** — clicked "Customer": `sort=customerCode&dir=asc` fired and the header
   showed "Customer ▲"; clicked again: `dir=desc` and "Customer ▼"; clicked the non-sortable
   "Qty" header: no request fired at all (confirms only columns with a `sortKey` are wired).
8. **Export link** — inspected `href` after step 6/7's filters were live: carried every one of
   them plus the active sort, exactly matching the last fetch's own query string.
9. **New Order** — enabled for admin, clicked, confirmed `window.location.href` became
   `/orders/new` (404 body, expected).
10. **Non-empty board + voided row** — created a throwaway customer/part/step-code/order via
    direct `fetch()` calls to the real API (not raw SQL) to get one genuine order into the board:
    row rendered with correct `yyyy-mm-dd` dates, `On target · Open` in the status cell, `1` load.
    Voided it (`DELETE /api/orders/[id]` with a reason), toggled "Include voided" on: the same row
    reappeared with the whole `<tr>` carrying `text-slate-400` and the status cell reading the
    single word `Voided` — no colored dot, confirming the override.
11. **Shell search — grouped dropdown** — searched "ZZ" (matching all three fixtures at once):
    dropdown showed all three group headers (Orders/Parts/Customers) with one row each, correctly
    formatted (`#1000 · ZZTEST · PO — · ZZPART1`, `ZZTEST · ZZPART1 —`, `ZZTEST · ZZ Smoke Test
    Customer`). Searched "ZZTEST" alone (matches only the customer): only the "Customers" group
    rendered — Orders/Parts correctly omitted.
12. **Shell search — click navigates** — clicked the customer result: navigated to
    `/customers/<real id>`, page rendered the real customer detail (addresses/contacts/history
    sections, an audit entry from its own creation).
13. **Shell search — the scan path** — typed the order number "1000" and dispatched a synthetic
    `Enter` keydown in the very next call (well under 250ms, no debounce wait): navigated straight
    to `/orders/<real id>` — the barcode-scan path, confirmed against a real order number, not a
    contrived unit-level check.
14. **Escape** — with the dropdown open (three groups showing), dispatched `Escape`: dropdown
    closed immediately.
15. Checked `read_console_messages` (no errors) and `preview_logs` (no server errors) throughout.
16. **Cleanup** — voided the test order and soft-deleted the test part/step-code/customer through
    the app's own DELETE endpoints (the only delete surface this app exposes by design — hard
    delete is "tests excepted" per CLAUDE.md). Confirmed via `psql` that the dev `erp` database's
    only order (`orderNumber 1000`) and the `ZZTEST` customer both carry `deletedAt`; the board and
    every picker are back to the pristine empty state. This matches the exact soft-delete residue
    already left behind by prior tasks' own smoke tests (`SMOKE01`, `DEMO`, etc. — all
    `deletedAt`-set customers already in that table before this session).

**Environment note, not a product bug:** the sandboxed Browser pane in this session could not
composite frames (`screenshot` always timed out — "Browser pane is not displayed"), and
coordinate/ref-based `computer` clicks were inconsistent as a result (worked for buttons about
half the time, never reliably for focusing/typing into inputs). Text inputs and selects were
driven via `form_input` (reliable throughout) or by dispatching real, bubbling native DOM events
via `javascript_tool` (`.click()`, `Event('input')`/`Event('change')` after the native value
setter, `KeyboardEvent('keydown', { key: 'Enter' | 'Escape' })`) — these are genuine DOM/React
event-cycle exercises of the shipped code, not mocks of it, and every result above was cross-
checked against the actual network requests the real running server received.

## Not directly exercised (explain why)

- **A user lacking `orders.view` hitting a 403 on `/`.** The only signed-in identity in the dev DB
  is `admin` (full permissions). The mechanism is identical to every other gated page in this
  codebase (no special-casing added — the shared error banner just renders whatever `HttpError`
  message the fetch throws), and the 401/403 sweep in `tests/order-routes.test.ts` already covers
  the server side exhaustively. Standing up a second, deliberately under-permissioned user to
  exercise this one banner felt like more fixture churn than the marginal confidence was worth,
  given the mechanism itself is shared, tested code, not anything new to this task.
- **The customer filter's own disabled+tooltip state** (a session lacking `customers.view`) — same
  reasoning; `gate()` itself has dedicated unit coverage (`tests/permission-ui.test.ts`), and this
  page calls it exactly the way `parts/page.tsx` already does.

## Concerns / follow-ups

None blocking. Two small, deliberate scope calls worth recording in case a later reviewer
wonders about them:

- Board search is **not** debounced (fires on every keystroke, matching `parts/page.tsx`'s own
  search box) — the brief's 250ms debounce requirement is stated only for the Shell's global
  search, not the board's inline filter, so the board mirrors the plain list-page idiom instead.
- "Save view" always **creates** a new view (never overwrites the selected one in place) — the
  brief's literal wording is "Save-view button (name prompt...)", a create verb; updating an
  existing view's stored config isn't in the contract, and `updateView`'s PATCH is still reachable
  (and exercised in this task) through the separate "set as default" checkbox on an already-
  selected view.

## Fix round 1

Reviewer finding (Important, one item): `Shell.tsx`'s `runSearch` recorded `searchError` on
failure but then `throw e`, so its promise rejected. The debounce timer's call site —
`setTimeout(() => { void runSearch(term); }, 250)` — never attached a `.catch`; `void` only
silences the "unused promise" lint, it does not attach a rejection handler. A search that failed
before the Enter path's own `try/catch` ever ran it (i.e. every debounce-triggered call) would
therefore be a genuine unhandled promise rejection at runtime.

**Fix, per the reviewer's suggested shape:** `runSearch` no longer rethrows. It now resolves to
`SearchResults | null` — `null` after recording `searchError` (and closing the dropdown) on
failure, the fetched data on success — so its returned promise always resolves and no call site
needs to remember to attach a catch. `onSearchKeyDown`'s Enter handling changed from
`try { data = await runSearch(term); } catch { return; }` to a plain
`const data = await runSearch(term); if (!data) return;`. The debounce timer's own call site
(`void runSearch(term)`) is unchanged syntactically, but is now actually correct rather than
merely quiet, since the promise it fires-and-forgets can no longer reject.

Took both suggested Minors while in the files:
- `src/app/page.tsx` — `columns`/`filters`/`sort`'s `useState` calls now take lazy initializer
  functions (`() => defaultViewConfig().columns`, etc.) instead of a `defaultViewConfig()` call
  hoisted into a `const initial` above them, which recomputed on every render only to be discarded
  after the first (the `use-latest.ts` precedent — `useState` reads its argument once).
- `src/lib/board-columns.ts` — `normalizeViewConfig` validates a saved view's stored `sort` against
  a whitelist (`SORT_KEYS`, derived from `BOARD_COLUMNS`' own `sortKey`s) before accepting it,
  rather than accepting any string. Previously a stale/hand-edited `sort` value would pass through
  and break every future application of that view with the server's own 400 ("Cannot sort orders
  by ...") instead of falling back to the default.

Skipped per the coordinator's instruction (conscious-choice items reserved for the final
whole-branch review): the voided-row link-color note and the component-split note.

**Gates:** `npx tsc --noEmit` clean, `npx eslint src tests` clean, `npm test` 871/871 (72 files,
unchanged), `npm run build` succeeded. Run once, all green.

**Verification of the fix itself** (the coordinator judged reproducing the original failure —
killing the DB or pointing the fetch at a bad URL mid-session — overkill for this one line of
defensive plumbing): confirmed by code trace (`runSearch`'s only two call sites — the debounce
timer and the Enter handler — no longer have a path where a rejection can escape uncaught), plus
a live dev-server regression check that the fix didn't disturb the happy path: created a fresh
throwaway order (`ZZFIX2`/order #1001) via direct API calls, typed its number into the Shell
search box and dispatched a synthetic `Enter` immediately (no wait, exercising the same
debounce-bypass path as before), and confirmed `window.location.href` became
`/orders/<the real id>` — identical behavior to the pre-fix smoke test. Also re-confirmed the
plain debounced grouped-dropdown path still renders all three groups correctly. Checked
`read_console_messages`/`preview_logs` after both: no errors either time. Fixtures cleaned up
via the app's own void/delete endpoints afterward (order voided, part/step-code/customer
soft-deleted), same as fix round 0.

Commit: `fix: Shell search failure path returns a result instead of rethrowing`.
