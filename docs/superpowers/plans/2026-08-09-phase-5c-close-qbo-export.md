# Phase 5C — Month-End Close & QBO Summary Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided month-end close (invoiced/paid/ending-A/R continuity schedule, frozen per month, soft-reopenable, locking its month against backdated posting) and a downloadable QuickBooks Online summary-journal export (accrual two-sided, idempotent per-event delta, refusing to post an account-less line).

**Architecture:** A pure mapping leaf (`gl-mapping.ts`) turns already-read invoice/payment/application rows into balanced journal lines and lists account gaps; a dependency-free period-lock leaf (`period-locks.ts`) answers "is this month closed?" and is wired into every 5A/5B posting mutation under its existing row claim; a close service (`close-periods.ts`) freezes the month's schedule and reconciles it against 5B's point-in-time aging; an export service (`gl-export.ts`) computes the per-event delta against an append-only `GlPosting` ledger and renders a CSV + a stored posting-register PDF. Everything derives from live 5A/5B rows — no balance or posted-flag is ever cached on `Invoice`/`Payment`/`Application`.

**Tech Stack:** Next.js 16 (App Router) · React 19 · Prisma 7 (client generated into `prisma/generated/`, gitignored) · PostgreSQL 18 · TypeScript 5.9 · Vitest 3 (integration against the real `erp_test` DB) · Playwright · pdfmake (server, via `PdfPrinter`) · exceljs.

**Binding documents:** the approved spec `docs/superpowers/specs/2026-08-09-phase-5c-close-qbo-export-design.md` (§ references below point at it); the original spec's §3 non-goals and §15 decision log; `CLAUDE.md` house rules.

## Global Constraints

Every task's requirements implicitly include this section.

- **All commands run from `erp/`.** Source is `erp/src/**`, tests `erp/tests/**`, schema `erp/prisma/**`.
- **TDD per task:** failing test → run it red → minimal implement → run it green → commit. Vitest against the real `erp_test` DB; `truncateAll()` in `beforeEach`; `fileParallelism: false` (never parallelize).
- **Conventional commits, NO attribution trailer on individual commits** (owner rule, 2026-08-01 — the squash concatenates them). Attribution goes in the PR body only.
- **Migrations are hand-written and applied to BOTH databases.** `npx prisma migrate dev` refuses without a TTY. Use the `/create-migration` skill, or: edit `schema.prisma` → `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script` → read the full output → hand-write `prisma/migrations/<timestamp>_<name>/migration.sql` → `npx prisma migrate deploy` (dev) → `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy` → `npx prisma generate`.
- **Services own business rules; routes stay thin:** `mustCan(requireUser(), area, action)` first line, `SCHEMA.strict().parse(await req.json())`, delegate. `requireUser()` takes **no** argument (reads AsyncLocalStorage). Raise expected failures with `throw new HttpError(status, message)`.
- **Every mutation goes through `auditedCreate`/`auditedUpdate`/`auditedSoftDelete`**; new auditable models join `AuditableModel` and `SNAPSHOT_INCLUDE`.
- **Client components must not import from `src/server/**`** — mirror server return types locally as `type` aliases; fetch via `api<T>()`; gate via `usePermissions()` + `gate()`/`gateDo()`.
- **Soft delete only** (`deletedAt`); `ClosePeriod`/`GlExportBatch`/`GlPosting` are **not** soft-deletable (a close reopens; a batch/posting is append-only — a correction is a later reversing posting, never an edit or delete).
- **Route handler tests pass ctx:** `handler(request, { params: Promise.resolve({...}) })` — required even for paramless routes.
- **Row locks, not isolation, guard cross-transaction invariants;** re-read guarded state under the claim. A concurrency test that passes is **not** evidence unless RED-verified with the guard removed and the competing caller pinned to Read Committed.
- **PDF output is not byte-deterministic across renders** — pin content (e.g. the uncompressed `/Count N` marker), never `Buffer.compare` two fresh renders. Stored-byte reprints stay exact.
- **Run `npm run test:e2e` whenever a change touches any UI/flow** (dev server + DEV db `erp` + bundled Chromium).
- **Money is summed in integer cents** (`cents(n)=Math.round(n*100)`, then `/100`) — the `aging.ts`/`ar-balances.ts` rule — or reconciliations drift on float.
- **Quality gates that must stay green:** `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, `npm run test:e2e`.

---

## File map

**Create:**
- `erp/src/server/gl-mapping.ts` — pure: event→journal lines (§5) + readiness gaps (§7). Leaf (imports only types).
- `erp/src/server/period-locks.ts` — dependency-free leaf: `lockMonth`, `closedPeriodFor`, `assertPeriodOpen`. The period lock (§6.3).
- `erp/src/server/close-periods.ts` — close/reopen lifecycle, continuity schedule, aging reconciliation (§6).
- `erp/src/server/gl-export.ts` — per-event delta vs `GlPosting`, CSV + register, batch write (§4.3, §5).
- `erp/src/server/pdf/posting-register.ts` — pure `TDocumentDefinitions` builder for the register PDF.
- `erp/src/lib/gl-constants.ts` — client-safe constants (journal sides, close status, CSV columns).
- `erp/src/app/api/receivables/close/preliminary/route.ts`, `close/route.ts`, `close/[id]/reopen/route.ts`, `close/[id]/export/route.ts`, `close/export/[batchId]/file/route.ts`, `close/export/[batchId]/register/route.ts`, `close/readiness/route.ts`, `close/readiness/export/route.ts`.
- `erp/src/app/receivables/close/page.tsx` + `Close.tsx` (client screen).
- Tests: `erp/tests/gl-mapping.test.ts`, `period-locks.test.ts`, `close-periods.test.ts`, `gl-export.test.ts`, and additions to `receivables-routes.test.ts`, `billing-config.test.ts`, `reference-links-sweep.test.ts`, `partial-unique-sweep.test.ts`; E2E `erp/tests/e2e/close.spec.ts`.

**Modify:**
- `erp/prisma/schema.prisma` — 3 new models + 3 `BillingConfig` FK columns + 3 `GlAccount` back-relations.
- `erp/src/server/audit.ts` — `AuditableModel` + `SNAPSHOT_INCLUDE`.
- `erp/src/server/settings.ts` — `gl_export_batch_number_next` counter.
- `erp/src/server/billing-config.ts` — the 3 new FKs (five spots).
- `erp/src/lib/reference-links.ts` — 3 registry entries.
- `erp/src/server/invoices.ts`, `receipts.ts`, `applications.ts` — wire `assertPeriodOpen`.
- `erp/src/app/admin/billing/page.tsx` — 3 GL selects.
- `erp/src/app/receivables/ReceivablesNav.tsx` (or the nav source) — a "Close" tab.
- Docs at the final task.

---

## Task 1: Data model, migration, audit + counter registration

**Files:**
- Modify: `erp/prisma/schema.prisma`
- Create: `erp/prisma/migrations/<timestamp>_phase_5c_close_and_gl_export/migration.sql`
- Modify: `erp/src/server/audit.ts`, `erp/src/server/settings.ts`
- Modify: `erp/tests/partial-unique-sweep.test.ts`
- Test: `erp/tests/close-periods.test.ts` (smoke only in this task)

**Interfaces:**
- Produces: models `ClosePeriod`, `GlExportBatch`, `GlPosting`; `BillingConfig.arGlAccountId`/`discountGlAccountId`/`writeOffGlAccountId`; the `gl_export_batch_number_next` `NumberSettingKey`. Statuses are plain `String` columns (the `ReceiptBatch.status` precedent), values defined in `gl-constants.ts` (Task 3) — **no Prisma enum**.

- [ ] **Step 1: Add the three models + BillingConfig columns to `schema.prisma`.** Append the models and extend `BillingConfig` + `GlAccount`:

```prisma
model ClosePeriod {
  id             String    @id @default(cuid())
  year           Int
  month          Int // 1-12
  status         String    @default("CLOSED") // CLOSED | REOPENED (gl-constants.ts)
  // Frozen continuity schedule (§4.1). Beginning = prior close's ending; first = 0.
  beginningAr    Decimal   @db.Decimal(12, 2)
  invoicedTotal  Decimal   @db.Decimal(12, 2)
  creditTotal    Decimal   @db.Decimal(12, 2)
  paymentTotal   Decimal   @db.Decimal(12, 2)
  discountTotal  Decimal   @db.Decimal(12, 2)
  writeOffTotal  Decimal   @db.Decimal(12, 2)
  endingAr       Decimal   @db.Decimal(12, 2)
  agingEndingAr  Decimal   @db.Decimal(12, 2) // aging net at period end, for the §6 variance
  closedAt       DateTime  @default(now())
  closedById     String?
  closedBy       User?     @relation(fields: [closedById], references: [id])
  reopenedAt     DateTime?
  reopenReason   String    @default("")
  notes          String    @default("")
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  exportBatches  GlExportBatch[]

  @@unique([year, month]) // plain unique — not soft-deletable, so no partial index
}

model GlExportBatch {
  id                 String        @id @default(cuid())
  exportNumber       Int           @unique // gl_export_batch_number_next; allocation-only, never reissued
  closePeriodId      String
  closePeriod        ClosePeriod   @relation(fields: [closePeriodId], references: [id])
  periodEnd          DateTime      @db.Date // the JE date stamped on every line in this batch (§ ruling 7)
  emittedAt          DateTime      @default(now())
  emittedById        String?
  emittedBy          User?         @relation(fields: [emittedById], references: [id])
  fileName           String
  fileContentType    String        @default("text/csv")
  file               Bytes
  registerContentType String       @default("application/pdf")
  register           Bytes
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  postings           GlPosting[]

  @@index([closePeriodId])
}

