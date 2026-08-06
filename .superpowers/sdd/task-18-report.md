# Task 18 report — Shipping ticket layout and print mechanics

**Status: complete.** Commit `4130260` (`feat(pdf): shipping ticket, one sheet per order on the shipment`) on `phase-4-certs-shipping`. All four gates green (1305/1305 vitest, tsc clean, eslint clean, build clean).

## Files

- **Created** `erp/src/server/pdf/shipping-ticket.ts` — `TicketData` types (brief's exact shape) + `buildShippingTicketDefinition(input: TicketData[])`, PURE plain-JSON (template-as-data, spec §10; purity asserted by `JSON.parse(JSON.stringify(def)) === def` in tests). One sheet per `TicketData`, `pageBreak: "before"` on every sheet but the first — the traveler's per-load mechanic reused per §3.20.
- **Created** `erp/src/app/api/shippers/[id]/print/route.ts` — `POST ?doc=ticket|bol&order=<id>&cert=1`, gated `shipping.view` (spec §9), streams the PDF with `content-disposition: inline; filename="ticket-<shipperNumber>[.-order-<orderNumber>].pdf"` (via the reviewed `documentFilename`) and `x-document-id` (the traveler route's shape).
- **Modified** `erp/src/server/shippers.ts` — Task 18 section: `ticketSettings()` (company_* + `shipper_liability_text`, read OUTSIDE the transaction — the `travelerSettings` / R4-finding-8 rule), `readShippingTicketData(db, shipperId, settings, orderId?)` (all reads on the caller's `db`; composes `readShipperDetail` + default BILL_TO via `listAddresses` + the ship-to row + one batched part-description read), `printShippingTickets(shipperId, orderId?)`.
- **Modified** `erp/src/app/shipping/[id]/ShipmentDetail.tsx` + `ShipmentOrderPanel.tsx` — ticket printing went LIVE (both paths: "Print all tickets", "Print this order's ticket"); BOL button and the cert checkbox stay disabled with titles naming Task 19 (§5.16 titles stay truthful — the stale "Tasks 18–19" wording updated).
- **Created** `erp/tests/shipping-ticket.test.ts` — 17 tests.

## Per-step account

- **Step 1 (sample read).** Read `docs/samples/Shipping Ticket Sample.pdf` with the Read tool before writing anything; every block below is built to it (comparison table further down).
- **Step 2–3 (RED).** Wrote all 17 tests first, including the brief's four verbatim (adapted only to the fixture names and `asSystem` context this codebase requires). `npx vitest run tests/shipping-ticket.test.ts` failed at collection ("Failed to resolve import `@/server/pdf/shipping-ticket`") — RED confirmed before any implementation existed.
- **Step 4 (implement).** Builder + collector + print entry, exactly the brief's shape: settings outside, then ONE Serializable `$transaction` → pre-claim stub read (only to learn which orders to claim — the `addOrderToShipper` precedent; `Shipper` has no row-lock instrument of its own) → `claimOrdersInOrder` → shipper RE-READ under the claim → `assertPrintable` → `readShippingTicketData(tx, …)` (every read on `tx`, never the top-level client — the P3 pool-starvation lesson) → `renderPdf` → `storeDocument(tx, { kind: "SHIPPER", shipperId, orderId: orderId ?? null }, pdf)`. Deliberately NOT `claimLiveShipper`: its 404-on-voided would misname a void; the voided case must be the shared 400 `VOIDED_PRINT`.
- **Step 5 (route).** As above; `doc` is required (`400 'doc must be "ticket" or "bol"'`), `order` passes through as the order id (matching `documentFilename`'s SHIPPER contract and the brief's `printShippingTickets(shipper.id, orderA.id)`).
- **Step 6 (GREEN + visual).** First run: 16/17 — the one failure was my own test's expectation using `order.lines[0].partNumber` where `OrderDetail` nests it as `order.lines[0].part.partNumber`; fixed the assertion (not the code), then 17/17. Rendered a sample-data ticket via a temporary scratch test (deleted before commit) to `/tmp/ticket-visual.pdf` and READ it side-by-side against the sample (both render visually through the Read tool).
- **Step 7 (gates + commit).** Below.

## Layout vs. sample, block by block

Matches (structure, ordering, emphasis):

- Header: company name + big bold "Shipping Ticket" left; `Order No.: 72036-3` + `Ship Date: 7/29/2026` (m/d/yyyy, the sample's own style) center.
- Sold To / Ship To boxed side-by-side; Sold To corner carries the customer code; name bold, street, then city/state/zip spread along the box bottom.
- Field strip: full-grid boxed `Purchase Order Number | Packing List No | Customer Job No | Route | Carrier`; packing list zero-padded to six digits (`072826`) exactly as the sample prints it.
- Parts table: `Quantity | Part No. / Part Name / Part Description | Pounds`; the part cell stacks the three lines exactly as the sample does; horizontal rules only on body rows.
- Container table in the sample's two side-by-side column groups (`Container Type | # Of Containers | Cust Cont Id` ×2), container list folded left-half/right-half.
- Liability standing block (`shipper_liability_text`, default transcribed verbatim in Task-earlier settings.ts including the sample's own "HEAT TREAT" misprint) in fine print, closed by the heavy rule.
- `Shipped Complete` centered bold (only when every line on the ticket is `lineComplete`; suppressed otherwise — tested), then right-set `Quantity Shipped` / `Pounds Shipped`.
- Footer tear-off pinned to the page bottom via `absolutePosition` (plain JSON): heavy rule, bare `Order No.: 72036` (no sequence — the sample's own tear-off), `Shipped Complete`, boxed totals at 2 decimals (`192.00` / `4,128.00`), `Received By: ___ Date: ___`, `Sold To: <name>` + `Shipped ON: 07/29/2026` (zero-padded, as printed).

Deliberate deviations (none silent — each commented in the builder):

1. **No logo top-right** — the owner supplied none; Phase 7 owns logo upload (the traveler's ruled precedent). The company address/phone settings block stands in where the logo sits.
2. **No `Page 1 of 1`** — a page count is only knowable to pdfmake header/footer CALLBACKS, which a plain-JSON template cannot carry; a hard-coded "1 of 1" would lie the moment a ticket wraps. Omitted rather than fabricated.
3. **Sample's "Temper Only" annotation** — no field behind it in this model and spec §10.1 does not list it; not printed (brief Step 1: "do not invent fields").
4. **Ship To corner code prints empty** — the sample's "73753" is Visual Shop's internal address row id; `CustomerAddress` has no short code and a cuid is not paper. Sold To's corner (the customer code) prints per spec.
5. **No signature block** — checked against §3.11 and the sample deliberately: the printing-user's-signature ruling attaches to the *certification* (the sample cert shows the shape; spec §10.3 lists the signature block; §10.1 lists none, and the ticket sample carries only the hand-completed `Received By` strip). The ticket therefore prints no signature; Task 19's cert does.
6. Cosmetic: body pounds print `4,128` (no trailing period; the sample's `4,128.` is a Visual Shop formatting quirk); totals print `192` / `4,128.00` body and `192.00` / `4,128.00` tear-off, mirroring the sample's own inconsistency in the direction it leans.

Address semantics decided (spec §10.1 wording → this schema): Sold To = customer code + customer name over the default live `BILL_TO` (default flag first, else first — the traveler's RECEIVED_FROM idiom); Ship To = the shipment's `shipToAddressId` row read UNFILTERED on deletedAt/active (the paper must name where the truck went — the traveler's deliberately-unfiltered parts precedent), its `name` as the destination name (that is how a third-party consignee is expressed, spec §3 closing note), falling back to the customer name when blank/absent.

## The `?cert=1` decision (and `doc=bol`)

**Both are refused with a 400 naming Task 19; nothing is archived.** `cert=1` means "also print the certification" pre-ticked (§3.14) — honoring the ticket half while silently dropping the cert half would tell the person at the printer their quality paperwork went out when it did not, so the whole request is refused with "Printing the certification alongside is not available yet — it lands with the certification layout (Task 19). Print the ticket without it for now." `doc=bol` likewise (it would also otherwise need the lazy `bolNumber` allocation Task 19 owns). A test pins that the refusal archived zero documents. The UI cannot hit either path: the cert checkbox and BOL button are disabled with tooltips naming Task 19.

## Print/reprint semantics evidence

- **One sheet per order / one order alone:** `/Count 2` for a two-order shipment's whole-set print, `/Count 1` for a named order (the uncompressed page marker — never `Buffer.compare` between fresh renders).
- **Stored bytes exact:** `Buffer.compare(stored.fileData, first.pdf) === 0` (STORED vs original — the sanctioned exact comparison). The reprint path itself is the untouched, already-reviewed `GET /api/documents/[docId]` streaming `getDocument`'s bytes.
- **Voided refusal + permanence:** after `voidShipper`, a new print rejects with `/voided/i` AND the exact shared `VOIDED_PRINT` message (service test + route test asserting the 400 body), while the earlier stored document stays readable (`fileData.length > 0`). `listDocumentsForShipper`/`getDocument` never filter on `deletedAt` (pre-existing, Task 3).
- **Owner columns:** whole-set print stores `{kind: SHIPPER, shipperId, orderId: null}`; single-order stores `orderId` set — asserted on `getDocument` rows, plus `listDocumentsForShipper` returning both.
- **Audited create, metadata only:** the `storedDocument` audit entry exists, carries `SHIPPER` + the shipperId, and contains no `fileData` key.
- **Reads never mutate:** print is an explicit POST gated `shipping.view`; its only write is the audited `StoredDocument` create (spec §9's reasoning, restated in the route comment).
- **Content-Disposition:** `ticket-<shipperNumber>.pdf` / `ticket-<shipperNumber>-order-<orderNumber>.pdf` asserted exactly — the Task 3-reviewed `documentFilename` naming, not a new scheme.

## RED/GREEN

- RED: `npx vitest run tests/shipping-ticket.test.ts` → `Test Files 1 failed | Tests no tests` — "Failed to resolve import \"@/server/pdf/shipping-ticket\"" (module did not exist).
- After implementation: `16 passed | 1 failed` — the failure was the test's own nested-part expectation (`order.lines[0].partNumber` → should be `order.lines[0].part.partNumber`); assertion fixed.
- GREEN: `Test Files 1 passed (1) · Tests 17 passed (17) · Duration 2.85s`.

## Gates (all from `erp/`)

| Gate | Result |
|---|---|
| `npm test` | **94 files, 1305 tests, all passed** (108.7s) |
| `npx tsc --noEmit` | clean, no output |
| `npx eslint src tests` | clean, no output |
| `npm run build` | clean; `ƒ /api/shippers/[id]/print` appears in the route manifest |

## Verification method

Rendered-PDF comparison (the Read tool renders PDFs): `/tmp/ticket-visual.pdf` built from the sample's own data (order 72036-3, AMZ, 192 × 500031-HT, 4,128 lbs, 3 bins, carrier "Customer") read side-by-side against `docs/samples/Shipping Ticket Sample.pdf`, iterated on the definition until the block structure, ordering and emphasis matched as tabled above. The browser was not driven (no dev server was running in this session); the rendered-PDF comparison is the visual verification performed. The scratch render test was deleted before commit.

## Concerns

1. **Tear-off placement is `absolutePosition` at y=648.** It does not reserve flow space, so a pathologically long ticket (dozens of lines/containers/serials) that flows past ~y 640 would overlap the tear-off on that page. Typical tickets (the sample's shape) leave the sample's own large blank gap. A data-only definition has no better instrument; Phase 7's designer owns anything fancier. Flagged, not hidden.
2. **HEAD moved under me mid-task** (lane-B / Task 14b commits landed on the branch: `e5e1a6e`…`1d03ec0`). The full suite, tsc, eslint and build all ran against the combined tree after those commits, so the green above covers the integration.
3. `?cert=1` refusal is a temporary contract: Task 19 must replace both refusals (bol, cert) with the real paths — the route comment says so explicitly.
4. The per-order print button posts `order=<orderId>` (the ORDER id, per spec §9's `&order=<id>` and the brief's signature), not the `shipperOrderId` — noted because the two ids coexist on the page.
