# Task 19 report — Bill of Lading and Certification PDF layouts

Commit: `7800882` — `feat(pdf): bill of lading and certification layouts` (BASE `a32c912`, branch
`phase-4-certs-shipping`). All four gates green; suite 1342 passed / 0 failed.

## Files

| File | Change |
|---|---|
| `erp/src/server/pdf/bol.ts` | **new** — pure BOL builder (`buildBolDefinition(BolData)`) |
| `erp/src/server/pdf/cert.ts` | **new** — pure cert builder (`buildCertDefinition(CertPdfData)`) |
| `erp/src/server/shippers.ts` | `bolSettings`, `readBolData`, `printBol`, `printableShipmentCertIds` |
| `erp/src/server/certs.ts` | `certPrintSettings`, `readCertPdfData`, `printCert` |
| `erp/src/app/api/shippers/[id]/print/route.ts` | real `?doc=bol` and `cert=1` paths; honest cert parse |
| `erp/src/app/api/certs/[id]/print/route.ts` | **new** — POST, gated `certs.view` (§9) |
| `erp/src/app/shipping/[id]/ShipmentDetail.tsx` | BOL button live; top-level cert checkbox; CERT doc label; archived-certs info line |
| `erp/src/app/shipping/[id]/ShipmentOrderPanel.tsx` | per-order cert checkbox live (pre-ticked, §3.14) |
| `erp/tests/bol.test.ts` | **new** — 15 tests |
| `erp/tests/cert-pdf.test.ts` | **new** — 22 tests |
| `erp/tests/shipping-ticket.test.ts` | the Task 18 test pinning the temporary bol/cert 400s updated to the real behavior (unknown-doc refusal kept) |

## Per-step account

**Step 1 — samples read.** Both PDFs read with the Read tool before any code. The cert sample:
centered company + "Certification" title, right block (Order No./Date/Entry Date/Page), To: block,
PO/Packing List/Material block, parts table, the certify statement, "Were heat treated as per
P.O. NONE to HRC:" line, a 3-across `28.0 | 30.0 | 29.0` readings grid, signature block (script
image over rule, typed name/title/company), footer (address, Phone, Fax). The BOL sample: the
straight-bill form with the four labeled rules top-right, carrier line, UDSBL fine print,
consigned-to/destination, `TRV NO. 71955,71957,71959,71960,71961`, freight table, the Section 7
sidebar with the collect box, and the bottom legal notes/signature lines.

