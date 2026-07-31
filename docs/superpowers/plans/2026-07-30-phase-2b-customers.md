# Phase 2B — Customers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can key their real customers — code, name, parent/child divisions, credit terms, typed addresses, and contacts — with Excel export, spreadsheet paste, and full audit.

**Architecture:** Customer gets its **own service** (`src/server/customers.ts`) rather than running through Phase 2A's generic `reference.ts`. That service keys on a unique `name` and assumes flat extra columns; Customer keys on `code`, carries a self-reference and two child collections, so forcing it in would damage an abstraction eleven reference kinds depend on. Addresses and contacts are audited as **their own models** (kickoff §2) — cleaner history than giant parent snapshots. The Excel-quote-aware TSV parser is extracted from `paste.ts` into a shared module first, because customer paste needs the same behaviour and it took two fix rounds to get right.

**Tech Stack:** Next.js 15.5.22 (App Router), React 19, Prisma 6.19.3 + PostgreSQL 16, zod 4, vitest 3 against a real `erp_test` database, Tailwind 4, exceljs 4.4.

## Global Constraints

- **Node 22+**, npm. All commands run from `erp/`.
- **Quality gates, green at every commit:** `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`.
- **Migrations apply to BOTH databases.** After any `schema.prisma` edit:
  `npx prisma migrate dev --name <name>` then
  `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`
- **Soft delete only** — `deletedAt`, never a hard delete outside tests.
- **Every mutation goes through `auditedCreate` / `auditedUpdate` / `auditedSoftDelete`.** `src/server/audit.ts` is the **sole writer** of audit rows and a sweep test enforces it. Extend `AuditableModel` and `SNAPSHOT_INCLUDE` for each new entity.
- **Revival-on-create is mandatory for any `@unique` column with soft delete** (kickoff §2.6). Clear `deletedAt`, update fields from the new input, **and reset `active` to true** unless explicitly passed. Ruled Critical twice in Phase 2A. Copy `createReference` in `src/server/reference.ts`.
- **`requireUser()` is synchronous and zero-arg**: `mustCan(requireUser(), "customers", "view")`.
- **`HttpError` comes from `./errors`**, never `./http`. `src/server/errors.ts` must keep **zero imports** — a test enforces it.
- **Client components never import from `src/server/**`** — shared constants live in `src/lib/`.
- **Customers are gated by the `customers` area** (`customers.view` / `.create` / `.edit` / `.delete`) — it already exists in `src/lib/permission-constants.ts`. Reference data stays on `admin`.
- Route handler tests pass ctx: `handler(request, { params: Promise.resolve({}) })`.
- Tests share one database: `truncateAll()` in `beforeEach`, `fileParallelism: false`.
- **Conventional commits** ending with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq
  ```

---

## File Structure

**Created:**
- `src/server/tsv.ts` — the Excel-quote-aware parser, extracted from `paste.ts` so customers reuse it.
- `src/server/customers.ts` — customer CRUD, revival, parent-cycle guard, paste.
- `src/server/customer-addresses.ts` — typed addresses, one-default-per-kind.
- `src/server/customer-contacts.ts` — contacts and their per-document flags.
- `src/lib/customer-constants.ts` — client-safe address kinds, contact flags, paste column order.
- `src/app/api/customers/route.ts`, `.../[id]/route.ts`, `.../[id]/addresses/route.ts`, `.../[id]/addresses/[addressId]/route.ts`, `.../[id]/contacts/route.ts`, `.../[id]/contacts/[contactId]/route.ts`, `.../export/route.ts`, `.../paste/route.ts`
- `src/app/customers/page.tsx`, `src/app/customers/[id]/page.tsx`
- `tests/tsv.test.ts`, `tests/customers.test.ts`, `tests/customer-children.test.ts`, `tests/customer-routes.test.ts`, `tests/customer-paste.test.ts`

**Modified:**
- `prisma/schema.prisma` — drop `Salesperson`; add `Customer`, `CustomerAddress`, `CustomerContact`, `AddressKind`.
- `src/server/paste.ts` — import the parser instead of defining it.
- `src/server/audit.ts` — drop `salesperson`, add the three new models.
- `src/lib/reference-constants.ts`, `src/server/reference.ts` — drop `salesperson`.
- `tests/reference-tables.test.ts` — expect ten kinds, not eleven.
- `src/components/Shell.tsx` — Customers nav already exists; no change expected (verify).
- `tests/permissions-sweep.test.ts` — extended in Task 9.

---

## Task 1: Remove the Salesperson reference table

The owner confirmed 2026-07-30 that this shop does not assign salespeople. It shipped in Phase 2A and nothing references it; leaving it puts a permanently-empty pick-list in the admin screens.

**Files:**
- Modify: `prisma/schema.prisma`, `src/lib/reference-constants.ts`, `src/server/reference.ts`, `src/server/audit.ts`, `tests/reference-tables.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `REFERENCE_KINDS` drops to ten members. `ReferenceKind` no longer includes `"salesperson"`.

- [ ] **Step 1: Update the test that asserts the kind list**

In `tests/reference-tables.test.ts`, the first test asserts the sorted kind list. Remove `"salesperson"`:

```ts
  it("exposes every kind the owner needs to key", () => {
    expect([...REFERENCE_KINDS].sort()).toEqual([
      "carrier", "commentSnippet", "containerType", "glAccount", "inspectionCode",
      "inspectionScale", "material", "paymentType", "specification", "terms",
    ]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/reference-tables.test.ts -t "exposes every kind"`
Expected: FAIL — received array still contains `"salesperson"`.

- [ ] **Step 3: Drop it from the client-safe constants**

In `src/lib/reference-constants.ts`: remove `"salesperson"` from `REFERENCE_KINDS`, remove the `salesperson:` line from `REFERENCE_LABELS`, and remove `salesperson: []` from the trailing group in `REFERENCE_EXTRA_FIELDS`.

- [ ] **Step 4: Drop it from the service and audit**

In `src/server/reference.ts`, remove `salesperson: z.object({}),` from `EXTRA_SCHEMAS`.
In `src/server/audit.ts`, remove `| "salesperson"` from the `AuditableModel` union and `salesperson: undefined,` from `SNAPSHOT_INCLUDE`.

`tsc` will flag any straggler — the `Record<ReferenceKind, ...>` types make an orphaned key a compile error.

- [ ] **Step 5: Drop the model and migrate both databases**

Remove the entire `model Salesperson { ... }` block from `prisma/schema.prisma`.

```bash
npx prisma migrate dev --name drop_salesperson
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

The generated migration drops the table. That is intended — the table is empty in every environment and the owner has ruled it unused.

- [ ] **Step 6: Verify nothing references it**

```bash
grep -rn "salesperson\|Salesperson" src/ tests/ prisma/schema.prisma
```
Expected: no output.

- [ ] **Step 7: Run all four gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: green. The `it.each(REFERENCE_KINDS)` delegate-contract test now runs ten cases.

- [ ] **Step 8: Commit**

```bash
git add prisma src/lib/reference-constants.ts src/server/reference.ts src/server/audit.ts tests/reference-tables.test.ts
git commit -m "feat: remove the unused Salesperson reference table

The owner confirmed this shop does not assign salespeople, so the table
shipped in Phase 2A is unreferenced. Leaving it would put a permanently
empty pick-list in the admin screens.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq"
```

---

## Task 2: Extract the TSV parser into a shared module

`parseRecords` is module-private in `paste.ts`. Customer paste needs identical behaviour, and this parser took two fix rounds in Phase 2A to get right (Excel quoting, then a trailing-tab false positive). Reimplementing it would reintroduce both bugs.

**Files:**
- Create: `src/server/tsv.ts`, `tests/tsv.test.ts`
- Modify: `src/server/paste.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `@/server/tsv`:
  - `type ParsedRecord = { startLine: number; fields: string[] }`
  - `type ParseError = { line: number; message: string }`
  - `type ParseOutcome = { records: ParsedRecord[]; error: ParseError | null }`
  - `parseRecords(text: string): ParseOutcome`
  - `isBlankRecord(fields: string[]): boolean`
  - `parseTsv(text: string, columns: string[]): Record<string, string>[]`
  - `overflowError(fields: string[], columns: string[]): string | null` — returns the "Too many columns" message when a record carries content past the declared columns, else `null`. Extracted so customer paste applies the identical rule, including the trailing-tab tolerance.

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/tsv.test.ts
import { describe, it, expect } from "vitest";
import { parseRecords, isBlankRecord, parseTsv, overflowError } from "@/server/tsv";

