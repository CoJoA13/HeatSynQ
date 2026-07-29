# Visual Shop — ERP Reference Report
### A functional and configuration teardown of the Cornerstone Systems "Visual Shop" job-shop ERP, compiled as a design reference

**Compiled from:** the public Visual Shop support knowledge base at support.visualshop.com (Freshdesk portal, Cornerstone Systems, Inc.)
**Scope of harvest:** 35 knowledge-base folders / **254 articles**, read in full.
**Excluded by request:** *Other Programs for Visual Shop* (Visual Archive, Visual Track original / 2.0 / Mobile, Visual Truck, Visual Truck Mobile, Visual Capture, Visual Net, Visual Portal, All Other Programs), all *Videos* folders (Quick Lessons, Tutorials, Features), and *Newsletters / Email Announcements*.
**Compiled:** 2026-07-29

---

## How to read this document

This is a **design reference, not a user manual.** Descriptions are written in my own words; what is reproduced verbatim is *factual identifier data* — configuration section names, key names, key values, database column names, form (DataWindow) names, security module and checkbox numbers, status codes, menu paths, file names and hardware specifications. Those identifiers are the substance an ERP designer needs, and they are reproduced exactly as the vendor documents them.

Hierarchy is preserved three ways:

1. **Functional hierarchy** — Part → module → sub-feature → configuration keys → security → forms (Parts I–XVII).
2. **Configuration hierarchy** — the complete Program Defaults registry: 93 sections, 2,527 keys, with default values (Appendix A).
3. **Source hierarchy** — every source folder and every article title, in the vendor's own tree, so any statement here can be traced back (Appendix B).

Notation: `[section] key = value` is the vendor's own shorthand for a Program Default. `dw_*` names are PowerBuilder DataWindow objects — i.e. report/form definitions compiled into `.pbl` libraries. "Module #n, checkbox #m" is the security coordinate system.

---

## Part 0 — Executive summary: what Visual Shop actually is

Visual Shop is a **make-to-order service-shop ERP for metal processing** — heat treating, plating, anodizing, coating, peening, galvanizing, brazing, sorting. That single fact explains nearly every design decision in it, and it is the most useful thing to understand before borrowing any of its ideas.

The defining characteristic is that **the shop never owns the material.** A customer sends parts in; the shop performs operations on them; the same parts go back out. There is no bill of materials, no finished-goods inventory of product, no MRP explosion. What replaces the BOM is the **Process Master** — a named, reusable routing of steps. What replaces the inventory ledger is the **order/load** structure that tracks somebody else's parts while they are in the building.

Five structural consequences worth stealing or consciously rejecting:

- **Quantity *or* weight.** Every order line must carry a quantity or a weight (or both). Pricing, shipping, tracking and invoicing all handle both units natively, plus containers, gross/tare/net weight, and serial numbers. A design that assumes "each" as the only unit cannot model this business.
- **Order → Load is the real work unit.** An order can be split into loads (by quantity or weight, with furnace/belt capacity ceilings), and loads move, get inspected, get held, get shipped, and get certified independently. Nearly every screen, report and status is addressed as `order_id / load` or `order_id / ship_seqno`.
- **The certificate is a deliverable.** A certification of conformance is a first-class document with its own numbering, formats, inspection results, signatures, charges and print/email lifecycle. In aerospace and automotive supply chains it is the reason the customer pays.
- **Configuration lives in the database, not in code branches.** A single table, `INIprofile`, holds 2,527 documented switches addressed by *(station_id, section, key_name)*. Behaviour, screen layout, form selection, pricing hierarchy and validation are all data.
- **Forms are data too.** Roughly 1,100 distinct printable form objects exist, selected by program default. Instead of a template engine, the vendor ships a very large library of per-customer variants — which is simultaneously the system's greatest flexibility and its largest maintenance liability.

Technology: PowerBuilder client (`htshoppbd.exe`) against Microsoft SQL Server, deployed as a fat client to a shared `C:\htsw` folder, synchronized to workstations with a file-copy tool. Windows-only, including for shop-floor tablets.

---

## Part I — The configuration engine (Program Defaults)

### I.1 Storage model

