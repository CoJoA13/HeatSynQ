### Task 4: `part-prices.ts` — price rows and their breaks

**Files:**
- Create: `src/server/part-prices.ts`, `src/app/api/parts/[id]/prices/route.ts`, `src/app/api/parts/[id]/prices/[priceId]/route.ts`, `src/app/api/parts/[id]/prices/[priceId]/breaks/route.ts`, `src/app/api/parts/[id]/prices/[priceId]/breaks/[breakId]/route.ts`
- Test: `tests/part-prices.test.ts`

> **Task 2 already deleted the old surface** (`part-price-breaks.ts`, its tests, its two routes, `PRICING_FIELDS` and the parts-route guards). This task only builds the replacement. If any of those still exist when you start, Task 2 is incomplete — say so rather than working around it.

**Interfaces:**
- Consumes: `decimalField(precision, scale, opts)` (`src/server/decimal-field.ts`), `assertRefExists`, `auditedCreate` / `auditedUpdate` / `auditedSoftDelete`, `PRICE_PER` (`src/lib/part-constants.ts`).
- Produces:
```ts
// src/server/part-prices.ts
export type PartBreakRow = { id: string; threshold: number; price: number };
export type PartPriceRow = {
  id: string;
  processStepCodeId: string;
  stepCode: string;            // ProcessStepCode.code
  stepName: string;            // ProcessStepCode.name
  glAccountId: string | null;  // through the step code — this is what gives revenue a GL account
  glAccountName: string;       // the account number as text, "" when the step code has none
  position: number;
  setupCharge: number | null;
  unitPrice: number | null;
  minimumCharge: number | null;
  pricePer: PricePerValue;
  breaks: PartBreakRow[];
};
export async function listPartPrices(partId: string): Promise<PartPriceRow[]>;
export async function addPartPrice(partId: string, input: Record<string, unknown>): Promise<{ id: string }>;
export async function updatePartPrice(partId: string, priceId: string, input: Record<string, unknown>): Promise<void>;
export async function deletePartPrice(partId: string, priceId: string): Promise<void>;
export async function addPriceBreak(partId: string, priceId: string, input: Record<string, unknown>): Promise<{ id: string }>;
export async function updatePriceBreak(partId: string, priceId: string, breakId: string, input: Record<string, unknown>): Promise<void>;
export async function deletePriceBreak(partId: string, priceId: string, breakId: string): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** `tests/part-prices.test.ts` — copy the fixture and `asSystem` helper from `tests/part-price-breaks.test.ts:1-22` verbatim (it is being deleted; its harness is the idiom), then:

```ts
it("adds two priced operations and lists them in position order", async () => {
  const { partId, austemper, straighten } = await fixture();
  await asSystem(() => addPartPrice(partId, {
    processStepCodeId: straighten.id, position: 2, unitPrice: "1.0000", pricePer: "EACH" }));
  await asSystem(() => addPartPrice(partId, {
    processStepCodeId: austemper.id, position: 1, unitPrice: "6.5100",
    minimumCharge: "600.00", pricePer: "EACH" }));
  const rows = await listPartPrices(partId);
  expect(rows.map((r) => r.stepCode)).toEqual(["AUST", "STRT"]);
  expect(rows[0].unitPrice).toBe(6.51);
  expect(rows[0].minimumCharge).toBe(600);
});

it("refuses a second live price row for the same operation", async () => {
  const { partId, austemper } = await fixture();
  await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  await expect(asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 2 })))
    .rejects.toThrow("That operation is already priced on this part");
});

it("re-prices an operation after its row is deleted (partial unique)", async () => {
  const { partId, austemper } = await fixture();
  const { id: first } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  await asSystem(() => deletePartPrice(partId, first));
  const { id: second } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  expect(second).not.toBe(first);
});

it("refuses a break on a LOT-priced row, and refuses LOT while breaks exist", async () => {
  const { partId, austemper, straighten } = await fixture();
  const { id: lotId } = await asSystem(() => addPartPrice(partId, {
    processStepCodeId: austemper.id, position: 1, pricePer: "LOT", unitPrice: "500.0000" }));
  await expect(asSystem(() => addPriceBreak(partId, lotId, { threshold: 500, price: "0.95" })))
    .rejects.toThrow("A LOT-priced operation cannot carry price breaks");

  const { id: eachId } = await asSystem(() => addPartPrice(partId, {
    processStepCodeId: straighten.id, position: 2, pricePer: "EACH", unitPrice: "1.0000" }));
  await asSystem(() => addPriceBreak(partId, eachId, { threshold: 500, price: "0.95" }));
  await expect(asSystem(() => updatePartPrice(partId, eachId, { pricePer: "LOT" })))
    .rejects.toThrow("A LOT-priced operation cannot carry price breaks");
});

