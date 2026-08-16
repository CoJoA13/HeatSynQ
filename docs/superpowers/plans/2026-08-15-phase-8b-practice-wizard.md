# Phase 8B — Practice DB & First-run Wizard: Implementation Plan

**Date:** 2026-08-15
**Design spec:** `docs/superpowers/specs/2026-08-14-phase-8-reports-parallel-run-design.md` (approved 2026-08-14) — **§5 is the contract for this sub-phase** (§5.1 practice DB, §5.2 demo seed, §5.3 reset, §5.4 watermark, §5.5 checklist, §5.6 order gate, §5.7 password reminder); §7 the data-model row, §8 house rules, §12 the plan-time items.
**Branch:** `phase-8b-practice-wizard` (squash-merged to `main`; attribution in the PR body, never a commit trailer).
**Depends on:** Phase 1 (`app/layout.tsx`, `Shell`, `settings.ts`, `seed.ts`, the `db.ts`/`seed.ts` layered-guard ethos), Phase 5 (`ReadinessGap` in `gl-mapping.ts`, `BillingConfig` singleton), the **whole master-data service graph** (the demo seed calls it), Phase 6/7 (the eight document templates + `defaultConfigFor`), and Phase 7 (`render.ts` + `pdf-lib`, for the practice watermark).
**Plan review:** a 3-lens adversarial review (house-rules/data-integrity · codebase-feasibility · spec-coverage/ordering) ran 2026-08-15 before execution; every substantive finding is incorporated in the body — the **opt-in gate-prereq harness** (not global `truncateAll`), the **ambient-singleton demo seed + full auth bootstrap**, the **§5.7 password reminder** (live signal + client dismiss), the **reprint-watermark test** (T12), and the **banner-E2E home** (T5 component test + opt-in E2E). Not deferred.

## Owner decisions baked into this plan (2026-08-15)

| # | Decision | Ruling |
|---|---|---|
| 1 | **Practice deploy** (§12 item 10) | **Dedicated `practice` compose profile + host port 8080.** `docker compose --profile practice up` is opt-in; the prod bring-up is untouched and never starts practice. |
| 2 | **Demo-slice contents** (§12 item 9) | **I design a representative synthetic slice; owner reviews the actual fixture at T12.** Generic-but-realistic heat-treat customers (incl. a parent/division pair), parts (recipes/pricing/specs), orders spanning OPEN/PARTIAL_SHIPPED/SHIPPED/INVOICED + a posted payment; **no pre-closed month**. |
| 3 | **Order-gate company predicate** (§5.6 / §12 item 5) | **All three letterhead fields** — `company_name` + `company_address` + `company_phone` (the approval default; not relaxed). |
| 4 | **`PRACTICE_MODE` vs `current_database()` disagreement** | **db-identity is authoritative**; `practiceMode()` throws loudly if the env flag claims practice while the connected DB is not `erp_practice` (the dangerous direction — a prod box wrongly flagged practice). The env only corroborates; it never flips the mode. |
| 5 | **`/setup` discoverability + gating** (§5.5 / §8) | **Admin-gated** (`admin.view` to read the rollup, `admin.edit` to confirm/dismiss), **surfaced in the shell until complete or dismissed** (`checklistDismissedAt`). |
| 6 | **Practice first-population** | A **documented, one-time, `erp_practice`-guarded seed command** (`npm run db:seed:demo`), NOT an auto-first-boot seed; the in-app **Reset practice data** control (§5.3) is the refresh path thereafter. |
| 7 | **Demo cert-billing** | Uses **plant-level `BillingConfig.billForCertDefault`/`certChargeDefault`** — the per-part `Part.billForCert`/`certCharge` fields **have no service writer** (read-only in `invoices.ts:544-545`), so a part-level cert override has no path. Filed as a pre-existing backlog note; **not** in 8B scope. |

## The shape every task shares (read once)

**TDD per task:** failing test → implement → pass → commit a small unit. Conventional commits, **no attribution trailer** (squash concatenates it N times). **Commit small units** so a died-mid-task turn resumes from a committed prefix. Run `npm test` + `npx tsc --noEmit` + `npx eslint src tests` per task; **run `npm run test:e2e` on any UI/flow-touching task** (dev server + DEV db `erp`) — a gate row is written **after** watching the run end, or it says PENDING; never a pre-written green claim.

**The db-identity guard split (the load-bearing pattern for T2/T12/T13).** Anything guarded to `erp_practice` (the demo seed, the reset) is split into (a) an **exported internal function** exercised against `erp_test` in CI, and (b) a **thin guarded entry** whose *refusal* is the RED test (`assertPracticeDatabase` throws in the `erp_test` process because `current_database() !== 'erp_practice'`). Without this split the happy path can never run in CI, because vitest connects to `erp_test`.

