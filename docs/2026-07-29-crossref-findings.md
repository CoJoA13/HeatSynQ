# Cross-Reference Findings — Reference Report vs. Training Manual

**Date:** 2026-07-29
**Documents compared:**
- `Visual-Shop-ERP-Reference-Report.md` — teardown compiled 2026-07-29 from Cornerstone's current support knowledge base (254 articles). Called **"report"** below, cited by line number (`L…`).
- `VisualShopTraining.pdf` — official classroom training manual, **July 2018**, 468 pages, by Jane Montgomery. Called **"manual"** below, cited by printed page (`p.…`). Screenshot-heavy; where the text layer was empty, findings were verified against the page images. (To look up a printed page in the PDF: PDF page = printed page + 2.)

---

## 1. Verdict

**The two documents align on substance.** They describe the same product, the same data model (order → load → part → step; quantity *and* weight; process masters built from standard steps via table keys; certs as first-class documents), the same module set, and the same workflows. No finding suggests either document describes a different system or is unreliable as a whole.

**They differ in three explainable ways:**

1. **Vintage.** The manual is a 2018 snapshot; the report reflects the 2026 knowledge base. A large set of modules in the report simply did not exist (or weren't trained) in 2018 — see §4. The manual's own consultant page says Visual Shop had "over 1,800 defaults" in 2018; the report counts 2,527 today. Same product, eight years of growth.
2. **Coverage.** The report deliberately excluded the companion products (Visual Track, Visual Archive, Visual Truck, Visual UPS, Visual Net) and has no chapter on the customer master or shop-floor tracking; the manual covers all of those but predates much of the configuration surface.
3. **Depth.** The manual carries screen-level field detail the report compresses; the report carries configuration-key and behavioral detail the manual never had.

**Genuine contradictions exist** — about 45 were found — but most are small (checkbox numbers, menu paths, procedure step order). Roughly a dozen are significant enough to affect a rebuild; they are listed in §2 and most are resolved not by arbitrating the documents but by checking **your live Visual Shop and how your shop actually uses it**.

---

## 2. Contradictions that matter for a rebuild

These change the data model, a business rule, or module behavior. For each: what the two sources say, and how to resolve.

### 2.1 Scheduling has capacity math the report says doesn't exist ⭐
- **Report** (L179, L424, L1562): "no calendar, capacity model or finite scheduling," "priorities and lines, no load calculation."
- **Manual** (pp.295–297, 328–330): the `Orders > Scheduling` module schedules at the **order-load-step** level with rate parameters — Lbs/hour, Qty/hour, Orders/hour, Time between orders, **Hours per batch, Lbs per batch, Time between batches**, Pieces/hour, Time per piece — Start/Total/Stop columns, a **Calculate** button, a **Make Batch** function that groups loads under a batch number, and Areas flagged **Batch vs Continuous** with Rate/$-per-rate/Capacity fields.
- **Why it matters:** this is the closest thing Visual Shop has to the salt-bath batching problem you named. The report essentially missed the module (its own Appendix A lists 20 orphan `[Schedule]` keys it never explains).
- **Resolve:** tell me whether your shop uses `Orders > Scheduling`, the Order Management/Expediting grid columns, the Hot List, or none of these — and what the real salt-driven sequencing rules are.

### 2.2 Login/credential model
- **Manual** (pp.3, 381–383): two generations — legacy numeric **passnumber**, and `[Security] new_security = Y` which switches to **username + password** with complexity rules, lockout, temp passwords, and forced-change flows.
- **Report** (Part XIV): documents only the passnumber model.
- **Resolve:** which does your shop run today? (A rebuild will have modern auth regardless, but the answer tells us what your operators are used to.)

### 2.3 Security permissions are richer than the report's model
- **Manual** (p.5): permission checkboxes are **tri-state** (black = permanent, grey = temporary, unchecked = none) with a **per-module Expire/Temp Date** for vacation-cover-style temporary grants; `Duplicate` copies one operator's security to another; Master Formats are templates.
- **Report** (L1263): plain boolean grid.
- Also: the manual documents **Module 28 (Part Maint, ~16 checkboxes)** and **Module 128 (per-tab hiding)**, absent from the report's module map; the report's Module 13 and shipping-hold checkboxes disagree with the manual (manual: cb3 sets a hold, **cb9 removes it**; report collapses to cb3). Module 63 "Quote Requests" is checkbox **7** per the manual, **3** per the report.
- **Resolve:** design question for later — how much of this permission granularity do you actually use?

### 2.4 Certification record identity is undefined — in both documents
- The cert list keys rows by `Ship/Ld#`, with a documented sentinel **"Ship# 0 prints cert for the entire order"** (manual p.100); an order can have **two certs** (an order-level cert plus a process-master-driven one, manual p.97); scopes are By Order / By Load / By Shipper (both docs). But **neither document defines the uniqueness rule** (order × format × load × ship-seqno?) or exactly when each record is created.
- Also conflicting: report says a Cust Control `Default Cert Id` **flips the order's cert requirement to Yes at save** (L738); manual says that's a separate `Cert Every Order` checkbox (p.48).
- **Resolve:** we'll model certs from how *your* certs actually behave — I'll need a few examples of real orders (single-shipment, partial-shipment, multi-load) and which certs they produced.

### 2.5 The cert format record is far bigger than the report shows
- **Manual** (p.99): the Cert Control format carries ~30 fields — copies, address-to-use, 2-side print, scope selector, liability statement, internal instructions, cert charge, intro text, per-section print toggles (Parts / Serials / Insp Requirements / Steps / Material / Proc Comments), spec printing choices, tracking-vs-manual results toggles, signature block (signer/title/name/company), before/after-signature text, logos 1–4, 32,000-char freeform.
- **Report** (L627): "default statements (cert intro, ending statement, etc.)". It also claims some sections "always print" — the manual's format record shows them as per-format Yes/No.
- **Resolve:** for the rebuild, your actual cert formats (samples of printed certs) are the spec.

### 2.6 Pricing hierarchy — the report contradicts itself
- Report L884–896 gives **three different orderings** of the price-resolution chain (the `=Y` list, the `=Q` list, and the "full typical chain"), and neither document specifies precedence **within** the step-level pricing tables (Screw/Washer vs Price Grid vs Process Inspection vs Process Grid…).
- The manual adds rules the report lacks: each invoice price row **displays which pricing source produced it** (p.141); generic step pricing must exist before customer step pricing (p.224); Part Maintenance pricing **does not expire** despite quotes carrying an Exp. Date (p.194); `zero_assembly_minqty` changes the minimum-charge algorithm entirely (p.198).
- **Resolve:** we'll map the pricing methods **your shop actually uses** (most shops use two or three of the ~eight) and spec only those, with a precedence you confirm.

### 2.7 Digital Order Approval — four conflicts in one module
- Purpose: manual says "capture data **after** order entry" (p.242); report says it's a **gate before the order can print** (L297). Stamps: manual says **no form exists to print them** (p.243); report names `dw_order_print_solar_sign` (L301). Operated from its own menu item (manual p.245) vs from Order Management (report L306). Stamps table path differs.
- **Resolve:** do you use DOA at all? If yes, how does it behave in your build?

### 2.8 Quoting — who is the quote about?
- **Manual** (pp.84–87): Billing Quotations is **customer-based** ("instead of particular parts"); part-based quoting is the separate Part Maintenance Quote tab.
- **Report** (L936): "Part ID is required for pricing, because customer id + part id is the match key."
- Follow-on conflicts: whether a salesperson is required (report yes / manual no); quote `Date` and `Quoted By` have two different definitions inside the manual itself (pp.179 vs 194); the quote-expiry key and arithmetic are named nowhere.
- **Resolve:** how does your shop quote — per customer, per part, both? What does quote expiry mean to you in practice?

### 2.9 A/R period control
- **Manual** (p.280): `[A/R] check_closing_dates` verifies invoice-lock dates against the last A/R close and warns on unlocking into a closed period — i.e., a period lock exists. Also: **Invoice Utilities can unlock a locked invoice and even move an invoice to a different customer** (p.271), and **finance-charge invoices never post to GL and are excluded from every export** (pp.274–278).
- **Report** (L1025): "no period lock beyond the closing record itself"; locking presented as one-way; finance-charge GL exclusion absent.
- **Resolve:** scope question — is A/R in or out of the new system (see Open Questions)?

### 2.10 Where inspection results and CCM appear in Expediting
- Manual: Tracking tab = tracking history only; a separate **Insp tab** shows results **plus Customer Communications** (pp.125–127, 348, 356). Report merges results into the Tracking tab (L586) and puts CCM elsewhere.

### 2.11 Order entry constraints the report understates
- **One process master per order**: "the Parts will all have to have the same Process Master assigned to be used together on one order" (manual p.92) — the report states this only as a sales-order variant behavior. First-order data-model rule.
- Part Maintenance **required fields**: Part ID + Customer + Process ID (unless assembly) per manual pp.39, 188; report says only a confirmation prompt guards blank id/name/description.
- A process master **must contain at least one inspection record** (manual pp.30, 34) — nowhere in the report.
- The **Steps tab** in Order Entry (per-order step add/insert/delete, red-diamond targeting, per-order inspection edits, manual pp.67, 96) is missing from the report's order-entry cascade.

### 2.12 Smaller conflicts, noted for the record
- Fax is a first-class output channel in 2018 (Print/Email/**Fax**/Label; cert print offers Printer/Fax/Email + Preview) — absent from the report.
- Word-insert semantics: manual binds inserts to **database column names** with table-prefix disambiguation and leaves the **literal `[token]` in the output** when unresolved (pp.373–375); report says **form field names** and unresolved-**blank** (L749, L634). Manual also says shipper-message inserts work on exactly **one** form (`dw_ship_form_ms_valmont_australia`) — possibly a single customer's bespoke feature, not a platform capability.
- Cert edits must be **saved and re-retrieved** before printing (manual p.100) vs the report's continuous flow (L623).
- Signature image spec is internally inconsistent in the report (72×288 px = 1:4, but 0.853″×2.062″ ≈ 1:2.4) (L697).
- Expediting search: "800+ days, back to the first order" (manual p.336) vs "ten years" (report L428). Module 13 cb1 semantics disagree.
- Part Maintenance list behaviors attributed to the wrong generation of the screen (report L539 vs manual pp.163–165); the 2018 new list was "still under construction."
- CAR: values table path and where part reworks are created disagree (manual pp.227, 236–238 vs report L1041–1043).
- Procedure-order conflicts in invoicing/cash application (Add Ord to Inv#, credit creation, Place OAC, credit-only application) — the manual and KB describe different keystroke sequences. Low stakes for a rebuild (we won't replicate keystrokes), but don't trust either doc for exact 2018 vs 2026 procedure.
- Literal-value conflicts: `dw_order_header_entry_caltech_1` (manual) vs `dw_order_header_caltech_1` (report); `PEACHTREE` vs `PEACHTREE_DDE`; `T_validate_container_id` vs `VT_validate_container_id`; `keey_overlay_history` (manual, sic) vs `keep_overlay_history` (report); ACH batch payment-type key; `VT_idle_timer` 600 vs 180; `eq_cycle` Y vs N; two different barcode grammars (`*/EEID/E1315*` vs `%EID%XXXX` family — possibly two scanning contexts).

---

## 3. What the manual has that the report lacks (major gaps in the report)

The report is the better *design* document, but it must not be treated as complete. If we build from it alone, we'd miss:

1. **The customer master entity — entirely.** The manual (pp.42–61) documents the full customer record: compound key (**Plant ID + Cust ID**), alpha key, customer-vs-prospect type, parent-customer linkage (one check pays multiple child customers' invoices — confirmed on the A/R side too), COD/credit-hold/active/review flags, house/general/internal account flags, taxability, mass-email eligibility; typed addresses (Ship To / Bill To / Received From / Other) with per-contact document-type subscriptions; per-customer **Inv Control** overrides; per-customer **form overrides** (11 document types); Cust Control fields with real business rules — `Release Level` (blocks order release), `PO Required` (no release without PO), **Max Deviation Percent** (qty/lbs receiving tolerance), `Require Serial Numbers` (blocks shipping), `Pcs per Container` (auto-generates container rows), default routes/carriers/instructions, freight capture, step-pricing groups.
2. **The Part Maintenance data model** (pp.163–214): required fields; **three distinct hold flags** (On Hold = blocks release+shipping; Shipping HOLD = shipping only; Inactive = hides from search); the user-field inventory (`User0–160` numeric, `s_user1–55` string, `d_user1–6` date, `cb_user1–40` checkbox, with lengths); field lengths (spec 150, instruction fields 255); Inspections 1–10; the load/rack planning block (**Qty per load / Lbs per load used when splitting orders into loads** — relevant to your batching); GL derivation from part Process/Equip/Group/CC; the **Formulas subsystem** (Excel-like computed fields with mass-apply, color-coded required columns); duplication rules (picture sharing pitfall, price zeroing); **Find/Replace Assembly Masters** and **Part Maintenance Process Change** modules; part-aware **process-master revisioning** (parts pinned to old revisions don't auto-update — the report claims no versioning exists).
3. **Shop-floor tracking (Class 11, pp.289–332)** — excluded from the report by request, but it defines semantics the core system depends on even without tablets: tracking templates with ~18 behavioral flags per row (mandatory weigh/count thresholds, split-by-wt/qty/container, overlap, repeats, accept/reject reconciliation), the Area table (**Batch vs Continuous** equipment type, rate/capacity fields), **reject → hold state machine that blocks shipping** (release only via Change Order Status), gap-time capture, and the template override chain (table key → master step → part overlay — with the trap that Order Tracking Maintenance applies only the table-key default).
4. **The `Orders > Scheduling` module** (pp.328–330) — see §2.1. The single most relevant gap for your stated needs.
5. **Cert format record and cert module chrome** — see §2.5; plus Print Now is **Yes/No/Multi**, Print/Change overrides a full address/parts/serials/inspection set, "No Print Notes" internal field, requirements-vs-results printed sections.
6. **Shipping screen detail**: freight fields (Frt Bill / Frt $), container **move** interface (not read-only), per-serial `Print On Shipper` flags, per-load `Done` checkbox, Print Cert from Shipping, Override button, MOS print/display controls.
7. **Invoicing/A-R depth**: the **Pre-price** document type; **print-before-lock** rule; **Invoice Utilities** (unlock, change customer, distribution maintenance); per-row **pricing-source display**; `Update Part M` write-back; Set to No Charge; the entire `Billing > Pricing` menu (bracket/step price codes with 15 break tiers, memorized price maintenance, PPG); terms-based cash discounting; parent-customer payments; batch close hard-blocks (named reports must print, batch must balance).
8. **Equipment table detail** (p.18): numeric-only ID, primary/secondary, **Batch/Continuous flag**, production-schedule flag, calibration dates, SSI trend hooks, rate fields, the "999 – Miscellaneous" convention.
9. **Companion products** (Visual Archive document imaging w/ barcode auto-filing; Visual Truck deliveries/signatures; Visual UPS → WorldShip; SSI Furnace Link — the equipment integration you've excluded; Advizor BI; "Visual Accounting" — whose 2018 marketing sheet is visibly recycled from a golf-club product, so treat its claims skeptically).

---

## 4. What the report has that the 2018 manual lacks (post-2018 features)

Confirmed absent from the entire manual by full-text search — these are the "newer Visual Shop" surface. **For each: does your shop use it?**

- **Order Management** module (and whether `[Order Management]` is a real INI section or a renamed `[Expediting]` — the report's own appendix duplicates all 68 keys under both names)
- **Hot List**; **Flex Scheduling** (requires "Visual Shop HD"); the graphs **Dashboard** (Module 29)
- **CRM ticketing**; standalone **CCM** module
- **Contract Review** (both generations); the modern list views (`use_new_search_list`, order-entry dashboard)
- **Sales Order Entry / Receive Parts / Batch Print / SWD & MDP imports** (sales orders existed in 2018 — a lone "TC No" reference — but were untrained)
- **Kanban shipping**; **pickups/signature pads**; **available-to-ship email notifications**; **delete-vs-reverse shipper controls**; the stop-shipment gate family (past-due, credit-limit, credit-hold, not-inspected)
- **Certification by process**; cert-charge plumbing; the `{insert}` cert templating vocabulary; manual-inspection-result entry configuration
- The **order status vocabulary** (N/R/G/C/P/S/I/D/O) with cumulative notification semantics; the **four-level due-date chain**; review/inactivation gates; serial **range-expansion** (`EC{001-025}`); the three-channel notes architecture; order-part-detail popups
- The **add-on/surcharge subsystem**; pricing-hierarchy config keys; Fix Invoices batch repair; Monthly Purge; AR Utilities; named GL interfaces (Sage 100/200 SQL link, QuickBooks Online…)
- **OAuth email** (Microsoft/Google); mass email; **keyboard shortcuts** (F1/F2/F3/F4/F9 etc. — the 2018 manual documents none)
- The whole **Program Defaults engine** description (INIprofile, station overrides), Station ID methods, and the modern infrastructure guidance (specs, backups, synchronizer, upgrade procedure)

---

## 5. Holes in *both* documents (only you / your live system can answer)

1. **Salt-quench scheduling rules** — neither document knows your constraints. The manual gives the machinery (batches, rates, areas); what drives sequencing in *your* shop (salt temperature? chemistry? fixture availability? load compatibility?) is undocumented anywhere.
2. **Cert record keying** and dual-cert creation timing (§2.4).
3. **Pricing precedence** — final order, and within step-level tables (§2.6).
4. **Load-split side effects** — what happens to containers, serial numbers, order-level charges, and promise dates when an order splits into loads. Undefined in both.
5. **`Ship Line Complete` vs per-load `Done` vs load `Status`** — three completion flags, interaction never stated.
6. **"Entry Status"** filter on the order list — values never enumerated.
7. **DOA gating semantics** — must all three roles approve? What state is "neither approved nor held"?
8. **Order Check validations** (Cust Control) — the manual's three checkboxes carry two duplicate descriptions; unrecoverable from documentation.
9. **Permission evaluation defaults** — both docs hedge that module access "may" suffice without checkbox 1 for "many" modules, enumerated nowhere.
10. **Quote expiry** — key, arithmetic, and what expiry actually governs (given "Part Maintenance pricing does not expire").
11. **Due-date traffic-light evaluation order** (May Miss vs Will Miss windows overlap).
12. **Step-overlay behavior when the target step is deleted** — retarget or orphan? A real correctness hazard for released routings.
13. **Month-end close semantics** — what the closing record writes, reversibility, transactions dated into a closed period.
14. **Document numbering** — invoice/credit sequences, and what `Seqno` is relative to document numbers.

---

## 6. Implications for the rebuild plan

- **Use the report as the primary design reference** for behavior and configuration (it's current), **corrected by this findings list**, and **use the manual for screen/field-level detail** (customer master, part maintenance, cert formats, tracking/scheduling) — then **verify against your live system**, which is the only current, complete source of truth.
- **Your live Visual Shop database is the third document.** Since you run it today, the fastest way to close most of §5 is to look at real data (with your permission, during the design phase): actual cert records, actual pricing rows, actual schedule usage, actual config (`INIprofile`) — which also tells us exactly which of the 2,527 defaults your shop has set, i.e., which behaviors matter.
- **Scope control is the whole game.** Visual Shop is ~20 modules plus companions; your shop almost certainly uses a fraction. The questions below cut the problem to what you actually need for parallel testing.

---

## 7. Open questions

### A. Scope — which of these does your shop actively use today? (in/out for the new system)
| # | Area | Notes |
|---|---|---|
| A1 | Order entry → certs → shipping → invoicing | Assumed IN — the spine |
| A2 | A/R (batches, payments, statements, finance charges) | If IN: which accounting package receives the GL export? |
| A3 | Quoting (Billing Quotations / Part Maint quotes / follow-up dashboard) | |
| A4 | Sales Order Entry / Receive Parts / Batch Print | Dock staging workflow |
| A5 | Quick Track / final inspection (the manual step-completion gate) | You said no shop-floor tracking — but does *someone* mark steps/final-inspect to make orders "available to ship"? |
| A6 | Order Management / Expediting grids — which do your CSRs live in? | |
| A7 | Scheduling: `Orders > Scheduling` / grid columns / Hot List / none | See §2.1 |
| A8 | Contract Review / Digital Order Approval | |
| A9 | CAR / reworks | |
| A10 | Inventory & purchasing module | |
| A11 | CCM / CRM / mass email | |
| A12 | Outside processing PO printing | |
| A13 | Kanban shipping / MOS (multi-order shippers) / bills of lading | |
| A14 | Dashboard graphs | |
| A15 | Companion products: Visual Archive / Truck / UPS / Net portal | |
| A16 | Barcodes anywhere (order travelers? operator badges?) | |

### B. Scheduling (the load-bearing questions)
- B1. How is the schedule built today, and by whom?
- B2. **Describe the salt constraints in your own words:** what makes job A run before job B? (e.g., pot temperatures and change cost, process compatibility, fixture/rack limits, load size vs pot capacity, customer promise dates…) No assumptions from me — this section of the spec will be written from your answer.
- B3. What should the new system's scheduling view *do* — visualize and sequence (like today, but better), or also calculate (estimated start/finish times per load)?

### C. Environment & approach
- C1. How many users, and roughly what roles (order entry, CSR, quality, shipping, billing, admin)?
- C2. Web app vs desktop; self-hosted vs cloud?
- C3. Parallel-run mechanics: dual-enter orders in both systems, or should the new system import/sync master data (customers, parts, processes, pricing) from the live SQL Server? One-time import or refreshed?
- C4. Forms: can you provide samples of your current printed order traveler, shipper, cert, and invoice? (These are the templates that matter — not the ~1,100-form library.)
- C5. May the design phase read your live Visual Shop database (read-only) to resolve the §5 unknowns?

---

*Compiled from six parallel cross-referencing passes over both documents. Citations: manual printed pages (PDF page = printed + 2), report line numbers.*
