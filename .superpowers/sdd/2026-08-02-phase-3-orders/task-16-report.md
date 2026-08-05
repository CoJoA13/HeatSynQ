# Task 16 Report: Traveler — pdfmake pipeline, stored documents, print UI

**Branch:** `phase-3-orders`
**Commits:**
- `1071995` — `feat: PartInspection sampleQty (owner ruling §3.9)`
- `aaeb14f` — `feat: traveler PDFs — per-load sheets, stored exact reprints, barcode`

**Baseline:** HEAD `84d5264` (Tasks 1–15 merged, suite 879)
**Result:** suite **902** (879 + 1 sampleQty + 22 traveler), `tsc` clean, `eslint` clean,
`npm run build` clean. Dev-server smoke passed end to end (§7).

The samples gate is closed. All three owner rulings of 2026-08-03 are implemented and recorded
as a dated amendment under design-spec §3.9.

---

## 1. The owner rulings (spec §3.9, amended 2026-08-03)

The amendment is written into
`docs/superpowers/specs/2026-08-02-phase-3-orders-design.md` §3.9, in the §5d amendment's style
(short, dated, states all three):

| Ruling | Implementation |
|---|---|
| **(a) The mockup IS the build target** — no further samples | Layout mirrors `docs/samples/2025-aht-orderform-mockup.pdf` section for section. Every deviation is listed in §6 below and commented at the code that makes it. |
| **(b) `PartInspection.sampleQty`, optional free text** | New `String @default("")` column + hand-written migration on both DBs; service/zod `.max(60)` display text; part page inspections grid gains the cell; prints in the traveler's Key Characteristic **Quantity** column. |
| **(c) No inspection-location images in Phase 3** | The mockup's `{Inspection Location.bmp}` slot renders nothing. The only image anywhere in the document is the header barcode — asserted by a test that counts `"image":` occurrences and requires exactly one per load. `PartInspection.location` (text) still prints in a Location column. |

**Why `sampleQty` is text, not a number:** the mockup itself carries `8` on the Hardness row and
`100%` on the Mag-Particle row. A numeric column would reject half the real values. `.max(60)` is
a column width, not a domain rule — it stops a pasted paragraph from blowing up the PDF layout.

---

## 2. Architecture — three layers

```
collectTravelerData()      reads: getOrder + getRevision(LOCKED) + lead part + settings + barcode
buildTravelerDefinition()  PURE: TravelerData in, plain-JSON pdfmake definition out
renderPdf()                bytes — src/server/pdf/render.ts, the only pdfmake-aware file
```

**Files created**
- `erp/src/server/pdf/render.ts` — `renderPdf`, `barcodePng`, `pngDataUri`, the named table layouts
- `erp/src/server/pdf/pdfmake-node.d.ts` — ambient declaration for pdfmake's Node entry
- `erp/src/server/traveler.ts` — `TravelerData`, `buildTravelerDefinition`, `collectTravelerData`,
  `printTraveler`, `listDocuments`, `getDocument`, `travelerFilename`
- `erp/src/app/api/orders/[id]/traveler/route.ts` (POST, `?load=N`)
- `erp/src/app/api/orders/[id]/documents/route.ts` (GET)
- `erp/src/app/api/documents/[docId]/route.ts` (GET bytes)
- `erp/src/app/orders/[id]/DocumentsSection.tsx`
- `erp/tests/traveler.test.ts` (22 tests)

**Files modified** — `package.json` (+`pdfmake` ^0.2.23, +`bwip-js` ^4.11.2 runtime;
+`@types/pdfmake` ^0.3.3 dev), `next.config.ts`, `prisma/schema.prisma` + new migration,
`src/server/part-inspections.ts`, `src/app/parts/[id]/InspectionsSection.tsx`,
`src/app/orders/[id]/page.tsx`, `src/app/orders/new/page.tsx`,
`tests/part-inspections.test.ts`, and the spec.

### 2.1 pdfmake wiring — what actually worked

The brief said "try the vfs build first; the %PDF smoke test is the gate, not hope." It is the
**`PdfPrinter`** path that ships:

