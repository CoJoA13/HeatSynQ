### Task 10: Aux routes — drafts, saved views, search

**Files:**
- Create: `src/app/api/order-drafts/route.ts` (GET / PUT / DELETE — session only, own row: `requireUser().id`, no permission gate), `src/app/api/saved-views/route.ts` (GET / POST), `src/app/api/saved-views/[id]/route.ts` (PATCH / DELETE) — `orders.view` + own rows, `src/app/api/search/route.ts` (GET `?q=` — `requireUser` only; service filters groups)
- Test: `tests/aux-routes.test.ts`

- [ ] **Step 1: Failing tests**: drafts 401 unauthenticated, isolated per user (user A's PUT invisible to B's GET); saved-views 403 without `orders.view`, [id] routes 404 on another user's view (not 403 — no existence leak); search 401 only, and a `parts.view`-only session gets orders-empty results through the route.
- [ ] **Steps 2–4: FAIL → implement → PASS + gates.**  **Step 5: Commit** — `feat: draft, saved-view, and search routes`