model GlPosting {
  id            String        @id @default(cuid())
  batchId       String
  batch         GlExportBatch @relation(fields: [batchId], references: [id])
  sourceType    String // INVOICE | CREDIT | PAYMENT | DISCOUNT | WRITE_OFF (gl-constants.ts)
  sourceId      String
  glDate        DateTime      @db.Date // the event's GL date (§4.3)
  glAccountId   String?
  glAccount     GlAccount?    @relation(fields: [glAccountId], references: [id], onDelete: SetNull)
  glAccountName String        @default("") // frozen account-number text
  debit         Decimal       @default(0) @db.Decimal(12, 2)
  credit        Decimal       @default(0) @db.Decimal(12, 2)
  side          String // SALES | CASH
  memo          String        @default("") // the line's memo (preserved so reversals reproduce it)
  isReversal    Boolean       @default(false)
  createdAt     DateTime      @default(now())

  @@index([sourceType, sourceId])
  @@index([batchId])
  @@index([glDate])
}
```

Add to `model BillingConfig` (mirror the existing `BillingSalesTaxGl` pair exactly — each FK needs a UNIQUE relation name):

```prisma
  arGlAccountId       String?
  arGlAccount         GlAccount?       @relation("BillingArGl", fields: [arGlAccountId], references: [id])
  discountGlAccountId String?
  discountGlAccount   GlAccount?       @relation("BillingDiscountGl", fields: [discountGlAccountId], references: [id])
  writeOffGlAccountId String?
  writeOffGlAccount   GlAccount?       @relation("BillingWriteOffGl", fields: [writeOffGlAccountId], references: [id])
```

Add to `model GlAccount` the back-relations (a `GlAccount` is referenced by `BillingConfig` many-named and by `GlPosting`):

```prisma
  billingAr       BillingConfig[]   @relation("BillingArGl")
  billingDiscount BillingConfig[]   @relation("BillingDiscountGl")
  billingWriteOff BillingConfig[]   @relation("BillingWriteOffGl")
  glPostings      GlPosting[]
```

Add the `closedBy`/`emittedBy` back-relations on `model User` (find the `User` model and add):

```prisma
  closedPeriods ClosePeriod[]
  glExports     GlExportBatch[]
```

- [ ] **Step 2: Generate the migration SQL (TTY-less).** Run from `erp/`:

```bash
npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script
```

Read the full output. It will emit `CREATE TABLE "ClosePeriod"/"GlExportBatch"/"GlPosting"`, their indexes and FKs, and three `ALTER TABLE "BillingConfig" ADD COLUMN ... TEXT` + three `ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE`. Paste it verbatim into `prisma/migrations/<timestamp>_phase_5c_close_and_gl_export/migration.sql`. No hand-written CHECK or enum is needed (statuses are plain strings; no new Prisma enum). Confirm the `BillingConfig` FK add matches the precedent:

```sql
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_arGlAccountId_fkey" FOREIGN KEY ("arGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply to both databases and regenerate the client.**

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npx prisma generate
```

- [ ] **Step 4: Register the three models in the audit layer.** In `erp/src/server/audit.ts`, extend the `AuditableModel` union (last line) and `SNAPSHOT_INCLUDE`:

```ts
// AuditableModel — append to the final line:
  | "receiptBatch" | "payment" | "application"
  | "closePeriod" | "glExportBatch";
```

```ts
// SNAPSHOT_INCLUDE — add:
  closePeriod: undefined,
  glExportBatch: { postings: true }, // the export's audit trail is its batch + the postings it emitted
```

`GlPosting` is **not** in `AuditableModel`: it is never independently created/updated/deleted — it is written only inside the `glExportBatch` create's transaction and snapshotted through the `{ postings: true }` include.

- [ ] **Step 5: Add the export-batch counter to the settings registry.** In `erp/src/server/settings.ts`, add to the `SETTINGS` object, beside `receipt_batch_number_next`:

```ts
  gl_export_batch_number_next: {
    schema: numberSeed, default: 1000, label: "Next GL-export batch number", group: "Numbering",
  },
```

The key **must** end in `_number_next` or it won't satisfy `NumberSettingKey` and `allocateNumber` won't accept it.

- [ ] **Step 6: Exempt `GlExportBatch.exportNumber` in the partial-unique sweep.** In `erp/tests/partial-unique-sweep.test.ts`, add to the `ALLOWED` set with a comment:

```ts
  "ReceiptBatch.batchNumber",
  // Allocation-only from gl_export_batch_number_next, never reissued (a discarded/reversed export
  // must never free a number a batch already carries) — the creditNumber/batchNumber precedent.
  "GlExportBatch.exportNumber",
```

`ClosePeriod` and `GlPosting` carry no soft-delete column, so their `@unique`/`@@unique` need no exemption.

- [ ] **Step 7: Write a smoke test proving the models exist and type.** Create `erp/tests/close-periods.test.ts`:

```ts
import { beforeEach, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";

beforeEach(truncateAll);

it("can create a ClosePeriod, GlExportBatch, and GlPosting", async () => {
  const period = await prisma.closePeriod.create({
    data: {
      year: 2026, month: 7, beginningAr: 0, invoicedTotal: 100, creditTotal: 0,
      paymentTotal: 40, discountTotal: 0, writeOffTotal: 0, endingAr: 60, agingEndingAr: 60,
    },
  });
  const batch = await prisma.glExportBatch.create({
    data: {
      exportNumber: 1000, closePeriodId: period.id, periodEnd: new Date("2026-07-31"),
      fileName: "gl-2026-07.csv", file: new Uint8Array([1]), register: new Uint8Array([2]),
    },
  });
  await prisma.glPosting.create({
    data: {
      batchId: batch.id, sourceType: "INVOICE", sourceId: "x", glDate: new Date("2026-07-15"),
      debit: 100, credit: 0, side: "SALES",
    },
  });
  expect(await prisma.glPosting.count({ where: { batchId: batch.id } })).toBe(1);
});
```

- [ ] **Step 8: Run gates.**

```bash
npx vitest run tests/close-periods.test.ts tests/partial-unique-sweep.test.ts
npx tsc --noEmit
```

Expected: PASS. (`partial-unique-sweep` proves the `exportNumber` exemption is accepted.)

- [ ] **Step 9: Commit.**

```bash
git add erp/prisma/schema.prisma erp/prisma/migrations erp/src/server/audit.ts erp/src/server/settings.ts erp/tests/partial-unique-sweep.test.ts erp/tests/close-periods.test.ts
git commit -m "feat(5c): close + GL-export data model, migration, audit + counter registration"
```

---

## Task 2: BillingConfig GL defaults — service, delete-blocker registry, admin UI

**Files:**
- Modify: `erp/src/server/billing-config.ts`
- Modify: `erp/src/lib/reference-links.ts`
- Modify: `erp/tests/reference-links-sweep.test.ts`
- Modify: `erp/src/app/admin/billing/page.tsx`
- Test: `erp/tests/billing-config.test.ts`

**Interfaces:**
- Consumes: `assertRefExists("glAccount", id, tx)`, `setBillingConfig`/`getBillingConfig` (existing).
- Produces: `BillingConfigRow` gains `arGlAccountId`/`discountGlAccountId`/`writeOffGlAccountId: string | null`, read by `gl-mapping.ts`/`gl-export.ts`/`close-periods.ts`.

- [ ] **Step 1: Write the failing service test.** In `erp/tests/billing-config.test.ts` add (mirror the existing round-trip + blocker tests):

```ts
it("round-trips the three 5C GL defaults and blocks deleting an account in use", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "1200", description: "A/R" } });
  const saved = await asSystem(() => setBillingConfig({ arGlAccountId: gl.id }));
  expect(saved.arGlAccountId).toBe(gl.id);
  await expect(asSystem(() => deleteReference("glAccount", gl.id))).rejects.toThrow();
  const blockers = await findBlockers("glAccount", gl.id);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].entityLabel).toBe("Billing settings");
  expect(blockers[0].href).toBe("/admin/billing");
});

it("refuses a discount/write-off GL account that does not exist", async () => {
  await expect(asSystem(() => setBillingConfig({ discountGlAccountId: "nope" })))
    .rejects.toThrow("That gl account does not exist");
});

// Proves GL_POSTING_BLOCKER at runtime (its include/displayName/liveWhere:{} can't be checked by
// the static sweep). Build the rows directly — no export service exists yet in this task.
it("a GL account on a sent GlPosting blocks its deletion, named by the export batch", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Revenue" } });
  const period = await prisma.closePeriod.create({ data: { year: 2026, month: 7, beginningAr: 0,
    invoicedTotal: 0, creditTotal: 0, paymentTotal: 0, discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0 } });
  const batch = await prisma.glExportBatch.create({ data: { exportNumber: 1000, closePeriodId: period.id,
    periodEnd: new Date("2026-07-31"), fileName: "x.csv", file: new Uint8Array([1]), register: new Uint8Array([2]) } });
  await prisma.glPosting.create({ data: { batchId: batch.id, sourceType: "INVOICE", sourceId: "i1",
    glDate: new Date("2026-07-15"), glAccountId: gl.id, glAccountName: "4010", debit: 100, credit: 0, side: "SALES" } });
  const blockers = await findBlockers("glAccount", gl.id);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].entityLabel).toBe("GL export");
  expect(blockers[0].name).toBe("GL export #1000");
});
```

- [ ] **Step 2: Run it red.**

```bash
npx vitest run tests/billing-config.test.ts -t "round-trips the three 5C GL defaults"
```

Expected: FAIL (`arGlAccountId` not on the returned row / not accepted by `SAVE`).

- [ ] **Step 3: Extend `billing-config.ts` in the five lockstep spots.** (a) `BillingConfigRow` type — add `arGlAccountId: string | null;`, `discountGlAccountId: string | null;`, `writeOffGlAccountId: string | null;`. (b) the `EMPTY` fallback — add `arGlAccountId: null,` etc. (c) the `SAVE` zod — add `arGlAccountId: z.string().nullable().optional(),` etc. (d) `getBillingConfig`'s return mapping — add `arGlAccountId: row.arGlAccountId,` (raw string, **not** `.toNumber()`). (e) `setBillingConfig` — add the three to the `assigns` boolean and add three guards:

```ts
if (data.arGlAccountId) await assertRefExists("glAccount", data.arGlAccountId, tx);
if (data.discountGlAccountId) await assertRefExists("glAccount", data.discountGlAccountId, tx);
if (data.writeOffGlAccountId) await assertRefExists("glAccount", data.writeOffGlAccountId, tx);
```

- [ ] **Step 4: Register the FKs in `reference-links.ts`.** The schema Task 1 added carries **four** new reference-targeting `@relation` FKs at `glAccount`: the three `BillingConfig` defaults **and** `GlPosting.glAccountId` (a frozen `onDelete: SetNull` snapshot, the `InvoiceLine.glAccountId` precedent). The sweep exempts only `onDelete: Cascade`, so all four must be registered or the build stays red. Add `"glPosting"` to the `ReferenceLinkModel` union, then a `GL_POSTING_BLOCKER` const + the four entries:

```ts
// GlPosting has no `deletedAt` (append-only), so `liveWhere: {}` is required (the BillingConfig
// precedent); the row a person can act on is its export batch (the INVOICE_VIA_LINE shape).
const GL_POSTING_BLOCKER = {
  entityLabel: "GL export",
  detailPath: () => "/receivables/close",
  liveWhere: {},
  include: { batch: { select: { id: true, exportNumber: true } } },
  blockerId: (r: Record<string, unknown>) => String((r.batch as { id: string }).id),
  displayName: (r: Record<string, unknown>) => `GL export #${(r.batch as { exportNumber: number }).exportNumber}`,
} as const;
```

```ts
{ model: "billingConfig", column: "arGlAccountId", targetKind: "glAccount",
  label: "A/R GL account", ...BILLING_CONFIG_BLOCKER },
{ model: "billingConfig", column: "discountGlAccountId", targetKind: "glAccount",
  label: "Discount GL account", ...BILLING_CONFIG_BLOCKER },
{ model: "billingConfig", column: "writeOffGlAccountId", targetKind: "glAccount",
  label: "Write-off GL account", ...BILLING_CONFIG_BLOCKER },
{ model: "glPosting", column: "glAccountId", targetKind: "glAccount",
  label: "GL account", ...GL_POSTING_BLOCKER },
