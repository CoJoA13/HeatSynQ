## Task 8: The `/receivables/close` UI

**Files:**
- Create: `erp/src/app/receivables/close/page.tsx`, `erp/src/app/receivables/close/Close.tsx`
- Modify: the Receivables nav source (add a "Close" tab, gated `receivables.view`)
- Test: browser verification + `npm run test:e2e` (the flow lands in Task 9)

**Interfaces:**
- Consumes: `/api/receivables/close/*` (Tasks 5–7). Mirror the server return types locally as `type` aliases — never import `src/server/**`.

- [ ] **Step 1: Build `Close.tsx`** (`"use client"`) modelled on `AgingReport.tsx` + `Statements.tsx`: a year/month picker driving a guarded `api()` fetch of `/api/receivables/close/preliminary?year=&month=` **and** `/api/receivables/close/readiness?year=&month=` for the same month (so §6.1's account-less flags show on the preliminary screen and the Export-button disabled-count matches `exportClose`); the continuity schedule rendered as a table (beginning → invoiced/credits/payments/discounts/write-offs → ending, with the aging figure and variance beside it); a **readiness** panel (gap list + an `<a href>` to `/api/receivables/close/readiness/export?year=&month=` and a per-gap fix link); a **Close** button (`gate(perms, "receivables.edit")` + `gateDo(perms, "close_ar_period")`, `disabled` with a `title` when the variance ≠ 0, the prior month is open, or permission is missing); a closed-periods list with each period's figures, its export batches (download **file** + **register** links), a **Reopen** button (`gateDo` `close_ar_period`, `confirm` + reason prompt), and an **Export** button (`gateDo` `run_qbo_export`, disabled with the readiness count until clear). The close/reopen/export actions POST via `fetch` (mutations), surface `body.error`, and bump a refresh counter. Follow every UI rule in the Global Constraints (disabled-with-reason, `useLatest` guard, no silent `.catch`).

- [ ] **Step 2: Build `page.tsx`** wrapping `<Close />` in `<Suspense>` (it reads search params) and rendering the `ReceivablesNav`.

- [ ] **Step 3: Add the nav tab.** In the Receivables nav source, add a `Close` link to `/receivables/close` gated on `receivables.view` (mirror the aging/statements entries).

- [ ] **Step 4: Verify in the browser.** `preview_start` the dev server; sign in; seed a GL default set + a July invoice/payment through the app or a quick script; open `/receivables/close`, confirm the schedule, readiness, close (variance 0), export, and the file/register downloads render. Fix any console/network errors from source.

- [ ] **Step 5: Run E2E to confirm nothing regressed.**

```bash
npm run test:e2e
```

- [ ] **Step 6: Commit.**

```bash
git add erp/src/app/receivables/close erp/src/app/receivables
git commit -m "feat(5c): month-end close & GL-export UI (/receivables/close)"
```

---

