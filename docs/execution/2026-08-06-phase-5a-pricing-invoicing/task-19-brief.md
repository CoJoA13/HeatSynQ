### Task 19: `pdf/invoice.ts` — the layout, print and archive

> **Carried in from Task 12's review (2026-08-07). `printInvoice` MUST claim the invoice row
> `FOR UPDATE` before inserting the `StoredDocument`.** Task 12's `discardInvoice` refuses to
> discard a *printed* invoice by reading `storedDocument` under its invoice-row claim — but that
> invariant lives on the `StoredDocument` rows, not on the claimed `Invoice` row, so the two sides
> only serialize if the print path takes the **same** invoice-row claim before it archives. This is
> the Phase 4 print-vs-void lesson exactly (whole-branch review found print-vs-void completely
> unprotected because one side rested on an SSI accident): claim the invoice row, THEN insert the
> StoredDocument, inside one transaction. Serializable isolation alone is not the guarantee. Without
> this, a discard and a first-print can interleave — the discard reads "not printed" while the
> print commits, and you get a discarded invoice with an archived PDF that reprints forever.

**Files:**
- Create: `src/server/pdf/invoice.ts`, `src/app/api/invoices/[id]/print/route.ts`
- Modify: `src/server/invoices.ts` (`printInvoice`), `src/server/documents.ts` (`AREA_FOR_KIND`, `DocumentOwner`, `ownerColumns`, `listDocumentsForOrder`, `documentFilename`, `resolveDocumentFilename`), `src/app/orders/[id]/…` (`KIND_LABELS`)
- Test: `tests/invoice-pdf.test.ts`

**Interfaces:**
- Consumes: `renderPdf` (`src/server/pdf/render.ts`), `LAYOUT`, `storeDocument` / `assertPrintable` (`src/server/documents.ts`), `claimOrder`.
- Produces:
```ts
// src/server/pdf/invoice.ts — PURE: plain data in, plain-JSON pdfmake definition out
export type InvoicePdfData = { /* company, remitTo, billTo, shipTo, documentNumber, invoiceDate,
   termsName, orderNumber, poNumber, materialName, processNames, parts[], priceRows[],
   subtotal, surchargeRows[], chargeRows[], certRow, freightRow, taxRow, total */ };
export function buildInvoiceDefinition(input: InvoicePdfData): TDocumentDefinitions;
// src/server/invoices.ts — the three-layer split every print in this codebase uses:
//   settings read → pure read-to-plain-data → pure build → bytes → archive
export async function invoicePrintSettings(): Promise<InvoicePrintSettings>;   // company + remit-to
export async function readInvoicePdfData(db: Db, invoiceId: string, settings?: InvoicePrintSettings): Promise<InvoicePdfData>;
export async function printInvoice(invoiceId: string): Promise<{ documentId: string; documentNumber: string; pdf: Buffer }>;
```

- [ ] **Step 1: Finish widening `documents.ts`.** **Task 2 already did the schema-shaped half** — widening `DocumentKind` made `Record<DocumentKind, Area>` a compile error until it was done, which is exactly the point of that type. Already in place, verified: `AREA_FOR_KIND` has `INVOICE: "invoicing"` / `CREDIT: "invoicing"`; `DocumentOwner` has both arms; so do `ownerColumns`, `DocumentMeta.invoiceId`, `documentFilename` and `resolveDocumentFilename`. **What is still owed here:**
  - `listDocumentsForOrder`'s `OR` gains `{ invoice: { orderId } }`, so an invoice appears on its order's hub (it currently has only the `orderId` / `cert` / `shipper` branches, `src/server/documents.ts:174`);
  - `KIND_LABELS` in `src/app/orders/[id]/DocumentsSection.tsx:18` — today it is `{ TRAVELER: "Traveler" }` alone, so every other kind renders as a raw enum name (the cosmetic gap HANDOFF §6 recorded). Make it exhaustive over all six kinds.
  - **Cover Task 2's untested filename arms.** `documentFilename`'s `INVOICE`/`CREDIT` cases (`src/server/documents.ts:255-258`) and `resolveDocumentFilename`'s new case (`:304-312`) are new production code with no test. `documentFilename` now takes **four optional positionals, three of them numbers** — a caller passing a credit number in the `shipperNumber` slot compiles silently. Add cases to the existing `describe("documentFilename")` block in `tests/documents.test.ts` asserting `invoice-72026.pdf` and `credit-1000.pdf`.