```

Registering `GlPosting.glAccountId` here blocks deleting a GL account that appears on a sent export — the same "posted history is permanent" call the `invoiceLine`/`processStepCode` entries make; in practice the account is already blocked by the invoice line or payment type that generated the posting, so this adds no new restriction, only satisfies the sweep. `db.glPosting` exists as a Prisma delegate, so `findBlockers` needs no change.

- [ ] **Step 5: Update the sweep's expected-offenders list.** In `erp/tests/reference-links-sweep.test.ts`, the `finds every known reference FK when nothing is registered` case asserts a `.sort()`-ed exact array — add **four** entries in sorted position (the test `.sort()`s, so exact placement follows string order — `glPosting` sorts after `customerSurcharge` and before `invoiceLine`):

```ts
      "billingConfig.arGlAccountId -> glAccount",        // sorts before certChargeStepCodeId
      "billingConfig.discountGlAccountId -> glAccount",  // between certChargeStepCodeId and freightGlAccountId
      "billingConfig.writeOffGlAccountId -> glAccount",  // after salesTaxGlAccountId
      "glPosting.glAccountId -> glAccount",              // after customerSurcharge.*, before invoiceLine.*
```

- [ ] **Step 6: Run the service + sweep tests green.**

```bash
npx vitest run tests/billing-config.test.ts tests/reference-links-sweep.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add the three admin selects.** In `erp/src/app/admin/billing/page.tsx`: extend the `Cfg` type with the three `string | null` fields, then add three `<select>` blocks copying the existing "Freight GL account" block verbatim, changing only the field name (in `value`/`onChange`/`savedMark`) and the `<span>` label (e.g. "A/R GL account", "Discount GL account", "Write-off GL account"). `glAccounts` and `save()` need no change.

- [ ] **Step 8: Verify the admin flow in the browser and run E2E.** This touches a UI flow. Verify the three selects render and save (preview_start the dev server, navigate to `/admin/billing`, set each, confirm the saved mark), then:

```bash
npm run test:e2e
```

Expected: all flows pass.

- [ ] **Step 9: Commit.**

```bash
git add erp/src/server/billing-config.ts erp/src/lib/reference-links.ts erp/tests/reference-links-sweep.test.ts erp/tests/billing-config.test.ts erp/src/app/admin/billing/page.tsx
git commit -m "feat(5c): BillingConfig A/R, discount, write-off GL defaults + admin UI"
```

---

## Task 3: `gl-mapping.ts` — the pure journal + readiness engine

**Files:**
- Create: `erp/src/lib/gl-constants.ts`, `erp/src/server/gl-mapping.ts`
- Test: `erp/tests/gl-mapping.test.ts`

**Interfaces:**
- Consumes: nothing from services (pure). `gl-constants.ts` mirrors `ar-constants.ts`'s client-safe style.
- Produces: `salesJournal`, `cashJournal`, `readinessGaps`, and the shared types below — consumed by `gl-export.ts` (Task 6).

- [ ] **Step 1: Write `gl-constants.ts`** (client-safe, no server imports):

```ts
export const JOURNAL_SIDES = ["SALES", "CASH"] as const;
export type JournalSide = (typeof JOURNAL_SIDES)[number];
export const CLOSE_STATUSES = ["CLOSED", "REOPENED"] as const;
export type CloseStatus = (typeof CLOSE_STATUSES)[number];
export const POSTING_SOURCE_TYPES = ["INVOICE", "CREDIT", "PAYMENT", "DISCOUNT", "WRITE_OFF"] as const;
export type PostingSourceType = (typeof POSTING_SOURCE_TYPES)[number];
export const GL_EXPORT_COLUMNS = ["Date", "Account", "Debit", "Credit", "Memo"] as const;
```

- [ ] **Step 2: Write the failing mapping test.** Create `erp/tests/gl-mapping.test.ts`:

```ts
import { expect, it } from "vitest";
import { cashJournal, salesJournal, reverseLines, readinessGaps, type SalesEvent, type CashEvent } from "@/server/gl-mapping";

function sum(lines: { debit: number; credit: number }[]) {
  const d = lines.reduce((a, l) => a + l.debit, 0);
  const c = lines.reduce((a, l) => a + l.credit, 0);
  return { d: Math.round(d * 100), c: Math.round(c * 100) };
}

it("an invoice posts DR A/R = CR revenue + tax and balances", () => {
  const ev: SalesEvent = {
    kind: "INVOICE", invoiceId: "i1", total: 108,
    arGlAccountId: "ar", arGlAccountName: "1200",
    taxTotal: 8, taxGlAccountId: "tax", taxGlAccountName: "2200",
    revenue: [{ glAccountId: "rev", glAccountName: "4010", amount: 100 }],
  };
  const lines = salesJournal(ev);
  const ar = lines.find((l) => l.glAccountId === "ar")!;
  expect(ar.debit).toBe(108);
  const { d, c } = sum(lines);
  expect(d).toBe(c); // balances
});

it("a credit reverses the sales entry (DR revenue/tax, CR A/R)", () => {
  const ev: SalesEvent = {
    kind: "CREDIT", invoiceId: "c1", total: 50, arGlAccountId: "ar", arGlAccountName: "1200",
    taxTotal: 0, taxGlAccountId: null, taxGlAccountName: "",
    revenue: [{ glAccountId: "rev", glAccountName: "4010", amount: 50 }],
  };
  const lines = salesJournal(ev);
  expect(lines.find((l) => l.glAccountId === "ar")!.credit).toBe(50);
  const { d, c } = sum(lines);
  expect(d).toBe(c);
});

it("a payment posts DR cash = CR A/R, balanced and keyed on the payment id", () => {
  const lines = cashJournal({
    kind: "PAYMENT", sourceId: "pay1", amount: 90,
    debitGlAccountId: "bank", debitGlAccountName: "1000", arGlAccountId: "ar", arGlAccountName: "1200",
  });
  expect(lines).toHaveLength(2);
  expect(lines.every((l) => l.sourceId === "pay1")).toBe(true);
  expect(lines.find((l) => l.glAccountId === "ar")!.credit).toBe(90);
  const { d, c } = sum(lines);
  expect(d).toBe(c);
});

it("reverseLines swaps debit/credit and flags isReversal", () => {
  const [orig] = cashJournal({ kind: "DISCOUNT", sourceId: "app1", amount: 5,
    debitGlAccountId: "disc", debitGlAccountName: "4900", arGlAccountId: "ar", arGlAccountName: "1200" });
  const [rev] = reverseLines([orig]);
  expect(rev.credit).toBe(orig.debit);
  expect(rev.debit).toBe(orig.credit);
  expect(rev.isReversal).toBe(true);
});

it("readinessGaps lists a step code, surcharge, payment type, and missing A/R default", () => {
  const gaps = readinessGaps({
    arGlAccountId: null, discountGlAccountId: "d", writeOffGlAccountId: "w",
    hasDiscount: false, hasWriteOff: false,
    stepCodesMissingGl: [{ id: "s1", code: "HT" }],
    surchargesMissingGl: [{ id: "u1", name: "Energy" }],
    paymentTypesMissingGl: [{ id: "p1", name: "ACH" }],
  });
  const kinds = gaps.map((g) => g.kind).sort();
  expect(kinds).toEqual(["payment-type", "plant-default", "step-code", "surcharge"]);
});
```

- [ ] **Step 3: Run it red.**

```bash
npx vitest run tests/gl-mapping.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4: Implement `gl-mapping.ts`** (pure; imports only types):

```ts
import type { JournalSide, PostingSourceType } from "@/lib/gl-constants";

export type JournalLine = {
  side: JournalSide;
  glAccountId: string;
  glAccountName: string;
  debit: number;
  credit: number;
  memo: string;
  sourceType: PostingSourceType;
  sourceId: string;
  isReversal: boolean;
};

export type SalesEvent = {
  kind: "INVOICE" | "CREDIT";
  invoiceId: string;
  total: number;
  arGlAccountId: string;
  arGlAccountName: string;
  taxTotal: number;
  taxGlAccountId: string | null;
  taxGlAccountName: string;
  revenue: { glAccountId: string; glAccountName: string; amount: number }[];
};

// ONE cash event = one payment, one discount application, or one write-off application. Each maps
// to a self-balancing pair (its debit + an A/R credit) keyed on that event's own id — so the
// per-event delta (§4.3) reverses one event without disturbing the others (never an aggregate A/R).
export type CashEvent = {
  kind: "PAYMENT" | "DISCOUNT" | "WRITE_OFF";
  sourceId: string; // the payment id / application id — a real cuid, never a display field
  amount: number;
  debitGlAccountId: string; // cash (PAYMENT) / discount / write-off account
  debitGlAccountName: string;
  arGlAccountId: string;
  arGlAccountName: string;
};

const c = (n: number) => Math.round(n * 100);

