### Task 16: Traveler — pdfmake pipeline, stored documents, print UI  ⚠ SAMPLES GATE

**PRECONDITION (spec §3.9/§10): the owner said samples-first.** `docs/samples/2025-aht-orderform-mockup.pdf` fixes the structure; **before starting, check `docs/samples/` for any additional real-document scans and ASK THE OWNER: (a) whether the samples are complete enough to build against, and (b) the two §3.9 mapping calls — the inspection sample-quantity column and the inspection-location image.** Do not guess; do not silently proceed on the mockup alone.

**Files:**
- Modify: `package.json` (add `pdfmake` ^0.2.x, `bwip-js` ^4.x — runtime `dependencies`; npm 12 will skip their install scripts if any — expected)
- Create: `src/server/pdf/render.ts` (pdfmake plumbing), `src/server/traveler.ts` (doc-definition builder + print/list/get), `src/app/api/orders/[id]/traveler/route.ts` (POST `?load=N` optional), `src/app/api/orders/[id]/documents/route.ts` (GET), `src/app/api/documents/[docId]/route.ts` (GET bytes)
- Modify: `src/app/orders/[id]/page.tsx` (print buttons + documents list live), `src/app/orders/new/page.tsx` (enable Save & Print)
- Test: `tests/traveler.test.ts`

**Interfaces (Produces):**
```ts
// pdf/render.ts
export async function renderPdf(def: TDocumentDefinitions): Promise<Buffer>;   // wraps pdfmake; smoke-tested for %PDF header
export async function barcodePng(text: string): Promise<Buffer>;               // bwip-js code128, returns PNG for data-URI embedding
// traveler.ts
export function buildTravelerDefinition(input: TravelerData): TDocumentDefinitions; // PURE — data in, JSON doc-definition out (the template-as-data contract, §10)
export async function printTraveler(orderId: string, loadNumber?: number): Promise<{ documentId: string; pdf: Buffer }>;
export async function listDocuments(orderId: string): Promise<{ id: string; kind: string; loadNumber: number | null; createdAt: Date }[]>;
export async function getDocument(docId: string): Promise<{ id: string; orderId: string; kind: string; loadNumber: number | null; createdAt: Date; fileData: Buffer }>;
// TravelerData: the builder's input, assembled by printTraveler from OrderDetail + the locked
// revision (via getRevision) + the lead part's inspections/material + company settings + the
// barcode PNG — implementer defines the exact type; buildTravelerDefinition stays pure.
```
`printTraveler`: 404 missing order; **400 "Cannot print a traveler for a voided order"**; renders one sheet-set per load (all loads when `loadNumber` omitted, that load only otherwise — each sheet's header carries `Order # / Load N / barcode(orderNumber)`), `auditedCreate("storedDocument", …)` with the bytes, returns them. Reprint = `getDocument` streaming stored bytes untouched. pdfmake wiring: try the vfs build (`pdfmake/build/pdfmake` + `vfs_fonts`) under Node first; if `getBuffer` misbehaves server-side, fall back to `new PdfPrinter(...)` with the vfs font data — **the smoke test is the gate, not hope.**

- [ ] **Step 0: THE GATE — samples + the two §3.9 answers from the owner.**
- [ ] **Step 1: Failing tests**: `%PDF` smoke; `buildTravelerDefinition` is pure and mirrors the mockup section order (assert on the definition's content tree: header carries order number + load number; steps section lists the LOCKED revision's steps with values — build a part, lock via an order, then CHANGE the working revision and assert the definition still shows the locked values; inspection rows present; footer blocks present); per-load render carries that load's qty; voided-order 400; stored-bytes-identical reprint (`Buffer.compare === 0`); documents list ordered newest-first; route 401/403 (`orders.view`).
- [ ] **Steps 2–4: FAIL → implement (npm install first) → PASS + all four gates.**
- [ ] **Step 5: Wire the hub + entry Save & Print; manual smoke: print the mockup-shaped sibling order, open the PDF, eyeball against `docs/samples/`.**
- [ ] **Step 6: Commit** — `feat: traveler PDFs — per-load sheets, stored exact reprints, barcode`