it("refuses a soft-deleted step code", async () => {
  const { partId, austemper } = await fixture();
  await prisma.processStepCode.update({ where: { id: austemper.id }, data: { deletedAt: new Date() } });
  await expect(asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 })))
    .rejects.toThrow("That process step code does not exist");
});

it("scopes every mutator to its part and its price row", async () => {
  const { partId, otherPartId, austemper } = await fixture();
  const { id } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  await expect(asSystem(() => updatePartPrice(otherPartId, id, { position: 2 })))
    .rejects.toThrow("Price row not found");
  await expect(asSystem(() => deletePartPrice(otherPartId, id)))
    .rejects.toThrow("Price row not found");
});

// Task 2 changed `deletePart` to cascade-soft-delete PartPrice rows (parts.ts) and left it
// untested. It is load-bearing: `partPrice` reuses PART_VIA_CHILD in the FK registry, so if the
// cascade were ever dropped, a deleted part's live price rows would block a step-code delete
// forever behind a blocker naming a part nobody can see. Add this to `tests/parts.test.ts`'s
// existing "delete requires a reason and cascades children" case rather than a new one.
it("soft-deletes a part's price rows when the part is deleted", async () => {
  const { partId, austemper } = await fixture();
  const { id } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  await asSystem(() => deletePart(partId, "keyed against the wrong customer"));
  const row = await prisma.partPrice.findUniqueOrThrow({ where: { id } });
  expect(row.deletedAt).not.toBeNull();
  // Its breaks are deliberately left alone — they hang off a dead row under a dead part and no
  // live read can reach them (deletePartPrice follows the same rule).
});

it("audits a price row create/update/delete with a real diff", async () => {
  const { partId, austemper } = await fixture();
  const { id } = await asSystem(() => addPartPrice(partId, {
    processStepCodeId: austemper.id, position: 1, unitPrice: "6.5100" }));
  await asSystem(() => updatePartPrice(partId, id, { unitPrice: "7.0000" }));
  await asSystem(() => deletePartPrice(partId, id));
  const entries = await prisma.auditLog.findMany({
    where: { entity: "partPrice", entityId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] });
  expect(entries.map((e) => e.action)).toEqual(["create", "update", "delete"]);
  const before = entries[1].before as { unitPrice: string };
  const after = entries[1].after as { unitPrice: string };
  expect(Number(before.unitPrice)).toBe(6.51);
  expect(Number(after.unitPrice)).toBe(7);
});
```

  The `fixture()` helper extends the deleted file's: after creating the part, also
  `const austemper = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper" } });`
  and the same for `{ code: "STRT", name: "Straighten" }`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/part-prices.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/part-prices.ts`**, following `part-price-breaks.ts`'s idiom exactly — `FIELDS` object → `ADD`/`EDIT` strict schemas → `withDbErrors` → `$transaction` → `audited*` with `{ tx }` → a private `claimLive` doing a scoped `updateMany` that 404s on `count === 0`:

```ts
import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { PRICE_PER, type PricePerValue } from "../lib/part-constants";

export type PartBreakRow = { id: string; threshold: number; price: number };
export type PartPriceRow = {
  id: string; processStepCodeId: string; stepCode: string; stepName: string; position: number;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; breaks: PartBreakRow[];
};

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on PartPrice.
const PRICE_FIELDS = {
  processStepCodeId: z.string().min(1),
  position: z.number().int().min(0),
  setupCharge: decimalField(12, 2, { min: "nonnegative" }),
  unitPrice: decimalField(12, 4, { min: "nonnegative" }),
  minimumCharge: decimalField(12, 2, { min: "nonnegative" }),
  pricePer: z.enum(PRICE_PER).optional(),
};
const ADD_PRICE = z.object(PRICE_FIELDS).strict();
const EDIT_PRICE = z.object(PRICE_FIELDS).partial().strict();