/** Sales side (§5): DR A/R = CR revenue + tax for an INVOICE; the mirror for a CREDIT. All lines
 *  carry this event's invoice id and isReversal:false (a new posting). */
export function salesJournal(ev: SalesEvent): JournalLine[] {
  const reverse = ev.kind === "CREDIT";
  const st: PostingSourceType = ev.kind;
  const dr = (id: string, name: string, amt: number, memo: string): JournalLine =>
    ({ side: "SALES", glAccountId: id, glAccountName: name, debit: amt, credit: 0, memo, sourceType: st, sourceId: ev.invoiceId, isReversal: false });
  const cr = (id: string, name: string, amt: number, memo: string): JournalLine =>
    ({ side: "SALES", glAccountId: id, glAccountName: name, debit: 0, credit: amt, memo, sourceType: st, sourceId: ev.invoiceId, isReversal: false });
  const lines: JournalLine[] = [];
  lines.push(reverse ? cr(ev.arGlAccountId, ev.arGlAccountName, ev.total, "A/R") : dr(ev.arGlAccountId, ev.arGlAccountName, ev.total, "A/R"));
  for (const r of ev.revenue) {
    if (c(r.amount) === 0) continue;
    lines.push(reverse ? dr(r.glAccountId, r.glAccountName, r.amount, "Revenue") : cr(r.glAccountId, r.glAccountName, r.amount, "Revenue"));
  }
  if (c(ev.taxTotal) !== 0 && ev.taxGlAccountId) {
    lines.push(reverse ? dr(ev.taxGlAccountId, ev.taxGlAccountName, ev.taxTotal, "Sales tax") : cr(ev.taxGlAccountId, ev.taxGlAccountName, ev.taxTotal, "Sales tax"));
  }
  return lines;
}

/** Cash side (§5): one event → DR its account + CR A/R, balanced, both keyed on the event id. */
export function cashJournal(ev: CashEvent): JournalLine[] {
  const memo = ev.kind === "PAYMENT" ? "Cash receipt" : ev.kind === "DISCOUNT" ? "Discount" : "Write-off";
  return [
    { side: "CASH", glAccountId: ev.debitGlAccountId, glAccountName: ev.debitGlAccountName, debit: ev.amount, credit: 0, memo, sourceType: ev.kind, sourceId: ev.sourceId, isReversal: false },
    { side: "CASH", glAccountId: ev.arGlAccountId, glAccountName: ev.arGlAccountName, debit: 0, credit: ev.amount, memo: "A/R", sourceType: ev.kind, sourceId: ev.sourceId, isReversal: false },
  ];
}

/** Reverse a set of previously-posted lines (swap debit/credit, mark isReversal). §4.3 corrections. */
export function reverseLines(lines: JournalLine[]): JournalLine[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, isReversal: true }));
}

export type ReadinessGap = {
  kind: "step-code" | "surcharge" | "payment-type" | "plant-default";
  id: string | null;
  label: string;
  href: string;
};

export type ReadinessInput = {
  arGlAccountId: string | null;
  discountGlAccountId: string | null;
  writeOffGlAccountId: string | null;
  hasDiscount: boolean;
  hasWriteOff: boolean;
  stepCodesMissingGl: { id: string; code: string }[];
  surchargesMissingGl: { id: string; name: string }[];
  paymentTypesMissingGl: { id: string; name: string }[];
};