**Steps 2–4 — failing tests.** `tests/bol.test.ts` and `tests/cert-pdf.test.ts` written first; the
RED run failed at collection ("Cannot find module `@/server/pdf/bol` / `@/server/pdf/cert`" — 2
files failed, 0 tests ran), which is the strongest failure available when the modules under test do
not exist. One deliberate adaptation of the brief's literal test code, made after an empirical
probe (below): **raw-PDF byte-grep content assertions are impossible with this rendering pipeline**,
so content is asserted on the pure JSON definition (Task 18's House pattern) and rendered bytes are
pinned structurally.

> **Probe (run before writing the tests):** rendered `{ text: "TRV NO. 71955,71957" }` through the
> real `renderPdf` with `compress: false`. The content stream reads
> `[<00010002> 9.277344 <00030004> 0] TJ` — pdfkit subsets the Roboto TTF and writes glyph ids,
> never character bytes, so `pdf.toString("latin1").toContain("71955")` is false for ANY text at
> ANY compression setting. The brief's `pdf.toString("latin1")` assertions were therefore ported to
> `allText(definition)` over the exact definition the print renders from (built through the real
> `readBolData`/`readCertPdfData` path, not hand fixtures), plus `%PDF-`/`/Count N` pins on the real
> bytes — the same split Task 18's reviewed tests use. Every semantic the brief's tests demanded
> (order numbers on the BOL, readings-not-verdicts on the cert, printedAt-once, no-signature
> fallback, no internal notes) is asserted; only the grep medium changed, for a physical reason.

**Step 5 — implementation.** Both builders pure (JSON round-trip asserted); print entries follow
the `printShippingTickets` transaction shape exactly. **All layout is flow-based — zero
`absolutePosition` in either builder** (the Task 18 review's tear-off collision lesson, applied as
instructed).

**Step 6 — routes and UI.** Both refusals replaced; the honest cert parse; the new cert print
route; both checkboxes and the BOL button live. Details below.

**Step 7 — GREEN + visual.** All 37 new tests passed; both documents rendered from sample-shaped
fixture data and Read beside the samples (block-by-block comparison below); full suite 1342 green.

**Step 8 — gates + commit.** See Gates.

## bolNumber allocation mechanics

`printBol` (shippers.ts): settings outside the transaction, then ONE Serializable transaction —
pre-claim stub read (only to learn the claim set, the sanctioned shape) → `claimOrdersInOrder` over
every order on the shipment → re-read shipper → `assertPrintable` → **if `bolNumber` is null,
`allocateNumber("bol_number_next", tx)` and an `auditedUpdate("shipper", …)` writing it** → 
`readBolData` on the tx → render → `storeDocument({kind: "BOL", shipperId})`. The counter bump is
`allocateNumber`'s own `FOR UPDATE` on the Setting row (the sanctioned unaudited exception); the
number landing on the shipper is a normal audited update, so history shows which print claimed
which number. Reprints re-enter the same transaction, find `bolNumber` non-null, and reuse it —
tested: reprint returns the same number; a shipment that only prints tickets keeps `bolNumber`
null; a voided shipment keeps its number forever and the next shipment's BOL gets the NEXT counter
value, never the "freed" one. `Shipper.bolNumber` stays plain `@unique` (deliberate, exempted —
untouched). `documentFilename` already covered BOL/CERT (Task 3) — no extension needed; the route
filenames (`bol-<shipperNumber>.pdf`, `cert-<orderNumber>.pdf`) are asserted via Content-Disposition.

## The cert=1 semantics reading (disclosed)

The brief (Step 6) rules the core: *"the shipment print action accepts cert=1 and prints each
covered order's cert alongside, storing each as its own document."* My reading, implemented in
`printableShipmentCertIds` + the route:

1. **Separate documents, one response body.** Each cert is its own render, its own `StoredDocument`
   (kind CERT, `printedAt` set on first print), printed via the same `printCert` the standalone
   route uses, **signed by the requesting user** (§3.11). The HTTP response streams the ticket PDF;
   the archived certs are named in an `x-cert-document-ids` header. The UI opens the ticket and
   surfaces the certs through the Documents list with an explicit "N certification(s) archived —
   open them from Documents below" message (browsers allow one popup per click; a volley of blocked
   tabs would be worse than a truthful pointer).
2. **"Each covered order's cert" resolves through the order's frozen `certScope`:** SHIPMENT → the
   live cert pinned to THIS shipment; ORDER → the live order-scope cert; **LOAD → every live
   load-scope cert the order has** (a shipment cannot know which loads went, and printing some
   without the others would silently drop quality paper — disclosed for adjudication; the
   alternative of refusing LOAD outright seemed worse than over-printing).
3. **A covered order that REQUIRES a cert with nothing to print refuses the whole request (400
   naming the order, nothing archived)** — Task 18's own refusal ethos, quoted in its route
   comment: silently dropping the cert half "would tell the person at the printer their quality
   paperwork went out when it did not." An order that doesn't require one and has none contributes
   nothing silently; an order that doesn't require one but HAS one prints it (it exists and
   pertains).
4. **`cert=1` additionally requires `certs.view`** (route-level `mustCan`, tested 403). Spec §9's
   table gates the route on `shipping.view` only, but a CERT document is certs-area paper
   (`AREA_FOR_KIND`) the caller could not even download afterward; printing paper the caller cannot
   open would breach the owner's own Task 3 ruling about not disclosing certs to shipping-only
   users. Disclosed as a deliberate tightening for review.
5. **`cert=1` with `doc=bol` refuses** (400): §3.14's checkbox is the ticket action; the UI offers
   it nowhere else. Disclosed.
6. **The honest parse (the Task 18 known minor, fixed):** `cert=1` requests, absence or explicit
   `cert=0` does not (200, no certs printed — tested), any other value is a 400 naming the field.
7. **Resolution runs BEFORE the ticket prints**, so the required-but-missing refusal archives
   nothing (tested). Residual race: a cert voided between resolution and its print fails the
   request AFTER the ticket archived — a partial archive of permanent documents (benign: archives
   are append-only and reprints are normal), disclosed as a known narrow window. The resolution
   also runs `assertPrintable` on the shipper itself, closing a real hole: a voided shipment's
   ORDER-scope certs are still live (only shipment-scope certs void with the shipment), so without
   this check a voided-shipment print could still archive cert paper before the ticket refusal.