describe("tsv parser", () => {
  it("parses plain rows with 1-based start lines", () => {
    const { records, error } = parseRecords("a\tb\nc\td");
    expect(error).toBeNull();
    expect(records).toEqual([
      { startLine: 1, fields: ["a", "b"] },
      { startLine: 2, fields: ["c", "d"] },
    ]);
  });

  it("decodes an escaped inner quote", () => {
    expect(parseRecords('"3/4"" round"').records[0].fields).toEqual(['3/4" round']);
  });

  it("keeps a multi-line quoted cell as ONE record and numbers what follows correctly", () => {
    const { records } = parseRecords('"line one\nline two"\nnext');
    expect(records[0].fields).toEqual(["line one\nline two"]);
    expect(records[1]).toEqual({ startLine: 3, fields: ["next"] });
  });

  it("reports an unterminated quote and keeps records parsed before it", () => {
    const { records, error } = parseRecords('good\n"unterminated');
    expect(records).toHaveLength(1);
    expect(error?.message).toMatch(/unterminated quoted cell/);
  });

  it("counts blank lines for numbering but flags them as blank", () => {
    const { records } = parseRecords("a\n\nb");
    expect(records.map((r) => r.startLine)).toEqual([1, 2, 3]);
    expect(records.map((r) => isBlankRecord(r.fields))).toEqual([false, true, false]);
  });

  it("parseTsv pads short rows and drops blank lines", () => {
    expect(parseTsv("x\n\n", ["a", "b"])).toEqual([{ a: "x", b: "" }]);
  });

  it("overflowError tolerates trailing empties but rejects real extra content", () => {
    expect(overflowError(["a", "b", ""], ["one", "two"])).toBeNull();
    expect(overflowError(["a", "b", "   "], ["one", "two"])).toBeNull();
    expect(overflowError(["a", "b", "c"], ["one", "two"])).toMatch(/Too many columns/);
    expect(overflowError(["a"], ["one", "two"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tsv.test.ts`
Expected: FAIL — `Cannot find module '@/server/tsv'`.

- [ ] **Step 3: Create tsv.ts by moving the parser verbatim**

Create `src/server/tsv.ts` and **move** `ParsedRecord`, `ParseError`, `ParseOutcome`, `parseRecords`, `isBlankRecord`, and `parseTsv` out of `src/server/paste.ts` unchanged — including their comments, which record why the parser is character-scanning rather than a split. Export all six. Then add `overflowError`, lifting the rule currently inline in `pasteReference`:

```ts
/**
 * A record carrying content past the declared columns is an error, not something to truncate —
 * silent truncation is the data loss `.strict()` exists to catch on single adds. But Excel
 * routinely emits trailing tabs on an otherwise-normal row (copying a selection with an empty
 * trailing cell, or a range one column wider than the data), so only overflow cells with actual
 * content count. Fields arrive already trimmed.
 */
export function overflowError(fields: string[], columns: string[]): string | null {
  const overflow = fields.slice(columns.length);
  if (!overflow.some((c) => c.length > 0)) return null;
  return `Too many columns: expected ${columns.length} (${columns.join(", ")}) but got ${fields.length}`;
}
```

- [ ] **Step 4: Rewire paste.ts to import rather than define**

In `src/server/paste.ts`, replace the moved definitions with:

```ts
import { parseRecords, isBlankRecord, overflowError } from "./tsv";
```

and replace the inline overflow block inside `pasteReference` with:

```ts
    const overflow = overflowError(record.fields, columns);
    if (overflow) {
      errors.push({ row: rowNumber, message: overflow });
      continue;
    }
```

`paste.ts` keeps `pasteReference` and `PasteResult`.

**`tests/paste.test.ts` imports `parseTsv` from `@/server/paste` in eight places.** Change **only that import line** to `@/server/tsv` — do not add a re-export to `paste.ts` to avoid touching the test, and do not change a single assertion.

- [ ] **Step 5: Run the existing paste tests — this refactor must change no behaviour**

```bash
npx vitest run tests/tsv.test.ts tests/paste.test.ts
```
Expected: both green. The **only** permitted edit to `tests/paste.test.ts` is the import specifier in Step 4; every assertion, input string, and expected value stays byte-identical. If an assertion needs changing, you have altered behaviour — fix the move, not the test. Verify with `git diff tests/paste.test.ts` and confirm it shows one changed line.

- [ ] **Step 6: Run all four gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/server/tsv.ts src/server/paste.ts tests/tsv.test.ts
git commit -m "refactor: extract the Excel-quote-aware TSV parser for reuse by customer paste

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq"
```

---

## Task 3: Customer schema and service

**Files:**
- Modify: `prisma/schema.prisma`, `src/server/audit.ts`
- Create: `src/server/customers.ts`, `src/lib/customer-constants.ts`, `tests/customers.test.ts`

**Interfaces:**
- Consumes: `withDbErrors`, `HttpError`, the audit helpers.
- Produces, from `@/server/customers`:
  - `type CustomerRow = { id: string; code: string; name: string; parentId: string | null; parentCode: string | null; termsId: string | null; creditLimit: number | null; creditHold: boolean; cod: boolean; taxable: boolean; defaultPo: string; orderNotes: string; shippingNotes: string; invoiceNotes: string; surchargeOptOut: boolean; financeChargeRate: number | null; active: boolean }`
  - `listCustomers(opts?: { includeInactive?: boolean; search?: string }): Promise<CustomerRow[]>`
  - `getCustomer(id: string): Promise<CustomerRow>`
  - `createCustomer(input: Record<string, unknown>): Promise<{ id: string }>`
  - `updateCustomer(id: string, input: Record<string, unknown>): Promise<void>`
  - `deleteCustomer(id: string): Promise<void>`
- From `@/lib/customer-constants`: `CUSTOMER_PASTE_COLUMNS`, `ADDRESS_KINDS`, `ADDRESS_KIND_LABELS`, `CONTACT_FLAGS`.

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/customers.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import {
  listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer,
} from "@/server/customers";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";

describe("customers service", () => {
  beforeEach(async () => await truncateAll());

  it("creates and lists by code", async () => {
    await createCustomer({ code: "BETA", name: "Beta Co" });
    await createCustomer({ code: "ACME", name: "Acme Foundry" });
    expect((await listCustomers()).map((c) => c.code)).toEqual(["ACME", "BETA"]);
  });

  it("requires both code and name", async () => {
    await expect(createCustomer({ code: "X" })).rejects.toThrow();
    await expect(createCustomer({ name: "No code" })).rejects.toThrow();
  });

  it("rejects a duplicate code and an unknown field", async () => {
    await createCustomer({ code: "ACME", name: "Acme" });
    await expect(createCustomer({ code: "ACME", name: "Other" })).rejects.toThrow(HttpError);
    await expect(createCustomer({ code: "NEW", name: "N", bogus: 1 })).rejects.toThrow();
  });

  it("revives a soft-deleted code and brings it back active", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await updateCustomer(id, { active: false });
    await deleteCustomer(id);
    const again = await createCustomer({ code: "ACME", name: "Acme Reborn" });
    expect(again.id).toBe(id);
    const rows = await listCustomers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "ACME", name: "Acme Reborn", active: true });
  });

  it("stores the Phase 5 commercial fields and returns decimals as numbers", async () => {
    const terms = await prisma.terms.create({ data: { name: "Net 30" } });
    const { id } = await createCustomer({
      code: "ACME", name: "Acme", termsId: terms.id, creditLimit: "25000.00",
      creditHold: true, cod: false, taxable: false, defaultPo: "BLANKET-7",
      orderNotes: "call before shipping", surchargeOptOut: true, financeChargeRate: "0.015",
    });
    const c = await getCustomer(id);
    expect(c.creditLimit).toBe(25000);
    expect(c.financeChargeRate).toBe(0.015);
    expect(c).toMatchObject({ creditHold: true, taxable: false, defaultPo: "BLANKET-7", surchargeOptOut: true });
  });

  it("links a parent and exposes its code for display", async () => {
    const parent = await createCustomer({ code: "ACME", name: "Acme Corp" });
    const child = await createCustomer({ code: "ACME-OH", name: "Acme Ohio", parentId: parent.id });
    expect((await getCustomer(child.id)).parentCode).toBe("ACME");
  });

  it("refuses to make a customer its own ancestor", async () => {
    const a = await createCustomer({ code: "A", name: "A" });
    const b = await createCustomer({ code: "B", name: "B", parentId: a.id });
    await expect(updateCustomer(a.id, { parentId: b.id })).rejects.toThrow(/circular|ancestor|itself/i);
    await expect(updateCustomer(a.id, { parentId: a.id })).rejects.toThrow(/circular|ancestor|itself/i);
  });

  it("refuses to delete a customer that still has active children", async () => {
    const parent = await createCustomer({ code: "ACME", name: "Acme" });
    const child = await createCustomer({ code: "ACME-OH", name: "Ohio", parentId: parent.id });
    await expect(deleteCustomer(parent.id)).rejects.toThrow(/child/i);
    await deleteCustomer(child.id);
    await deleteCustomer(parent.id);
    expect(await listCustomers()).toHaveLength(0);
  });

  it("searches on code and name", async () => {
    await createCustomer({ code: "ACME", name: "Acme Foundry" });
    await createCustomer({ code: "BETA", name: "Beta Castings" });
    expect((await listCustomers({ search: "acm" })).map((c) => c.code)).toEqual(["ACME"]);
    expect((await listCustomers({ search: "castings" })).map((c) => c.code)).toEqual(["BETA"]);
  });

  it("hides inactive unless asked, and soft delete leaves the row", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await updateCustomer(id, { active: false });
    expect(await listCustomers()).toHaveLength(0);
    expect(await listCustomers({ includeInactive: true })).toHaveLength(1);
    await deleteCustomer(id);
    expect(await listCustomers({ includeInactive: true })).toHaveLength(0);
    expect(await prisma.customer.findUnique({ where: { id } })).not.toBeNull();
  });

  it("audits create and update with a usable diff", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await updateCustomer(id, { name: "Acme Foundry" });
    const entries = await readAudit("customer", id);
    expect(entries.map((e) => e.action)).toEqual(["update", "create"]);
    expect((entries[0].before as { name: string }).name).toBe("Acme");
    expect((entries[0].after as { name: string }).name).toBe("Acme Foundry");
  });

  it("404s on an unknown id", async () => {
    await expect(getCustomer("nope")).rejects.toMatchObject({ status: 404 });
    await expect(updateCustomer("nope", { name: "x" })).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/customers.test.ts`
Expected: FAIL — `Cannot find module '@/server/customers'`.

- [ ] **Step 3: Add the schema**

Append to `prisma/schema.prisma`:

```prisma
model Customer {
  id                String    @id @default(cuid())
  code              String    @unique
  name              String
  parentId          String?
  parent            Customer? @relation("CustomerHierarchy", fields: [parentId], references: [id])
  children          Customer[] @relation("CustomerHierarchy")
  termsId           String?
  terms             Terms?    @relation(fields: [termsId], references: [id])
  creditLimit       Decimal?  @db.Decimal(12, 2)
  creditHold        Boolean   @default(false)
  cod               Boolean   @default(false)
  taxable           Boolean   @default(true)
  defaultPo         String    @default("")
  orderNotes        String    @default("")
  shippingNotes     String    @default("")
  invoiceNotes      String    @default("")
  surchargeOptOut   Boolean   @default(false)
  financeChargeRate Decimal?  @db.Decimal(6, 4)
  active            Boolean   @default(true)
  deletedAt         DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  addresses         CustomerAddress[]
  contacts          CustomerContact[]
  @@index([name])
}
```

Add the back-relation `customers Customer[]` to `model Terms`.

- [ ] **Step 4: Migrate both databases**

```bash
npx prisma migrate dev --name customer
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

- [ ] **Step 5: Write the client-safe constants**

```ts
// erp/src/lib/customer-constants.ts
// Pure constants — safe to import from client components (no server imports).
export const ADDRESS_KINDS = ["SHIP_TO", "BILL_TO", "RECEIVED_FROM"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

export const ADDRESS_KIND_LABELS: Record<AddressKind, string> = {
  SHIP_TO: "Ship to",
  BILL_TO: "Bill to",
  RECEIVED_FROM: "Received from",
};

export const CONTACT_FLAGS = [
  { key: "getsShippers", label: "Shippers" },
  { key: "getsInvoices", label: "Invoices" },
  { key: "getsStatements", label: "Statements" },
  { key: "getsCerts", label: "Certs" },
] as const;

/** Column order for spreadsheet paste, and the header hint shown above the paste box. */
export const CUSTOMER_PASTE_COLUMNS = ["code", "name", "defaultPo", "orderNotes"] as const;
```

- [ ] **Step 6: Write the service**

```ts
// erp/src/server/customers.ts
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";

export type CustomerRow = {
  id: string; code: string; name: string;
  parentId: string | null; parentCode: string | null;
  termsId: string | null;
  creditLimit: number | null; creditHold: boolean; cod: boolean; taxable: boolean;
  defaultPo: string; orderNotes: string; shippingNotes: string; invoiceNotes: string;
  surchargeOptOut: boolean; financeChargeRate: number | null; active: boolean;
};

// Prisma returns Decimal objects, which serialize to JSON as an opaque shape rather than a
// number. Convert at the service boundary so routes, the UI, and Excel all see plain numbers.
const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

const money = z.union([z.number(), z.string()]).nullable().optional();

const CREATE = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(200),
  parentId: z.string().nullable().optional(),
  termsId: z.string().nullable().optional(),
  creditLimit: money,
  creditHold: z.boolean().optional(),
  cod: z.boolean().optional(),
  taxable: z.boolean().optional(),
  defaultPo: z.string().max(200).optional(),
  orderNotes: z.string().max(4000).optional(),
  shippingNotes: z.string().max(4000).optional(),
  invoiceNotes: z.string().max(4000).optional(),
  surchargeOptOut: z.boolean().optional(),
  financeChargeRate: money,
  active: z.boolean().optional(),
}).strict();

const SELECT = {
  id: true, code: true, name: true, parentId: true, termsId: true,
  creditLimit: true, creditHold: true, cod: true, taxable: true,
  defaultPo: true, orderNotes: true, shippingNotes: true, invoiceNotes: true,
  surchargeOptOut: true, financeChargeRate: true, active: true,
  parent: { select: { code: true } },
} as const;

type Raw = Prisma.CustomerGetPayload<{ select: typeof SELECT }>;
function toRow(r: Raw): CustomerRow {
  const { parent, creditLimit, financeChargeRate, ...rest } = r;
  return { ...rest, parentCode: parent?.code ?? null,
    creditLimit: num(creditLimit), financeChargeRate: num(financeChargeRate) };
}

export async function listCustomers(opts?: { includeInactive?: boolean; search?: string }): Promise<CustomerRow[]> {
  const q = opts?.search?.trim();
  const rows = await prisma.customer.findMany({
    where: {
      deletedAt: null,
      ...(opts?.includeInactive ? {} : { active: true }),
      ...(q ? { OR: [
        { code: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ] } : {}),
    },
    select: SELECT,
    orderBy: { code: "asc" },
  });
  return rows.map(toRow);
}

export async function getCustomer(id: string): Promise<CustomerRow> {
  const row = await prisma.customer.findFirst({ where: { id, deletedAt: null }, select: SELECT });
  if (!row) throw new HttpError(404, "Customer not found");
  return toRow(row);
}

/** Rejects a parent chain that would make `id` its own ancestor. */
async function assertNoCycle(id: string, parentId: string | null | undefined): Promise<void> {
  if (!parentId) return;
  if (parentId === id) throw new HttpError(400, "A customer cannot be its own parent");
  let cursor: string | null = parentId;
  const seen = new Set<string>([id]);
  while (cursor) {
    if (seen.has(cursor)) throw new HttpError(400, "That parent would create a circular relationship");
    seen.add(cursor);
    const next: { parentId: string | null } | null =
      await prisma.customer.findUnique({ where: { id: cursor }, select: { parentId: true } });
    cursor = next?.parentId ?? null;
  }
}

export async function createCustomer(input: Record<string, unknown>): Promise<{ id: string }> {
  const data = CREATE.parse(input);
  // No cycle check on create: a row that does not exist yet cannot be in anyone's parent chain.
  // A bogus parentId falls through to Prisma's FK constraint, which db-errors maps to a clean 400.

  // `code` is unique and deletion is soft, so a deleted code would otherwise be permanently
  // unusable — the owner deletes a typo, retypes it, and gets "already exists" for a row nothing
  // can display. Mirrors createReference (src/server/reference.ts) and createRole.
  const existing = await prisma.customer.findUnique({ where: { code: data.code } });
  if (existing && !existing.deletedAt) throw new HttpError(400, "A customer with that code already exists");

  const row = existing
    ? await auditedUpdate("customer", existing.id, () =>
        withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
          // A revived row must come back live unless the caller explicitly asked otherwise;
          // returning it still inactive would make a "successful" create silently invisible.
          prisma.customer.update({
            where: { id: existing.id },
            data: { ...data, deletedAt: null, active: data.active ?? true },
          })))
    : await auditedCreate("customer", data, () =>
        withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
          prisma.customer.create({ data })));
  return { id: row.id };
}

export async function updateCustomer(id: string, input: Record<string, unknown>): Promise<void> {
  const data = CREATE.partial().strict().parse(input);
  if (data.parentId !== undefined) await assertNoCycle(id, data.parentId);
  await withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
    auditedUpdate("customer", id, () => prisma.customer.update({ where: { id }, data })));
}

export async function deleteCustomer(id: string): Promise<void> {
  // Mirrors deleteRole's "still assigned" guard: orphaning children behind a deleted parent
  // would leave rows whose parentCode resolves to something no screen can show.
  const children = await prisma.customer.count({ where: { parentId: id, deletedAt: null } });
  if (children > 0) throw new HttpError(400, "That customer still has child customers");
  await withDbErrors({ entity: "Customer" }, () => auditedSoftDelete("customer", id));
}
```

- [ ] **Step 7: Extend the audit union**

In `src/server/audit.ts`, add `| "customer"` to `AuditableModel` and `customer: undefined,` to `SNAPSHOT_INCLUDE`. Addresses and contacts are audited as their own models (Task 5/6), so the parent snapshot needs no relations.

- [ ] **Step 8: Run the tests, then all four gates, then commit**

```bash
npx vitest run tests/customers.test.ts
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add prisma src/server/customers.ts src/lib/customer-constants.ts src/server/audit.ts tests/customers.test.ts
git commit -m "feat: customer schema and service with code, parent hierarchy, and revival

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq"
```

---

## Task 4: Customer routes

**Files:**
- Create: `src/app/api/customers/route.ts`, `src/app/api/customers/[id]/route.ts`, `tests/customer-routes.test.ts`

**Interfaces:**
- Consumes: everything from Task 3; `signInWith` from `tests/helpers/auth`.
- Produces: `GET/POST /api/customers`, `GET/PUT/DELETE /api/customers/[id]`.

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/customer-routes.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET as list, POST as create } from "@/app/api/customers/route";
import { GET as detail, PUT as update, DELETE as remove } from "@/app/api/customers/[id]/route";
import { createCustomer } from "@/server/customers";

const noParams = { params: Promise.resolve({}) };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

describe("customer routes", () => {
  beforeEach(async () => await truncateAll());

  it("401s every verb without a session", async () => {
    expect((await list(new Request("http://t/api/customers"), noParams)).status).toBe(401);
    expect((await create(new Request("http://t/api/customers", { method: "POST", body: "{}" }), noParams)).status).toBe(401);
    expect((await detail(new Request("http://t/api/customers/x"), withId("x"))).status).toBe(401);
    expect((await update(new Request("http://t/api/customers/x", { method: "PUT", body: "{}" }), withId("x"))).status).toBe(401);
    expect((await remove(new Request("http://t/api/customers/x", { method: "DELETE" }), withId("x"))).status).toBe(401);
  });

  it("403s each verb the user lacks, while view still works", async () => {
    const cookie = await signInWith(["customers.view"]);
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });

    expect((await list(new Request("http://t/api/customers", { headers: { cookie } }), noParams)).status).toBe(200);
    expect((await detail(new Request(`http://t/api/customers/${id}`, { headers: { cookie } }), withId(id))).status).toBe(200);

    const post = await create(new Request("http://t/api/customers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "NEW", name: "New" }),
    }), noParams);
    expect(post.status).toBe(403);

    const put = await update(new Request(`http://t/api/customers/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    }), withId(id));
    expect(put.status).toBe(403);

    const del = await remove(new Request(`http://t/api/customers/${id}`, {
      method: "DELETE", headers: { cookie },
    }), withId(id));
    expect(del.status).toBe(403);
  });

  it("round-trips a create through the route and honours search", async () => {
    const cookie = await signInWith(["customers.view", "customers.create"]);
    const res = await create(new Request("http://t/api/customers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "ACME", name: "Acme Foundry" }),
    }), noParams);
    expect(res.status).toBe(200);

    const found = await list(new Request("http://t/api/customers?search=acme", { headers: { cookie } }), noParams);
    expect((await found.json()).map((c: { code: string }) => c.code)).toEqual(["ACME"]);
  });

  it("surfaces a duplicate code as a readable 400", async () => {
    const cookie = await signInWith(["customers.view", "customers.create"]);
    await createCustomer({ code: "ACME", name: "Acme" });
    const res = await create(new Request("http://t/api/customers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "ACME", name: "Dup" }),
    }), noParams);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already exists/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/customer-routes.test.ts`
Expected: FAIL — the route modules do not exist.

- [ ] **Step 3: Write the collection route**

```ts
// erp/src/app/api/customers/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listCustomers, createCustomer } from "@/server/customers";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "customers", "view");
  const url = new URL(req.url);
  return NextResponse.json(await listCustomers({
    includeInactive: url.searchParams.get("includeInactive") === "1",
    search: url.searchParams.get("search") ?? undefined,
  }));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "customers", "create");
  return NextResponse.json(await createCustomer(await req.json()));
});
```

- [ ] **Step 4: Write the item route**

```ts
// erp/src/app/api/customers/[id]/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getCustomer, updateCustomer, deleteCustomer } from "@/server/customers";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  return NextResponse.json(await getCustomer((await params).id));
});

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  await updateCustomer((await params).id, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "delete");
  await deleteCustomer((await params).id);
  return NextResponse.json({ ok: true });
});
```

- [ ] **Step 5: Run the tests, then all four gates, then commit**

```bash
npx vitest run tests/customer-routes.test.ts
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/app/api/customers tests/customer-routes.test.ts
git commit -m "feat: customer routes with per-verb permission gating

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq"
```

---

## Task 5: Typed addresses

**Files:**
- Modify: `prisma/schema.prisma`, `src/server/audit.ts`
- Create: `src/server/customer-addresses.ts`, `src/app/api/customers/[id]/addresses/route.ts`, `src/app/api/customers/[id]/addresses/[addressId]/route.ts`
- Test: `tests/customer-children.test.ts` (addresses half)

**Interfaces:**
- Consumes: Task 3's service; `ADDRESS_KINDS` from `@/lib/customer-constants`.
- Produces, from `@/server/customer-addresses`:
  - `type AddressRow = { id: string; kind: AddressKind; name: string; street: string; city: string; state: string; zip: string; isDefault: boolean; active: boolean }`
  - `listAddresses(customerId: string, opts?: { includeInactive?: boolean }): Promise<AddressRow[]>`
  - `addAddress(customerId: string, input: Record<string, unknown>): Promise<{ id: string }>`
  - `updateAddress(addressId: string, input: Record<string, unknown>): Promise<void>`
  - `deleteAddress(addressId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/customer-children.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { createCustomer } from "@/server/customers";
import { listAddresses, addAddress, updateAddress, deleteAddress } from "@/server/customer-addresses";
import { readAudit } from "@/server/audit";

async function customer() {
  return (await createCustomer({ code: "ACME", name: "Acme" })).id;
}

describe("customer addresses", () => {
  beforeEach(async () => await truncateAll());

  it("adds typed addresses and lists them by kind then name", async () => {
    const id = await customer();
    await addAddress(id, { kind: "BILL_TO", name: "Accounts Payable", street: "1 Mill Rd" });
    await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" });
    const rows = await listAddresses(id);
    expect(rows.map((a) => `${a.kind}:${a.name}`)).toEqual(["SHIP_TO:Dock 2", "BILL_TO:Accounts Payable"]);
  });

  it("makes the first address of a kind the default automatically", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" });
    expect((await listAddresses(id)).find((a) => a.id === first)?.isDefault).toBe(true);
  });

  it("promoting a new default demotes the previous one of that kind only", async () => {
    const id = await customer();
    const { id: ship1 } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" });
    const { id: bill } = await addAddress(id, { kind: "BILL_TO", name: "AP" });
    const { id: ship2 } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 2", isDefault: true });
    const rows = await listAddresses(id);
    const by = (x: string) => rows.find((a) => a.id === x)!;
    expect(by(ship2).isDefault).toBe(true);
    expect(by(ship1).isDefault).toBe(false);
    expect(by(bill).isDefault).toBe(true); // a different kind keeps its own default
  });

  it("rejects an unknown kind and an unknown field", async () => {
    const id = await customer();
    await expect(addAddress(id, { kind: "WAREHOUSE", name: "x" })).rejects.toThrow();
    await expect(addAddress(id, { kind: "SHIP_TO", name: "x", bogus: 1 })).rejects.toThrow();
  });

  it("404s when the customer does not exist", async () => {
    await expect(addAddress("nope", { kind: "SHIP_TO", name: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("soft deletes and audits as its own entity", async () => {
    const id = await customer();
    const { id: addr } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" });
    await updateAddress(addr, { city: "Toledo" });
    await deleteAddress(addr);
    expect(await listAddresses(id)).toHaveLength(0);
    expect(await prisma.customerAddress.findUnique({ where: { id: addr } })).not.toBeNull();
    const entries = await readAudit("customerAddress", addr);
    expect(entries.map((e) => e.action)).toEqual(["delete", "update", "create"]);
  });

  it("promotes a remaining address when the default is deleted", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" });
    const { id: second } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" });
    await deleteAddress(first);
    expect((await listAddresses(id)).find((a) => a.id === second)?.isDefault).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/customer-children.test.ts`
Expected: FAIL — `Cannot find module '@/server/customer-addresses'`.

- [ ] **Step 3: Add the schema and migrate both databases**

```prisma
enum AddressKind {
  SHIP_TO
  BILL_TO
  RECEIVED_FROM
}

model CustomerAddress {
  id         String      @id @default(cuid())
  customerId String
  customer   Customer    @relation(fields: [customerId], references: [id], onDelete: Cascade)
  kind       AddressKind
  name       String      @default("")
  street     String      @default("")
  city       String      @default("")
  state      String      @default("")
  zip        String      @default("")
  isDefault  Boolean     @default(false)
  active     Boolean     @default(true)
  deletedAt  DateTime?
  createdAt  DateTime    @default(now())
  updatedAt  DateTime    @updatedAt
  @@index([customerId, kind])
}
```

```bash
npx prisma migrate dev --name customer_addresses
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

- [ ] **Step 4: Write the service**

```ts
// erp/src/server/customer-addresses.ts
import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { ADDRESS_KINDS, type AddressKind } from "../lib/customer-constants";

export type AddressRow = {
  id: string; kind: AddressKind; name: string; street: string;
  city: string; state: string; zip: string; isDefault: boolean; active: boolean;
};

const FIELDS = {
  kind: z.enum(ADDRESS_KINDS),
  name: z.string().max(200).optional(),
  street: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  zip: z.string().max(20).optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
};
const ADD = z.object(FIELDS).strict();
const EDIT = z.object(FIELDS).partial().strict();

// Kind order drives display: ship-to first because it is what order entry reaches for.
const KIND_ORDER: Record<AddressKind, number> = { SHIP_TO: 0, BILL_TO: 1, RECEIVED_FROM: 2 };

export async function listAddresses(
  customerId: string, opts?: { includeInactive?: boolean },
): Promise<AddressRow[]> {
  const rows = await prisma.customerAddress.findMany({
    where: { customerId, deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { name: "asc" },
  });
  return rows
    .map((r) => ({
      id: r.id, kind: r.kind as AddressKind, name: r.name, street: r.street,
      city: r.city, state: r.state, zip: r.zip, isDefault: r.isDefault, active: r.active,
    }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

/**
 * Clears the default flag across a kind. Always called BEFORE the write that sets the new
 * default, never after: demoting afterwards leaves a window where two addresses of one kind are
 * both default, and whichever read lands in that window sees the wrong one. Demoting first leaves
 * a window with none, which no code path treats as meaningful.
 */
async function demoteAll(customerId: string, kind: AddressKind) {
  await prisma.customerAddress.updateMany({
    where: { customerId, kind, deletedAt: null, isDefault: true },
    data: { isDefault: false },
  });
}

export async function addAddress(customerId: string, input: Record<string, unknown>): Promise<{ id: string }> {
  const data = ADD.parse(input);
  const owner = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null } });
  if (!owner) throw new HttpError(404, "Customer not found");

  // The first address of a kind is the default whether or not the caller said so — a kind with
  // addresses but no default would leave order entry with nothing to pick.
  const existing = await prisma.customerAddress.count({
    where: { customerId, kind: data.kind, deletedAt: null },
  });
  const isDefault = data.isDefault ?? existing === 0;

  if (isDefault) await demoteAll(customerId, data.kind);
  const row = await auditedCreate("customerAddress", { ...data, customerId, isDefault }, () =>
    withDbErrors({ entity: "Address" }, () =>
      prisma.customerAddress.create({ data: { ...data, customerId, isDefault } })));
  return { id: row.id };
}

export async function updateAddress(addressId: string, input: Record<string, unknown>): Promise<void> {
  const data = EDIT.parse(input);
  const current = await prisma.customerAddress.findFirst({ where: { id: addressId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Address not found");
  // Demote before promoting, for the reason on demoteAll — never leave two defaults visible.
  if (data.isDefault === true) {
    await demoteAll(current.customerId, (data.kind ?? current.kind) as AddressKind);
  }
  await withDbErrors({ entity: "Address" }, () =>
    auditedUpdate("customerAddress", addressId, () =>
      prisma.customerAddress.update({ where: { id: addressId }, data })));
}

export async function deleteAddress(addressId: string): Promise<void> {
  const current = await prisma.customerAddress.findFirst({ where: { id: addressId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Address not found");
  await withDbErrors({ entity: "Address" }, () => auditedSoftDelete("customerAddress", addressId));

  // Deleting the default would leave that kind with addresses but none marked — promote the
  // next one so order entry always has something to reach for.
  if (current.isDefault) {
    const next = await prisma.customerAddress.findFirst({
      where: { customerId: current.customerId, kind: current.kind, deletedAt: null, active: true },
      orderBy: { name: "asc" },
    });
    if (next) {
      await auditedUpdate("customerAddress", next.id, () =>
        prisma.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } }));
    }
  }
}
```

- [ ] **Step 5: Extend the audit union**

In `src/server/audit.ts`: add `| "customerAddress"` to `AuditableModel` and `customerAddress: undefined,` to `SNAPSHOT_INCLUDE`.

- [ ] **Step 6: Add the routes**

```ts
// erp/src/app/api/customers/[id]/addresses/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listAddresses, addAddress } from "@/server/customer-addresses";

export const GET = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listAddresses((await params).id, { includeInactive }));
});

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  return NextResponse.json(await addAddress((await params).id, await req.json()));
});
```

```ts
// erp/src/app/api/customers/[id]/addresses/[addressId]/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateAddress, deleteAddress } from "@/server/customer-addresses";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  await updateAddress((await params).addressId, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  await deleteAddress((await params).addressId);
  return NextResponse.json({ ok: true });
});
```

Adding or removing an address is editing the customer, so both gate on `customers.edit` rather than `create`/`delete` — those verbs belong to the customer record itself.

- [ ] **Step 7: Run the tests, then all four gates, then commit**

```bash
npx vitest run tests/customer-children.test.ts
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add prisma src/server/customer-addresses.ts src/server/audit.ts src/app/api/customers tests/customer-children.test.ts
git commit -m "feat: typed customer addresses with one default per kind

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq"
```

---

## Task 6: Contacts

**Files:**
- Modify: `prisma/schema.prisma`, `src/server/audit.ts`, `tests/customer-children.test.ts`
- Create: `src/server/customer-contacts.ts`, `src/app/api/customers/[id]/contacts/route.ts`, `src/app/api/customers/[id]/contacts/[contactId]/route.ts`

**Interfaces:**
- Consumes: Task 3's service; `CONTACT_FLAGS` from `@/lib/customer-constants`.
- Produces, from `@/server/customer-contacts`:
  - `type ContactRow = { id: string; name: string; email: string; phone: string; getsShippers: boolean; getsInvoices: boolean; getsStatements: boolean; getsCerts: boolean; active: boolean }`
  - `listContacts(customerId: string, opts?: { includeInactive?: boolean }): Promise<ContactRow[]>`
  - `addContact(customerId: string, input: Record<string, unknown>): Promise<{ id: string }>`
  - `updateContact(contactId: string, input: Record<string, unknown>): Promise<void>`
  - `deleteContact(contactId: string): Promise<void>`

- [ ] **Step 1: Append the failing test**

Append to `erp/tests/customer-children.test.ts`:

```ts
import { listContacts, addContact, updateContact, deleteContact } from "@/server/customer-contacts";

describe("customer contacts", () => {
  beforeEach(async () => await truncateAll());

  it("adds contacts with per-document flags, defaulting them off", async () => {
    const id = await customer();
    await addContact(id, { name: "Dana Reed", email: "dana@acme.test", getsInvoices: true });
    const [c] = await listContacts(id);
    expect(c).toMatchObject({
      name: "Dana Reed", email: "dana@acme.test",
      getsInvoices: true, getsShippers: false, getsStatements: false, getsCerts: false,
    });
  });

  it("requires a name and rejects a malformed email", async () => {
    const id = await customer();
    await expect(addContact(id, { email: "x@y.test" })).rejects.toThrow();
    await expect(addContact(id, { name: "X", email: "not-an-email" })).rejects.toThrow();
  });

  it("accepts a blank email — phone-only contacts are normal", async () => {
    const id = await customer();
    await addContact(id, { name: "Shop Phone", phone: "555-0100" });
    expect((await listContacts(id))[0].email).toBe("");
  });

  it("rejects an unknown field", async () => {
    const id = await customer();
    await expect(addContact(id, { name: "X", bogus: 1 })).rejects.toThrow();
  });

  it("404s when the customer does not exist", async () => {
    await expect(addContact("nope", { name: "X" })).rejects.toMatchObject({ status: 404 });
  });

  it("soft deletes and audits as its own entity", async () => {
    const id = await customer();
    const { id: contact } = await addContact(id, { name: "Dana" });
    await updateContact(contact, { getsCerts: true });
    await deleteContact(contact);
    expect(await listContacts(id)).toHaveLength(0);
    expect(await prisma.customerContact.findUnique({ where: { id: contact } })).not.toBeNull();
    expect((await readAudit("customerContact", contact)).map((e) => e.action))
      .toEqual(["delete", "update", "create"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/customer-children.test.ts -t "customer contacts"`
Expected: FAIL — `Cannot find module '@/server/customer-contacts'`.

- [ ] **Step 3: Add the schema and migrate both databases**

```prisma
model CustomerContact {
  id             String    @id @default(cuid())
  customerId     String
  customer       Customer  @relation(fields: [customerId], references: [id], onDelete: Cascade)
  name           String
  email          String    @default("")
  phone          String    @default("")
  getsShippers   Boolean   @default(false)
  getsInvoices   Boolean   @default(false)
  getsStatements Boolean   @default(false)
  getsCerts      Boolean   @default(false)
  active         Boolean   @default(true)
  deletedAt      DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  @@index([customerId])
}
```

```bash
npx prisma migrate dev --name customer_contacts
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

- [ ] **Step 4: Write the service**

```ts
// erp/src/server/customer-contacts.ts
import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";

export type ContactRow = {
  id: string; name: string; email: string; phone: string;
  getsShippers: boolean; getsInvoices: boolean; getsStatements: boolean; getsCerts: boolean;
  active: boolean;
};

// Blank is allowed — plenty of shop contacts are phone-only — but anything present must be a
// real address, since Phases 4-5 email documents to these and a typo fails silently at send time.
const email = z.union([z.literal(""), z.string().email().max(200)]).optional();

const FIELDS = {
  name: z.string().min(1).max(200),
  email,
  phone: z.string().max(50).optional(),
  getsShippers: z.boolean().optional(),
  getsInvoices: z.boolean().optional(),
  getsStatements: z.boolean().optional(),
  getsCerts: z.boolean().optional(),
  active: z.boolean().optional(),
};
const ADD = z.object(FIELDS).strict();
const EDIT = z.object(FIELDS).partial().strict();

export async function listContacts(
  customerId: string, opts?: { includeInactive?: boolean },
): Promise<ContactRow[]> {
  const rows = await prisma.customerContact.findMany({
    where: { customerId, deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone,
    getsShippers: r.getsShippers, getsInvoices: r.getsInvoices,
    getsStatements: r.getsStatements, getsCerts: r.getsCerts, active: r.active,
  }));
}

export async function addContact(customerId: string, input: Record<string, unknown>): Promise<{ id: string }> {
  const data = ADD.parse(input);
  const owner = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null } });
  if (!owner) throw new HttpError(404, "Customer not found");
  const row = await auditedCreate("customerContact", { ...data, customerId }, () =>
    withDbErrors({ entity: "Contact" }, () =>
      prisma.customerContact.create({ data: { ...data, customerId } })));
  return { id: row.id };
}

export async function updateContact(contactId: string, input: Record<string, unknown>): Promise<void> {
  const data = EDIT.parse(input);
  const current = await prisma.customerContact.findFirst({ where: { id: contactId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Contact not found");
  await withDbErrors({ entity: "Contact" }, () =>
    auditedUpdate("customerContact", contactId, () =>
      prisma.customerContact.update({ where: { id: contactId }, data })));
}

export async function deleteContact(contactId: string): Promise<void> {
  const current = await prisma.customerContact.findFirst({ where: { id: contactId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Contact not found");
  await withDbErrors({ entity: "Contact" }, () => auditedSoftDelete("customerContact", contactId));
}
```

- [ ] **Step 5: Extend the audit union**

In `src/server/audit.ts`: add `| "customerContact"` to `AuditableModel` and `customerContact: undefined,` to `SNAPSHOT_INCLUDE`.

- [ ] **Step 6: Add the routes**

```ts
// erp/src/app/api/customers/[id]/contacts/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listContacts, addContact } from "@/server/customer-contacts";

export const GET = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listContacts((await params).id, { includeInactive }));
});

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  return NextResponse.json(await addContact((await params).id, await req.json()));
});
```

```ts
// erp/src/app/api/customers/[id]/contacts/[contactId]/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateContact, deleteContact } from "@/server/customer-contacts";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  await updateContact((await params).contactId, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  await deleteContact((await params).contactId);
  return NextResponse.json({ ok: true });
});
```

- [ ] **Step 7: Run the tests, then all four gates, then commit**

```bash
npx vitest run tests/customer-children.test.ts
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add prisma src/server/customer-contacts.ts src/server/audit.ts src/app/api/customers tests/customer-children.test.ts
git commit -m "feat: customer contacts with per-document-type flags

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq"
```

---

## Task 7: Customer export and paste

Built before the pages so the list screen can wire a working export link and paste panel rather than a dead one — Phase 2A shipped a dead export link for two tasks and it caused confusion.

**Files:**
- Create: `src/app/api/customers/export/route.ts`, `src/app/api/customers/paste/route.ts`, `tests/customer-paste.test.ts`
- Modify: `src/server/customers.ts` (add `pasteCustomers`)

**Interfaces:**
- Consumes: `parseRecords`, `isBlankRecord`, `overflowError` from `@/server/tsv`; `toXlsx` from `@/server/excel`; `readableMessage` from `@/server/error-message`; `CUSTOMER_PASTE_COLUMNS`.
- Produces: `pasteCustomers(text: string): Promise<PasteResult>` from `@/server/customers`, where `PasteResult` is the existing type exported by `@/server/paste`.

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/customer-paste.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { createCustomer, listCustomers, pasteCustomers } from "@/server/customers";
import { GET as exportRoute } from "@/app/api/customers/export/route";
import { POST as pasteRoute } from "@/app/api/customers/paste/route";

const noParams = { params: Promise.resolve({}) };

describe("customer paste", () => {
  beforeEach(async () => await truncateAll());

  it("creates every valid row and reports failures by 1-based line", async () => {
    await createCustomer({ code: "ACME", name: "Acme" });
    const result = await pasteCustomers("ACME\tDup Co\nBETA\tBeta Castings\n\n\tNo code");
    expect(result.created).toBe(1);
    expect(result.errors.map((e) => e.row)).toEqual([1, 4]);
    expect(result.errors[0].message).toMatch(/already exists/i);
    expect((await listCustomers()).map((c) => c.code)).toEqual(["ACME", "BETA"]);
  });

  it("handles Excel quoting the same way reference paste does", async () => {
    const r = await pasteCustomers('ACME\t"Acme ""Heat Treat"" Inc"\t\t"line one\nline two"');
    expect(r.errors).toEqual([]);
    const [c] = await listCustomers();
    expect(c.name).toBe('Acme "Heat Treat" Inc');
    expect(c.orderNotes).toBe("line one\nline two");
  });

  it("tolerates a trailing tab but rejects genuine extra columns", async () => {
    expect((await pasteCustomers("ACME\tAcme\t\t\t")).errors).toEqual([]);
    await truncateAll();
    const r = await pasteCustomers("BETA\tBeta\t\t\tEXTRA");
    expect(r.created).toBe(0);
    expect(r.errors[0].message).toMatch(/Too many columns/);
  });

  it("exports a real workbook whose header matches the paste columns", async () => {
    const cookie = await signInWith(["customers.view"]);
    await createCustomer({ code: "ACME", name: "Acme Foundry" });
    const res = await exportRoute(new Request("http://t/api/customers/export", { headers: { cookie } }), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/Customers\.xlsx/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Customers")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "Code", "Name", "Default PO", "Order notes", "Active"]);
    expect(sheet.getRow(2).values?.[1]).toBe("ACME");
  });

  it("401s and 403s on both routes", async () => {
    expect((await exportRoute(new Request("http://t/api/customers/export"), noParams)).status).toBe(401);
    const viewer = await signInWith(["customers.view"]);
    const denied = await pasteRoute(new Request("http://t/api/customers/paste", {
      method: "POST", headers: { cookie: viewer, "content-type": "application/json" },
      body: JSON.stringify({ text: "ACME\tAcme" }),
    }), noParams);
    expect(denied.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/customer-paste.test.ts`
Expected: FAIL — `pasteCustomers` is not exported and the routes do not exist.

- [ ] **Step 3: Add pasteCustomers to the service**

Append to `src/server/customers.ts`:

```ts
import { parseRecords, isBlankRecord, overflowError } from "./tsv";
import { readableMessage } from "./error-message";
import { CUSTOMER_PASTE_COLUMNS } from "../lib/customer-constants";
import type { PasteResult } from "./paste";

/**
 * Creates every valid row and collects failures per row rather than aborting the batch — a
 * single typo on line 40 must not discard the 39 rows above it. Row numbers are the 1-based
 * line in the pasted text, counting blank lines (the user's spreadsheet still counts them) and
 * reporting a record that spans several physical lines at the line it starts on.
 */
export async function pasteCustomers(text: string): Promise<PasteResult> {
  const columns = [...CUSTOMER_PASTE_COLUMNS];
  const { records, error } = parseRecords(text);
  const errors: PasteResult["errors"] = [];
  let created = 0;

  for (const record of records) {
    if (isBlankRecord(record.fields)) continue;
    const overflow = overflowError(record.fields, columns);
    if (overflow) { errors.push({ row: record.startLine, message: overflow }); continue; }
    const row = Object.fromEntries(columns.map((c, i) => [c, record.fields[i] ?? ""]));
    // Drop empty optional cells so zod's .optional() applies instead of receiving "".
    const input = Object.fromEntries(
      Object.entries(row).filter(([k, v]) => k === "code" || k === "name" || v !== ""));
    try {
      await createCustomer(input);
      created++;
    } catch (err) {
      errors.push({ row: record.startLine, message: readableMessage(err) });
    }
  }
  if (error) errors.push({ row: error.line, message: error.message });
  return { created, errors };
}
```

- [ ] **Step 4: Add the export route**

```ts
// erp/src/app/api/customers/export/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listCustomers } from "@/server/customers";
import { toXlsx } from "@/server/excel";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "customers", "view");
  const url = new URL(req.url);
  const rows = await listCustomers({
    includeInactive: url.searchParams.get("includeInactive") === "1",
    search: url.searchParams.get("search") ?? undefined,
  });
  const columns = [
    { key: "code", header: "Code" },
    { key: "name", header: "Name" },
    { key: "defaultPo", header: "Default PO" },
    { key: "orderNotes", header: "Order notes" },
    { key: "active", header: "Active" },
  ];
  const buf = await toXlsx("Customers", columns, rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Customers.xlsx"',
    },
  });
});
```

- [ ] **Step 5: Add the paste route**

```ts
// erp/src/app/api/customers/paste/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { pasteCustomers } from "@/server/customers";

export const POST = handle(async (req) => {
  mustCan(requireUser(), "customers", "create");
  const { text } = z.object({ text: z.string().min(1).max(200_000) }).parse(await req.json());
  return NextResponse.json(await pasteCustomers(text));
});
```

- [ ] **Step 6: Run the tests, then all four gates, then commit**

```bash
npx vitest run tests/customer-paste.test.ts
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/server/customers.ts src/app/api/customers tests/customer-paste.test.ts
git commit -m "feat: customer Excel export and spreadsheet paste

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq"
```

---

## Task 8: Customer list and detail pages

**Files:**
- Create: `src/app/customers/page.tsx`, `src/app/customers/[id]/page.tsx`
- Modify: `src/components/PasteGrid.tsx` (generalise beyond reference kinds)

**Interfaces:**
- Consumes: the routes from Tasks 4-7; `ADDRESS_KINDS`, `ADDRESS_KIND_LABELS`, `CONTACT_FLAGS`, `CUSTOMER_PASTE_COLUMNS` from `@/lib/customer-constants`; `api` from `@/lib/fetcher`; `HistoryPanel` from `@/components/HistoryPanel`.
- Produces: `/customers` and `/customers/[id]`. **No `src/server/**` imports** — these are client components.

- [ ] **Step 1: Generalise PasteGrid**

`src/components/PasteGrid.tsx` currently takes `kind: ReferenceKind` and derives its endpoint and column hint from the reference constants. Change its props to accept them directly so customers can reuse it:

```tsx
export function PasteGrid(
  { endpoint, columns, onDone }: { endpoint: string; columns: string[]; onDone: () => void },
) {
```

Inside, replace the `REFERENCE_LABELS`/`REFERENCE_EXTRA_FIELDS` derivation with the `columns` prop, and POST to `endpoint` instead of the reference path. Then update its one existing caller in `src/components/ReferenceTable.tsx`:

```tsx
{pasting && (
  <PasteGrid
    endpoint={`/api/admin/reference/${kind}/paste`}
    columns={[REFERENCE_LABELS[kind].nameLabel, ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.label)]}
    onDone={load}
  />
)}
```

- [ ] **Step 2: Write the list page**

```tsx
// erp/src/app/customers/page.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { PasteGrid } from "@/components/PasteGrid";
import { CUSTOMER_PASTE_COLUMNS } from "@/lib/customer-constants";

type Customer = {
  id: string; code: string; name: string; parentCode: string | null;
  creditHold: boolean; active: boolean;
};

export default function CustomersPage() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [draft, setDraft] = useState({ code: "", name: "" });
  const [error, setError] = useState<string | null>(null);

  const query = `${showInactive ? "includeInactive=1&" : ""}${search ? `search=${encodeURIComponent(search)}` : ""}`;

  const load = useCallback(async () => {
    setRows(await api<Customer[]>(`/api/customers${query ? `?${query}` : ""}`));
  }, [query]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function add() {
    try {
      await api("/api/customers", { method: "POST", body: JSON.stringify(draft) });
      setDraft({ code: "", name: "" }); setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Customers</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      <div className="mb-3 flex items-center gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Search code or name" className="w-64 rounded border px-2 py-1 text-sm" />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <a href={`/api/customers/export${query ? `?${query}` : ""}`} className="text-sm text-blue-700 underline">
          Export to Excel
        </a>
        <button onClick={() => setPasting((p) => !p)} className="text-sm text-blue-700 underline">
          {pasting ? "Hide paste entry" : "Paste from spreadsheet"}
        </button>
      </div>

      <table className="w-full rounded border bg-white text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">Code</th><th className="p-2">Name</th>
            <th className="p-2">Parent</th><th className="p-2">Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-t">
              <td className="p-2 font-mono">
                <Link href={`/customers/${c.id}`} className="text-blue-700 underline">{c.code}</Link>
              </td>
              <td className="p-2">
                {c.name}
                {c.creditHold && (
                  <span className="ml-2 rounded bg-red-100 px-1 text-xs text-red-800">credit hold</span>
                )}
              </td>
              <td className="p-2 font-mono text-slate-500">{c.parentCode ?? ""}</td>
              <td className="p-2">{c.active ? "yes" : "no"}</td>
            </tr>
          ))}
          <tr className="border-t bg-slate-50">
            <td className="p-2">
              <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                     placeholder="Code" className="w-full rounded border px-2 py-1" />
            </td>
            <td className="p-2" colSpan={2}>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                     placeholder="Name" className="w-full rounded border px-2 py-1" />
            </td>
            <td className="p-2 text-right">
              <button onClick={add} className="rounded bg-slate-800 px-3 py-1 text-white">Add</button>
            </td>
          </tr>
        </tbody>
      </table>

      {pasting && (
        <PasteGrid endpoint="/api/customers/paste" columns={[...CUSTOMER_PASTE_COLUMNS]} onDone={load} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write the detail page**

```tsx
// erp/src/app/customers/[id]/page.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/fetcher";
import { HistoryPanel } from "@/components/HistoryPanel";
import { ADDRESS_KINDS, ADDRESS_KIND_LABELS, CONTACT_FLAGS, type AddressKind } from "@/lib/customer-constants";

type Customer = {
  id: string; code: string; name: string; parentId: string | null; parentCode: string | null;
  creditLimit: number | null; creditHold: boolean; cod: boolean; taxable: boolean;
  defaultPo: string; orderNotes: string; shippingNotes: string; invoiceNotes: string; active: boolean;
};
type Address = {
  id: string; kind: AddressKind; name: string; street: string;
  city: string; state: string; zip: string; isDefault: boolean;
};
type Contact = {
  id: string; name: string; email: string; phone: string;
  getsShippers: boolean; getsInvoices: boolean; getsStatements: boolean; getsCerts: boolean;
};

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [addrDraft, setAddrDraft] = useState<{ kind: AddressKind; name: string }>({ kind: "SHIP_TO", name: "" });
  const [contactDraft, setContactDraft] = useState({ name: "", email: "" });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [cust, addr, cont] = await Promise.all([
      api<Customer>(`/api/customers/${id}`),
      api<Address[]>(`/api/customers/${id}/addresses`),
      api<Contact[]>(`/api/customers/${id}/contacts`),
    ]);
    setC(cust); setAddresses(addr); setContacts(cont);
  }, [id]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function save(body: object) {
    try {
      await api(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function call(path: string, init: RequestInit) {
    try { await api(path, init); setError(null); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  if (!c) return <div className="p-6">{error ?? "Loading…"}</div>;

  return (
    <div className="p-6">
      <h1 className="mb-1 text-2xl font-semibold">
        <span className="font-mono">{c.code}</span> — {c.name}
      </h1>
      {c.parentCode && <p className="mb-3 text-sm text-slate-500">Division of {c.parentCode}</p>}
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Commercial</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.creditHold} onChange={(e) => save({ creditHold: e.target.checked })} />
            Credit hold
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.taxable} onChange={(e) => save({ taxable: e.target.checked })} />
            Taxable
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.cod} onChange={(e) => save({ cod: e.target.checked })} />
            COD
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.active} onChange={(e) => save({ active: e.target.checked })} />
            Active
          </label>
        </div>
        <label className="mt-3 block text-sm">
          Default PO
          <input defaultValue={c.defaultPo} onBlur={(e) => save({ defaultPo: e.target.value })}
                 className="ml-2 rounded border px-2 py-1" />
        </label>
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Standing notes</h2>
        {([["orderNotes", "At order entry"], ["shippingNotes", "At shipping"], ["invoiceNotes", "At invoicing"]] as const)
          .map(([key, label]) => (
            <label key={key} className="mb-2 block text-sm">
              {label}
              <textarea defaultValue={c[key]} rows={2} onBlur={(e) => save({ [key]: e.target.value })}
                        className="mt-1 w-full rounded border p-2" />
            </label>
          ))}
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Addresses</h2>
        <table className="mb-2 w-full text-sm">
          <tbody>
            {addresses.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="py-1">{ADDRESS_KIND_LABELS[a.kind]}</td>
                <td>{a.name}</td>
                <td className="text-slate-500">{[a.street, a.city, a.state, a.zip].filter(Boolean).join(", ")}</td>
                <td>{a.isDefault && <span className="rounded bg-slate-200 px-1 text-xs">default</span>}</td>
                <td className="text-right">
                  {!a.isDefault && (
                    <button className="mr-3 text-xs text-slate-600"
                            onClick={() => call(`/api/customers/${id}/addresses/${a.id}`,
                              { method: "PUT", body: JSON.stringify({ isDefault: true }) })}>
                      make default
                    </button>
                  )}
                  <button className="text-xs text-red-600"
                          onClick={() => call(`/api/customers/${id}/addresses/${a.id}`, { method: "DELETE" })}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-1">
          <select value={addrDraft.kind} className="rounded border px-2 py-1 text-sm"
                  onChange={(e) => setAddrDraft({ ...addrDraft, kind: e.target.value as AddressKind })}>
            {ADDRESS_KINDS.map((k) => <option key={k} value={k}>{ADDRESS_KIND_LABELS[k]}</option>)}
          </select>
          <input value={addrDraft.name} placeholder="Name" className="flex-1 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setAddrDraft({ ...addrDraft, name: e.target.value })} />
          <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
                  onClick={() => { void call(`/api/customers/${id}/addresses`,
                    { method: "POST", body: JSON.stringify(addrDraft) }); setAddrDraft({ kind: "SHIP_TO", name: "" }); }}>
            Add address
          </button>
        </div>
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Contacts</h2>
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left">
              <th>Name</th><th>Email</th><th>Phone</th>
              {CONTACT_FLAGS.map((f) => <th key={f.key} className="px-1">{f.label}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {contacts.map((ct) => (
              <tr key={ct.id} className="border-t">
                <td className="py-1">{ct.name}</td><td>{ct.email}</td><td>{ct.phone}</td>
                {CONTACT_FLAGS.map((f) => (
                  <td key={f.key} className="px-1 text-center">
                    <input type="checkbox" checked={ct[f.key]}
                           onChange={(e) => call(`/api/customers/${id}/contacts/${ct.id}`,
                             { method: "PUT", body: JSON.stringify({ [f.key]: e.target.checked }) })} />
                  </td>
                ))}
                <td className="text-right">
                  <button className="text-xs text-red-600"
                          onClick={() => call(`/api/customers/${id}/contacts/${ct.id}`, { method: "DELETE" })}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-1">
          <input value={contactDraft.name} placeholder="Name" className="flex-1 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setContactDraft({ ...contactDraft, name: e.target.value })} />
          <input value={contactDraft.email} placeholder="Email" className="flex-1 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setContactDraft({ ...contactDraft, email: e.target.value })} />
          <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
                  onClick={() => { void call(`/api/customers/${id}/contacts`,
                    { method: "POST", body: JSON.stringify(contactDraft) }); setContactDraft({ name: "", email: "" }); }}>
            Add contact
          </button>
        </div>
      </section>

      <HistoryPanel entity="customer" entityId={c.id} />
    </div>
  );
}
```

- [ ] **Step 4: Verify by hand**

```bash
npm run dev
```
Sign in as admin/admin. At `/customers`: add `ACME` / `Acme Foundry`, search for it, open it. On the detail page: tick Credit hold and confirm the red badge appears back on the list; add a Ship-to address and confirm it is marked default; add a second and use "make default"; add a contact and tick Invoices; check the history panel shows the create and the edits. Back on the list, use "Paste from spreadsheet" with three tab-separated rows including one duplicate code, and confirm the good rows import while the duplicate is reported by row number. Then click Export to Excel and open the file.

Report exactly what you saw. Stop the dev server and remove the rows you created.

- [ ] **Step 5: Run all four gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/app/customers src/components/PasteGrid.tsx src/components/ReferenceTable.tsx
git commit -m "feat: customer list and detail pages with addresses, contacts, export and paste

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq"
```

---

## Task 9: Phase 2B close-out

**Files:**
- Modify: `tests/permissions-sweep.test.ts`, `erp/README.md`, `docs/HANDOFF.md`

- [ ] **Step 1: Extend the sweep with the invariant Phase 2A's final review flagged as missing**

That review noted the sweeps do not assert that *services* route mutations through the audit helpers — a service calling `prisma.customer.update` directly would pass everything. Phase 2B is the first phase to add services outside the generic reference one, so close it now.

Append to `tests/permissions-sweep.test.ts`:

**Two exact details, both verified against the current tree — get them wrong and this check is either broken or vacuous:**

- The audit-call pattern must accept **any** `audit*` helper, not just `audited(Create|Update|SoftDelete)`. `settings.ts` mutates via `prisma.setting.upsert` and audits through `auditSettingChange()` (added in Phase 2A when the direct-write exception was retired). A narrower regex flags it as a false positive.
- `sessions.ts` is a **genuine** exception: it calls `prisma.session.update` for sliding expiry, which is not a business mutation and correctly writes no audit row. It is the only such file.

```ts
  it("no service mutates Prisma outside an audit helper", () => {
    // Services call prisma.<model>.create/update INSIDE an audited* callback, so requiring an
    // audit* call somewhere in the same file is the cheap structural proxy. Pattern must match
    // auditSettingChange too — settings.ts upserts and audits through that helper, not audited*.
    const EXCEPT = new Set([
      "audit.ts",    // owns the helpers; legitimately writes audit rows itself
      "db.ts",       // the client
      "sessions.ts", // sliding session expiry is not a business mutation and writes no audit row
    ]);
    const offenders = readdirSync(join(process.cwd(), "src/server"))
      .filter((f) => f.endsWith(".ts") && !EXCEPT.has(f))
      .filter((f) => {
        const s = readFileSync(join(process.cwd(), "src/server", f), "utf8");
        const mutates = /prisma\.[a-zA-Z]+\.(create|update|upsert|delete)(Many)?\s*\(/.test(s);
        const audits = /\baudit(ed)?[A-Z][A-Za-z]*\s*\(/.test(s);
        return mutates && !audits;
      });
    expect(offenders).toEqual([]);
  });
```

- [ ] **Step 2: Prove the new check fails when violated**

First confirm it passes on the unmodified tree. Then temporarily add an unaudited mutation to a file that is NOT in the exception list — `src/server/customers.ts` is the right target since it is what this phase added:

```ts
export async function scratch() { await prisma.customer.update({ where: { id: "x" }, data: {} }); }
```

That alone will not trip it (the file already calls `auditedCreate`), which is the honest limit of a file-level proxy. To see a real failure, put the mutation in a file with no audit call at all — create a throwaway `src/server/scratch-probe.ts` containing only that function plus its `prisma` import.

```bash
npx vitest run tests/permissions-sweep.test.ts
```
Expected: FAIL, naming `scratch-probe.ts`. Delete the file and confirm `git status` is clean. **Report the failure output you saw, and state plainly in your report that this check is file-level rather than call-level** — a service that mixes audited and unaudited mutations in one file passes. That is a known limit worth recording rather than overselling, and it is exactly the kind of overstatement a Phase 2A review caught in the `requireUser` sweep.

- [ ] **Step 3: Update the README**

Add under Development:

```markdown
### Customers
Customers → list, search, and open a customer. Each carries a unique code, an optional parent
(for divisions billed together), credit terms, typed addresses (ship-to / bill-to / received-from,
one default per kind), and contacts flagged for which documents they receive. The list exports to
Excel and accepts spreadsheet paste (columns: code, name, default PO, order notes).
```

- [ ] **Step 4: Update the handoff**

In `docs/HANDOFF.md` §4, append:

```markdown
**Phase 2B (customers) is complete.** Customers carry an owner-assigned unique `code` alongside the
name (Visual Shop's customer-id habit), an optional parent for divisions that bill together, the
Phase 5 commercial fields (credit limit/hold, COD, taxable, terms, surcharge opt-out, finance-charge
override), three standing note blocks, typed addresses with one default per kind, and contacts with
per-document flags. The unused `Salesperson` reference table was removed. The Excel-quote-aware TSV
parser moved to `src/server/tsv.ts` so customer paste reuses it rather than reimplementing it.
```

In §6, remove the "any model with `@unique` + soft delete needs revival-on-create" line's "write the rule down before 2B" framing — it is now written into the kickoff brief §2.6 and applied to `Customer.code`. Leave the rule itself.

- [ ] **Step 5: Run all four gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add tests/permissions-sweep.test.ts README.md ../docs/HANDOFF.md
git commit -m "test: sweep for unaudited service mutations; docs: Phase 2B close-out

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xsv751PMfZABbubkSn6syq"
```

---

## Self-Review

**Spec coverage.** Spec §5.1 Customer — name, typed addresses, contacts with emails, terms, taxable, credit limit + hold, COD, default PO, standing notes, surcharge opt-out, finance-charge override, active: Tasks 3, 5, 6. Amended `code` and parent/child (spec §15 Phase 2B amendments): Task 3. Kickoff §2.1: Tasks 3, 5, 6. Kickoff §2.5 Excel export and quick-entry grids: Task 7, wired in Task 8. `HistoryPanel` on detail: Task 8. Salesperson removal (spec §15 amendment): Task 1. **Deliberately out of scope**, carried to 2C/2D: parts, specs link, per-part Process Steps, templates. Per-customer document template variants are Phase 7.

**Deviation from the kickoff's ordering, with reason.** The brief lists customer schema then routes then pages, with export and paste as later per-entity wiring. Export and paste are built here *before* the pages (Task 7 before Task 8) so the list screen wires a working export link and paste panel on first render — Phase 2A shipped a dead export link that lived two tasks and caused avoidable confusion in review.

**Carried in from Phase 2A's final review.** The missing "services route mutations through audit helpers" sweep is Task 9 Step 1, since 2B is the first phase adding services outside the generic reference one. The raw-cuid reference columns are **not** in this plan — the owner ruled them deferred, and they belong with the same name-resolution mechanism parts will need in 2C.

**Type consistency.** `CustomerRow` is defined once in Task 3 and consumed by Tasks 4, 7, 8. `AddressKind` comes from `@/lib/customer-constants` and is used by the service (Task 5), the routes, and the page (Task 8). `PasteResult` is the existing type from `@/server/paste`, reused by `pasteCustomers` rather than redefined. `parseRecords`/`isBlankRecord`/`overflowError` are defined once in Task 2 and consumed by both `paste.ts` and `customers.ts`. `PasteGrid`'s props change in Task 8 Step 1, and its only existing caller is updated in the same step.

**Known risk flagged for the implementer.** Prisma returns `Decimal` for `creditLimit` and `financeChargeRate`, which does not serialize to JSON as a number. Task 3's service converts at the boundary via `num()` and a test asserts `creditLimit` comes back as `25000`, not an object — if that test is removed, the UI and Excel will silently show `[object Object]`.
