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