All settings live in one SQL table, `INIprofile`, with these columns (confirmed from the vendor's own insert script):

| Column | Purpose |
|---|---|
| `profile_name` | Legacy origin marker; every row carries `'ht.ini'` |
| `station_id` | Scope: literal `'DEFAULT'` for plant-wide, or a workstation's Station ID for an override |
| `section` | Functional grouping, e.g. `Orders`, `Shipping`, `Invoicing`, `Menu` |
| `key_name` | The setting name |
| `key_value` | Short value |
| `key_value_long` | Long value (`varchar(max)`); used when the value is a path, SQL snippet, address list or block of text |
| `creation_date`, `creation_op` | Audit stamp (operator id) |

The resolution rule is simple and worth copying: **a row matching the current Station ID overrides the `DEFAULT` row for the same section/key.** That single mechanism gives per-workstation printers, per-workstation screen variants, and safe staged rollout of a behaviour change to one desk before the whole plant.

### I.2 Maintenance UI and its rules

Path: `Maintain > Program Defaults > Change Defaults`. Workflow the vendor documents repeatedly:

- Pick the **Section** from the dropdown.
- To change a value: double-click the row and edit `key_value` in the detail pane below, then Save.
- To add a key in an existing section: highlight any row, click **Duplicate**, overwrite key name / key value / description, Save.
- To add a **new section**: click **New Entry** and populate all required fields.
- To scope a key to one workstation: Duplicate, then change **Station Id** from `DEFAULT` to the station name.

Two behavioural rules that constrain the design:

- **`[menu]` keys require a restart.** Anything that adds or removes a menu item (`sale_orders`, `show_receive_parts`, `mass_email`, `flag_shippers`, `use_dashboard`, `show_digital_order_approval`, `new_plant_support`) is read at application start; Visual Shop must be closed and reopened.
- **Change history is optional.** `keep_defaults_history` records changes to defaults; `new_default_maint` switches to the newer maintenance window. For an audited system, history should not be optional.

A companion SQL script, **`AddDefaultsToDatabase.sql`**, seeds the modern-UI switches idempotently (`IF NOT EXISTS ... INSERT INTO INIprofile ...`) for: Order Management list, new Process Master window, new Plant Support, Order Entry list, Billing Quotations list, Invoicing list, Part Maintenance parts list, Dashboard, Proof of Delivery list, Flex Scheduling and Email. The vendor's own quick filter for auditing which modern features are on is a key-name whitelist: `use_new_search_list`, `use_new_window`, `new_plant_support`, `use_dashboard`, `show_dashboard`, `open_with_vs`, `new_pod`, `flex_schedule`.

### I.3 Station ID — five ways to set it

Station ID is the scoping key for everything workstation-specific (above all, printers). Maximum **8 characters** in every method.

| # | Method | Detail |
|---|---|---|
| 1 (recommended) | Shortcut argument | Append `/s:<stationid>` to `htshoppbd.exe` in the shortcut target; `/p:<costcenter>` sets cost center too. Example: `c:\htsw\htshoppbd.exe /s:Jane /p:TX` |
| 2 | Derive from computer name | `[defaults] ComputerNameAsStationID = Y` — fastest way to stamp many workstations at once |
| 3 | `ht.ini` | Add `Station_id=` under the `[Tracking]` section of `c:\htsw\ht.ini` (create the section if absent) |
| 4 | `Visual Shop.ini` | Add `Station_id=` to the `[sqlca]` section and save as `c:\visual shop.ini` (one space in the filename) |
| 5 | Environment variable | Create user variable `vsclient`, then launch with `C:\htsw\htshoppbd.exe /s:%vsclient%` |

Verification: `Help > About Visual Shop` shows the resolved Station ID. **Caution the vendor flags twice:** a stray `C:\Visual Shop.ini` silently overrides `C:\htsw\ht.ini`, which has caused connection and station-id troubleshooting dead ends. Precedence between multiple ini sources is undocumented — a genuine design flaw to avoid.

The dominant real-world use is **per-station printer routing**: duplicate a key in the `Printers` section, change Station Id to the workstation, and point the specific form (order form, label, cert, invoice) at that station's printer.

### I.4 Scale of the configuration surface

93 sections, **2,527 keys**. That is the number that should give any ERP designer pause: it is the accumulated cost of never saying no to a customer-specific behaviour request. The largest sections by key count are listed below; the full registry with default values is **Appendix A**.

| Section | Keys | What it governs |
|---|---:|---|
| `Orders` | ~330 | Order Entry behaviour, validation, screen variants, notifications, contract review |
| `Shipping` | ~200 | Shipper creation, MOS, holds, availability, labels, notify |
| `Invoicing` | ~200 | Pricing hierarchy, add-ons, GL numbers, invoice creation rules, form selection |
| `Reports` | ~150 | Which report variant each menu item runs |
| `parts` | ~120 | Part Maintenance fields, custom tabs, PDFs, required fields |
| `Certifications` | ~100 | Cert creation, signatures, PDF/email, results entry |
| `Tracking` | ~100 | Shop-floor tracking behaviour |
| `Email` | ~90 | Provider, addresses, per-form subject/body/attachment naming |
| `Expediting` | ~80 | Customer-service screen layout and pop-ups |
| `Menu` | ~60 | Which modules appear at all (restart required) |
| `order printing` | ~50 | Order form, labels, outside-processing PO |
| `A/R`, `Order Management`, `Process`, `Quotations`, `Security`, `Inventory`, `Load_Split`, `dashboard`, `Schedule`, `Printers`, `defaults`, `license`, `customer`, `notes`, `ccm`, `CAR`, `Pickups`, `MOS_corrections`, `part_custom_window`, `quick track`, `manual inspect`, `receive parts`, `SaleOrders`, `bill_of_lading`, `order label`, `order_status` … | remainder | see Appendix A |

**Design takeaway.** The idea is sound and worth adopting: a typed settings registry with scoped overrides, editable at runtime, no redeploy. The execution is where to diverge. Specifically: give keys a declared **data type and allowed-value domain** (a great many of these are `Y`/`N` but a meaningful minority are enumerations like `Y/N/A/B/C`, form names, comma-positional tuples, or free text, and nothing enforces it); make history **mandatory**; add **dependency declarations** (dozens of keys silently require another key, e.g. `avail_list_show_all` only works when `avail_order_list=Y`); and above all resist letting customer-specific behaviour become a new key — the 2,527 keys are, functionally, 2,527 untested code paths.

---

## Part II — Master data model (Plant Support)

All reference data lives under `Maintain > Plant Support` (hot key `Ctrl+L`). There are two generations of this screen; `[Menu] new_plant_support = Y` switches to the newer tabbed layout, and the documentation describes both because both are in the field. In the new layout tables are grouped by domain (General, Orders, Customer, Table Keys, Part Maint Tables, Process Masters, A/R Invoicing, Custom, Special Tables).

### II.1 The four tables everything else depends on

**Group Name** — a grouping abstraction deliberately left loose: a line, a set of similar equipment, a department, or any other reporting rollup.

| Field | Notes |
|---|---|
| `Group ID` * | Alphanumeric; short, may need abbreviating |
| `Group Name` | May duplicate the ID |
| `Max Load`, `Min Amps`, `Max Amps`, `Amp Incr`, `Color Name or Number`, `Bitmap` | Consumed by custom forms only |
| `Group Type`, `Group Area` | Used by the TPS function |

**Material ID** — the material the *customer* sends in. Every Process Master requires one. The vendor's own convention for the general case is a material called `Various`. A name should always be entered even if identical to the ID, because the name is what prints and displays.

**Inspection Scale** — the measurement scales you report results on (`Scale`, `Description`). Entirely user-defined.

**Inspection Codes** — the *types* of inspection performed (`Inspect Code`, `Inspection Name`, optional `Scale`, plus `On Cert` / `On Shipper` checkboxes read by some forms). The vendor is explicit that this is a name only — the *method* belongs in step text, not here.

**Process Codes** — what you do, and simultaneously the invoicing line-item vocabulary.

| Field | Notes |
|---|---|
| `Process Code` * | The operation name |
| `Name`, `Description` | Description optional |
| `Valid In Process Master Only` | `Y`/`N`, default `N`. `Y` = usable to search for a master but no steps may be written against it |
| `Color Name or Number` | Custom forms |
| `Category` | Various custom functions |

### II.2 Table Keys — the join table at the centre of the system

The documentation labels this **"EXTREMELY IMPORTANT"** and it is the single most important structure to understand. A Table Key is the intersection of **what you do** (process code) with **where you do it** (equipment / group / cost center). It is consumed by step writing, quotations, invoicing, order entry, process masters, process pricing, GL posting and tracking — effectively the whole system.

| Field | Purpose |
|---|---|
| `Table Name` | Leave as `STANDARD` |
| `Process Code` * | From Process Codes |
| `Eq ID` | From Equipment |
| `Gr ID` | From Group Name |
| `Cc ID` | From CC Name |
| `Trak Temp ID` | From Tracking Template — links the key to shop-floor tracking |
| `GL#` | General ledger account for this combination; consumed at invoicing/GL posting |
| `Key Code` | Custom report use |
| `Item NOT priced` | Exclude this combination from pricing |
| `Pricing Item Only` | Combination exists for pricing only, never as a step |
| `Min Chg` | Minimum charge for the key (not honoured by every invoicing option) |
| `Step on cert`, `Step comm on cert` | Whether the step / its comment prints on certifications (form-dependent) |
| `Signoff` | Print a sign-off block on the order (form-dependent) |
| `Spec Trk Step` | Custom tracking flag |

Two hard rules: **to write standard steps against a key you must supply an equipment, group *or* cost center in addition to the process code**; and if `costcenter_as_plant = Y` is in use, a table key must exist for the process code *with* cost center or pricing will not generate at all.

**Comma-positional key syntax.** Where a program default needs to name a Table Key, the value is a four-slot tuple `process,equip,group,costcenter` and **all three commas are mandatory** — position carries the meaning. Process code only: `"ProcessCode,,,"`. Equipment only: `",Equip,,"`. Group only: `",,Group,"`. Cost center only: `",,,CC"`. The more slots you fill, the more specific the match a step must satisfy to trigger. `[order printing] Outside_po_key` is the canonical example. This is compact but fragile — a positional, unvalidated, delimiter-sensitive string in a settings table is exactly the kind of thing to replace with structured fields.

**GL resolution order.** GL numbers may be assigned on the **Equipment** table or on **Table Keys**. Visual Shop reads Equipment first; if a GL is present there it *overrides* the Table Keys GL. Plant-level fallbacks live in defaults: `[Invoicing] sales_gl_number` (debit side for invoices), `[Invoicing] credit_gl_number` (credit side for credits), and for cash application `[A/R] AR_GL_number`, `check_gl_number`, `discount_gl_number`, `adjustment_gl_number`, `writeoff_gl_number` — each of which may instead be left blank and driven from the **Payment Types** table.

### II.3 Other reference tables referenced across the KB

Equipment; CC Name (cost centers); Carriers; Routes; Areas (`Area Id` and `Plant` required, `Area Title / Schedule Id` recommended); Tracking Template; Tracking Type (default is Track In / Track Out); Container Types; Payment Types; Terms; Sales Persons; Ending Statements; Comments (by Comment Type, with copy-to-step support); Reasons (typed lists, e.g. `Orders On-Hold`); Stamps Table (file paths to approval stamp images); Certification Control (cert formats); Cert by Process; Customer Categories and Sub-Categories; Car Values (CAR/rework enumerations); Cust User Field Names (up to 12); Required Part Fields (with a per-field *Do Not Dupe* flag); Invoice UOM (the price-per vocabulary); Price Keys; Convert to Decimal (diameter → decimal); Email Groups; Archive / Purge Control; Custom > Contract Review (question set); Special Tables (misc. enumerations).

**Design takeaway.** The Group / Equipment / Cost Center / Process Code lattice joined through one Table Keys table is genuinely elegant for a process shop: it simultaneously defines routing vocabulary, pricing granularity, GL mapping and tracking templates. The weakness is that it is *only* a lattice — there is no calendar, capacity model or finite scheduling behind it, so "where you do it" carries no load or availability semantics beyond an advisory `Max Load` on the group.

---

## Part III — The order lifecycle

### III.1 Order status vocabulary

One status enumeration carries an order from receipt to invoice, and it is also the trigger vocabulary for notifications:

| Code | Meaning | Notes |
|---|---|---|
| `N` | In Process | Documented as effectively never used |
| `R` | In Receiving | Parts logged in, order not yet complete/released |
| `G` | Receiving Complete | |
| `C` | Process Complete | |
| `P` | Partial Shipped | Set when a ship line is not marked complete |
| `S` | Shipped Complete | |
| `I` | Invoiced | |
| `D` | Deleted | Soft delete — order remains queryable |
| `O` | Order Re-opened | Result of a negative/reversing shipment |

`[orders] notification_status` selects the *minimum* status that fires a customer notification, and the semantics are cumulative rather than exact: `R` fires on R, G or C; `G` fires on G or C; `C` on C; `P` on P or S; `S` on S only; and `I`, `D`, `O` on those statuses. The vendor's own note explains why: an order with no process may stop at `R` while one with a process reaches `C`, so the rule has to be "this status or better". Notifications only fire **on save**, which makes `S` nearly useless in practice — an honest documented wart.

Load status is separate from order status and is what tracking, final inspection, holds and shipping availability actually operate on.

### III.2 Order Entry — the core transaction

Reached from the toolbar, `Orders > Order Entry`, or hot key **F2**. Tab key advances field-by-field *and* screen-by-screen; the tab sequence is the primary UX, and the spacebar acts as a click (i.e. spacebar on the opening screen starts a New Order).

The entry flow is a staged cascade — **Order Top → Parts → (containers → part → serials) → Process → Save/Print**:

**Order Top.** Customer (incremental scroll-down search; tabbing out of the highlighted customer confirms), then a *Make Order* confirmation; `PO No`; `Packing #`; `Certification` Yes/No; `Request Date`; `Target Ship` (deliberately outside the tab sequence); `Carrier In` (who delivered the parts — free text or dropdown); `In Route ID` (own-truck pickup routes); `Order is At` (area — requires tracking). Tabbing out of *Order is At* advances to Parts.

**Containers.** `Type` (container type), `# of cont.`, `Qty`, `Gross Wt`, `Tare`, `Net Wt` (net computes from gross − tare), `ID No.` (the customer's container ID). Tabbing out of the container ID reveals the part fields. **Hard rule: every order must have a quantity OR a weight.**

**Part.** `Part ID`, `Part Name`, `Part Description`, `Qty`, `Each wt`, `Total wt` (computed from each-weight), then `Print Container Label` Yes/No. **Rule: you must have a Part Id OR Part Name OR Part Description; a Part Id is required if a Part Maintenance record is to be created.** A magnifying glass selects a memorized part; a `+` button creates one inline (available when `[Orders] use_simple_part_entry = dw_order_part_entry_simple_plus` and on most custom part tabs). A camera/picture icon attaches an image to the part during order entry, which persists to the part record.

**Serial numbers.** Revealed by tabbing out of Total Wt. A **range expansion syntax** generates a series: entering `EC{001-025}` produces EC001…EC025 on tab-out. `EC{001-25}` is accepted equivalently, and **only the first number controls zero-padding**. Each serial can carry its own description (commonly used for heat/lot numbers).

**Process.** Search with `%` or a partial Process Master ID; alternatively search by Material, Equipment/Group or Process Code. *Pick It* (or double-click) attaches the master and generates the steps. Memorized parts skip this. Then **Save**, then **Print Order**.

**Screen variants.** `[Orders] use_simple_order_entry` selects the Order Top layout, with roughly 35 shipped values including `1`, `2`, `5`, `CHARTS`, `Y`, `dw_order_header_entry`, `_3`, `_4`, `_5`, and per-customer variants `_accurate_steel`, `_aht`, `_avtec`, `_caltech`, `_charts`, `_chromal`, `_crhudgins_1`, `_dav_tech`, `_evans`, `_george`, `_hansen`, `_hta`, `_kachina`, `_metal_treaters`, `_metcor1`, `_mpc`, `_paramount`, `_pk`, `_quaker`, `_reifel`, `_suncoast_faa`, `_techno_1`, `_tmf`, `_vac_aero`, `_valmontact`, `_valmontpacif`, `_winston`, `_wolverine`, `_wpoint`. Value `2` is documented as "original order form, adds Cust and Shop numbers, sets Cert to Yes" — i.e. the value encodes behaviour, not just layout. Order-level pricing rows are only available on certain Order Tops (`_bfg`, `dw_order_header_caltech_1`, `_gen_mp`, `_jagemann`, `_peening`, `_premier_proc`, `_qualtek`, `_ss_plating`, `_surtronics`, `_triplex`, `_valmontact`, `_valmontpacif`), and the Rework button only on `_dci_aerotech`, `_caltech_1`, `_penna_fl`, `_peening`, `_gen_mp`. **This is the clearest example of the anti-pattern in the product: capability is bound to a form variant rather than to configuration.**

**Order Part Detail pop-up.** `[orders] use_popup_orderpartdetail = Y` plus `order_part_detail_popup_dw = <variant>` gives an editable part detail overlay during order entry, with variants `dw_order_process_part_bap`, `_bw_southwest`, `_davtech`, `_hudson`, `_jagemann`, `_ps_morgan`, `_nassau`, `_peening` (view-only). Most can save changes to the order *and* persist them to the part record; greyed fields are locked per variant. `auto_open_orderpartdetail` opens it automatically after a memorized part is selected. `orderpartdetail_calcprice = Y` is required for the Total Price to calculate; `orderpartdetail_popup_assembly = Y` adds an assembly section — and if the part has Assembly Process Masters the *Save Changes* button is disabled by design.

**Order Entry as a list.** `[Orders] use_dashboard = Y` (build > 3888) opens Order Entry on a searchable order list instead of a blank order: dropdown filters for Order Status and Entry Status, Start Date and Days Back, double-click or Edit to open, *New Order* to create, Save As → Excel with Headers, print, and saved search criteria. The vendor recommends setting it against a single Station ID first — the staged-rollout pattern the station scoping was built for.

### III.3 Due dates — a four-level override chain

Two date fields exist on the Order Top: **Request Date** and **Target Ship**. Both feed the rush reports. Note the asymmetry: date *types* can only be added in Order Entry but can only be modified or removed in Expediting; edits in either module propagate to the other.

Plant default → customer → part → process, each announcing itself:

1. **Plant:** `[Orders] request_date_days = <n>`, with `request_from_workdays = Y|N` deciding whether weekends (and, where set, holidays) count.
2. **Customer:** `Maintain > Customer > Cust Control > Req Days`. Applies the moment the customer is chosen.
3. **Part:** Part Maintenance `Request Days`. Prompts to override as soon as the part is selected; declining leaves the existing date.
4. **Process Master:** `Proc Days` on the process header. Prompts on the Process tab when the master is attached.

Target Ship has its own parallel set: `[Orders] target_days` (entry date + n), `targetdate_via_entrydt = Y` (respects `request_from_workdays`), `targetdate_via_cc = Y` (take from Cust Control *Target Days*), and `[customer] target_days_title` to relabel the Cust Control field. Two documented edge cases: Cust Control target days of `0` sets the target to today; blank sets it to `00/00/0000`.

**Promise Dates** are a third, quantity-aware layer, added in Expediting via the Rush button: a promise date can be bound to a specific quantity and/or weight, and **the date is dropped from the order once satisfied.** Promise dates drive the Rush List and Backlog by Due Date reports.

### III.4 Notes — three separate channels

The system deliberately separates three note types, which is a good idea implemented with confusing overlap:

| Channel | Where entered | Where it surfaces | Prints? |
|---|---|---|---|
| **Order notes** (yellow push-pin) | Order Entry push-pin icon | Expediting, Shipping, Invoicing, Order Management pop-ups | **Never** — screen only |
| **Customer notes** | `Maintain > Customer` main screen | Order Entry, Shipping, Invoicing, Bill of Lading | Form-dependent |
| **Part notes** | Any Part Maintenance field, nominated by key | Order Entry (modal), Expediting, Shipping, Invoicing | No |

Push-pin controls: `[notes] sort_order = D` for descending (blank = ascending, and **the change only affects notes created afterwards** — existing notes keep their original order, an odd data-vs-display confusion); `[notes] note_width` between 1563 (current) and 4000; auto-display via `[Invoicing] force_note_view = Y`, `[Shipping] auto_display_notes`, and `[Order Management]`; `[ccm] generate_order_notes = Y` makes the Customer Communications module create a push-pin note bound to a referenced order.

Customer notes auto-display: `[orders] auto_show_cust_notes = Y`, plus equivalents in `[shipping]`, `[Invoicing] pop_up_notes` and `[bill_of_lading]`.

Part notes: `[Orders] part_note_column = <part maintenance column name>` (e.g. `misc_notes`; **the column may not be numeric-only**) makes that field's contents pop as a modal in Order Entry. `[orders] force_partnote_click = Y` forces an explicit OK; `[Expediting] auto_display_part_notes`, `[Shipping]` and `[Invoicing]` extend it. The note never blocks the order — it only demands acknowledgement.

### III.5 Order-level charges

Certain Order Tops expose price rows on the order itself, so a receiving clerk can record "this needs an extra charge" without knowing the price. The lifecycle rule is strict and correct: **order-level charges may be added or changed until `Create Invoices from Shipped Orders` runs; after that the invoice tables own the data and all changes must be made in Invoicing.**

Fallback pricing when the clerk has no number:
- `[Invoicing] Order_prices_use_step_pricing = Y` — at invoice creation, look up step pricing, then customer step pricing, for missing price and/or price-per.
- `[Invoicing] Order_entry_zero_prices = Y` — if nothing is found anywhere, still create a zero-price row (so the charge is not silently lost).
- `[Invoicing] order_charges_priceper = <Invoice UOM value>` — the price-per to assume; the literal word `blank` leaves it empty. If the resolved price-per is `F` (Flat) or `G` (Lot Charge), the quantity is forced to 0.

### III.6 Contract Review — two generations

**Generation 1** (`[Orders] show_contractreview_tab = Y`) adds a hard-coded verification tab as the last tab of Order Entry. Every item must be marked *Verified* or *N/A*, in five fixed sections: **Part Information** (Part Rev, Part No, Process ID, Correct Container, Qty/Weight); **Quality/Technical Requirements** (Specification, Quality Codes, Prime Customer, ITAR/EAR, Job #/Lot #, Material); **Inspection Requirements** (Certification Req'd, Surface Hardness, Core Hardness, Effective Case, Total Case, Micro structure, Sampling Required); **Shipping/Billing** (Ship to Address, Bill to Address, PO #, Packing Slip); **Other Customer Requirements** (the 12 customer user-field titles) plus **Approved**. It also requires `[customer] user_fields = Y`, which adds 12 string user fields to the customer window, named and optionally made dropdown-only in `Cust User Field Names`.

Behaviour worth studying: once *Approved* is set, **no field on the tab can be changed**, and the only escape is to remove and reattach the Process Master — which **wipes every answer and resets approval to N with no history of the previous values.** Only the standard "process removed/reassigned" event is logged. Expediting shows the tab read-only with a History tab entry. This is a compliance feature with a data-loss hole in it; if you build this, version the answer set.

**Generation 2** replaces the fixed questionnaire with a configurable one. `[Orders] contract_review_level` takes four values:

| Value | Behaviour |
|---|---|
| `0` | Tab hidden |
| `1` | Tab visible; order may print with unanswered questions |
| `2` | Tab visible; all answers required **if Process Master Type = Aero** |
| `3` | Tab visible; all answers required for the order to be saved |

Questions are maintained in `Plant Support > Custom > Contract Review` with Add Row / Insert Row / Delete Row. Each question is either **text** or **choice**; choice questions get a *Values List* editor where each allowed answer carries a **row highlight colour** and a flag for *additional information required*. Unanswered question numbers highlight red; answered rows take the answer's colour; a required-extra-info answer highlights yellow and blocks the save. Three named departments sign off before print. This is a much better design than generation 1 and closer to what a modern system should do.

### III.7 Outside processing

An Outside-Processing purchase order can print automatically right after the shop order if any step matches a configured Table Key.

- `[order printing] print_outside_po = Y`
- `[order printing] Outside_po_key = <process,equip,group,cc>` — the comma-positional tuple from II.2; specificity of the tuple equals specificity of the trigger.
- `[order_printing] Outside_po_form = dw_order_outside_po_vendor` (the default vendor form). Alternatives: `_process`, `_costcenter_astro`, `_metroplex`, `_pht`, `_fpm`, `_pmtesting`, `_vendor_mpi`, `_vendor_winston`, `_vendor_bfg`, `_vendor_euclid`, `_vendor_euclid2`, `_vendor_ahtc`.
- `[Inventory] use_inventory` — the vendor list comes from the Inventory module (`Process > Inventory > Vendor Maintenance`); restart required for the menu.

At order save a vendor-selection window pops; **once a vendor is chosen for an order it cannot be changed.** The printed form carries order number, part id, material and the qualifying step's instructions only — a separate shipping document (e.g. Bill of Lading) is still needed to physically send the parts out. There is no PO receipt, no vendor liability, no outside-processing cost capture: this is a printed instruction, not a procurement transaction. A modern design should treat outside processing as a real subcontract operation with expected return date, cost and receipt.

### III.8 Digital Order Approval

A gate between order entry and release requiring **three** sign-offs — Sales, Quality, Production — before an order can print.

- `[Menu] show_digital_order_approval = Y` (restart).
- `[Quotations] QuoteFormNumber = dw_quote_solar1` (the View Quote button).
- `[order printing] form_type = dw_order_print_solar_sign` prints the approval stamps on the order; `print_labels` / `print_container_labels` as required.
- **On-hold reasons** must be seeded in `Plant Support > General > Reasons` with Reason Type `Orders On-Hold`, otherwise the hold list shows "ERROR, No On Hold Reasons to select from".
- **Stamps table** (`Plant Support > Orders > Stamps Table`) holds file paths to the stamp images.
- Security **Module 37** — checkbox 1 access, **2** = DOA ok Quality, **3** = DOA ok Sales, **4** = DOA ok Production, **5** = DOA ok Stamps.

Operated from Order Management: open the order, then Approve or place On Hold per category (Save and Refresh to see changes), *Edit Special Instructions* (which lands in the order's Process Comment after save), and *View Quote*.

### III.9 Load splitting

`Orders > Tracking > Order Load Splitting`; also reachable by checking **Load Split** on the Process tab during order entry (the split window opens on save), and from Expediting / Order Management via a Split button. Security: **Module 53 (Fix Tracking)**. Documented purposes: divide an order by quantity/weight; satisfy a partial early request (150 of 300 first); control WIP batch size for tracking; enforce furnace/belt capacity with **Max Loads** by quantity or weight; and set processing priority via the resulting order-loads. `[load_split] onhold_option = Y` prompts to place newly created split loads on hold, which pairs with `[order_status] log_change_reason = Y` so the hold reason is captured as a customer event (`Load Status Changed` / `Load on-hold`).

### III.10 Review and inactivation gates

A neat, uniform pattern applied to three master entities: **`review_req_days`** in the `[customer]`, `[process]` and `[parts]` sections. When populated, order entry checks for activity within that many days plus the entity's *Needs Review* flag and *Next Review Date*.

- **Customer:** warns if there has been no order in the window, or *needs review* is checked, or the next review date is null or ≤ today. If the operator has customer-maintenance security they are offered the record. `[orders] prevent_needs_review_cust = Y` turns the warning into a block.
- **Process:** warns if no order in the window and the review date is null or ≤ today. **No** offer to open the record from the message (only via the *change* button, security permitting) — an inconsistency. `[orders] prevent_needs_review_proc = Y` blocks.
- **Part:** warns if the part has had no order in the window; offers the record if security allows; `[orders] prevent_needs_review_part = Y` blocks. Additionally, when `[parts] review_req_days` holds a number, **parts never ordered or not ordered within X days are flipped to inactive when the Part Maintenance window opens** — a silent mass mutation as a side effect of opening a screen, which is a pattern to avoid.

Bulk equivalents exist as deliberate operations: `Process > Delete Parts` (enter an order date; *Show Active Parts Only* is pre-checked; *Mark Parts Inactive (do not delete)* is the default action; uncheck rows individually — there is no Clear All — then Save) and `Maintain > Inactive Customers` (days since last order defaulting to 365, plus *Include Customers with No Orders*, with a Clear All button). Both documents argue strongly for inactivating rather than deleting, because deletion destroys activity and sales history.

---

## Part IV — Sales Order Entry, Receive Parts and inbound imports

### IV.1 Sales Order Entry

Enabled by `[Menu] sale_orders = Y` (restart). Reached at `Orders > Sales Order Entry`. It is a **staging document** that solves two real problems: entering many parts for one customer without re-keying the header, and recording work that has been promised before the material physically arrives. Because a sales order is not yet an order, **it can be deleted if the parts never show up** — which is the whole point.

Flow: New → choose customer → tab through to Parts → enter parts (verified or created inline) → Save. Then Search, double-click a row to reopen, and **Save/Print**, which converts the sales order into one or more real orders (and routers) in Order Entry. Sales orders are identified by a `TC` number in the search list.

Default conversion behaviour is **one order per part row**. `[SaleOrders] use_simple_part_entry` changes the part grid and the conversion rule:

| Value | Behaviour |
|---|---|
| `dw_salesorder_part_entry_candr` | **Combines parts sharing the same Process Master onto one order.** Adds a *Chng Part Name* button that rewrites the Part Maintenance name — requires add/change/delete part security, and writes part history. Works with `[Orders] part_name_lookup_option = Y` to search parts by name. |
| `dw_salesorder_part_entry_howard` | Shows the part's `po_number` from Part Maintenance if populated; with `[SaleOrders] part_comment_equals = PO` the memorized PO may be edited. **Reverts to one order per part** rather than combining. |
| `dw_salesorder_part_entry_sands` | Adds a button beside Part Id that triggers a Part Maintenance search for that id. Part Maintenance must already be open (errors otherwise, and errors again if another part record is active). One hit opens the record; several show a list. Edits saved before Save/Print flow into the created orders without re-selecting. |
| `dw_salesorder_part_entry_swd` | Used by the SWD import path (below). |

`[SaleOrders] multi_process_per_part = Y` is the more interesting variant: each part may carry **several processes**, and **one order is created per process**. The screen also shows, per part, the list of processes previously used with that part — a small but genuinely useful affordance. Header fields (customer, PO, due date) are entered once; the example in the documentation creates orders 1664–1668 from a single sales order with five process assignments across two parts.

Deletion requires security **checkbox 4** in the Sales Order module; without it the Delete button does not appear. Sales orders can only be deleted **one at a time**, and only **before** Batch Print.

Additional `[SaleOrders]` keys documented across these articles: `allow_cont_no_qty` / `allow_conts_no_qty`, `allow_parts_no_process`, `default_container`, `default_container_rows`, `after_part_entry` (e.g. `Add Part`), `after_containers_moveto`, `after_partselect_moveto`, `AlwaysUse_PartShipto`, `custom_print`, `def_part_description`, `hide_container_dw`, `hide_serial_dw`, `import_file_type`, `initial_carrier`, `initial_customer_number`, `match_inspection`, `part_comment_equals`, `use_simple_part_entry`, `multi_process_per_part` (full values in Appendix A).

### IV.2 Batch Print

The conversion gate for sales orders, and also a general order-print queue (security **Module 17**). Options:

- **Mark all to Print** — flags every sales order that is *OK to print*; **Clear All to Print** — clears the Save/Print checkbox so the operator picks individually.
- **Show all Sales Orders** (including incomplete) vs **Show only OK to Print**.
- Save/Print then auto-saves and prints each selected sales order, converting it to an order, ending with a "Batch Save/Print Processing has completed" message.

Module 17 also covers *Reprint an Order* and *Batch Print Orders* — where program defaults suppress printing during normal order entry precisely so orders accumulate in the batch queue, optionally filtered to one operator's orders.

### IV.3 Receive Parts

`[menu] show_receive_parts = Y` plus `[receive parts] use_standard_window`, security **Module 36**. At `Orders > Receive Parts` a receiving clerk enters only customer, P.O., container types and quantities, then **Print Labels** (form chosen by the label defaults). This creates the container rows on a sales order, which then appears at the top of the Sales Order Entry list (descending sort) for someone else to complete. A clean separation of dock work from order engineering — worth copying.

### IV.4 Custom sales-order imports

Two documented import shapes, both driven from an **Import** button in Sales Order Entry that creates one sales order per file row.

**Option 1 — `import_file_type = SWD`.** Prerequisites: `[Orders] use_simple_order_entry = 2`; `[Orders] use_simple_part_entry = dw_order_part_entry_proc_type_size_swd`; `[Menu] sale_orders = Y`; `[saleorders] use_simple_part_entry = dw_salesorder_part_entry_swd`, `allow_cont_no_qty`, `allow_parts_no_process`, `import_file_type = SWD`; `[parts] process_assembly_dw = dw_process_part_process_display_swd`; `[orders] autoselect_assembly_checkbox = <part maintenance user checkbox number>`. Rows convert to **released orders or incomplete orders** at Batch Print; incomplete ones need manual release in Order Entry. An import message report is written to the `HTSW` folder.

**Option 2 — `import_file_type = MDP`.** Prerequisites: `[Menu] sale_orders = Y`; `[saleorders] after_part_entry = Add Part`, `default_container = <container name>`, `import_file_type = MDP`; `[Shipping] create_shipper_file_csv`. This one is a **true EDI-ish integration** and needs two rows in `Maintain > Customer > FTP Settings`:

| Field | Record 1 | Record 2 |
|---|---|---|
| Form Name | `Shipper` | `Sales Order Entry Import` |
| Source File | blank | — |
| Structure File | `MDP` | `MDPS` |
| File Type | `EDI` | — |
| Local Path / FTP Server / Username / Password / Port / Protocol | local path, server, user, password, port, `FTP` | — |
| FTP Remote Path | path after login | path after login |

Import procedure: choose the customer **first** — and if the customer id does not exist in Visual Shop the import aborts with an exception report and saves nothing (**the only stop in the process**, which is a notably thin validation posture). Then Browse for a file or pull it by FTP.

Consolidation rules on conversion: rows with the same PO **and** same part id merge into one part row (one order); the **first** row's job number wins; all serials and serial descriptions carry over to the merged row; quantities and weights sum; the total part qty/weight moves onto the default container row; the Process Master is pulled from the verified part record. Two conditions block conversion until fixed in Sales Order Entry: the part is **not verified**, or there is **more than one Part Maintenance record** for that part id / customer combination. After Save+Print (or Batch Print) the sales order is gone and all corrections must happen in Order Entry.

---

## Part V — Customer service, scheduling and the operational cockpits

### V.1 Order Management

The vendor's own description is that this is the most powerful and versatile module, and functionally it is a spreadsheet-like grid over the entire order universe: Order Top, Processes, Parts, Shipping, Tracking, History, Rush, Load and Inspection data, all searchable. Search scopes are **Open, Shipped, Invoiced, or All** (All includes Deleted and Invoiced).

`[Order Management] use_new_search_list = Y` switches to the modern list (`N` restores the legacy screen). The list auto-retrieves; double-click opens; *Search* returns to the list.

**Retrieve controls:**

| Key | Effect |
|---|---|
| `daysback` | Days Back from Order Entry box; **defaults to 60** |
| `open_orders_only = Y` | Pre-checks the *Open* checkbox |
| `open_orders_only = A` | Pre-checks the *All* checkbox |
| `grid_search_order_dw` | Which grid layout to use, e.g. `dw_expd_search_grid_order_linden` |
| `schedule_print_dw` | Which schedule report to print |
| `picture_update` | Enables picture add/update (with security) |

**Three grid granularities** are available and independently configurable: **one row per order, one row per part, one row per load.** That is exactly the right answer for a business whose work unit shifts depending on the question being asked.

**Search and filter:** built-in boxes for part id, PO number and so on, plus a `[...]` column picker for ad-hoc criteria; *Reset Columns*; print; a sort/filter dialog with drag-and-drop of source columns; column reordering and resizing that persists.

**Due Date Status** is a derived, configurable traffic light computed from target date minus today:

| Status | Rule |
|---|---|
| On Target | No target date, or more than `may_miss_days` away |
| May Miss | Within `may_miss_days` (**default 5**) |
| Will Miss | Within `will_miss_days` (**default 3**) |
| Did Miss | Target date has passed |

Security **Module 13** grants the module (checkbox 1 need not be ticked): search, send notes, add inventory, add/print attachments, delete, and add Rush. Checkbox **2** = Add/Update Pictures (also needs `picture_update`), checkbox **3** = Shipping Hold Maintenance.

### V.2 Scheduling inside Order Management

Three columns — **Target date, Schedule, Priority** — turn the grid into a light scheduling board (the documentation notes users typically drag those three columns adjacent to each other). Printing produces a schedule per Schedule value, and depending on the report can break by Target date / Schedule / Priority, or group all orders for a Schedule together, with summaries by date and priority. **When an order ships it drops off the schedule automatically.**

Setup: `[Order Management] use_new_search_list = Y`; `grid_search_order_dw` pointing at a grid that includes Target/Schedule/Priority; `schedule_print_dw = dw_expd_schedule_csi` (also `dw_expd_schedule_avtec`, `dw_expd_schedule_phoenix`). **Areas must be created first**, then the Schedule list, and **every Schedule entry must map to an Area.**

This is finite-capacity-free sequencing: priorities and lines, no load calculation. Honest for a shop where the constraint is furnace batching rather than minute-level routing, but it is the biggest functional gap versus a modern APS.

### V.3 Expediting

Hot key **F1**; security **Module 13**. Described as the primary customer-service module: search orders by part, PO, material, process and more, across open / shipped / all, from one day back to ten years back. Tabs include Order Top, Parts, Process, **Tracking** (steps grey out once tracked, with the bottom pane identifying Quick Track actions and listing pass/fail inspections), **Load**, **Shipping**, **Rush** (where Promise Dates are added), **History** (including contract-review and status events), **Rework**, **Insp**, and Contract Review (read-only). `[Expediting] dw_order_top = dw_expd_header_crhudgins` is called out as an Order Top variant that exposes a shipping-hold checkbox; `[Expediting] dw_insp = dw_expd_mre_tracking_results_fpm` surfaces manual inspection results on their own tab so results can be reviewed without re-entering the editable Quick Track window — a good read-only-by-default instinct.

### V.4 Customer Expediting and CCM

**Customer Expediting** (`Billing > Customer Expediting`, security **Module 31**) is the customer-centric mirror of Order Management: pick a customer from the list, then work **15 left-hand tabs** — Customer, Detail (customer maintenance), Control (cust control), Operations (customer operations report), History (credit history), Sales (Sales by Customer TY/LY), Addr/Cont, Statements, Quotes (double-click to preview), CCM, Documents, Parts, Invoices, Reports and Expediting. Some tabs are live, some read-only; several support sort/filter, column selection, zoom reset and thumbnails. Cost-center-as-plant behaviour carries through into the embedded reports.

**Customer Communications Manager (CCM)** — `Notes > Customer Communications Manager` or the CCM tab above. Functions: *Edit Contacts* (not available in the Customer Expediting variant); *New Communication* (Category and Sub-Category from `Plant Support > Customer > Customer Categories`, Priority, Follow-up, Contact, Subject, notes; after saving, *Send Note* posts an internal Visual Shop note and *Send Doc* assigns other users to the action); *Communications* (a report by customer/all, days back, sort, category — double-click opens the record on the Work Communications tab); *Work Communications* (all fields editable, a *message* field for send-doc entries that saves on tab-out, a resolution field, and status closure); *Documents* (customer-level documents both received and sent, with defaults able to alert users that documents are attached).

CCM defaults: `[ccm] generate_order_notes = Y` (create an order push-pin note when an order id is present on a customer contact), `form_name` (blank default; e.g. `dw_ccm_print_form_thermtech`), `ccm_communications_dw`, and contact-display variants `dw_ccm_contact_display_swd`.

### V.5 CRM module

`Notes > Customer Relations Management`. A ticketing system: the opening list sorts/filters by Customer, Order ID, Ticket Type, Priority, Open/Closed status, Assigned User and Key Words. New tickets auto-number; **Customer and Subject are required**; other header fields are Periodicity (for repeating tickets), Order ID, type, priority, follow-up date and assignee, plus a description area and an attachment section with a comment. Three tabs: **Details**, **Notes** (accumulating narrative, with its own attachments) and **Activities** (an automatic audit of every change — who and when, written on each save). One documented weakness to fix in any reimplementation: **the Order ID is not validated against the customer.**

### V.6 Hot List

`[Schedule] flex_schedule = H` adds `Orders > Schedules > Hot Orders List` — a short, manually-ranked list of urgent jobs, independent of flex scheduling, and an order may sit on multiple hot lists (right-click to move an order between lists). Manual sequencing is by drag; clicking a column header sorts, clicking again reverses.

| Column | Meaning |
|---|---|
| `#` | Priority rank — always sequential from 1, does not participate in sorting |
| `Black Box` | Editable free field |
| `Order - Load` | Order and load number |
| `Zones` | |
| `Created on` | Date added to the list |
| `Container(s)` | Container count |
| `Net Wt.` | Net weight |
| `Customer Name` | |
| `Target Date` | Editable; customer's required date |
| `Order Status` | |
| `FOB #`, `Coat Symbols` | |
| `Step` | Step count and current step |
| `Current Step` | Last process scanned |
| `Next Step` | Next process on the router |
| `Notes` | Editable commentary |

Editable columns are Black Box, Target Date and Notes — and **unsaved edits are destroyed by Refresh or by closing the list**, an avoidable data-loss trap. Orders are added singly (pop-up confirms the order data), in bulk (shift-click then *Pick One*), or from Order Management via an *Add Order to Hot Order List* icon. Delete removes from the list only, not from the system, and orders leave automatically when shipped, invoiced or deleted.

### V.7 Flex Scheduling

`[Schedule] flex_schedule = Y` enables `Orders > Schedules > Flex Scheduling`; **requires Visual Shop HD**, and integrates with Visual Track Mobile and Visual Track 2. Setup chain: create **Areas** (`Maintain > Plant Support > Areas`; `Area Id` and `Plant` required, `Area Title / Schedule Id` recommended) → generate **Tracking Templates** from those areas using `Maintain > Visual Shop System Utilities > Fix System > Tracking Template Area Import` (self-service requires typing the password `Flex!mp0rt`; CSI assistance recommended) → confirm templates under `Plant Support > Tracking Template` → assign each a **Tracking Type** (default Track In / Track Out; new types are added under `Plant Support > Tracking Type`) → create a **View** (`Views > Add view`, name it, then on the Schedules tab drag areas from Available to Selected, searchable by Area ID). Each area renders as a table of the loads currently in it; loads move manually or by scan.

Two observations: hiding an administrative bulk-import behind a hard-coded shared password is a security smell; and gating scheduling behind an "HD" edition is a licensing decision, not an architectural one.

### V.8 Dashboard

`[Menu] use_dashboard = Y` (restart) puts the Dashboard on the menu and prompts for a security code at launch; with Dashboard security it opens automatically, and without it the standard no-security message appears and Visual Shop opens normally. Re-openable at `File > Open Dashboard`. Security **Module 29**, where the checkboxes map to the Navigator pages. **User-defined InfoMaker reports cannot be used on the Dashboard** — only shipped graph objects.

Each section shows up to **six** graphs chosen per user via *Customize this tab*, each with Print and Filter/Sort, and some support drill-down to detail.

- **Overview:** Late Deliveries by Customer; Late Deliveries by Reason; On Time Delivery by Month; On Time Delivery by Month and Group; Open Orders by Age; Aged Receivables; Orders by Top Process ID; Wt and Qty by Top Process IDs; Orders Received Last 31 Days; Open Orders by Process Code; Order Due in Next 5 Days; Top 10 Slowest Paying Customer; Last 10 Days Daily Sales; Unlocked Invoice Status; Due vs. Ready to Ship Next 5 Days; Ready to Ship Next 5 Days; Sales by Month TY/LY; Payments Received by Type; Sales TY/LY Top 10 Custs; Status of Orders Ready to Ship; Weight Shipped Last 30 Days; Sales by Month Top 4 Process Codes; Sales by Month; Customers Who Owe Money.
- **Customers / Sales:** Sales by Month TY/LY; Sales by Month; Last 10 Days Daily Sales; Sales by Month Top 4 Process Codes; Sales by Month Top 4 Groups; Sales TY/LY Top 10 Custs.
- **Orders:** Orders by Top Process ID; Wt and Qty by Top Process IDs; Orders Received Last 31 Days; Open Orders by Age; Open Orders by Process Code; Order Due in Next 5 Days; Open Orders by Equipment; Daily Statistics; Open Orders by Group.
- **Shipping:** Ready to Ship Next 5 Days; Due vs. Ready to Ship Next 5 Days; Status of Orders Ready to Ship; Weight Shipped Last 30 Days.
- **Accounts Receivable:** Customers Who Owe Money; Aged Receivables; Top 10 Slowest Paying Customer; Payments Received by Type; Unlocked Invoice Status.
- **Top Customers:** Orders by Month TY/LY.

Dashboard defaults: `[dashboard] first_page` (`Dashboard`, `Invoicing`, `Accounts Receivable`, `Operations`, `Sales`), `invoicing_navpage_visible = Y|N`, and siblings per navigator page (Appendix A). Note the KPI set is entirely **delivery, backlog, sales and receivables** — there is no cost, margin, yield or scrap KPI anywhere, which follows from the absence of any cost model in the product.

---

## Part VI — Routings: Process Master, Standard Steps and Part Maintenance

### VI.1 Standard Steps

The vendor's definition is worth quoting in concept: standard steps are **tables of instructions organised by Table Key** — that is, by process code plus equipment/group/cost center. A Process Master then assembles standard steps into a complete job.

The critical property, stated as a warning: **changing a standard step updates every process that uses it**, so the documentation instructs you to first review which processes consume the step. There is no versioning and no effective-date — a live edit rewrites history for in-flight orders. Any reimplementation should version step text and bind orders to the version in force at release.

`Process > Standard Steps` (or the toolbar icon) → Table Key icon → double-click a key combination → existing steps appear, or an empty one. **Add Row** creates a step; **Add** appends a blank step to type from scratch; a **Search By** column holds a few characters used later to find the step when building a master. Toolbar functions: **Dupe** (copy the step under the red bar for editing), **Delete**, **Comments** (pulls from `Plant Support > Base System Tables > Comments` by Comment Type; select text, copy, paste into the step), and **Find/Replace** across any or all steps for that Table Key. Save, then Exit.

### VI.2 Process Master types

Masters are named by **Process ID** and come in three flavours with materially different behaviour:

| Type | Assignment | Step generation | Constraints |
|---|---|---|---|
| **Generic** | One process per order; assigned to a part in Part Maintenance in the main `Process ID` column | Steps from the one master | The simple, dominant case |
| **Part Assembly** | Multiple masters attached to the *part* via the **Assem Proc** button | All steps built from all assigned masters at order entry | Processes **cannot** be chosen at order entry; `inspection_overlay` does not work; duplicating an order copies **only the steps**, not the assembly process IDs; spec overrides at part level do not work |
| **Order Assembly** | Multiple masters available; **chosen at order entry** | Steps created in the order the masters are selected | If the part is not memorized, *all* processes are selectable — putting router construction in the order-entry clerk's hands. Pricing can follow the chosen processes |

Pricing may be attached in the Assem Proc window, and **the pricing rows need not correspond to the process rows** — a deliberate decoupling of what you do from what you charge for.

`[process] Default_Type = G` sets the default type; `[process] memorize_steps = P|A|N` controls whether steps are memorized to the part, the assembly, or not at all; `[process] only_standard_steps` restricts masters to library steps rather than free text — the single most valuable lever for keeping work instructions controlled.

### VI.3 The new Process Master window

`[process] use_new_window = Y` (set to `N` or blank to revert — the vendor explicitly offers the escape hatch). Its headline benefit is **on-the-fly creation of Table Keys, Process Codes, Groups, Standard Steps and other tables from within the master**, removing the back-and-forth of building reference data first.

- `[process] auto_search = N` stops the window retrieving every master on open (necessary on large databases; the vendor notes automatic type-ahead search is "coming soon").
- Search modes: **Default** (legacy-equivalent), **Part**, **Inspect**, and **Custom** (requires a `custom_search_dw` built by CSI). Columns are selectable, movable and resizable, and **Make this My Default Search** persists the operator's preference.
- Printing: *Process > Print* for the highlighted master with options; *List > Print* prints or saves the process list via File Explorer.
- **Change history** is available on both old and new windows: right-click a column or white space; double-click a *Detail History Record* to see a before/after report. `[process] history_comments` forces the operator to state a reason for the change.
- **Renaming a Process ID in place** is supported: edit the ID field and Save, then choose between renaming and creating a new master from the current one. Renaming a routing identifier in place is dangerous unless history is retained — the history feature is what makes it defensible.

### VI.4 Part Maintenance

Hot key **F9**; `Process > Part Maintenance` or the toolbar icon. Parts are the memorized customer/part/process records that make repeat orders fast.

Documented realities of part creation:
- Parts may be created before order entry, during order entry via the `+` button, or implicitly: when a process master is selected, a security-gated prompt offers to add the part to the process, creating a customer/part/process record. **The vendor warns to turn that security off when using {inserts} and overlays**, because it produces incomplete part records.
- Saving a part with no id, name or description prompts for confirmation, both here and via the `+` button in Order Entry — a deliberate guard against blank records.
- Part-level overrides exist for certification, material, inspection and specification. **Spec overrides do not work with Assembly masters.** Order duplication does not duplicate assembly process records, only steps.
- Standard-step process-level instructions can be stored in part fields, and cert free-form text can be drawn from a part field (see the insert table in Part VII).

**New part:** New Part → Part Id, Name, Description → Process Master (dropdown) → Customer (dropdown) → default PO Number → tab-by-tab detail → Save.

**Duplicate a part:** select the row **without** opening Show/Hide Detail → Duplicate → amend. `Maintain > Plant Support > Required Part Fields` lets each field be flagged **Do Not Dupe** (excluded from copies) and/or **required** — a small, well-judged pair of flags.

**Detail buttons:** Proc Steps, Assem Proc, Print Process, Step Overlays, Print Overlays, Lookup, Price Structures, Group/Part Addon Overrides.

**List view:** `[parts] use_new_search_list = Y` auto-retrieves parts into a dashboard-style list with **Zoom** (column size slider), **Show Thumbnails** (part pictures), **Select Columns**, column reordering, **Reset Columns**, print, and a drag-and-drop sort/filter (drag columns from Source Data to Columns; check for ascending). A neat documented trick: sorting on `seqno` ascending shows the earliest-entered part first, descending shows the newest.

**Custom tabs.** Visual Shop allows exactly **two** custom part tabs, which *replace* the Paint and Powder tab and the User tab.
- `[Parts] customtab_displayfirst = Y` shows the custom (Paint and Powder replacement) tab first instead of Desc/Picture.
- `[Parts] customtab_dw` names the window; setting it back to `dw_uo_part_paint_power_1` restores the stock tab.
- `[Parts] customtab_text` and `usertab_text` relabel the tabs (blank keeps the original labels).
- `[part_custom_window] select_tab` makes the designer prompt for which of the two tabs is being built; `Set_Selected_Invisible = Y` hides already-placed columns (per window, not shared).
- Designer: `Maintain > Custom Part Window Maint` — drag fields from the right (the *All* tab field set) to the left canvas, shift-click for multiples, click a field to edit its label, set the **tab sequence** (numbers appear in red, incrementing by 10), remove with a button or the Delete key, set text and background colours, and edit **MicroHelp** (the hint shown bottom-right when the field has focus) via the **Tags** window.
- **Constraint:** if you use custom part windows, do **not** also use the User Field Names table in Plant Support.

A drag-and-drop screen designer with tab-order and per-field help, stored as data, is a genuinely strong feature for a product with this many verticals — but capping it at two tabs, and having those two tabs displace existing ones, is an arbitrary limitation.

**Step Overlays** — the mechanism that makes generic masters part-specific without cloning them. Activate a part → **Proc Steps** → **Step Overlays**:

| Field | Behaviour |
|---|---|
| `Comment` | `Overlay Comment` replaces the master's step comment entirely; `Add To Comment` appends to it. Step comments hold up to **255 characters** |
| `Step` | `Overlay Step` replaces the step itself |
| `Step / Seq` | The step and sequence number being replaced |
| `Process / Eq / Gr / CC` | The Table Key of the replacement step |
| Step Search area | Find and select the replacement step |
| `Template ID` | Tracking template for the overlaid step (tracking required) |

`[Orders] overlay_key_replace = Y` allows the overlay to substitute a **different Table Key** on the order; without it, only step text and comments are replaced while the key stays as the master's. Add Row for further overlays; Save. Overlays may replace a step, a comment, or both. If steps are inserted or deleted in a master used by an overlaid part, **the overlays renumber automatically — but overlay history will not reflect a deleted step.** Process Master displays a message when a selected process has overlays. `[Orders] step_overlay` and `inspection_overlay` govern related behaviour (the latter, note, does not work with assembly masters).

**Quotes in Part Maintenance.** `Quotes` tab on an activated part. Requirements: a valid part record with all required fields, and **a Salesperson** (on the All and Quote tabs, from `Plant Support > Sales Persons`). Fields: `Quote ID` (auto-assigned if blank), `Quoted Qty`, `Unlimited`, `Quoted By`, `Quote Date`, `Eff. Date` (defaults to today if blank), `Exp. Date` (auto-calculated from the quote-days default), `Rec` (checked when the part is used on an order) and `Date` (when that happened), `RFQ Number`, `Sales Person`, `Contact`, `Title`, `Phone`, `Fax`, `Printed`, `Multi Quote #`, `Turnaround`, `Route`, `Carrier`, `Quote Notes`, `Quote Instructions`, `Ending Statement` (from the Ending Statements table). After pricing, **Get** previews and **Print** issues it.

**Multi-part quotes** are presentational only, and the documentation is blunt about it: each part must still be created separately with its own process and pricing; the `+` button populates `Multi Quote #`, and on subsequent parts the **Dup** button copies the header data. All parts must share the same multi-quote number, then **Get** under *Multi Part Quote* previews one combined form. `[Invoicing] unit_types_include` restricts which Invoice-UOM price-per options are offered in Part Maintenance (and in Price Structures and step pricing).

**Mass price change.** `Process > Part Maintenance Price Change`, security **Module 22** checkbox **1** (access) and **2** (view only). The documentation opens with a full-database-backup recommendation, which is the correct instinct for a mass mutation with no undo. Criteria: Customers (all / one / include-or-exclude list), Process Codes (same), *Show Parts With* (include/exclude subtotals; Distributions and/or Screw/Washer — custom options), *Part IDs Containing* (include/exclude), *Part Entered* date range, *Active Parts Only*. Then pick the tab matching where the price lives: **Assembly Prices** (Assem Proc window), **PPG Prices**, or **Part Prices** (Price tab).

The performance workflow the article exists to teach: **Get Prices**, then **Sort/Filter → Filter** with a criterion such as `price = 10.42`, OK, **Do It** — reducing 6,790+ retrieved records to 18 before changing anything. Change options: *Round to dec places* (may not work with all defaults), *Chg Zero Setup/Min* (otherwise zero-dollar fields are skipped), *Update Inactive Parts* (only available when *Active Parts Only* was not used), and per-row unchecking.

**Part PDFs and attachments** are covered in Part XI.

---

## Part VII — Quality: tracking-lite, inspections and certifications

### VII.1 Quick Track

Quick Track is the **manual alternative to shop-floor tracking**: a fast way to flag steps done and record step-level or final inspection. `Orders > Quick Track` → enter order and load → Retrieve.

The completion semantics are the useful part: **ticking the Completed checkbox for a step flags that step and every step above it as complete.** When the last step is marked complete a **Final Inspect** screen opens; selecting `Pass? = Yes` and saving sets the order/load status to **Done**, which is what makes it *Available to Ship*.

Mutual exclusivity is explicit: if full shop-floor tracking (Visual Track or Visual Shop Order Tracking) is in use, **Quick Track must be switched off** by unchecking security **Module 53 (Fix Tracking), checkbox 7 (Access Quick Track)**.

Downstream effects: Expediting's Tracking tab greys tracked steps, identifies Quick Track as the source in the lower pane, and lists the inspections recorded with pass/fail.

Shipping visibility is tied to this: `[Shipping] avail_list_show_all = Y` shows every not-shipped-complete order regardless of tracking status; `N` hides orders that have not been final inspected. **It only works when `avail_order_list = Y`** — a dependency the documentation states, and the kind of dependency a settings registry should encode.

### VII.2 Manual inspection result entry

Quick Track carries an **Inspect Results** button equivalent to the one in tracking and the cert module (available while viewing steps, **not** on the Final Inspect window; all results entered flow onto Final Inspect). Results are recorded **by order-load**, but the documentation warns that **most cert forms print cumulative results rather than load results**, so custom forms may be needed to honour cert-control result options.

Flow: Retrieve the order/load → **Inspect Results** icon → the Select Load window → enter the load → OK → highlight the inspection row → **Quick Add** or **Add**. *Quick Add* opens a right-hand panel for rapid multi-result entry (Save moves them to the main window — **and the main window still needs its own Save**); *Add* inserts a single editable row below. Insert and Delete exist only in Tracking Inspection Results.

Required defaults:

| Section | Key | Value | Purpose |
|---|---|---|---|
| `quick track` | `manual_insp_button` | `Y` | Adds the Inspect Results button to Quick Track |
| `Certifications` | `custom_insp_entry_type` | `FPM` | Controls the Insp Results button in Certifications; requires `mre_inspection = Y` |
| `Certifications` | `mre_inspection` | `Y` | Required for Manual Result Entry windows |
| `Shipping` | `insp_result_type` | `T` | Tracking inspection results for selected loads; required for the Inspect Result window outside Shipping |

Optional: `[Expediting] dw_insp = dw_expd_mre_tracking_results_fpm` (read-only results tab — anyone with Expediting access can view them); `[manual inspect] qadd_oncert_sameas_passfail = Y` (auto-tick *on cert* when an inspection passes, though whether it actually prints still depends on the cert form); `[manual inspect] mre_range_message = Y` (warn when an entered value falls outside the requirement range, while still allowing a manual pass and/or print-on-cert). If tracking data is not needed at all, the Insp Results button is also available in `Orders > Certifications`.

### VII.3 Certifications — scope and assignment

Reached by toolbar icon or `Orders > Certifications`; hot key **F3**. Security **Module 15**: the module grants access and deletion, checkbox **1** grants print, checkbox **2** grants modify/save.

**A cert format is assigned at the moment of order entry**, resolved from the part record, then customer control, then process master. If none of those supply one but the Order Top says `Certify: Yes`, the plant default cert format from program defaults is attached at save. Note the corollary the documentation states explicitly for parts: **setting *Certify part* = Yes without selecting a cert format results in no cert being assigned.**

Three cert *scopes*, and choosing correctly matters:

| Scope | Behaviour | When to use |
|---|---|---|
| **By Order** | Order-level qty/wt print regardless of when the cert prints | Simple, single-shipment work |
| **By Load** | Load-level information prints; **best printed manually**, not automatically at shipping | Load-controlled processing |
| **By Shipper** | A cert is *created from the original* for **each shipment**, carrying that shipment's shipped qty/wt | Required when the customer needs a cert with every partial shipment |

Retrieval: enter Order ID and Load#/seqno → Retrieve; or enter the order id and press Enter twice to list all certs for the order, then double-click. The cert record shows certification number, order id, creation date, last printed date, creator and format. **Show Format** displays an abbreviated view of the assigned format.

Editable on the cert: `Freeform Results`, `Insp Code` (dropdown), `Scale` (dropdown), `Min Value` / `Max Value` / `Value`, and comment fields. Printing: **Print** → set `Print Now?` to Yes on the row → **Print Now**. A one-off variant, **Print/Change**, allows editing the data for a single print — and those changes **cannot be saved**, which is exactly right for a controlled document.

### VII.4 Cert formats and text inserts

Formats live in `Maintain > Plant Support > Certification Control` (also reachable as `Plant Support > Process Masters > Certification Controls`). A format carries default statements (cert intro, ending statement, etc.), of which **only the FreeForm text field is editable in the Cert module**. Regardless of format, every cert always carries order information: PO number, packing list, part fields (part id, name, description), serial number fields and inspection requirements. Optional additions include step text.

Four documented strategies for reducing format proliferation — and this is a genuinely instructive piece of the KB, because format count is the maintenance cost:

1. **One format per primary process**, attached to the Process Master, so it lands on every order using that process ID. Standard comments go in the format's FreeForm field.
2. **Process Master comments** — the *Comments – Prints on Certs* field on the master flows to Process Comments on every order's Process tab and prints on the cert.
3. **Customer control text** — customer-level text prints automatically for that customer's certs.
4. **A single generic format using `{insert}` references** to part-maintenance and customer-control columns, resolved at cert creation; if the referenced field is empty the insert resolves to blank.

Insert syntax uses the **database column name in braces**, e.g. `{cc_def_process_instr}` for customer-level process comments. The documented part-field insert vocabulary:

| Tab | Column | Field in Part Maintenance | Type |
|---|---|---|---|
| All | `linear_inches` | Linear Inch | Numeric |
| All | `misc_notes` | Misc. Notes | Alphanumeric |
| All | `pcs_per_rack` | Pcs per Rack | Numeric |
| All | `perimeter_inch` | Perimeter Inch | Numeric |
| Formula | `part_formula` | part formula | Dropdown only |
| Information | `color` | Color | Dropdown + alphanumeric |
| Information | `lot_number` | lot number | Alphanumeric |
| Information | `mask_inst` | Mask Inspection | Alphanumeric |
| Information | `mask_part` | Mask | |
| Information | `material` | material | Dropdown only |
| Information | `mfg_name` | Mfg Name | Dropdown only |
| Information | `mfg_number` | Mfg Num | Dropdown only |
| Information | `paint_number` | paint type / # | Alphanumeric |
| Information | `paint_used_per_part` | paint used by part | Numeric |
| Information | `part_specifications` | Part Spec | Alphanumeric |
| Information | `part_type` | Part Type | Alphanumeric |
| Information | `plating_type` | Plating Type | Dropdown only |
| Information | `powder_number` | powder type / # | Dropdown only |
| Information | `powder_used_per_part` | powder used by part | Numeric |
| Information | `rack_id` | Rack ID | Dropdown only |
| Information | `recipe_number` | Recipe Number | Numeric |
| Information | `request_days` | request days | Numeric |
| Information | `seal` | seal | Numeric |
| Information | `specification` | specification | Dropdown only |
| Information | `treatment_code` | Treatment Code | Dropdown only |
| Information | `type` | type | Dropdown only |
| Information | `type_category` | category | |
| Information | `type_condition` | condition | |
| Information | `unmask_inst` | Unmask Inspection | Alphanumeric |
| Inspection | `insp_text` | Inspection Text | Alphanumeric |
| Inspection | `insp2code` | Inspection 2: Insp Code | Dropdown only |
| Inspection | `insp2max` | Inspection 2: max | Numeric |
| Inspection | `insp2min` | Inspection 2: min | Numeric |
| Inspection | `insp2scale` | Inspection 2: Scale | Dropdown only |
| Inspection | `Inspection_code` | Inspection 1: Insp Code | Dropdown only |
| Inspection | `max_value` | Inspection 1: max | Numeric |
| Inspection | `min_value` | Inspection 1: min | Numeric |
| Inspection | `note_inspect` | Inspection Notes | Alphanumeric |
| Inspection | `scale` | Inspection 1: scale | Dropdown only |
| Inspection | `surface_req` | surface req | Numeric |
| Inspection | `value` | value | Numeric |
| Metals | `ounces_of_metal` … `_4` | Oz Metal 1–4 | Numeric |
| Metals | `type_of_metal` … `_4` | Metal Type 1–4 | Dropdown only |
| Method | `additional_proc_notes`, `_2` | Additional Process Notes (1, 2) | Alphanumeric |
| Method | `note_process` | Process Notes | Alphanumeric |
| Method | `process_method` | process method | Dropdown only |
| Price | `area_run_in_plant` | area run in | Dropdown only |
| Price | `post_process` | Post Process Instructions | Alphanumeric |
| Price | `pre_process` | Pre Process Instructions | Alphanumeric |
| Price | `process_code` | process code | Dropdown only |
| Quote | `q_instructions` | Quote Instructions | Alphanumeric |
| Quote | `q_notes` | Quote Notes | Alphanumeric |

Results can also be edited from the **Shipping** screen: open the order, click **Results**, edit the free-form field, *Save Results* — and the cert then prints with the changes alongside the shipper.

### VII.5 Signatures on certifications

A precise and easily-missed spec: the signature image is **72 × 288 pixels**, printing at **0.853 × 2.062 inches**, i.e. a **1:4 height-to-width ratio**. The practical instruction is to draw a 1″ × 4″ box, have the person sign entirely inside it, and scan to **.bmp**. Any image saved at 1:4 will work. (It need not be a signature at all — a typed name in a file is acceptable.)

Assignment: `Maintain > Security` → find the operator → **Signature** button on the bottom right of the first window → select the bitmap from the `htsw` folder → OK → exit the frame → Save. The signature is now bound to the operator.

Which signature prints is decided by two `[Certifications]` keys:

- `signature_from_cert_control = Y` — print the **name typed in the Cert Control format** (provided that person has a signature in security); `N` — print the **operator who printed the cert**.
- `signature_from_last_opid = Y` — print the signature of the operator who **last saved the cert** in `Orders > Certifications`. Combined with `[certifications] shipper_results_from_load1 = Y`, any shipper cert shows the operator who last saved the **Load 1** cert. `N` falls back to the printing operator.

These work with the generic forms `dw_cert_form_generic` and `dw_cert_form_with_signature` and some custom forms. A signer is attached to a format at `Plant Support > Cert Control` via the **Signer** dropdown plus a free-text *Name To Print on Cert*. And a documented nuance for shipper certs (Cert Control = By Shipper): **the person who actually prints the cert has their initials placed next to the signature** — a small but meaningful traceability touch.

### VII.6 Certification by process

Special certs for particular operations (the examples given are Salt Spray, High Humidity, Copper Sulfate) can be generated automatically **in addition to** the standard cert.

- `[Orders] cert_by_process = Y | N | A`. `A` forces a process cert **even when the order's cert requirement is No** ("Always"). If you already require a cert on every order, `Y` suffices.
- `[Shipping] <process-cert key> = Y` creates a shipper cert for the process cert when the regular cert is by shipper. **Constraints:** the process cert formats must be **By Shipper**; the **Print/Change** window cannot be used; and because cert forms are retrieved by `order_id / ship_seqno` and there will now be two certs sharing that pair, **a custom process-cert form is required or the output will contain duplicate sections.** The documentation is refreshingly candid that stock forms will look wrong here.
- `auto_print_cert = Y` is required for certs to print at shipping; `auto_print_process_cert = Y` for process certs to print at shipping.
- Create one Cert Control format per process cert required (including customer-specific ones), then map them in `Maintain > Plant Support > Cert by Process`: Add → select the Process Code → select the Cert Control format → optionally restrict to a Customer.

At order entry, any order containing a step whose process code appears in the Cert by Process table gets that certification record created automatically alongside the standard one. Order-level process certs are updated and printed in `Orders > Certifications` (enter the order, *Get Cert*, double-click to activate, edit freeform/results, Print → set Print Now → Print Now). The standard cert continues to be updated from the Shipping screen's Results tab and prints with the shipping ticket.

### VII.7 Certification charges

Three levels, with overrides:

**Plant level.** `[Invoicing] cert_pcode = <process code>` must match a Plant Support Process Code **exactly**, and **a Table Key must exist for it**. When populated, a cert price row is added during invoicing. The price itself comes from `Billing > Pricing > Maintain Step Level Pricing` → *Process Step* tab → click the cert Table Key in the Generic Steps pane → enter price → Save. Customer override: the same window's **Customer Process Step** tab.

**Price-structure interaction.** When pricing comes from a structure (Billing > Quotations, or Billing > Pricing > Part Pricing), the assumption is that **all** price rows come from the structure — so `[Invoicing] addcerttopricestructure = Y` is required for the `cert_pcode` row to be added as well.

**Cert format level.** `Plant Support > Process Masters > Certification Controls` → **Cert Charge** field on the format, activated by `[Invoicing] get_cert_format_price = Y`. This has **no customer override** — the charge is a property of the format. Interaction worth noting: with `[Invoicing] part_cert_bill_no_price = Y` and *Bill for Cert* = Yes on the part record, the part row field is populated on the invoice cert price row but **the amount still comes from cert control**.

**Customer level.** `Plant Support > Overview > Cust Control > Billing Options > Do Not Bill for Certs` suppresses the charge entirely for that customer.

**Part level.** `Process > Part Maintenance > Information` (or *All*) tab: *Certify part*, *Cert Format* dropdown, *Bill for Cert*, *Cert Charge*.

### VII.8 Customer Control — cert requirements and overrides

Reached three ways: the smiley-face toolbar icon, `Maintain > Plant Support > Cust Control Table`, or `Maintain > Customer` → **Cust Control**.

**Under Order Check:**
- `Default Cert Id` — assigning a format **flips the order's cert requirement to Yes at save even if it was set to No beforehand.**
- `Cert Copies` — number of copies; **overrides cert control**.
- `Cert Uses First Print Date` — the cert date becomes the first-print date (not honoured by all forms).
- `Cert Every Order` — automatic cert on every order; requires `Default Cert Id`.

**Under Certification Requirements** (a custom, defaults-dependent area that enforces inspection data before shipping): `Validate Results before Shipping` (requires actual readings), `Min Entries` (how many readings are required), `Inspection Code` (which code must be validated). The documentation carries a blunt warning — **"If you use this, you may not be able to ship orders"** — which is honest about how easily a hard quality gate can stop the dock.

**Under Customer Specific Cert Text:** a 255-character block that prints on the cert (form-dependent).

**PDF by customer:** ticking *PDF Forms > Certification / Store in Folder*, with `[Certifications] pdf_by_customer = Y` and `[Certifications] create_pdf_copy = Y`, writes a PDF copy of every cert to the nominated directory.

**Email customisation** (documented here, applies generally): subject lines may be set plant-wide by default or overridden per customer, with **field inserts in square brackets** drawn from the form being sent, e.g. `Invoice Form: [inv_cred_number] from [remit_to_name]`. Keys: `[email] invoice_subject`, `[email] certification_docname`, `[email] invoice_docname` (attachment file names, customer-overridable), `[email] certification_text` (email body, e.g. `Here is your certification for PO Number [po_number]`), and `[email] certification_text_file` when the body is too large for a key value. Inserts **must be exact field names on the specific form**, which differ per form — a fragile late-binding contract, and one of the clearest arguments for a proper templating layer with a declared data contract.

---

## Part VIII — Shipping

Reached at `Orders > Shipping`, the toolbar icon, or hot key **F4**. Security **Module 14**.

### VIII.1 Single-order shipping

Enter the order number → **Get Order** → `Ship Now Qty` and `Ship Now Lbs` auto-fill for a complete shipment and may be overridden → **Print It** prints and saves the shipper.

The single most important semantic in the module: **the `Ship Line Complete` checkbox — not the quantity — decides whether the order is closed.** Checked ⇒ complete; unchecked ⇒ partial shipped, *regardless of the quantity or weight shipped*. That is a deliberate and defensible design (the shop, not arithmetic, decides whether it is finished), but it must be understood or the order book silently misreports.

**Shipping Control** (left): ship date (changeable), Print or Email, shipping label with copy count, and *Show Email List* to reveal available addresses.
**Customer information** (beside it): magnifying glass to pick a different Ship To, Carrier and Route dropdowns from Plant Support, and a shipping comments box under the address.

**Tabs:** *Parts* (ship now qty/lbs, ship line complete), *Loads* (loads and their statuses — one line per load when split), *Containers* (from order entry), *Serial Numbers* (from order entry), *All Loads* (last action per load), **Results** (free-form results written to the certification that prints with this shipper — the most operationally important tab), and *Part Comments* (printed by some forms).

### VIII.2 Multi-order shippers (MOS)

Tick **Multi Ord Shipper**, then for each order: double-click it in the list or type it and Get Order, set ship now qty/lbs, and click **Add to MOS**. A right-hand list accumulates the orders ready to print for that customer; finishing (or exiting shipping) prompts to print the MOS. With the *Multi Order Shipper Print Select* default, a selection screen listing **all MOSs for all customers** appears instead.

`[Shipping] mos_checked = Y` pre-checks the Multi Ord Shipper box on every entry to the module (manually uncheckable); `N` requires opting in each time.

**Correcting an MOS** — `Orders > Correct Multi-Shippers`: choose a Retrieval Type and range → Retrieve → set the offending order's `Multi Num` to **0** → go to Shipping and reverse the quantity/weight (negative amounts, dated to the original shipment) → reship correctly (watching the ship date) → return to Correct Multi-Shippers and set the Multi Number back to the MOS number → Save and Exit → in Shipping, pull any order on that MOS, Reprint, highlight the row, Print.

If "always use multi-shippers" is set, correction would normally be impossible because the MOS number could not be set to zero; `[MOS_corrections] allow_mos_correct_2_0 = Y` restores that ability. **Deleting** an MOS follows the same path: set Multi Num to 0, then delete/reverse the shipper in Shipping (Retrieve → Reprint → highlight → Delete), then reship with the correct date.

### VIII.3 Deleting versus reversing a shipment

The rule is dictated by whether Invoicing has seen it, and it is the right rule.

**Delete (reverse) the last shipper** — permitted only when the order has **not** been invoiced, the order/load status has not changed, and the order has not been split, combined or transferred. Single-order shipments only. `[Shipping] delete_shippers = Y` adds a **Delete** button on the Reprint display; select the shipper and press Delete. Visibility of the resulting reversals: `[Shipping] show_reversed_shippers = Y|N` (reprint screen) and `[Expediting] show_reversed_shippers = Y|N` (Expediting's Shipping tab).

**Reverse/unship with a negative shipment** — required once the shipment has reached Invoicing, because the invoice may already have printed. Open the order in Shipping, enter **negative** Ship Now Qty and Lbs, and **set the date to that of the original shipment**. This reopens the order (status `O`). Negative shipments then appear on the Create Invoices window and must be resolved there.

**Reprinting:** enter the order → Get Order → a "Shipping Error Message Box" appears → Yes to continue → **Reprint** → Print, or Reprint then pick the specific shipment row and Print. A **Preview** button exists at the bottom of the reprint screen, with a documented annoyance: after previewing, the shipping module resets and the order number must be re-entered.

### VIII.4 Stop-shipment controls

Five independent gates, three of which are overridable by a supervisor at the screen — a good model of *soft* versus *hard* stops.

| Gate | Configuration | Security | Override? |
|---|---|---|---|
| **Customer past due** | `[Shipping] prevent_when_past_due = Y`, `prevent_past_due_days = <n>`, plus *Prevent Shipping if Past Due* on the customer | Module **14**, checkbox **6** unchecked to be stopped | Yes — a supervisor with cb6 enters their security code at the prompt |
| **Over credit limit** | `[Shipping] credit_limit_message = Yes` (message only) or `= Security` (blocks), plus a Credit Limit on the customer | Module **14**, checkbox **5** unchecked to be stopped | Yes — any operator with cb5 can key their code |
| **Shipping hold on the order** | `[Expediting] shipping_hold = Y`; a *Shipping HOLD Maintenance* button appears on Expediting's Load tab (tick Hold, optional reason). Also settable in `Orders > Tracking > Order Final Inspect` | Module **13**, checkbox **3** checked to maintain holds | **No — the documentation states shipping override will not work.** The hold must be removed first |
| **Customer on Credit Hold** | *CREDIT HOLD* checkbox on the customer | — | **No** — and note it blocks **order entry** as well as shipping |
| **Not final inspected** | `[Shipping] auto_override = N` | Module **14**, checkbox **3** unchecked | Message is "nothing to ship"; requires tracking |
| **Customer inspection requirements unmet** | `[Shipping] insp_result_type = T`, `inspection_min_count`, plus Cust Control *Validate Results before Shipping* / *Min Entries* / *Inspection Code* | — | The results window pops automatically at shipping when the customer requires results and the minimum entry count is not met |

`[Expediting] dw_order_top = dw_expd_header_crhudgins` is noted as an Order Top variant carrying a checkbox that clears the shipping hold directly.

### VIII.5 Shipping notifications

A pre-shipment courtesy: email customers that their order is **available to ship**. `[shipping] avail_order_dw_name` selects a custom Available-to-Ship DataWindow carrying the notify function — documented values `dw_ship_avail_by_order_dixie`, `dw_ship_avail_by_order_ohiomet`, `dw_ship_avail_by_order_marsh`.

Each row gets a dropdown with three choices — **Send**, **Manual**, **Skip** — then the **Notify** button acts on the selections. *Send* emails a report of the orders and PO numbers available to ship, **grouped by unique customer id / ship-to address combination**, to the same addresses the shipper would go to. The state machine detail that makes it useful: when **additional** qty/lbs later become available, the indicator resets to *Send* rather than staying *Notified*, so a second notification is visibly required.

### VIII.6 Kanban shipping

Kanban here is a **status established at shipping, not at order entry** — the purpose being to warehouse a customer's finished work: process it, ship it to a Kanban status so it can be invoiced, and print the real shipper later when the customer physically collects.

`[Shipping] kanban_shippers = Y` adds the **Kan Ban** checkbox (above the Exit button). The three-step flow:

1. Ship as normal but tick **Kan Ban** before *Print It*. A shipping ticket prints — which you may keep as backup or not print at all, since another prints on real shipment.
2. `Billing > Create Invoices from Shipped Orders` shows the order as shipped complete, so it can be **billed before the customer has taken it**; continue to Invoicing normally.
3. On collection, `Orders > Kanban Shipping` → enter the order → populate qty and weight as in normal shipping → **Print It**, which prints on the kanban shipper form.

`[Shipping] kanban_mos = Y` allows a kanban shipment to be completed as an MOS (add orders with quantities, then *Display MOS* or *Print MOS*).

The revenue-recognition implication is significant and worth flagging in any comparable design: this bills on transfer to a controlled internal location rather than on delivery to the customer.

### VIII.7 Pickups and signature capture

`Orders > Deliveries > Quick Pickup` and `Flag Shipper as Delivered` accept a physical signature for shippers and Bills of Lading. Hardware: the **Topaz T-L462-HSB-R** SignatureGem pad. Configuration: `[Pickups] signature_pad = topaz`, and `[menu] flag_shippers = Y` if the Deliveries menu is absent (restart).

Installation order matters and the documentation is emphatic: **do not plug the pad in before installing the drivers.** If it was, open `devmgmt.msc`, find the two Human Interface Devices belonging to the pad (unplug/replug to identify them), uninstall both, unplug, install the SigPlus drivers from the Topaz site, then reconnect. Note that Visual Truck does **not** use signature pads — delivery signatures there are captured on a tablet.

---

## Part IX — Billing: invoicing, add-ons and pricing

### IX.1 Invoice creation

The normal path is `Billing > Create Invoices from Shipped Orders`, which turns shipments into invoices in bulk; from that point the invoice tables are authoritative and order-side edits no longer affect billing. `[Invoicing] use_dashboard = Y` opens Invoicing on a list. `[Invoicing] show_inv_list_report = Y` runs the *Invoice List with Notes* report immediately after invoice creation (requires `[Reports] invoice_list_with_notes_dw = dw_inv_list_report_with_notes_standard`) — a good "prove what just happened" habit.

**Grouping rules** are configurable, and the *Invoice by Shipper and by PO* article documents the combination that produces the behaviour "same PO shipped together ⇒ one invoice; same PO shipped on separate MOS numbers ⇒ separate invoices":
`[Invoicing] multi_inv_by_po = shipper`, `multi_order_inv_all = Y`, `1_inv_per_shipper_bill_parts = Y`, plus the *Multi order Invoice/shipper by PO number* option ticked.

**Multi-order invoices** are maintained from the Multi-Order box: *Show/Hide Order List* lists the orders on the invoice; **Rem Ord** removes one (and **removes the currently open order if you do not name one in the white field** — an easy mistake to make); **Add Ord to Inv#** requires a specific and awkward sequence — bring up the target invoice, type its number in the white box, click **Cancel** in the toolbar (the number stays), search and select the order to add, re-enter the invoice number below the button, then click *Add Ord to Inv#*. **Go to Order** navigates within the invoice. This is a procedure that exists because the UI models one invoice at a time; a modern design should treat the invoice as a document with a line collection.

### IX.2 Credits

`Billing > Invoicing` → find the invoice → **Dupe Inv to Credit** → confirm twice (the documentation notes the double confirmation is intentional) → the header flips from Invoice to Credit **in red** → open **Detail** and choose a **Credit Type** from the dropdown → adjust the price row to the credit amount → **Price it** → **Print it**. The credit must then be **locked** (Get Invoices → Lock Invoices) before it can be used in Apply Payments. Note that a full-value credit is simply the same flow without reducing the amount.

### IX.3 Fix Invoices

Two repair tools, both writing directly and both correctly flagged as dangerous.

**Batch repair** (`Billing > Fix Invoices`) exists for shipments that appear on the Create Invoices window but will not create — the documented cause being **loss of connection to the server** mid-create. Enter one of the affected order numbers → *Get Info* → *Fix Create Invoices* → paste the lock information → *Get Info* again to bring back the whole set created under that lock → then **Clear Inv. Flags** for all, or **Clear All** to untick and select individually.

**Delete Invoices** (same window): enter a date range → Get Info → check records → **Delete Checked Invoices**. This deletes the invoice and clears the shipment flags so the shipment reappears on Create Invoices. Documented cautions, in the vendor's own capitals: if the shipment is on more than one invoice **all** will appear (with a warning and an abort opportunity); if it is on a multi-order invoice **only that shipment** is removed and the rest of the invoice is untouched — **but the invoice should be retrieved again in Invoicing so all counters and pricing recalculate.** That last point is a stale-derived-data hazard worth designing away entirely.

**Single-shipment repair:** the *Delete an Invoice* section takes the invoice **Seqno** from the invoice header (the Delete icon in Invoicing does the same). The *Changing the Flags on Ship To Records* section is used to push one shipper back to a prior state — enter the order number, *Get Info*, then **compare the Seqno on each row** to be certain which shipper is being altered, set `Inv Created` and `Do not Create Inv` to Yes/No as needed, verify the **number of billings** (resettable to 0 or 1), then *Press Here to Save Changes*. This is also how a negative/reversing shipment is marked "no invoice".

### IX.4 Add-on charges and surcharges

Add-ons are automatic extra invoice lines — energy surcharges, fuel, environmental fees and the like. Setup begins in Plant Support: create a **Process Code** named for the add-on, then a **Table Key** for it carrying the **GL number** so the charge posts correctly.

**Add-ons 1–5 are configured entirely in program defaults**, `[Invoicing]`, with a consistent key family:

| Suffix | Meaning |
|---|---|
| `_name` | The charge name — **must exactly match the Process Code** |
| `_percent` | The percentage (as a decimal) |
| `_type` | Calculation type (e.g. `PPG`) |
| `_include` | Comma-separated process codes to include — exactly as in the process code table, **no spaces, trailing comma required**, e.g. `WASH,CLEAN,` (used with `add_on_1_type = PPG`) |
| `_include_nonppg` | Same, for the non-PPG case |
| `_exclude` | Comma-separated process codes to exclude, same formatting rules |
| `_minimum` | Floor value — if the calculated add-on is less, the minimum is used. **Add-on 1 only** |

Documented keys: `add_on_1_exclude`, `add_on_1_include`, `add_on_1_include_nonppg`, `add_on_1_minimum`, `add_on_1_name`, `add_on_1_percent`, `add_on_1_type`, `add_on_2_*` (exclude, include, include_nonppg, name, percent, type), `add_on_3_*` (same set), `add_on_4_include`, `add_on_4_name`, `add_on_4_percent`, `add_on_4_type`, `add_on_5_exclude`, `add_on_5_include`, `add_on_5_name`, `add_on_5_percent`, `add_on_5_type`.

**Add-ons 7–10 are configured differently** — in `Maintain > Plant Support > Table Keys > Select Addons`, as a four-field row: (1) the dollar amount or percentage as a decimal, (2) the process code being added, (3) the GL number, (4) `P` for percent or `D` for dollar. Requires `[invoicing] doaddon710 = Y`, and `[Parts] zero_assembly_minqty` — without which **the surcharge does not calculate for minimum price rows when using type `D`**.

**Customer overrides:** `Maintain > Customers` → a different add-on percentage (as a decimal) or **Do NOT do Add On**.

Three documented gotchas: **add-on #3 only works if the customer is flagged TAXABLE**; add-on charges **do not appear on all invoice forms** (check yours, and expect to have it modified); and **distribution records are created when invoices are locked**, not when they are created.

### IX.5 Pricing hierarchy

This is the most consequential piece of configuration in the product, because the same order can price differently depending on one key. `[Invoicing] do_part_maintenance_price` selects the search order:

**`= Y`**
1. Part Maintenance pricing — part id match
2. Quote ID — part id match
3. Part Pricing structures (Billing > Quotations, or Billing > Pricing > Part Pricing)
4. Customer Process Step pricing, then Process Step pricing

**`= Q`**
1. Quote ID on the order header (pulled in when the part id matches, or selected during order entry)
2. Part Maintenance pricing (part id match; Simple or Assemble)
3. Part Pricing structures
4. Customer Process Step pricing, then Process Step pricing

The general principle underneath both: **part match first, then overall Process Master pricing, then step-level pricing** — where step level can be driven by standard steps or by grids that take part and order attributes (material, inspection, dimensions) into account. The full typical chain, as the KB lists it: part id if on a quote or part price structure → Part Maintenance price (Assembly / Simple) → Process Master pricing (customer/process first, then process alone) → Process Grid / Inspect / Dimensional pricing tables → Customer Process Step pricing → Process Step pricing.

Two keys change how structures are matched:

`[Invoicing] no_cust_process_ID` — for structures built against process masters with a part id assigned:

| Value | Matching |
|---|---|
| `Y` | Structures for the process master, **regardless of customer** |
| `N` | Structures for the process master **and that specific customer** |
| `B` | Process master + customer, then process master with **no** customer |
| `C` | Process master + customer, then **customer process pricing** (customer id / process code only, ignoring eq/gr/cc), then process master with no customer |

`[Invoicing] process_search_noparts = Y` — restricts process-id structure matching to structures that have **no parts assigned**. Without it, a structure matching only on process id is used even if it carries a completely different part; with it, only partless structures qualify. The article's own explanation is that invoice-create falls back from quote id → part → part/process → process id, and this key makes that last fallback safe. This is exactly the kind of subtle correctness switch that should be default behaviour rather than opt-in.

### IX.6 Consolidated pricing window

`Billing > Pricing > Maintain Step Level Pricing` merges the pricing modules into one tabbed window (quotes and part pricing excluded). Security **Module 22**, where the checkboxes literally decide which tabs are visible:

| Checkbox | Grants |
|---|---|
| 1 | Access this module |
| 2 | View only — no updates |
| 3 | Screw / Washer |
| 4 | Price Grid |
| 5 | Process Inspection |
| 6 | Process Grid (custom pricing — not enabled automatically) |
| 7 | Process Step |
| 8 | Customer Process Step |
| 9 | Part / Process Grid |
| 10 | Metal Prices |

Each tab has its own search fields plus next/previous arrows to walk matches.

**Screw / Washer pricing** is a size-and-weight matrix, and its setup shows how far the pricing model can bend. `Billing > Price Keys`: `Price Key` (user-defined, assigned to parts in Part Maintenance), `Process`, `Multiplier` (applied when using the Equivalent Price Key), optional `Customer`, and `Equivalent Price Key` — which equates one key with another, the documented example being *screw price = washer price*. Diameters come from `Plant Support > Part Maint Tables > Convert to Decimal` (`Value To Convert` → `Decimal Value`, optional per-customer). `[Invoicing] screw_pricing = SWD` selects the screen view.

Matrix fields: `Part Type` (from Price Keys), `Process`, `Diameter` (from Convert To Decimal), `Length From/To`, `Thickness From/To`, `Pounds From/To`, `Over Len%`, `Plate to Gauge Process` (redirect to a different process code instead of the one on the order — used **in place of** the price key multiplier), `Insp – min/max`, `Setup / Price / Min`, `Form` (the price-per unit type), `Issue Date` (auto), and a customer dropdown for customer-only pricing. **Over Len%** semantics: enter a decimal percentage (`.05` = 5%, `.2` = 20%) to charge for length beyond the longest listed length, with `Size` expressing units (`.5` = per half unit) — and a documented caveat that **when Over Len% is used the weight break is ignored and the last one is taken**, plus an admission that some processes are hard-coded. **Price Grid** covers dimensional pricing with pre-set formulas.

### IX.7 Billing Quotations

`Billing > Quotations` or the toolbar icon → **New**. Customers *or* **customer leads** may be quoted (leads can be converted to customers later), but the documentation warns that **quotes tied to an invalid customer/lead will not link to orders and will not carry to invoicing.** Header: customer/lead, `Sales ID`. Then **Part / Prices**: `Part Id / Name / Description` — **Part ID is required for pricing, because the customer id + part id pair is the match key** — `Process Code`, optional `Equip` / `Group` / `Cost center`, `Setup`, `Price`, `Unit` (how you charge), `Min`. **Add Row** for more price lines, Save; **Add** for more parts; **Save / Print**.

**Quotations dashboard:** `[quotations] show_dashboard = Y` opens Billing > Quotations on a three-section dashboard — Visual Net quote requests, quotes requiring follow-up (with a sales-person filter and a count), and expired quotes. Security **Module 21** for Quotations, checkbox **3** to close/re-open quotes directly from the dashboard, and **Module 63 (Visual Net)** checkbox **3** for `Visual Net > Quote Requests`.

---

## Part X — Accounts Receivable and the general ledger interface

Visual Shop keeps its own receivables sub-ledger and posts **summary journal entries** to an external accounting package. It is not a general ledger.

### X.1 Batches and cash application

`A/R > A/R Batch Entry`. **Four batch types**, chosen at creation, each dictating the default payment type used when applying:

| Type | Payment type source |
|---|---|
| **Check** | The default; payment type `Check`, **not changeable** |
| **Credit Card** | `[A/R] cc_batch_paytype = <payment type>` |
| **ACH** | `[A/R] ach_batch_paytype = <payment type>` |
| **Inter-Company** | No default; the batch header offers a dropdown of the Payment Types table |

Payment types are created in `Maintain > Plant Support` (older builds: Special Tables → Payment Types; newer: `Plant Support > A/R Invoicing > Payment Types`).

**Creating a batch:** Add/Change Batch → `Batch Date` → `Batch Type` → per check line: `Check/CC#`, `Date`, `Customer`, `Dollars`, `Comment`, `Reference No` → Tab or **Add Row** for the next check → Save. The check listing can be printed or exported (*Save As* → Excel with Headers) before Close.

**Applying payments** — `A/R > Apply Payments to A/R`. **Hard prerequisite: invoices and credits must be locked before they can be paid.** The screen opens with a right-hand list of customers who have check rows in the current batch; clicking a name loads them, or a customer can be selected on the left and tabbed (the legacy behaviour). The customer's **available balance** is highlighted mid-screen and decrements as the check is consumed; above it sits the **batch** total, which is deliberately distinct from the customer total.

To apply: double-click an invoice → choose pay type → enter the amount (full or partial) → **Pay It**. A short-paid remainder simply stays as the invoice balance, and the batch summary updates on save. **Discounts and adjustments** are handled by adding a second row on the same invoice (**Add**, then set Pay Type to Discount or any adjusting type) and entering both amounts before *Pay It*. **Unapplied cash** goes to **OAC** (On Account Credit): click *Place OAC* → OK → enter the amount in the On Account box → *Place OAC* again → confirm → Save.

**Auto Pay** handles long invoice lists: click **Auto Pay** → the first unpaid invoice number defaults in → highlight any invoices to skip → optionally tick *Only fully pay invoices, no partials* → **Auto Pay It** → *Hide Auto* to return.

**Closing the batch** generates two reports, and the documentation is explicit that **Print must be clicked before Close Batch** — the reports are not recoverable afterwards, which is a poor design for an audit artefact.

**Applying credits** works in an open batch or in a deliberately created **zero batch**. Select the customer and tab (a "no check in this batch" message is expected and harmless), click the target invoice, **Add**, enter the amount to use (the credit may exceed the invoice), set Pay Type to **Credit**, enter the credit document number, **Pay It**, repeat for further invoices, then Save. A check and a credit can be applied to the same invoice in the same batch by creating two payment rows.

### X.2 Finance charges

`A/R > Finance Charges`: enter the **aging date** and a **number of days** past due, then Run. Per customer, *See Invoices* shows what is being charged, and individual invoices can be ticked **Dispute** to exclude them; unticking **Calc** exempts the customer entirely. **Create Finance Charges** generates them — and the documentation warns that **nothing appears to happen, and pressing it again creates duplicate charges.** Finance charges are marked with an **F** on most reports. *Print Invoices* / *Print Invoice* issue them. **Edit History** allows amounts on previous finance charges to be changed, and the eraser button next to **FC** deletes one.

The percentage is set on `Maintain > Plant Setup` (under the remit-to address) with a per-customer override in `Maintain > Customer` (bottom right).

### X.3 Report and utility inventory in A/R

**Aging / Summaries** (security **Module 23**, checkbox 1):
- *A/R Information*: **A/R Summary** (open A/R as of today, plus a date range summary of invoices/credits issued, checks received, average pay amount and days), **Open A/R by Customer** (used to discover which invoices a check paid), **Inv Detail** (payments against one invoice), **Last Payment Date**.
- *A/R Summary Reports* — two reports giving open A/R **as of a specific date**, with a critical operational caveat: **they re-open closed invoices, so `A/R > Close Invoices` must be run afterwards.** Side effects in reports are a design defect worth avoiding.
- **A/R Aging Summary** (optional age/cutoff date, days to age on, Excel export).
- **Aging/Summary with Cutoff Date** (with a one-line-per-customer summary mode to shorten runtime).
- **Aging/Summary Trial Balance** (aging date, summary mode, *Show Contact*, all or one customer).
- **Aging/Summary by Customer** (one at a time; *Show month with doc#*).
- **Aging/Summary over X days / $** (radio aging options, an "and over dollar" threshold, age-on date, summary mode — and note it shows **all** invoices for any customer that qualifies).
- **A/R Collections** / **Closed A/R Collections** — call notes against past-due invoices; **paid invoices drop off automatically**, with the closed report retaining the history. Double-clicking an invoice row opens it in Invoicing.

**Statements** (`A/R > Statements`): radio to restrict to customers with invoices over X days old (or current for all), *And Over $*, *Age On Date* (may not affect every statement form), *Pick a Customer*, *Multi Order / Invoice Statement*, and a *Customer Name Range* (e.g. A – Hi).

**Payment Report** (`A/R > Payment Report`): payments for a date range, optionally one payment type. Used in the month-end procedure.

**Preliminary Closing Report**: checks payments against invoices before closing, sortable by customer, batch date, or start–stop date.

**Monthly sub-folder:** *Monthly AR Checks* (date range, optional non-AR checks, sort by customer or salesperson); *Monthly Batch Report* (all batches in a range); *Monthly Payments* (payments **not** yet posted to GL, totalled by GL, pay type or customer, with an "up to and including" date); *Monthly Purge/Archive* — which purges per `Maintain > Archive / Purge Control` and carries the flat warning **"There is no option to undo this action."**

**Credit / On Account Report:** credits created during cash application. *On Accounts* selector: **All** (including credits created in Invoicing), **On Account** (cash-application credits only), **OAC Open Batch** (on-account credits in a batch not yet closed).

**Balancing AR sub-folder:** *Invoice Payment Balances* (checks and the invoices they were applied to, by date range) and *Check Balancing* (checks in the open batch not yet applied).

**AR Utilities:** fixes payment and some invoicing problems by writing **directly to the database with no undo**; the documentation says to call CSI.

### X.4 Posting to the general ledger

**Post Payments to GL** (`A/R > Post Payments to GL`): enter a date (includes everything not yet sent, dated on or before it) → Run → Print (with Printer Setup) → **Create Export** (path comes from a default and can be amended) → **Update Now**, which marks the payments as exported so they cannot go twice. **AR GL Recap by Batch** reports export information by GL number and is explicitly historical and non-editable — the right call. **Post Sales to GL** lives on the Billing menu and behaves symmetrically for invoices and credits.

**What the export is, precisely:** a summary general journal entry — **GL number, date, dollar amount only.** The documentation states plainly that invoice number, check number, order number, customer and PO are **not** included unless a custom export is written. That is a deliberate boundary: Visual Shop holds the detail, the accounting package holds the balances. It also means the accounting system cannot answer any customer-level question, which is why Customer Expediting and the AR reports exist.

**Named interfaces:** Sage 100/200 (formerly MAS 90/200) is the recommended option and is a **SQL table link** rather than a file export, via a GL link from Partners In Technology; QuickBooks, QuickBooks Online and Sage 50 (formerly Peachtree) are the most common; SBT, Great Plains, Business Works and Macola are also in the field. Documented export type values include `PEACHTREE_DDE`, `QAD`, `MAS90B`, `SBT`, `QUICKBOOKS-CLASS`.

**GL number assignment** is covered in Part II.2: `[Invoicing] sales_gl_number` / `credit_gl_number` for the A/R side of sales journal entries (the offsetting side coming from Equipment or Table Keys), and `[A/R] AR_GL_number`, `check_gl_number`, `discount_gl_number`, `adjustment_gl_number`, `writeoff_gl_number` for cash application (each optionally driven from the Payment Types table instead).

### X.5 Month-end close checklist

The vendor's sequence, which doubles as a good specification for what a close routine must verify:

1. **Confirm nothing is unlocked.** `Reports > Visual Shop Reports > Billing > Invoice Detail Listing`, date range, **Locked = NO**, Run. Anything listed must be locked to be in the month — **except** rows where `Inv / Cred` is `P`, which are unshipped orders and are ignored.
2. **Close paid invoices.** `A/R > Close Invoices > Click Here to Close Paid Invoices`. This deletes nothing; it stops zero-balance invoices appearing on A/R reports.
3. **Close A/R Period.** `A/R > Close A/R Period` → enter the closing date → **New Closing** → verify the ending balance against the Aging/Summary With Cut Off Date report → **Save** only if it balances.
4. **Aging/Summary with Cutoff Date** — tick one-line-per-customer for speed, use the same stop date, Run, print, compare the total to the Close A/R ending balance.
5. **Sales** — any sales report (Sales by Customer is suggested), same date range, tick *Include Credits*; compare to the Close A/R sales figure **after subtracting the credit total**.
6. **Payments** — `A/R > Payment Report`; compare to the Close A/R payment amounts. Any type not itemised on Close A/R lands in **Other**.
7. **On-account credits** — `A/R > Credit / On Account Report` with *On Accounts = On Account*; compare to the OAC total.

If the numbers disagree the instruction is to compare against the sales and A/R reports, fix what can be fixed, and call support. There is no automatic reconciliation and no period lock beyond the closing record itself.

---

## Part XI — Ancillary modules

### XI.1 Corrective actions and reworks (CAR)

Two related but distinct mechanisms, distinguished by what they hang off.

**Order-based reworks / corrective actions.** During Order Entry an order can be flagged as **Rework**, creating a Corrective Action associated with it; Expediting then shows "Order has Reworks". Reachable at `Notes > Corrective Action > Corrective Action` (New, or search) and via Expediting's **Rework** tab. Security **Module 35 (Corrective Action) checkbox 1** — required both to create reworks and to view them in Expediting.

Entry: open or create an order → **REWORK** → the window lists reworks *on* this order (top) and reworks *referencing* this order (bottom) → **Add** → `Type` is a required dropdown, everything else optional → if **Order Related** is ticked, the `Rma code` must be a valid order number **for that customer** → Save.

Two important limitations, both stated: **the Rework button only exists on five Order Top variants** — `dw_order_header_entry_dci_aerotech`, `_caltech_1`, `_penna_fl`, `_peening`, `_gen_mp` — and **a CAR created from the menu without referencing an order cannot be viewed in Expediting.**

**Part-based reworks.** Created from **Order Management** (security **Module 35 checkbox 2**), viewable read-only in Order Entry and Part Maintenance (the Rework icon un-greys when reworks exist; the list can be printed but not edited). When a new part rework is created, Visual Shop **auto-fills the originating load** from the load selected at creation, and the semantics are defined precisely: *originating Load* is the original load number, *Load qty* is the originating load's quantity **after the split**, and *Reject qty* is the new load's quantity. `Type` auto-fills for a part rework. All rework types are visible under `Notes > Corrective Action`, but **only order reworks can be created there.**

**Setup.** `Maintain > Plant Support > Special Tables > Car Values` → *Maintain List* → add values and descriptions for each of: **Type, Status, Int. Escape, Root Cause, Corrective Action, recur prevent, Impact Description, Department** — each independently flaggable as a dropdown. In Security, the operator must additionally be ticked as **CAR User**, which is what places them in the assignment dropdowns in Order Entry and the Corrective Action module.

**Reporting:** `Operations > Detailed Rework by Part Number` — start and end date, Type (from Car Values), one customer or all.

The design instinct here is right — an 8-dimension classification of nonconformance with root cause and recurrence prevention is a legitimate quality record. What is missing is any linkage to cost, any workflow/approval state machine beyond *Status*, and any due date for the corrective action.

### XI.2 Inventory and purchasing

Flagged in the documentation as a **legacy module supplied "as is"**, with customisation available only on the printed forms and at cost. Its scope:

- Part-related inventory: inventory products are assigned to part records in Part Maintenance; **requirements are identified at order entry**; requirements can be **committed** to an order at order-entry save or separately in Expediting; inventory is **depleted** either during tracking inventory usage or at shipping depending on defaults; screens and reports show availability as *On Hand* less *Committed to Open Orders*.
- Non-part items: office supplies, maintenance supplies, chemicals.
- Purchase orders, including **credits and returns**.

`[Inventory]` keys:

| Key | Meaning |
|---|---|
| `use_inventory = Y` | Shows `Process > Inventory` on the menu (`N` removes it) |
| `inventory_label` | Custom label form name, or blank for default |
| `order_entry_commit` | `Y` commits inventory at order-entry save; `N` requires Expediting |
| `po_copies` | Number of PO copies to print |
| `po_form` | Custom purchase order form name, or blank for default |
| `scrap = Y` | Adds a scrap checkbox and order ID to the Adjustment screen — **neither can be edited after save** |
| `shipping_auto_usage` | `Y` depletes inventory automatically on shipment; `N` requires the Inventory Usage screen |
| `allow_ship_no_inventory` | With `use_inventory = Y`, `shipping_auto_usage = Y` and `bypass_detail = Y`: `N` **stops the shipment** when on-hand is insufficient; `Y` allows it, which affects committed quantity and the order requirement (shipping does not clear it) |
| `auto_vendorid = Y` | Vendor maintenance auto-assigns vendor numbers |
| `bypass_detail = Y` | For "assembly"-style or expense-only usage — **explicitly not to be used when paint/powder usage is the primary function** |
| `po_detail_comments = Y` | Comments dropdown on product detail lines (custom forms only) |

**Product types** and how each behaves is the most useful table here — note they differ in *which* quantity fields are maintained:

| Prod Type | Behaviour |
|---|---|
| **Powder** | Used in create PO and receive product; Qty on Order / Qty on Hand both maintained |
| **Liquid** | Qty on Order / Qty on Hand maintained |
| **Other** | Qty on Order / Qty on Hand maintained |
| **Supplies – Tracked** | Qty on Order / Qty on Hand maintained |
| **Supplies – Not Tracked** | **Qty on Order only**, updated at PO creation |
| **Expense** | Used in create PO and **receive invoice** (not receive product); Qty on Order updated at PO creation but **not maintained after receipt** |

Product fields: `Prod Number`, `Prod Type`, `Short Desc`, `Prod Unit` (dropdown, extendable via the magnifying glass), `Vendor Id`. Created at `Process > Inventory > Product Maintenance > Add`.

### XI.3 Attachments, part PDFs and scanning

**Part PDFs.** `[Parts] part_pdfs = Y` enables PDF attachment to memorized parts. To print the PDF with the order: `[order printing] print_part_pdfs`. The documented behaviour is crude but honest — **the PDF prints immediately after the shop order with no identifying header; it simply launches Acrobat and prints.** Refinements: `pdfs_first_part_only = Y` (only the first part's PDF on a multi-part order) and `pdfs_load_parts_only = Y` (only parts with a quantity or weight on the load being printed).

Two storage strategies: **(1) inside the database** — activate the part, **PDF** button, **Add**, select the file, Exit, Save; or **(2) linked from disk** with `[Parts] pdf_use_file`, where the path is stored and **the exact folder and filename must remain stable** or printing breaks.

**Order attachments.** `[Orders] scan_pdfs` adds an **Attachment** (paperclip) button to Order Entry, which also appears in Expediting. It scans directly or selects existing files, saved into the database against the order. These are **review-only — they never print with the order**, though they can be viewed and printed manually. Two conveniences: the previous PO can be attached to the order (via *Add File* or the list's shortcut menu), and pictures can be double-clicked or shortcut-menued to open in the operating system's default viewer. The paperclip is available in **Expediting** and **Billing > Quotations** with no default required.

**Scanning technology.** Visual Shop scans through a **TWAIN** interface using the **EZTWAIN** driver. Requirements: a TWAIN-compliant scanner; recommended settings **200 dpi black and white**, going to **300 dpi** where barcode recognition is needed. A documented failure mode: some scanners ignore the requested 200 dpi setting, producing lower-quality PDFs from within Visual Shop than from the scanner's own software. Suggested document scanners: **Canon DR-M160II** (reported to work extremely well) and **Canon DR-M260**.

### XI.4 Barcodes

Barcode fonts are installed per workstation by **VSExtras.exe** (`visualshop.com/customer/Extras/VSExtras.exe`); the legacy method is to extract the supplied Barcode zip and paste the fonts into Control Panel → Fonts.

Two fonts, with a genuinely useful distinction:
- **`C39P36DmTt`** — renders the barcode only.
- **`C39HrP24DhTt`** — renders the barcode **with the human-readable text**.

The encoding format for operator scanning is **`*/EEID/E1315*`** — Code 39 start/stop asterisks around a typed field marker and the operator id. The documented use case is drivers: add the operator, generate a barcode for their operator id, print and laminate it as an ID card so they can "scan and go" throughout Visual Shop.

### XI.5 Support tools the vendor recommends

- **Greenshot** (`getgreenshot.org`) — partial-window capture, markup with text and shapes, copy to clipboard. Used throughout the KB itself.
- **PDFCreator** (`pdfforge.org/pdfcreator`, Free edition) — for automating save-to-folder printing. Setup notes: untick the two boxes at install, **Skip** PDF Architect, **Decline** the McAfee bundle, then in *Profiles* → *Destination Folder* toggle **Interactive → Automatic**, untick *Use PDF Architect for PDF files*, set the target directory, Save.
- **TeamViewer** for remote support: browse to **visualshopsupport.com** typed into the **address bar, not a search box** (security software may block the redirect), or go direct to **get.teamviewer.com/supportcsi**. If an instance is already running, choose *Show Running TeamViewer* rather than closing the message, and read off the Partner ID and password. Session links can also be emailed. If nothing connects, TeamViewer is likely blocked by network policy.

---

## Part XII — Reports

Reports are reached at `Reports > Visual Shop Reports > <family>` or the consolidated `Reports > VS Reports All – N – One`. Two cross-cutting behaviours:

- **`[Reports] auto_date_range`** — most date-range reports pre-populate the **last 30 days**; setting this to `N` turns that off globally.
- **Custom variants are selected by program default**, with the pattern `[Reports] <report>_dw = <dw_name>` or `[Reports] <report> = <CUSTOMERNAME>`. Nearly every family has customer-specific forks, which means "the Backlog report" is not one report but a family whose behaviour depends on a key.

Security is per family:

| Module | Report family |
|---|---|
| **20** | Billing / invoicing reports |
| **21** | Pricing (and Quotations) |
| **23** | A/R |
| **24** | Shipping |
| **25** | Operations |
| **26** | Sales |

Adding the module is sufficient for several families — checkboxes need not be ticked.

**Shipping reports (Module 24):** Available to Ship — by date, by route/carrier/both, by Carrier In, by Carrier Out (each with *COD only* and *Notes* showing push-pin notes); By Date (date only, or grouped, with weight-decimal and show-summary options); By Customer (all or one, date range, plus a custom variant behind `[Reports] ShipByCustomer_type = plateco`); By Order; By Material; By Part ID; By Route – All (`[Reports] ship_by_route_all_dw = d_ship_by_route_all_triple_cities`); By Route Individual; Shipping report by customer (multiple parts, plant id, cost center); Order By Route (print control by Target Date or Ship Date); Shipped Lbs. by Day (graph); **Turnaround reports** (one or all customers, date range, exclude holidays and weekends, run by customer / process / group / equipment / area run in / GL number / summary by customer / approval ID, summary-only option); **Turnaround vs Target Date** by customer, process, equipment and summary (sortable by customer id or by on-time percentage), plus a by-load version; *Print shippers with the Order* (prints a shipping ticket **without recording a shipping event** — a useful dry-run idea); *Current Orders Over Credit Limit*; *Days from Order Entry to Shipment*.

**Operations reports (Module 25):** open orders, WIP, due dates, backlogs, customer-specific part and order reports, part history, part lists, order history. The **Backlog** family alone shows the customisation pattern clearly: by Customers (date range or *No Date Range*, one or all customers, shipped / open / both / all-but-deleted, COD only) with *With Process ID* and *With Part* variants and three named customer forks — `[Reports] backlog_by_customer = TECH METAL`, `= JMDINDUST` (adds an Order Type column from the order type table and **requires `dw_order_header_entry_jmdindust`** to see it), and `= TRUTEC` (which additionally needs `[load_split] onhold_option = Y`, `[order_status] log_change_reason = Y`, and the deletion of `[order status] tracking = FPM`, taking its hold reason from customer events coded *Load Status Changed* or *Load on-hold*). Also: Backlog by Equipment, by Process Code (`[Reports] backlog_by_procode = d_oper_backlog_procode_ssplating` removes Material), by Group, by Group/request date, by Group (complete date), by Process/Inspect, by Date (powder and custom versions), by Date with Customer List, Partial Shipped Jobs, and by Target Date (date and/or time range, or by order number).

**Billing reports (Module 20):** Invoice Detail Listing (date range; locked/not/both; COD/no COD/both; printed/not/both; credits only excluding on-account credits; all cost centers when cost-center-as-plant is used) and a short-form version; Open Invoices; Invoice Detail – Truck Route (shipped or invoice date, subtotal by day or customer, route); Invoice List with Order ID; the same with customer summary and taxes (a *Tax Process Code* defaulting to `GST`); **Invoice List with Notes** (No-Charge-only filter; custom version as described above, where a multi-order invoice may span ship dates so **only orders shipped within the range appear — which may not be all the orders on the invoice**); Incomplete Invoices; Daily Sales Graph (**range should not exceed 31 days**); Backlog $ by Process and GL; Order Value Using Process Part; Daily Invoice Recap by Customer; Part/Process Billing Summary; Part Invoiced vs Part Shipped; **Quote Listing** in five variants plus Expired Quotes, Expired Prices, Parts, and one drawing from both process-part and price structures; Quote Listing with Invoices; Invoice Report with Parts and Prices; Dollars Invoiced per Order (by order number, or by date range across locked invoices); Days from Shipment to Invoice; Past Due Invoices; Invoice Detail Tax Report; Quotes Converted to Invoices.

**Sales reports (Module 26):** Sales by Equipment TY/LY (one line per equipment, up to 13 periods, show credits, fiscal year, pounds, dollars, sort by descending dollars or by equipment). A notable documented calculation change: **VAR % is now VAR $ ÷ Last Year $**, previously VAR $ ÷ This Year $, revertible with `[Reports] sales_variance_thisyear = Y` — exactly the kind of change that should be a versioned definition rather than a switch. Also: Sales by Customer TY/LY (report period fiscal year or fiscal month+year; comparison Single Year / TY-LY / TY-LY-PR; report types Standard, Summary, Curr Year Pennies, Curr Year Pennies 13 Per — each only valid for certain comparisons; show full address; exclude process codes); Sales by Customer TY/LY by Salesperson (one page per salesperson with grand totals last, optional zero-dollar customers) and a 12-month version; Sales by Process; Sales by Material; Sales by Group (filterable to Group A / Group B); **Sales by Day / Inv Distrib** with report choices *Cust by Day*, *Group by Day*, *Equip by Day*, *GL by Day*, *Proc by Day* and *Detail*, plus a *Show PTD/YTD/Last YTD* option that adds period-to-date, year-to-date and last-year-to-date columns (and, except for Cust by Day and Detail, unlocks *Show All Totals* and *Show Projected Totals*); Sales for a day by Process/GL; Sales Current Month Comparison.

**Pricing reports (Module 21):** Current and Expired Prices; Part Price Report (original retrieval, active-only, inactive-only; `%` wildcard on part number); Screw and Washer Prices (Get/Print Cover, Standard Price List, Special List); Customer Pricing Report (choose pricing types; customer-specific only or customer-specific plus generic; current or current-plus-expired — with the caution that running all customers permits only **one** pricing type and may be inadvisable on a large database); Customer Part Pricing for Heat Treat and Plating, described as **"VERY CUSTOM"**, driven by group definitions in defaults: `[Reports] part_price_group1_UOM = B`, `part_price_group2_name = Plating`, `part_price_group2_pcodes`, `part_price_group2_UOM = B`, `part_price_group3_name = Sorting`, `part_price_group3_pcodes = Roll Sort, Vision Sort`, `part_price_group3_UOM = M`; Part Maintenance Quotes Conversion Report with Order Entry Dates (quote and order date ranges, conversion type not-converted / converted / both, one or all customers, optional pre-priced invoices).

**Tracking reports:** Order Feedback (populated from the **Feedback** button in Tracking — enter order and load, OK, type the operator/order feedback, Save); **Reject Report** (failed inspections from tracking, by date range); **Area/Process Report** (detail or summary, batch or continuous, date range defaulting to one day, specific area and operator or all) with named custom forks `[Reports] area_process_dw = BFG | FPM | BRADDOCK TFL`; **Tracking Backlog** — a step-level backlog with include/exclude semantics for process code, group, equipment and cost center, sortable by order id or date, showing current or next step, with an option to skip no-track steps. Its custom variants illustrate how far these forks diverge: `[Reports] tracking_backlog = dw_tracking_backlog_report_fpm` (**quantity and weight come from the order-load, while material is `mat_trade_name` from the load-1 process master — i.e. material is always order-level, never load-level**), `_pride_plating` (adds a Save Step Data button and shows a blank row when the last step was a no-track step), `_metal_treater` (adds order date range and order-level criteria with material, process id and inspect code dropdowns), `_swd` (adds container count and type), `_mpp`. Also **Quick Track Report** (one customer or all).

**Customer Activity reports:** Customer Listing (optional route and carrier; a salesperson can be selected and **Make Changes writes it back to the database** — a report that mutates data, which is a pattern to avoid) with a **Label** button producing **Avery 5160** labels (include contact name, exclude COD, exclude credit hold, active only; a letter range or an activity-since date; optionally use names from the Contact table); Customer Event List (beginning-through date or a from/to range, specific customer, event code); Customer Credit History (All / Prior Year / Prior 6 Months / Prior 3 Months; all or one customer) with custom variant `[Reports] customer_credit_history_dw = dw_cust_credit_history_report_sands` adding Terms, Credit Limit, Sales YTD and Sales CSR columns; Customer Credit History by Territory (by salesperson); Customer Email Address Report (active customers, selected email groups).

**Process reports:** exactly one — **Process Step List**, which opens a criteria window first; OK runs it for all processes, or one or more columns can be constrained.

**Custom report library:** `Reports > Custom Report Maint > Display Report List` can open an alternative `.pbl` (the documented example being `crhudgins_reports.pbl`, browsing to the Visual Shop directory if it is not shown), then double-click a report. This is how per-customer report libraries are delivered outside the main build.

---

## Part XIII — The forms engine

### XIII.1 How forms work

Every printable document is a PowerBuilder **DataWindow** object compiled into a `.pbl` library shipped with the build — order forms in `htordfrm.pbl`, shipping forms in `htshpfrm.pbl`, and so on, with per-customer libraries such as `crhudgins_reports.pbl` for bespoke reports. Selecting a form means **writing its object name into a program default**. There is no template designer for customers; new layouts are authored by the vendor.

`Reports > Custom Reports Maintenance` allows a form to be previewed with retrieval arguments supplied manually, which is the only self-service way to see what a candidate form produces before adopting it.

The selection keys, which together constitute the form-binding contract:

| Document | Key |
|---|---|
| Order form | `[order printing] form_type` |
| Order label | `[order label] label_type` |
| Container label | `[order label] container_label_form` |
| Shipping label | `[Shipping] label_form` |
| Shipper — one part | `[Shipping] one_part_form` |
| Shipper — multi-order | `[Shipping] multi_order_form` |
| Certification | `[Certifications] certform` |
| Invoice | `[Invoicing]` invoice form key |
| Billing quotation | `[Quotations] QuoteFormNumber` |
| Part Maintenance quote | `[Quotations] QuotePPFormNumber` |
| Multi-part quote | `[Quotations] MultiPartQuoteFormNumber` |
| A/R statement | `[A/R] statement_form` (`statement_form_multi` for multi-order) |
| Bill of Lading | `[bill_of_lading] bol_form` |
| Purchase order | `[Inventory] po_form` |
| Outside-processing PO | `[order printing] outside_po_form` |

Related label switches documented alongside: `[order label] labels_by_part`, `[order label] container_labels_only = Y`, `[order label] Part_Description = Y`, `[orders] always_request_cont_labels = Y`, and `[Shipping] cust_ship_label = Y` (required by the multi-order label pair `dw_ship_label_ms_cr_plate_1` / `_2`).

### XIII.2 Catalogue scale

Counted from the vendor's own form tables and screenshot indexes:

| Family | Distinct forms documented |
|---:|---|
| Order print forms | **167** |
| Shipping forms — one part | **146** |
| Shipping forms — multi-order | **94** |
| Invoice forms | **~130** |
| Certification forms | **~84** |
| Quote forms — Billing Quotations | **31** |
| Quote forms — Part Maintenance | **26** |
| Quote forms — multi-part | **19** |
| Order labels | **27** |
| Container labels | **24** |
| Shipping labels | **16** |
| A/R statements | **19** |
| Outside-processing POs | **13** |
| Purchase orders | **8** |
| Bills of lading | **4** |
| **Approximate total** | **~1,100** |

That number is the single most important lesson in this report. A product that answers every layout request with a new compiled object accumulates roughly a thousand artefacts that must survive every upgrade, and it produces the coupling seen throughout this document — where a *capability* (order-level pricing, the rework button, an order-type column) is only available if you happen to be using the right form variant. **The correct architecture is a data-driven template engine with a declared, versioned data contract per document type, and layout as configuration rather than as code.**

### XIII.3 Representative naming conventions

The names are systematic enough to be informative. Prefixes: `dw_order_print_form_*` (orders), `dw_ship_form_*` (shippers; `_ms_` marks multi-order, `_1copy` a single-copy layout), `dw_cert_form_*`, `dw_inv_form_*`, `dw_quote_form_*` / `dw_quote_process_part_*` / `dw_quote_pp_*_multi`, `dw_order_label_*`, `dw_order_container_label_*`, `dw_ship_label_*`, `dw_ar_statement_*`, `dw_bol_form_*`, `dw_vpo_form_*`, `dw_order_outside_po_*`.

Suffixes encode either a customer name (`_kachina`, `_wolverine`, `_valmont`) or a behaviour, and the behavioural ones are the useful vocabulary:

- `_shipped_totals` — cert prints shipped totals rather than order totals.
- `_certsteps` — cert prints process steps.
- `_with_signature` — cert prints an electronic signature.
- `_1_of_x` — labels numbered "1 of X" across a container set.
- `_hd_and_signoff`, `_lt_signoff`, `_signoff_*` — order forms with header/detail and operator sign-off blocks.
- `_no_steps` — order form suppressing step text.
- `_no_print_files_7` — invoice family that suppresses print-file generation.
- `_noproc` — shipper that omits process information (i.e. hides what was done from the packing document).
- `_nolb`, `_no_decimals`, `_grosswt`, `_doz`, `_multiseqno`, `_lbs_to_piece` — unit and rounding behaviours.
- `_gst`, `_plant_code`, `_soldto`, `_no_past_due`, `_fc` — tax, plant, address and finance-charge variants.

The stock/starting points named in the documentation are `dw_order_print_form_default`, `dw_ship_form`, `dw_ship_form_1copy`, `dw_cert_form`, `dw_cert_form_generic`, `dw_cert_form_with_signature`, `dw_inv_form_1` … `dw_inv_form_6`, `dw_quote_form`, `dw_order_container_label`, `dw_ship_label`, `dw_ar_statement_soldto`, `dw_order_outside_po_vendor`, `dw_vpo_form_1`. Complete per-family name lists are recorded in the source articles indexed in Appendix B (the *Viewing Forms* folder, 22 articles).

Two cert forms carry documented restrictions worth noting as examples of hidden constraints: `dw_cert_form_5` **cannot be used for a shipper cert**, and process-cert setups require a custom form because two certs share `order_id / ship_seqno`.

---

## Part XIV — Security model

### XIV.1 Operator records

`Maintain > Security > Operator Security` → **New Employee** or Search. The standing instruction is: **do not delete operators** (unless just created) — mark them inactive, because operator records must persist to resolve names on audit logs. That is the right rule, and it is worth enforcing structurally rather than by documentation.

| Field | Notes |
|---|---|
| `Operator ID` * | Required; **must be greater than 1000** |
| `Operator Passnumber` * | Required; changeable; used to gain access to modules |
| `Job Title`, `First Name`, `Initials`, `Last Name`, `Short Name` | Short Name is the system-wide display reference |
| `Clock Number`, `Assigned Dept.` | |
| `TEAMS` | Team labour tracking |
| `Valid Days` | Days of the week the operator id is valid |
| `Effective date` | Defaults to today |
| `Expires On` | Passnumber expiry (a default date is supplied) |
| `Warn On` | Advance expiry warning date |
| `Start Time` / `End Time` | Shift window |
| `Shutdown Timer` | Idle minutes before automatic logoff; **0 = unlimited** |
| `Cert Exp Date` | Certification expiry, marking the operator as a technician |
| `Enabled` | `No` keeps the record for reporting only |
| `Master Format` | `Yes` makes the record a **template** for a class of employee |
| `Valid to Log Off` | `Yes` prompts for the passnumber at application startup instead of at every module |
| `Signature` | Bitmap for certification signing (see VII.5) |
| `CAR User` | Places the operator in corrective-action assignment dropdowns |
| Note Groups | Internal-note routing groups |

The **Master Format** idea — role templates rather than per-person permission sets — is good practice and should be the primary model, not an option.

### XIV.2 Module map

Security is a two-level grid: adding a **module** grants the module (and for many modules that alone is sufficient — checkbox 1 need not be ticked), and **checkboxes** grant specific functions within it. Modules observed across the knowledge base:

| # | Module | Notable checkboxes documented |
|---:|---|---|
| **1** | Security Maintenance | 1 = access; **2 = OAuth Email Accounts** |
| **12** | Orders (Order Entry) | Enter and update orders |
| **112** | Orders continued | Extended order-entry privileges |
| **13** | Expediting / Order Management | module = search, send notes, add inventory, add/print attachments, delete, add rush; **2** = add/update pictures (with `picture_update`); **3** = shipping hold maintenance |
| **14** | Shipping | **3** = final-inspection override; **5** = over-credit-limit override; **6** = past-due override |
| **15** | Certifications | module = open/access/delete; **1** = print; **2** = modify/save |
| **17** | Reprint an Order | module grants reprint, Batch Print Orders, Batch Print Sale Orders |
| **18** | Delete an Order | module only |
| **19** | Change Order Status | module only — reopen a held order-load, or force an order closed |
| **20** | Invoicing / Billing reports | |
| **21** | Quotations / Pricing reports | **3** = close/re-open quotes from the dashboard |
| **22** | Pricing | **1** access, **2** view-only, **3** screw/washer, **4** price grid, **5** process inspection, **6** process grid, **7** process step, **8** customer process step, **9** part/process grid, **10** metal prices |
| **23** | A/R | **1** = access the module and its reports |
| **24** | Shipping reports | module sufficient |
| **25** | Operations reports | |
| **26** | Sales reports | |
| **29** | Dashboard | checkboxes = which navigator pages are accessible |
| **30** | Email and Popup | **7** = Email Order Notification |
| **31** | Customer Expediting | required to open the module |
| **35** | Corrective Action | **1** = order reworks / view in Expediting; **2** = part rework access |
| **36** | Receive Parts | required |
| **37** | Company Specific (Digital Order Approval) | **1** access; **2** DOA ok Quality; **3** DOA ok Sales; **4** DOA ok Production; **5** DOA ok Stamps |
| **53** | Fix Tracking | **7** = Access Quick Track (uncheck when using full tracking); also governs load splitting |
| **63** | Visual Net | **3** = access Quote Requests |
| — | Sales Order Entry | **4** = delete sales orders |

The one structural criticism: this is a flat module/checkbox matrix with no roles, no inheritance and no data-scoping (there is no notion of "this operator may only see these customers"). The Master Format template is a partial answer; `Class` (below) is another.

### XIV.3 Bulk administration and audit

- **Mass Update** — one window to change *Expires On*, *Warn On* and *Module Expire Dates* for many **active** operators at once, with Check All / Clear All, Save, *Save as* to a file, and Print.
- **Module Updates** — bulk-edit **one module at a time** across active operators, filtered by module and optionally by **Class** (a user-defined list maintained in Special Tables). Select module and/or class → Run → tick the boxes per operator → Save.
- **Security Report** (`Maintain > Security > Security Report`) — all / active / inactive operators; **Full Display** (with security header information) or **Basic**; sort by operator id or first name; select specific modules to retrieve only operators holding them; filter by Class.
- `[Security]` program defaults hold the password-policy settings (expiry intervals, warning windows and related rules — see Appendix A).

---

## Part XV — Email

### XV.1 The two generations

**Legacy SMTP.** Every workstation that emails needs three things installed: a **PDF printer**, an **email component** (Chilkat or EasyMail), and the program defaults. `VSExtras.exe` installs the Cornerstone PDF Printer, Chilkat and EasyMail together. The mechanism is: the form or report is **printed to PDF** first, then Visual Shop reads the `[email]` defaults and hands the message to Chilkat or EasyMail, which talks to the mail server.

The operational warning is important and correct: **once Send is pressed the email goes instantly — it cannot be aborted or recalled.** Verify content and recipient first.

PDF driver options: **Cornerstone PDF Printer** (`Cornerstone PDF Printer Installer.msi`, found in the `HTSW` folder on current builds; works **only** inside Visual Shop for email and is not a general Windows printer) or **Bullzip PDF Printer** (download and install, then open *Start > All Programs > Bullzip > Options* once **per Windows user login** and close it — the sole purpose being to create the user's `settings.ini`; no settings change). Bullzip's install pulls Ghostscript Lite.

Exchange note: for Exchange 2007/2010/2013, if external addresses fail, **a new send/receive connector with proper authentication is required** — a server-side change, not a Visual Shop one.

**Modern Authentication (OAuth).** Requires build **4327_1 or later**, a Google or Microsoft account, and a PDF printer (Cornerstone or Bullzip; VSExtras is downloadable from the vendor's customer extras path). Configuration is a single key: `[Email] Provider = M` (Microsoft) or `G` (Google). The **authenticated address is tied to the operator ID.** On first send the user is prompted to sign in and authorise; **the session then lasts up to 90 days** with no re-prompt, and the user can sign out deliberately at `Notes > Sign Out of Email`.

**Shared mailbox with OAuth** (one address, many users): set `[Email] Provider`; give the administrator security **Module 1 checkboxes 1 and 2** (*Access this Module* and *OAuth Email Accounts*); restart; go to `Maintain > Security > OAuth Email Accounts` → **Shared** tab → **Add row** → enter the shared address → *Continue* → sign in to the shared mailbox → **Access** → select which Visual Shop users are assigned to it (addable and removable at any time) → OK → Close.

### XV.2 Addressing and per-document customisation

Recipients resolve from three sources, in combination rather than in precedence: a plant-wide list in a program default (e.g. `[email] orders_always_sendto = <semicolon-separated addresses>`), the **contacts flagged for that document type** in `Maintain > Customer > Addr/Cont` (e.g. an *Order* checkbox on the contact), and per-form overrides. `[email] bcc_email_address` is applied to **every** email Visual Shop generates regardless of form-specific settings, while form-specific BCC keys such as `[orders] 6th_order_email_bcc` exist alongside it. `[email] orders_showall_contacts = Y` sends to all of the customer's contacts rather than only the flagged ones. `[email] orders_auto_manual = M` switches from automatic send to "show me the email first" — which should arguably be the default.

Per-document families of keys follow the pattern seen in VII.8: `<doc>_subject`, `<doc>_docname` (the attachment file name), `<doc>_text` and `<doc>_text_file`, each overridable per customer in Customer Control, and each supporting **`[field_name]` inserts taken from the form being sent** — which must match that form's field names exactly. `[defaults] terms_and_conditions_file = <full path>` attaches a terms document, switched on for order acknowledgements by `[Orders] email_tc_file`.

### XV.3 Order acknowledgements and notifications

Security **Module 30 (Email and Popup) checkbox 7** — Email Order Notification. Then `[Orders] email_notification = Y`.

Notification triggers documented:
- Order status transitions, per the `notification_status` table in III.1 — **fired only on save**.
- **First-time orders** — a notification when an order is saved for the first time.
- **New part notification** — when a memorized part is used on an order for the first time, an email goes to the **customer's salesperson**, keyed by `[Orders] first_order_email`. Its documented content shape: subject *"Subject Prefix New Part XXXX From Customer Name"*; body giving the part, customer, price, unit of measure, order number and order date.
- **Sixth-order notification** — `[orders] 6th_order_email_list` with `[orders] cb1_user_function = ELM`: when the part's `cb_user1` checkbox is ticked and the **sixth** order for that part arrives, the listed addresses are notified. (A good example of a customer-specific rule crystallised into a permanent key.)
- **Quantity change** — `[Orders] send_qty_change_email` emails `[Orders] qty_change_email_addr` when the order's total quantity has changed since the order was printed.

### XV.4 Mass email

`[menu] mass_email = Y` puts *Mass Email* on the menu; `[defaults] use_html` tells Visual Shop that the **HTML editor** has been installed. The editor is a separate COM component that must be **registered with Windows**, and the documentation is explicit that **the synchronizer will not register it** — a separate installer must be run on each workstation that sends mass email. The vendor's own recommendation is to set `use_html` **per Station ID** so one workstation sends mass email while the rest send single emails.

Usage: `Notes > Send Email > Mass Email` → double-click an existing list, or **Create New** to run a query wizard:

1. Choose the source: **Customer and Contacts** (queries `customer` and `address_contact`), **Customer Leads** (the customer lead table), or **Enter/Paste SQL** (write your own).
2. Select columns — used both for retrieval and as **insertable merge fields** in the body, with a live List Preview.
3. Add criteria (column, operator, value) much like report filtering. The `in` operator builds a value list, and **right-clicking the Value field shows the existing values in the database for that column** — a genuinely thoughtful affordance.
4. Review the generated SQL and the record count, name and describe the query, Finish.
5. Highlight the query, **Select**.
6. Enter a subject and compose the body — typed text, inserted columns, pictures and clipboard images.
7. On **Preview and Send**: send a test to your own address first, then **Send to Email List**, which sends **one email per person**, with any row deselectable.

Images are inserted by clicking the picture button, choosing the file, clicking where it should appear in the body, then **Clipboard Image**.

Failures surface in the same log as ordinary email.

### XV.5 Error handling

`[email] errorlogging = 1` writes a detailed text file to the default directory. The primary artefact is **`Emaillog.txt`** in the `HTSW` folder; the newest entries are at the **end** of the file, and if it has grown unwieldy it can simply be deleted to start a fresh log.

The documented error codes (originating in EasyMail's documentation and surfaced as message boxes):

| Value | Meaning |
|---:|---|
| 1 | An exception has occurred |
| 3 | The process has run out of memory |
| 4 | Problem with the message body or attachments |
| 7 | The From address was malformed or rejected by the SMTP server — some servers accept mail only from particular addresses or domains, and some reject a From address that fails a reverse lookup |
| 8 | The server reported an error on a recipient address (e.g. it refuses mail for unknown recipients) |
| 10 | Error opening a file — check that attachments exist and are accessible |
| 11 | Error reading a file — same checks |
| 16 | Connection problem; a socket error occurred |
| 19 | Could not create thread |
| 20 | Cancelled via the Cancel() method |
| 27 | Socket timeout |

---

## Part XVI — Infrastructure, deployment and operations

### XVI.1 Hardware specifications

The vendor's stated framing is worth keeping: the specifications target *higher performance*, not the minimum that will run, and faster clock speed helps Visual Shop more than core count (cores matter only when the machine runs many things at once).

**Visual Shop / Visual Archive workstation:** Windows 11 Professional preferred; 32- or 64-bit supported; Intel or AMD multi-core; **8 GB RAM**; SSD preferred; 100 Mbps NIC with gigabit preferred; monitor **1920×1080 or higher**; standard integrated or discrete video.

**Visual Track (shop-floor tracking):** a **Windows 11 tablet, PC or laptop — Android and iPads will not work**; 32/64-bit; multi-core; **4 GB RAM**; SSD preferred; screen **1280×800 or higher**.

**Visual Truck (delivery signature capture):** Windows 11 tablet (or PC/laptop); **4 GB RAM**; SSD preferred; Wi-Fi, with optional **4G/5G** so the device can reach the database without a hotspot; **1280×800 or higher**.

**Barcode scanners:** standard **1D USB** scanners suffice (available under $30); wireless versions cost slightly more; **2D imaging** scanners are needed for 2D barcodes or for scanning barcodes off a screen. Computerised/batch scanners are explicitly pointless because Cornerstone programs are not designed to run on them.

**Document scanners:** Canon **DR-M160II** (reported to work extremely well), Canon **DR-M260** (similar price, a step above); any TWAIN-compliant scanner should work.

**Servers:**

| Tier | Specification |
|---|---|
| **1–5 users, ≤100 orders/day** | Windows Professional or Server, 64-bit; **1–2 GB RAM per user**; Intel i-series / Xeon, AMD Ryzen / EPYC; RAID backup drives recommended; gigabit Ethernet; latest Microsoft SQL Server with collation **`SQL_Latin1_General_CP850_CI_AS`**. SQL Server **Express** is viable at startup and possibly beyond, with ≤5 users and <10 GB database |
| **5–20 users** | 64-bit Windows Server; **16+ GB RAM** minimum (1–2 GB per user); Xeon or EPYC; 1 TB drives, SSD preferred; **RAID 10**; gigabit NIC(s); same SQL Server and collation; VMware, Hyper-V or bare metal supported |
| **20+ users** | **32+ GB RAM** minimum (1–2 GB per user); same SQL Server and collation |

### XVI.2 SQL Server installation

The collation requirement — **`SQL_Latin1_General_CP850_CI_AS`** — is flagged as **EXTREMELY IMPORTANT** and must be set on the Collation tab during installation. It is the sort of prerequisite that is nearly impossible to change later and should be validated by the application at connect time.

**SQL Server Express limits** as documented (2019): **10 GB** maximum database, **2 GB** RAM usage, **1 core**, and **no SQL Server Agent** — therefore no maintenance plans, which is why the vendor offers SQLBackupAndFTP as the alternative.

Express install path: download the *Free Specialized Edition – Express*, choose **Custom**, then *New SQL Server Stand-Alone Installation*; accept terms; allow update checks; in **Feature Selection** choose Database Engine Services (plus the items shown in the vendor's screenshot); **Instance Configuration → Default Instance**; Server Configuration service accounts as shown; **Collation → `SQL_Latin1_General_CP850_CI_AS`**; **Database Engine Configuration → Mixed Mode** with a SQL password (the documentation prints a suggested password, which is a poor practice to copy — generate your own); **Data Directories** pointed at a dedicated data drive if one exists (e.g. `D:\Microsoft SQL Server\`). Then install **SQL Server Management Studio**, and in **SQL Server Configuration Manager** enable **Named Pipes** and **TCP/IP** and restart the `MSSQLSERVER` service.

**Port 1433** must be open inbound on the server or workstations cannot connect. Procedure: `wf.msc` → Inbound Rules → order by Local Port → if 1433 is absent, **New Rule** → Port → TCP, specific local port 1433 → Allow the connection → all profiles → name it (the vendor suggests *Microsoft SQL Server Port 1433*) → Finish.

### XVI.3 Backups

The disclaimer is explicit and worth repeating in any comparable product: CSI can assist, but **responsibility for setup, maintenance, validity and all backup tasks lies entirely with the customer or their IT provider.**

The recommended maintenance-plan design is three plans plus an integrity plan:

1. **SQL Server Agent** must be set to **Automatic** start mode and be **Running** (Configuration Manager).
2. **Backup devices** (`Server Objects > Backup Devices`): create **`VSBackupA`**, **`VSBackupB`**, **`VSBackupDiff`**.
3. **`IntegrityOptimization`** plan via the Maintenance Plan Wizard, scheduled; the wizard's first four tasks applied to the Visual Shop database and any others; **History Cleanup set to 2 weeks**. Enabling Agent XPs may be needed first (`sp_configure 'show advanced options', 1; RECONFIGURE; sp_configure 'Agent XPs', 1; RECONFIGURE`). Right-click and Execute to verify — it can take 5 to 30+ minutes.
4. **`VSDailyA`** — Back Up Database (Full) to `VSBackupA`, **Recurs every 2 days**, starting today, with **Overwrite** and **Verify backup integrity**.
5. **`VSDailyB`** — identical but writing to `VSBackupB` and **starting tomorrow**, so the two alternate and you always retain the previous day's full backup even if one is corrupt.
6. **`VSWeeklyDiff`** (optional, for hourly protection) — a weekly full backup to `VSBackupDiff`, Sunday 00:00, Overwrite, on top of which hourly differentials run.

Execute each plan manually after creation to confirm success.

**SQLBackupAndFTP** is the simpler alternative (and the only option under Express, since there is no Agent). It is explicitly **third-party and unsupported by CSI**. Setup: install; connect to *Microsoft SQL Server (local)*, pick the server, choose **SQL Server Authentication**, enter credentials, **Test Connection**, Save and Close; select the Visual Shop database; set the destination folder with the green **+** (the SQL Server `Backup` folder is suggested, e.g. `C:\Program Files\Microsoft SQL Server\MSSQL##.MSSQLSERVER\MSSQL\Backup`), **Test**, Save; schedule a full backup every 24 hours at 22:00 as a simple plan (differential and transaction-log backups may require the Pro edition); set an **On Failure Email To** address; **Run Now** and then physically verify the backup file exists.

### XVI.4 Test database

A well-designed practice worth adopting wholesale. Create a new database (e.g. `VSTest`) in Management Studio, restore the most recent production backup into it (From Device → Add → newest backup → Options tab → **Overwrite**).

Then **neutralise it**, so a test system cannot email real customers, with this scrubbing script (the vendor's own):

```sql
Update ADDRESS_CONTACT set email_address = 'testdb@testdb.testdb'
  where email_address is not null and rtrim(email_address) <> ''
Update PLANT set pl_name = 'TEST DATABASE - ' + pl_name
Update INIprofile set key_value = 'TEST DATABASE - ' + key_value,
       key_value_long = cast('TEST DATABASE - ' as varchar(max)) + cast(key_value_long as varchar(max))
  where section = 'license' and key_name = 'MainMenuName'
Update INIprofile set key_value = '', key_value_long = ''
  where section = 'email' and key_name = 'mail_server'
```

Three layers of protection there, all worth copying: every contact email is redirected, the plant name and the **main menu caption** are prefixed with "TEST DATABASE" so nobody can mistake which system they are in, and the mail server is blanked so sending cannot work at all.

Expose the database in the client by adding to `C:\htsw\ht.ini`: `menu=Y`, `databases=vsdatabase,VSTest`, `servers=VSSERVER` — which produces a database picker at login. Finally set the plant name (`Maintain > Plant Setup`) to something like *Visual Shop Test Database*. The recurring warning appears again: **make sure no `C:\Visual Shop.ini` is overriding `ht.ini`.**

### XVI.5 Workstation installation and the synchronizer

**New workstation:** confirm the build in use (`Help > About Visual Shop`) because **every computer must run the same build**; download the matching `VSBuild####.exe` from `visualshop.com/downloads`; run it (on the SmartScreen prompt choose *More Info → Run Anyway*; the installer is password-protected); then copy the entire `C:\htsw` folder from an existing workstation and paste it into `C:\` on the new machine, choosing **Yes to All** to overwrite. The documented trap: **paste to the root of `C:\`, not into `C:\htsw`, or you create `C:\htsw\htsw`.**

**Supporting software** — run `VSExtras.exe`, which installs Cornerstone PDF Printer, barcode fonts, PPGold, Register Pictures, the HTML editor and Chilkat.

**The synchronizer** replaces manual file copying. The master `htsw` folder lives on the server and is shared (note the *Network Path* shown in the folder's Sharing properties — that is the path to use). On each workstation:

1. Edit `C:\htsw\sync01.syn` in Notepad and set `Complete=Yes`, `DistributionDir=\\servername\htsw\`, `DestinationDir=C:\htsw\`. The full file structure documented is: `[setup] complete=Yes`; `[variables] DistributionDir=`, `DestinationDir=`; `[log] file=C:\htsw\synlog.txt`, `replace=1`, `verbose=2`; `[sync] syncop0=/src %DistributionDir%\*.* /dest %DestinationDir%\ /d`; `[start] show=1`, `cancel=0`.
2. Right-click `C:\htsw\syncrt.exe` → *Send To > Desktop (create shortcut)*, then edit the shortcut's **Target** to `C:\htsw\syncrt.exe "C:\htsw\sync01.syn"` and rename it (e.g. *VS Sync*).
3. To use: **exit Visual Shop**, run the shortcut, then restart Visual Shop. Repeat on every workstation, **including tracking stations**.

Troubleshooting: confirm the workstation can reach the share by typing the address in Explorer, and **save the credentials** if Windows prompts, otherwise they must be re-entered after every restart. For the error *"Synchronizer Process Not Run: C:\htsw:sync01.syn - Not Found"* the vendor admits the root cause was never determined; the remedy is to delete `sync01.syn`, `syncrt.exe`, `synlog.txt` and any shortcuts, reinstall the correct build, and set the synchronizer up from scratch — or copy a working set from another machine.

### XVI.6 Upgrade procedure

The documented order matters, and each step has a stated reason:

1. **Back up the database** and keep a copy of the current `HTSW` folder (typically `C:\htsw` — confirmable from the shortcut properties). This is done only on the workstation performing the download, and preserves the ability to roll back the program files.
2. Close **all** instances of Visual Shop.
3. Run `VSBuildXXXX.EXE`, enter the supplied password, accept the EULA, choose the installation folder, and select optional features — noting that **not all features are available on all Visual Shop plans**.
4. With **all users off the database**, run `Maintain > Upgrade Database` to apply the SQL scripts. The warning is explicit: **running it with active users could impact the SQL updates.**
5. **Immediately synchronize every workstation**, including tracking stations. The stated consequence of not doing so: **mismatched builds can crash Visual Shop or leave records incompletely updated.**

That is a fat-client upgrade with a schema migration and no version negotiation between client and database — the strongest architectural argument in the whole product for a service-based or browser-based client.

### XVI.7 Server migration

The disclaimer is unusually direct: many opportunities for disaster, do not treat the instructions as a complete guide, and do not attempt a migration without CSI assistance. CSI is a software provider and does not handle hardware or networks.

**Preparation, while still live:** size and provision the new server; install everything except SQL Server and connect it to the network; install SQL Server to CSI's guidelines (collation!); install Visual Shop and its supporting software on the new server; back up the production database and restore it into a new database on the new server (usually `vsdatabase`); run Visual Shop on the new server and confirm you can connect to **both** old and new databases; set up and **verify** the maintenance plans on the new server; and test connecting to the new server from the old server and one workstation by repointing their `C:\htsw\ht.ini`.

**Cutover, with Visual Shop down:** confirm a workstation really can connect to the new server; log everything out of Visual Shop, Visual Track, Visual Truck, Visual UPS, Visual Archive and anything else touching the database; run a fresh backup of the old database; while it runs, begin repointing the `ht.ini` files — and if connections fail, check for a `C:\Visual Shop.ini` overriding it. A further documented Windows quirk: **Windows has been seen reading a cached copy of `ht.ini` and ignoring the edits**; the workaround is to copy the whole `htsw` folder, paste it in place, rename the original to `htsw-old` and rename the copy to `htsw`. Update `sync01.syn` to the new server as you go (and if the synchronizer is not in use, set it up now). After the backup completes, **stop the SQL Server services on the old server or take the database offline** so nobody can reconnect, then restore onto the new server, overwriting.

### XVI.8 Known workstation defect: DEP and OLE photo controls

Symptoms: *"Error accessing external object property autosize at line 2 in constructor event of object uo_ole_photo"* and *"Error accessing external object property filename at line 82 in function wf_dw_photo_load of object uo_dw_pictures_2"*.

Cause: Windows **Data Execution Prevention** blocking the OLE picture control — and the documentation correctly notes DEP is a good thing that should not simply be disabled.

Fix: This PC → Properties → Advanced → Performance **Settings** → **Data Execution Prevention** tab → select *Turn on DEP for all programs and services except those I select* → **Add** → browse to the `HTSW` folder (on Terminal Services usually the `E:\` drive) → select **HTSHOPPBD.EXE** → Apply/OK out. Then run **Register Pictures** and/or **PPGold** (both included in `VSExtras.exe`), and verify with `Help > Photo Test → Test`.

### XVI.9 Implementation sequence

The vendor's own go-live plan, which is a sound template:

1. **Initial setup** — purchase SQL Server licensing (unless Express suffices); install SQL Server following the guide closely; install the Visual Shop startup database; install Visual Shop on the workstation(s) doing configuration.
2. **Company information** — `Maintain > Plant Setup` for company details, and `Maintain > Program Defaults > Change Defaults > License` for the company name.
3. **Base tables** — `Maintain > Plant Support`: Process Codes, Groups and **Table Keys** first, because everything depends on them.
4. **Import what you can** — Visual Shop can map columns from a `.csv` to database columns, or data can be loaded directly with SQL Server. Commonly imported: customers, customer contacts, customer addresses, parts, materials, process codes, groups, **table keys**, and general ledger numbers.
5. **Process Masters manually** — the documentation is candid that processes and steps are usually too structured to import and are built by hand.
6. **Forms** — **the order form is the most critical and usually needs to be custom**; then shipping, certification, invoice, quotation and labels.
7. **Accounting setup** — GL numbers, and point Table Keys at them.
8. **Run test orders in parallel with the existing system** using real parts and processes, to validate the process flow, make adjustments, and **double as operator training**.
9. **Pick a go-live date**, from which all new orders are entered in Visual Shop; existing **A/R can be imported** at that point to create a clean cutoff for financial reporting.

### XVI.10 Keyboard shortcuts

| Key | Action |
|---|---|
| **F1** | Expediting |
| **F2** | Order Entry |
| **F3** | Certifications |
| **F4** | Shipping |
| **F9** | Part Maintenance |
| **Ctrl+L** | Plant Support tables |
| **Ctrl+S** | Printer Setup |
| **Ctrl+N** | Contact Maintenance |
| **Ctrl+M** | Process Master |
| **Ctrl+A** | Customer Addresses |
| **Ctrl+R** | Read Notes |
| **Ctrl+I** | Picture Maintenance |
| **Ctrl+P** | Plant Setup |
| **Spacebar** | Acts as a mouse click (e.g. *New Order*) |

Also: **Tab** advances field-to-field *and* screen-to-screen through Order Entry, which is the intended high-speed entry path.

---

## Part XVII — Design conclusions for a new ERP

### XVII.1 What Visual Shop gets right and is worth adopting

**The service-shop data model.** Order → Load → Part → Step, with quantity *and* weight as first-class co-equal measures, containers with gross/tare/net, and serial numbers with their own descriptions. Any system serving a process shop needs this shape; retrofitting weight into a piece-count model does not work.

**Process Master instead of BOM.** A reusable, named routing that can be generic, part-assembled or order-assembled, built from a library of **Standard Steps** keyed by *what you do* × *where you do it*. Combined with **Step Overlays** — part-specific replacement or extension of individual steps and comments without cloning the master — this solves the "500 nearly identical routings" problem elegantly.

**Table Keys as a single dimensional join.** One table binding process code, equipment, group and cost center, and simultaneously carrying GL account, pricing eligibility, minimum charge, cert-printing flags and tracking template. This gives one place to answer "what does this operation mean" for costing, pricing, posting and tracking.

**Configuration as scoped data.** `(station_id, section, key_name) → value` with station-level override of a plant-level default, editable at runtime. The staged-rollout pattern that falls out of it — turn a feature on for one desk, watch it, then promote it — is genuinely valuable.

**The certificate as a document with a lifecycle.** Its own record, format, scope (order / load / shipper), inspection results, insert-driven text, signature, charge and print/email history — with a *Print/Change* mode whose edits deliberately cannot be saved.

**Soft gates with supervisor override, and hard gates where they belong.** Past-due and credit-limit stops can be overridden at the screen by an operator holding the right checkbox; shipping holds and credit holds cannot be overridden at all. That distinction is a real business requirement and is modelled correctly.

**Small, high-value affordances** worth stealing outright: the `{001-025}` serial range expansion; the *Do Not Dupe* / *Required* pair on part fields; MicroHelp text stored per field in a drag-and-drop screen designer; right-click-to-see-existing-values when building a query filter; the sort/filter-before-you-mass-update workflow that cuts 6,790 records to 18; the promise date that is bound to a quantity and disappears when satisfied; the notification indicator that resets from *Notified* to *Send* when new quantity becomes available; and the test-database scrubbing script that renames the main menu so nobody can mistake which system they are in.

### XVII.2 What to do differently

**Do not let capability live in form variants.** The single largest structural defect. Order-level pricing, the Rework button, an Order Type column, contract review, an editable shipping-hold checkbox — each is available only on particular `dw_*` objects. The result is ~1,100 compiled form artefacts, a combinatorial support matrix, and customers who cannot adopt a feature without also adopting someone else's layout. **Separate document layout from behaviour absolutely: a data-driven template engine, a declared and versioned data contract per document type, and features gated by permission and configuration only.**

**Type and constrain the configuration registry.** 2,527 free-text keys is 2,527 untested paths. Give every setting a declared type, an allowed-value domain, a default, a description, a required-dependency list (dozens of keys silently need another key set) and a mutually-exclusive list. Make change history mandatory, not a `keep_defaults_history` option. Validate on save rather than failing silently at runtime. Retire the comma-positional tuple (`process,equip,group,cc`) in favour of structured fields.

**Version anything a document or an order depends on.** Standard steps change in place and rewrite the instructions of in-flight orders. Process Master IDs can be renamed in place. Contract-review answers are destroyed with no history when a process master is reattached. Cert formats are edited live. In a regulated supply chain, released work must be bound to the revision that was in force when it was released.

**Never let a report mutate data, and never let a report have side effects.** The A/R summary reports **re-open closed invoices**, requiring a follow-up *Close Invoices* run; the Customer Listing report writes a salesperson change back to the database. Reads should be reads.

**Never mutate en masse as a side effect of opening a screen.** Parts silently flipping to inactive when Part Maintenance opens is the clearest example. Bulk changes should be explicit, previewed, logged and reversible.

**Make destructive operations recoverable, or make them impossible.** *Monthly Purge/Archive*, *AR Utilities* and *Fix Invoices* all write directly with "no undo" and an instruction to phone support. Soft-delete, an audit trail and a restore path should be the default; Visual Shop already does this well for orders (status `D`) and argues for it for customers and parts, so the principle is understood — it is just not applied consistently.

**Fix the reporting-artefact gaps.** Batch-close reports that cannot be reprinted after closing; *Create Finance Charges* that gives no feedback and silently duplicates on a second click; unsaved Hot List edits destroyed by Refresh. Idempotent commands, explicit confirmation, and persisted, reprintable audit documents.

**Add the missing domains.** There is **no cost model** anywhere — no labour, machine, energy, consumable or scrap cost, and therefore no margin, no yield and no cost-of-quality KPI (which is why the Dashboard is entirely delivery, backlog, sales and receivables). There is **no capacity or finite scheduling** — Areas, Schedules and Priority give sequencing but no load calculation, and `Max Load` on a group is advisory. **Outside processing is a printed instruction, not a subcontract** — no expected return, no cost, no receipt, no vendor liability. Corrective actions have no workflow state machine, due dates or effectiveness verification. Security has no roles, no inheritance and no data scoping (an operator cannot be restricted to a set of customers).

**Modernise the deployment and integration boundary.** A fat client requiring identical builds everywhere, a file-copy synchronizer, a schema migration run manually with all users out, ini files whose precedence is undocumented and which Windows sometimes caches — every one of these is an avoidable operational cost. Likewise, integration is CSV/FTP/EDI structure files plus summary GL journals that deliberately exclude invoice, customer and order detail; a modern equivalent should expose an authenticated API and event stream, with the accounting interface as one consumer among several.

**Two smaller things.** Do not gate features behind an edition (Flex Scheduling requiring "Visual Shop HD") if the reason is commercial rather than architectural. And do not protect administrative bulk operations with a shared hard-coded password (`Flex!mp0rt`) or publish default SQL passwords in documentation — use the permission system that already exists.

### XVII.3 The one-paragraph verdict

Visual Shop is a mature, deeply pragmatic answer to a specific and awkward problem: run a shop that processes other people's metal, prove what you did to it, ship it back in pieces, and bill for it. Its domain model — order/load, process master, standard steps with overlays, and the Table Keys lattice — is genuinely good and should be the starting point for anything in this space. Its failure mode is equally instructive: two decades of saying yes to every customer-specific request, expressed as ~1,100 compiled form objects and 2,527 untyped configuration keys, with behaviour welded to layout. **Take the domain model and the scoped configuration idea; reject the coupling of capability to form, the absence of versioning, and the untyped settings sprawl; and add the cost, capacity and subcontract models that were never built.**

---

## Appendix A — Complete Program Defaults registry

Every documented configuration key, grouped by section, exactly as published in the vendor's 93 Program Defaults articles. **2,527 keys.**

Reading notes: the *Section* value is the literal `section` column in `INIprofile` (case as documented — Visual Shop is inconsistent about capitalisation and it does not matter). *Default / documented value* is the value the vendor publishes; a blank means the article documents no value (typically because the value is free text: a path, a form name, an address list or a numeric threshold). Values shown as `Y or N` are booleans; anything else is either an enumeration, a `dw_*` form name, or free text. Keys in the `Menu` section require restarting Visual Shop.



### A.1 `[A/R (New)]` — 53 keys

| Key name | Default / documented value |
|---|---|
| `ach_batch_paytype` | — |
| `active_customers_only` | N |
| `adjustment_gl_number` | — |
| `allow_delete_closed_fc` | N |
| `ar_by_plant` | N |
| `AR_default_gl_number` | — |
| `AR_GL_NO` | — |
| `ar_gl_number` | — |
| `ar_invoice_info_bycust` | platerp |
| `auto_apply_discount_percent` | 0 |
| `auto_apply_discount_type` | — |
| `autopay` | Y |
| `autopay_batch` | N |
| `batch_entry_custid_search` | Y |
| `bypass_batch_close_reports` | N |
| `cc_batch_paytype` | — |
| `check_closing_dates` | — |
| `check_gl_number` | — |
| `create_statement_file` | N |
| `days_for_discount` | — |
| `discount_%` | — |
| `discount_customer_tax` | Y |
| `discount_gl_number` | — |
| `do_not_incl_credits_fc` | N |
| `email_liability_file` | N |
| `email_tc_file` | N |
| `exclude_payment_types` | — |
| `export_file_check` | — |
| `export_file_location` | — |
| `export_file_name` | — |
| `export_file_name_check` | Y |
| `export_file_type` | — |
| `export_reports_by_cc` | — |
| `fax_statements` | — |
| `import_batch_type` | Ionic |
| `import_default_custid` | — |
| `import_file_location` | — |
| `import_file_name` | — |
| `import_file_type` | — |
| `import_payment_batches` | — |
| `no_discount_process_codes` | — |
| `no_print_after_email` | Y |
| `nsf_gl_number` | — |
| `oac_form` | dw_inv_form_oac |
| `print_liability_file` | N |
| `sales_gl_number` | — |
| `sort_inv_by_date` | N |
| `statement_form` | — |
| `statement_form_multi` | — |
| `use_customer_terms` | — |
| `use_parent_id` | N |
| `warn_import_duplicates` | N |
| `writeoff_gl_number` | — |


### A.2 `[A/R (Old)]` — 50 keys

| Key name | Default / documented value |
|---|---|
| `ach_batch_paytype` | — |
| `active_customers_only` | N |
| `adjustment_gl_number` | — |
| `allow_delete_closed_fc` | — |
| `ar_by_plant` | N |
| `AR_default_gl_number` | — |
| `AR_GL_NO` | — |
| `ar_gl_number` | — |
| `auto_apply_discount_percent` | 0 |
| `auto_apply_discount_type` | — |
| `autopay` | Y |
| `autopay_batch` | N |
| `batch_entry_custid_search` | — |
| `bypass_batch_close_reports` | N |
| `cc_batch_paytype` | — |
| `check_closing_dates` | — |
| `check_gl_number` | — |
| `create_statement_file` | N |
| `credit_gl_number` | — |
| `days_for_discount` | — |
| `discount_%` | — |
| `discount_customer_tax` | Y |
| `discount_gl_number` | — |
| `do_not_incl_credits_fc` | N |
| `email_liability_file` | N |
| `email_tc_file` | N |
| `exclude_payment_types` | — |
| `export_file_check` | — |
| `export_file_location` | — |
| `export_file_name` | — |
| `export_file_type` | — |
| `export_reports_by_cc` | — |
| `fax_statements` | — |
| `import_batch_type` | 29 |
| `import_default_custid` | — |
| `import_file_location` | — |
| `import_file_name` | — |
| `import_file_type` | — |
| `import_payment_batches` | — |
| `no_discount_process_codes` | — |
| `nsf_gl_number` | — |
| `oac_form` | dw_inv_form_oac |
| `print_liability_file` | N |
| `sales_gl_number` | — |
| `sort_inv_by_date` | N |
| `statement_form` | — |
| `statement_form_multi` | — |
| `use_customer_terms` | — |
| `use_parent_id` | N |
| `warn_import_duplicates` | N |


### A.3 `[Airportscreens]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `show_full_list_dw` | Y |


### A.4 `[Batch_shipping]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `Select_CostCenter` | YN |


### A.5 `[Bill_of_lading]` — 12 keys

| Key name | Default / documented value |
|---|---|
| `auto_show_cust_notes` | YN |
| `bol_form` | — |
| `bol_header_dw` | — |
| `carrier_edit` | YN |
| `copies` | 1 |
| `default_cod` | — |
| `iso_doc_number` | — |
| `payment_type` | Y |
| `ref_select_days_back` | — |
| `reference_verification` | N |
| `ship_at` | — |
| `ship_from` | — |


### A.6 `[CanEng]` — 6 keys

| Key name | Default / documented value |
|---|---|
| `caneng_dsn` | — |
| `database` | — |
| `DBMS` | — |
| `LogID` | — |
| `LogPass` | — |
| `ServerName` | — |


### A.7 `[CAR]` — 9 keys

| Key name | Default / documented value |
|---|---|
| `car_list_dw` | americanht |
| `car_No_Increment` | Y |
| `menu_item_text` | "Case" |
| `MRB` | — |
| `orderCar_detail_dw` | dw_car_detail_plateco |
| `print_dw` | dw_car_detail_print_elmira |
| `RMA_equals_orderid` | Y |
| `send_emails` | Y |
| `single_rework_on_part` | Y |


### A.8 `[ccm]` — 3 keys

| Key name | Default / documented value |
|---|---|
| `ccm_communications_dw` | default |
| `form_name` | — |
| `generate_order_notes` | N |


### A.9 `[Certifications]` — 103 keys

| Key name | Default / documented value |
|---|---|
| `acceptreject_by_loadandpart` | YN |
| `auto_display_steps` | YN |
| `auto_pop_code_scale` | YN |
| `blank_step_text` | YN |
| `cert_header_dw` | dw_cert_record_astroN |
| `cert_pic_form` | dw_cert_form_accurate_pics |
| `cert_prompt` | N |
| `cert_step_dw` | dw_cert_steps_cert_result_entries_mil |
| `certform` | dw_cert_form_generic |
| `certpartform` | dw_cert_form_candrdw_cert_form_bap_cert_part |
| `check_reject_serialno` | YN |
| `coating_weight` | YN |
| `coeff_friction` | YN |
| `copy_req_long_text` | YN |
| `create_pdf_copy` | YN |
| `cust_mode` | elmira |
| `custom_insp_entry_type` | FPMN |
| `custom_manual_result_dw` | dw_insp_tracking_entryN |
| `custom_tracking_result_dw` | dw_insp_tracking_entryN |
| `Default_format` | ` |
| `Default_shipper_format` | — |
| `dont_log_cert_save` | YN |
| `email_certform` | — |
| `email_first` | YNS |
| `email_liability_file` | YN |
| `email_tc_file` | YN |
| `form_number` | — |
| `fpm_generic_inspections` | YN |
| `ftp_cert_file` | YN |
| `hide_print_window` | YN |
| `hide_search_button` | YN |
| `ht_worksheet` | YN |
| `ini_copy_req_long_text` | Y |
| `ini_show_only_load_parts` | N |
| `ini_tech_signature_images` | N |
| `inspections_use_average` | YN |
| `ire_passfail_no_required` | YN |
| `keep_history` | YN |
| `keep_results` | N |
| `load1_format` | — |
| `manual_results_window` | — |
| `mre_inspection` | N |
| `mre_range_message` | YN |
| `multi_load_certform` | — |
| `not_printed_print_now_default` | N |
| `notary_opid` | 0 |
| `nvlap_esp_date` | 12-31-08 |
| `nvlap_expire_date` | — |
| `pdf_by_customer` | YN |
| `Print_Fax` | PFBE |
| `print_liability_file` | N |
| `print_preview` | YN |
| `print_quoted_strings` | YN |
| `print_seperate_jobs` | N |
| `print_tray` | — |
| `printer_name_on_form` | N |
| `PrintForm1_collate` | — |
| `PrintForm1_copies` | — |
| `PrintForm1_duplex` | — |
| `PrintForm1_dw` | — |
| `PrintForm1_orientation` | — |
| `PrintForm1_pagerangeinclude` | — |
| `PrintForm1_papersource` | — |
| `PrintForm1_printer` | — |
| `PrintForm1_quality` | — |
| `PrintForm1_scale` | — |
| `PrintForm2_collate` | — |
| `PrintForm2_copies` | — |
| `PrintForm2_duplex` | — |
| `PrintForm2_dw` | — |
| `PrintForm2_orientation` | — |
| `PrintForm2_pagerangeinclude` | — |
| `PrintForm2_papersource` | — |
| `PrintForm2_printer` | — |
| `PrintForm2_quality` | — |
| `PrintForm2_scale` | — |
| `qc_cert` | N |
| `qick_add_dw` | dw_cert_quick_manual_result_entry_midstate |
| `result_signatures` | N |
| `serial_heading` | — |
| `serial_numbers` | YN |
| `shipper_load_results` | YN |
| `shipper_results_from_load1` | YN |
| `show_list` | Y |
| `show_only_load_parts` | YN |
| `signature_from_cert_control` | N |
| `signature_from_final_inspect` | YN |
| `signature_from_last_opid` | YN |
| `signature_from_results` | Y |
| `skip_load1` | Y |
| `sort_serial_by_entry` | YN |
| `steptext_print_default` | YN |
| `subtract_nocharge_qty` | YN |
| `tech_signature_images` | N |
| `tech_signatures` | N |
| `technicians` | YN |
| `track_results_pass_only` | YN |
| `tracking_results_use_loadid` | NULL |
| `use_all_tracking_load_results` | YN |
| `use_first_print_date` | YN |
| `use_multi_shipper_nums` | YN |
| `use_revisions` | YN |
| `valmont_readings` | YN |


### A.10 `[Corporate]` — 7 keys

| Key name | Default / documented value |
|---|---|
| `DataBase` | — |
| `DBMS` | — |
| `Dbparm` | — |
| `Lock` | — |
| `LogID` | — |
| `LogPass` | — |
| `ServerName` | — |


### A.11 `[Costing]` — 3 keys

| Key name | Default / documented value |
|---|---|
| `Cost Analysis Report` | — |
| `rpt_dw` | dw_job_costing_report |
| `show_overhead` | 0 |


### A.12 `[Customer]` — 26 keys

| Key name | Default / documented value |
|---|---|
| `addr_cnt_all_ccs` | YN |
| `allow_delete_with_orders` | YN |
| `allow_delete_with_parts` | YN |
| `allow_delete_with_quotes` | YN |
| `cod_matches_terms` | YN |
| `default_inactive_days` | 365 |
| `email_notification_address` | — |
| `hide_addr_cnt_print` | YN |
| `history_date` | mm/dd/yyyy ddd |
| `keep_history` | YN |
| `log_order_term_cod_changes` | YN |
| `main_screen` | — |
| `market_sector_suser_field` | — |
| `new_cust_email_notification` | MPL |
| `req_cust_referrals` | YN |
| `require_market_sectors` | N |
| `reset_start_date` | N |
| `search_active_only` | N |
| `target_days_title` | — |
| `update_coordinates` | Y |
| `use_auto_search` | NULL |
| `use_cust_referrals` | YN |
| `user_checkbox_title` | — |
| `user_fields` | YN |
| `USPS_title` | — |
| `warn_inactive_updates` | YN |


### A.13 `[Customer_Expediting]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `auto_display_notes` | YN |


### A.14 `[dashboard]` — 22 keys

| Key name | Default / documented value |
|---|---|
| `age_receivables` | "30 |
| `ar_navpage_visible` | YN |
| `color1` | 255 |
| `color2` | 65280 |
| `color3` | 16711680 |
| `color4` | 65535 |
| `color5` | 16776960 |
| `color6` | 16711935 |
| `first_page` | — |
| `invoicing_navpage_visible` | YN |
| `logo_file` | — |
| `logo_link` | — |
| `logo_text` | — |
| `number_top_customers` | 10 |
| `open_with_vs` | Y |
| `openorders_age_periods` | "2 |
| `openorders_work_days` | Y |
| `operations_navpage_visible` | Y |
| `schedule_window` | NULL |
| `top_custs_days_back` | 94000 |
| `top_open_orders_groups` | NULL |
| `top_values` | "10 |


### A.15 `[defaults]` — 55 keys

| Key name | Default / documented value |
|---|---|
| `auto_program_start` | — |
| `bingo_board_timer` | 20 |
| `check_AR_close` | YN |
| `check_fiscal_calendar` | YN |
| `check_system_purge` | YN |
| `color_flatbutton` | Y |
| `color_theme` | — |
| `corp_database` | — |
| `Customer_ID_Required` | — |
| `dongletrace` | N |
| `email_via_security` | — |
| `email_via_security_exit` | — |
| `fix_util_add_sign` | N |
| `form_iso_text` | — |
| `greater_than_days` | 0 |
| `ini_greater_than_days` | 0 |
| `keep_defaults_history` | Y |
| `Language` | — |
| `liability_statement_file` | — |
| `long_addresses` | N |
| `new_addr_table` | YN |
| `new_default_maint` | YN |
| `no_po_dupication` | YN |
| `old_version_ok_required` | YN |
| `oledb_trim_skip_custid` | YN |
| `original_language` | ENGLISH |
| `parent_plant_id` | — |
| `plant` | — |
| `plant_report_name` | — |
| `run_scheduled_jobs` | NULL |
| `shipping_trace` | YN |
| `show_dw_name` | — |
| `show_sql_preview` | N |
| `SIC` | YN |
| `single_copy_only` | YN |
| `skip_regionalformatting` | N |
| `SQL_update_warning_mesasge` | Y |
| `state` | — |
| `systemdefault_key4096` | Y |
| `terminalserver` | N |
| `terms` | — |
| `terms_and_conditions_file` | — |
| `test` | N |
| `test_address_book` | N |
| `text_long_correction` | 0 |
| `trace` | N |
| `trans_save_procid` | — |
| `translate_language` | SPANISH |
| `use_country_table` | YN |
| `use_html` | N |
| `VisualShop_Update_Reminder` | YN |
| `vs_user_timer` | 5 |
| `vs_user_timer2` | 0:05:00 |
| `weight_name` | Pounds |
| `wt_name` | Lbs |


### A.16 `[Email]` — 97 keys

| Key name | Default / documented value |
|---|---|
| `AccountName` | — |
| `bAuthentication` | 01 |
| `bcc_car` | — |
| `bcc_certification` | — |
| `bcc_email_address` | — |
| `bcc_general` | — |
| `bcc_invoice` | — |
| `bcc_mrb` | — |
| `bcc_order_notification` | — |
| `bcc_quote` | — |
| `bcc_quote_notification` | — |
| `bcc_quote_salesforce` | NULL |
| `bcc_reports` | — |
| `bcc_shipper` | — |
| `bcc_statement` | — |
| `bcc_step_notification` | — |
| `bRememberPassword` | 01 |
| `bUseSecurePassword` | 01 |
| `car_docname` | — |
| `car_subject` | — |
| `car_text` | — |
| `car_text_file` | — |
| `cert_from_address` | — |
| `cert_reply_address` | — |
| `certification_docname` | — |
| `certification_subject` | — |
| `certification_text` | — |
| `certification_text_file` | — |
| `certs_auto_manual` | AM |
| `certs_showall_contacts` | N |
| `default_text` | — |
| `EasyMail` | YN |
| `Eventlogging` | 01 |
| `from_email_address` | — |
| `ini_zeon_version` | 5 |
| `invoice_docname` | — |
| `invoice_from_address` | — |
| `invoice_reply_address` | — |
| `invoice_subject` | — |
| `invoice_text` | — |
| `invoice_text_file` | — |
| `invoices_auto_manual` | AMN |
| `invoices_showall_contacts` | N |
| `mail_profile` | — |
| `mail_profile_password` | — |
| `mail_server` | — |
| `MailPort` | — |
| `MailProfile` | — |
| `max_addresses` | 20 |
| `modify_subject_line` | N |
| `order_from_address` | — |
| `order_reply_address` | — |
| `orders_always_sendto` | — |
| `orders_auto_manual` | N |
| `orders_showall_contacts` | YN |
| `Password` | — |
| `quote_docname` | — |
| `quote_from_address` | — |
| `quote_notifications_sendto` | — |
| `quote_reply_address` | — |
| `quote_subject` | — |
| `quote_text` | — |
| `quote_text_file` | — |
| `quotes_auto_manual` | AMN |
| `quotes_showall_contacts` | N |
| `reply_email_address` | — |
| `send_bcc_by_default` | YN |
| `ship_notify_docname` | NULL |
| `ship_notify_subject` | NULL |
| `ship_notify_text` | NULL |
| `shipper_docname` | — |
| `shipper_from_address` | — |
| `shipper_reply_address` | — |
| `shipper_subject` | — |
| `shipper_text` | — |
| `shipper_text_file` | — |
| `shippers_auto_manual` | AMN |
| `shippers_showall_contacts` | N |
| `show_seq#` | YN |
| `signature_first` | Y |
| `ssl_connection` | YN |
| `statement_docname` | — |
| `statement_from_address` | — |
| `statement_reply_address` | — |
| `statement_subject` | — |
| `statement_text` | — |
| `statement_text_file` | — |
| `statements_auto_manual` | AMN |
| `statements_showall_contacts` | N |
| `steps_auto_manual` | AMN |
| `subject_prefix` | — |
| `timeout` | 30 |
| `tls_connection` | YN |
| `use_html` | N |
| `warn_charts` | YN |
| `zeon_email` | YN |
| `zeon_version` | 5 |


### A.17 `[Expediting]` — 68 keys

| Key name | Default / documented value |
|---|---|
| `allow_customeronly_search` | Y |
| `approval id flag` | N |
| `auto_display_notes` | N |
| `auto_display_part_notes` | N |
| `Auto_log_order` | N |
| `bit_settings` | 0 |
| `bolt_on_rush_types` | — |
| `bothsearchptypesvisible` | N |
| `Calculate_lbs_from_qty` | N |
| `Chart_Used_For_Rush` | N |
| `custlookup_return_id_only` | N |
| `daysback` | — |
| `default_search` | — |
| `display_ccm` | — |
| `display_chart` | N |
| `display_move_rec` | N |
| `display_sched_dw` | — |
| `due_date_type` | — |
| `dw_insp` | — |
| `dw_load` | — |
| `dw_order_top` | — |
| `dw_parts` | — |
| `dw_tracking` | — |
| `exact_tracking_number_match` | Y |
| `force_find_visible` | N |
| `gototrack` | N |
| `hide_pinv_create_msg` | N |
| `inspection_rows` | NULL |
| `inspfailflag_bystep` | N |
| `inv_list_display_multishipper#` | — |
| `invoice_form` | — |
| `load_dw_no_zero_parts` | N |
| `may_miss_days` | NULL |
| `next_type` | — |
| `norush_if_invoiced_shipped` | N |
| `open_orders_only` | — |
| `order_search_bal_wt_format` | — |
| `order_search_window` | — |
| `ordersearch_sortorder` | A |
| `other_settings` | — |
| `picture_update` | N |
| `prev_next_orders` | — |
| `printbutton_orderform` | — |
| `rushtab_custom_dw` | — |
| `rushtab_plantdd` | — |
| `search_container` | N |
| `search_serial` | N |
| `ShippedOrders_by_date` | N |
| `shipperlookupbutton` | N |
| `shipping_datawindow` | — |
| `shipping_hold` | N |
| `show_inspection_tab` | Y |
| `show_reversed_shippers` | Y |
| `show_time_temp` | — |
| `show_tracking_report` | N |
| `surface_connstring` | — |
| `SWD_log` | N |
| `title_Aircraft` | — |
| `title_Job#` | — |
| `title_Other_cust_1` | — |
| `title_Other_cust_2` | — |
| `title_packing_slip` | — |
| `title_Tracking#` | — |
| `tracking_report` | — |
| `trackingtab_custom_dw` | — |
| `tracktab_hide_notrack` | N |
| `use_new_search_list` | NULL |
| `will_miss_days` | NULL |


### A.18 `[Fix System]` — 7 keys

| Key name | Default / documented value |
|---|---|
| `pm_requirement_comments` | see description |
| `pm_requirement_inspect_code` | see description |
| `pm_requirement_inspect_scale` | see description |
| `pm_requirement_max_value` | see description |
| `pm_requirement_min_value` | see description |
| `pm_requirement_process_codes` | see description |
| `pm_requirement_text_value` | see description |


### A.19 `[flag_shippers]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `beep` | YN |


### A.20 `[Forms]` — 6 keys

| Key name | Default / documented value |
|---|---|
| `tag_line1` | — |
| `tag_line2` | — |
| `tag_line3` | — |
| `tag_line4` | — |
| `tag_line_footer` | — |
| `tag_line_header` | — |


### A.21 `[FTP]` — 8 keys

| Key name | Default / documented value |
|---|---|
| `delete_remote_file` | N |
| `local_path` | — |
| `password` | — |
| `port` | 21 |
| `protocol` | 0 |
| `remote_path` | — |
| `server` | — |
| `username` | — |


### A.22 `[gm_corp]` — 5 keys

| Key name | Default / documented value |
|---|---|
| `database` | — |
| `DBMS` | — |
| `LogID` | — |
| `LogPass` | — |
| `ServerName` | — |


### A.23 `[help]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `browser` | — |
| `help_file` | — |


### A.24 `[Holidays]` — 5 keys

| Key name | Default / documented value |
|---|---|
| `Saturday` | — |
| `show_workday_count` | — |
| `Sunday` | — |
| `use_calendar_table` | N |
| `weekend` | 17 |


### A.25 `[InspCode_Maint]` — 3 keys

| Key name | Default / documented value |
|---|---|
| `additional_cols_visible` | YN |
| `dw_name` | dw_inspect_premier |
| `show_minmax_required` | YN |


### A.26 `[Inventory]` — 17 keys

| Key name | Default / documented value |
|---|---|
| `allow_ship_no_inventory` | N |
| `auto_vendorid` | YN |
| `bypass_detail` | YN |
| `inv_master` | dw_inven_master_entry_superior |
| `inventory_label` | — |
| `order_entry_commit` | YN |
| `po_copies` | Number of copies you want printed |
| `po_detail_comments` | YN |
| `po_form` | — |
| `po_form_issue_date` | — |
| `po_form_revision` | — |
| `po_open_duedate_report` | — |
| `po_open_report` | — |
| `scrap` | YN |
| `search_datawindow` | NULL |
| `shipping_auto_usage` | YN |
| `use_inventory` | YN |


### A.27 `[Invoicing]` — 363 keys

| Key name | Default / documented value |
|---|---|
| `1_inv_per_shipper_bill_parts` | — |
| `access_part_maint` | YN |
| `Add_on_1_exclude` | — |
| `Add_on_1_include` | — |
| `Add_on_1_include_nonppg` | — |
| `Add_on_1_minimum` | 0 |
| `Add_on_1_name` | — |
| `Add_on_1_percent` | 0 |
| `Add_on_1_type` | TF |
| `Add_on_2_exclude` | — |
| `Add_on_2_include` | — |
| `Add_on_2_include_nonppg` | — |
| `Add_on_2_name` | — |
| `Add_on_2_percent` | 0 |
| `Add_on_2_type` | TF |
| `Add_on_3_exclude` | — |
| `Add_on_3_include` | — |
| `Add_on_3_include_nonppg` | — |
| `Add_on_3_name` | — |
| `Add_on_3_percent` | 0 |
| `Add_on_3_type` | — |
| `Add_on_4_include` | — |
| `Add_on_4_name` | — |
| `Add_on_4_percent` | 0 |
| `Add_on_4_type` | — |
| `Add_on_5_exclude` | — |
| `Add_on_5_include` | — |
| `Add_on_5_name` | — |
| `Add_on_5_percent` | 0 |
| `Add_on_5_type` | — |
| `addcerttopricestructure` | YN |
| `addon1_ppg_unittype` | F |
| `addon1_ppg_use_include_lists` | YN |
| `addon710_zero_min` | YN |
| `adj_pcode` | — |
| `age_from_endofmonth` | YN |
| `allocate_part_mins` | YN |
| `allow_freight_row_delete` | YN |
| `allow_zero_price_rows` | YN |
| `always_do_step_pricing` | YN |
| `AR_different_location` | YN |
| `auto_display_part_notes` | YN |
| `auto_load_parts` | YN |
| `batch_detail_shows_dim` | YN |
| `batch_email_first` | YN |
| `batch_email_nolist` | YN |
| `Batch_print_by_docnum` | — |
| `batch_print_dollars` | YN |
| `bill_black_weight` | N |
| `bill_parts_or_shipped` | PS |
| `breakout_keeps_ppg` | YN |
| `breakout_price_struct` | YN |
| `build_gl_posting_table` | YN |
| `bypass_wt_change` | — |
| `calendar_start_day` | Monday |
| `cbuser1_pcode` | NULL |
| `cc_by_process_master` | NULL |
| `cert_pcode` | — |
| `certification_price` | — |
| `chart_pcode` | — |
| `charts_use_container_count` | YN |
| `check_date_no_days` | 0 |
| `check_date_on_tabout` | YN |
| `check_for_unprinted_shipments` | Y |
| `check_price_per_pound` | YN |
| `copy_order_header_user_fields` | N |
| `create_custom_options` | — |
| `create_invoice_file` | — |
| `create_no_chg_price_row` | NULL |
| `create_nocharge_inv` | YN |
| `create_printed_shpmts_only` | YN |
| `create_sets_pm_units` | YN |
| `create_show_sql_preview` | N |
| `credit_gl_number` | — |
| `custom_part_dw` | — |
| `custom_price_is_order_min` | N |
| `custom_pricing` | — |
| `custom_process_codes` | — |
| `customs_invoice_copies` | 0 |
| `customs_invoice_form` | — |
| `daily_metal_prices` | YN |
| `daily_metal_prices_date` | SON |
| `daily_min_amount` | 0 |
| `daily_min_proc_exclude` | — |
| `days_back_to_search_on` | — |
| `def_min_1` | — |
| `def_min_2` | — |
| `def_min_3` | — |
| `default_Minimum_dollars` | — |
| `default_search_field` | NULL |
| `delete_zero_perpart_rows` | Y |
| `Dimensions_on_part` | — |
| `display_all_comments` | NULL |
| `display_billing_quotes` | YN |
| `distributions_must_have` | — |
| `do_not_get_eq_gl` | — |
| `do_not_get_gl` | — |
| `do_note_check_in_batch` | — |
| `do_part_maintenance_price` | YNQ |
| `do_ppg_pricing` | — |
| `doaddon710` | N |
| `EDI_Type` | — |
| `email_first` | YN |
| `email_first_always_print` | YN |
| `email_form_type` | — |
| `email_liability_file` | YN |
| `email_nolist` | YN |
| `email_tc_file` | YN |
| `enter_inv_number` | YN |
| `eq_offset_gl` | — |
| `equip_req` | YN |
| `export_address_control` | — |
| `export_checks_fiscal_period` | NULL |
| `export_file_check` | YN |
| `export_file_location` | — |
| `export_file_name` | — |
| `export_file_type` | — |
| `export_import_invoices_to_corp` | — |
| `export_requires_print` | Y |
| `finish_pricing` | — |
| `first_part_maint_tab_name` | the label of the tab |
| `force_note_view` | YN |
| `force_order_hold_release` | N |
| `form_checkboxes` | PEF |
| `form_number` | — |
| `Freight` | LYN |
| `Freight_dollar_amount` | — |
| `freight_line_pcode` | — |
| `ftp_format` | — |
| `get_assembly_price` | — |
| `get_cert_format_price` | — |
| `get_gl_on_table_key_match` | YNO EQN |
| `get_orderid_button` | YN |
| `get_process_part_price` | YN |
| `get_tracked_equipment` | YPVN |
| `gl_by_cost_center` | NULL |
| `gl_posting_traverse` | YN |
| `glexport_plant1_plantid` | — |
| `glexport_plant2_plantid` | — |
| `group_batch_invoices` | YN |
| `group_batch_invoices_1pdf` | YN |
| `group_shipments_by_shipto` | NULL |
| `import_table_key` | — |
| `import_version` | — |
| `include_order_type_I_T` | YN |
| `insp_code_on_invoice` | YN |
| `intercompany_gl_1` | — |
| `intercompany_gl_2` | — |
| `intercompany_plant_1` | — |
| `intercompany_plant_2` | — |
| `inv_cred_use_same_num_list` | YN |
| `invoice_file_location` | {file path location} |
| `invoice_file_type` | xml |
| `invoice_form` | — |
| `invoice_num_eq_shippernum` | — |
| `invoice_price_section` | — |
| `keep_calendar_date` | YN |
| `keep_history` | YN |
| `keep_history_apply_payments` | Y |
| `keep_history_batch` | Y |
| `keep_history_inv_create` | Y |
| `keep_history_inv_lock` | Y |
| `keep_hold_status` | YN |
| `keep_temp_data` | N |
| `keys_from_process_master` | YN |
| `liability_file_print_only` | N |
| `location` | — |
| `lock_invoice_display` | — |
| `lock_invoices_not_printed` | YN |
| `lock_prelim_dist_dw` | — |
| `locked_date_msg_on_print` | N |
| `manual_ftp` | N |
| `manual_invoice_form` | — |
| `mark_all_order_shipments` | — |
| `market_sector_suser_field` | — |
| `MAS90_unsupported_code` | N |
| `max_invoices_per_pdf` | 1 |
| `maximum_price_per_pound` | 0 |
| `metal_prices_on_mins` | Y |
| `metal_uses_parts_priceper` | N |
| `min_override_by_pcode` | N |
| `minimum_price_per_pound` | 0 |
| `misc_export_file_location` | — |
| `misc_export_file_type` | — |
| `Multi_for_1_date` | — |
| `multi_inv_by_po` | — |
| `multi_order_inv_all` | — |
| `multi_part_zero_min` | N |
| `multi_seqno_form` | — |
| `multiorder_during_batch` | N |
| `multiple_equiv_pricekeys` | N |
| `new_addon_code` | Y |
| `new_pricing_code` | Y |
| `no_cust_process_ID` | — |
| `no_qty_skip_price` | N |
| `One_Minimum` | — |
| `One_Minimum_Process_Exclude` | — |
| `open_after_remove_ord` | N |
| `open_with_calendar` | Y |
| `order_assembly` | N |
| `order_charges_after_pm` | N |
| `order_charges_priceper` | — |
| `order_datawindow` | NULL |
| `order_entry_info` | — |
| `order_entry_pricing` | N |
| `order_entry_pricing_continues` | N |
| `order_entry_zero_prices` | N |
| `order_prices_use_step_pricing` | NULL |
| `outside_processing_pcode` | — |
| `part_cert_bill_no_price` | N |
| `Part_color_and_dollars` | — |
| `part_minimum_override` | N |
| `part_process_grid_pricing` | N |
| `partial_and_no_chg_pricing` | N |
| `pcode_override_pricing` | N |
| `pdf_timeout` | 5 |
| `per_part_minus_1` | Y |
| `perform_credit_limit_check` | — |
| `pictures on price rows` | — |
| `pop_up_credit_status` | Y |
| `pop_up_notes` | N |
| `populate_price_code_results` | N |
| `pr_finance_charge_days` | 0 |
| `pr_finance_charge_min` | 0 |
| `pr_finance_charge_tablekey` | — |
| `pr_finance_charge_unit` | F |
| `precious_metal_multipart` | N |
| `precious_metal_price_check` | — |
| `precious_metal_process_code` | — |
| `preprice` | — |
| `preprice_excludes_addons` | N |
| `preprice_invoices_keep_history` | N |
| `preprice_only` | N |
| `preprice_partials` | N |
| `prepricecod` | — |
| `prevent_duplicate_doc_numbers` | N |
| `Price_based_on_order_units` | — |
| `price_key_and_size_on_part` | — |
| `price_on_part` | — |
| `price_per_pound_units` | 0 |
| `price_row_finance_charges` | N |
| `price_row_per_part` | N |
| `print_coast_calcs` | — |
| `print_created_list` | — |
| `print_liability_1percust` | N |
| `print_liability_file` | N |
| `print_liability_file_batch` | N |
| `print_liability_when_noemail` | N |
| `print_pl` | — |
| `process_code_of_cert` | — |
| `process_code_to_find` | — |
| `process_codes_to_certify` | — |
| `process_codes_to_certify2` | — |
| `process_master_sets_group` | N |
| `process_part_not_mandatory` | — |
| `process_search_noparts` | N |
| `purge_history_after_x_days` | 0 |
| `recalc_tax_with_addon` | N |
| `recalc_tax_with_addon1` | Y |
| `recalc_tax_with_addon2` | Y |
| `recalc_tax_with_addon3` | Y |
| `recalc_tax_with_addon4` | Y |
| `recalc_tax_with_addon5` | Y |
| `report_ord_no_part_price` | — |
| `report_preprice_dw` | — |
| `require_delete_reason` | N |
| `require_order_id` | N |
| `round_addon710_prices` | Y |
| `Round_price_to` | — |
| `round_weight_to` | 5 |
| `s_user1_title` | — |
| `s_user2_title` | — |
| `s_user3_title` | — |
| `s_user4_title` | — |
| `s_user5_title` | — |
| `s_user6_title` | — |
| `sales_gl_number` | — |
| `salt_pcode` | — |
| `screw_pricing` | — |
| `screws_and_washer_pricing` | — |
| `search_checkboxes` | — |
| `send_no_charge_inv_to_AR` | — |
| `set_assembly_to_qty` | N |
| `set_cc_before_pricing` | N |
| `set_cert_dols_button` | N |
| `set_daily_minimum` | N |
| `set_detail_on` | — |
| `set_header_qty_lbs` | — |
| `set_invoices_nolock` | N |
| `set_line_row_to_1` | — |
| `set_mins_button` | N |
| `set_part_mins_pcode_exclude` | — |
| `set_part_price_mins` | N |
| `set_part_proc` | — |
| `set_sort_by_docnum` | — |
| `set_structure_search` | C |
| `shipment_report` | — |
| `shipper_sort_by_shippernum` | — |
| `show_addons` | — |
| `show_addons710_source` | Y |
| `show_ar_balance` | N |
| `show_calc_minimum` | N |
| `show_carrier` | N |
| `show_credit_status` | N |
| `show_customer_comments` | N |
| `show_default_Minimum_dollars` | NULL |
| `show_detail_report` | — |
| `show_inv_list_report` | N |
| `show_logo_on_form` | N |
| `show_mos_number` | N |
| `show_nocharge_button` | Y |
| `show_order_totals` | — |
| `show_pricing_popup` | N |
| `show_ship_print_number` | — |
| `show_shipped_parts_only` | — |
| `show_shipto_address` | — |
| `show_step_price_message` | Y |
| `sidebar_custnotes_dw` | dw_oe_customer_notes |
| `sidebar_dollars_dw` | dw_inv_dollar_display |
| `sidebar_ordnotes_dw` | d_order_notes |
| `sidebar_quote_dw` | dw_quote_sidebar_disp |
| `sidebar_shipment_dw` | dw_inv_sidebar_ship_di |
| `site` | — |
| `skip_no_price_steps` | — |
| `skip_no_qty_part` | N |
| `skip_rework_steps` | — |
| `sort_all_by_name` | — |
| `special` | — |
| `special_inv_create` | — |
| `structure_date_no_days` | 0 |
| `subsequent_invoices_nocharge` | N |
| `suppress_part_compressed` | N |
| `swd_sorting` | N |
| `tax1_exclude` | — |
| `tax2_exclude` | — |
| `tax3_exclude` | — |
| `tax_pcode` | — |
| `total_lot_charge` | N |
| `unit_part_price` | — |
| `unit_part_price_customer` | — |
| `unit_types_include` | — |
| `update_assembly_price` | N |
| `update_part_maint_price` | — |
| `update_structure_date` | N |
| `use_assembly_min_billing` | N |
| `use_customs_invoices` | N |
| `use_dashboard` | NULL |
| `use_ok_to_lock` | Y |
| `use_order_terms` | N |
| `use_print_options_table` | N |
| `use_ship_qty_no_partial` | — |
| `use_stored_addons` | N |
| `use_stored_addons_710` | N |
| `use_tracking_qty` | N |
| `userid` | — |
| `validate_order_cost_centers` | — |
| `validate_price_row_group` | N |
| `view_outside_processing_po` | — |
| `warn_no_assembly` | N |
| `warn_zero_orderid` | Y |
| `zero_charge_freight_rows` | Y |
| `zero_decimals_on_wt` | N |
| `zero_partrow_part_cert` | N |


### A.28 `[labelformat]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `container` | — |
| `global_default_label` | — |


### A.29 `[license]` — 4 keys

| Key name | Default / documented value |
|---|---|
| `ExpireOn` | — |
| `LicensedTo` | — |
| `MainMenuName` | — |
| `MenuReports` | — |


### A.30 `[Load_Split]` — 21 keys

| Key name | Default / documented value |
|---|---|
| `company_rules` | NULL |
| `containers_equal_loads` | N |
| `contserial_splittogether` | Y |
| `cursor_on_newload` | N |
| `custom_split_code` | — |
| `manual_serial` | N |
| `manual_serial_locked` | N |
| `max_field` | 0 |
| `max_field_equal_div` | Y |
| `new_kanban_onhold` | Y |
| `newloads_status_open` | N |
| `one_part_per_load` | N |
| `onhold_option` | N |
| `part_equal_div` | Y |
| `print_new_loads` | Y |
| `PrintNewLoads` | Y |
| `qtyperload_default` | N |
| `reprint_original` | N |
| `reset_done_status_2_open` | N |
| `split_by` | — |
| `splitcountequalcontainers` | N |


### A.31 `[manual inspect]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `qadd_oncert_sameas_passfail` | N |


### A.32 `[mas90]` — 5 keys

| Key name | Default / documented value |
|---|---|
| `database` | — |
| `DBMS` | — |
| `LogID` | — |
| `LogPass` | — |
| `ServerName` | — |


### A.33 `[Menu]` — 50 keys

| Key name | Default / documented value |
|---|---|
| `backlog_group_display` | YN |
| `Consolidated Packing List` | NULL |
| `Consolidated_Packing_List` | NULL |
| `custom_invoice_recap_report` | YN |
| `customer_leads` | YN |
| `deliverymanager` | YN |
| `emp_timesheet_reports` | YN |
| `find_replace_assembly_masters` | NULL |
| `flag_shippers` | YN |
| `FunctionKey2` | — |
| `group_list` | NULL |
| `ihp_time_entry` | YN |
| `MARSH_warehousing` | YN |
| `mass_email` | YN |
| `Menu_Help_Icon` | — |
| `MenuCustomPrograms` | — |
| `MessageBoard` | YN |
| `mpp_mrb_maint` | N |
| `new_plant_support` | NULL |
| `new_stored_reports` | YN |
| `outdated_addr_module` | YN |
| `package_shipping_module` | YN |
| `proc/standard_icon_switch` | YN |
| `process_master_test` | N |
| `rfid` | N |
| `sale_orders` | YN |
| `shipped_not_billed` | YN |
| `show_digital_order_approval` | N |
| `show_inv_comm_report` | YN |
| `show_new_business_comm_report` | YN |
| `show_new_expediting_only` | YN |
| `show_outside_processing` | YN |
| `show_pricing_model_report` | N |
| `show_process_change` | YN |
| `show_quick_done` | YN |
| `show_rack_tracking` | YN |
| `show_receive_parts` | N |
| `show_reportbuilder` | YN |
| `show_summary_trial_balance` | YN |
| `show_winlist` | N |
| `SWD_tracking_log` | YN |
| `techno_tracking_report` | YN |
| `use_dashboard` | YN |
| `use_pm_quote_module` | YN |
| `Utility` | N |
| `utility_name` | NULL |
| `Valmont_Galv_tracking_Maint` | YN |
| `valmont_rework_log` | YN |
| `VS_code_trace` | N |
| `Windows_Maximized` | YN |


### A.34 `[MOS_corrections]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `allow_mos_correct_2_0` | N |


### A.35 `[MPP_Tracking_Schedule]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `AreaId` | — |
| `{Area Id}` | {Sort order} |


### A.36 `[MRE_inspect]` — 5 keys

| Key name | Default / documented value |
|---|---|
| `allow_load_status_hold` | N |
| `out_of_range_security` | N |
| `reject_default_hold` | N |
| `reject_onhold_lockout` | N |
| `tracking_result_dw` | — |


### A.37 `[notes]` — 14 keys

| Key name | Default / documented value |
|---|---|
| `add_only` | N |
| `group1_name` | Note Group 1 |
| `group2_name` | Note Group 2 |
| `group3_name` | Note Group 3 |
| `group4_name` | Note Group 4 |
| `group5_name` | Note Group 5 |
| `note_entry_dw` | — |
| `note_ignore` | — |
| `note_pop_up_timer` | — |
| `note_width` | 1563 |
| `orderdatereminder` | — |
| `orderdatereminder_rush` | N |
| `orderdatereminder_timer` | — |
| `sort_order` | A |


### A.38 `[OPT]` — 6 keys

| Key name | Default / documented value |
|---|---|
| `database` | — |
| `DBMS` | — |
| `DBPARM` | — |
| `LogID` | — |
| `LogPass` | — |
| `ServerName` | — |


### A.39 `[Order Charges]` — 25 keys

| Key name | Default / documented value |
|---|---|
| `charge1_comments` | — |
| `charge1_price` | 0 |
| `charge1_priceper` | — |
| `charge1_quantity` | 0 |
| `charge1_tablekey_seqno` | 0 |
| `charge2_comments` | — |
| `charge2_price` | 0 |
| `charge2_priceper` | — |
| `charge2_quantity` | 0 |
| `charge2_tablekey_seqno` | 0 |
| `charge3_comments` | — |
| `charge3_price` | 0 |
| `charge3_priceper` | — |
| `charge3_quantity` | 0 |
| `charge3_tablekey_seqno` | 0 |
| `charge4_comments` | — |
| `charge4_price` | 0 |
| `charge4_priceper` | — |
| `charge4_quantity` | 0 |
| `charge4_tablekey_seqno` | 0 |
| `charge5_comments` | — |
| `charge5_price` | 0 |
| `charge5_priceper` | — |
| `charge5_quantity` | 0 |
| `charge5_tablekey_seqno` | 0 |


### A.40 `[order label]` — 18 keys

| Key name | Default / documented value |
|---|---|
| `company_name` | — |
| `container_default_number` | 0 |
| `container_label_copies_equal_x` | N |
| `container_label_form` | — |
| `container_label_pictures` | N |
| `container_label_plus_count` | 0 |
| `container_label_uses_print_opt` | N |
| `container_labels_only` | — |
| `copy_number` | 1 |
| `label_type` | — |
| `labels_by_part` | — |
| `multiple_print_jobs` | — |
| `Part_Description` | N |
| `print_all_loads` | N |
| `print_orientation` | D |
| `print_zero` | — |
| `SinglePrintSpool` | N |
| `use_print_options` | N |


### A.41 `[Order Management (Was Expediting)]` — 68 keys

| Key name | Default / documented value |
|---|---|
| `allow_customeronly_search` | YN |
| `approval id flag` | YN |
| `auto_display_notes` | N |
| `auto_display_part_notes` | YN |
| `Auto_log_order` | YesNo |
| `bit_settings` | 0 |
| `bolt_on_rush_types` | RTP |
| `bothsearchptypesvisible` | YN |
| `Calculate_lbs_from_qty` | YESNO |
| `Chart_Used_For_Rush` | YN |
| `custlookup_return_id_only` | YN |
| `daysback` | — |
| `default_search` | — |
| `display_ccm` | YN |
| `display_chart` | YN |
| `display_move_rec` | YN |
| `display_sched_dw` | — |
| `due_date_type` | RT |
| `dw_insp` | — |
| `dw_load` | — |
| `dw_order_top` | — |
| `dw_parts` | — |
| `dw_tracking` | — |
| `exact_tracking_number_match` | YN |
| `force_find_visible` | N |
| `gototrack` | YN |
| `hide_pinv_create_msg` | N |
| `inspection_rows` | NULL |
| `inspfailflag_bystep` | N |
| `inv_list_display_multishipper#` | YN |
| `invoice_form` | — |
| `load_dw_no_zero_parts` | YN |
| `may_miss_days` | NULL |
| `next_type` | — |
| `norush_if_invoiced_shipped` | YN |
| `open_orders_only` | — |
| `order_search_bal_wt_format` | — |
| `order_search_window` | — |
| `ordersearch_sortorder` | DA |
| `other_settings` | PEENINGN |
| `picture_update` | YN |
| `prev_next_orders` | — |
| `printbutton_orderform` | YN |
| `rushtab_custom_dw` | — |
| `rushtab_plantdd` | — |
| `search_container` | N |
| `search_serial` | N |
| `ShippedOrders_by_date` | YN |
| `shipperlookupbutton` | YN |
| `shipping_datawindow` | — |
| `shipping_hold` | YN |
| `show_inspection_tab` | YN |
| `show_reversed_shippers` | YN |
| `show_time_temp` | YN |
| `show_tracking_report` | YN |
| `surface_connstring` | — |
| `SWD_log` | YN |
| `title_Aircraft` | — |
| `title_Job#` | — |
| `title_Other_cust_1` | — |
| `title_Other_cust_2` | — |
| `title_packing_slip` | — |
| `title_Tracking#` | — |
| `tracking_report` | — |
| `trackingtab_custom_dw` | — |
| `tracktab_hide_notrack` | N |
| `use_new_search_list` | NULL |
| `will_miss_days` | NULL |


### A.42 `[order printing]` — 125 keys

| Key name | Default / documented value |
|---|---|
| `"Outside_po_form"+string(lppo` | — |
| `"Outside_po_key"+string(lppo` | — |
| `always_setto_load1` | N |
| `autoplan_form_type` | — |
| `autoprint_order` | N |
| `bar_code_font` | — |
| `barcode_visible` | N |
| `blueprint_form` | — |
| `cert_print` | — |
| `check_for_acrobat` | Y |
| `color_day_'+trim(string(daynu` | — |
| `company_name` | — |
| `cont_form_number` | — |
| `contact_review_form` | N |
| `copies` | — |
| `copies_equal_contcount` | N |
| `cr_form_number` | — |
| `create_preprice_inv` | N |
| `customer_picture` | N |
| `endingbitmap` | — |
| `final` | — |
| `final2` | — |
| `final3` | — |
| `form_number` | — |
| `form_number2` | — |
| `form_type` | — |
| `item_numbers` | — |
| `keep_temp_data` | N |
| `label_form_number` | — |
| `max_number_of_copies` | 15 |
| `office_copy` | N |
| `other_checkbox_checked` | — |
| `Outside_po_form` | — |
| `Outside_po_key` | — |
| `outside_po_no` | 1 |
| `override_print_options_copies` | N |
| `part_pics_4_perpage` | N |
| `partload_pictures` | N |
| `pdf_timeout` | 5 |
| `pdfs_first_part_only` | N |
| `pdfs_load_parts_only` | N |
| `pdfs_per_part_seqno` | NULL |
| `pdfs_use_timeout` | N |
| `pic_options` | — |
| `print_additional_filename` | — |
| `print_alternate_steps` | — |
| `print_barcode` | — |
| `print_completed_steps_only` | — |
| `print_container_labels` | N |
| `print_cust_id` | — |
| `print_formal_spec` | — |
| `print_labels` | — |
| `print_load_code` | — |
| `print_logo` | — |
| `print_optional_steps` | — |
| `print_other_label` | — |
| `print_outside_po` | — |
| `print_outside_po_copies` | 0 |
| `print_part_pdfs` | N |
| `print_part_pdfs_once` | N |
| `print_picture` | — |
| `print_proc_attach_once` | N |
| `print_proc_attachments` | N |
| `print_process_id` | — |
| `print_router` | — |
| `print_section_size` | — |
| `print_seperate_jobs` | — |
| `print_step_pics` | N |
| `print_steps` | — |
| `PrintForm1_collate` | — |
| `PrintForm1_copies` | — |
| `PrintForm1_duplex` | — |
| `PrintForm1_dw` | — |
| `PrintForm1_orientation` | -1 |
| `PrintForm1_pagerangeinclude` | — |
| `PrintForm1_papersource` | — |
| `PrintForm1_printer` | — |
| `PrintForm1_quality` | — |
| `PrintForm1_range` | — |
| `PrintForm1_scale` | — |
| `PrintForm2_collate` | — |
| `PrintForm2_copies` | — |
| `PrintForm2_duplex` | — |
| `PrintForm2_dw` | — |
| `PrintForm2_orientation` | -1 |
| `PrintForm2_pagerangeinclude` | — |
| `PrintForm2_papersource` | — |
| `PrintForm2_printer` | — |
| `PrintForm2_quality` | — |
| `PrintForm2_range` | — |
| `PrintForm2_scale` | — |
| `PrintForm3_collate` | — |
| `PrintForm3_copies` | — |
| `PrintForm3_duplex` | — |
| `PrintForm3_dw` | — |
| `PrintForm3_orientation` | -1 |
| `PrintForm3_pagerangeinclude` | — |
| `PrintForm3_papersource` | — |
| `PrintForm3_printer` | — |
| `PrintForm3_quality` | — |
| `PrintForm3_range` | — |
| `PrintForm3_scale` | — |
| `receiving_insp_form` | N |
| `reprint_multi` | — |
| `resolution` | — |
| `rev_no` | — |
| `ReworkRequestOnPrint` | — |
| `RFID Checked` | N |
| `ri_form_number` | — |
| `show_preview_button` | N |
| `show_price` | — |
| `Signoff34_process_codes` | — |
| `signoff_p_category` | — |
| `Signoff_process_codes_exclude` | — |
| `signoff_x_category` | — |
| `step_header_text` | — |
| `step_signoff` | — |
| `step_signoff2` | — |
| `step_signoff3` | — |
| `step_signoff4` | — |
| `subforms_firstprint_only` | N |
| `subforms_load1_only` | N |
| `use_pic_print_table` | N |
| `use_print_options_table` | N |
| `watermark_process_master` | — |


### A.43 `[Order Search]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `days_back` | Yesterday |


### A.44 `[order status]` — 8 keys

| Key name | Default / documented value |
|---|---|
| `All Load Button` | N |
| `chg_checkbox2_title` | — |
| `chg_checkbox_title` | — |
| `chg_field_checkbox` | — |
| `chg_field_checkbox2` | — |
| `chg_field_reason` | — |
| `log_change_reason` | N |
| `tracking` | N |


### A.45 `[order_final_inspect]` — 23 keys

| Key name | Default / documented value |
|---|---|
| `addbutton_pass_default` | — |
| `always_allow_inspections` | N |
| `approval id flag` | N |
| `auto_display_notes` | N |
| `Auto_fill_insp_code_only` | N |
| `Cert_maint` | N |
| `Container_maint` | N |
| `copy_inspection` | N |
| `copy_inspresults` | N |
| `copy_scale` | N |
| `display_customer_comments` | N |
| `display_pre_post_comments` | N |
| `dw_final_insp_list` | — |
| `failed_loads_no_release` | N |
| `failed_loads_on_hold` | N |
| `final_insp_area_list` | — |
| `ifnotvalid_displaysteps` | N |
| `initial_on_cert` | — |
| `initial_passinsp` | — |
| `inspection_list_visible` | N |
| `inspection_with_results` | N |
| `print_cert_of_compliance` | N |
| `print_custom_cert` | N |


### A.46 `[order_label]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `label_number` | — |


### A.47 `[order_status_report]` — 3 keys

| Key name | Default / documented value |
|---|---|
| `serv_dept_contact` | — |
| `serv_dept_manager` | — |
| `serv_dept_phone` | — |


### A.48 `[OrderProcess_Display]` — 3 keys

| Key name | Default / documented value |
|---|---|
| `footer_text` | — |
| `Part_Watermark` | N |
| `steps_dw` | dw_exp_order_lookup |


### A.49 `[Orders]` — 288 keys

| Key name | Default / documented value |
|---|---|
| `6th_order_email_bcc` | — |
| `6th_order_email_list` | — |
| `accpac_export` | N |
| `add_load_parts` | N |
| `addpart_required_field_check` | Y |
| `AddStepProcessFromAbove` | Y |
| `after_assm_goto_assmtab` | N |
| `after_partselect_moveto` | — |
| `allow_changes` | — |
| `allow_force_on_hold` | N |
| `Allow_Multi_Processes` | N |
| `always_request_cont_labels` | N |
| `AlwaysUse_PartShipto` | N |
| `approved_quotes_only` | N |
| `area_dropdown_dw_name` | — |
| `Assembly_KeepOriginalStepEq` | N |
| `Assembly_process` | — |
| `assign_containerid` | N |
| `attach_invoice_addons` | N |
| `auto_open_orderpartdetail` | N |
| `auto_plan` | N |
| `auto_search_last_tc` | N |
| `auto_show_cust_notes` | N |
| `AutoPlan_Default_CertFormat` | — |
| `AutoPlan_Replace_certfreeform` | Y |
| `autoselect_assembly_checkbox` | 0 |
| `autoupdate_addresses` | — |
| `background_color_headings` | 0 |
| `Bodycote_ud` | — |
| `Bypass_expired_quotes` | — |
| `bypass_po_required` | N |
| `calculate_amps` | — |
| `capture_insert_values` | — |
| `carrier_or_route_required` | N |
| `cb_user1_function` | — |
| `cert_by_process` | — |
| `certoverride` | N |
| `change_search_costcenter` | — |
| `charts` | N |
| `check_order_for_zero_qty/wt` | N |
| `ChemPlate_Can_eng` | N |
| `cod_type_message` | — |
| `complete_trackthrough` | N |
| `compress_part_search` | Y |
| `cont_part_add_each` | N |
| `container_window` | — |
| `ControlMenu` | N |
| `copy_custgroup_eqid_2_steps` | NULL |
| `copy_plantcc_to_proc` | Y |
| `costcenter_as_plant` | N |
| `create_cert_steps` | N |
| `create_new_masters` | — |
| `custnote_nodocuments` | N |
| `custom_calculation` | — |
| `custom_pppsc` | N |
| `debug` | N |
| `default_certification` | N |
| `default_container` | — |
| `default_deliverypriority` | 0 |
| `default_first_location` | — |
| `default_last_location` | — |
| `default_part_thickness` | — |
| `dim1` | dim1 |
| `dim2` | dim2 |
| `dim3` | dim3 |
| `dim4` | dim3 |
| `dim5` | — |
| `display_all_comments` | N |
| `display_make_order_msg` | Y |
| `displaypartlist_evenif_1found` | NULL |
| `dist_onepartperload` | N |
| `dup_after_save` | N |
| `dup_prev_order` | — |
| `dup_prev_order_section` | C |
| `dupe_bits` | 0 |
| `dupeorderlist_descending` | N |
| `duplast_resetdates` | N |
| `elm_lot#_partcheckbox` | NULL |
| `elm_pack_charlist` | {list of valid characters} |
| `elm_pack_charlocation` | NULL |
| `elm_pack_custlist` | {list of customer id's} |
| `elm_pack_EL_custlist` | NULL |
| `elm_pack_EL_partcheckbox` | NULL |
| `elm_pack_partcheckbox` | {no of part maint checkb |
| `email_liability_file` | N |
| `email_notification` | N |
| `email_notification_end` | — |
| `email_notification_lead` | — |
| `email_notification_structure` | — |
| `email_notification_subject` | — |
| `email_notification_text` | — |
| `email_notification_text_file` | — |
| `email_tc_file` | N |
| `enter_process_id` | — |
| `export_file_location` | — |
| `ext_price_po_check` | N |
| `figure_tare` | N |
| `finishtype` | — |
| `first_article` | — |
| `first_ordassem_steps_only` | N |
| `first_order_email` | N |
| `first_order_email_bcc` | — |
| `force_partnote_click` | N |
| `formalspec_overlay` | N |
| `generic_part_search_fallback` | N |
| `generic_proc_search` | Standard |
| `get_onhold_reason` | N |
| `group_a_filter` | — |
| `group_b_filter` | — |
| `group_c_filter` | — |
| `hide_creditLimit_msg` | N |
| `hide_creditReview_msg` | N |
| `hide_creditStatus_msg` | N |
| `hide_pm_qtylbsperload` | N |
| `in_order_master_search` | — |
| `insp_inst_in_pm_comments` | Y |
| `inspection_overlay` | — |
| `keep_po_inventory` | N |
| `key_order_at` | N |
| `load_size_from` | Parts |
| `load_weight` | — |
| `mandatory_actuals` | — |
| `mandatory_before_process_ok` | — |
| `mandatory_cust_proc_table` | — |
| `mandatory_material_check` | — |
| `mandatory_process_check` | — |
| `market_sector_suser_field` | — |
| `material_overlay` | N |
| `max_cust_actual_qty_dev_%` | — |
| `max_cust_actual_wt_dev_%` | — |
| `microsection_inspect_code` | — |
| `minmaxorvalue_required_for` | — |
| `move_material_to_part` | N |
| `move_part_dimensions` | N |
| `move_partcertformat_2_process` | N |
| `move_parts_to_new_order` | N |
| `move_thickness_to_part` | N |
| `move_type_condition` | N |
| `movepart_cont2process` | N |
| `movepart_custspec2process` | N |
| `movepart_pmspecs2process` | N |
| `mtt_lookup_by_value_only` | N |
| `multi_verified_lookup` | — |
| `new_customer_selection` | Y |
| `newpart_noassembly_pricing` | N |
| `newpart_on_pm_change` | — |
| `no_cust_prospects` | N |
| `no_date_check` | — |
| `no_general_quote_message` | N |
| `no_partdesc_update` | N |
| `no_po_dupication` | N |
| `no_target_date_msg` | N |
| `no_unverified_parts` | NULL |
| `notification_form` | — |
| `notification_form_docname` | NULL |
| `notification_status` | R |
| `On New Customer Set Terms` | — |
| `one_assembly_spec_required` | N |
| `one_part_per_order` | N |
| `one_partquote_required` | N |
| `opp2_screen` | — |
| `opp_screen` | — |
| `order_entry_setup` | — |
| `order_hold_on_part_hold` | Y |
| `order_part_detail_popup_dw` | — |
| `order_part_mask` | — |
| `order_process_search` | N |
| `orderassembly_dw` | — |
| `orderassembly_pm_select` | N |
| `orderpartdetail_calcprice` | N |
| `orderpartdetail_popup_assembly` | N |
| `otherdate_as_promisedate` | N |
| `overide_onscreen_print` | No |
| `overlay_key_replace` | Y |
| `part_assembly_inspect` | — |
| `part_assembly_must_match` | N |
| `part_auto_qty` | N |
| `part_container_row_equality` | N |
| `part_list_verified` | Y |
| `part_listbox_dw_name` | — |
| `part_listbox_show_inactive` | N |
| `part_name_lookup_option` | N |
| `part_note_column` | — |
| `part_price_message` | N |
| `part_qty_from_wt` | N |
| `part_reqdays_msg` | Y |
| `partassembly_as_orderassembly` | N |
| `partassembly_pricing_required` | N |
| `partassm_pricepopup` | N |
| `partgroup_override` | N |
| `partquote_expire_bcc` | — |
| `partquote_expire_notice` | N |
| `pm_duser1_days` | {no of days} |
| `pm_quote_days` | {no of days} |
| `poni_copper` | — |
| `poni_coppergalv` | — |
| `poni_muriatic_tin` | — |
| `poni_promoter` | — |
| `poni_promotergalv` | — |
| `poni_ps96` | — |
| `poni_starter` | — |
| `poni_sulfuric` | — |
| `populate_cont_via_part` | N |
| `popup_orderpartdetail_multi` | N |
| `prime_check` | N |
| `print_checkbox_option` | N |
| `print_chkbx_def_contlabel` | Y |
| `print_chkbx_def_label` | Y |
| `print_chkbx_def_order` | Y |
| `print_hold_orders` | N |
| `print_order_first` | N |
| `proc_inst_in_pm_comments` | Y |
| `proc_safty_bypass` | NULL |
| `process_control_file_location` | — |
| `process_default` | — |
| `process_master_email` | N |
| `process_master_email_list` | — |
| `process_part_info_display` | — |
| `process_search_generic_default` | N |
| `process_tab_set_search` | N |
| `ProcMast_Reqest_NoPrompt` | N |
| `ProcMast_Sets_TargetDate` | — |
| `qty_change_email_addr` | — |
| `qty_change_email_bcc` | — |
| `quote_each_part` | N |
| `quote_each_part_dw` | — |
| `quote_each_part_dw_byname` | — |
| `Quote_only_once` | — |
| `quote_part_by` | P |
| `quote_price_display` | N |
| `quote_price_display_dw` | dw_order_quote_price_ |
| `quote_select_color` | — |
| `quotecontact_as_ordercontact` | N |
| `reopen_warning` | N |
| `request_date_days` | — |
| `request_from_workdays` | N |
| `rework_doubles_price` | NULL |
| `rework_min_price` | NULL |
| `round_ea_wt_to` | 4 |
| `round_weight_to` | 2 |
| `route_or_carrier_out_only` | N |
| `save_prompt_on_close` | N |
| `scan_pdfs` | N |
| `search_msg_code` | — |
| `Security_Lockout` | — |
| `send_qty_change_email` | N |
| `ship_stops_req_date_chg` | N |
| `shipping_hold` | N |
| `shiptosave_carrier` | N |
| `shiptosave_route` | N |
| `show_assembly_tab` | Y |
| `show_contractreview_tab` | N |
| `show_inventory_tab` | Y |
| `skipsimplepartprice_ext` | N |
| `specification_overlay` | — |
| `splitdefault_if_morethanone` | — |
| `start_days` | — |
| `step_overlay` | — |
| `steps_set_to_email` | N |
| `steps_set_to_email_rework` | NULL |
| `steptab_tabseq` | — |
| `suppress_insp_overlay_message` | N |
| `swd_partnotemessage` | N |
| `tabthroughdetailtab` | N |
| `target_days` | 0 |
| `targetdate_via_cc` | N |
| `targetdate_via_entrydt` | N |
| `tc_number_manual` | Y |
| `tc_number_notes` | Y |
| `tc_number_use` | N |
| `test_inspcode_match` | N |
| `test_partprocess_match` | N |
| `tracking_on` | — |
| `upd_part_w_new_process` | N |
| `update_order_part_thickness` | N |
| `use_actuals` | — |
| `use_assembly_dw` | — |
| `use_container_tare` | N |
| `use_plateco_lbs_per_load` | N |
| `use_popup_orderpartdetail` | N |
| `use_process_part_thickness` | N |
| `use_simple_order_entry` | — |
| `use_simple_part_entry` | — |
| `use_simple_process_entry` | — |
| `use_simple_serial_entry` | — |
| `view_inv_creates_preprice` | N |
| `warning_container#_duped` | — |
| `word_insert_user_fields` | N |


### A.50 `[other label]` — 7 keys

| Key name | Default / documented value |
|---|---|
| `company_name` | — |
| `other_default_number` | 0 |
| `other_label_copies_equal_x` | N |
| `other_label_form` | — |
| `other_label_pictures` | N |
| `other_label_plus_count` | 0 |
| `other_label_uses_print_opt` | N |


### A.51 `[outside_processing]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `form_name` | — |
| `po_text` | — |


### A.52 `[Packaging]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `label_copies` | 1 |
| `type` | — |


### A.53 `[Part Quotes]` — 23 keys

| Key name | Default / documented value |
|---|---|
| `auto_dupe_parts` | D |
| `copy_part1_fields` | NULL |
| `create_orders` | NULL |
| `default_group` | — |
| `default_process_code` | — |
| `default_process_id` | — |
| `delete_part_from_db` | N |
| `FaxFormNumber` | — |
| `first_part_maint_tab_name` | the label on the tab |
| `form_checkboxes` | P |
| `internal_form` | — |
| `open_pm_onside` | NULL |
| `part_lbs_column` | — |
| `pm_opens_part1_only` | NULL |
| `print_attachments` | N |
| `print_from_part_maint` | N |
| `print_from_part_maintenance` | Y |
| `print_liability_when_noemail` | N |
| `quote_form` | dw_pph_quote_form_va |
| `quote_header_dw` | dw_part_quote_header |
| `quote_parts_dw` | dw_part_quote_part_ent |
| `show_other_charges` | N |
| `warn_revision` | N |


### A.54 `[part_custom_window]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `select_tab` | N |
| `Set_Selected_Invisible` | N |


### A.55 `[part_pricing]` — 7 keys

| Key name | Default / documented value |
|---|---|
| `assembly_dw` | NULL |
| `crhudgins_surcharge` | — |
| `default_cust_list` | — |
| `default_tab` | 1 |
| `msg_checks_ppg_pricecode` | N |
| `parts_and_ppg` | N |
| `use_customer_list` | N |


### A.56 `[parts]` — 126 keys

| Key name | Default / documented value |
|---|---|
| `"hide_tab"+string(lp` | — |
| `acrobat_pathandname` | — |
| `aftersave_showlist` | N |
| `Allow_Assembly_Sort` | N |
| `ApplyFormula_AtSave` | N |
| `Assembly_button_hide` | N |
| `assembly_search` | N |
| `auto_assign_mp_quoteno` | N |
| `autoplan_partcondition_column` | s_user55 |
| `autoplan_partrevision_column` | s_user3 |
| `autopopulate_plantcostcenter` | Y |
| `button_control` | — |
| `calculate_qty_ext_value` | N |
| `cb_user1_default` | — |
| `color_dddw_only` | N |
| `Company` | — |
| `custgroup_as_default` | — |
| `custom_calculations` | NULL |
| `custom_part_name` | — |
| `customtab_displayfirst` | — |
| `customtab_dw` | — |
| `customtab_maxheight` | — |
| `customtab_text` | — |
| `datawindow_set` | — |
| `default_cert_format` | — |
| `default_formula` | — |
| `default_price_per` | — |
| `default_search` | PART LIST |
| `default_specification` | — |
| `default_usercolumn_2_0` | — |
| `dim1_dropdown` | — |
| `display_finish_price` | — |
| `dup_pictures` | — |
| `dupe_assembly_masters` | Y |
| `dupe_assembly_prices` | Y |
| `dupe_group_part` | — |
| `dupe_part_prices` | Y |
| `edit_process_master` | N |
| `email_quotedby` | NULL |
| `formula_in_control` | N |
| `formula_mass_apply` | N |
| `formula_reqcol_displaytype` | — |
| `formula_standards` | N |
| `frozen_plan` | N |
| `hide_tab1` | N |
| `hide_tab10` | N |
| `hide_tab11` | N |
| `hide_tab12` | N |
| `hide_tab13` | N |
| `hide_tab2` | N |
| `hide_tab3` | N |
| `hide_tab4` | N |
| `hide_tab5` | N |
| `hide_tab6` | N |
| `hide_tab7` | N |
| `hide_tab8` | N |
| `hide_tab9` | N |
| `identify_prices` | N |
| `import_parts` | N |
| `import_parts_errors` | — |
| `import_parts_filename` | — |
| `initial_quote_turnaround` | — |
| `keep_history` | N |
| `keep_overlay_history` | — |
| `market_sector_suser_field` | — |
| `move_process_key_to_part` | N |
| `movequote_proc_mat_2header` | N |
| `new_functions_program` | Y |
| `no_dw_resize` | N |
| `opt_search` | — |
| `order_search` | N |
| `part_dw_search` | dw_part_maint_partonly |
| `part_id_exist_override` | N |
| `part_pdfs` | N |
| `part_price_report` | — |
| `part_process_pic` | N |
| `part_type_dddw_only` | N |
| `part_type_dropdown` | — |
| `partassembly_auto_pricing` | N |
| `partassembly_general_pricing` | Y |
| `partprice_search_dw` | — |
| `parts_on_hold_button` | N |
| `pdf_use_file` | N |
| `picture_dw` | — |
| `pioneer_userdate_days` | 0 |
| `popup_nodupe_fields` | N |
| `pppc_by_part_proc_seq` | N |
| `price_change_quote_dates` | N |
| `price_date_userfield` | — |
| `price_row_dw` | — |
| `price_struct_by_cust` | N |
| `prime_prog` | N |
| `print_assembly` | Y |
| `process_assembly_dw` | — |
| `process_assembly_price_dw` | — |
| `Process_Association` | N |
| `process_dw` | dw_process_step_corre |
| `process_id_by_cc` | N |
| `procfinish_select` | N |
| `qty_ext_value_field` | — |
| `quotes_email_only` | N |
| `quotes_pdf_also` | N |
| `seal_dddw_only` | N |
| `search_expired_quotes` | Y |
| `search_inactive` | Y |
| `set_certify_field` | N |
| `show_cust_leads` | N |
| `show_priceit` | N |
| `showlist_aftersave` | N |
| `spec_by_proc_code` | N |
| `spec_search` | N |
| `step_display` | — |
| `step_overlay_print_from` | — |
| `TabFontFaceName` | — |
| `thumnails` | N |
| `update_userfield_masschange` | N |
| `use_dim_names` | N |
| `use_only_multiquote` | N |
| `use_part_type_formula` | NULL |
| `use_production_teams` | — |
| `use_quotedby_dropdown` | NULL |
| `user_dropdowns` | N |
| `user_format` | — |
| `usertab_text` | — |
| `view_billing_quotes` | N |
| `zero_assembly_minqty` | N |


### A.57 `[pht_tracking]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `ssi_dsn` | — |
| `ssi_note_output` | N |


### A.58 `[Pickups]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `add_to_list_default` | SINGLE |
| `signature_pad` | N |


### A.59 `[picture]` — 7 keys

| Key name | Default / documented value |
|---|---|
| `default_directory` | — |
| `display_4` | N |
| `get_image_from_scanner` | N |
| `grayscale` | N |
| `select_multi_frames` | N |
| `use pictures` | Y |
| `use_explorer` | Y |


### A.60 `[plant]` — 6 keys

| Key name | Default / documented value |
|---|---|
| `DataBase` | — |
| `DBMS` | — |
| `LogID` | — |
| `LogPass` | — |
| `plant id` | — |
| `ServerName` | — |


### A.61 `[PreOrder]` — 3 keys

| Key name | Default / documented value |
|---|---|
| `after_partselect_moveto` | — |
| `no_move_part_desc` | N |
| `no_move_part_material` | N |


### A.62 `[Pricing]` — 10 keys

| Key name | Default / documented value |
|---|---|
| `bracket_auto_populates` | N |
| `calc_each_price_dec` | 2 |
| `dimension_range_message` | Y |
| `hide_cust_step_rev_fields` | Y |
| `keep_ppg_history` | N |
| `over_max_bracket` | N |
| `ppg_default_dec` | 2 |
| `ppg_must_meet_min` | N |
| `process_grid_dw` | — |
| `show_search_on_cancel` | N |


### A.63 `[prime_maint]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `allow_12char_prime` | — |


### A.64 `[printers]` — 24 keys

| Key name | Default / documented value |
|---|---|
| `bill_of_lading` | — |
| `bullzip_resolution` | — |
| `cert` | — |
| `cust_ship_label` | — |
| `device_replace` | — |
| `extended_printer_setup` | N |
| `invoice_form` | — |
| `mos_label_printer` | code |
| `order` | — |
| `order2` | — |
| `order_cont_label` | — |
| `order_label` | — |
| `order_tray` | — |
| `other_label` | — |
| `package_label` | — |
| `print_preview` | N |
| `quote_form` | — |
| `shipping_cert` | — |
| `shipping_label_printer` | — |
| `shipping_ticket` | — |
| `tracking_label` | — |
| `trim(labeldw` | — |
| `VT_shipping_label_printer` | — |
| `Zfax` | — |


### A.65 `[Process]` — 29 keys

| Key name | Default / documented value |
|---|---|
| `approve_process` | N |
| `auto_search` | NULL |
| `cc_plant_lock` | — |
| `code_process` | — |
| `custom_search_dw` | — |
| `customer_spec_dropdown` | N |
| `default_review_days` | 0 |
| `default_search` | default |
| `Default_Type` | G |
| `display_standardstepseqno` | N |
| `Do_Not_resize` | N |
| `Finish_number_search` | Y |
| `formal_spec_dropdown` | N |
| `history_comments` | NULL |
| `invalid_tablekey_msg` | Y |
| `keep_history` | NULL |
| `memorize_steps` | NULL |
| `new_save_program` | N |
| `new_search_window` | N |
| `only_standard_steps` | — |
| `report_datawindow` | — |
| `revision_start_with_zero` | N |
| `search_customer_spec_dropdow` | N |
| `search_formal_spec_dropdown` | N |
| `simple_step_add` | N |
| `specifications_on_steps` | N |
| `standard_step_archiving` | N |
| `step_number_msg` | Y |
| `use_new_window` | NULL |


### A.66 `[Process Codes]` — 4 keys

| Key name | Default / documented value |
|---|---|
| `checkbox1_label` | VN 1 |
| `checkbox2_label` | VN 2 |
| `checkbox3_label` | VN 3 |
| `show_vn_checkboxes` | N |


### A.67 `[quick track]` — 7 keys

| Key name | Default / documented value |
|---|---|
| `auto_display_notes` | N |
| `Auto_fill_insp_code_only` | N |
| `complete_steps` | — |
| `dw_final_result` | — |
| `manual_insp_button` | N |
| `ohiomet_schedstepresets` | N |
| `sub_main_4_steps_insp` | N |


### A.68 `[Quotations]` — 79 keys

| Key name | Default / documented value |
|---|---|
| `calculate_addons` | N |
| `calculate_pickup` | N |
| `comment_long` | N |
| `compress_part_search` | — |
| `days_back` | — |
| `default_end_statement_id` | 0 |
| `default_salesperson` | — |
| `deliverby_checkboxes` | M |
| `Dimensions_on_part` | — |
| `do_ppg_pricing` | — |
| `dup_entire_quote` | N |
| `email_attachment_file` | — |
| `email_liability_file` | N |
| `email_tc_file` | N |
| `expire_days` | 0 |
| `FaxFormNumber` | — |
| `first_row_highlight` | Y |
| `follow_up_days` | — |
| `form_checkboxes` | P |
| `form_number` | — |
| `hide_worksheet_lock` | N |
| `keep_history` | N |
| `labor_cost1_label` | Cost 1 |
| `labor_cost2_label` | Cost 2 |
| `labor_cost3_label` | Cost 3 |
| `labor_cost4_label` | Cost 4 |
| `labor_cost5_label` | Cost 5 |
| `materials_markup` | 120 |
| `MultiPartQuoteFormNumber` | dw_quote_pp_multi |
| `no_auto_pp_quote` | — |
| `no_logo` | N |
| `notification_form_expiration` | dw_part_quotes_expirati |
| `notification_form_followup` | dw_part_quotes_followu |
| `notify_expirations` | N |
| `notify_followups` | N |
| `notify_time` | 8:00 |
| `oe_popup_notes` | N |
| `operations_markup` | 125 |
| `part_dw` | dw_price_part |
| `pdf_directory` | — |
| `percent_probability` | NULL |
| `piece_price_from_hours` | NULL |
| `plant_name` | — |
| `price_dw` | NULL |
| `price_on_save` | N |
| `Prices_expire_with_quote` | — |
| `print_attachments` | N |
| `print_field_exceptions` | — |
| `print_liability_file` | N |
| `print_liability_file_file` | N |
| `quote_attachment` | — |
| `quote_header_dw` | dw_quote_header |
| `quote_signature` | O |
| `QuoteFormNumber` | — |
| `QuotePPFormNumber` | — |
| `require_approval` | N |
| `Round_price_to` | — |
| `round_worksheet_lb_price` | 2 |
| `round_worksheet_min_price` | 2 |
| `round_worksheet_price` | 2 |
| `round_worksheet_price1000` | 2 |
| `salesforce_cust_userfield` | NULL |
| `save_closes_quote` | Y |
| `save_closes_window` | Y |
| `set_probability` | NULL |
| `SetupChargeName` | — |
| `show_dashboard` | NULL |
| `Simple_Quotes` | — |
| `structure_default_dec` | 4 |
| `transportation_rate` | 0 |
| `use_contact_dropdown` | — |
| `use_large_liability` | N |
| `use_resp_worksheet` | N |
| `validate_req_print_fields` | N |
| `warn_existing_price_structure` | — |
| `warn_exists_part_maint` | — |
| `worksheet_creates_structures` | Y |
| `worksheet_dw` | — |
| `worksheet_type` | NULL |


### A.69 `[report_costing]` — 4 keys

| Key name | Default / documented value |
|---|---|
| `material_percent` | 0 |
| `pc_cat_mat` | N |
| `pickup_percent` | 0 |
| `zinc_cost` | 0 |


### A.70 `[Reports]` — 133 keys

| Key name | Default / documented value |
|---|---|
| `12_week_sales_by_process` | N |
| `3yr_sales_cust` | — |
| `ar_aging_dw` | dw_ar_aging_summary |
| `ar_open_invoices` | — |
| `area_process_cycles` | — |
| `area_process_dw` | — |
| `assembly_prices` | — |
| `assembly_pricing_dw` | NULL |
| `auto_date_range` | Y |
| `auto_order_ship_days` | NULL |
| `auto_sending_report` | N |
| `avail_to_ship` | — |
| `backlog$_process_gl_dw` | — |
| `backlog_area_timer` | 99 |
| `backlog_by_cust_daysback` | 0 |
| `backlog_by_customer` | — |
| `backlog_by_customer_shipto` | N |
| `backlog_by_date_custlist` | — |
| `backlog_by_date_dw` | — |
| `backlog_by_due_date_dw` | — |
| `backlog_by_due_date_window` | — |
| `backlog_by_group` | — |
| `backlog_by_procode` | d_oper_backlog_proco |
| `backlog_by_route` | — |
| `backlog_report_by_target_date` | — |
| `cash_projection_dw` | NULL |
| `commitment_report_type` | — |
| `contact_report_dw` | — |
| `cust_ops_ar_aging` | — |
| `cust_ops_ar_aging_summary` | — |
| `cust_order_status` | — |
| `cust_pricing` | dw_pricing_report |
| `cust_pricing_auto_email` | NULL |
| `custom_part_history` | — |
| `custom_trial_balance_dw` | — |
| `customer_credit_history_dw` | NULL |
| `customer_invoice_recap` | — |
| `customer_invoice_recap_custom1` | 0 |
| `customer_invoice_recap_custom2` | 0 |
| `customer_order_dw` | — |
| `daily_statistics_dw` | dw_statistic_daily |
| `days_ship_to_invoice` | — |
| `do_13_periods` | N |
| `dollars_shipped_report` | — |
| `extend_quote_listing_decimal` | N |
| `inv_comm_codes_exclude` | — |
| `inv_comm_custs_include` | — |
| `inv_comm_prc_exclude` | — |
| `inv_part_prices` | — |
| `invoice_commission_percent` | 0 |
| `invoice_commission_report` | dw_inv_commissions_r |
| `invoice_list_with_notes_dw` | — |
| `invoice_recap_dw` | — |
| `invoice_sales_report_codes` | &^X%A#@ |
| `invoice_sales_report_dw` | dw_invoice_report_date |
| `mrb_inhouse_dw` | — |
| `multi_order_ship` | — |
| `no_date_range` | — |
| `open_orders_report_dw` | — |
| `oper_back_pro_insp` | dw_oper_process_insp |
| `oper_prod_log_doc` | — |
| `oper_prod_log_rev` | — |
| `order_formal_spec_dw` | — |
| `order_ship_days` | dw_order_ship_days_re |
| `order_ship_days_ex_weekends` | N |
| `part_billing_summary` | — |
| `part_history_pcode_exclude` | — |
| `part_list_by_date_dw` | — |
| `part_list_report` | — |
| `part_price_group1_name` | e.g., Heat Treat |
| `part_price_group1_pcodes` | list of process codes |
| `part_price_group1_UOM` | UOM for group 1 |
| `part_price_group2_name` | e.g., Plating |
| `part_price_group2_pcodes` | list of process codes |
| `part_price_group2_UOM` | UOM for group 2 |
| `part_price_group3_name` | e.g., Sorting |
| `part_price_group3_pcodes` | list of process codes |
| `part_price_group3_UOM` | UOM for group 3 |
| `part_price_price_break_point` | e.g., 250000 |
| `past_due_invoices` | — |
| `payment_report` | — |
| `popup_defaults_to_detail` | N |
| `process_step_listing_window` | — |
| `prod_recpt_log` | — |
| `promise_date_promise_only` | N |
| `promise_date_sortby` | Y |
| `quote_conversion_dw` | — |
| `quote_list_price_format` | [general] |
| `receiving_report_timer` | 120 |
| `Sales Commission Report DW` | — |
| `sales_and_credits` | — |
| `sales_and_credits_by_equipment` | — |
| `sales_backlog_dollars` | — |
| `sales_by_cust_dw` | — |
| `sales_by_cust_process` | dw_sales_by_cust_proc |
| `sales_by_day_detail` | — |
| `sales_by_day_ytd` | — |
| `sales_by_equip_peen` | N |
| `sales_by_salesman` | — |
| `sales_by_salesman_cust` | — |
| `sales_by_shp_date_dw` | dw_sales_by_ship_date |
| `sales_comm_gl_exclude` | — |
| `sales_equip_order_dw` | — |
| `sales_overview_ex_paytypes` | — |
| `sales_part_prices` | — |
| `sales_projections_gl` | — |
| `sales_state_cust` | — |
| `sales_top50_dw` | — |
| `sales_top50_gl` | — |
| `sales_variance_thisyear` | N |
| `ship_by_date_dw` | — |
| `ship_by_partid_dw` | — |
| `ship_by_route_all_dw` | d_ship_by_route_all |
| `ship_rpt_by_customer_datetime` | — |
| `ship_rpt_by_route_all_datetime` | — |
| `ShipByCustomer_sum` | Y |
| `ShipByCustomer_type` | — |
| `shipper_from_order` | — |
| `shipping_track_timer` | 120 |
| `spc_data_pull_excel` | dw_oper_spc_data_pull |
| `summary_over_x_days` | — |
| `table_key_headings` | N |
| `top_custs_active_only` | Y |
| `track_complete_report` | — |
| `tracking_area_rpt` | — |
| `tracking_backlog` | — |
| `tracking_profit` | — |
| `trial_balance_buckets` | — |
| `trial_balance_dw` | dw_ar_summary_aged_ |
| `turnaround_vs_target` | — |
| `wip_includes_partials` | Y |
| `wip_report_dw` | — |
| `wip_thru_shipped_locked` | S |


### A.71 `[rfid]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `areafilter` | — |


### A.72 `[SaleOrders]` — 34 keys

| Key name | Default / documented value |
|---|---|
| `after_containers_moveto` | — |
| `after_part_entry` | M |
| `after_partselect_moveto` | — |
| `allow_conts_no_qty` | N |
| `allow_parts_no_process` | Y |
| `AlwaysUse_PartShipto` | NULL |
| `custom_print` | — |
| `def_part_description` | — |
| `default_container` | — |
| `default_container_rows` | 2 |
| `first_part_maint_tab_name` | NULL |
| `hide_container_dw` | N |
| `hide_serial_dw` | N |
| `import_error_file_dir` | — |
| `import_file_type` | — |
| `import_skips_dupe_parts` | N |
| `import_skips_hot_jobs` | N |
| `initial_carrier` | — |
| `initial_customer_number` | — |
| `log_import_activity` | NULL |
| `match_inspection_code` | — |
| `new_customer_selection` | NULL |
| `no_move_part_desc` | N |
| `no_move_part_material` | N |
| `part_comment_equals` | — |
| `part_price_message` | N |
| `print_chkbx_container` | N |
| `print_chkbx_label` | N |
| `print_chkbx_order` | Y |
| `print_chkbx_other` | N |
| `use_simple_container_entry` | — |
| `use_simple_order_entry` | — |
| `use_simple_part_entry` | — |
| `use_simple_serial_entry` | — |


### A.73 `[Sales]` — 3 keys

| Key name | Default / documented value |
|---|---|
| `group_exclude` | — |
| `Insert_GL_Numbers` | — |
| `Starting_month` | — |


### A.74 `[Schedule]` — 20 keys

| Key name | Default / documented value |
|---|---|
| `add_delete_logged` | N |
| `auto_splitload` | N |
| `by_operator` | N |
| `calculate_schedule` | N |
| `change_request_date` | N |
| `chgdte_use_target` | N |
| `dw_multirow_selection` | N |
| `eq_report_datawindow` | — |
| `filter_checked` | N |
| `flagdone` | N |
| `next_step_only` | N |
| `open_from_display` | Y |
| `open_orders_by` | — |
| `pos_eq` | — |
| `pre_eq` | — |
| `pro_eq` | — |
| `S_Holland_display` | N |
| `schedule_report` | — |
| `schedule_time_only` | N |
| `VSschedule` | N |


### A.75 `[Sections: Equipment and Equipment_schedule]` — 7 keys

| Key name | Default / documented value |
|---|---|
| `days_over` | 0 |
| `eq_sched_fullscreen` | 30 |
| `percent_over` | 0 |
| `percent_under` | 0 |
| `plating_costs` | YN |
| `schedule_type` | — |
| `show_retrieval_time` | N |


### A.76 `[Sections: Location and ls_location]` — 8 keys

| Key name | Default / documented value |
|---|---|
| `as_Key` | String(al_defalut_Value |
| `DataBase` | — |
| `Dbparm` | — |
| `Location_type` | P |
| `LogID` | — |
| `LogPass` | — |
| `plant_list` | — |
| `ServerName` | — |


### A.77 `[Security]` — 22 keys

| Key name | Default / documented value |
|---|---|
| `auto_assign_operator_ids` | N |
| `close_button` | Y |
| `default_password` | 124 lkasdfjea2# |
| `ini_new_security` | — |
| `lock_attempts` | 0 |
| `lock_out_startup` | 0 |
| `min_characters` | 0 |
| `min_lower` | 0 |
| `min_month` | 0 |
| `min_number` | 0 |
| `min_symbol` | 0 |
| `min_upper` | 0 |
| `new_password_days` | 0 |
| `new_security` | — |
| `oper_change_pw` | — |
| `orderdatereminder` | — |
| `password_change_days` | — |
| `starting_op_id` | — |
| `sys_expire_date` | — |
| `sys_warn_date` | — |
| `temp_pw` | — |
| `Temporary_Allowed` | Y |


### A.78 `[Shipping]` — 188 keys

| Key name | Default / documented value |
|---|---|
| `address_change_dw` | — |
| `All_loads_not_ready_warning` | NULL |
| `allow_ups` | — |
| `always_create_cert` | N |
| `always_create_file` | N |
| `always_ship_complete` | N |
| `always_use_multi_shipper` | N |
| `auto_complete_disable` | N |
| `auto_create_cod_invoices` | N |
| `auto_display_custship_note` | N |
| `auto_display_notes` | N |
| `auto_display_part_notes` | N |
| `auto_override` | — |
| `auto_print_cert` | — |
| `auto_print_cert_mos` | N |
| `auto_print_process_cert` | N |
| `auto_show_cust_notes` | N |
| `autoship_ifscanned` | N |
| `avail_list_show_all` | N |
| `avail_order_dw_name` | — |
| `avail_order_list` | N |
| `balance_by_order` | N |
| `Barcode` | — |
| `batch_shipping` | N |
| `button_order` | — |
| `calculate_avail_to_ship` | N |
| `Calculate_lbs_from_qty` | N |
| `cert_by_process` | — |
| `certprint_req_b4_shipping` | N |
| `certs_use_load1_steps` | N |
| `Check4Active_po_dupes` | Y |
| `check_mos_po` | N |
| `close_outside_pos` | N |
| `cod_check` | N |
| `complete_without_shipping` | N |
| `cont_gross_tare` | N |
| `container_qty` | N |
| `Copies` | — |
| `copies_by_primary_gr` | — |
| `copy1_text` | — |
| `copy2_text` | — |
| `copy3_text` | — |
| `CopyAccRej_2_shipper_cert` | N |
| `courier_information` | N |
| `create_shipper_cert_steps` | N |
| `create_shipper_file` | N |
| `create_shipper_file_csv` | N |
| `credit_limit_message` | N |
| `cust_ship_label` | N |
| `Customer_controled_mos` | Y |
| `delete_delivered_shipper` | N |
| `delete_shippers` | N |
| `Disable_shipdate_entry` | N |
| `email_liability_file` | N |
| `email_multi_order_form` | — |
| `email_multi_shipper` | N |
| `email_never_shows_list` | N |
| `email_one_part_form` | — |
| `email_tc_file` | N |
| `enter_cert_qty` | N |
| `enter_cert_results` | — |
| `faa_form_certificate` | S2UR808J |
| `faa_form_certificate_nsn` | NSN: 0052-00-012-900 |
| `faa_form_certificate_omb` | OMB Control No. 2120- |
| `faa_form_certificate_omb_date` | 12/31/2010 |
| `fedex_serial` | — |
| `flag_reverse_shippers` | N |
| `force_carrier_input` | N |
| `force_view_notes` | N |
| `form_number` | — |
| `hide_cert_print_window` | NULL |
| `hide_override` | N |
| `hide_shipped_parts_checked` | N |
| `insp_result_type` | — |
| `inspection_chemp_bypass` | — |
| `inspection_min_count` | N |
| `inspection_min_count_cust` | N |
| `inspection_result_type` | NULL |
| `kanban_avail_order_list` | Y |
| `kanban_mos` | N |
| `kanban_multi_order_form` | — |
| `kanban_part_only_once` | Y |
| `kanban_ship_form` | — |
| `kanban_shippers` | N |
| `kanban_stop_overship` | N |
| `keep_shipping_date` | N |
| `Label` | — |
| `label_copies` | — |
| `label_form` | — |
| `label_form_barcode` | — |
| `label_number` | QF-069 Rev A |
| `label_papersource` | — |
| `label_printer` | — |
| `misc_export_file_location` | — |
| `misc_export_file_type` | — |
| `mos_by_addr` | N |
| `mos_by_po` | N |
| `mos_by_station` | N |
| `mos_checked` | N |
| `mos_disable_checkbox` | N |
| `mos_form_no` | — |
| `mos_form_sort` | — |
| `mos_print_button` | N |
| `mos_print_select` | N |
| `mos_selection_default` | A |
| `multi_order_form` | — |
| `multiorder_label_form` | — |
| `no_partial_load_flag` | N |
| `one_part_form` | — |
| `operator_complete_disable` | N |
| `part_comment_tab` | N |
| `part_comment_view_required` | N |
| `part_datawindow` | — |
| `part_gross_tare` | N |
| `part_pictures` | N |
| `part_price_message` | N |
| `part_view_tab` | N |
| `part_weight_required` | N |
| `part_weights_from_cont` | N |
| `partcomplete_undership_msg` | N |
| `pastdue_reason_required` | N |
| `pcs_cont_part_override` | NULL |
| `pod_uses_pic_print` | N |
| `prevent_orders_wo_po` | N |
| `prevent_past_due_days` | 0 |
| `prevent_past_due_dollars` | 0 |
| `prevent_past_due_months` | 0 |
| `prevent_when_past_due` | N |
| `print_cc_label` | N |
| `print_checkbox_false` | N |
| `print_container_labels` | N |
| `Print_Fax` | P |
| `print_label_per_container` | N |
| `print_liability_file` | N |
| `print_mos_label` | N |
| `print_mos_on_exit` | Y |
| `print_partial_shipment_certs` | Y |
| `print_shipper_seq` | N |
| `print_shop_order` | N |
| `prompt_for_part_cert` | N |
| `protect_ship_address` | N |
| `remove_trailing_blanks` | N |
| `Reprint_Copies` | {number of copies} |
| `reset_print_checkboxes` | NULL |
| `serial_as_container_id` | N |
| `serials_only_once` | N |
| `set_container_weights` | N |
| `ship_all_parts` | N |
| `ship_all_serials` | — |
| `ship_avail_to_ship` | N |
| `ship_containers` | — |
| `ship_silver_wt` | N |
| `ship_zero_qty` | N |
| `shiplabel_when_using_mos` | N |
| `shipper_certs_by_part` | N |
| `shipper_file_delimiter` | — |
| `shipper_file_mapping` | — |
| `shipper_file_name_format` | — |
| `shipper_form_no` | — |
| `shipper_serial_dw` | — |
| `shipper_top_dw` | — |
| `shipping_label_qty_print` | 0 |
| `shipto_updates_carrier` | N |
| `short_ship_msg` | N |
| `show_creditstatus_msg` | N |
| `show_hide_list` | N |
| `show_multi_shipper_email_list` | N |
| `show_part_only_once` | N |
| `show_reversed_shippers` | Y |
| `show_total_mos_wt` | N |
| `signature_certformat` | — |
| `signature_from_cert_control` | N |
| `skip_overall_wt_test` | N |
| `stop_overship` | N |
| `tc_shipping_disable` | N |
| `tc_shipping_type` | — |
| `tracking_containers` | N |
| `update_plant_at_shipping` | N |
| `ups_serial` | — |
| `ups_serial5` | — |
| `use_finish_pricing` | N |
| `use_min_count_insp_req` | N |
| `use_new_error_checks` | Y |
| `use_tablet_shipping` | N |
| `view_cod_invoices` | N |
| `zero_cert_qty` | N |
| `zero_ship_now` | N |
| `zetafax_test` | N |


### A.79 `[specification]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `datawindow` | — |


### A.80 `[sqlca]` — 16 keys

| Key name | Default / documented value |
|---|---|
| `DataBase` | — |
| `databases` | — |
| `DBMS` | — |
| `DbParm` | — |
| `DBtrace` | — |
| `demo_menu` | N |
| `FailoverPartner` | — |
| `log_directory` | — |
| `LogID` | — |
| `LogPass` | — |
| `menu` | — |
| `menu_timer` | — |
| `ServerName` | — |
| `servers` | — |
| `vsfilelogin` | — |
| `vsloginlocation` | — |


### A.81 `[sqlca_fpmtrklog]` — 6 keys

| Key name | Default / documented value |
|---|---|
| `DataBase` | — |
| `DBMS` | — |
| `Dbparm` | — |
| `LogID` | — |
| `LogPass` | — |
| `ServerName` | — |


### A.82 `[SSI_charts]` — 9 keys

| Key name | Default / documented value |
|---|---|
| `COMMPATH` | — |
| `COMPRESSPATH` | — |
| `CONFIGPATH` | — |
| `DATABASEPATH` | — |
| `DLOGPATH` | — |
| `maxvalues` | N |
| `RTMPATH` | — |
| `ssi_combridge` | — |
| `TRENDPATH` | — |


### A.83 `[standardsteps]` — 7 keys

| Key name | Default / documented value |
|---|---|
| `always_update_searchtext` | N |
| `doubleclick_ml_entry` | N |
| `operator_notes` | N |
| `orderreport_dw` | — |
| `search_dw` | — |
| `show_translate` | N |
| `Source Directory` | — |


### A.84 `[table_keys]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `table_name_entry` | Y |


### A.85 `[TeamTrack]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `TeamLogDw` | — |
| `TeamTrackingType` | — |


### A.86 `[Tracking]` — 82 keys

| Key name | Default / documented value |
|---|---|
| `"CommandButton"+string(lp` | — |
| `area_security` | N |
| `Barcode` | — |
| `bypass_failure_reason` | N |
| `cc_exclude` | — |
| `custom_tracking_prompts` | NULL |
| `customtab_user_dw` | dw_uo_part_maint_user |
| `display_user_tab` | N |
| `eq_cycle` | Y |
| `eq_exclude` | — |
| `eq_sched_time_interval` | 4 |
| `exitpassword` | — |
| `Final Inspection Label` | dw_final_inspec_label_ |
| `final_inspect_not_allowed` | N |
| `fixtrack_load_by_part` | — |
| `gaptime` | N |
| `gr_exclude` | — |
| `load_tracking_info` | N |
| `loadsplit_in_ordertracking` | Y |
| `log_trackarea` | N |
| `maintenance_type` | New |
| `manual_serial` | — |
| `MenuWindowPicture` | — |
| `moveto_scheduling` | N |
| `MRB` | N |
| `no_final_inspect` | N |
| `nonsched_eq_autotrackout` | N |
| `nonsched_eq_autotrackout1` | N |
| `notrack_tracking_types` | No Track |
| `ohio_debug` | N |
| `ordercode_not_required` | N |
| `part_display` | N |
| `print_labels` | N |
| `quantity_log` | N |
| `setup_type` | — |
| `show_pdf_list` | Y |
| `show_timer_message` | N |
| `Touchscreen` | — |
| `track_unscheduled` | N |
| `track_unscheduled_timer` | 30 |
| `trackin_tracking_types` | Track In |
| `Tracking_type` | — |
| `user_defined_1` | — |
| `user_defined_3` | — |
| `valmont_no_area_required` | N |
| `valmont_qty_weighted` | N |
| `valmont_trk_show_insp_value` | N |
| `valmont_trk_show_lot_location` | NULL |
| `verify_area` | Y |
| `VS_ats_entry` | N |
| `VS_auto_display_notes` | N |
| `VS_Custom_Schedule` | — |
| `VS_hide_area_cancel_button` | N |
| `VS_overtrack_allowed` | N |
| `VS_Scheduled_Area_Only` | N |
| `VT_all_stepinsp_require_entry` | NULL |
| `VT_area_filter` | — |
| `VT_ask_before_autotrackout` | N |
| `VT_ats_copies` | 1 |
| `VT_ats_entry` | N |
| `VT_ats_type` | — |
| `VT_custom_insp_type` | — |
| `VT_custom_track_type` | — |
| `VT_Disable_Batch_Tracking` | N |
| `VT_fpm_custom_tracklog` | N |
| `VT_gaptime_operator_comments` | N |
| `VT_idle_timer` | 600 |
| `VT_mre_without_entries` | N |
| `VT_no_final_inspect` | N |
| `VT_OK_after_orderscan` | N |
| `VT_op_autolog_off` | Y |
| `VT_overtrack_allowed` | N |
| `VT_scantracktype_change2area` | — |
| `VT_schedule_dw` | NULL |
| `VT_Schedule_select` | N |
| `VT_shipping_label_form` | — |
| `VT_showautotrackout` | N |
| `VT_Split_load_Option` | TCMP |
| `VT_template_controls_split_msg` | N |
| `VT_trackout_selection_default` | Y |
| `VT_validate_container_id` | — |
| `weight_already_entered_msg` | N |


### A.87 `[tracking_maintenance]` — 5 keys

| Key name | Default / documented value |
|---|---|
| `addinsert_allloads` | N |
| `FinalInspectRequired` | N |
| `reprint_on_stepchange` | Y |
| `scheddel_on_steprenumber` | N |
| `use_standard_order_label` | N |


### A.88 `[TrackingTemplate]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `use_custom_signoff` | N |


### A.89 `[Translator]` — 2 keys

| Key name | Default / documented value |
|---|---|
| `active` | N |
| `language` | — |


### A.90 `[Visual Net]` — 9 keys

| Key name | Default / documented value |
|---|---|
| `copy_material` | Y or N |
| `copy_part_data` | Y or N |
| `copy_spec` | Y or N |
| `new_quote_request` | Y or N |
| `pickup_pop_up` | Y or N |
| `po_pop_up` | Y or N |
| `Quote_pop_up` | Y or N |
| `show_email_addr` | Y or N |
| `vs_pickup_request_dw` | dw_vn_pickup_request |


### A.91 `[Visual_Archive]` — 11 keys

| Key name | Default / documented value |
|---|---|
| `active` | N |
| `DataBase` | — |
| `DBMS` | — |
| `DbParm` | — |
| `LogID` | — |
| `ServerName` | — |
| `skip_certifications` | N |
| `skip_invoices` | N |
| `skip_quotations` | N |
| `skip_shippers` | N |
| `Username` | — |


### A.92 `[VisualTruck]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `ExcludeRoutes` | — |


### A.93 `[working directory]` — 1 keys

| Key name | Default / documented value |
|---|---|
| `working_directory` | — |


---

## Appendix B — Complete source index

Every folder and article harvested, in the vendor's own hierarchy, so any statement in this report can be traced to its source. **35 folders, 254 articles.** Article URLs follow the pattern `https://support.visualshop.com/support/solutions/articles/<id>`.



### B.1 Quick Procedures — 2 articles

- **Quick Procedures** — `/articles/36000071355-quick-procedures`
- **Keyboard shortcuts hot keys** — `/articles/36000339380-keyboard-shortcuts-hot-keys`


### B.2 Setup and Implementation — 2 articles

- **Implementation Tasks** — `/articles/36000235940-implementation-tasks`
- **Download Instructions** — `/articles/36000580048-download-instructions`


### B.3 New User Training — 1 articles

- **New User Training** — `/articles/36000135284-new-user-training`


### B.4 Dashboard Overview — 1 articles

- **Dashboard Setup and Reports available** — `/articles/36000103593-dashboard-setup-and-reports-available`


### B.5 Order Entry Module — 16 articles

- **Order Entry List** — `/articles/36000103592-order-entry-list`
- **Available Order Top Windows for Order Entry** — `/articles/36000080261-available-order-top-windows-for-order-entry`
- **Order Part Detail Pop-Up Window Examples** — `/articles/36000079948-order-part-detail-pop-up-window-examples`
- **Order Notes - The Yellow Push Pin Icon** — `/articles/36000080247-order-notes-the-yellow-push-pin-icon`
- **Request and Target date fields in Order Entry** — `/articles/36000079949-request-and-target-date-fields-in-order-entry`
- **Order Level Charges** — `/articles/36000071065-order-level-charges`
- **Order acknowledgement and Order notifications** — `/articles/36000079945-order-acknowledgement-and-order-notifications`
- **Adding Part Pictures in Order Entry** — `/articles/36000077094-adding-part-pictures-in-order-entry-`
- **Auto Entry Serial Numbers** — `/articles/36000079944-auto-entry-serial-numbers`
- **Contract Review Option in Order Entry** — `/articles/36000276201-contract-review-option-in-order-entry`
- **Contract Review Option in Order Entry (New)** — `/articles/36000101241-contract-review-option-in-order-entry-new-`
- **Outside Processing Overview** — `/articles/36000276264-outside-processing-overview-`
- **Outside Processing Overview (New** — `/articles/36000105860-outside-processing-overview-new`
- **Digital Order Approval Module** — `/articles/36000108313-digital-order-approval-module`
- **Load Splitting Module** — `/articles/36000227103-load-splitting-module`
- **NEW CONTRACT REVIEW** — `/articles/36000527699-new-contract-review`


### B.6 Sales Order Entry — 6 articles

- **Sales Order Entry Overview** — `/articles/36000105863-sales-order-entry-overview`
- **Deleting Sales Order Entries** — `/articles/36000105909-deleting-sales-order-entries`
- **Custom Sales Order Import - First Option** — `/articles/36000105908-custom-sales-order-import-first-option`
- **Custom Sales Order Import - Second Option** — `/articles/36000105910-custom-sales-order-import-second-option`
- **Receive Parts** — `/articles/36000177732-receive-parts`
- **Sales Order Entry - Assigning Multiple Processes Per Part** — `/articles/36000194035-sales-order-entry-assigning-multiple-processes-per-part`


### B.7 Order Management — 2 articles

- **Scheduling in Order Management** — `/articles/36000149991-scheduling-in-order-management`
- **Order Management** — `/articles/36000275389-order-management`


### B.8 Quick Track — 2 articles

- **Quick Track Overview** — `/articles/36000105929-quick-track-overview`
- **Inspect Button in Quick Track** — `/articles/36000106172-inspect-button-in-quick-track`


### B.9 Certifications — 8 articles

- **Certifications Overview (Old)** — `/articles/36000276199-certifications-overview-old-`
- **Certifications Overview** — `/articles/36000108539-certifications-overview`
- **General information for the Certification module and Cert Control Column in Plant Support** — `/articles/36000108541-general-information-for-the-certification-module-and-cert-control-column-in-plant-support`
- **Certification Charges** — `/articles/36000108544-certification-charges-`
- **Certification by Process** — `/articles/36000108543-certification-by-process`
- **Signature on Certifications** — `/articles/36000108542-signature-on-certifications`
- **Word Inserts for use with Free Form Text in Certifications** — `/articles/36000086693-word-inserts-for-use-with-free-form-text-in-certifications`
- **Customer Control Certification Requirements and overrides** — `/articles/36000108569-customer-control-certification-requirements-and-overrides-`


### B.10 Shipping Module — 8 articles

- **Shipping Module Overview** — `/articles/36000109044-shipping-module-overview`
- **Single Order Shipping** — `/articles/36000109060-single-order-shipping`
- **Multi Order Shippers** — `/articles/36000097118-multi-order-shippers`
- **Reprinting Shippers** — `/articles/36000106064-reprinting-shippers`
- **Stop Shipment options** — `/articles/36000103259-stop-shipment-options`
- **SHIPPING NOTIFICATIONS** — `/articles/36000112834-shipping-notifications`
- **Topaz Signature Pad** — `/articles/36000149381-topaz-signature-pad`
- **Kanban Shipping** — `/articles/36000235640-kanban-shipping`


### B.11 Process Master Module — 5 articles

- **New Process Master Module** — `/articles/36000103544-new-process-master-module`
- **Original Process Master Window (Old)** — `/articles/36000276200-original-process-master-window-old-`
- **Original Process Master Window (New)** — `/articles/36000103568-original-process-master-window-new-`
- **Create Standard Steps** — `/articles/36000179954-create-standard-steps`
- **Process Master Types: Generic, Part Assembly, Order Assembly** — `/articles/36000269750-process-master-types-generic-part-assembly-order-assembly`


### B.12 Part Maintenance — 10 articles

- **Part Maintenance Overview** — `/articles/36000086746-part-maintenance-overview`
- **Part Maintenance list view** — `/articles/36000106249-part-maintenance-list-view`
- **Marking Parts as Inactive, or, Deleting Parts** — `/articles/36000100817-marking-parts-as-inactive-or-deleting-parts`
- **Part Notes - Creating and Displaying** — `/articles/36000080257-part-notes-creating-and-displaying-`
- **Custom Part Tab in Part Maintenance (Old)** — `/articles/36000276275-custom-part-tab-in-part-maintenance-old-`
- **Custom Part Tab in Part Maintenance (New)** — `/articles/36000112408-custom-part-tab-in-part-maintenance-new-`
- **Step Overlays** — `/articles/36000185057-step-overlays`
- **Quotations in Part Maintenance** — `/articles/36000200570-quotations-in-part-maintenance`
- **PART MAINTENANCE PRICE CHANGE** — `/articles/36000234452-part-maintenance-price-change`
- **Automatically set Parts, Processes, and Customers to Inactive after X days** — `/articles/36000343014-automatically-set-parts-processes-and-customers-to-inactive-after-x-days`


### B.13 A/R — 17 articles

- **A/R and Invoicing Exports for Accounting Software** — `/articles/36000081826-a-r-and-invoicing-exports-for-accounting-software`
- **A/R Batch Entry (Old)** — `/articles/36000276277-a-r-batch-entry-old-`
- **A/R Batch Entry (New)** — `/articles/36000109272-a-r-batch-entry-new-`
- **Applying Payments and closing the Batch** — `/articles/36000100835-applying-payments-and-closing-the-batch`
- **Applying Credits** — `/articles/36000100824-applying-credits`
- **Finance Charge Section of A/R** — `/articles/36000109293-finance-charge-section-of-a-r`
- **Aging / Summaries - AR Report information and screen shots** — `/articles/36000109295-aging-summaries-ar-report-information-and-screen-shots`
- **Preliminary Closing Report** — `/articles/36000109518-preliminary-closing-report`
- **Statements** — `/articles/36000109538-statements`
- **A/R > Payment Report** — `/articles/36000109546-a-r-payment-report-`
- **A/R > Monthly sub-folder** — `/articles/36000109548-a-r-monthly-sub-folder`
- **CREDIT / ON ACCOUNT REPORT** — `/articles/36000109549-credit-on-account-report`
- **Posting Payments** — `/articles/36000109555-posting-payments`
- **A/R > Balancing AR sub-folder** — `/articles/36000109565-a-r-balancing-ar-sub-folder`
- **End of the Month Procedure - Close A/R** — `/articles/36000109532-end-of-the-month-procedure-close-a-r`
- **AR Utilities** — `/articles/36000109566-ar-utilities`
- **General Ledger Interface and Program Defaults you may need.** — `/articles/36000168425-general-ledger-interface-and-program-defaults-you-may-need-`


### B.14 Reports — 8 articles

- **Shipping Reports Overview** — `/articles/36000086694-shipping-reports-overview`
- **Pricing Reports** — `/articles/36000101261-pricing-reports-`
- **Operations Report** — `/articles/36000071067-operations-report`
- **Billing Reports** — `/articles/36000103073-billing-reports-`
- **Sales Reports** — `/articles/36000103142-sales-reports`
- **Process Report** — `/articles/36000104431-process-report`
- **Customer Activity Reports** — `/articles/36000104432-customer-activity-reports-`
- **Tracking Reports** — `/articles/36000104652-tracking-reports`


### B.15 Customer Maintenance Module — 4 articles

- **Customer Notes - Creating and Displaying the notes** — `/articles/36000080249-customer-notes-creating-and-displaying-the-notes`
- **Marking Customers as inactive or, Deleting Customers** — `/articles/36000100818-marking-customers-as-inactive-or-deleting-customers`
- **Parent Customer** — `/articles/36000104027-parent-customer`
- **ADDING CUSTOMER ADDRESSES** — `/articles/36000126004-adding-customer-addresses-`


### B.16 Viewing Forms — 22 articles

- **Visual Shop Forms and Logos** — `/articles/36000095539-visual-shop-forms-and-logos`
- **Quote Forms Table with Key Values and Details** — `/articles/36000095552-quote-forms-table-with-key-values-and-details`
- **Quote Forms -Billing Quotation quote forms - Screen Shots** — `/articles/36000106436-quote-forms-billing-quotation-quote-forms-screen-shots`
- **Quote Forms Part Maintenance quote forms - Screen Shots** — `/articles/36000106332-quote-forms-part-maintenance-quote-forms-screen-shots-`
- **Quote Forms Multi-Part Quote forms - Screen Shots** — `/articles/36000105228-quote-forms-multi-part-quote-forms-screen-shots-`
- **Certification forms Table with Key Values and Details** — `/articles/36000095545-certification-forms-table-with-key-values-and-details`
- **Certification Forms - Screen Shots** — `/articles/36000105056-certification-forms-screen-shots`
- **Label forms with Key Values and Details** — `/articles/36000095688-label-forms-with-key-values-and-details`
- **Order Label Form Screen Shots** — `/articles/36000107117-order-label-form-screen-shots`
- **Container Label Form Screen Shots** — `/articles/36000106507-container-label-form-screen-shots`
- **Shipping Label Screen Shots** — `/articles/36000106509-shipping-label-screen-shots`
- **Shipping Forms Table with Key Values and Details** — `/articles/36000095576-shipping-forms-table-with-key-values-and-details`
- **Shipping Forms -One Part Forms - Screen Shots** — `/articles/36000102938-shipping-forms-one-part-forms-screen-shots`
- **Multi-Order Shipper Forms- Screen Shots** — `/articles/36000102941-multi-order-shipper-forms-screen-shots`
- **Invoice forms- Table with Key Values and Details** — `/articles/36000095544-invoice-forms-table-with-key-values-and-details`
- **Invoice Forms - Screen shots** — `/articles/36000101019-invoice-forms-screen-shots-`
- **Miscellaneous forms Table with Key Values and Details** — `/articles/36000095687-miscellaneous-forms-table-with-key-values-and-details`
- **Miscellaneous forms Purchase Order Forms with Screen Shots** — `/articles/36000106745-miscellaneous-forms-purchase-order-forms-with-screen-shots`
- **Miscellaneous forms A/R Statement Forms with Screen Shots** — `/articles/36000106718-miscellaneous-forms-a-r-statement-forms-with-screen-shots`
- **Miscellaneous forms Bill of Lading form screen shots** — `/articles/36000106744-miscellaneous-forms-bill-of-lading-form-screen-shots`
- **Miscellaneous forms Outside Processing Forms with Screen Shots** — `/articles/36000106746-miscellaneous-forms-outside-processing-forms-with-screen-shots`
- **Order Forms** — `/articles/36000095686-order-forms`


### B.17 Email Setup and Email Errors in Visual Shop — 6 articles

- **Email Setup for Visual Shop (Legacy SMTP)** — `/articles/36000085194-email-setup-for-visual-shop-legacy-smtp-`
- **PDF Printer Choices and Installation instructions** — `/articles/36000085199-pdf-printer-choices-and-installation-instructions`
- **Email Error Descriptions and Instructions on attaching the Emaillog.txt for Support** — `/articles/36000085201-email-error-descriptions-and-instructions-on-attaching-the-emaillog-txt-for-support-`
- **Mass Email Overview and Setup** — `/articles/36000108532-mass-email-overview-and-setup`
- **Visual Shop Email Configuration with Modern Authentication** — `/articles/36000579439-visual-shop-email-configuration-with-modern-authentication`
- **Visual Shop Emailing: Modern Authentication for Multi User Accounts** — `/articles/36000607590-visual-shop-emailing-modern-authentication-for-multi-user-accounts`


### B.18 CAR - Corrective Actions and Reworks — 2 articles

- **Corrective Action Rework - CAR** — `/articles/36000071051-corrective-action-rework-car-`
- **Part Reworks** — `/articles/36000071063-part-reworks`


### B.19 Invoicing — 6 articles

- **Creating Credits** — `/articles/36000101084-creating-credits-`
- **Fix Invoices - Option to fix several invoices at once.** — `/articles/36000097908-fix-invoices-option-to-fix-several-invoices-at-once-`
- **Fixing one invoice** — `/articles/36000097909-fixing-one-invoice`
- **Invoice by Shipper and also by PO.** — `/articles/36000168810-invoice-by-shipper-and-also-by-po-`
- **Multi-Order Invoicing - Adding or Removing Orders from an Invoice** — `/articles/36000106152-multi-order-invoicing-adding-or-removing-orders-from-an-invoice`
- **Surcharges and Addons** — `/articles/36000130150-surcharges-and-addons-`


### B.20 Customer Expediting — 2 articles

- **Customer Expediting Overview** — `/articles/36000098243-customer-expediting-overview`
- **Customer Communications Manager [CCM]** — `/articles/36000168427-customer-communications-manager-ccm-`


### B.21 Security — 3 articles

- **Setting up Security For a new Operator** — `/articles/36000098392-setting-up-security-for-a-new-operator`
- **Security Modules** — `/articles/36000098914-security-modules`
- **Updating Security Modules and Security Report** — `/articles/36000184410-updating-security-modules-and-security-report`


### B.22 New Workstations — 4 articles

- **uo_ole_photo error - modify Data Execution Prevention settings** — `/articles/36000195874-uo-ole-photo-error-modify-data-execution-prevention-settings`
- **New Workstation Installation Setup Instructions** — `/articles/36000105511-new-workstation-installation-setup-instructions`
- **Visual Shop Synchronizer setup** — `/articles/36000213762-visual-shop-synchronizer-setup`
- **Adding Barcode Fonts** — `/articles/36000076626-adding-barcode-fonts`


### B.23 Attachments — 1 articles

- **Attachment Options Throughout Visual Shop** — `/articles/36000079431-attachment-options-throughout-visual-shop`


### B.24 test — 1 articles

- **Connecting for Remote Support.** — `/articles/36000109096-connecting-for-remote-support-`


### B.25 Pricing — 2 articles

- **Pricing Hierarchy** — `/articles/36000113484-pricing-hierarchy`
- **Consolidated Pricing Window** — `/articles/36000210521-consolidated-pricing-window`


### B.26 Billing Quotations — 1 articles

- **Billing Quotations Overview** — `/articles/36000128508-billing-quotations-overview`


### B.27 Bar codes for scanning operators or other quick scans — 1 articles

- **Creating new Bar codes for Operators and other Areas within Visual Shop** — `/articles/36000167124-creating-new-bar-codes-for-operators-and-other-areas-within-visual-shop`


### B.28 Inventory Module — 1 articles

- **Inventory Overview** — `/articles/36000230017-inventory-overview`


### B.29 CRM Module — 1 articles

- **Customer Relationship Management Module** — `/articles/36000503247-customer-relationship-management-module`


### B.30 Hot List — 1 articles

- **Hot List Orders Module** — `/articles/36000526558-hot-list-orders-module`


### B.31 Scheduling — 1 articles

- **Flex Scheduling** — `/articles/36000586489-flex-scheduling`


### B.32 Setting up Program Defaults — 4 articles

- **Changing a Program Default** — `/articles/36000071737-changing-a-program-default`
- **Adding a Program Default** — `/articles/36000071738-adding-a-program-default`
- **Adding a new Section in Program Defaults** — `/articles/36000071739-adding-a-new-section-in-program-defaults`
- **Setting up Specific Station ID's and Station ID Defaults** — `/articles/36000071878-setting-up-specific-station-id-s-and-station-id-defaults`


### B.33 Program Defaults — 93 articles

- **Section: A/R (Old)** — `/articles/36000071673-section-a-r-old-`
- **Section: A/R (New)** — `/articles/36000277680-section-a-r-new-`
- **Section: Airportscreens** — `/articles/36000400197-section-airportscreens`
- **Section: Batch_shipping** — `/articles/36000071674-section-batch-shipping-`
- **Section: Bill_of_lading** — `/articles/36000071675-section-bill-of-lading`
- **Section: CanEng** — `/articles/36000071676-section-caneng`
- **Section: CAR** — `/articles/36000071677-section-car`
- **Section: ccm** — `/articles/36000071678-section-ccm`
- **Section: Certifications** — `/articles/36000071679-section-certifications`
- **Section: Corporate** — `/articles/36000071680-section-corporate`
- **Section: Costing** — `/articles/36000071681-section-costing`
- **Section: Customer** — `/articles/36000071682-section-customer-`
- **Section: Customer_Expediting** — `/articles/36000071683-section-customer-expediting`
- **Section: dashboard** — `/articles/36000071684-section-dashboard`
- **Section: defaults** — `/articles/36000071685-section-defaults`
- **Section: Email** — `/articles/36000071686-section-email`
- **Sections: Equipment and Equipment_schedule** — `/articles/36000071687-sections-equipment-and-equipment-schedule`
- **Section: Expediting** — `/articles/36000071688-section-expediting`
- **Order Management (Was Expediting)** — `/articles/36000281024-order-management-was-expediting-`
- **Section: Fix System** — `/articles/36000071689-section-fix-system`
- **Section: flag_shippers** — `/articles/36000071690-section-flag-shippers`
- **Section: Forms** — `/articles/36000071691-section-forms`
- **Section: FTP** — `/articles/36000071692-section-ftp`
- **Section: gm_corp** — `/articles/36000071693-section-gm-corp`
- **Section: help** — `/articles/36000071694-section-help`
- **Section: Holidays** — `/articles/36000071695--section-holidays`
- **Section: Menu** — `/articles/36000071696-section-menu`
- **Section: InspCode_Maint** — `/articles/36000071697-section-inspcode-maint`
- **Section: Inventory** — `/articles/36000071698-section-inventory`
- **Section: Invoicing** — `/articles/36000071699-section-invoicing`
- **Section: labelformat** — `/articles/36000071700-section-labelformat`
- **Section: license** — `/articles/36000071701-section-license`
- **Section: Load_Split** — `/articles/36000071702-section-load-split`
- **Sections: Location and ls_location** — `/articles/36000071703-sections-location-and-ls-location`
- **Section: manual inspect** — `/articles/36000071704-section-manual-inspect`
- **Section: mas90** — `/articles/36000071705-section-mas90`
- **Section: MOS_corrections** — `/articles/36000071706-section-mos-corrections`
- **Section: MPP_Tracking_Schedule** — `/articles/36000071707-section-mpp-tracking-schedule`
- **Section: MRE_inspect** — `/articles/36000071708-section-mre-inspect`
- **Section: notes** — `/articles/36000071709-section-notes`
- **Section: OPT** — `/articles/36000071710-section-opt`
- **Section: Order Charges** — `/articles/36000071711-section-order-charges`
- **Section: order label** — `/articles/36000071712-section-order-label`
- **Section: order printing** — `/articles/36000071713-section-order-printing`
- **Section: Order Search** — `/articles/36000071714-section-order-search`
- **Section: order status** — `/articles/36000071715-section-order-status`
- **Section: order_final_inspect** — `/articles/36000071716-section-order-final-inspect-`
- **Section: order_status_report** — `/articles/36000071717-section-order-status-report`
- **Section: order_label** — `/articles/36000071718-section-order-label`
- **Section: OrderProcess_Display** — `/articles/36000071719-section-orderprocess-display`
- **Section: Orders** — `/articles/36000071720-section-orders`
- **Section: other label** — `/articles/36000071721-section-other-label`
- **Section: outside_processing** — `/articles/36000071722-section-outside-processing`
- **Section: Packaging** — `/articles/36000071723-section-packaging`
- **Section: Part Quotes** — `/articles/36000071724-section-part-quotes`
- **Section: part_custom_window** — `/articles/36000071725-section-part-custom-window`
- **Section: part_pricing** — `/articles/36000071726-section-part-pricing-`
- **Section: parts** — `/articles/36000071727-section-parts`
- **Section: pht_tracking** — `/articles/36000071728-section-pht-tracking`
- **Section: Pickups** — `/articles/36000071729-section-pickups`
- **Section: picture** — `/articles/36000071730-section-picture`
- **Section: plant** — `/articles/36000071731-section-plant`
- **Section: PreOrder** — `/articles/36000071732-section-preorder`
- **Section: Pricing** — `/articles/36000071733-section-pricing`
- **Section: prime_maint** — `/articles/36000071734-section-prime-maint`
- **Section: printers** — `/articles/36000071735-section-printers`
- **Section: Process** — `/articles/36000071736-section-process`
- **Section: Process Codes** — `/articles/36000071741-section-process-codes`
- **Section: quick track** — `/articles/36000071742-section-quick-track`
- **Section: Quotations** — `/articles/36000071743-section-quotations`
- **Section: report_costing** — `/articles/36000071744-section-report-costing`
- **Section: Reports** — `/articles/36000071745-section-reports`
- **Section: rfid** — `/articles/36000071747-section-rfid`
- **Section: SaleOrders** — `/articles/36000071748-section-saleorders`
- **Section: Sales** — `/articles/36000071749-section-sales`
- **Section: Schedule** — `/articles/36000071750-section-schedule`
- **Section: Security** — `/articles/36000071751-section-security`
- **Section: Shipping** — `/articles/36000071752-section-shipping`
- **Section: specification** — `/articles/36000071753-section-specification`
- **Section: sqlca** — `/articles/36000071754-section-sqlca`
- **Section: sqlca_fpmtrklog** — `/articles/36000071755-section-sqlca-fpmtrklog-`
- **Section: SSI_charts** — `/articles/36000071756-section-ssi-charts`
- **Section: standardsteps** — `/articles/36000071757-section-standardsteps`
- **Section: table_keys** — `/articles/36000071758-section-table-keys`
- **Section: TeamTrack** — `/articles/36000071759-section-teamtrack`
- **Section: Tracking** — `/articles/36000071760-section-tracking`
- **Section: tracking_maintenance** — `/articles/36000071761-section-tracking-maintenance`
- **Section: TrackingTemplate** — `/articles/36000071762-section-trackingtemplate`
- **Section: Translator** — `/articles/36000071763-section-translator`
- **Section: Visual_Archive** — `/articles/36000071765-section-visual-archive`
- **Section: VisualTruck** — `/articles/36000071766-section-visualtruck`
- **Section: working directory** — `/articles/36000071767-section-working-directory`
- **Visual Net** — `/articles/36000482437-visual-net`


### B.34 Hardware / Server / Database — 8 articles

- **Hardware Requirements and Suggestions** — `/articles/36000146946-hardware-requirements-and-suggestions`
- **Server Migration Tasks and Guidelines** — `/articles/36000172959-server-migration-tasks-and-guidelines`
- **Microsoft SQL Server Express Installation** — `/articles/36000210663-microsoft-sql-server-express-installation`
- **Microsoft SQL Server Maintenance Plan Setup** — `/articles/36000210586-microsoft-sql-server-maintenance-plan-setup`
- **Opening Port 1433 for Microsoft SQL Server** — `/articles/36000205055-opening-port-1433-for-microsoft-sql-server`
- **SQLBackupAndFTP Setup** — `/articles/36000211388-sqlbackupandftp-setup`
- **Setting up a test database** — `/articles/36000216869-setting-up-a-test-database`
- **SQL Script for adding selected Program Defaults** — `/articles/36000278429-sql-script-for-adding-selected-program-defaults`


### B.35 Tools — 2 articles

- **Greenshot screenshot capture tool** — `/articles/36000201937-greenshot-screenshot-capture-tool`
- **PDFCreator PDF printer** — `/articles/36000206976-pdfcreator-pdf-printer`


---

## Appendix C — Coverage, method and limitations

**Method.** The knowledge-base home page was enumerated for every `/support/solutions/folders/<id>` link, yielding 49 folders. The 14 folders in the excluded categories were removed, leaving 35. Each folder page was paged through (the portal lists 10 articles per page) to enumerate 254 article ids, and each article was then retrieved and parsed, preserving heading levels, list nesting and table rows. Everything in Parts 0–XVII and Appendices A–B derives from that corpus; nothing was inferred from outside it except the design commentary, which is clearly marked as such ("Design takeaway", Part XVII, and the verdict paragraphs).

**Coverage.** All 254 in-scope articles were read in full, including the 22 *Viewing Forms* catalogue articles and all 93 *Program Defaults* section articles. The Program Defaults registry in Appendix A is complete at the key level (2,527 keys across 93 sections).

**Known limitations of the source material, not of the harvest:**

- **Screenshots carry information that text cannot.** A large share of these articles is composed of annotated screen captures — the ~1,100 form articles in particular are mostly "here is the key value, here is a picture of the output". Field-level layout differences between form variants are therefore visible in the source but not transcribable here. Where a form's *behaviour* is described in text, it is captured above.
- **Program Default descriptions vary in quality.** Some keys are documented with full semantics and interactions; a meaningful number carry only a name, or a note reading "(custom entry)", or a description that assumes knowledge of one customer's installation. Appendix A reproduces the documented value; where the vendor documents no value, the cell shows an em dash.
- **Duplicate and generational articles.** Several topics exist twice, as "(Old)" and current versions covering the legacy and new Plant Support / Process Master / Part Maintenance / Contract Review / Certifications screens. Both were read; this report describes both generations where they differ behaviourally, because both are in the field.
- **Undocumented interactions.** The documentation states many dependencies (`avail_list_show_all` needing `avail_order_list=Y`; `custom_insp_entry_type=FPM` needing `mre_inspection=Y`; `doaddon710` needing `zero_assembly_minqty`) but there is no dependency graph, and it is safe to assume more exist than are written down.
- **Version drift.** Behaviour is tied to build numbers in places (the Order Entry list requires a build above 3888; Modern Authentication requires 4327_1 or later). The knowledge base is a living document and describes the current build at time of writing rather than any single release.
- **Not covered by request:** the companion products (Visual Track and Visual Track 2.0 / Mobile, Visual Truck and Visual Truck Mobile, Visual Archive, Visual Capture, Visual Net, Visual Portal), the video/tutorial libraries, and the newsletter archive. Full shop-floor tracking therefore appears in this report only where core Visual Shop touches it — Quick Track as its manual substitute, tracking templates, load statuses, final inspection, and the tracking reports.

**One note on provenance.** Nothing resembling injected instructions, hidden directives or attempts to redirect this task was found anywhere in the 254 articles; the corpus is ordinary vendor documentation throughout.

---

*End of report. Compiled from 254 knowledge-base articles across 35 folders; 93 configuration sections and 2,527 configuration keys catalogued; ~1,100 form objects inventoried.*
