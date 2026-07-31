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
- **Finance charges**: plant rate + per-customer override; per-invoice dispute/exempt; idempotent run (re-running cannot duplicate); printable.
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
- All multi-step operations (invoice creation run, finance-charge run, QBO export) are **idempotent** — re-running or double-clicking cannot duplicate.
- No repair tools by design: void/unlock/reverse paths with audit cover every correction scenario identified in Visual Shop's documentation (Fix Invoices, AR Utilities, MOS corrections, purges).
- Reads never mutate (no report side effects — a Visual Shop defect class explicitly designed out).

## 13. Testing and parallel-run acceptance

- **TDD throughout**: every business rule in §7 (pricing resolution, load math, status transitions, ship-line-complete, payment application, FC idempotency, export idempotency, permission checks) gets automated tests written before implementation.
- Seeded demo data for the practice database.
- **Parallel run**: real work entered in both systems for an owner-chosen period; a built-in **comparison page** (orders entered, shipped, invoiced dollars by date range) checked weekly against Visual Shop's reports.
- **Acceptance criterion: one full month closed in the new system — A/R aging and the QuickBooks summary export agreeing with the books — before any cutover conversation.** Visual Shop remains system of record throughout.

## 14. Open items (inputs needed during implementation, none blocking design)

1. **Samples of the current printed traveler, shipper, cert, and invoice** (owner to drop scans/PDFs into the project folder) — drives default template layouts and the cert field set (heat/lot numbers on serials, etc.).
2. **Finance-charge treatment in the QBO export** — settle with the bookkeeper (Visual Shop excludes FC from GL export entirely; confirm desired behavior).
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
