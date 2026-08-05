### Task 12: Board UI (home) + saved views + Shell search

**Files:**
- Modify: `src/app/page.tsx` (the board replaces the welcome), `src/components/Shell.tsx` (global search live; "Orders" nav → `/`)
- Test: extend `tests/permissions-sweep.test.ts` expectations only if the sweep flags the new client files (no server imports — verify, don't exempt)

**Behavior contract (client components against the Task 9/10 routes; §5.16 gating; `use-latest` on every fetch; failed fetches surface in the standard error banner — never `.catch(() => {})`):**
- Columns per spec §11 (order #, `CODE · name`, lead part, PO, qty, weight, received, request, target, light+status, loads, linked, VS #). Light renders color dot + text label. Voided rows (when toggled on) show status "Voided", muted.
- Filters: status multi-select, customer picker (session pick-list of live customers via existing customers API), received/request date ranges, include-voided toggle (default off), search box (server `search` param).
- Column picker: show/hide + reorder (spec §11); the current arrangement is what Save-view captures into `config.columns`.
- Saved views: dropdown (user's views + "Default board"), Save-view button (name prompt; "Set as default" checkbox), applies columns/filters/sort from `config`; delete view w/ confirm. Gated `orders.view` (the page 403s without it — standard shell handling).
- Export button → `/api/orders/export?…` with current filters.
- New Order button → `/orders/new`, gated `orders.create` (disabled + tooltip otherwise).
- Shell search: debounced 250 ms dropdown, grouped Orders/Parts/Customers; Enter with `exactOrderId` → `router.push('/orders/'+id)`; barcode scanners type digits + Enter — that path IS the scan path. Groups the API returns empty are omitted.

- [ ] **Step 1: Build the board page** (client component; fetch on mount + on filter change through `useLatest`).
- [ ] **Step 2: Build Shell search + nav change.**
- [ ] **Step 3: Manual smoke via dev server** (`npm run dev`, seeded admin): board renders empty-state, filters round-trip, search dropdown navigates. Gates (`tsc`, eslint, tests, build).
- [ ] **Step 4: Commit** — `feat: order board home page, saved views, live global search`

