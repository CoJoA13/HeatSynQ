# Heat-Treat Shop ERP — Design Specification

**Date:** 2026-07-29
**Status:** Approved 2026-07-29 with owner's review changes applied (qty+weight required, auto load-split, no order duplication, CAR removed)
**Owner:** Production Manager (project sponsor, primary scheduler, daily user)
**Reference system:** Visual Shop by Cornerstone Systems, Inc. (CSI)
**Reference documents:** `Visual-Shop-ERP-Reference-Report.md` (2026 KB teardown), `VisualShopTraining.pdf` (July 2018 manual), `docs/2026-07-29-crossref-findings.md` (cross-reference of the two)

---

## 1. Background and purpose

The shop is a commercial heat treater running Visual Shop as its ERP. Visual Shop's domain model fits the business, but its navigation, UI, and customization model do not: ~1,100 vendor-compiled forms, a 2,527-key untyped settings registry, a fat-client deployment, and capability welded to form variants.

This project builds a **new, self-hosted web ERP** that preserves Visual Shop's working concepts and vocabulary — customers, memorized parts, process masters, work orders that split into loads, certs, shippers, invoices, A/R — with a dramatically simpler and cleaner implementation, easier navigation, and **more** customization than Visual Shop in two specific places: document templates and permissions.

**The new system runs in parallel with Visual Shop until proven. Visual Shop remains the system of record until an explicit cutover decision. Nothing in this project touches the Visual Shop installation or its database.**

## 2. Goals

1. Operate "more or less the same" as Visual Shop for the in-scope workflow, so staff carry their mental model over.
2. Navigation and UI that are measurably easier: one search box, one order page, nothing more than two clicks away.
3. Self-service customization of printed documents (traveler layout, logo placement, per-customer variants) — beyond what Visual Shop offers.
4. Granular, owner-configurable permissions with full audit — beyond Visual Shop's flat checkbox matrix.
5. Prove correctness through a parallel run: **acceptance = one full month closed in the new system with A/R and the QuickBooks summary agreeing with the books.**

## 3. Non-goals (out of scope — deliberate)

- **Scheduling. None.** The Production Manager schedules in Excel around molten-salt quench-tank temperatures (90,000 lb salt mass; 7,000 lb load capacity; temperature moves take hours; customers can pay for a move). This cannot and must not be automated. Order screens show due dates as plain data only.
- **Shop-floor tracking** (no step marking, no load status gates, no "available to ship" gating — the shop ships when work is physically done).
- **Equipment/furnace integration** (no SSI Furnace Link equivalent).
- **Migration from Visual Shop.** The new system starts empty ("None, no migration" — owner). Master data is keyed in by hand, assisted by quick-entry grids.
- Visual Shop features confirmed unused: Sales Order Entry / Receive Parts staging, outside-processing POs, inventory & purchasing, CCM / CRM / mass email, dashboard graphs, contract review, digital order approval, kanban shipping, pickup signature pads, shipping labels, automatic customer emails (status/acknowledgment), assembly process masters (part- or order-assembly), companion products (Visual Archive / Truck / UPS / Net).
- **CAR / corrective actions** — the owner uses a separate dedicated program for CARs. Rework handling inside the ERP may be revisited in a later phase.
- **Order duplication** — deliberately not implemented (owner decision: duplication risks double-billing).
- Exotic pricing methods: screw/washer matrices, dimensional price grids, inspection-based pricing, metal-market pricing, bracket/step price codes, PPG structures, assembly pricing.
- The `{insert}`/formula engines and the drag-and-drop custom part *screen* designer (custom part **fields** are in scope; a screen painter is not).
- Free-form report painter (see §8 boundary).
- Multi-plant operation. Single plant.

## 4. Users and environment

- **1–5 users**, office-based: order entry/receiving, billing, quality/certs, owner/admin. Roles are user-defined (§9), so titles here are illustrative.
- **Deployment:** one self-hosted server on the shop network; users access via browser. No workstation installs.
- **Accounting:** QuickBooks Online, fed summary journal entries (§7.6).
- **Barcodes:** each printed traveler carries an order barcode; scanning it into the global search opens the order. No other scanning.

## 5. Domain model

### 5.1 Entity summary

| Entity | Essentials |
|---|---|
| **Customer** | Name; multiple typed addresses (Ship To / Bill To / Received From); contacts with emails; terms; taxable flag; credit limit + credit hold; COD; default PO; standing notes/instructions surfaced at order entry, shipping, invoicing; per-customer template variants; per-customer surcharge opt-out/override; per-customer finance-charge override; active flag |
| **Part** (memorized) | Belongs to one customer; part number (required, **unique per customer only** — see §15 amendments), name, description; **each-weight (required — order entry computes total weight from it)**; its own **revisioned Process Steps** (**required** — see below); material; **specs (many)**; inspection requirements (code / scale / min / max / optional location) that print on certs; pricing (§7.5) and, ideally, an active quote (**auto-linked at order entry when present**); load quantity and/or load weight (**drive automatic load splitting**, §7.2); owner-defined custom fields; attachments/photos; active flag |
| **Process Steps** ⚠️ *amended 2026-07-30* | ~~Shared, revisioned process master with a step library and per-part overrides.~~ **Superseded — see §15 amendments.** The recipe belongs to the **part**: an ordered, **revisioned** list of Process Steps, each naming a **Process Step Code** (shared reference vocabulary carrying the GL account) and supplying that part's own values. Shared skeletons are **Templates**, which load structure with **blank values only**. Editing creates a new revision; **released orders keep the revision they were printed with**. Full model: `docs/2026-07-30-process-steps-model.md` |
| **Work order** | Customer + PO + received date; parts; containers (type, count, qty, gross/tare/net — net computed); serial numbers with `{001-025}` range expansion; process snapshot (master + revision + per-order step edits); request date (defaulted §7.1) and target date; status (§7.1); notes (order / customer / part); extra charges; attachments; **must carry a quantity and a weight** |
| **Load** | Subdivision of an order for processing: load number, quantity and/or weight. Example that defines the model: 1,000 pcs at 300/load → loads of 300/300/300/100. **Loads ≠ containers** (containers are customer packaging). Ship quantities are *not* bound by load boundaries |
| **Certification** | Scope: by order, by load, or by shipment; inspection results (code/scale/min/max/value, pass/fail) + freeform text + internal no-print notes; rendered from a cert template; signature image of the signing user; stored PDF + print/email history |
| **Shipper** | Ships qty/lbs against an order; **ship-line-complete checkbox decides closure, not arithmetic**; single-order or **multi-order (MOS)**; bill of lading; carrier/route; freight fields; void/reverse rules §7.3; stored PDF |
| **Invoice / Credit** | Created from shipments (grouping configurable: per shipper / per order / per PO) or manually; lines display their pricing source; surcharge lines auto-appended; draft → finalized (numbered, locked, posts to A/R); credits derived from invoices with sign handled; stored PDF |
| **A/R** | Payment batches (check / card / ACH); applications incl. partial, discount, write-off, on-account credit; aging with cutoff; statements; finance charges; month-end close record |
| **Quote** | Customer + parts + prices; effective/expiry dates; follow-up date and list; links into orders and pricing resolution |
| **Reference data** | Operations (process codes) **carrying GL account**; equipment/department tags (informational); materials; inspection codes & scales; container types; carriers; terms; payment types (with GL); salespersons; ending statements; comment snippets; specifications |