const BREAK_FIELDS = {
  threshold: decimalField(12, 2, { required: true, min: "positive" }),
  price: decimalField(12, 4, { required: true, min: "nonnegative" }),
};
const ADD_BREAK = z.object(BREAK_FIELDS).strict();
const EDIT_BREAK = z.object(BREAK_FIELDS).partial().strict();

const LOT_WITH_BREAKS = "A LOT-priced operation cannot carry price breaks";

export async function listPartPrices(partId: string): Promise<PartPriceRow[]> {
  const rows = await prisma.partPrice.findMany({
    where: { partId, deletedAt: null },
    include: {
      processStepCode: {
        select: { code: true, name: true, glAccountId: true, glAccount: { select: { name: true } } },
      },
      breaks: { where: { deletedAt: null }, orderBy: { threshold: "asc" } },
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id, processStepCodeId: r.processStepCodeId,
    stepCode: r.processStepCode.code, stepName: r.processStepCode.name,
    // The GL account rides along on the read so `createInvoice` never has to re-walk step codes
    // to find the account a revenue line posts to (5A §3.4's whole reason for this restructure).
    glAccountId: r.processStepCode.glAccountId,
    glAccountName: r.processStepCode.glAccount?.name ?? "",
    position: r.position,
    setupCharge: r.setupCharge?.toNumber() ?? null,
    unitPrice: r.unitPrice?.toNumber() ?? null,
    minimumCharge: r.minimumCharge?.toNumber() ?? null,
    pricePer: r.pricePer,
    breaks: r.breaks.map((b) => ({ id: b.id, threshold: b.threshold.toNumber(), price: b.price.toNumber() })),
  }));
}
```

  Then the six mutators. The rules each must enforce, with the exact messages the tests above assert:
  - `addPartPrice` — part must be live (404 `"Part not found"`); `assertRefExists("processStepCode", …, tx)`; a live row for that `(partId, processStepCodeId)` refuses 400 `"That operation is already priced on this part"` via `findFirst({ where: { partId, processStepCodeId, deletedAt: null } })` (**never `findUnique`** — the column pair is unique only among live rows). Serializable, because it assigns a registered FK.
  - `updatePartPrice` — `claimLive(tx, priceId, partId, patch)`; when the patch sets `pricePer: "LOT"`, first count live breaks and refuse 400 `LOT_WITH_BREAKS` if any; re-check the duplicate-operation rule when `processStepCodeId` changes. Serializable whenever it assigns the FK **or** touches `pricePer` — the latter is the write-skew partner of `addPriceBreak`'s LOT read, exactly as `addPartBreak`/`updatePart` were paired before.
  - `deletePartPrice` — `auditedSoftDelete("partPrice", priceId, undefined, tx)` after confirming the row is live and scoped to the part. **Its breaks are left as they are**: the row is gone from every live read, and soft-deleting children individually would write audit noise for rows nothing can reach.
  - `addPriceBreak` / `updatePriceBreak` / `deletePriceBreak` — the deleted file's bodies with `partId` swapped for `partPriceId`, plus a scoping read that the price row is live **and** belongs to `partId` (404 `"Price row not found"`), and the `pricePer === "LOT"` refusal reading the price row rather than the part.

- [ ] **Step 4: Run the tests** — `npx vitest run tests/part-prices.test.ts`. Expected: PASS.

- [ ] **Step 5: The four routes.** Copy `src/app/api/parts/[id]/breaks/route.ts` and its `[breakId]` sibling, re-pathed and re-scoped. **Every one keeps `mustDo(user, "change_prices")` unconditionally** — pricing is gated by that named action, not by `parts.edit` alone. Params for the nested ones: `{ params: Promise.resolve({ id, priceId, breakId }) }`.

- [ ] **Step 6: Confirm Task 2's deletions held** — `src/server/part-price-breaks.ts`, its tests, its two routes, `PRICING_FIELDS` and the two parts-route guards are all gone, and `npx tsc --noEmit` is clean with only the new surface in place.

- [ ] **Step 7: Confirm the sweeps** — `npx vitest run tests/reference-links-sweep.test.ts tests/partial-unique-sweep.test.ts tests/permissions-sweep.test.ts`. All green.

- [ ] **Step 8: Gates + commit** — `feat(parts): price rows keyed by process step code, replacing the part's price columns`

---