```ts
import PdfPrinter from "pdfmake/src/printer.js";
import vfs from "pdfmake/build/vfs_fonts.js";
const FONTS = { Roboto: { normal: Buffer.from(vfs["Roboto-Regular.ttf"], "base64"), … } };
```

The browser build (`pdfmake/build/pdfmake` + `createPdf(...).getBuffer()`) is the wrong tool under
Node — it wants a global `window`, and its vfs plumbing exists to fetch fonts a browser cannot read
off disk. `PdfPrinter` is pdfmake's documented server entry point. It normally takes .ttf **file
paths**; buffers decoded from pdfmake's own bundled vfs are used instead, deliberately, so nothing
has to survive `output: "standalone"`'s file tracing into the Docker image.

Smoke-verified before a line of the traveler was written (`%PDF-`, 12,802 bytes) and again as
test #1 of the suite.

**Types.** pdfmake ships none; `@types/pdfmake` types only the *browser* build. `pdfmake/interfaces`
(`TDocumentDefinitions`, `Content`, `TableCell`) comes from those types and is used throughout; the
Node `PdfPrinter` gets a 30-line ambient declaration (`src/server/pdf/pdfmake-node.d.ts`) covering
exactly the two members called.

**`next.config.ts` gains `serverExternalPackages: ["pdfmake", "bwip-js"]`** — both are CJS with
their own internal `require` graphs (pdfkit, fontkit, iconv-lite) and a megabyte of embedded base64
font data. Declared external they are `require`d at runtime and traced into the standalone build the
same way Prisma's engine is.

### 2.2 The purity test caught a real design violation

Spec §10 promises the traveler template is **data, not code** — the substrate Phase 7's designer
will edit and version. The first cut used pdfmake's inline table layouts:

```ts
const RULED = { hLineWidth: () => 0.8, vLineWidth: () => 0 };   // callbacks IN the definition
```

`expect(JSON.parse(JSON.stringify(def))).toEqual(def)` failed on it. A definition carrying functions
can never be stored, versioned or edited as data. The layouts are now **registered by name** in the
renderer (`printer.createPdfKitDocument(def, { tableLayouts })`) and the definition references
`"traveler-ruled"` / `"traveler-steps"` / `"traveler-boxed"` — plain strings. This is the single
most valuable thing the test suite found.

`buildTravelerDefinition` is additionally asserted to be non-async, deterministic across two calls
with the same input, and to embed no clock (no `info.creationDate`) — a definition that read "now"
would make two prints of the same order differ for no reason.

---

## 3. Print mechanics and the voided rules

`printTraveler(orderId, loadNumber?)`:

- **404** a missing order; **400 `"Cannot print a traveler for a voided order"`**.
- The render happens **outside** the transaction (~100 ms of pure CPU with nothing to roll back;
  holding a write transaction open across a 14-load render would be a self-inflicted lock). The
  void check therefore runs **twice** — once up front so a refusal costs nothing, and once inside
  the transaction, which is the one that decides, closing the void-mid-render window.
- `auditedCreate("storedDocument", { orderId, kind, loadNumber }, …)` — **metadata only**. The
  bytes are never handed to the audit layer (`redact()` is defense in depth, not the mechanism);
  the attachments service sets the same precedent. Asserted: the audit `after` payload has no
  `fileData` key and does not contain `%PDF`.
- One PDF per print action: all loads (one sheet-set per load, `loadNumber` null) when the load is
  omitted; that load only otherwise.

`listDocuments` / `getDocument` deliberately do **not** filter on `deletedAt`: reads work on a
voided order (§5c). Stored prints stay listable and byte-identically reprintable forever — there is
no delete path on `StoredDocument` at all (§4).

`listDocuments` orders `[{ createdAt: "desc" }, { id: "desc" }]`; the id tiebreak is a time-ordered
cuid, so two prints inside one millisecond still list in the order they happened.

`printTraveler`'s return is widened past the brief's `{ documentId, pdf }` to
`{ documentId, orderNumber, loadNumber, pdf }` — purely so the route can name the download without
a second read that would pull the whole PDF back out of the database.

---