**Migrations** use the settled **TTY-less two-DB workflow** (CLAUDE.md / the `create-migration` skill): `migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script` → read in full → hand-write `prisma/migrations/<ts>_<name>/migration.sql` → `migrate deploy` to dev **and** `erp_test` → `prisma generate`. `migrate diff` will **not** emit a `CHECK` constraint or a seed `INSERT` — those are added by hand (the `BillingConfig` migration precedent).

**Execution record** in `docs/execution/2026-08-15-phase-8b/` (task briefs, implementer reports, reviewer verdicts, `progress.md`) — **committed on Task T1**, not at the end (the `.superpowers/sdd` clobber lesson).

**Review loop:** a fresh subagent per task → an independent `task-reviewer` per task (spec-compliance + quality, against a task-brief + implementer-report + review-package diff) → fix rounds until approved → a whole-branch review on the strongest model → one fix wave → PR → the Codex GitHub bot re-reviews (expect two rounds; a fix can draw a finding on its own regression) → merge on CI green. From round 6 on, triage non-correctness/concurrency/data-integrity findings to issues.

## Standing traps this phase must not trip

1. **Watermark byte-golden + no double-stamp (T6).** `stampPractice` must **short-circuit to the input `Buffer`** when not in practice mode (production renders stay byte-identical — the reprint-exact + golden-compat guarantee). `renderSheetGroups` currently calls the **public** `renderPdf` per group (`render.ts:307`) — it must switch to an unstamped `renderPdfCore` and stamp the **merged** bytes exactly once, or every traveler/shipping page is stamped twice. The merge `save({ useObjectStreams: false })` (`render.ts:312`) must be preserved so the `/Count N` marker stays readable.
2. **Order-gate blast radius (T7) — an opt-in prereq helper, NOT global `truncateAll`.** `truncateAll` re-seeds `BillingConfig` with `arGlAccountId` **NULL** (`tests/helpers/db.ts:51`) and `company_*` default to `""`. An unconditional gate at `createOrder` reds **every** order-creating vitest file. But seeding the prereqs into the *shared* `truncateAll` baseline is wrong in **both** directions: it reds the ~pristine-state suites that assert the empty default (`billing-config` `arGlAccountId:null` at `tests/billing-config.test.ts:29-37`, `settings` `company_name===""` at `tests/settings.test.ts:13`, `reference-gl`/`paste` GlAccount counts) **and** it contaminates the production `reseedSingletons` (T11) — which T13's reset reuses — turning the reset into a non-singleton seed and breaking trap #4. **The fix:** a separate opt-in `seedOrderGatePrereqs(db)` helper, called in the `beforeEach` of ONLY the order-creating suites; global `truncateAll` and `reseedSingletons` keep seeding **only** the by-construction singletons (BillingConfig `arGl`-NULL, 8 templates, SetupState). The E2E DEV `erp` path needs the same prereqs seeded in `e2e/lib/db-fixtures.ts` (see T7/T15). Because the global baseline is untouched, T3's readiness tests and every pristine-state suite stay green with no churn.
3. **Template config drift (T11).** `reseedSingletons` becomes the **4th consumer** of the `DEFAULT_CONFIG` constants the drift-guard pins. Template versions must be re-seeded from **`defaultConfigFor(docType)`**, never a re-typed JSON literal.
4. **Reset ordering (T13).** The reset must restore the **by-construction singletons** (`BillingConfig` + the 8 PUBLISHED "Standard" templates + `SetupState`) **before** any demo business rows, or it leaves the practice DB in the impossible no-billing-config/no-printable-templates state the restore exists to prevent. It reuses **no** test-only tooling (`truncateAll` stays test-only).
5. **`practiceMode()` cost (T2/T5).** The banner runs `await practiceMode()` on **every** root-layout render (every request). `current_database()` is process-constant (§5.1 forbids per-request DB switching), so the helper **memoizes** (module-level lazy promise) — an un-memoized query adds a DB round-trip to every page.
6. **Client/server boundary (T5).** The practice flag is resolved **server-side only** (`practiceMode()` in the async root layout) and passed down as a boolean prop. `Shell` is `"use client"` and must never read the flag; `/api/auth/me` is auth-gated and unreachable on `/login`, so it is not the channel.
7. **`erp_practice` provisioning is fresh-volume-only (T14).** `db-init/*.sql` runs only at first cluster init on an empty `dbdata` volume. On a box that already ran the prod stack, adding `erp_practice` to `db-init` will **not** create it retroactively — the runbook notes a manual `createdb -U erp erp_practice`.

---

## Task T1 — `SetupState` singleton migration + schema (client regen)

**Goal:** the one new table lands; the client regenerates; the test DB never runs in a state prod cannot be in.