## The no-signature-on-file decision (§3.11) — and two adjacent ones

- **No image on file:** the display name TYPED over the signature rule, then the normal typed
  name/company beneath — exactly §3.11's own words ("prints their display name over the signature
  rule — visible on screen, blocking nothing"). No mark is ever fabricated. Tested (name appears
  ≥2×, no `image` node in the definition).
- **BMP signature (disclosed decision):** users.ts accepts `image/bmp` uploads, but pdfkit embeds
  only PNG and JPEG — a BMP data URI kills the render mid-print. `readCertPdfData` treats a
  non-embeddable mime as "no image on file" and uses the same typed-name fallback (tested). The
  honest alternatives were a 400 at print time (blocks quality paper over an image format) or a
  crashed render; the fallback matches §3.11's own degradation. **Flag for adjudication /
  fold-in:** consider dropping `image/bmp` from `SIGNATURE_MIME` on the users side.
- **The title line (disclosed for adjudication):** the sample and §10.3 print name, **title**,
  company — but no title field exists anywhere on the User record (verified; §4.4 adds none). The
  collector passes `""` and the builder omits the line entirely rather than fabricating one (the
  permission role name is not a job title and would print nonsense on customer paper). The builder
  and `CertSigner` type fully support a title the moment a field exists. Company = the
  `company_name` setting (the sample's signature-block company differs slightly from its own
  header — "American Heat Treat" vs "Heat Treating" — which is Visual Shop data, not a layout fact).

## Layout vs sample — Certification (rendered beside the sample, block by block)