- [ ] **Step 2: Fill in `KIND_LABELS`** on the order hub's Documents list for every kind — the cosmetic gap HANDOFF §6 recorded (non-traveler kinds render as raw enum names today). Enumerate all six so the map is exhaustive.
- [ ] **Step 3: Write the failing tests** `tests/invoice-pdf.test.ts`, on `tests/cert-pdf.test.ts`'s shape:

```ts
/** The owner's own invoice as plain builder input — order 72026, one part, one priced
 *  operation, one surcharge. Every assertion below reads off THIS, so the golden numbers in
 *  tests/pricing.test.ts and the golden paper here describe the same document. */
function sampleData(): InvoicePdfData {
  return {
    company: { name: "American Heat Treating - Alabama, LLC",
               address: "3008 Red Morris Parkway, Anniston AL 36207", phone: "256-835-3370" },
    remitTo: { name: "American Heat Treating - Alabama, LLC",
               street: "3008 Red Morris Parkway", city: "Anniston", state: "AL", zip: "36207" },
    billTo: { name: "GFMCO - Columbus LLC", street: "PO Box 96, 600 12th Street",
              city: "Columbus", state: "GA", zip: "31902-0096" },
    shipTo: { name: "GFMCO - Columbus LLC", street: "PO Box 96, 600 12th Street",
              city: "Columbus", state: "GA", zip: "31902-0096" },
    documentNumber: "7 - 72026", invoiceDate: "2026-07-29", termsName: "Net 30",
    orderNumber: 72026, poNumber: "49499",
    materialName: "Ductile Iron", processNames: "Austemper",
    parts: [{ qty: 144, partNumber: "A16-21591-000", partName: "EQUALIZER-RR SUSP",
              partDescription: "", eachWeight: 21, totalWeight: 3024 }],
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51,
                  minimumCharge: 600, setupCharge: null, amount: 937.44 }],
    subtotal: 937.44,
    surchargeRows: [{ description: "EnergySur", amount: 37.5 }],
    chargeRows: [], certRow: null, freightRow: null, taxRow: null,
    total: 974.94,
  };
}

it("is a pure builder — the definition survives a JSON round trip", () => {
  const def = buildInvoiceDefinition(sampleData());
  expect(JSON.parse(JSON.stringify(def))).toEqual(def);
});

it("prints the sample's identity block, parts, price rows and totals", async () => {
  // CONTENT is pinned on the DEFINITION, never on rendered bytes — copy `allText` from
  // tests/cert-pdf.test.ts:25-35 along with its comment: pdfkit writes TTF-SUBSET GLYPH IDS, so a
  // rendered PDF carries no character text to grep for. The rendered file is pinned
  // STRUCTURALLY instead (below).
  const text = allText(buildInvoiceDefinition(sampleData())).join(" ");
  expect(text).toContain("Invoice");
  expect(text).toContain("American Heat Treating - Alabama, LLC");
  expect(text).toContain("7 - 72026");
  expect(text).toContain("Net 30");
  expect(text).toContain("Remit To");
  expect(text).toContain("GFMCO - Columbus LLC");
  expect(text).toContain("72026");                 // Our Order #
  expect(text).toContain("49499");                 // Your PO #
  expect(text).toContain("Ductile Iron");
  expect(text).toContain("Austemper");
  expect(text).toContain("A16-21591-000");
  expect(text).toContain("EQUALIZER-RR SUSP");
  expect(text).toContain("Price per Each");
  expect(text).toContain("6.51");
  expect(text).toContain("Minimum Charge");
  expect(text).toContain("600.00");
  expect(text).toContain("Sub Total Amount");
  expect(text).toContain("937.44");
  expect(text).toContain("EnergySur");
  expect(text).toContain("37.50");
  expect(text).toContain("Total Amount Due");
  expect(text).toContain("974.94");

  // Structural pins on the real file — the `%PDF-` header and the page count, exactly as
  // tests/traveler.test.ts:61 and tests/cert-pdf.test.ts:256 do it. Never `Buffer.compare` two
  // fresh renders (CLAUDE.md).
  const pdf = await renderPdf(buildInvoiceDefinition(sampleData()));
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(pageCount(pdf)).toBe(1);                  // copy `pageCount` from tests/traveler.test.ts:61
});

it("stores the print and reprints the identical bytes", async () => {
  const { invoice } = await finalizedFixture();
  const first = await printInvoice(invoice.id);
  const stored = await getDocument(first.documentId);
  expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED bytes — exact by design
});

it("refuses a new print on a discarded draft, and keeps old prints downloadable", async () => {
  const { invoice } = await draftFixture();
  const printed = await printInvoice(invoice.id);
  await asSystem(() => discardInvoice(invoice.id, "raised in error"))
    .catch(() => {});                                            // refused once printed — see Task 12
  await prisma.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
  await expect(printInvoice(invoice.id)).rejects.toThrow(/voided/i);
  await expect(getDocument(printed.documentId)).resolves.toBeTruthy();
});

it("prints a credit with its credit number and negative amounts", async () => {
  const { invoice } = await finalizedFixture();
  const credit = await asSystem(() => createCredit(invoice.id));
  const { documentNumber, documentId, pdf } = await printInvoice(credit.id);
  expect(documentNumber).toBe(String(credit.creditNumber));
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // The number and the negative amounts are pinned on the DEFINITION, for the glyph-id reason
  // above — build it from the same data the print used.
  const text = allText(buildInvoiceDefinition(await readInvoicePdfData(prisma, credit.id))).join(" ");
  expect(text).toContain(String(credit.creditNumber));
  expect(text).toContain("-937.44");
  const stored = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId } });
  expect(stored.kind).toBe("CREDIT");          // the kind follows the invoice row's own kind
  expect(stored.invoiceId).toBe(credit.id);
});
```

