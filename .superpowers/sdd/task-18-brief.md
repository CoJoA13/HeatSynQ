### Task 18: Shipping ticket layout and its print mechanics

**Files:**
- Create: `src/server/pdf/shipping-ticket.ts`, `src/app/api/shippers/[id]/print/route.ts`
- Modify: `src/server/shippers.ts` (print entry point)
- Test: `tests/shipping-ticket.test.ts`

**Interfaces:**
- Consumes: `storeDocument`, `assertPrintable` (Tasks 3, 10); `claimOrdersInOrder` (Task 7); `shippedTotals` (Task 7).
- Produces:
```ts
export type TicketCompany = { name: string; address: string; phone: string; liabilityText: string };
export type TicketParty = { code: string; name: string; street: string; city: string; state: string; zip: string };
export type TicketLine = { qty: number; partNumber: string; partName: string; partDescription: string; pounds: number };
export type TicketContainer = { typeName: string; count: number; customerContainerId: string };
export type TicketData = {
  company: TicketCompany;
  soldTo: TicketParty;                 // the customer's default BILL_TO
  shipTo: TicketParty;                 // the shipment's ship-to address
  orderLabel: string;                  // "72036-3"
  orderNumber: number;
  shipDate: string;                    // "yyyy-mm-dd"
  poNumber: string;
  packingListNo: number;               // Shipper.shipperNumber
  customerJobNo: string;
  route: string;
  carrierName: string;
  lines: TicketLine[];
  containers: TicketContainer[];
  serials: { serial: string; description: string }[];   // only printOnShipper rows
  shippedComplete: boolean;
  totalQty: number;
  totalWeight: number;
};
export function buildShippingTicketDefinition(input: TicketData[]): TDocumentDefinitions;  // one sheet per order
export async function printShippingTickets(shipperId: string, orderId?: string):
  Promise<{ documentId: string; shipperNumber: number; pdf: Buffer }>;
```

- [ ] **Step 1: Read `docs/samples/Shipping Ticket Sample.pdf`** and build to it — §10.1 lists every block. It is the contract; do not invent fields.
- [ ] **Step 2: Write the failing tests:**

```ts
it("renders one sheet per order on the shipment", async () => {
  const { shipper } = await twoOrderShipment();
  const { pdf } = await printShippingTickets(shipper.id);
  expect(pdf.toString("latin1")).toContain("/Count 2");     // uncompressed page marker, P3's rule
});

it("renders one sheet when a single order is named", async () => {
  const { shipper, orderA } = await twoOrderShipment();
  const { pdf } = await printShippingTickets(shipper.id, orderA.id);
  expect(pdf.toString("latin1")).toContain("/Count 1");
});

it("reprints stored bytes exactly", async () => {
  const { shipper } = await oneOrderShipment();
  const first = await printShippingTickets(shipper.id);
  const stored = await getDocument(first.documentId);
  expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED vs original: exact
});

it("refuses to print a voided shipment but keeps the stored one readable", async () => {
  const { shipper } = await oneOrderShipment();
  const printed = await printShippingTickets(shipper.id);
  await voidShipper(shipper.id, "wrong truck");
  await expect(printShippingTickets(shipper.id)).rejects.toThrow(/voided/i);
  expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
});
```

**Never `Buffer.compare` two fresh renders** — `renderPdf` is not byte-deterministic (Global Constraints).
- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement.** `buildShippingTicketDefinition` is plain JSON on the existing `LAYOUT` constants in `src/server/pdf/render.ts`. `printShippingTickets` mirrors `printTraveler` exactly: read settings **outside** the transaction, then Serializable `$transaction` → `claimOrdersInOrder` → read on `tx` (never the top-level client — that was a pool-starvation bug in P3) → `renderPdf` → `storeDocument(tx, { kind: "SHIPPER", shipperId, orderId: orderId ?? null }, pdf)`.
- [ ] **Step 5: Wire the route** — `POST /api/shippers/[id]/print?doc=ticket&order=<id>` gated `shipping.view`, streaming the PDF with `contentDisposition`.
- [ ] **Step 6: Run the tests** — PASS. Open a rendered PDF beside the sample and compare block by block.
- [ ] **Step 7: Gates + commit** — `feat(pdf): shipping ticket, one sheet per order on the shipment`

---
