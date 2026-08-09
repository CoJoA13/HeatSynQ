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

