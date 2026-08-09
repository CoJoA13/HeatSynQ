### Task 16: Routes — the 401/403 permission sweep

**Files:**
- Modify: the `src/app/api/receivables/**` routes as needed
- Test: `tests/receivables-routes.test.ts`, `tests/permissions-sweep.test.ts`

- [ ] **Step 1: Sweep test.** For every `receivables` route assert: no session → 401; a session lacking the area/action → 403; write-off routes additionally 403 without `write_off`. The `permissions-sweep` (routes call `requireUser`, admin/area gating, `audit.ts` sole writer) stays green with the new module.
- [ ] **Step 2: Run — Expected: FAIL** on any gap; fix the offending route's `mustCan`/`mustDo` first line.
- [ ] **Step 3: Run — Expected: PASS. `/gates`. Commit.**
```bash
git add src/app/api/receivables/ tests/
git commit -m "test(5b): 401/403 sweep across the receivables routes"
```

---