- [ ] **Step 4: Write `src/server/pdf/invoice.ts`** to `docs/samples/Invoice Sample.pdf`, on `pdf/cert.ts`'s structure — a header comment naming the sample as the contract and listing **every** deviation, then plain input types ("no Decimals, no Dates, no Prisma rows"), then pure locale-pinned formatters, then one `function xBlock(d): Content` per visual block, then the exported builder. Blocks: title + company, the identity column (`Invoice No.` / `Invoice Date` / `Terms` / `Page No.`), the `Remit To` box, `Billto` / `Shipto`, the order strip (`Our Order #`, `Your PO #`, `Material`, `Process`), the **PARTS** table (`Quantity` · `Part No. / Description` · `Each weight` · `Total Wt`), the **PRICE** block (one row per operation: its name left, its amount right, with `Price per <unit>:` and `Minimum Charge:` beneath), `Sub Total Amount`, one named row per surcharge/charge/cert/freight/tax, and `Total Amount Due`. **Two deviations to state in that header comment**: no "Page N of M" (a pure-JSON definition cannot carry a page-count function — the ticket's and the cert's identical deviation, owner ping #1), and `Process:` prints the lead part's priced operation names comma-joined, byte-identical to the sample whenever a part has one priced operation.
- [ ] **Step 5: Write `printInvoice`** using the identical bracket all four existing prints use (`certs.ts:673-707`): settings read **outside** the transaction → Serializable `$transaction` → `claimOrder` → claim the invoice row → re-read → `assertPrintable` → read-on-`tx` → `renderPdf` → `storeDocument(tx, { kind: invoice.kind === "CREDIT" ? "CREDIT" : "INVOICE", invoiceId }, pdf)`. **No clock inside the builder** — the print date is passed in as data, the traveler's purity rule.
- [ ] **Step 6: The print route** `POST /api/invoices/[id]/print` — `mustCan(requireUser(), "invoicing", "view")` (a print is a read of the document, the cert-print precedent), returning the PDF with the resolved filename.
- [ ] **Step 7: Run the tests, then gates + commit** — `feat: invoice and credit PDFs, stored byte-for-byte`

---

