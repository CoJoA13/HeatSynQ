# Task 3 Report: `billing-config.ts` + Admin → Billing

Commit: `2b3b488` — `feat(admin): plant billing configuration — GL defaults, tax rate, certification charge`

## What I implemented

**Inherited already-done (Steps 1-6, not touched, verified only):**
- `src/server/billing-config.ts` — `getBillingConfig` / `setBillingConfig`, singleton row, FK guards via `assertRefExists`, Serializable only when an FK is actually assigned, `auditedUpdate`.
- `tests/billing-config.test.ts` — 9 service/route tests.
- `src/app/api/admin/billing/route.ts` — GET (`admin.view`) / PUT (`admin.edit`).

I re-ran `npx vitest run tests/billing-config.test.ts` myself before touching anything: 9/9 passed, confirming the controller's claim.

**Done by me (Steps 7-8):**
- `src/app/admin/billing/page.tsx` — new client component, modelled on `src/app/admin/settings/page.tsx` and the GL-account-select precedent in `src/app/admin/step-codes/page.tsx`. One form, seven controls in the order the brief names them: sales tax rate, sales tax GL account, freight GL account, other-charge GL account, certification-charge step code, certification-charge default amount, bill-for-cert-by-default.
  - The three GL selects load from `/api/admin/reference/glAccount` (no `includeInactive`, matching the step-codes page precedent exactly, since the brief doesn't ask for it).
  - The step-code select loads from `/api/picklists/processStepCode`.
  - Every control is gated with `gate(perms, "admin.edit")` from `src/lib/permission-ui.ts` and rendered `disabled` with `title={canEdit.title}` ("Requires admin.edit") — never hidden, per §5.16. Verified this live in a browser (see below), not just by code inspection.
  - The two decimal fields (`salesTaxRate`, `certChargeDefault`) are controlled inputs following the `customers/[id]/page.tsx` `creditLimit` idiom: the field holds `number | string | null`, typing updates local state, and a focus-baseline ref (the `focused` pattern from `step-codes/page.tsx`) means only a genuine change on blur triggers a PUT — tabbing through untouched fields writes no no-op audit entry.
  - Selects and the checkbox save immediately on change (no blur needed), consistent with how `step-codes/page.tsx` handles its GL-account select.
  - Each PUT's response (the fresh `BillingConfigRow`) is written straight back into state; a failed save reloads from the server before reporting the error, so a rejected value never lingers on screen as if it had been accepted.
  - No `HistoryPanel`/`BlockerPanel` — the brief's Step 7 says "one form, seven controls," nothing more, so I didn't add either to avoid scope creep. (Blocker behavior on GL-account delete is already covered at the service layer by an inherited test.)
- Nav entry: added `{ label: "Billing", href: "/admin/billing" }` to the `ADMIN` array in `src/components/Shell.tsx`, positioned right after "Settings", per the controller's explicit resolution of the brief's `/admin`-index-page contradiction. No other Shell.tsx change.

## What I tested

**Gates (all from `erp/`):**
| Gate | Result |
|---|---|
| `npm run build` | Pass — standalone build succeeded, all routes/pages compiled including `/admin/billing`. |
| `npx tsc --noEmit` (run after the build, per the task's phantom-error note) | Pass — zero errors, including zero of the phantom `api/parts/[id]/breaks` errors the note warned about (the build had already regenerated `.next/types/validator.ts`). |
| `npx eslint src tests` | Pass — zero warnings/errors. |
| `npm test` | Pass — **98 test files, 1424 tests, all passing**, output pristine (no stray console noise in the vitest summary). This includes the inherited `tests/billing-config.test.ts` (9/9) unmodified. |

No test file needed to be written for `page.tsx` — confirmed via `find`/`grep` that no `tests/` file targets any `*/page.tsx` component anywhere in the existing suite; the established pattern for these admin screens is browser verification only, not a unit test.

**Browser verification (real, not asserted):**

I did not have a running dev server or a seeded dev DB going in, so I set both up first:
- Created `erp/.claude/launch.json` (a plain `npm run dev` launch config on port 3000) so the Browser-pane tooling had a server to attach to. Left it in the working tree but **did not commit it** — it's dev convenience infrastructure, not part of the task's file list.
- `npx prisma migrate deploy` against the dev `erp` DB (no pending migrations) and `npm run db:seed` (the dev DB had zero users — first run of this box), which seeded `admin`/`admin`.

Then, against `http://localhost:3000`, logged in through the browser:
1. Loaded `/admin/billing` as `admin` (full permissions). All seven controls rendered, all showing the seeded-empty defaults (`salesTaxRate: null`, everything else null/false) — matches `getBillingConfig`'s `EMPTY` shape.
2. Inserted one throwaway `GlAccount` and one throwaway `ProcessStepCode` directly via `psql` so the two dropdowns had real options to exercise (the dev DB had no reference data yet). Reloaded — both selects populated correctly (`4010 Sales Tax Payable`, `CERT — Certification`).
3. Set `salesTaxRate` to `0.0400`, `salesTaxGlAccountId` to the test GL account, `certChargeStepCodeId` to the test step code, and `billForCertDefault` to `true`. Confirmed each individual `PUT /api/admin/billing` returned 200 with the expected updated body (inspected via the browser's network-request log, e.g. `{"salesTaxRate":0.04,"salesTaxGlAccountId":"gltest1",...}`).
4. **Hard-reloaded the page** (fresh `GET`, not a client-side navigation) and read the live DOM directly: `salesTaxRate` input value `"0.04"`, `salesTaxGlAccountId` select value `"gltest1"`, `certChargeStepCodeId` select value `"sctest1"`, checkbox `checked: true` — everything persisted correctly across a full page load.
5. Checked the browser console (`read_console_messages`, `onlyErrors: true`) after every load and after the reload: **no errors, no warnings**.
6. Created a second, throwaway role+user (`billview`, `admin.view` only, no `admin.edit`) to verify the permission gating for real rather than by inspection. Logged in as that user, loaded `/admin/billing`, and inspected the DOM directly: **all seven controls** (`disabled: true`, `title: "Requires admin.edit"`), and the page still showed every previously-saved value — nothing was hidden, exactly per §5.16. Confirmed no console errors on that load either.
7. Cleaned up afterward: deleted the throwaway `billview` user/session/role/rolePermission, deleted the throwaway `GlAccount`/`ProcessStepCode` rows, and reset the `BillingConfig` singleton back to its seeded all-null/false state via `psql`, so the dev DB is left as it would have been before my testing (aside from accumulated audit-log rows from the test PUTs, which I left in place — audit history isn't something this task should be pruning).
8. Stopped the dev server at the end (`pkill -f "next dev"`), confirmed `curl` to `localhost:3000` now fails.

One environment wrinkle worth flagging: the Browser pane's coordinate-based `computer` click tool was unreliable in this session — clicks resolved via `ref` consistently landed on the wrong element (verified by checking `document.activeElement` immediately after), off by roughly one form row, and `computer{action:"screenshot"}` failed outright ("the Browser pane is not displayed, so the page is not compositing frames"). I worked around this by using `form_input` (which sets values directly on the referenced DOM node and does fire React's change handlers for text/select controls) and, where a real click/blur event was required for React's synthetic-event handling (the checkbox's `onChange`, the decimal inputs' `onBlur`), by calling `.click()` / `.blur()` on the located element via the JS-execution tool. This is a limitation of the tooling/environment in this session, not of the page under test — every value change was still confirmed via the actual network request bodies and the actual persisted DOM state after a hard reload, so the verification is real, just not mouse-driven.

## Files changed

- `erp/src/app/admin/billing/page.tsx` (new)
- `erp/src/app/api/admin/billing/route.ts` (new, inherited)
- `erp/src/server/billing-config.ts` (new, inherited)
- `erp/tests/billing-config.test.ts` (new, inherited)
- `erp/src/components/Shell.tsx` (modified — one line, the nav entry)

Not committed (left in working tree, out of this task's scope): `erp/.claude/launch.json`.

## Self-review findings

- Confirmed the seven controls appear in the same order as `BillingConfigRow`'s field order, which also matches the brief's prose order.
- Confirmed no `src/server/**` import exists in `page.tsx` (checked by eye and by the fact that `tsc`/`eslint`/`build` all passed with no client/server boundary complaint).
- Confirmed the GL-account selects intentionally omit `includeInactive` — this matches the one existing precedent (`step-codes/page.tsx`) exactly, rather than me inventing a different convention.
- Reconsidered whether to add a `HistoryPanel`/`BlockerPanel` to the page (both exist elsewhere and would arguably be nice) and deliberately left them out — the brief's Step 7 is explicit ("one form, seven controls") and CLAUDE.md's guidance is to stop and report `DONE_WITH_CONCERNS` rather than grow a file beyond the brief's intent on my own judgment. Nothing else grew beyond that seven-control shape either.
- Verified `saved` field-name feedback (a small green "saved" marker, mirroring `settings/page.tsx`) fires per-field, not globally, so saving one control doesn't falsely flag an unrelated one.

## Issues or concerns

None. All four gates are green, the page works end-to-end in a real browser including a real permission-denied scenario, and the diff stayed within the brief's stated file list plus the controller's explicit nav-entry resolution.

## Fix wave 1

Reviewer returned one Important finding and two accepted Minor judgment notes on the committed task (`2b3b488`). Fixed exactly these three; no other changes.

### Finding 1 (Important) — round-trip coverage for all seven fields

`getBillingConfig` (`src/server/billing-config.ts:44-50`) maps seven DB columns onto seven result fields, but only `salesTaxRate`/`billForCertDefault` had any read-back assertion through the mapping; `otherChargeGlAccountId`/`certChargeDefault` were never exercised at all, and `salesTaxGlAccountId`/`freightGlAccountId` were only ever checked by reading the DB row directly (bypassing the mapping). A transposition between any two of the mapping's lines would have passed the full suite.

Added one test to `tests/billing-config.test.ts` — `"round-trips all seven fields through a single save, none transposed"` — that creates three *distinct* `GlAccount` rows (so a transposition between any pair of the three GL fields is caught) plus one `ProcessStepCode`, calls `setBillingConfig` once with all seven fields set, reads back through `getBillingConfig`, and asserts each of the seven values individually with `toBe`.

**Discrimination proof** (temporarily swapped `freightGlAccountId: row.freightGlAccountId` → `freightGlAccountId: row.otherChargeGlAccountId` in `getBillingConfig`):

Command: `npx vitest run tests/billing-config.test.ts`

With the transposition — FAILS:
```
 ❯ tests/billing-config.test.ts (10 tests | 1 failed) 705ms
   × getBillingConfig / setBillingConfig > round-trips all seven fields through a single save, none transposed 34ms
     → expected 'cmsigdhdm0006rvf6mwyuk8sh' to be 'cmsigdhdm0005rvf6aytx3f2d' // Object.is equality
 ❯ tests/billing-config.test.ts:104:36
    102|     expect(cfg.salesTaxRate).toBe(0.055);
    103|     expect(cfg.salesTaxGlAccountId).toBe(glTax.id);
    104|     expect(cfg.freightGlAccountId).toBe(glFreight.id);
       |                                    ^
 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

Reverted the transposition — PASSES:
```
 ✓ tests/billing-config.test.ts (10 tests) 747ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

The new test discriminates a real transposition; all other 9 tests were unaffected in both runs.

### Finding 2 (Minor, accepted) — document the unreachable `create` arm

Added a comment directly above the `auditedUpdate(... upsert ...)` call in `src/server/billing-config.ts` recording: (a) the `create` arm exists only as self-healing for a genuinely rowless database (partial restore, hand-run `DELETE`); (b) it is unreachable against any migrated database because the migration seeds the singleton row and `truncateAll` re-seeds it after every `TRUNCATE`, and the `CHECK ("id" = 'singleton')` plus the primary key guarantee the only row it could ever create is the correct one; (c) if it ever did run, `auditedUpdate` would log it as an update with a null `before`, which is expected, not a bug. No behavior change — the upsert itself is untouched.

### Finding 3 (Minor, accepted) — reorder rollback-then-report in the save-failure path

`src/app/admin/billing/page.tsx`'s `save()` catch block called `setError(...)` before `void load()`, while its comment and the phase plan's §5.13 rule both say rollback happens first. Read `load()`: its `.then` callback only calls `setCfg`/`setGlAccounts`/`setStepCodes` — it never calls `setError(null)` today, so reordering does not clear the banner. Swapped the two statements (`void load().catch(() => {})` now first, `setError(...)` second) and updated the trailing comment to `// roll back to server truth first, then report why (§5.13)`, matching the code to the stated rule instead of leaving a latent trap for a future `load()` refactor.

### Verification

- `npx vitest run tests/billing-config.test.ts` → 10/10 passed (post-fix, mapping reverted).
- `npx tsc --noEmit` → clean, no output, no phantom `api/parts/[id]/breaks` errors (none appeared even without a prior `npm run build` this time).
- `npx eslint src tests` → clean, no output.

Not run: full `npm test` (owner runs the full gates separately, per instructions).

Commit: `test(billing): round-trip coverage for every billing config field` (no attribution trailer).