All entities: full change history (who/when/before→after), soft delete only.

### 5.2 Quantity layers (from the owner's own example)

Ordered (1,000) → per-load (300/300/300/100) → shipped (e.g., 230, driven by the customer's container needs). The three layers are independent; the UI shows all three on the order page.

## 6. Application structure and navigation

- **Home = the order board**: fast order list; search-as-you-type; filters (status, customer, date range); user-chosen, reorderable, **saved** column views; due-date traffic light (On Target / May Miss / Will Miss / Did Miss with configurable day windows, evaluated most-urgent-first); Excel export.
- **Global search box on every screen**: order #, PO, part, serial, customer — and traveler **barcode scans** land here and open the order directly.
- **Left menu**: Orders, Quotes, Certifications, Shipping, Invoicing, A/R, Customers, Parts, Processes, Reports, Admin. Permissions hide inaccessible areas.
- **The order page is the hub**: overview, parts & containers, serials, steps (with revision), loads, certs, shipments, invoices, notes, attachments, history — sections of one page; Ship / Cert / Invoice actions launch from it pre-filled.
- **Keyboard-speed entry**: order entry tabs field-to-field in a deliberate sequence (customer → PO → dates → containers → part → serials → process → save/print); autocomplete on customers/parts; inline validation while typing; spacebar/Enter conventions consistent throughout.
- Every list exports to Excel.

## 7. Module behavior

### 7.1 Order lifecycle

- Statuses: **Open → Partial Shipped → Shipped → Invoiced**, plus **Voided** (soft delete, reason + permission) and **Reopened** (result of a reversing shipment). No receiving/process-complete gates — matches the shop's real flow.
- Request date defaults: plant default days → per-customer override → per-part override (most specific wins, silent). Target date manual. Dates inform; they never block.
- Order entry hard rules: **quantity and weight both required.** Selecting a memorized part auto-populates the weight (each-weight × quantity), the process master, and — when one exists — its active quote. A part record requires a part number, customer, each-weight, and process master.
- **Orders cannot be duplicated** (owner decision: duplication risks the same order being billed multiple times). Repeat work is entered fresh against the memorized part, which is fast because the part carries everything.
- Order-level extra charges may be added/edited until the order is invoiced; then the invoice owns them (Visual Shop's rule, kept).

### 7.2 Loads

**Loads split automatically at order save** when the part carries a load quantity or load weight — 1,000 pcs at 300/load → loads of 300/300/300/100, as Visual Shop does it. The split is editable and renumberable before printing; orders whose part has no per-load values stay single-load unless split manually. Each load shows on the traveler and can carry its own cert when cert scope = by load. No load status machinery (no tracking).

### 7.3 Shipping

- Single-order: pull order → ship-now qty/lbs prefilled for the remainder → adjust → **ship-line-complete decides closure** → print/email shipper (stored PDF).
- **MOS**: accumulate multiple orders for one customer onto one shipper; edited as a document (add/remove orders) — no Multi-Num-zero workarounds. **BOL** printable for any shipment.
- Corrections: not-yet-invoiced → **void** (permissioned, audited, reason). Invoiced → **reversing shipment** (negative qty, original ship date suggested) which reopens the order and surfaces on the next invoice run as a credit candidate.
- Freight fields (bill/$) captured at shipment for invoicing.

### 7.4 Certifications

- Cert record auto-created per the part/order cert setting; scope by order / load / shipment.
- Results entry: inspection rows (code, scale, min, max, value, pass/fail) + freeform block + internal no-print notes; commercial/ISO-level rigor (no Nadcap/CQI-9 machinery).
- Print/Change-style one-off edits at print time do **not** save (controlled-document behavior, kept from Visual Shop); permanent edits are audited; per-user signature images print on the cert.
- Every printed/emailed cert stored as the exact PDF sent.

### 7.5 Pricing resolution (one order, always visible)

1. **Quote** referenced on the order (customer + part match, in-date) →
2. **Part price**: setup / price / minimum; price-per **each / lb / per-100 / per-1000 / lot(flat)**; quantity-or-weight breaks; per-line minimum enforcement; setup charged once →
3. **Zero + "needs price" flag** — never silently priced, never silently dropped.

Every invoice line names its source (quote #, part price, manual). **Surcharges**: owner-defined named add-ons (percent or flat; include/exclude by operation; per-customer opt-out/override; own GL) auto-appended at invoice creation.

### 7.6 Invoicing, A/R, QuickBooks Online

- Create-from-shipments in bulk with configurable grouping (per shipper / per order / per PO); manual invoices and credits; credits derived from invoices (sign handled).
- Lifecycle: draft → **finalized** (numbered, locked, posts to A/R) → paid. Unlock = permissioned, audited action.
- **Finance charges**: plant rate + per-customer override; **informational only** — computed at statement print, printed on the statement as a figure the customer is not being billed (and excluded from Total Due), never posted, never aged. There is no run and nothing is stored, so nothing can duplicate; collecting interest means raising a real invoice. (Ratifies P5B §3 ruling 9 and P5C §3 ruling 4; owner ruling 2026-08-19 on #162, which removed this line's earlier promise of a per-invoice dispute/exempt and an idempotent run.)
- A/R: batches (check/card/ACH); apply with partials, discounts, write-offs, on-account credits; batch balance shown live; aging with cutoff; statements; **guided month-end close** showing invoiced / paid / ending A/R side-by-side with the close record saved.
- **QBO export**: summary journal entries (GL, date, amount) — detail stays in the ERP. Via QBO API connection or downloadable file (bookkeeper's choice). Idempotent — once marked sent, can never double-post. GL sourced from operations, surcharges, payment types, plus plant-level defaults.

### 7.7 Quoting

Customer quotes with part/price lines (same price-per vocabulary); effective + expiry dates; follow-up date; a follow-up/expired worklist; quote → order linkage (pull a quote into an order; that locks pricing tier 1). Close/reopen with reason.

### 7.8 Reports (initial set)

Backlog by customer / by date; shipped by day / customer / date range; turnaround (order-to-ship days); sales by month / customer / operation; invoice register; A/R aging (as-of); statements; payments received; quote follow-up & conversion. Every report filterable and Excel-exportable. **The owner's actual go-to report list will be confirmed at implementation start (open item #3) — reports are cheap to add; the platform matters more than the initial list.**

## 8. Documents and the template designer

Eight document types: **traveler, shipper, MOS shipper, bill of lading, certification, invoice/credit, statement, quote.**

- Multiple templates per type; one default; **per-customer assignment**.
- Visual editor (Admin): logo upload and placement; header block; show/hide sections (steps on traveler, serials on shipper, results vs freeform on certs…); add/remove/reorder fields per section from a **documented field list per document type** (the data contract); standing text blocks (cert intro, liability, ending statements) edited in place; fonts/sizes; **preview against any real order** before saving.
- Templates are **versioned**; an edit never changes what an already-printed document looked like.
- Traveler barcode automatic. Every outgoing document stored as the exact PDF produced; reprint = same file.
- **Boundary (agreed):** structured customization of the eight types — not a free-form report painter. Truly exotic layouts become built-in custom templates during implementation.

## 9. Permissions and audit

- **Owner-defined roles** (no hard-coded list); per area (orders, parts, processes, customers, quotes, certs, shipping, invoicing, A/R, reports, templates, admin): **view / create / edit / delete**.
- **Named dangerous actions granted separately**: void/reverse shipper, unlock invoice, void order, change prices, edit cert results after print, apply payments, run QBO export, close A/R period, edit templates, manage users/roles.
- Per-user exception grants/denies on top of the role.
- Login: username + password; configurable session timeout; per-user signature image (certs).
- **Audit is not optional**: every create/edit/delete logged (who, when, before→after); History section on every record; searchable admin log; soft deletes only; destructive-ish actions require a reason.

## 10. Settings (one typed page)

Company/plant info; document numbering (order, shipper, invoice, cert, quote); date defaults (request days, traffic-light windows); invoice grouping; surcharge definitions; finance-charge rate; GL accounts and defaults; QBO connection; backup folder/schedule. Every setting typed and validated — no free-string switches.

## 11. Architecture and stack

- **Next.js (React) full-stack app + Prisma ORM + bundled PostgreSQL**, deployed as Docker containers (or a Windows service wrapper) on one shop-network box; HTTPS on LAN.
- Server-side **PDF rendering** for all documents (what makes templates data, not code).
- Nightly automated DB backups to a configurable folder + backup-now button; documented restore procedure; **practice database** (clearly labeled, obviously distinct UI banner) for training.
- Update model: update the server, everyone gets it on refresh. No client installs, no synchronizer, no build matching.

## 12. Data safety and error handling

- Order entry **autosaves drafts** — a crash or closed tab loses nothing.
- Inline validation while typing; save-time errors are specific and field-anchored.
- All multi-step operations (invoice creation run, QBO export) are **idempotent** — re-running or double-clicking cannot duplicate. (The finance-charge run was struck here on #162: finance charges are informational, computed at print and never stored, so there is no run and nothing that could duplicate — §7.6.)
- No repair tools by design: void/unlock/reverse paths with audit cover every correction scenario identified in Visual Shop's documentation (Fix Invoices, AR Utilities, MOS corrections, purges).
- Reads never mutate (no report side effects — a Visual Shop defect class explicitly designed out).

## 13. Testing and parallel-run acceptance

- **TDD throughout**: every business rule in §7 (pricing resolution, load math, status transitions, ship-line-complete, payment application, the finance charge's exclusion from Total Due, export idempotency, permission checks) gets automated tests written before implementation.
- Seeded demo data for the practice database.
- **Parallel run**: real work entered in both systems for an owner-chosen period; a built-in **comparison page** (orders entered, shipped, invoiced dollars by date range) checked weekly against Visual Shop's reports.
- **Acceptance criterion: one full month closed in the new system — A/R aging and the QuickBooks summary export agreeing with the books — before any cutover conversation.** Visual Shop remains system of record throughout.

## 14. Open items (inputs needed during implementation, none blocking design)

1. **Samples of the current printed traveler, shipper, cert, and invoice** (owner to drop scans/PDFs into the project folder) — drives default template layouts and the cert field set (heat/lot numbers on serials, etc.).
2. ~~**Finance-charge treatment in the QBO export** — settle with the bookkeeper (Visual Shop excludes FC from GL export entirely; confirm desired behavior).~~ **RESOLVED 2026-08-19 (§15, issue #162): finance charges are informational and post NOTHING**, so there is nothing to treat in the export — the same answer Visual Shop reached. Collecting interest means raising a real invoice, which posts as any other invoice does. Do not reopen this during acceptance work.
3. **Go-to report list** — which reports the office actually runs today.
4. **GL account list** for operations, surcharges, payment types, and plant defaults.
5. Confirm no shipping-label printing is needed (not selected; assumed out).

## 15. Decision log (owner Q&A, 2026-07-29)

| Decision | Answer |
|---|---|
| Scope | Order-to-invoice core + A/R + quoting IN; Sales Order Entry OUT (receiving happens straight in Order Entry) |
| Scheduling | **OUT** ("don't want scheduling at this time") — stays in Excel |
| Ship gate | None — "we just ship" |
| Daily cockpit | Order Management-style list → the new home screen |
| Extras | MOS/BOL, traveler barcodes IN; outside processing, inventory, CCM, dashboards, contract review, DOA, companions OUT |
| Platform | Self-hosted web app |
| Accounting | QuickBooks Online; A/R inside ERP + summary export (Visual Shop boundary) |
| Migration | **None** — start empty |
| Users | 1–5 |
| Certs | Commercial + ISO 9001 only |
| Loads | Routine and essential; loads ≠ containers; shipping decoupled from loads |
| Approach | **A — simplified engine**, amended with form designer + granular permissions |
| Keep despite simplification | Surcharge add-ons; finance charges |
| Confirmed unused | Assembly masters; automatic customer emails |
| Database | Bundled PostgreSQL |
| Design sections §1–§8 | Approved individually in session |
| Spec review change | Quantity **and** weight both required at order entry; parts auto-populate weight, process master, and active quote |
| Spec review change | **No order duplication** — double-billing risk |
| Spec review change | **Loads auto-split** from the part's load qty/wt at order save (Visual Shop behavior) |
| Spec review change | **CAR removed** — owner uses a separate CAR program; in-ERP rework deferred to a later phase |
| Spec (as amended) | **Approved by owner 2026-07-29** ("everything else looks good") |

### Amendments after approval (2026-07-30, Phase 2 planning)

| Decision | Answer |
|---|---|
| Part number uniqueness | **Unique per customer, never globally.** Work migrates between customers when their customer finds a cheaper source, so the same number recurs — and **the base chemistry can require a different recipe**. A part number alone therefore never identifies a part, and nothing about a part is ever inferred across customers from a matching number |
| GL accounts | **Own maintained reference table**, referenced (not free text) by process step codes, payment types, and surcharges. **Optional when keying a step code** — "configurable and not set in stone" — so masters can be entered before the accounting list exists; Phase 5 must refuse to export rather than post without one |
| Specifications | **On the part, many per part** (customer spec + industry standard can co-occur). **Not on the process** — the same process can yield ASTM grade 1, 2, or 3 depending on the customer's base iron (ductile iron), so the achieved grade is a property of the part, not the recipe |
| **Shared process masters** | **REMOVED — supersedes §5.1.** Nearly every step varies part to part (racking always; test type and location always; temper time/temp; austenitize time/temp/carbon potential; pre-heat often — only receiving is fixed and wash is yes/no), so a shared master would be an empty shell overridden everywhere. The one benefit of sharing — propagate an edit to many parts — is a thing this shop would never want, given chemistry-dependent outcomes. **The recipe belongs to the part** |
| Process Steps model | Part owns an ordered, **revisioned** list of Process Steps. Shared instead are: **Process Step Codes** (the billable reference vocabulary, carrying GL — Visual Shop's process codes, kept) and **Templates** (named, shop-built, ordered step codes + boilerplate, loading **structure with blank values only**). See `docs/2026-07-30-process-steps-model.md` |
| Copying recipes | **Deliberately not offered.** The only load source is a blank template. Copying another part's values is how one customer's chemistry silently becomes another's |
| Step fields | Each **Process Step Code defines which fields it exposes** (Austenitize: temperature/time/carbon potential; Hot Wash: none). Owner-configurable, same pattern as part custom fields. Typed fields print in a fixed place on the traveler and cannot be quietly omitted |
| Per-part step overrides | **No longer needed** — deleted from Phase 3 scope. The recipe is already per-part |
| Inspection requirements | Gain an **optional freeform location/notes field** (e.g. "Brinell @ flange OD") — some customers demand that specificity; free text avoids forcing structure on the majority that don't |
| Naming | UI says **Process Steps** for a part's recipe and **Process Step Code** for the billable reference table (replaces "Operation"). "Recipe" remains the shop's spoken word for the parameters |

### Amendments for Phase 2B (owner Q&A 2026-07-30)

| Decision | Answer |
|---|---|
| Customer identity | **Owner-assigned unique `code` alongside `name`** (e.g. `ACME`). Matches Visual Shop's customer-id key so staff carry the habit; gives order entry and global search something short to type, and gives documents a stable identifier when a company renames. Supersedes §5.1's name-only Customer. Part uniqueness remains `(customer, partNumber)` |
| Parent/child customers | **Modelled now** — a nullable self-reference. Most customers have no parent; divisions of one company can. Phase 2B stores and displays it only. Phase 5 A/R needs it so one check can pay several children's invoices and a statement can roll up (confirmed as real Visual Shop behaviour in the crossref findings). Modelled early for the same reason as surcharge opt-out and the finance-charge override: avoiding a migration once live A/R data exists |
| Salespersons | **Not used by this shop.** Nothing is assigned a salesperson, so the `Salesperson` reference table shipped in Phase 2A is unreferenced. It is **removed in Phase 2B** rather than left as an unused pick-list in the admin screens. Supersedes the salespersons entry in §5.1's Reference data row and §10's implied use. Spec §7.8's "sales by salesperson" report is likewise dropped from the initial report set |
| Serialization | **A real column on the Part** (`serializationRequired`, boolean), not an owner-defined custom field — owner decision 2026-07-30. The system acts on it: Phase 3 order entry validates against it, warning when a part flagged for serialization has no serial numbers entered. A custom field is inert and unreadable by that check. Settles kickoff open item 2 |

### Amendments for Phase 6 — Quoting (owner Q&A 2026-08-10)

Full design: `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` (its §3 records all fourteen rulings).

| Decision | Answer |
|---|---|
| Quote reference granularity | **Per order line**, not per order — each order line stores which quote line prices it. Supersedes §7.5 tier 1's "referenced on the order" wording; two parts on one order can sit on different quotes |
| Tier 1 substitution | **Wholesale per line**: a linked line prices from the quote's rows ONLY; the part's rows are ignored for that line, and a linked quote line with zero rows invoices as needs-price, never a silent part-price fallback |
| Quote validity | **Judged at link time** against the order's received date. A stored link prices the order through invoicing; later expiry or closure never silently re-prices. Closing warns and lists still-linked open orders |
| Auto-link ambiguity | **Latest effective date wins silently** (tie → higher quote number); always overridable at entry; overlapping open quotes warn at quote save but are not blocked |
| Quote edits | **Live until finalize** — invoices resolve quote rows at creation time (the part-price behavior); finalized invoices stay frozen. No snapshot-at-link layer |
| Quote lifecycle | **Standing agreement**: born numbered + OPEN, prices any number of orders in its window, close/reopen are deliberate reasoned acts (free-text reason), "expired" is derived from the expiry date |
| Quote scope | **Real customer required; part optional per line** — free-text lines are paper-only until a part is attached. No prospect/lead customers |
| Ending statements | **Built as the eleventh reference kind** (listed in §5.1's reference-data row, shipped late) — admin list with one default, per-quote pick, `text` body |
| User title | **`User.title` added** — prints on the quote signature block and closes Phase 4's cert-signature-title ping (HANDOFF §7.5.4) |

### Amendments for Phase 7 — Template designer (owner Q&A 2026-08-12)

Full design: `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` (its §3 records all seven rulings; approved 2026-08-12 including the `pdf-lib` dependency).

| Decision | Answer |
|---|---|
| §8 versioning | **Draft → publish**: prints resolve the last published version; drafts never print; discarded drafts are kept as append-only history (a status flip, never a delete). A print racing a publish may render the prior published version — "from that moment" means commit order, accepted by design |
| §8 editable surface | **Label overrides, number formats, date formats, and column widths** join the editor beyond §8's core list (widths with validation guardrails; the ticket tear-off goes flow-based) |
| §8 "steps on traveler" | The show/hide example is **superseded** by the 2026-07-30 Step-fields ruling — traveler templates cannot hide typed step fields or the barcode; the editor shows them locked and the config validator refuses a config that hides them |
| §8 fonts | **Curated bundled set** (4–6 open-source families vendored as `.ttf` assets); no font-file upload |
| §8 assignment | **Division inherits the parent's assignment**: resolution walks to the nearest assigned ancestor, then the type's default template. A template with no published version can be neither the default nor assigned |
| §5.1 Part | gains optional **`processName`** — prints on the traveler's Process: slot (live) and folds into the invoice's create-time `processNames` snapshot (blank falls back to the priced-operation join) |
| §10 Settings | the four standing-text keys (`cert_statement`, `shipper_liability_text`, `quote_intro_text`, `quote_liability_text`) **migrate into template content and retire from Settings**; company identity keys stay |

### Amendments for Phase 8 — Reports & parallel-run tools (owner approval 2026-08-14)

Full design: `docs/superpowers/specs/2026-08-14-phase-8-reports-parallel-run-design.md` (approved 2026-08-14 after a five-lens adversarial review; its §3 records rulings D1–D7 and §12 the resolved judgment calls). Builds as three sub-phases — **8A Reports + Scoreboard · 8B Practice DB + First-run wizard · 8C Backup polish**.

| Decision | Answer |
|---|---|
| §7.8 report set (fixed) | **Backlog, Shipped, Turnaround, Sales, Payments received** built new; **invoice register** (= the invoicing list) and **A/R aging** homed under `/reports`. **Statements stay the Phase 5 per-customer printed document** — not re-built as a report. **Sales-by-operation and a quote-conversion report deferred** (owner named part number; the Phase 6 follow-up worklist already covers the quote chase). Every report a filterable/Excel-exportable numeric table — **no charts** (§3 dashboard-graphs non-goal upheld) |
| §7.8 report bases | **Sales** = invoiced revenue **excluding sales tax**, by **`finalizedAt`** (ruling 8), net of credits, sliced by customer/part/finalized-month (part slice buckets non-part lines under "(no part)"); ties to the GL export's revenue accounts. **Payments received** = **POSTED-batch** payments by `receivedDate` (matches deposits/the close). **Turnaround** = received → full-`SHIPPED` completion, completion date derived from shipment `shipDate`s (no stored completion timestamp exists). **Backlog** includes `REOPENED`. **Shipped** = pounds & pieces, a new `shipDate`-windowed aggregate including released rows |
| §13 comparison scoreboard | **Our-numbers-only, eyeballed** against Visual Shop (no VS data entry, no variance). One page: orders entered (`receivedDate`) / shipped (lbs + pcs) / invoiced $ (**by `invoiceDate`** — owner steer, matches VS; a VS eyeball, not a books tie-out). Acceptance (§13) stays carried by aging + QBO agreeing with the books |
| §11 practice database | A **separate copy** (own `erp_practice` DB, own port), practice-vs-production decided by an **authoritative db-identity check** (`current_database() = 'erp_practice'`), not the env flag alone. **Representative-slice** demo data (no pre-closed month) seeded through the services. **Reset-practice-data** control, double-guarded (db-identity re-check), restoring the by-construction singletons. **Every practice PDF watermarked** PRACTICE/SAMPLE (a `pdf-lib` post-stamp) |
| §10/§11/§12 backup | An in-app **Backups page** (list + back-up-now + red staleness indicator where a **missing status reads overdue** + integrity check); the backup **folder is a shared deploy value**, not a live setting; nightly job stays; on-demand `pg_dump` spawned via argv with a validated path. **Restore = documented command** (no in-app button). **Alerting = in-app only**. Backups page is **production-only** (practice copy excluded) |
| §10/§12 backup — the 8C deploy + build values (owner, **2026-08-16**) | **`BACKUP_DIR=/backups`** (host `./backups`, mounted into `app` too; `app-practice` gets neither env nor mount). **`backup_stale_hours` default 36**; cadence and 30-day retention **unchanged**, and on-demand archives obey the same prune. **Green requires a recent success AND a clean last run** — a recorded failure is red immediately, and manual backups count as successes. **`lastSuccessAt` is derived from the newest integrity-passing archive**, so the status file needs no read-merge. Staleness surfaces on the page **and** in a `manage_backups`-only shell warning bar (a small, deliberate widening of "in-app alerting only"). A manual backup is **audited**. Full record: the 8C design spec's **§6.4** |
| New: first-run wizard + order gate | A **setup checklist** (dependency-ordered, live-readiness-driven, dismissible, remembers completion via a new `SetupState` singleton). **Real order entry is blocked** until **company identity (name+address+phone) AND a chart of accounts** are configured — a server-side readiness predicate at the single `createOrder` chokepoint. **Admin password change is recommended, not forced** |
| New: `manage_backups` action | A **new named dangerous action** (widens §9's "granted separately" list) gating the Backups page + back-up-now — owner-approved 2026-08-14 |
| The `reports` permission area | goes live (its nav link was a dead 404); a single `reports.view` grant gates the section |
| Invoice draft edits — the three §5.5 rulings (owner, **2026-08-17**) | **A manual override WINS, silently**: recalculate substitutes a hand-typed line into the slot of the derived line sharing its order-side identity rather than regenerating that line beside it (which double-billed), and **tax follows the override**. **No revert control** — the undo is remove the row, save, recalculate. **A manually added charge's GL account is assigned SERVER-SIDE** to the configured other-charge account, the same one an engine-generated charge gets; **no operator GL picker**, since the pick-list route deliberately excludes `glAccount` (ruling 15). **A $0 invoice is legitimate paper** (warranty, rework, no-charge) — finalize refuses an **empty line set**, never a zero total. Issues #61/#62/#63/#64 |

### Amendments after the accounting answers + Group C rulings (owner, 2026-08-17)

The annotated accounting question list (returned the same day it was prepared; transcription in
`docs/company-confidential/2026-08-17-accounting-questions.md`, HANDOFF §7 item 2) plus two owner
rulings taken at the Group C kickoff.

| Decision | Answer |
|---|---|
| §6/§13 point-in-time reproducibility — **accepted as-is** (Q22; closes #78) | A re-run of a past aging/statement reflects **current** status: corrections made after the period (a voided application, an unlocked invoice) shift the answer. Accepted because month-end reports are **printed and filed when they are run**; §6's reproducibility wording is narrowed to that filing practice. No temporal reconstruction is built |
| §12 QBO delivery — **the journal entry is keyed by hand** (Q1) | QuickBooks **Online** confirmed; the bookkeeper keys one summary journal entry per month from the stored posting register ("QBs can read PDF files"). **No import format is ever built** — IIF/connector/CSV are all moot. The export CSV + register remain as the keying source and the ERP-side record |
| Revenue split — **one step code per process** (Q12, ratified) | Nobody reads revenue-by-furnace, and the books already collapse every heat-treat service to one income account. Step codes are keyed one-per-process (~15–20), one revenue account each; Visual Shop's eight-way furnace split is deliberately not reproduced |
| §5.6 reversal pairs — **void is reversal-aware** (issue #65) | Voiding the **original** of a live reversal pair is **refused naming the reversal** (§5.14 shape) — with every live reversal fully covered by its live original, the net ledger stays ≥ 0 by construction. Voiding the **reversal** is the blessed undo: it restores the `lineComplete` flags the reversal itself cleared (recorded at reversal time; a human's re-decision in between is respected) and recomputes status. Invoiced pairs stay behind the §5.7 freeze — unlock is the correction route |
| §10 whole-set document coverage — **persist print-time coverage** (issue #52) | A whole-shipment ticket/BOL records **which orders it covered at print time**; an order's hub lists only paper that actually named it. Membership stays editable after a print (the printed paper is not falsified by a later addition — print a fresh BOL); the existing removal-after-print refusal is unchanged |
| §5.6 **a live reversal pair is FROZEN** (owner, 2026-08-18, issue #139) | Any edit to EITHER document of a live pair is refused naming the pair; the correction flow is the #65 one — void the reversal, edit, re-reverse. **The first slice is enforced on PR #141**: a second reversal of an already-reversed original is refused at creation naming the first (its previous protection — the below-zero arithmetic — was bypassable via a sibling shipment's quantity, and the void-restore's correctness depends on at-most-one-live-reversal). The edit-mutator guards on both sides are the remaining build (Group E) |
| §5.5 removal-after-print goes **coverage-precise** (owner, 2026-08-18, issue #140) | `removeOrderFromShipper` refuses only when a printed whole-set document actually NAMES the order (`coveredOrderIds`, recorded since #52) — an order added after the print, on no paper, removes freely; the refusal still names the covering document (§5.14). Build folds into Group E |
| §8 data fetching — **client components fetching in effects is the permanent architecture** (owner, 2026-08-18, issue #31) | The `react-hooks/set-state-in-effect` override becomes a documented decision, not a deferral: no fetch library, no Server Components migration — the build is complete and either would be a migration over working, tested paper for consistency rather than correctness. The discipline the lint rule cannot express is `src/lib/use-latest.ts` (tickets on both success and rejection paths) and its siblings, enforced by the Round 2 Group D sweep of every fetch-into-state page rather than one page at a time |

Four rulings taken 2026-08-19, after Round 2's grouped work closed (the remaining backlog was
entirely owner-gated; these four were put to the owner together).

| Decision | Answer |
|---|---|
| §5.5 a typed no-step-code price keeps absorbing — **accepted, the warning is the mechanism** (issue #134, closed) | A "needs price" line carries no step code, so it stands in for every priced operation on its order line **indefinitely**, including work priced after the figure was typed. Not narrowed: the stored state cannot distinguish "the work this price was typed for" from "work added afterwards", and the two review rounds that tried to guess produced a live double bill and then a live under-bill. `invoiceWarnings` flags the line on every mutating action, which removes the silence — the part that actually bites. Revisit trigger: if invoicing unpriced parts becomes routine rather than exceptional, the fix is a stored "first recalculate" marker |
| §5.10 early-pay discount — **earned only by a payment that SETTLES the invoice** (issue #69) | **Supersedes the same day's first ruling** ("the amount being paid"), which was put to the owner without its arithmetic: a flat percentage of the cash remitted strands \$0.40 on the ordinary case (\$1,000 at 2/10 settled by a \$980 remittance) and contradicts both the 5B design spec and a pinned test. Re-asked with the numbers, the owner ruled the other way: **a partial payment inside the window earns nothing at all.** This is a *settlement guard*, not a basis change — the eligible figure stays `discountPercent × the invoice's open balance`, which is what was already built. Settlement is judged against what is still **open**, never the original total, so a customer who part-paid earlier may still settle the remainder early and earn the percentage on what remains. **Two read sites move together** — `discountOffer` (named `discountAvailable` until #155 arm 2 widened it, 2026-08-20) offers the figure only when this payment's unapplied cash can close the remainder net of it (`cash ≥ open − eligible`), and `applyPayment` caps the DISCOUNT line independently, refusing unless the payload's cash + discount lands the invoice at exactly zero. **One detail below the ruling is the implementation's reading, not the owner's words, and is flagged for ratification: a `WRITE_OFF` in the same payload does NOT count toward settling** — `PAYMENT 950 + DISCOUNT 20 + WRITE_OFF 30` lands the invoice at zero and still earns nothing, on the reasoning that the discount is earned by a full early *payment* and absorbing a short-pay is the opposite of being paid early (reviewed and endorsed, with the further argument that counting it would open a `PAYMENT 500 + DISCOUNT 20 + WRITE_OFF 480` loophole). It is the tighter reading, it is pinned by its own test, and it is a one-line change if the owner reads it the other way. The frozen `termsDiscountPercent`/`termsDiscountDays` (#79) stay the only percentage source, with no fallback to the live customer relation. Consequence worth knowing: with the #81 entitlement cap also in force, a discount is now takeable only in the SAME call as the settling payment |
| §9 "destructive-ish" **defined**: cascades or frees an identifier (issue #8) | A delete requires a reason when it takes other records with it or frees a unique code for reuse — customer (built) and **role** (**built** since 2026-08-01, `47d6d0a` — the issue was filed and ruled against stale documentation; clears permission grants). Addresses, contacts, reference rows and step codes stay promptless: a reason prompt in front of routine cleanup is the cost this reading deliberately avoids. If the §5.14 guard is ever relaxed so a reference delete can proceed while records point at it, that delete joins the list |
| §3 contact delivery flags are **informational** (issue #4, closed) | A delivery flag (gets invoices/statements/certs/shippers) on a blank-email contact is allowed and validated no further. Automatic customer emails are a §3 non-goal and nothing in the app emails a document — documents are rendered, stored and printed — so the flag selects nothing and reaches nobody; it records how the customer wants paperwork sent. Phone-only contacts stay valid. Reopens only if email delivery is ever built (which would reopen the non-goal first), and the shape then is "allow, but never deliver" |
| §5.10 customer A/R stays **single-customer scoped** (issue #71, closed) | A parent customer's page shows that customer's own receivables, never a family roll-up. The defect this scope replaced was an unlabeled family list of invoices above a division-scoped net — a correct total that read as a leak — so a family view would have to carry a Customer column and widen the net with the rows. The shop does not chase money at the family level. Reopens if collections ever move to the parent (one remittance covering several divisions) |

### Amendments after the manual walkthrough (owner, 2026-08-19)

Seven rulings taken after the pre-acceptance verification pass — the demonstration dataset, the
45-screen sweep and the 14-chapter manual (`docs/manual/`). Writing an explanation of each control
is what surfaced most of these: a label that does not match the behaviour behind it survives every
gate the project has, because no gate reads labels.

| Decision | Answer |
|---|---|
| §5.10 the finance charge is **informational — it is shown, never levied** (issue #162) | "Assess finance charges" computes a figure, prints it on the statement, and does **not** bill it: `statements.ts` returns `totalDue: aging.net`, and `financeCharge` appears nowhere in the server outside its own calculator and the statement printer — never written to an `Invoice`, never posted, never aged, never exported, and recomputed from scratch on every print. **The posting half is deliberately not being built.** A statement is a courtesy document; the shop eyeballs the figure and raises interest by hand if it ever decides to charge it. That makes the SURFACE the defect: "assess" means *to levy* in every accounting context, and the paper prints a charge line above a Total Due that excludes it — internally inconsistent paper a careful customer would be right to ignore. The work is wording and presentation only: the control says plainly that the figure is not billed, and the statement stops implying the charge is part of the total. `Invoice.financeChargeExempt` stays dead under this reading (no service and no screen sets it; only tests write it) — commented so it is not re-filed. Reopens only if the shop decides to charge interest, which is the full A/R + aging + roll-forward + GL build, not a small one |
| §5.6 shipment reversal **gets a screen** (issue #161) | `POST /api/shippers/[id]/reverse` is implemented and covered by 17 unit tests, and **no screen could call it** — verified three ways (no client reference, no component reference, no E2E flow). A mis-shipped load that has already been invoiced is exactly what reversal exists for, so it gets a control on the shipment detail page beside Void, on the permission the route already enforces, with the reason prompt the service requires. Consequences: **`OrderStatus.REOPENED` becomes reachable from a screen for the first time** (it is reversal's only writer — `shippers.ts`; the board already offered a filter that could never match, and the schema comment calling the status "reserved" is stale), and the #65/#139 refusal messages that instruct an operator to "void the reversal, edit, re-reverse" become TRUE rather than naming an impossible step — the §5.14 route-out-of-the-block they always claimed to be |
| §3.19 **manual cert creation gains a scope choice** (issue #165, split from #161) | The same sweep found a second unreachable route: `POST /api/certs` has no UI caller, and the order hub's "Create cert for Load N" is hardcoded to LOAD scope — so no screen can raise an **ORDER**- or **SHIPMENT**-scope certificate if automatic creation ever misses one, or one is voided and must be re-raised at a different scope. Built with an operator-chosen scope. It must not reimplement uniqueness: **one-live-cert-per-scope-instance is service-enforced under the order claim and cannot be indexed** (a `Cert` has no unique column, and Postgres treats NULLs as distinct). Kept out of #161's diff — both are "an implemented route with no button", and reviewing them together would blur which change caused which finding. **Delivered 2026-08-21 with one NEW SERVICE RULE the surface exposed: a SHIPMENT-scope cert requires the shipment to actually CARRY the order.** The two automatic callers always passed a pairing they had written a statement earlier, so an unpaired (order, shipment) was unreachable and therefore unguarded; a hand-raised cert can name any pair, and one whose shipment never carried the order prints every quantity as ZERO under a bare order label — the same "printable record of nothing" the LOAD branch already refuses a bad load number for. Checked under the existing `claimOrder`, so a concurrent `addOrderToShipper` / `removeOrderFromShipper` serializes with it. **SHIPMENT scope also needed a new route rather than a relaxed schema:** `POST /api/certs` is `.strict()` and omits `shipperId` by a decision recorded in that file's own docblock, so `POST /api/shippers/[id]/certs` resolves the shipper from its path the way the LOAD route resolves the order — the decision was routed around, not reversed |
| §5.10 a cash application **keeps the payment's date; the lock is working** (issue #159, closed) | `applyPayment` dates every application at the payment's `receivedDate` and then guards the period, so once a month closes, cash received in it can never be applied — including on-account cash (reproduced: the demonstration dataset's closed 2026-07 carries $6,750 across three payments that cannot be allocated). **Ruled not a defect.** The cash-journal entry belongs to the date the cash arrived, and a late allocation genuinely does move a closed month's aging — which is precisely what the period lock exists to prevent silently. The reopen is the correct, visible, audited route rather than a workaround. Two things follow and are procedure, not code: **on-account cash is allocated before its month closes**, and when it outlives the month, unlock → apply → re-close is sanctioned and heavyweight on purpose. The `applyPayment`/`applyCredit` dating asymmetry (`receivedDate` vs `todayDateOnly()`) is **deliberate and stays** — for cash the date is when the money arrived, for a credit it is when the allocation happened |
| §5.10 written-off invoices are retained **until the write-off's own period closes** (issue #157) | #77 retains a fully written-off invoice at `open: 0` so the void stays reachable from the screen that made it (`openItemsForCustomer` filters `open <= 0`, so the row would otherwise vanish with its own undo — §5.14). Retention was unbounded in two shapes: the full write-off, and a partial standalone write-off later settled in cash. **Bounded by the write-off's period**: the undo stays available exactly as long as the correction is cheap, and once that month closes, voiding needs an unlock anyway — the row has stopped being a route out of itself. One check belongs to the implementation, not the ruling: **if voiding a write-off in a closed month is not already refused, hiding the row would strand the undo**, which is the exact failure the retention exists to prevent, and the ruling must be revisited rather than worked around |
| §5.10 "pay first, discount after" is **not a real remittance pattern** (issue #155 arm 1, closed) | #69's settlement guard and #81's entitlement cap compose to an empty set — since `percent × open < open` for any percentage below 100, a DISCOUNT-only follow-up call can never both settle the invoice and stay inside the cap. Customers remit the net figure in one payment, so today's behaviour is **correct and merely narrow**, not defective. The eligible basis does **not** change. The test pinning *which* message fires stays as it is, now documenting a deliberate narrowness rather than flagging a boundary to revisit, with a comment at the arithmetic so the empty set is not re-derived and re-filed |
| §5.14 the hidden discount offer **must name its route out** (issue #155 arm 2) | With terms of 2/10 and a payment inside the window, an operator entering a partial payment sees **nothing at all** in the Discount column — no control, no explanation — and cannot learn that 980.00 against that invoice would earn 20.00. The offer read returns **why** the figure is zero, and the operator-fixable case renders a hint naming the settling figure. **The hint names the cash that must reach THAT INVOICE, never what the cheque should have been written for** (shipped wording: *"Applying 980.00 here would earn 20.00"*): the server tests this receipt's UNAPPLIED cash, so on a receipt already partly spent elsewhere a "remit 980.00" phrasing is simply false — its face value can exceed 980.00 and still be refused. An earlier draft of this row illustrated the defect that way, which is the one phrasing the fix may not ship; `no terms discount` and `window closed` stay silent, because there is genuinely no route out of either. **Text-only, not a disabled control** — two E2E flows assert a row-scoped checkbox count of 0 on their partial applies, which a hint keeps green and a disabled checkbox would correctly fail. Arm 1's ruling is what makes the hint's wording stable: the figure that earns the discount is always the settling one |
