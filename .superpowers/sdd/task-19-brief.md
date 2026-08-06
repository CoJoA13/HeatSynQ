### Task 19: BOL and certification layouts

**Files:**
- Create: `src/server/pdf/bol.ts`, `src/server/pdf/cert.ts`
- Modify: `src/server/shippers.ts`, `src/server/certs.ts`, the print routes
- Test: `tests/bol.test.ts`, `tests/cert-pdf.test.ts`

**Interfaces:**
- Produces:
```ts
export function buildBolDefinition(input: BolData): TDocumentDefinitions;
export async function printBol(shipperId: string): Promise<{ documentId: string; bolNumber: number; pdf: Buffer }>;
export function buildCertDefinition(input: CertPdfData): TDocumentDefinitions;
export async function printCert(certId: string, signerUserId: string): Promise<{ documentId: string; pdf: Buffer }>;
```

- [ ] **Step 1: Read `docs/samples/Bill of Lading Sample.pdf` and `Certification Sample.pdf`** and build to §10.2 and §10.3.
- [ ] **Step 2: Write the failing BOL tests:**

```ts
it("allocates the BOL number on first print and reuses it on reprint", async () => {
  const { shipper } = await twoOrderShipment();
  const a = await printBol(shipper.id);
  const b = await printBol(shipper.id);
  expect(b.bolNumber).toBe(a.bolNumber);
  expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBe(a.bolNumber);
});

it("does not allocate a BOL number for a shipment that never prints one", async () => {
  const { shipper } = await oneOrderShipment();
  await printShippingTickets(shipper.id);
  expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBeNull();
});

it("lists every order number on the shipment", async () => {
  const { shipper, orderA, orderB } = await twoOrderShipment();
  const { pdf } = await printBol(shipper.id);
  const text = pdf.toString("latin1");
  expect(text).toContain(String(orderA.orderNumber));
  expect(text).toContain(String(orderB.orderNumber));
});
```

- [ ] **Step 3: Write the failing cert tests:**

```ts
it("prints readings but never min, max, scale or pass/fail", async () => {
  const { cert, user } = await certWithReadings({ min: 28, max: 32, readings: [30.0, 25.6] });
  const { pdf } = await printCert(cert.id, user.id);
  const text = pdf.toString("latin1");
  expect(text).toContain("30.0");
  expect(text).toContain("25.6");
  expect(text).not.toMatch(/\bPass\b|\bFail\b/);
  expect(text).not.toContain("Min");            // §3.21 — the sample carries no requirements table
});

it("never prints internal notes", async () => {
  const { cert, user } = await certWithReadings({ internalNotes: "SECRET-INTERNAL-STRING" });
  const { pdf } = await printCert(cert.id, user.id);
  expect(pdf.toString("latin1")).not.toContain("SECRET-INTERNAL-STRING");
});

it("falls back to the display name when the signer has no signature on file", async () => {
  const { cert, user } = await certWithReadings({ signature: null });
  const { pdf } = await printCert(cert.id, user.id);
  expect(pdf.toString("latin1")).toContain(user.displayName);
});

it("sets printedAt on the first print only", async () => {
  const { cert, user } = await certWithReadings({});
  await printCert(cert.id, user.id);
  const first = (await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt;
  await printCert(cert.id, user.id);
  expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toEqual(first);
});
```

- [ ] **Step 4: Run to verify failure.**
- [ ] **Step 5: Implement both.** `printBol` allocates `bol_number_next` **only when `bolNumber` is null**, inside the claim-holding transaction. `printCert` embeds the *printing* user's `signatureImage` (§3.11), pulls `cert_statement` from settings, and renders each requirement as the sample does: a line naming the specification and scale, then a bare wrapping grid of that requirement's reading values.
- [ ] **Step 6: Wire the print routes** — `?doc=bol` on the shipment print route; `POST /api/certs/[id]/print`; and the **cert-with-shipment checkbox** (§3.14): the shipment print action accepts `cert=1` and prints each covered order's cert alongside, storing each as its own document.
- [ ] **Step 7: Run the tests** — PASS. Open both rendered PDFs beside their samples and compare block by block.
- [ ] **Step 8: Gates + commit** — `feat(pdf): bill of lading and certification layouts`

---
