# Task 6 review — The Backups admin page

## Spec Compliance: ✅ Spec compliant

## Verified specifically

- **Union genuinely rejects two-gate/zero-gate entries.** Empirically confirmed with `tsc --strict`
  against a scratch file importing `NavEntry` from `erp/src/lib/nav.ts`: an entry with both `area`
  and `action` errors ("Type 'string' is not assignable to type 'undefined'"), an entry with
  neither errors ("Property 'action' is missing"). A third case, `{ label, href, action: "" }`
  (falsy-but-present), type-checks cleanly, as it should.
- **`canSeeEntry` discriminates correctly on the falsy-action edge case.** `entry.action !== undefined`
  (not a truthiness check) means `action: ""` still routes to the action branch and checks
  `action.` + `""`, never falls through to `canViewArea(perms, undefined)`. Verified by inspection
  and the tsc probe above (`erp/src/lib/nav.ts:260-264`).
- **Both list builders route through it** — `visibleNav`/`visibleAdmin` (`erp/src/lib/nav.ts:266-274`)
  both call `canSeeEntry`; no residual direct `canViewArea` call in either.
- **Pre-existing gating unchanged.** Ran `tests/nav.test.ts` + `tests/permissions-sweep.test.ts`
  directly (not the full suite, per instructions): 16/16 pass, pristine output, matching the
  implementer's reported run exactly. All 7 pre-existing cases (Templates dead-end pair, top-level
  area filtering, empty/undefined permission sets) still exercise the same assertions verbatim.
- **Page constraints.** `usePermissions()` is the shared hook (`page.tsx` imports from
  `@/lib/use-permissions`, not a hand-rolled effect); `permissions` stays `undefined` in flight and
  `error` is surfaced in the banner (`error ?? permError`, page.tsx line ~124). §5.13 order in
  `backUpNow`'s catch block is refresh-then-report (`await load().catch(() => {})` precedes
  `setError`). §5.16: the button is always rendered, only `disabled`, with `title=gate.title`
  supplying the reason. No business logic re-derivation — `green = health?.state === "ok"` reads
  the server enum verbatim; no client-side staleness math. `tests/permissions-sweep.test.ts`'s
  "no client component imports src/server" case passes, and the page's only non-`react`/`next`
  imports are `@/lib/fetcher`, `@/lib/permission-ui`, `@/lib/use-permissions`, `@/lib/backup-constants`
  — all client-safe leaves. Both API routes (`GET`/`POST /api/admin/backups[/run]`) gate on
  `manage_backups` via `mustDo`, matching the page's `gateDo("manage_backups")`. No attribution
  trailer on either commit.

## Strengths

- The union + `canSeeEntry` refactor is exactly the shape the brief specified, with the added value
  of an accurate, updated file-header decision comment explaining the Phase 8C addendum in situ.
- The three new nav tests are well-targeted (holder-without-admin.view, admin.view-without-action,
  loading state) and don't disturb the existing Templates dead-end pair.
- Palette/heading-size deviations from the brief's literal code block (slate over gray, text-2xl
  over text-xl, `<p>` banner over bordered `<div>`) are correctly justified against actual sibling
  pages (verified: `surcharges/page.tsx:263,297`, `settings/page.tsx:39` match exactly).

## Issues

None found — Critical, Important, and Minor are all empty.

## Assessment

**Task quality:** Approved
**Reasoning:** The nav discriminated-union mechanism was independently verified with `tsc` to
genuinely reject both malformed shapes rather than merely looking restrictive, the falsy-action
edge case is handled correctly, both list builders route through the shared resolver, all
pre-existing gating cases still pass with pristine output, and the page correctly follows the
shared-hook, §5.13, and §5.16 constraints with no business logic or `src/server` leakage.
