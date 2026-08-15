# Task 6 — Home invoice register + A/R aging under /reports — review verdict

**Range:** `960e0e0..54ba7a3` (`a92ae9d` code + `54ba7a3` docs). Scope: 4 files, +115/-1.

## Spec Compliance — ✅ Spec compliant

- **Area keys verified against the real guards (not guessed):**
  - `invoice-register` → `area: "invoicing"` (`src/lib/report-registry.ts:51`) matches
    `mustCan(requireUser(), "invoicing", "view")` at `src/app/api/invoices/route.ts:10`.
  - `aging` → `area: "receivables"` (`src/lib/report-registry.ts:55`) matches
    `mustCan(requireUser(), "receivables", "view")` at `src/app/api/receivables/aging/route.ts:11` —
    the correct sibling; `AREAS` also holds `ar` (`src/lib/permission-constants.ts:5`), which is NOT used.
- **Filter gates per-entry, not on reports:** `src/app/api/reports/route.ts:15`
  `REPORTS.filter((r) => can(user, r.area, "view"))` — cross-area entries gate on their own area.
- **LINK not relocate:** hrefs point at existing pages `/invoicing` and `/receivables/aging`; both
  `page.tsx` files present; nav routes unchanged (`src/lib/nav.ts` Invoicing `/invoicing` area `invoicing`,
  Receivables `/receivables` area `receivables`). No page moved or rebuilt.
- **No dead links:** both `src/app/invoicing/page.tsx` and `src/app/receivables/aging/page.tsx` exist.
- **No client-side `src/server/**` import:** `report-registry.ts` imports only `type Area` from
  `permission-constants.ts` (pure constants).
- **Behavioral test (the one Task 0's reviewer flagged missing):**
  `tests/reports-routes.test.ts:59-89` — case 1 (`reports.view`-only) sees `backlog` but NOT
  `invoice-register`/`aging`; case 2 (`+ invoicing.view + receivables.view`) sees both at their real
  routes. `signInWith` (`tests/helpers/auth.ts:9`) grants exactly the listed permissions, so the two
  cases genuinely differ on the source-area grant.
- **RED-then-GREEN:** case 2 uses `find(...).toMatchObject(...)`; with no entry present `find` returns
  `undefined`, yielding exactly the reported `expected undefined to match object { href: '/invoicing' }`
  failure. Genuine RED. Case 1's `not.toContain` is a post-impl regression control (passes trivially
  pre-impl) — honestly claimed only case 2 as RED.

## Strengths
- Area keys confirmed against the actual `mustCan` guards; the `ar` vs `receivables` trap avoided.
- Filter is a true behavioral assertion post-impl (a broken filter would surface `invoice-register` in case 1).
- Client-safe registry preserved; commit messages carry no attribution trailer.

## Issues
None (Critical/Important/Minor). The filesystem `existsSync` page check is intentionally a light
assertion per the brief; acceptable.

## Assessment
**Task quality:** Approved
**Reasoning:** Two correct registry entries with guard-verified area keys, LINK-not-relocate honored,
and the previously-missing per-entry area-filter behavioral test added with genuine RED-then-GREEN.