## 4. Data sources (and one deliberate departure from the brief)

| Traveler content | Source |
|---|---|
| Order, lines, containers, loads | `getOrder` → `OrderDetail` |
| Process steps + typed values | `getRevision(leadPartId, lockedRevisionNumber)` — the LOCKED revision |
| Lead part inspections | `listPartInspections(leadPartId)` (parts service) |
| Every line part's description / each-weight / material | ONE `prisma.part.findMany` |
| Customer name + received-from address | `prisma.customer` + `listAddresses` |
| Company block | `getSetting("company_name" \| "company_address" \| "company_phone")` |
| Barcode | `barcodePng(String(orderNumber))` — Code 128, bare order number |

**The departure:** the brief said "the lead part's inspections + material via the parts service".
Inspections do come from the service. Material/description/each-weight come from one `findMany`
over every line part instead of `getPart` per line, because (a) the traveler needs the same three
fields for *every* line, not just the lead, (b) `getPart` fires a second per-part revision query it
does not need, and (c) `getPart` 404s a soft-deleted part an order may legitimately still reference
— paper has to name the part whatever has happened to the catalog since. The `findMany` is
deliberately unfiltered on `deletedAt` for that reason.

**No logo.** The owner supplied none with the samples; Phase 7 owns logo upload (§10). The company
settings block stands centered where the logo sits on the mockup.

---

## 5. UI

**Hub `DocumentsSection`** replaces the placeholder: `Print traveler` (all loads) · a
`Single load…` select listing every load with its piece count · `Print load` · the archive table
(kind / load / timestamp, each row a link to `/api/documents/[id]` that streams the stored bytes
inline). Voided → both buttons and the select disabled with
`title="Order is voided — stored prints stay available"` (§5.16: disabled with a reason, never
hidden).

**Printing cannot use `api()`** (which always parses JSON), so it is raw `fetch` with the error
body read the same way `api()` reads it — a voided 400 or a 403 still surfaces as its real server
message.

**Popup blocking is named, never swallowed.** The PDF is opened via an object URL; browsers may
block `window.open` after an `await` (and always will for the gesture-less auto-print). That is
detected (`window.open` returns `null`) and reported: *"The traveler printed and is saved below,
but your browser blocked the window. **Open the traveler**"*, linking to the archived copy via the
route's `x-document-id` response header. The print happened and is archived either way. This fired
for real in the dev smoke and behaved exactly as designed.

**Save & Print (entry page) — the shape chosen.** Save & Print **saves, then navigates to the hub
with a one-shot `?print=1`** which `DocumentsSection` honours exactly once per page instance (a
ref set synchronously before the await, so a re-render or React's development double-effect cannot
print — and archive — twice; confirmed in the smoke: one auto-print, one stored row).