- **Schema** (`prisma/schema.prisma`): add `model SetupState` cloning the `BillingConfig` singleton — `id String @id @default("singleton")`, `numbersConfirmedAt DateTime?`, `checklistDismissedAt DateTime?`, `updatedAt DateTime @updatedAt` (§7). No FKs. **Exactly two non-derivable facts** — the §5.7 password reminder is a **live signal + client-side dismiss** (T9/T10), so it needs **no** `passwordReminderDismissedAt` column and §7's two-field singleton stays intact.
- **Migration** (`prisma/migrations/<ts>_setup_state/migration.sql`, hand-written via the two-DB workflow): `CREATE TABLE` + PK; `ALTER TABLE ... ADD CONSTRAINT "SetupState_singleton_check" CHECK ("id" = 'singleton')`; `INSERT INTO "SetupState" ("id","updatedAt") VALUES ('singleton', now()) ON CONFLICT DO NOTHING` — mirroring the `BillingConfig` migration's CHECK + seed (`migrate diff` emits neither). Apply to dev **and** `erp_test`; `prisma generate`.
- **Test harness:** add the `SetupState` `INSERT ... ON CONFLICT DO NOTHING` re-seed line beside `BillingConfig`'s in `truncateAll` (`tests/helpers/db.ts`).
- **Explicitly NOT here:** the `AuditableModel` union / `SNAPSHOT_INCLUDE` edit and the service — those wait for **T4** (adding a member to the exhaustive `Record<AuditableModel, …>` before the client carries the model fails `tsc`).
- **Test-first:** after `migrate deploy`, `prisma.setupState.findFirst({ where: { id: 'singleton' } })` returns the seeded row; inserting a second row with `id !== 'singleton'` is rejected by the CHECK; the row survives `truncateAll()`.
- **Acceptance:** both DBs on the new migration; `prisma migrate status` clean; client exposes `setupState`.
- **Review focus:** the CHECK + seed are hand-added (not lost); migration applied to BOTH DBs.

## Task T2 — `practiceMode()` leaf (db-identity, authoritative)

**Goal:** the single source of practice-vs-production every consumer reads.

- **New leaf** `src/server/practice-mode.ts` (the `order-locks.ts`/`invoice-guards.ts` dependency-free precedent — imports only `prisma` from `./db` and `HttpError` from `./errors`):
  - `export const PRACTICE_DB_NAME = "erp_practice"` (once).
  - `practiceMode(): Promise<boolean>` — **memoized** (module-level lazy promise) `SELECT current_database() = 'erp_practice'` via the `settings.ts` typed-scalar `$queryRaw` idiom. If `process.env.PRACTICE_MODE === "true"` but db-identity is **not** `erp_practice`, throw loudly (owner decision 4 — the dangerous direction). db-identity is authoritative.
  - `assertPracticeDatabase(tx): Promise<void>` — an **un-memoized** in-request re-check on the caller's `tx`, throwing `HttpError(403)` unless `erp_practice` (the load-bearing reset guard, §5.3).
- **Test-first:** `practiceMode()` resolves `false` in the `erp_test` process (RED with no stubbing — `current_database() === 'erp_test'`); `assertPracticeDatabase(prisma)` throws `HttpError(403)`.
- **Acceptance:** leaf imports nothing but `db`/`errors`; grep confirms it is the only `current_database()` site.
- **Review focus:** memoization present; the loud-throw on the dangerous env mismatch; no service/permission graph dragged in.

## Task T3 — Order-entry readiness predicate leaf (blocking signals)

**Goal:** the two BLOCKING install signals in one leaf so the gate, the UI notice, and the full rollup share one source (the `invoice-guards.ts` "lift the cross-module question into a leaf before the import cycle exists" precedent — keeps `orders.ts` cycle-free).

- **New leaf** `src/server/order-entry-readiness.ts`: a fresh `SetupStep { label, href }` type (reuse only the `ReadinessGap` **shape** from `gl-mapping.ts`, **not** its GL-export `kind` union). Compute:
  - **company identity** = `getSetting(company_name/company_address/company_phone)` all `.trim() !== ""` (all three; the `""` default is the true unset signal).
  - **chart of accounts** = `prisma.glAccount.count({ where: { deletedAt: null } }) > 0` **AND** `getBillingConfig().arGlAccountId != null`.
  - returns `{ ready, gaps: [{ label, href }] }` (`href` → `/admin/settings` for identity, `/admin/billing` for the A/R account). Pure read — no claim, no audit, no Serializable (§8).
- **Test-first:** `ready:false` with a company-identity gap when any of the three settings is blank; a chart-of-accounts gap when no live `GlAccount` OR `arGlAccountId` unset; `ready:true`/empty gaps when all set.
- **Review focus:** own signals (does **not** extend `readinessGaps`); pure read.

## Task T4 — `SetupState` service + audit wiring

**Depends on:** T1.
**Goal:** a threadable getter/setter cloning `billing-config.ts`, audited.