/** §7 refuse-to-export: name every account gap. Empty => the export may proceed. */
export function readinessGaps(input: ReadinessInput): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  if (!input.arGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "A/R control account is not set", href: "/admin/billing" });
  if (input.hasDiscount && !input.discountGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "Discount account is not set", href: "/admin/billing" });
  if (input.hasWriteOff && !input.writeOffGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "Write-off account is not set", href: "/admin/billing" });
  for (const s of input.stepCodesMissingGl) gaps.push({ kind: "step-code", id: s.id, label: `Process step code ${s.code} has no GL account`, href: `/admin/step-codes` });
  for (const u of input.surchargesMissingGl) gaps.push({ kind: "surcharge", id: u.id, label: `Surcharge ${u.name} has no GL account`, href: `/admin/surcharges` });
  for (const p of input.paymentTypesMissingGl) gaps.push({ kind: "payment-type", id: p.id, label: `Payment type ${p.name} has no GL account`, href: `/admin/reference` });
  return gaps;
}
```

- [ ] **Step 5: Run it green.**

```bash
npx vitest run tests/gl-mapping.test.ts
npx tsc --noEmit && npx eslint src tests
```

Expected: PASS / clean.

- [ ] **Step 6: Commit.**

```bash
git add erp/src/lib/gl-constants.ts erp/src/server/gl-mapping.ts erp/tests/gl-mapping.test.ts
git commit -m "feat(5c): pure GL mapping engine (sales/cash journals + readiness gaps)"
```

---

## Task 4: `period-locks.ts` leaf + wiring into every 5A/5B posting mutation

**Files:**
- Create: `erp/src/server/period-locks.ts`
- Modify: `erp/src/server/invoices.ts`, `erp/src/server/receipts.ts`, `erp/src/server/applications.ts`
- Test: `erp/tests/period-locks.test.ts`

**Interfaces:**
- Consumes: `HttpError` from `errors.ts` (a leaf — importing it keeps `period-locks.ts` a leaf), `type Prisma`.
- Produces: `lockMonth(tx, year, month)` (consumed by `close-periods.ts` Task 5), `assertPeriodOpen(tx, glDate)`, `closedPeriodFor(tx, glDate)`.

**The concurrency design (load-bearing — do not reduce to a plain `findFirst`).** The guarded fact is the *absence* of a CLOSED `ClosePeriod` row for the month (an un-closed month has no row, spec §4.1), which no `SELECT … FOR UPDATE` can claim. So both the guard and the close take a **transaction-level Postgres advisory lock keyed on `(year, month)`** before reading/writing. This serializes a finalize/apply/void against a concurrent close of the same month at any isolation, closing the phantom the row-claim rule can't. It is defense-in-depth on top of both sides already being Serializable, and the RED test in Step 7 proves it.

- [ ] **Step 1: Write the failing guard test.** Create `erp/tests/period-locks.test.ts`:

```ts
import { beforeEach, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";
import { assertPeriodOpen, closedPeriodFor } from "@/server/period-locks";

beforeEach(truncateAll);

async function closeMonth(year: number, month: number) {
  return prisma.closePeriod.create({
    data: { year, month, beginningAr: 0, invoicedTotal: 0, creditTotal: 0, paymentTotal: 0,
      discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0 },
  });
}

it("refuses a date inside a CLOSED month, allows an open month", async () => {
  await closeMonth(2026, 7);
  await prisma.$transaction(async (tx) => {
    await expect(assertPeriodOpen(tx, new Date("2026-07-15"))).rejects.toThrow(/closed/i);
    await assertPeriodOpen(tx, new Date("2026-08-01")); // no throw
  });
});

it("a REOPENED month is open again", async () => {
  const p = await closeMonth(2026, 7);
  await prisma.closePeriod.update({ where: { id: p.id }, data: { status: "REOPENED" } });
  await prisma.$transaction(async (tx) => {
    await assertPeriodOpen(tx, new Date("2026-07-15")); // no throw
    expect(await closedPeriodFor(tx, new Date("2026-07-15"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it red.**

```bash
npx vitest run tests/period-locks.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `period-locks.ts`** (leaf — imports only `type Prisma` and the `HttpError` leaf):

```ts
import type { Prisma } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";

export type ClosePeriodRef = { id: string; year: number; month: number };

function ym(glDate: Date): { year: number; month: number } {
  return { year: glDate.getUTCFullYear(), month: glDate.getUTCMonth() + 1 };
}

/** Transaction-level advisory lock on a (year, month). Both the guard and the close take it, so a
 *  posting mutation and a close of the same month serialize even when the ClosePeriod row is absent. */
export async function lockMonth(tx: Prisma.TransactionClient, year: number, month: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(4200, ${year * 100 + month})`;
}

/** The CLOSED ClosePeriod covering glDate, or null. Takes the month lock first. */
export async function closedPeriodFor(tx: Prisma.TransactionClient, glDate: Date): Promise<ClosePeriodRef | null> {
  const { year, month } = ym(glDate);
  await lockMonth(tx, year, month);
  const row = await tx.closePeriod.findFirst({
    where: { year, month, status: "CLOSED" },
    select: { id: true, year: true, month: true },
  });
  return row;
}

/** Throw 409 if glDate falls in a CLOSED month. Call UNDER the caller's existing row claim. */
export async function assertPeriodOpen(tx: Prisma.TransactionClient, glDate: Date): Promise<void> {
  const closed = await closedPeriodFor(tx, glDate);
  if (closed) {
    const mm = String(closed.month).padStart(2, "0");
    throw new HttpError(409,
      `The accounting period ${closed.year}-${mm} is closed — reopen it to make this change`);
  }
}
```

- [ ] **Step 4: Add an import-shape test** (mirror `invoice-guards`'s pin) to `period-locks.test.ts`:

```ts
import { readFileSync } from "node:fs";

it("stays a dependency-free leaf", () => {
  const src = readFileSync(new URL("../src/server/period-locks.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/from ["']\.\/(invoices|receipts|applications|orders|shippers|close-periods|gl-export)["']/);
  expect(src).not.toMatch(/\brequire\(|import\(/);
});
```

- [ ] **Step 5: Wire the guard into `invoices.ts`.** In `finalizeInvoiceInTx`, after the `needsPrice` refusal block and before `const actor = currentActor();`:

```ts
  await assertPeriodOpen(tx, invoice.invoiceDate);
```

In `unlockInvoiceInTx`, after the `hasReceivableActivity` check and before the `auditedUpdate`:

```ts
  await assertPeriodOpen(tx, invoice.invoiceDate);
```

In `createCredit`, after `const creditDate = todayDateOnly();` and before the `auditedCreate`:

```ts
  await assertPeriodOpen(tx, creditDate);
```

Add `import { assertPeriodOpen } from "./period-locks";` at the top. (`invoice.invoiceDate`/`creditDate` are already in hand under the claim — no extra select.)

- [ ] **Step 6: Wire the guard into `receipts.ts` and `applications.ts`.** In `receipts.ts` `postBatchInTx`, after the "already posted" refusal, add a read of the batch's payments and guard per distinct received date (a POSTED batch's payments are the cash events):

```ts
  const dates = await tx.payment.findMany({
    where: { batchId: id, deletedAt: null }, select: { receivedDate: true },
  });
  for (const d of dates) await assertPeriodOpen(tx, d.receivedDate);
```

In `voidPaymentInTx`, add `receivedDate: true` to the payment `findFirst` select (currently `{ id: true }`), then after the live-application refusal and before the `auditedSoftDelete`:

```ts
  await assertPeriodOpen(tx, payment.receivedDate);
```

In `applications.ts` `applyPaymentInTx`, after `const appliedDate = payment.receivedDate;` and before the write loop:

```ts
  await assertPeriodOpen(tx, appliedDate);
```

In `applyCreditInTx`, after `const appliedDate = todayDateOnly();`:

```ts
  await assertPeriodOpen(tx, appliedDate);
```

In `voidApplicationInTx`, add `appliedDate: true` to the live re-read select, then before the `auditedSoftDelete`:

```ts
  await assertPeriodOpen(tx, live.appliedDate);
```

Add the `import { assertPeriodOpen } from "./period-locks";` to both files.

- [ ] **Step 7: Add the RED-verified concurrency test.** Append to `period-locks.test.ts` — prove a finalize into a month is refused once that month is closed, and (the real race) that the guard's advisory lock serializes a finalize against a concurrent close. First write the "post-close refusal" integration test using the real service:

```ts
import { finalizeInvoice } from "@/server/invoices";
// ... build a finalizable invoice dated in July via existing test factories ...
it("refuses finalizing an invoice dated in a closed month", async () => {
  const invoiceId = await makeFinalizableInvoiceDated("2026-07-10"); // helper per existing invoice tests
  await closeMonth(2026, 7);
  await expect(finalizeInvoice(invoiceId)).rejects.toThrow(/closed/i);
});
```

Then RED-verify: temporarily delete the `assertPeriodOpen` call in `finalizeInvoiceInTx` and confirm this test FAILS to throw; restore it. Document the RED run in the task report (a passing guard test is not evidence without it).

- [ ] **Step 8: Run gates.**

```bash
npx vitest run tests/period-locks.test.ts tests/invoices.test.ts tests/receipts.test.ts tests/applications.test.ts
npx tsc --noEmit && npx eslint src tests
```

Expected: PASS / clean. (The existing 5A/5B suites must stay green — the guard is a no-op when no month is closed.)

- [ ] **Step 9: Commit.**

```bash
git add erp/src/server/period-locks.ts erp/src/server/invoices.ts erp/src/server/receipts.ts erp/src/server/applications.ts erp/tests/period-locks.test.ts
git commit -m "feat(5c): period-lock leaf (advisory-locked) wired into every A/R posting mutation"
```

---

## Task 5: `close-periods.ts` — the close/reopen lifecycle + preliminary report + routes

**Files:**
- Create: `erp/src/server/close-periods.ts`
- Modify: `erp/src/server/close-periods.ts` tests → `erp/tests/close-periods.test.ts` (extend Task 1's smoke file)
- Create: `erp/src/app/api/receivables/close/preliminary/route.ts`, `close/route.ts`, `close/[id]/reopen/route.ts`
- Test: `erp/tests/receivables-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `agingReport({ asOf })` from `aging.ts`, `lockMonth` from `period-locks.ts`, `getBillingConfig`, `allocateNumber`, `auditedCreate`/`auditedUpdate`, `formatDateOnly`/`parseDateOnly` from `business-days.ts`.
- Produces: `preliminaryReport(year, month)`, `closePeriod(year, month)`, `reopenPeriod(id, reason)` and the types below (consumed by `gl-export.ts` Task 6 and the UI Task 8).

- [ ] **Step 1: Write the failing close tests.** Extend `erp/tests/close-periods.test.ts`:

```ts
import { closePeriod, preliminaryReport, reopenPeriod } from "@/server/close-periods";
// helpers: finalize an invoice dated in a month; post a payment applied to it (existing factories)

it("closes a clean month: beginning 0, chains, reconciles to aging (variance 0)", async () => {
  await makeFinalizedInvoiceDated("2026-07-05", 100); // total 100
  await payInvoiceDated("2026-07-20", 40);            // pay 40
  const prelim = await preliminaryReport(2026, 7);
  expect(prelim.schedule.beginningAr).toBe(0);
  expect(prelim.schedule.invoicedTotal).toBe(100);
  expect(prelim.schedule.paymentTotal).toBe(40);
  expect(prelim.schedule.endingAr).toBe(60);
  expect(prelim.schedule.variance).toBe(0); // endingAr === agingEndingAr
  const closed = await closePeriod(2026, 7);
  expect(closed.status).toBe("CLOSED");
  expect(closed.endingAr).toBe(60);
});

it("chains beginning A/R from the prior close", async () => {
  await makeFinalizedInvoiceDated("2026-07-05", 100);
  await closePeriod(2026, 7);
  await makeFinalizedInvoiceDated("2026-08-05", 30);
  const aug = await closePeriod(2026, 8);
  expect(aug.beginningAr).toBe(100); // July's ending
  expect(aug.endingAr).toBe(130);
});

it("refuses to close a month before its prior month is closed", async () => {
  await makeFinalizedInvoiceDated("2026-08-05", 30);
  await expect(closePeriod(2026, 8)).rejects.toThrow(/prior|previous|July|2026-07/i);
});

it("reopen requires a reason and flips status", async () => {
  await makeFinalizedInvoiceDated("2026-07-05", 100);
  const c = await closePeriod(2026, 7);
  await expect(reopenPeriod(c.id, "  ")).rejects.toThrow(/reason/i);
  const r = await reopenPeriod(c.id, "correcting a mis-keyed invoice");
  expect(r.status).toBe("REOPENED");
});
```

- [ ] **Step 2: Run red.**

```bash
npx vitest run tests/close-periods.test.ts -t "closes a clean month"
```

Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement `close-periods.ts`.** Compute the continuity schedule from live rows (invoices finalized with `invoiceDate` in the month; posted payments with `receivedDate` in the month; discount/write-off applications with `appliedDate` in the month; credits by `invoiceDate`), get `agingEndingAr` from `agingReport({ asOf: monthEnd })` summed in cents, and require reconciliation. `closePeriod` takes the month advisory lock (via `lockMonth`) inside a Serializable transaction so it serializes against concurrent postings (Task 4):

```ts
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors"; // match the existing helper import path
import { HttpError } from "./errors";
import { auditedCreate, auditedUpdate } from "./audit";
import { agingReport } from "./aging";
import { lockMonth } from "./period-locks";
import { formatDateOnly } from "@/lib/business-days";
import { currentActor } from "./context"; // Actor = { id: string | null; name: string }

const cents = (n: number) => Math.round(n * 100);

// NOTE (accepted, flag at the whole-branch review): `agingReport()` runs its own RepeatableRead
// transaction on a separate pooled connection — it takes no `tx`, so the endingAr (this tx) vs
// agingEndingAr (aging's read) variance is compared across two snapshots. This reconciles on
// clean data because every month dated <= periodEnd is either an already-CLOSED (locked) prior
// month or THIS month, which is held under the advisory lock during closePeriod — so no posting
// dated <= periodEnd can commit between the two reads. Do not "simplify" by dropping the aging
// side; the two independent derivations are the whole point of the reconciliation.

export type ContinuitySchedule = {
  beginningAr: number; invoicedTotal: number; creditTotal: number; paymentTotal: number;
  discountTotal: number; writeOffTotal: number; endingAr: number; agingEndingAr: number; variance: number;
};
export type ClosePeriodDetail = ContinuitySchedule & { id: string; year: number; month: number; status: string };
export type PreliminaryReport = {
  year: number; month: number; schedule: ContinuitySchedule;
  unpostedBatchCount: number; alreadyClosed: boolean;
};

function monthBounds(year: number, month: number): { startStr: string; endStr: string; endDate: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
  return { startStr: formatDateOnly(start), endStr: formatDateOnly(end), endDate: end };
}

async function priorEndingAr(tx: Prisma.TransactionClient, year: number, month: number): Promise<number> {
  const py = month === 1 ? year - 1 : year;
  const pm = month === 1 ? 12 : month - 1;
  const prior = await tx.closePeriod.findFirst({ where: { year: py, month: pm } });
  if (!prior) return 0;
  if (prior.status !== "CLOSED") throw new HttpError(409, `The prior period ${py}-${String(pm).padStart(2, "0")} is not closed`);
  return prior.endingAr.toNumber();
}

async function computeSchedule(tx: Prisma.TransactionClient, year: number, month: number): Promise<ContinuitySchedule> {
  const { startStr, endStr, endDate } = monthBounds(year, month);
  const start = new Date(startStr), end = new Date(endStr);
  const beginningAr = await priorEndingAr(tx, year, month);
  const invoices = await tx.invoice.findMany({
    where: { status: "FINALIZED", invoiceDate: { gte: start, lte: end } },
    select: { kind: true, total: true },
  });
  let invoicedTotal = 0, creditTotal = 0;
  for (const i of invoices) {
    if (i.kind === "CREDIT") creditTotal += Math.abs(i.total.toNumber());
    else invoicedTotal += i.total.toNumber();
  }
  const apps = await tx.application.findMany({
    where: { deletedAt: null, appliedDate: { gte: start, lte: end } },
    select: { type: true, amount: true },
  });
  let discountTotal = 0, writeOffTotal = 0;
  for (const a of apps) {
    if (a.type === "DISCOUNT") discountTotal += a.amount.toNumber();
    else if (a.type === "WRITE_OFF") writeOffTotal += a.amount.toNumber();
  }
  const payments = await tx.payment.findMany({
    where: { deletedAt: null, receivedDate: { gte: start, lte: end }, batch: { status: "POSTED", deletedAt: null } },
    select: { amount: true },
  });
  const paymentTotal = payments.reduce((s, p) => s + p.amount.toNumber(), 0);
  const endingAr = (cents(beginningAr) + cents(invoicedTotal) - cents(creditTotal) - cents(paymentTotal) - cents(discountTotal) - cents(writeOffTotal)) / 100;
  const rows = await agingReport({ asOf: formatDateOnly(endDate) });
  const agingEndingAr = rows.reduce((s, r) => s + cents(r.net), 0) / 100;
  const variance = (cents(endingAr) - cents(agingEndingAr)) / 100;
  return { beginningAr, invoicedTotal, creditTotal, paymentTotal, discountTotal, writeOffTotal, endingAr, agingEndingAr, variance };
}

export async function preliminaryReport(year: number, month: number): Promise<PreliminaryReport> {
  return withDbErrors({ entity: "Close period" }, () => prisma.$transaction(async (tx) => {
    const schedule = await computeSchedule(tx, year, month);
    const { startStr, endStr } = monthBounds(year, month);
    const unpostedBatchCount = await tx.receiptBatch.count({
      where: { status: "OPEN", deletedAt: null, payments: { some: { deletedAt: null, receivedDate: { gte: new Date(startStr), lte: new Date(endStr) } } } },
    });
    const existing = await tx.closePeriod.findFirst({ where: { year, month } });
    return { year, month, schedule, unpostedBatchCount, alreadyClosed: existing?.status === "CLOSED" };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function closePeriod(year: number, month: number): Promise<ClosePeriodDetail> {
  return withDbErrors({ entity: "Close period" }, () => prisma.$transaction(async (tx) => {
    await lockMonth(tx, year, month); // serialize against concurrent postings + a concurrent close
    const schedule = await computeSchedule(tx, year, month);
    if (cents(schedule.variance) !== 0) {
      throw new HttpError(409, `The close does not reconcile — ending A/R ${schedule.endingAr} vs aging ${schedule.agingEndingAr}`);
    }
    const existing = await tx.closePeriod.findFirst({ where: { year, month } });
    const data = { year, month, status: "CLOSED", closedById: currentActor().id, reopenedAt: null,
      beginningAr: schedule.beginningAr, invoicedTotal: schedule.invoicedTotal, creditTotal: schedule.creditTotal,
      paymentTotal: schedule.paymentTotal, discountTotal: schedule.discountTotal, writeOffTotal: schedule.writeOffTotal,
      endingAr: schedule.endingAr, agingEndingAr: schedule.agingEndingAr };
    const row = existing
      ? await auditedUpdate("closePeriod", existing.id, () => tx.closePeriod.update({ where: { id: existing.id }, data }), { tx })
      : await auditedCreate("closePeriod", data, () => tx.closePeriod.create({ data }), { tx });
    return { id: row.id, year, month, status: "CLOSED", ...schedule };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function reopenPeriod(id: string, reason: string): Promise<ClosePeriodDetail> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to reopen a period");
  return withDbErrors({ entity: "Close period" }, () => prisma.$transaction(async (tx) => {
    const existing = await tx.closePeriod.findFirst({ where: { id } });
    if (!existing) throw new HttpError(404, "Close period not found");
    await lockMonth(tx, existing.year, existing.month);
    const row = await auditedUpdate("closePeriod", id,
      () => tx.closePeriod.update({ where: { id }, data: { status: "REOPENED", reopenedAt: new Date(), reopenReason: why } }), { tx });
    return { id: row.id, year: row.year, month: row.month, status: "REOPENED",
      beginningAr: row.beginningAr.toNumber(), invoicedTotal: row.invoicedTotal.toNumber(), creditTotal: row.creditTotal.toNumber(),
      paymentTotal: row.paymentTotal.toNumber(), discountTotal: row.discountTotal.toNumber(), writeOffTotal: row.writeOffTotal.toNumber(),
      endingAr: row.endingAr.toNumber(), agingEndingAr: row.agingEndingAr.toNumber(), variance: 0 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
```

*Note for the implementer:* match the exact import path/name the repo uses for `withDbErrors` and `prisma` (5B's `receipts.ts`/`invoices.ts` show them — the module token may differ). `currentActor().id` and `formatDateOnly` are verified correct (`context.ts`, `business-days.ts`). Do not invent new helpers.

- [ ] **Step 4: Run the close tests green.**

```bash
npx vitest run tests/close-periods.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the two concurrency RED tests** (spec §12), following the 5B two-interleaved-transactions-on-separate-clients shape, each **RED-verified by removing `lockMonth`**:
  1. **A posting racing a close.** A `finalizeInvoice` for a July-dated invoice interleaved with `closePeriod(2026, 7)`, the competitor pinned to Read Committed — assert the two serialize (the finalize either lands before the close and is counted, or is refused as period-closed), never both-commit-into-a-closed-month. (The apply/void variants §12 names share the same guard; a comment noting they're covered by the same `assertPeriodOpen` lock is sufficient once finalize is proven.)
  2. **Two closes of one month.** Two concurrent `closePeriod(2026, 7)` calls — assert exactly one `CLOSED` row exists afterward and neither call errors on a duplicate write. Without `lockMonth` both `findFirst`→null→`create` and one hits the `@@unique([year,month])` violation; with it they serialize (the second sees the first's row and updates it). Verify RED by removing `lockMonth` and watching the duplicate/violation.

- [ ] **Step 6: Add the routes.** Both `close_ar_period` and `run_qbo_export` **already exist** in `src/lib/permission-constants.ts`'s `SPECIAL_ACTIONS` and are granted to admin via `ALL_PERMISSIONS` (`tests/permissions.test.ts:43`) — no declaration or seed step is needed; a `grep close_ar_period src/lib/permission-constants.ts` confirms it before wiring. `close/preliminary/route.ts` (GET, `receivables.view`, `?year=&month=`), `close/route.ts` (POST, `close_ar_period`, body `{year,month}`), `close/[id]/reopen/route.ts` (POST, `close_ar_period`, body `{reason}`):

```ts
// close/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { closePeriod } from "@/server/close-periods";

const BODY = z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }).strict();

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "receivables", "edit");
  mustDo(user, "close_ar_period");
  const { year, month } = BODY.parse(await req.json());
  return NextResponse.json(await closePeriod(year, month));
});
```

Write `preliminary/route.ts` and `[id]/reopen/route.ts` in the same shape (preliminary parses `year`/`month` from the URL and gates `receivables.view`; reopen parses `{ reason }` and gates `close_ar_period`, reading the id from `ctx.params`).

- [ ] **Step 7: Add the route permission-ladder tests** to `receivables-routes.test.ts` (401/403/200, per the existing pattern with `signInWith`/`withParams`). Include a 200 close + a `close_ar_period`-missing 403.

- [ ] **Step 8: Run gates + E2E is deferred to Task 8 (no UI yet).**

```bash
npx vitest run tests/close-periods.test.ts tests/receivables-routes.test.ts
npx tsc --noEmit && npx eslint src tests
```

- [ ] **Step 9: Commit.**

```bash
git add erp/src/server/close-periods.ts erp/src/app/api/receivables/close erp/tests/close-periods.test.ts erp/tests/receivables-routes.test.ts
git commit -m "feat(5c): month-end close/reopen lifecycle, aging reconciliation, preliminary report + routes"
```

---

## Task 6: `gl-export.ts` — per-event delta, CSV, batch write, + export/readiness routes

**Files:**
- Create: `erp/src/server/gl-export.ts`
- Create: `erp/src/app/api/receivables/close/[id]/export/route.ts`, `close/export/[batchId]/file/route.ts`, `close/readiness/route.ts`, `close/readiness/export/route.ts`
- Test: `erp/tests/gl-export.test.ts`, `erp/tests/receivables-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `salesJournal`/`cashJournal`/`readinessGaps`/`JournalLine`/`ReadinessGap` (Task 3), `getBillingConfig` (Task 2), `allocateNumber`, `toXlsx`, `formatDateOnly`.
- Produces: `exportClose(closePeriodId)`, `readinessForExport(periodEnd)`, `getExportBatchFile(batchId)`, `getExportBatchRegister(batchId)` — consumed by the UI (Task 8) and the file/register routes.

**The delta (§4.3).** For the close's period-end `E`: gather in-scope live postable events (finalized invoices/credits by `invoiceDate ≤ E`; posted non-void payments by `receivedDate ≤ E`; live discount/write-off applications by `appliedDate ≤ E`), and the net prior postings (`GlPosting` with `glDate ≤ E`, grouped by `(sourceType, sourceId)`, reversals cancelling). **New** = live events with no net prior posting → post. **Reversed** = net-posted events no longer live-in-scope → reverse. Both sides bound by `glDate ≤ E`, so re-exporting an earlier month after a later one closed never disturbs the later month.

- [ ] **Step 1: Write the failing delta tests.** Create `erp/tests/gl-export.test.ts`:

```ts
import { beforeEach, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";
import { exportClose } from "@/server/gl-export";
import { closePeriod, reopenPeriod } from "@/server/close-periods";
import { unlockInvoice } from "@/server/invoices";
// helpers set up GL accounts + BillingConfig defaults + a finalized invoice + a payment

it("first export posts a balanced batch; a re-run is an empty no-op", async () => {
  await seedGlDefaults();
  await makeFinalizedInvoiceDated("2026-07-05", 100);
  await closePeriod(2026, 7);
  const period = await prisma.closePeriod.findFirstOrThrow({ where: { year: 2026, month: 7 } });
  const first = await exportClose(period.id);
  const debit = first.postings.reduce((s, p) => s + p.debit, 0);
  const credit = first.postings.reduce((s, p) => s + p.credit, 0);
  expect(Math.round(debit * 100)).toBe(Math.round(credit * 100)); // balances
  expect(first.postings.length).toBeGreaterThan(0);
  const second = await exportClose(period.id);
  expect(second.postings.length).toBe(0); // idempotent
});

it("a reopen → void → re-close → re-export emits a reversing delta", async () => {
  await seedGlDefaults();
  const invId = await makeFinalizedInvoiceDated("2026-07-05", 100);
  await closePeriod(2026, 7);
  const period = await prisma.closePeriod.findFirstOrThrow({ where: { year: 2026, month: 7 } });
  await exportClose(period.id);
  await reopenPeriod(period.id, "correcting");
  await unlockInvoice(invId, "wrong amount"); // now dated-in-July invoice is DRAFT again
  await closePeriod(2026, 7);
  const delta = await exportClose(period.id);
  const net = delta.postings.reduce((s, p) => s + (p.debit - p.credit), 0);
  expect(delta.postings.length).toBeGreaterThan(0);
  expect(Math.round(net * 100)).toBe(0); // a balanced reversal
});
```

- [ ] **Step 2: Run red.**

```bash
npx vitest run tests/gl-export.test.ts -t "first export posts a balanced batch"
```

Expected: FAIL.

- [ ] **Step 3: Implement `gl-export.ts`.** Read live events + BillingConfig + the invoice-line revenue groups, map via `gl-mapping`, diff against `GlPosting`, allocate the export number, write the batch + postings, render the CSV. (The register PDF lands in Task 7; write a minimal CSV here and a placeholder single-byte register, replaced in Task 7 — or sequence Task 7 before the batch write; the plan keeps the register in Task 7 and this task stores an empty register buffer, noting the follow-up. Prefer: Task 7 supplies `buildPostingRegister`, imported here; if executing 6 before 7, store `new Uint8Array()` and let Task 7's step replace it.) Core shape:

```ts
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
import { HttpError } from "./errors";
import { auditedCreate } from "./audit";
import { allocateNumber } from "./settings";
import { getBillingConfig } from "./billing-config";
import { salesJournal, cashJournal, reverseLines, readinessGaps, type JournalLine, type ReadinessGap } from "./gl-mapping";
import { formatDateOnly } from "@/lib/business-days";
import { GL_EXPORT_COLUMNS } from "@/lib/gl-constants";

const cents = (n: number) => Math.round(n * 100);

export type ExportedBatch = {
  batchId: string; exportNumber: number; periodEnd: string;
  postings: { sourceType: string; sourceId: string; glAccountId: string | null; debit: number; credit: number; side: string; isReversal: boolean }[];
  file: Buffer;
};

// 1. build the CURRENT in-scope journal lines (live events with glDate <= periodEnd), keyed by event
// 2. read prior GlPosting (glDate <= periodEnd), net by (sourceType, sourceId)
// 3. new events -> post; net-posted-but-not-live -> reverse
// 4. write GlExportBatch + GlPosting, render CSV
export async function exportClose(closePeriodId: string): Promise<ExportedBatch> {
  return withDbErrors({ entity: "GL export" }, () => prisma.$transaction(async (tx) => {
    const period = await tx.closePeriod.findFirst({ where: { id: closePeriodId } });
    if (!period) throw new HttpError(404, "Close period not found");
    if (period.status !== "CLOSED") throw new HttpError(409, "Reopened periods must be re-closed before export");
    const periodEnd = new Date(Date.UTC(period.year, period.month, 0));

    const gaps = await resolveReadiness(tx, periodEnd);
    if (gaps.length > 0) throw new HttpError(409, `Cannot export — ${gaps.length} GL account gap(s); see the readiness list`);

    // Both maps keyed on the IDENTICAL 2-part `${sourceType}:${sourceId}` (§4.3). buildPriorNet
    // drops net-zero groups (an already-reversed event), so presence (.has) == "has a live posting".
    const currentByKey = await buildCurrentJournal(tx, periodEnd); // Map<key, JournalLine[]> (new-posting lines, isReversal:false)
    const priorByKey = await buildPriorNet(tx, periodEnd);         // Map<key, JournalLine[]> (net non-zero prior lines)

    const lines: JournalLine[] = [];
    for (const [key, cur] of currentByKey) {
      if (!priorByKey.has(key)) lines.push(...cur); // new event → post
    }
    for (const [key, prior] of priorByKey) {
      if (!currentByKey.has(key)) lines.push(...reverseLines(prior)); // net-posted but no longer live → reverse
    }

    const exportNumber = await allocateNumber("gl_export_batch_number_next", tx);
    const fileName = `gl-${period.year}-${String(period.month).padStart(2, "0")}.csv`;
    const file = renderCsv(lines, formatDateOnly(periodEnd));
    const register = new Uint8Array(); // Task 7 replaces this with the rendered posting-register PDF
    const batch = await auditedCreate("glExportBatch",
      { exportNumber, closePeriodId, periodEnd, fileName },
      () => tx.glExportBatch.create({
        data: {
          exportNumber, closePeriodId, periodEnd, fileName,
          file: new Uint8Array(file), register,
          postings: { create: lines.map((l) => ({
            sourceType: l.sourceType, sourceId: l.sourceId, glDate: periodEnd,
            glAccountId: l.glAccountId, glAccountName: l.glAccountName, memo: l.memo,
            debit: l.debit, credit: l.credit, side: l.side, isReversal: l.isReversal })) },
        },
        select: { id: true, exportNumber: true, postings: true },
      }), { tx });

    return {
      batchId: batch.id, exportNumber, periodEnd: formatDateOnly(periodEnd),
      postings: batch.postings.map((p) => ({ sourceType: p.sourceType, sourceId: p.sourceId, glAccountId: p.glAccountId, debit: p.debit.toNumber(), credit: p.credit.toNumber(), side: p.side, isReversal: p.isReversal })),
      file,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
```

Implement the private helpers below the export (`reverseLines` is imported from `gl-mapping`, not re-implemented):
- `buildCurrentJournal(tx, periodEnd)`: read finalized invoices/credits (`invoiceDate ≤ periodEnd`) with their lines grouped by `glAccountId` into `SalesEvent.revenue`; posted non-void payments (`receivedDate ≤ periodEnd`) → one `CashEvent{ kind:"PAYMENT" }` each; live `DISCOUNT`/`WRITE_OFF` applications (`appliedDate ≤ periodEnd`) → one `CashEvent` each. Map each via `salesJournal`/`cashJournal`. Return `Map<`${sourceType}:${sourceId}`, JournalLine[]>` — **the 2-part key**.
- `buildPriorNet(tx, periodEnd)`: read `GlPosting` with `glDate ≤ periodEnd`; group by the **same 2-part `${sourceType}:${sourceId}`**; within a group net debit/credit per `(glAccountId, side, memo)`, reconstructing `JournalLine[]` (carry `memo` and `glAccountName` from the row). **Drop any group whose every line nets to zero** (an already-reversed event) so `.has(key)` means "has a live prior posting".
- `resolveReadiness(tx, periodEnd)`: assemble `ReadinessInput` from `getBillingConfig()` + the account-less step codes/surcharges/payment types that appear on in-scope events (`glDate ≤ periodEnd`), set `hasDiscount`/`hasWriteOff` from whether any such application is in scope, call `readinessGaps`.
- `renderCsv(lines, dateStr)`: join `GL_EXPORT_COLUMNS`; one row per line — date, `glAccountName`, debit, credit, memo.
- `export async function getExportBatchFile(batchId): Promise<{ bytes: Buffer; fileName: string; contentType: string }>` and `getExportBatchRegister(batchId): Promise<{ bytes: Buffer; contentType: string }>`: read the stored `file`/`register` bytes (`prisma.glExportBatch.findFirst`, 404 if missing) for the file/register routes.
- `export async function readinessForExport(periodEnd: Date): Promise<ReadinessGap[]>`: wrap `resolveReadiness` in its own transaction — the **same** period-end the export refusal uses, so the UI's readiness panel and disabled-count match `exportClose`'s refusal exactly (§7).

*Grouping key subtlety (copy 5B's identity discipline):* key both maps by the FULL `(sourceType, sourceId)` — an invoice's cuid, a payment's cuid, an application's cuid — never a position or a display field. Because each event maps to a self-balancing set of lines under one id (§ Task 3), the 2-part key both nets correctly and reverses one event without touching another. These ids are never reused.

- [ ] **Step 4: Run the delta tests green.**

```bash
npx vitest run tests/gl-export.test.ts
```

Expected: PASS (balanced first batch, empty re-run, balanced reversal).

- [ ] **Step 5: Add the earlier-month-after-later test** — close July, close August, reopen+correct+re-close July, and assert the July re-export's postings all carry `glDate ≤ 2026-07-31` and August's batch is untouched (`glPosting` rows for August's sourceIds are unchanged).

- [ ] **Step 6: Add the export + readiness routes.** `close/[id]/export/route.ts` (POST, `run_qbo_export`), `close/export/[batchId]/file/route.ts` (GET, `receivables.view`, `getExportBatchFile` → streams `text/csv` attachment), `close/readiness/route.ts` (GET, `receivables.view`, **period-scoped** `?year=&month=` → `readinessForExport(monthEnd)` JSON gap list), `close/readiness/export/route.ts` (GET, `receivables.view`, same `?year=&month=`, `toXlsx("Readiness", …)`). The `?year=&month=` on both readiness routes is what keeps the UI's panel and disabled-count aligned with `exportClose`'s refusal. Export route shape:

```ts
export const POST = handle(async (req, ctx) => {
  const user = requireUser();
  mustCan(user, "receivables", "edit");
  mustDo(user, "run_qbo_export");
  const { id } = await ctx.params;
  return NextResponse.json(await exportClose(id));
});
```

The readiness xlsx route copies `aging/export/route.ts` verbatim, parsing `year`/`month` from the URL, computing the month-end (`new Date(Date.UTC(year, month, 0))`), calling `readinessForExport(monthEnd)`, and using columns `{ key: "label", header: "Gap" }`, `{ key: "href", header: "Fix at" }`.

- [ ] **Step 7: Add the route ladder + xlsx-body tests** to `receivables-routes.test.ts` (401/403/200; assert the file route's `content-type: text/csv` and the readiness export's xlsx MIME).

- [ ] **Step 8: Run gates.**

```bash
npx vitest run tests/gl-export.test.ts tests/receivables-routes.test.ts
npx tsc --noEmit && npx eslint src tests
```

- [ ] **Step 9: Commit.**

```bash
git add erp/src/server/gl-export.ts erp/src/app/api/receivables/close erp/tests/gl-export.test.ts erp/tests/receivables-routes.test.ts
git commit -m "feat(5c): GL-export delta engine (idempotent, reversal-safe), CSV, readiness refusal + routes"
```

---

## Task 7: The posting-register PDF

**Files:**
- Create: `erp/src/server/pdf/posting-register.ts`
- Modify: `erp/src/server/gl-export.ts` (render + store the register)
- Create: `erp/src/app/api/receivables/close/export/[batchId]/register/route.ts`
- Test: `erp/tests/gl-export.test.ts` (extend), `erp/tests/receivables-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `renderPdf`/`LAYOUT` from `pdf/render.ts`; `PostingRegisterData` (owned here); the `JournalLine[]` the export produced.
- Produces: `buildPostingRegister(data): TDocumentDefinitions`, consumed by `gl-export.ts`.

- [ ] **Step 1: Write the failing render test.** Extend `gl-export.test.ts`:

```ts
it("stores a non-empty posting-register PDF with a stable page marker", async () => {
  await seedGlDefaults();
  await makeFinalizedInvoiceDated("2026-07-05", 100);
  await closePeriod(2026, 7);
  const period = await prisma.closePeriod.findFirstOrThrow({ where: { year: 2026, month: 7 } });
  const { batchId } = await exportClose(period.id);
  const row = await prisma.glExportBatch.findUniqueOrThrow({ where: { id: batchId } });
  expect(row.register.byteLength).toBeGreaterThan(1000); // a real PDF, not the placeholder
});
```

- [ ] **Step 2: Run red.**

```bash
npx vitest run tests/gl-export.test.ts -t "posting-register PDF"
```

Expected: FAIL (register is the empty placeholder).

- [ ] **Step 3: Implement `pdf/posting-register.ts`** — a pure builder returning a plain `TDocumentDefinitions` (survives JSON round-trip; layouts by name via `LAYOUT`; owns its input type). Two sub-registers (SALES, then CASH), each a table of Date / Account / Debit / Credit / Memo, with a totals row proving Σdr = Σcr. Model the structure on `pdf/statement.ts`.

```ts
import type { TDocumentDefinitions, Content, TableCell } from "pdfmake/interfaces";
import { LAYOUT } from "./render";

export type PostingRegisterLine = { side: "SALES" | "CASH"; glAccountName: string; debit: number; credit: number; memo: string };
export type PostingRegisterData = { periodLabel: string; periodEnd: string; exportNumber: number; lines: PostingRegisterLine[] };

const money = (n: number) => (n === 0 ? "" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function buildPostingRegister(d: PostingRegisterData): TDocumentDefinitions {
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 40],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    content: [
      { text: `GL Posting Register — ${d.periodLabel}`, bold: true, fontSize: 13 },
      { text: `Export #${d.exportNumber} · JE date ${d.periodEnd}`, margin: [0, 2, 0, 10] },
      sideTable("SALES", d.lines.filter((l) => l.side === "SALES")),
      sideTable("CASH", d.lines.filter((l) => l.side === "CASH")),
    ],
  };
}

function sideTable(title: string, lines: PostingRegisterLine[]): Content {
  const head = (t: string): TableCell => ({ text: t, bold: true });
  const body: TableCell[][] = [[head("Account"), head("Debit"), head("Credit"), head("Memo")]];
  let dr = 0, cr = 0;
  for (const l of lines) { body.push([l.glAccountName, { text: money(l.debit), alignment: "right" }, { text: money(l.credit), alignment: "right" }, l.memo]); dr += l.debit; cr += l.credit; }
  body.push([{ text: "Total", bold: true }, { text: money(dr), alignment: "right", bold: true }, { text: money(cr), alignment: "right", bold: true }, ""]);
  return { margin: [0, 6, 0, 10], stack: [{ text: title, bold: true, margin: [0, 0, 0, 3] }, { table: { headerRows: 1, widths: ["*", "auto", "auto", "*"], body }, layout: LAYOUT.boxed }] };
}
```

- [ ] **Step 4: Render + store it in `gl-export.ts`.** Import `buildPostingRegister` and `renderPdf`, build `PostingRegisterData` from the emitted `lines`, and replace `register: new Uint8Array()` with `new Uint8Array(await renderPdf(buildPostingRegister(data)))`. `renderPdf` is async — call it before the `tx.glExportBatch.create` (build the buffer, then write). Keep it inside the transaction (it does no DB I/O).

- [ ] **Step 5: Add the register route** `close/export/[batchId]/register/route.ts` (GET, `receivables.view`, `getExportBatchRegister` → streams `application/pdf` inline), copying the file route with the PDF MIME.

- [ ] **Step 6: Run tests green + route test.**

```bash
npx vitest run tests/gl-export.test.ts tests/receivables-routes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add erp/src/server/pdf/posting-register.ts erp/src/server/gl-export.ts erp/src/app/api/receivables/close/export erp/tests/gl-export.test.ts erp/tests/receivables-routes.test.ts
git commit -m "feat(5c): posting-register PDF stored byte-for-byte on the export batch"
```

---

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

## Task 9: E2E flow, demo doc, and documentation

**Files:**
- Create: `erp/tests/e2e/close.spec.ts`, `docs/2026-08-09-phase-5c-demo.md`
- Modify: `docs/HANDOFF.md`, `CLAUDE.md`, and the spec's §15 decision log if the contract shifted

**Interfaces:** none (verification + docs).

- [ ] **Step 1: Write the E2E flow** `close.spec.ts` (Playwright, DEV db `erp`, bundled Chromium; heed the `getByLabel`-on-`<select>` trap — use `getByRole("combobox")` / `locator("label",{hasText}).locator("select")`): sign in as admin; set the three GL defaults in Admin → Billing; create + finalize a July-dated invoice; take a payment with a discount + a small write-off; open `/receivables/close`; assert the preliminary schedule reconciles (variance 0); close July; export; download the CSV and assert Σdebit = Σcredit by parsing it; then reopen July, void the payment, re-close, re-export, and assert a non-empty balanced reversing delta. Clean up the fixtures from the DEV db afterward.

- [ ] **Step 2: Run the full gate chain.**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build && npm run test:e2e
```

Expected: all green. Capture the counts for the handoff.

- [ ] **Step 3: Write the demo doc** `docs/2026-08-09-phase-5c-demo.md` — the walkthrough (seed accounts → enter a month → preliminary → close → export → reopen/correct/re-export), a screenshot or two of the register, and a **flagged-deviations** list for an owner ruling. Explicitly restate the two owner-homework items (spec §14): the real GL account list, and the bookkeeper's QBO import method + the correction-JE-dating question.

- [ ] **Step 4: Update the docs (part of the work, not a follow-up).**
  - `docs/HANDOFF.md`: §4 — add the current-phase state (or, once merged, a one-paragraph "Merged, in build order" entry + the history-file pointer); §9 — replace the 5C kickoff with the next work (Phase 6 quoting, or the 5B/5C follow-up backlog). Update the migration count and test tallies (dated).
  - `CLAUDE.md`: add the two new house rules this phase establishes, displacing nothing that stands — **(a)** the period-lock advisory-lock pattern (the guarded fact is the *absence* of a `ClosePeriod` row, so both the close and `assertPeriodOpen` take a per-`(year,month)` `pg_advisory_xact_lock`; a plain `findFirst` is not a guard), and **(b)** the GL-export delta contract (per-event `GlPosting` ledger, bounded by the exported period-end, new/reversed detection — idempotent and reversal-safe; nothing cached on `Invoice`/`Payment`/`Application`).
  - The spec's §15 decision log / the 5C design spec's §17 only if an owner ruling amended the contract during execution.

- [ ] **Step 5: Commit the docs and demo.**

```bash
git add docs/HANDOFF.md CLAUDE.md docs/2026-08-09-phase-5c-demo.md erp/tests/e2e
git commit -m "docs(5c): E2E close flow, demo, and handoff/house-rule updates"
```

- [ ] **Step 6: Open the PR** (attribution in the PR body, never a commit trailer). Summarize the deliverables, the gate results, the two owner-homework items, and any deferred review findings.

---

## Self-review

**Spec coverage** (each spec section → task):
- §4.1 ClosePeriod/GlExportBatch/GlPosting → Task 1. §4.2 BillingConfig FKs → Tasks 1–2. §4.3 delta contract → Task 6. §5 the two journals → Task 3 (engine) + Task 6 (wiring). §6 close lifecycle + period lock → Tasks 4–5. §7 readiness → Task 3 (resolver) + Task 6 (refusal + routes) + Task 8 (UI). §8 permissions/audit/sweeps → Task 1 (audit + counter + partial-unique) + Task 2 (reference-links) + Tasks 5–6 (the two specials `close_ar_period`/`run_qbo_export` — **verified already present** in `permission-constants.ts` `SPECIAL_ACTIONS` and admin-granted via `ALL_PERMISSIONS`, `permissions.test.ts:43`; Tasks 5–6 only wire routes/UI to them, no declaration step). §9 services → Tasks 3–7. §10 routes → Tasks 5–7. §11 UI → Task 8. §12 testing (incl. RED concurrency) → Tasks 4–6. §13 E2E + demo → Task 9. §14 owner homework → surfaced in Task 9's demo. §16 non-goals → nothing built for them.
- **Gap check:** the register-PDF ordering between Task 6 (writes an empty placeholder) and Task 7 (fills it) is called out in both tasks so a reviewer of Task 6 knows the placeholder is intentional and Task 7 is its completion. No spec requirement is unassigned.

**Placeholder scan:** no "TBD/TODO/implement later"; every code step carries code, every mechanical extension shows the exemplar + the exact spots. The one deliberate interim value (Task 6's empty `register` buffer, replaced in Task 7) is labelled as such, not a placeholder for missing design.

**Type consistency:** `JournalLine` (Task 3, carrying `isReversal` + `memo`) is produced by `salesJournal`/`cashJournal` (`isReversal:false`) and `reverseLines` (`isReversal:true`) and consumed by `gl-export.ts` (Task 6), which writes `l.isReversal`/`l.memo`/`l.sourceId` straight onto each `GlPosting` — no undefined helper, one 2-part `(sourceType, sourceId)` key on both sides of the delta. `CashEvent` is per-event (one payment/discount/write-off → a balanced pair keyed on its own id — no aggregate `sourceId:""`). `ContinuitySchedule`/`ClosePeriodDetail` (Task 5) flow to the UI (Task 8). `assertPeriodOpen(tx, glDate)`/`lockMonth(tx, year, month)` (Task 4) are consumed by the mutations (Task 4) and `close-periods.ts` (Task 5). `ReadinessGap`/`readinessGaps` (Task 3) → `resolveReadiness`/`readinessForExport(periodEnd)` (Task 6) → the period-scoped routes/UI. `getExportBatchFile`/`getExportBatchRegister` (Task 6) back the file/register routes. `exportNumber` uses the `gl_export_batch_number_next` counter (Task 1). `currentActor().id` and `formatDateOnly` are verified against the real code; the only remaining reconciliation is the `withDbErrors`/`prisma` import token, flagged inline in Task 5.