Two alternatives were rejected: printing inline before navigating (a second failure mode on the
save path, and the PDF's own window is lost across the navigation), and printing from the warnings
panel (it would print *before* the user has read the warnings). **With warnings present the
warnings panel still shows first** — `print` rides on `savedOrder` and the button reads
*"Go to order and print"*, firing the print when the user clicks through. The
"named, never silent" rule for warnings is intact.

`useSearchParams` forced a `Suspense` boundary around the hub route component (Next refuses to
build a page that reads it outside one); the fallback matches the page's own `Loading…`.

---

## 6. Mockup fidelity — what matches, what deviates

Verified by rendering the mockup-shaped order and comparing against
`docs/samples/2025-aht-orderform-mockup.pdf` page by page.

### Matches (verbatim)

- **Header** — customer name (bold) + received-from address left; company block centered; `Order
  Number` / `Load` labels with values right; Code 128 barcode beneath them.
- **Part-lines table** — `Part Quantity | Part Number / Part Name / Description | Part Weight |
  Line Weight`, horizontal rules only, slash-joined identity cell
  (`3541719C3 / U Bolt Rear Spr Plate / Machined`).
- **Quantity row** — `Order Quantity | Load Quantity | Container | Container Quantity | Tare
  Weight | Gross Weight`, with Order/Load/Gross row-spanned across the container rows. On the
  mockup's own data the render reproduces its exact numbers: **4,500 · 336 · Drop Pan 8 / 2,936 ·
  Bin 12 / 3,828 · 67,514**.
- **Process / Material / Process ID** rule.
- **Key Characteristic Inspection(s)** — boxed, centered title, per-inspection rows with scale /
  min / max / quantity.
- **PROCESS STEPS** — position, code name, instruction then typed values (`Label: value unit`) in
  field-def order, with **EQ# / OP / Date** handwriting boxes per step.
- **Footer** — `RESULTS:` | `TEMPERED RESULTS:` | `FINAL INSPECTION:` | `PASS ☐ FAIL ☐` |
  `Tested By: / Date:` | `OK to Ship: / Date:`, left and right blocks ending level.

### Deviations (all deliberate, all commented in code)

1. **`Process:` prints the locked revision (`Rev 1`), not a process name.** The mockup prints a
   NAME there (`Austemper`) and **this data model has no process-name field**. Both alternatives
   were worse: the lead part's `name` is a PART name (`U Bolt Rear Spr Plate`) that already prints
   in the lines table and would actively mislead under a `Process:` label; a name assembled from
   step codes would be invented. Spec §3.1/§10 define process identity as *"the lead part + the
   locked revision"* — Process ID is the part, so Process is the revision. **This is the one open
   question for the owner: does a traveler need a human process name (`Austemper`), and if so
   where does it live — on the part, or on the revision?**
2. **Inspection block's first column header reads `Inspection`, not `Hardness`.** On the mockup
   that header cell holds a *data value* (the first inspection's code name); it cannot generalise
   to an arbitrary set of inspection codes.
3. **`{Inspection Location.bmp}` renders nothing** (owner ruling c). The last column shows
   `PartInspection.location`'s **text** instead.
4. **No `Ph:` / `Fx:` lines under the customer address.** `CustomerAddress` has no phone column
   (phone lives on `CustomerContact`, which is a person, not a site). The company block's phone
   comes from the `company_phone` setting and does print.
5. **No Net Weight column.** Spec §10's prose mentions "net derived"; the mockup has no such
   column, and ruling (a) makes the mockup binding. Gross is a single figure for the whole set: the
   **sum of stored container gross weights when every container carries one**, otherwise the
   mockup's own arithmetic (order weight + total tare = 60,750 + 6,764 = 67,514). Summing partial
   data would silently under-report, which on shipping paper is worse than deriving.
6. **Two small additions, both real data with no column of their own on the mockup**, rendered as
   a 6.5 pt grey sub-line inside an existing cell rather than dropped:
   - Container cell: `40 per container` (`OrderContainer.qty` — the mockup's *Container Quantity*
     column is the container **count**: 8 drop pans + 12 bins against a 4,500-piece order).
   - Load Quantity cell: `4,536 lb` (`Load.weight` — the split is weight-capped as often as
     piece-capped, §5.4).
7. **No PO number on the traveler.** The mockup carries none, so none was added.
8. Cosmetic: the `EQ# / OP / Date` header labels sit inside the same boxed columns as the cells
   below them (pdfmake's vertical-rule callback has no row index); row-spanned values are top-
   aligned rather than vertically centered (pdfmake has no cell vertical-align).

---

## 7. Dev-server smoke (real browser, real dev DB)

Reference data (customer + received-from address, material, 7 step codes with 6 field defs, lead +
rider parts, a 7-step revision, two inspections including `sampleQty` `8` and `100%`, two container
types) was seeded to the dev DB; **the order itself was keyed through the entry page** as the task
required.

| Step | Result |
|---|---|
| Entry page → customer, PO, 2 containers, lead + rider lines, `Rev 1 — locks at save` preview | ✓ |
| **Save & Print** | Order **#1012** saved, navigated to `/orders/{id}?print=1` |
| Auto-print fired once | one `StoredDocument` row, `All loads`, 111,326 bytes, 14 pages, no trailing blank page |
| Popup blocked (headless pane) | fallback banner + working link rendered — named, not silent |
| Opened the stored PDF | **matches the mockup** (screenshot compared page by page) |
| Per-load: select `Load 3` → `Print load` | `traveler-1012-load-3.pdf`, 1 page, header `Load 3` |
| Reprint the same document twice | `cmp` → byte identical |
| Void the order (reason recorded) | banner shows the reason; both print controls disabled with the voided tooltip; select disabled |
| `POST …/traveler` on the voided order | `400 {"error":"Cannot print a traveler for a voided order"}` |
| `GET …/documents` and `GET /api/documents/{id}` after the void | `200`, list intact, bytes still **identical** to the pre-void download |
| Dev-server error log | empty |

Loads: 13 × 336 + 132 = 4,500 ✓. Filenames: `traveler-1012.pdf` / `traveler-1012-load-3.pdf`,
`content-type: application/pdf`, `content-disposition: inline`.

**Fixtures cleaned:** every `T16*` row soft-deleted (the app's own deletion model — hard deletes
are tests-only), the order voided, `company_*` settings reset to blank. Zero live `T16` rows and
zero live orders remain. Two side effects are permanent by design and were left alone: order number
1012 is consumed (numbers are never reused, §5c) and its two `StoredDocument` rows persist
(`StoredDocument` has no delete path, §4).

---

## 8. Tests (22 new, `erp/tests/traveler.test.ts`)

- **Plumbing** — `renderPdf` returns `%PDF-`; `barcodePng` returns a PNG.
- **Purity** — non-async; deterministic across two calls; whole definition survives
  `JSON.parse(JSON.stringify(...))`.
- **Content tree** — every mockup section asserted by walking the definition's `text` nodes:
  customer + address, company block, `Order Number`, the number, `Load`, an embedded
  `data:image/png;base64,`; the two part-line identity cells; `4,500`; `Drop Pan`; `Process:` +
  `Rev 1`; `Material:` + `Ductile Iron`; `Process ID:` + the lead part number; the inspection block
  including `sampleQty` `8` and `100%` and the location text; `PROCESS STEPS:`, the step code name,
  its instruction, `Furnace Temp: 1650 °F` **before** `Furnace Time: 2 hours` (field-def order),
  `EQ#`, `OP`; and all six footer blocks.
- **Ruling (c)** — exactly one image in the document per load, and no more.
- **Locked-revision fidelity** — build the order, `updateStep` the lead part (cutting revision 2),
  assert the definition still shows revision 1's instruction and **not** the changed text.
- **Per-load** — 14 sheets with the right per-load quantities; `?load=14` yields one sheet carrying
  132 and its weight and *not* 336; an unknown load number 404s.
- **Storage** — stored bytes equal the returned bytes (`Buffer.compare === 0`); two `getDocument`
  calls are identical; `?load=3` records `loadNumber: 3`; missing order 404s.
- **Voided** — new print 400s with the exact message while the stored print stays listed and
  byte-identically reprintable.
- **Audit** — a `storedDocument` `create` entry exists carrying `{ orderId, kind, loadNumber }`,
  with no `fileData` key and no `%PDF` anywhere in the payload.
- **Listing** — three prints list newest-first with the right load numbers and no `fileData`.
- **Routes** — POST streams `application/pdf` + `inline` and archives; `?load=5` stores load 5;
  `?load=abc` is a 400 (anchored regex, not `parseInt`); documents list; document bytes match;
  all three routes 401 signed out and 403 without `orders.view`; POST 400s on a voided order while
  both GETs still 200.
- **Edge shapes** — blank company settings, no addresses, no inspections, no containers still
  renders a valid PDF.
- **`sampleQty`** (in `tests/part-inspections.test.ts`) — round-trips as free text, defaults blank,
  rejects 61 characters.

---

## 9. Migration

`erp/prisma/migrations/20260803160000_part_inspection_sample_qty/migration.sql`, produced by the
TTY-less recipe (`migrate diff --from-config-datasource --to-schema=… --script`, output read in
full, hand-written) and applied to **both** databases plus `prisma generate`:

```sql
ALTER TABLE "PartInspection" ADD COLUMN     "sampleQty" TEXT NOT NULL DEFAULT '';
```

---

## 10. Self-review notes

- `buildTravelerDefinition` contains no `await`, no `prisma`, and no `Date` — verified by reading
  and by the purity test.
- Every field on `TravelerData` is rendered. Three fields that the first cut carried but never
  printed (`poNumber`, `TravelerStep.code`, and a `processName` that was always `""`) were removed
  rather than left as dead weight; `revisionNumber` and `Load.weight` were *rendered* instead of
  removed, because both say something the paper needs (§6.1, §6.6).
- `printTraveler` re-checks the void state inside its transaction, not only before the render.
- `new Uint8Array(pdf)` on write / `Buffer.from(row.fileData)` on read — Prisma 7's `Bytes` input
  is `Uint8Array<ArrayBuffer>` and Node's `Buffer` is `Uint8Array<ArrayBufferLike>`; the attachments
  service's `Buffer.from` precedent is followed on the read side.
- The auto-print ref is set **synchronously** before the await, so React's development double-effect
  cannot archive two documents. Confirmed empirically in the smoke.
- `StoredDocument` was already in `AuditableModel` and `SNAPSHOT_INCLUDE` (Task 1) — no audit-layer
  change was needed.
- No `findUnique`/`upsert` on a partial-unique column was added; `getDocument`'s `findUnique` is on
  the real `@id`.

## 11. For the owner / next reviewer

1. **Process name.** The only genuine data gap the mockup exposes. `Process:` currently prints
   `Rev N`. If the shop wants `Austemper` there, it needs a field — on the part, or on the
   revision — and that is an owner decision, not an implementer's guess.
2. **Order number 1012 and two `StoredDocument` rows** remain in the *dev* database from the smoke,
   by design (numbers are never reused; stored documents have no delete path). The order is voided
   and every other fixture row is soft-deleted.
3. Voided orders are excluded from global search (`findExactOrderId` filters `deletedAt: null`,
   Task 8's own rule), so scanning a voided order's barcode finds nothing. Pre-existing behaviour,
   noted only because the barcode makes it newly reachable.

---

# Fix round 1

**Commit:** `125ea43` — `fix: print UI popup handling + one-shot consumption; blank Process cell per owner ruling`
**Gates:** suite **904** (902 + 2 new), `tsc` clean, `eslint` clean, `npm run build` clean.
Dev-server re-smoke passed all four contracted checks (§F4).

Two Important review findings, both in the print UI, plus one owner ruling that arrived in
parallel. The server half was untouched — no architectural change.

## F1. `window.open(url, "_blank", "noopener")` always returns null (Important)

`DocumentsSection.tsx`. The blocked-popup detection was broken at the source: passing `"noopener"`
as the feature string makes `window.open` return `null` **by specification** — the whole point of
`noopener` is that the opener gets no handle on the new window. Consequences, all real:

- the *"your browser blocked the window"* banner fired on **every successful print**;
- `URL.revokeObjectURL` never ran, leaking one blob per print for the life of the tab;
- a genuine popup block was indistinguishable from success, so the one signal the panel exists to
  give was worthless.

Fixed exactly as the reviewer specified — the feature string is dropped and the opener is severed
on the returned handle instead. The URL is a same-origin blob, so `noopener`'s cross-origin
protection was buying nothing:

```ts
const opened = window.open(url, "_blank");
if (opened) opened.opener = null;
if (opened === null) { /* genuinely blocked — banner + link to the archived copy */ }
```

The top-of-file comment records what was wrong and why, so the `noopener` is not re-added by a
future reader who reaches for it on reflex.

## F2. The `?print=1` one-shot did not survive a reload or Back (Important)

`DocumentsSection.tsx`. The `autoPrinted` ref guarded only *this component instance* — React 19's
development double-effect, yes, but not a reload, a Back into the hub, or a bookmark of the URL.
Every one of those remounted with `?print=1` still on the address bar and printed again, silently
archiving a duplicate `StoredDocument` **plus its audit row** — for a document that is permanent
and has, by design, no delete path.

The one-shot now lives in the URL, which is where it belongs:

```ts
autoPrinted.current = true;
router.replace(pathname);   // strips ?print=1 before the print even starts
void print();
```

`replace`, not `push`, so Back still leaves the hub rather than landing on the print-again URL.
The ref stays as the within-instance guard; the two protect different things.

## F3. Owner ruling 2026-08-03 — the `Process:` cell renders BLANK in Phase 3

Supersedes this task's original `Rev N` rendering. Phase 7's template designer owns that slot.
`Material` and `Process ID` (the lead part number) are unaffected and still print.

- `processRow` renders an empty value cell; its comment now records the full ruling and the three
  rejected stand-ins (lead part name, a name assembled from step codes, the locked revision).
- `TravelerData.revisionNumber` is **kept** — it governs `steps` and is what makes them
  interpretable to any future template — and simply is not printed. Its doc comment says so.
- Test updated, and a dedicated test added: `leaves the Process cell blank while still knowing the
  locked revision` asserts `revisionNumber === 1` on the payload, that no `"Rev "` string reaches
  the definition, **and** that the lead part's name appears exactly once on a sheet (i.e. it was
  not quietly substituted into the Process cell either).

**Spec §3.9** gains a second dated amendment recording ruling (d), plus the reviewer's two
observations for the owner's demo notes, explicitly as **recorded observations, no code change**:

1. *Process ID* prints the lead part number (`3541719C3`) where the mockup shows a masked family
   number (`35417XXC3`) — a sibling order names its lead rather than the family.
2. The load's weight prints as a small grey sub-line under *Load Quantity* — an addition to the
   mockup (real `Load.weight` data with no column of its own there).

## Minor taken: the §5b reprint-divergence test

`a load edit after printing changes the NEXT print, never the stored one`. Loads stay editable
after a traveler prints (owner ruling §3.3), so a later render legitimately differs — what must
never happen is the *earlier* print changing under the shop's feet. The test prints, archives,
collapses the 14 auto-split loads to 2 by hand via `replaceLoads`, prints again, and asserts: a
different document id, genuinely different bytes, two sheets now instead of fourteen, the **first**
document still byte-for-byte what it was, and both listed newest-first. This is the hazard the
service's own comments cite, now under test rather than only asserted in prose.

Ledgered and skipped as instructed: sheet-overflow header repetition (latent, ~20-step revisions),
the `toStrictEqual` purity nit, the `withDbErrors` entity label.

## F4. Dev-server re-smoke

Fresh `R1*` fixture, order keyed through the entry page, Save & Print. Both popup outcomes were
exercised deliberately: the success branch by standing in for a browser that permits the popup
(the preview pane blocks every real `window.open` regardless of arguments, so the two branches
are otherwise indistinguishable there), the blocked branch by returning `null` — exactly the
signal a real block gives.

| Check | Result |
|---|---|
| Print succeeds, popup permitted | `window.open` called with **`(blobUrl, "_blank")`** — no feature string; **no banner**; revoke timer scheduled; firing it ran `revokeObjectURL` once |
| Print, popup blocked (`window.open → null`) | **Banner present** with a working link to the archived copy; **no** revoke timer scheduled |
| Save & Print → hub | URL is `/orders/{id}` — `?print=1` already stripped; one document archived |
| Navigate to `?print=1`, then **reload** | document count 4 → 5 on arrival, **still 5 after the reload** — no duplicate archived; URL stayed stripped |
| Printed PDF | **`Process:` cell blank**; `Material:` and `Process ID:` still print; header/lines/inspections/steps/footer unchanged |
| Void the order → new print | `400 "Cannot print a traveler for a voided order"` |
| Dev-server error log | empty |

Also observed and worth recording: while probing the success branch, a deliberately broken stub
made `window.open` undefined; the resulting `TypeError` surfaced in the panel's own error banner
rather than being swallowed. The error path reports.

**Fixtures cleaned:** order 1013 voided (reason recorded), every `R1*` row soft-deleted,
`company_*` settings reset to blank. Zero live `R1` rows, zero live orders. Order numbers 1012–1013
and their `StoredDocument` rows persist in the dev database by design (numbers are never reused;
stored documents have no delete path).