- **New service** `src/server/setup-state.ts`: `const ID = "singleton"`; an empty fallback; `getSetupState(db = prisma)` = `db.setupState.findFirst({ where: { id: ID } })` returning defaults when absent (threadable on a caller `tx` — the rollup T9 needs this); a setter wrapping `auditedUpdate("setupState", ID, () => tx.setupState.upsert(...), { tx })` inside `prisma.$transaction`. `SetupState` has no FKs → **DEFAULT isolation** (do **not** copy `billing-config`'s Serializable/`assertRefExists` branch).
- **Audit** (`src/server/audit.ts`, same task — the `Record` is exhaustive so both edits land together): add `"setupState"` to the `AuditableModel` union **and** `setupState: undefined` to `SNAPSHOT_INCLUDE` (the `billingConfig` precedent).
- **Test-first:** `getSetupState` returns defaults on a rowless DB; the setter upserts `numbersConfirmedAt`/`checklistDismissedAt` and writes exactly one `auditedUpdate` row with an undefined-relations snapshot; a second call updates in place.
- **Review focus:** DEFAULT isolation (no needless Serializable); both audit edits present.

## Task T5 — Practice banner in the root layout

**Depends on:** T2.
**Goal:** a distinct banner that survives `/login` and the me-null loading screen (§5.1).

- **`src/app/layout.tsx`:** make `RootLayout` **async** (currently synchronous, `:7`), `const isPractice = await practiceMode()`, render a new `<PracticeBanner />` as a **sibling of `<Shell>` inside `<body>`, immediately before it** (`:11`) — so it escapes `Shell`'s `/login` (`Shell.tsx:140`) and me-null (`Shell.tsx:141`) early returns. Wrap banner + Shell so `min-h-screen` content isn't pushed off-viewport.
- **New `src/components/PracticeBanner.tsx`:** a fresh full-width Tailwind bar (no existing persistent-banner component to reuse). Presentational — driven by a boolean prop (or a server component); **never** a client component that fetches the flag (owner decision 4 / §8).
- **Test-first:** with `practiceMode()` stubbed `true` the layout renders the banner above Shell regardless of Shell's branches; `false` → absent. (Full login-screen coverage is the T15 E2E.)
- **Review focus:** flag resolved server-side only; banner above the early returns; layout still renders children on every route state.

## Task T6 — PRACTICE/SAMPLE watermark post-stamp in `render.ts`

**Depends on:** T2.
**Goal:** every practice-copy PDF carries the mark, via one shared step both entry points pass through; production stays byte-golden (§5.4).

- **`src/server/pdf/render.ts`:** add a private `stampPractice(bytes: Buffer): Promise<Buffer>`, gated `if (!(await practiceMode())) return bytes;` (byte-golden short-circuit — no pdf-lib re-serialize in production). Otherwise: `PDFDocument.load`, embed a `StandardFont`, draw rotated `degrees(45)` low-opacity **"PRACTICE / SAMPLE"** on every `pdf.getPages()`, `save({ useObjectStreams: false })`.
- **Route both entry points through it exactly once:** extract `renderPdf`'s body (`:261-285`) into a private unstamped `renderPdfCore`; public `renderPdf = stampPractice(await renderPdfCore(def))`; switch `renderSheetGroups`' per-group call (`:307`) to `renderPdfCore` (unstamped) and `stampPractice` the **merged** bytes once after `:312`. Add `degrees`/`rgb`/`StandardFonts` imports from `pdf-lib` (the only sanctioned import site). **Not** a pdfmake `background` (the two-pass path refuses function-valued keys, `:267-270`).
- **Test-first:** with `practiceMode()` stubbed `true`, `renderPdf` output carries the stamp on every page and `renderSheetGroups` stamps the merged doc exactly once (no double opacity); with `false` the bytes are **byte-identical** to today; `/Count N` stays readable.
- **Review focus:** the short-circuit is a true no-op in production; single stamp on the merged path; the `useObjectStreams: false` preservation.

## Task T7 — Order-entry gate at the `createOrder` chokepoint + harness fix

**Depends on:** T3.
**Goal:** real order entry blocked until company identity AND chart of accounts are set, enforced as a **pre-transaction read** at the single chokepoint (§5.6).

- **`src/server/orders.ts`:** insert the gate between `const traffic = await trafficSettings()` (`:676`) and `return withDbErrors(...)` (`:678`) — call the T3 predicate on the plain `prisma` client (no `tx`) and `throw new HttpError(400, <message naming /setup>)` when either signal is unmet. It **must** be before `saveNewOrder`'s Serializable tx (inside Serializable it would enlarge the predicate read-set and turn a concurrent config edit into a no-retry abort). `HttpError` carries no `href` field — the link lives in the message text. TOCTOU is benign (§5.6).
- **Harness fix (same commit — trap #2), opt-in NOT global:** add a `seedOrderGatePrereqs(db)` helper (in `tests/helpers/db.ts` or a peer) that seeds `company_name/address/phone`, one live `GlAccount`, and `BillingConfig.arGlAccountId`; call it in the `beforeEach` of **only** the order-creating vitest suites (orders, shippers, invoices, certs, quotes, and any report suite that creates orders). **Do NOT touch global `truncateAll`** — that would red the pristine-state suites (billing-config/settings/reference-gl) and contaminate `reseedSingletons`/T13 (trap #2/#4). Order-creating suites that *want* the unset state (rare) simply don't call the helper.
- **E2E fixture (same task):** seed the same prereqs — company identity + one live `GlAccount` + `BillingConfig.arGlAccountId` — in `e2e/lib/db-fixtures.ts` `create()`, with a restore of prior company-identity settings mirroring the existing `priorBillingConfig` snapshot. Without this every order-creating Playwright flow throws at the gate. (The one flow that needs the *blocked* state — `setup-checklist.spec`, T15 — clears and restores within itself.)
- **Test-first:** `createOrder` throws `HttpError(400)` when company identity is missing; throws when chart of accounts is missing; succeeds when both set (the test seeds prereqs via the helper); the existing order-creating suites stay green under the opt-in helper.
- **Review focus:** read is pre-transaction; global `truncateAll`/`reseedSingletons` remain singleton-only (no gate prereqs leak in); the opt-in helper covers **every** order-creating vitest file **and** the E2E fixture; message links to `/setup`.

## Task T8 — Order-entry readiness GET route + blocking UI notice

**Depends on:** T3, T7.
**Goal:** the order-entry screen shows the blocking notice instead of the form when setup is incomplete, deriving from the **same** T3 computation so it cannot drift from the gate.

- **New route** `src/app/api/orders/entry-readiness/route.ts` (peer of `entry-defaults`): `mustCan(requireUser(), "orders", "create")`, returns the T3 predicate result. Pure read.
- **`src/app/orders/new/page.tsx`:** fetch it via `api<>()`; render the blocking notice ("Finish setup before entering orders", linking `/setup`) in place of the form branch when not-ready.
- **Test-first:** the route returns `ready:false`+gaps when unmet, `ready:true` when set; a component test asserts `orders/new` renders the notice (not the form) when the fetch reports not-ready.
- **Review focus:** notice and gate share the T3 source; route auth on `orders.create`.

## Task T9 — Install-readiness rollup service + `/api/setup/readiness` route

**Depends on:** T3, T4.
**Goal:** the full dependency-ordered checklist (§5.5 steps 1–8).

- **New service** `src/server/install-readiness.ts`: composes the T3 blocking predicate (company identity, chart of accounts) and adds the derived-live signals in dependency order (§5.5 steps 1–8): the **recommended change-admin-password** step (§5.5 step 1, §5.7 — a **live signal**: the user named `admin` still has a hash that verifies `"admin"`; recommended/non-blocking; deep-link `/admin/users`); starting document numbers (`numbersConfirmedAt` from `getSetupState`); step codes/surcharges present; remaining reference tables; customers/parts counts > 0; plus the persisted **"checklist dismissed"** (`checklistDismissedAt`). Each item carries a `recommended` vs `blocking` flag so the UI (T10) and the order gate (T7) agree on which are hard. Reuse only the `ReadinessGap` shape; compute own signals (do **not** extend `readinessGaps`). Pure read (may wrap several reads in one RepeatableRead tx if internal consistency needs it — the `aging.ts` precedent — but not required).
- **New route** `src/app/api/setup/readiness/route.ts`: `mustCan(requireUser(), "admin", "view")`, returns the ordered array.
- **Test-first:** the rollup returns the dependency-ordered steps with correct gap/complete state per signal — including the **password-still-default live signal** flipping to complete once the admin password changes, and the recommended-vs-blocking flags; the route returns the array behind `admin.view`.
- **Review focus:** dependency ordering matches §5.5; own signals; the two persisted facts come from `SetupState`.

## Task T10 — `/setup` checklist page + confirm/dismiss route + nav

**Depends on:** T4, T9.
**Goal:** the dismissible, completion-remembering first-run checklist (D6).

- **New page** `src/app/setup/page.tsx` (2-line server shell) → `"use client"` `SetupChecklist.tsx` cloned from `ReportsIndex.tsx`: `usePermissions()` + gate, a `loaded` flag distinct from empty (the §5.15 silent-dead-end lesson), a GateNotice on denial, fetch `/api/setup/readiness` (T9), render each step's label + a "Fix"/"Set up" anchor to its `href` (the gap-list render precedent). Every step deep-links to an **existing** admin/config endpoint — **no new mutation surface** except the two persisted facts.
- **New route** `src/app/api/setup/state/route.ts` (`PUT`, `admin.edit`): drives `setSetupState` to record `numbersConfirmedAt` (starting-numbers confirm) and `checklistDismissedAt` (dismiss).
- **Password reminder surface (§5.7):** a small `PasswordReminder` client component in the Shell, shown when the T9 password-still-default live signal is true **and** not dismissed this session (client-side `localStorage`, no persisted field — the reminder self-clears permanently once the password changes and the live signal flips). This is §5.7's "dismissible reminder", **distinct** from the checklist item; nothing is enforced (§5.7 — owner declined the forced change).
- **Nav / dynamic surfacing** (`src/lib/nav.ts` + Shell): `nav.ts`'s `NavEntry[]`/`canViewArea` filter is **area-gated only** and cannot express readiness — so `/setup`'s "surfaced while incomplete/undismissed" (owner decision 5) needs a **Shell-level check** (the Shell reads the rollup's complete/`checklistDismissedAt` flag and surfaces the entry), not merely a static `NavEntry` row.
- **Test-first:** `PUT /api/setup/state` stamps `numbersConfirmedAt` / `checklistDismissedAt` via `setSetupState` (admin.edit-gated); the component renders each rollup step with a Fix link and hides completed steps; the `PasswordReminder` shows when the live signal is true and hides once dismissed / password changed.
- **Review focus:** no new mutation surface beyond the two persisted facts; the reminder dismiss is client-side (no schema field); the dynamic surfacing is a Shell check, not a static nav row; admin gating; the `loaded`-vs-empty distinction.

## Task T11 — Extract `reseedSingletons` out of test-only code

**Depends on:** T1.
**Goal:** a production-grade singleton re-seed helper the reset (T13) reuses, without importing test-only code (`truncateAll` stays test-only).

- **New module** `src/server/practice-seed.ts` exposing `reseedSingletons(db)` performing `truncateAll`'s exact re-seed body: `BillingConfig` `INSERT ('singleton', false, now()) ON CONFLICT DO NOTHING`; `documentTemplate.createMany` over the fixed `standard-<doctype>` ids then `documentTemplateVersion.createMany` (v1 PUBLISHED, `config = defaultConfigFor(docType)` — trap #3, **never** a re-typed literal) then the single `publishedVersionId` UPDATE (a separate 3rd statement — the two `createMany` can't cross-reference); plus the new `SetupState` `INSERT ('singleton') ON CONFLICT`.
- **Relocate** `templateId`/`templateVersionId` out of `tests/helpers/db.ts:12-19` into this module and re-export from `db.ts` so the ~130 test files stay green. Refactor `truncateAll` to call `reseedSingletons` after its TRUNCATE.
- **Test-first:** `reseedSingletons()` against a DB with those singletons deleted restores `BillingConfig`, the 8 PUBLISHED "Standard" templates with correct `publishedVersionId` pointers (config deep-equal to `defaultConfigFor` per type — drift guard green), and `SetupState`; `truncateAll()` still yields the same post-condition after the refactor.
- **Review focus:** config from `defaultConfigFor` (drift guard); `truncateAll` behavior unchanged; no test-only symbol leaks into the reset path.

## Task T12 — Demo-seed module — the representative slice through the services

**Depends on:** T2, T6, T7.
**Goal:** the practice DB gets a gate-passing, singleton-complete representative slice built **strictly through the services** (never `createMany`; owner reviews the fixture here).

- **New `prisma/demo-seed.ts`** (separate from `seed.ts`): an exported `seedDemoSlice()` orchestration + a **db-identity-guarded entry** (`assertPracticeDatabase` / `DATABASE_URL` check) — the guard-split (tested internal fn + refusal-is-RED entry). **The services take no `tx`** (15/17 use the module-level `src/server/db.ts` singleton; only `createInvoice`/`finalizeInvoice` accept an optional one), so `seedDemoSlice` writes through the **ambient `DATABASE_URL`-pointed singleton** — no tx is threaded, and the guard is a **process-level `current_database()` pre-check**, not a transaction wrapping the seed. **First reproduce `seed.ts`'s auth bootstrap** (Admin Role → `ALL_PERMISSIONS` → the `admin`/`admin` user, in that order — `User.roleId` requires the Role) so the practice DB is loginable, including after T13's reset. Then build in dependency order through the existing service entrypoints — `createReference('glAccount')` chart of accounts → `createStepCode(+GL)` → `createSurcharge(+GL)` → `setBillingConfig(arGlAccountId + GL refs)` → `setSetting` company identity ×3 → `createCustomer` (incl. a parent + a division via `parentId`) + `addAddress(SHIP_TO)` / `addContact` → `createPart` (+ `addPartPrice`/`addPriceBreak` referencing step codes, `addStep` recipes, `addPartSpec`, `addPartInspection`) → `createOrder` (OPEN) / `createShipper` (PARTIAL_SHIPPED, SHIPPED — passing the required `opts: { canOverrideCreditHold: true }`) / `createInvoice` + `finalizeInvoice` (INVOICED) → `createBatch` + `addPayment` + `postBatch`. **Company identity + chart of accounts + `arGlAccountId` are set BEFORE the first `createOrder`** so the T7 gate passes with no exemption. **No pre-closed month.** Any `StoredDocument` it stores is rendered through `render.ts` (watermarked — §5.2, why this depends on T6). Cert billing uses plant-level `BillingConfig` defaults (owner decision 7).
- **Script wiring** (`package.json`): `db:seed:demo` (owner decision 6 — the documented one-time command).
- **Owner review checkpoint:** the exact customers/parts/orders are presented to the owner when this task lands (owner decision 2).
- **Test-first:** `seedDemoSlice()` against the truncated test DB produces a gate-passing, singleton-complete slice — orders spanning OPEN/PARTIAL_SHIPPED/SHIPPED/INVOICED, ≥1 finalized invoice and one posted payment batch, a parent/division customer pair — all through the services (no `createMany`; counters bumped by `allocateNumber`); **a login-capable `admin` exists after the run** (Role + permissions + user); the guarded entry refuses when `current_database() !== 'erp_practice'`. **The §10 reprint-watermark test lives here** (practiceMode-stubbed true — the T6 precedent, since a plain `erp_test` run has practiceMode false and would store *un*watermarked bytes): seed a `StoredDocument` through `render.ts` under the stubbed flag, **reprint** it, and assert the reissued bytes carry the mark **and** `Buffer.compare`-equal the stored bytes (a reprint reissues stored bytes verbatim — §5.4).
- **Review focus:** no `createMany`; no pre-written `*_number_next`; auth-bootstrap-first (loginable post-reset); the gate-order sequencing; the reprint-watermark assertion (via stubbed practiceMode, not the plain `erp_test` run); the guard-split via the ambient singleton (non-tx).

## Task T13 — Reset-practice-data route (double-guarded) + practice-only control

**Depends on:** T2, T11, T12.
**Goal:** a production-grade reset that can never touch prod data (§5.3).

- **New route** `src/app/api/practice/reset/route.ts`: a guarded entry + internal reset fn. **Double guard:** (1) authorized only in practice mode; (2) the load-bearing guard — a `current_database() = 'erp_practice'` **pre-check on the ambient singleton** (`assertPracticeDatabase`) at the top of the request, refusing outright otherwise. The reset is **intentionally non-atomic** — `seedDemoSlice` (T12) spans many independent service-owned transactions, so the guard is a pre-check, **not** a tx wrapping the whole reset. Compose: truncate practice rows → `reseedSingletons` (T11) restoring `BillingConfig` + 8 templates + `SetupState` **before** any business rows (trap #4) → `seedDemoSlice` (T12, which also re-bootstraps the `admin` login). Reuses **no** test-only tooling.
- **New control** `src/components/PracticeResetControl.tsx`, surfaced **only** in practice mode (server-resolved via `practiceMode()`), hidden in production.
- **Test-first:** the route is refused (403/throw) when `current_database() !== 'erp_practice'` (RED — fires naturally in the `erp_test` process, the §5.3 guard); the internal reset fn restores the singletons before demo rows, leaves a gate-passing install, and yields a **login-capable `admin`** afterward.
- **Review focus:** singletons before business rows; the inner db-identity re-check; the control hidden in prod.

## Task T14 — Deploy shape — `erp_practice` DB + practice app service

**Depends on:** none (infra; can run any time — but T15 needs it).
**Goal:** the separate practice copy exists in compose under a dedicated profile + port 8080 (owner decision 1).

- **`db-init`:** provision `erp_practice` exactly as `erp_test` is (append `CREATE DATABASE erp_practice OWNER erp;` or a new `db-init/create-practice-db.sql`). Note the fresh-volume-only caveat (trap #7) in the runbook.
- **`docker-compose.yml`:** add an `app-practice` service cloning the prod app — `build .`, `depends_on` db healthy, `SESSION_SECRET` from env, but `DATABASE_URL → ...@db:5432/erp_practice`, `PRACTICE_MODE: "true"`, **host port 8080**, and its **own `practice` profile** (NOT `prod` — the prod-only backup must not adopt practice; §6.3). No Dockerfile change — the shared CMD already runs `prisma migrate deploy` against `DATABASE_URL` on start, migrating `erp_practice`.
- **`.env.example`:** add `DATABASE_URL_PRACTICE` / `PRACTICE_MODE` for local (non-docker) practice runs.
- **Test-first (infra):** `docker compose config` resolves cleanly with `app-practice` present, `DATABASE_URL` → `erp_practice`, `PRACTICE_MODE=true`, port 8080, `practice` profile — validated by `compose config` + a manual bring-up, not a vitest case.
- **Review focus:** the `practice` profile is separate from `prod`; port 8080; the provisioning caveat documented.

## Task T15 — E2E flows — banner on login + checklist blocks/unblocks order entry

**Depends on:** T5, T8, T10, T14.
**Goal:** the two headline flows proven end-to-end (§5.6/§10).

- **`tests/e2e/setup-checklist.spec.ts`** (default gate, DEV `erp`): since T7's fixture seeds the gate prereqs so every other flow passes, this spec is **self-contained** — it first CLEARS company identity + `arGlAccountId` (asserting the order screen shows the blocking notice), reconfigures them through the checklist links (asserting order entry unblocks and an order saves), then **restores** the configured state so later flows in the shared sequential `erp` db are unaffected.
- **`tests/e2e/practice-banner.spec.ts`** (opt-in, NOT the default gate): the banner-on-login/me-null §10 requirement's **primary home is the T5 component/integration test** (practiceMode stubbed), because the default E2E harness drives DEV `erp` where `practiceMode()` is false and the banner never renders. The Playwright banner check is a **documented opt-in** run against a practice-pointed dev server — prerequisites spelled out in the T14 runbook: `createdb -U erp erp_practice` (trap #7) → `migrate deploy` → `db:seed:demo` → a dev server on `DATABASE_URL→erp_practice` — gated behind a `PRACTICE_E2E` env so it never reds the standard gate.
- **Discipline:** the subagent E2E run rules (resume-and-verify, no pre-written gate rows, controller re-runs); clean any killed-run `ClosePeriod`/GL debris in FK order before re-running; `timeout --kill-after=30 600 npm run test:e2e` (TERM first).
- **Review focus:** the checklist flow actually exercises the gate (not stubbed) and restores state for the shared db; the banner requirement has a defined home (T5 component test + opt-in E2E); no strand of the close-period E2E hang.

## Task T16 — Docs — CLAUDE.md + HANDOFF + spec §15 (Phase 8B)

**Depends on:** T2, T4, T6, T7, T11, T13, T14 (the architecture-defining tasks; each prior task also amends docs inline — this is the closing reconciliation, not the only doc write).
**Goal:** the standing architecture is recorded per the house rule.

- **CLAUDE.md** (curated, displacing not appending): the `practiceMode()` db-identity helper as the single source for banner + watermark + reset guard; the `render.ts` practice-watermark seam (pdf-lib's two sanctioned jobs = merge **and** practice post-stamp); the `SetupState` singleton as a second by-construction singleton beside `BillingConfig`; the pre-transaction order-entry readiness gate at the single `createOrder` chokepoint.
- **HANDOFF** §4/§6/§9 + backlog + the singleton roster + the next-phase (8C) kickoff.
- **Spec §15** — an "Amendments for Phase 8 (8B)" block: practice copy = separate db-identity-guarded copy, watermark, representative-slice reset, setup checklist, order gate.
- **Roadmap** Phase 8 row.
- **Acceptance:** no failing unit test — verified by the full gate chain + the whole-branch review matching the code that actually landed.

---

## Ordering rationale (why this avoids cycles and stale clients)

- **Migration-first:** T1 (the only 8B migration) lands with `prisma generate` before any code references `setupState`; every SetupState consumer (T4 service, T9 rollup, T11 reseed, T13 reset) depends transitively on T1. The audit-union + `SNAPSHOT_INCLUDE` edit is deferred from T1 to **T4** — adding a member to the exhaustive `Record` before the client carries the model, or without the paired snapshot entry, fails `tsc`; the two edits land together once the client exists.
- **Leaf-first:** `practiceMode()` (T2) and the order-entry predicate (T3) are dependency-free leaves with no schema dependency — they can start in parallel with T1. T3 is pulled out (the `invoice-guards.ts` precedent) so the gate (T7), the UI notice (T8), and the rollup (T9) share ONE source and `orders.ts` never grows an import cycle.
- **Extract-before-consume:** `reseedSingletons` (T11) is lifted into a production module **before** the reset (T13) depends on it.
- **Service → route → UI:** T4 precedes T9/T10; T3/T9 precede T8/T10; T6 (watermark seam) precedes T12 (whose stored docs must render watermarked).
- **Two load-bearing cross-couplings:** (a) the gate (T7) precedes the demo seed (T12) so the seed is authored against the **live** gate (identity + accounts before the first `createOrder`); (b) the reset (T13) composes T11 (singletons first) then T12 (demo rows) behind T2's `assertPracticeDatabase`.
- **Infra & docs:** T14 is code-independent (any time, but T15 needs it); T16 is the closing consolidation.

## Testing & gates

Per-task vitest as specified above; the full chain (`npm test`, `tsc`, `eslint`, `build`) per task; `npm run test:e2e` on every UI/flow-touching task. Whole-branch review on the strongest model before PR. The RED safety tests that must genuinely fire: `practiceMode()` false in `erp_test` (T2), `assertPracticeDatabase` refusal (T2/T13), the demo-seed guarded-entry refusal (T12), production render byte-identical (T6).

## Open items carried into execution

- **Demo-slice contents** (owner reviews at T12 — owner decision 2).
- **§5.7 password reminder interpretation (owner may override at review):** resolved as a **live signal** (admin hash still verifies `"admin"`) driving a recommended checklist step **plus** a standalone **client-side-dismissible** reminder — deliberately **no** new `SetupState` field (§7 stays two-field), the reminder self-clears once the password changes. If the owner prefers a persisted per-reminder dismiss (a schema field) or the checklist item alone, say so and T1/T9/T10 adjust.
- **Practice banner E2E** — **resolved:** primary home is the T5 component/integration test (practiceMode stubbed); the Playwright banner check is an opt-in `PRACTICE_E2E` run against a practice-pointed dev server (T14 runbook), never part of the default gate.
- **Pre-existing backlog note (not 8B):** `Part.billForCert`/`certCharge` have no service writer — a part-level cert-billing override has no path; file an issue.
- **`erp_practice` on existing boxes** needs a manual `createdb` (trap #7) — captured in the T14 runbook.