Matches: centered company name over the large "Certification" title; right block `Order No.:
72036-3` / `Date:` / `Entry Date:` (padded mm/dd/yyyy, the sample's style); underlined `To:` with
customer name, street, city/state/zip on the offset line; right-mid `Purchase Order No.:` /
`Packing List No.: 072826` (six-digit padded, the ticket's rule) / `Material: steel`; heavy rule;
parts table `Quantity | Part Number / Part Name / Part Description (stacked 3 lines) | Pounds`
with ruled (not gridded) rows; the `cert_statement` paragraph; the requirement line
`<specification> to <scale>:`; the readings as a **three-across `28.0 | 30.0 | 29.0` grid** with
one-decimal-minimum formatting ("30.0" never "30"); signature block bottom-right (image or typed
name over a rule, typed block beneath); footer strip with address left, `Phone:` right.

Deviations, each deliberate, none silent (all also commented in `pdf/cert.ts`):
1. **No logo** — none supplied; Phase 7 owns logo upload (the ticket/traveler precedent).
2. **No "Page: 1 of 1"** — a pure JSON definition cannot know page counts (pdfmake exposes them
   only to callbacks; the purity test would fail), and a hard-coded value lies on a wrapped cert.
   Task 18's identical deviation was ruled "correctly resolved; ledger-note it" — same ruling
   applies; the footer (which CAN be static content) carries the address/phone strip on every page.
3. **The sample's stray "73753"** beside the address is Visual Shop's internal row id (the ticket
   review's own finding on the same artifact) — not printed.
4. **No "Fax:"** — the sample prints the label with a blank value; no fax setting or field exists.
   Not invented (the ticket's "Temper Only" precedent).
5. **Readings grid prints continuously** — the sample shows visual gaps every three rows (probably
   Visual Shop's own sub-grouping); nothing in the data model corresponds to those gaps.
6. **The requirement line is `<inspectionCodeName> to <scaleName>:`** — the sample's "Were heat
   treated as per P.O. NONE" is the specification TEXT of that requirement in Visual Shop; here the
   specification is the inspection code's name (that is the §10.3 mapping: "a line naming the
   specification and scale"). The fixture uses the sample's own words as the code name to prove the
   line renders identically.
7. **Signature block is flow-laid** (margin-top 24 after content), not pinned to the page bottom —
   the brief's explicit instruction after the Task 18 absolutePosition hazard. On a short cert it
   sits mid-page rather than at the sample's bottom; on a long cert it follows content correctly.
8. **§3.21 by construction:** `CertPdfData` carries no min, max, scale column, pass/fail, override
   flag, or internalNotes field at all — asserted through the real data path (min 28 / max 32 /
   readings 30.0 & 25.6: values print, `\bPass\b|\bFail\b`/"Min"/"Max"/"Override" never appear,
   while the stored model provably holds a failed reading). The scale NAME prints in the heading
   line ("to HRC:") — that is §10.3's requirement, distinct from the banned scale COLUMN.

Scope quantities (§10.3, disclosed mapping): ORDER → the line's ordered qty/weight; SHIPMENT → that
shipment's shipped qty/lbs per line (0 for a line the shipment didn't carry — tested: a 50-of-192
partial prints 50/1075); LOAD → the load's own qty/weight on the **lead** line (Phase 3's loads
split the lead quantity; `Load` has one qty/weight pair, not per-line ones), riders keep their
order quantities, and a load with null qty/weight prints blank, never an invented zero. Serials:
the ORDER's serial rows with description (the heat/lot field), grouped per part line, for every
scope — §10.3 does not scope them and the description lives on the order serial.
`Date:` prints the **print date** (`todayDateOnly` in `printCert`, passed as data so builder and
collector stay clock-free); `Entry Date:` is the order's received date per §10.3.

## Layout vs sample — Bill of Lading (rendered beside the sample, block by block)

Matches: "Original - Not Negotiable" over "STRAIGHT BILL OF LADING"; the four labeled form rules
top-right (Pro No. / **Shipper's Bill of Lading No. with the number on the rule** / Consignee's
Ref/PO No. carrying the orders' POs / SCAC); carrier name centered over its rule with "(Name of
Carrier)" beneath; the RECEIVED fine print; `at <company address>  <Jul - 06 - 2026>  From
<company name>` (the sample's exact date style); the long UDSBL property paragraph; the bold
"Shipper hereby certifies" paragraph; Consigned to / street / Destination + St/Zip with the
notification-only and Delivery Address sidenotes and the tariff footnote; **`TRV NO.` listing every
order number comma-joined in ticket print order** (§3.20 — the point of the document); Delivering
Carrier / Car or Vehicle Initials / No. as blank rules; the freight table (`No. Packages` =
packageCount, description = freightDescription, `*Weight (Subject to Correction)` = the shipment
total in cents-safe summation, `Class or Rate` = freightClass, empty Check Column); the full
Section 7 sidebar with **the collect box driven by `freightTerms`** (X only for COLLECT — tested
both ways), RECEIVED $ / Agent or Cashier / Per / Charges Advanced as blank rules; and the bottom
notes (water/value/declared-value + Per rule/49 U.S.C./fibre boxes) with Shipper, Per / Agent, Per
and Permanent Post-office address rules.

Deviations, each deliberate, none silent (all also commented in `pdf/bol.ts`):
1. **The UDSBL boilerplate is transcribed into the builder, not a setting** — §3.21 made exactly
   two standing blocks settings; the BOL's legal text is the form itself; Phase 7's template
   designer is its editing path. Apparent sample typos are preserved verbatim ("here under",
   "(I) … (2)", "Interstate **Comerce** Commission") per the `SHIPPER_LIABILITY_DEFAULT`
   precedent, with two exceptions I normalized and disclose: "cotract"→"contract" (I judged the
   extraction artifact risk higher than the preserved-typo value; single OCR-ambiguous word), and
   "Initals"→"Initials" because **spec §10.2 itself writes "Car or Vehicle Initials"** — the spec's
   samples-driven amendment wins over my OCR of a photocopy.
2. **The freight table prints only its data row** — the sample form's tall empty grid (open rows
   down the page) is form real estate, not data; empty rows would imply absent entries.
3. **The Section 7 sidebar is not border-boxed** — the sample's photocopied form has column rules
   around it; content, order, and internal rules match. Cosmetic; flow layout keeps it beside the
   table.
4. **Single page, flow-laid, no page count** — the sample carries none either.
5. Blank fields (no carrier, no pro number, packageCount null) print as **empty rules for hand
   completion**, exactly the sample's own convention (the owner's "customer owned truck" note is
   why several sample fields are blank).

## Route + UI

- `POST /api/shippers/[id]/print`: `doc=ticket|bol` (unknown/missing → 400, archiving nothing —
  Task 18's test updated, not weakened), honest `cert` parse, BOL path streaming
  `bol-<shipperNumber>.pdf` with `x-document-id`. 401/403/200 covered for the changed handler
  (the missing-401 lesson from Task 18's review applied — both new test files carry explicit 401s).
- `POST /api/certs/[id]/print`: `handle` → `requireUser` → `mustCan(certs.view)` first line →
  `printCert(id, user.id)` → streams `cert-<orderNumber>.pdf` + `x-document-id`. 401/403/200
  tested; printedAt set; stored bytes Buffer.compare-equal to the response.
- Shipment page: "Print BOL" live behind the same print gate (§5.16 titles kept truthful — voided
  says "Shipment is voided — stored prints stay available"); "Also print certifications" pre-ticked
  at top level and per order panel, disabled with the `certs.view` tooltip when the permission is
  missing (and the request then simply omits cert=1); Documents list labels CERT rows.
- **The cert detail page's print button lives on the other lane and was NOT touched — its
  enablement lands at fold-in** (as instructed; `printedAt` is now genuinely set by both print
  paths, which is the fact its §5.16 gate reads).

## RED/GREEN evidence

- RED: `npx vitest run tests/bol.test.ts tests/cert-pdf.test.ts` → both files fail to collect
  (`Cannot find module '@/server/pdf/bol' / '@/server/pdf/cert'`), 0 tests run.
- GREEN (same command, post-implementation): `2 passed (2) / 37 passed (37)`.
- Full suite: `96 passed (96) / 1342 passed (1342)` — including the updated shipping-ticket route
  test; nothing else in the suite changed behavior.

## Gates

| Gate | Result |
|---|---|
| `npx vitest run` | **96 files / 1342 tests passed**, 0 failed (112.9s) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean (0 problems) |
| `npm run build` | success (standalone build; `/shipping/[id]` and all routes compile) |

No schema change, no migration (Task 2 already carried `bolNumber` and the settings keys).

## Concerns

1. **For adjudication — the cert title line** (omitted; no data source exists). See the §3.11
   section. If the owner wants the sample's "Production Manager" line, a `User.title` column is a
   one-migration follow-up; the builder already renders it when non-empty.
2. **For adjudication — LOAD-scope orders under cert=1** print ALL of that order's live load certs
   (rationale above); and LOAD-scope parts rows put the load's qty/weight on the lead line with
   riders keeping order quantities (the `Load` model has no per-line split).
3. **`cert=1` requires `certs.view`** — a deliberate tightening beyond §9's table row; reviewer
   should confirm or strike.
4. Narrow race: a cert voided between cert=1 resolution and its print leaves the ticket archived
   and the request failed (permanent-archive semantics make this benign; disclosed above).
5. `image/bmp` remains uploadable as a signature but can never print (falls back to typed name);
   consider removing it from `SIGNATURE_MIME` at fold-in.
6. Zero-order-shipment BOL parity: `printBol` on an orderless shipment would print an empty TRV
   line, the same edge the Task 18 review's Minor 3 noted for tickets and the controller judged
   unreachable through §4.2's document-level enforcement — same reasoning inherited, nothing new
   built.
7. Byte-grep adaptation of the brief's test snippets (glyph-subset fonts) — evidence and reasoning
   in Steps 2–4; the semantics of every briefed assertion are covered.

---

# Task 19 fix round — the two owner-ruled code changes

Commit: `0c28e81` — `fix(pdf): cert=1 missing-cert warns instead of refusing; signature uploads
drop BMP` (on top of the docs HEAD `df2ab50`; nothing rebased). Spec basis: the four §9 amendment
bullets dated 2026-08-05 (Task 19 review adjudications, owner-ratified). The two ratified-no-change
rulings (certs.view tightening; LOAD-scope all-live-certs incl. the printedAt side effect) were
left exactly as shipped. **None of the deferred minors were touched.**

## FIX 1 — cert=1 with a required-but-missing cert: print and WARN

**Service** (`erp/src/server/shippers.ts`): `printableShipmentCertIds` now returns
`{ certIds: string[]; warnings: string[] }`. The former `HttpError(400)` for a cert-requiring
covered order with nothing to print became a named warning in the §5.7 house shape:
`Order #<n> requires a certification and none exists to print — its ticket printed without one;
create it from /orders/<id>`. Everything else is unchanged: per-scope cert resolution, orders WITH
certs still print all of theirs on the same request, and the voided-shipment `assertPrintable`
ahead of any archive is kept (that one is a genuine refusal, not a §3.13 warning — it guards
archiving cert paper against a voided shipment, which the amendment does not touch).

**Warning transport (the disclosed decision).** §5.7 warnings normally ride the JSON mutation
payload (`ShipperMutationResult.warnings`) and the page banners render them — but this response's
body is the ticket PDF, so a JSON payload is unavailable. The warnings travel as a response header,
`x-print-warnings`, valued `encodeURIComponent(JSON.stringify(string[]))` — chosen because HTTP
header values must be ISO-8859-1-safe and the house warning text carries em-dashes (U+2014), which
a raw header value would reject at `new Response()` time; the encoding makes the transport lossless
for any future warning text. This is the exact sibling of the already-shipped
`x-cert-document-ids` mechanism on the same response. The shipment page
(`ShipmentDetail.tsx`) decodes it into a `printWarnings` state rendered amber beside the print bar
(cleared at the start of each print), with a deliberate degradation: a malformed header surfaces a
generic visible warning rather than silently dropping the fact that something warned.

**Tests** (`erp/tests/cert-pdf.test.ts`): the refusal pin rewritten to the new contract — 200,
tickets archived (`SHIPPER` listed for the shipment), `storedDocument.count({kind: CERT}) === 0`
(asserted directly, since a CERT document never carries `shipperId` and would not appear in the
shipper's list either way), no `x-cert-document-ids`, and the decoded warning naming
`#<orderNumber>`. Plus the ruled mixed case: two covered orders (one SHIPMENT-scope with its
auto-created cert, one LOAD-scope required-but-missing) — one cert document archived and matched to
the right cert, exactly one warning naming only the missing order, exactly one CERT stored in
total. A fixture fix rode along: `makeInspectedPart` now suffixes its material/scale/code names —
those registries are live-unique (`@@unique([name]) WHERE deletedAt IS NULL`) and the mixed test is
the first to create two inspected parts in one test.

## FIX 2 — `SIGNATURE_MIME` drops `image/bmp`

`erp/src/server/users.ts`: `["image/png", "image/jpeg"]`, with the amendment cited in the comment
(the on-screen preview showed the BMP while every cert silently printed the typed-name fallback).
Sibling change in the same commit: `erp/src/components/UserSignatureControl.tsx`'s file-input
`accept` list now matches (`image/png,image/jpeg` — the only UI reference to bmp, verified by
grep). `certs.ts`'s `EMBEDDABLE_SIGNATURE_MIME` null-out stays untouched as defense in depth for
rows uploaded while BMP was legal, and its comment now says exactly that; the cert-pdf test that
plants a BMP row directly via prisma (bypassing `setSignature`, as a legacy row would exist) still
passes and now tests precisely that legacy path. New test in `tests/user-signature.test.ts`:
`setSignature` with `image/bmp` → 400, nothing stored. The two existing allowlist tests iterate
`SIGNATURE_MIME` and self-adjusted.

## RED/GREEN evidence

- **RED** (tests edited first, pre-implementation): `npx vitest run tests/cert-pdf.test.ts
  tests/user-signature.test.ts` → **3 failed | 32 passed** — the rewritten warning-contract test
  (route still 400'd), the new mixed-case test (first failing on the fixture's live-unique name
  collision, a real fixture bug fixed as part of RED, then on the 400), and the new bmp-rejection
  test (`setSignature` still accepted `image/bmp`).
- **GREEN**: the four touched files → 67 passed; full suite → **96 files / 1344 tests passed**
  (1342 + the two net-new tests).

## Gates

| Gate | Result |
|---|---|
| `npx vitest run` | 96 files / **1344 passed**, 0 failed (112.7s) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | success |

## Concerns

1. The `x-print-warnings` header is capped only by the server's header-size limits (~8–16 KB
   typical); a shipment would need on the order of dozens of cert-less orders to approach it —
   beyond anything the model produces in practice. Noted, not guarded.
2. The warning fires per covered order, so printing ONE order's ticket (`&order=`) warns only about
   that order — consistent with "each covered order", worth a reviewer's glance.
3. The partial-archive race disclosed in the main report narrows but remains: with the refusal
   gone, the only mid-request failure path left is a cert voided between resolution and print.
