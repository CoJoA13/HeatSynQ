# HeatSynQ — Grounded Reference for the Implementation Spec

*Synthesized from five structured extractions of the reference prototype (`Visual Shop.dc.html` + `Visual Shop Redesign.dc.html`). Build context: Next.js full-stack (single on-prem server) + PostgreSQL (later) + app-managed auth; frontend-first on a typed mock data layer. **First slice = foundation (app shell, flat sidebar, command palette, design system) + Quote → Order → Invoice.***

> Faithfulness note: The prototype hardcodes every token as inline styles — there are **no CSS custom properties** in the source. The token set below is a derived consolidation intended for Tailwind/CSS, not a copy of existing variables. Where extractions conflict or are silent, it is called out explicitly.

---

## 1. Design tokens

### 1.1 Color palette

Two body-background variants exist: main file `#f6f7f9`, redesign `#eef0f4`. Recommend adopting **`#f6f7f9` as canvas** for the first slice (main prototype is the source of truth) and keeping `#eef0f4` as the nested-panel / muted-track tone.

#### Neutrals — surface & canvas
| Token | Hex | Usage |
|---|---|---|
| `canvas` | `#f6f7f9` | App body background (main) |
| `canvas-alt` | `#eef0f4` | Redesign body; muted progress-track / empty-bar fills |
| `surface` | `#ffffff` | Cards, panels, inputs, modals, KPI tiles, header (most frequent, 137 uses) |
| `surface-sidebar` | `#fbfbfd` | Sidebar `<aside>` (slightly off-white vs cards) |
| `surface-subtle` | `#f0f1f5` | Neutral pill bg, kbd-hint bg, inactive toggle |
| `surface-subtle-2` | `#f3f4f7` | Topbar search box bg |
| `surface-subtle-3` | `#f1f2f5` | Faint dividers / section-row bg |

#### Neutrals — text
| Token | Hex | Usage |
|---|---|---|
| `text` | `#1d2330` | Body text (set on body), headings |
| `text-heading-alt` | `#3a4151` | Secondary heading / strong label |
| `text-secondary` | `#5b637a` | Secondary body, sub-labels |
| `text-muted` | `#8a92a3` | Muted/caption, placeholders, timestamps (2nd most frequent, 135 uses) |
| `text-muted-2` | `#9aa1b0` | More muted; search placeholder, kbd text, micro-labels |
| `text-faint` | `#aab0bd` | Uppercase nav group headers |
| `text-nav-idle` | `#6b7280` | Idle nav item text; neutral pill text |

#### Neutrals — borders
| Token | Hex | Usage |
|---|---|---|
| `border` | `#e7e9ee` | Primary border/divider (cards, header bottom, sidebar right) |
| `border-alt` | `#e2e5ec` | Input borders, pill borders, secondary dividers |
| `border-faint` | `#f5f6f8` | Very faint internal row dividers |
| `border-medium` | `#cbd0db` | Stronger outline |
| `border-medium-alt` | `#d9dde5` | Timeline node ring / medium border |
| `scrollbar-thumb` | `#d6dae2` | Custom webkit scrollbar thumb |

#### Brand / primary (blue)
| Token | Hex | Usage |
|---|---|---|
| `primary` | `#3d63dd` | Logo, active nav text, links, progress fill, primary accents; "Sent"/"In Process" pill text |
| `primary-tint` | `#eef1fd` | Active nav bg; info pill bg |
| `primary-tint-2` | `#dfe4f6` | Avatar/icon chip bg paired with primary |
| `primary-tint-3` | `#d3dcfa` | Light blue accents/borders |
| `primary-dark` | `#2c4db0` | Hover/pressed |

#### Semantic — success / warn / danger
| Token | Hex | Usage |
|---|---|---|
| `success` | `#1f9d6b` | Positive pill text, positive deltas, status dots |
| `success-tint` | `#e8f5ef` | Success pill bg |
| `success-tint-alt` | `#cfeadd` | Completed timeline connector |
| `success-dark` | `#1b7a55` | Hover/strong |
| `warn` | `#c98a16` | Attention pill text, past-due text |
| `warn-tint` | `#fbf2e0` | Warn pill bg |
| `warn-tint-alt` | `#f1e3c7` | Warn accent line |
| `warn-tint-faint` | `#fdfaf2` | Very faint warn surface |
| `warn-dark` | `#946312` | Darker amber |
| `danger` | `#d4503e` | Danger pill text, error counts, focus ring base |
| `danger-tint` | `#fcebe8` | Danger pill bg |
| `danger-tint-alt` | `#f1d9d4` | Danger accent border |
| `danger-dark` | `#a33524` | Hover |

### 1.2 Typography

- **Sans (UI base):** `'IBM Plex Sans', system-ui, sans-serif` — weights 400/500/600/700. Base size **13px**. Set on body.
- **Mono (signature treatment):** `'IBM Plex Mono', monospace` — weights 400/500/600. Used for IDs (`WO-48211`), KPI numbers, timestamps, status pills, and uppercase nav/section labels. **This mono-for-data treatment is the brand signature — preserve it.**
- Fonts loaded from Google Fonts (Sans 400;500;600;700 + Mono 400;500;600).

| Role | Family | Weight | Size | Notes |
|---|---|---|---|---|
| Page title / greeting (H1) | Sans | 600 | 22px | letter-spacing −0.02em |
| Section title (H2) | Sans | 600 | 20px | letter-spacing −0.01em |
| Card/section heading | Sans | 600 | 14–19px | redesign heads 19px −0.01em |
| Hero title (redesign) | Sans | 600 | 34px | −0.02em, line-height 1.15 |
| KPI number | Mono | 600 | 26px | unit suffix 13px |
| Body default | Sans | 400/500 | 13px | nav/input text |
| Secondary body | Sans | 400 | 12.5px | sub-text |
| Caption / meta | Sans | 400 | 11px | KPI sub-labels, badges |
| Status pill text | Mono | 400 | 11px | all pills |
| Uppercase group label | Mono | 400 | 10.5px | nav .1em / table-header .06em, uppercase |
| Kbd hint (⌘K) | Mono | 400 | 11px | bg `#f0f1f5`, border `#e2e5ec`, radius 5px |
| Eyebrow (redesign) | Sans | 600 | 12px | .14em, color `#3d63dd`, bg `#eef1fd`, uppercase |

### 1.3 Radii
`5px` kbd chips/small badges · `6px` status pills, scrollbar · `7px` toggle segment, small tiles · `8px` logo tile, nav avatars · `9px` nav items, search input, buttons · `10px` topbar search, small cards · `13px` redesign cards · `16px` modals / large cards · `50%` circular avatars & status dots.

### 1.4 Shadows
- `0 1px 2px rgba(0,0,0,.08)` — active segmented-control button, subtle raise
- `0 0 0 3px rgba(212,80,62,.12)` — **danger** focus ring (use blue equivalent `rgba(61,99,221,.12)` for primary focus)
- `0 40px 90px -30px rgba(20,24,33,.6)` — modal/dialog elevation (main)
- `0 24px 60px …` — redesign large-card elevation

### 1.5 Spacing scale
`3, 4, 6, 8, 9, 10, 11, 12, 14, 16, 18, 24, 30` (px). Irregular — recommend normalizing to a 4px-based Tailwind scale while keeping 9/11/14/18 as named exceptions used in nav/pills.

### 1.6 Status-pill color map (4-tone + neutral semantic set)
Pills: Mono 11px, radius 6px, padding ~`3px 9–10px`.

| Tone | Text | Bg | Labels |
|---|---|---|---|
| Success (green) | `#1f9d6b` | `#e8f5ef` | Active, Won, Shipped, Released, Ready to ship |
| Info (blue) | `#3d63dd` | `#eef1fd` | Sent, In Process |
| Warn (amber) | `#c98a16` | `#fbf2e0` | Draft, On Hold, Approve |
| Danger (red) | `#d4503e` | `#fcebe8` | Late |
| Neutral (gray) | `#6b7280` | `#f0f1f5` | Scheduled, Received, rev tags |

### 1.7 Layout dimensions
| Dim | Value |
|---|---|
| Sidebar width | **252px** fixed (`flex-shrink:0`); redesign sidebar is auto-width, padding `18px 14px` |
| Topbar height | **60px**, border-bottom `1px #e7e9ee` |
| Content max-width | **1060px** (main dashboard); redesign up to 1360px |
| Modals | 560px and 420px, `max-width:90vw` |
| App shell | `height:100vh; display:flex; overflow:hidden` → fixed sidebar + flex column with sticky 60px header and scrollable content |
| Grids | KPI row `repeat(6, 1fr)`; two-col dashboard `1.55fr 1fr` |
| Empty-state copy | max-width 240px |

Keyframe animations present: `vsPulse` (live status dots), `vsShimmer` (loading skeletons), `vsGrow` (bar charts, redesign).

---

## 2. Domain data model

Reconciled entity list. **Slice flag:** ✅ = needed for the first slice (foundation + Quote → Order → Invoice); ⬜ = later. The first slice still needs **lookup/reference** entities so quotes/orders can reference real customers, parts, recipes, specs, and pricing.

### First-slice core (✅)

**Customer** ✅ — heat-treat shop's client account.
Fields: `id/customerNumber` (e.g. #1042), `name`, `initials` (2-letter avatar), `city`, `billingAddress`, `phone`, `terms` (Net 30/45/60), `openOrders` (int), `ytdSales`, `arBalance`, `status` (Active/Hold/Dormant), `defaultCert` (Spec ref + copies, e.g. "AMS 2759/3 · 2 copies"), `priceKey` (ref), `taxExempt` (bool/string), `primaryContact` (Contact ref).
Relationships: →Contact (1:N), →Part (1:N), →WorkOrder (1:N), →Quote (1:N), →Invoice (1:N), →Document (1:N), →PriceKey (N:1), →PricingRule (1:N), →ARBalance (1:1), →Specification (N:1 default cert).
Statuses: Active / Hold / Dormant.

**Contact** ✅ — person at a customer.
Fields: `name`, `role` (Buyer/Quality Mgr/A/P), `email`, `phone`. →Customer (N:1).

**Part** ✅ — customer part record with specs + assigned process master.
Fields: `partNumber` (TS-4471…), `description`, `material` (4140/8620/4340), `drawingRev` (A–D), `hardness` (Rc 58–62, HV 650+, "—"), `caseDepth`, `specification` (ref), `assignedProcessMaster` (ref, e.g. PM-CARB-58 rev C), `customer` (ref), `defaultProcess`, `priceKey` (ref), `stdLotQty`, `lastUsed`, `lastQuote`, `inspection.scale`, `inspection.sample`.
Relationships: →Customer (N:1), →ProcessMaster (N:1), →Specification (N:1), →PriceKey (N:1).

**ProcessMaster** (recipe) ✅ *(reference; drives traveler)* — standard ordered steps + instructions, shared by parts.
Fields: `id` (PM-CARB-58…), `name/process`, `description`, `stepCount`, `rev`, `status` (Active), `usedByCount`, `lastUpdated`, `createdBy` (Operator ref), `inspection.surfaceHardness/caseDepth/scale`.
Relationships: →ProcessStep (1:N ordered), →Part (1:N).

**ProcessStep** ✅ *(reference)* — one step of a ProcessMaster recipe.
Fields: `n` (run order), `op` (Receive & verify / Wash & rack / Carburize / Temper / Final inspect / Certify & ship), `equip` (Equipment/Area ref), `instr`, `params` (string[] e.g. `['1700°F','8.0 hr','0.90% C','Oil quench']`), `hasParams`, `track` (Track in / Track in-out / Track out / Inspect).
Relationships: →ProcessMaster (N:1), →Equipment (N:1).

**Quote** ✅
Fields: `id` (Q-2841), `customer` (ref), `customerPO`, `part` (ref), `material`, `quantity`, `processSummary`, `subtotal`, `discount`, `value/total`, `estMargin` (%), `requiredBy`, `date`, `validUntil` (+30 days), `age`, `salesperson` (Operator ref), `status`.
Relationships: →Customer (N:1), →QuoteLine (1:N), →Part (N:1), →WorkOrder (1:1 on conversion), →Operator (N:1; quote-auth limit $25,000).
Statuses: Draft / Sent / Approve (awaiting approval) / Won / Lost *(Lost implied by win/loss reporting; not seen as a pill)*.

**QuoteLine** ✅ — priced process line.
Fields: `process` (Carburize/Temper/Certification), `basis` (per lb / per lot / flat), `qtyOrWt` (e.g. "600 lb" or "1"), `rate` (editable), `amount` (rate × qty/wt).
Relationships: →Quote (N:1), →WorkOrder (N:1), →PricingRule (N:1).

**WorkOrder** (Order) ✅
Fields: `id/wo` (WO-48211), `customer` (ref), `part` (ref), `customerPO` (PO 7741-A), `process` (e.g. "Carburize + Temper"), `qty`, `due`, `orderedDate`, `status`, `certifyRequired` (e.g. "Yes · AMS 2759/3"), `orderValue`, `recipe` (ProcessMaster ref, e.g. "PM-CARB-58 · rev C"), `progressPct`.
Relationships: →Customer (N:1), →OrderLine (1:N), →ProcessMaster (N:1), →OrderStep (1:N), →Quote (N:1 created-from), →Certification (1:1), →Invoice (1:1), →Equipment (N:1 current load), →TrackingEvent (1:N).
Statuses: Received / Scheduled / In Process / On Hold / Late / Ready to ship / Released / Shipped.

**OrderLine** ✅ — part line on a WO (a WO can hold multiple parts, e.g. TS-4471 ×480 + SP-119 ×120).
Fields: `part` (ref), `description` (incl. material), `qty`, `spec` (per-line hardness). →WorkOrder (N:1), →Part (N:1).

**Invoice** ✅
Fields: `id` (INV-30412; `—` while To bill), `customer` (ref), `wo` (ref, e.g. "WO-48120 · shipped"), `amount`, `date`, `status`.
Relationships: →Customer (N:1), →WorkOrder (1:1).
Statuses: To bill / Sent / Paid.

**Certification (Cert)** ✅ *(first-slice-adjacent: order header flags it and it blocks ship)* — quality cert tied to WO/spec.
Fields: `id` (C-9921), `customer` (ref), `wo` (ref), `specification` (ref), `type` (Carburize/Vacuum/Nitride/…), `status` (Pending/Released), `copies`.
Relationships: →WorkOrder (1:1), →Customer (N:1), →Specification (N:1).
*Slice decision: cert lifecycle can be stubbed, but the order "Certify: Yes · AMS 2759/3" flag and the "cert required before ship" block should be modeled.*

**Specification** ✅ *(reference)* — customer/industry spec.
Fields: `id` (AMS 2759/3), `title`, `rev` (K/M/F/A/2), `owner` (SAE/DoD/Customer). →Part (1:N), →Certification (1:N), →Customer (N:1 for customer-owned specs).

**PriceKey** ✅ *(reference; feeds quote rates)* — named pricing scheme.
Fields: `id/name` (AERO-1), `description`. →Customer (1:N), →Part (1:N), →PricingRule (1:N).

**PricingRule** ✅ *(reference; rate source)* — step-pricing override under a price key.
Fields: `process`, `basis` (per lb / per lot), `rate` (e.g. $10.30), `minCharge` (e.g. $250, or "—"). →PriceKey (N:1), →Customer (N:1), →QuoteLine (1:N).
*Note: this is the only concrete rate source visible (customerDetail "Step pricing overrides · price key AERO-1") — see Open Questions on pricing.*

**ARBalance** ✅ *(needed for invoice → A/R)* — AR aging per customer + period totals.
Fields: `customer` (ref), `balance`, `current`, `pastDue`, `oldest` (days), `riskKind` (ok/warn/bad), period aging buckets (Current / 1–30 / 31–60 / 61–90 / 90+). →Customer (1:1), →Invoice (1:N).

**Operator / User** ✅ *(needed for auth, salesperson, quote auth limit)*
Fields: `id/operatorId` (validation: must be > 1000), `name`, `initials`, `title/role`, `viewAsRole` (manager/sales/office), `dept`, `quoteAuthLimit` ($25,000), `permissions`.
Relationships: →Role (N:1), →Quote (1:N salesperson), →TrackingEvent (1:N), →ProcessMaster (1:N createdBy).

**Role** ✅ — permission/view role. Fields: `key` (manager/sales/office), `label`, `permissions[]`. →Operator (1:N). Controls dashboard variant + module access.

**Document** ✅ *(customer/order attachments; light use in slice)* — `fileType` (PDF/DWG), `name`, `date`, `size`. →Customer (N:1), →Part (N:1).

### Later-slice entities (⬜)

| Entity | Purpose / key fields |
|---|---|
| **OrderStep** ⬜ | Per-order live step instance: `op`, `area/equip`, `operator`, `timestamp`, `state` (done/in process/scheduled/pending), `progress`, `tracked`. Needed for traveler execution / tracking, not for Q→O→I. |
| **Equipment** ⬜ | Furnaces/ovens: `name`, `status` (Running/On hold/Idle/Alarm), `process`, `wo`, `customer`, `qty`, `progressPct`, `operator`, `scan`, `finishTime`; redesign adds `temperature`, `timeRemaining`, `alarm`. |
| **Area** ⬜ | Tracking/kanban stage: `name` (Received/Wash & Rack/In Process/Final Inspect/Available to Ship), `count`. |
| **TrackingEvent** ⬜ | Scan/job card + order activity log: `wo`, `customer`, `detail`, `scan`, `flag` (LATE), `kind`, plus activity `action/actor/time`. |
| **ScheduleBlock** ⬜ | Weekly equipment-load block: `equipment`, `day` (mon–fri), `label`, `sub`, `kind`. |
| **Standard** ⬜ | Quality/process standard library: `id` (AS9100D…), `title`, `category` (Quality/Process), `reviewed/nextReview`. |
| **CAR** ⬜ | (Redesign only) Corrective Action Request: `id` (CAR-0312), `reason`, `status` (open/overdue), `openCount`. |
| **Maintenance** ⬜ | (Redesign only) Pyrometry/AMS 2750 TUS/SAT: `standard`, `type` (TUS), `equipment`, `due`. |
| **ReportGroup** ⬜ | Report catalog grouping: `title`, `icon`, `items[]`. |
| **DashboardKPI** ⬜ | Metric tiles: `label`, `value`, `delta`, `role`. |
| **SetupModule** ⬜ | Config tiles: `title`, `desc`. |
| **CommandPaletteItem / NavItem** | Nav + ⌘K entries: `label`, `group`, `key` (route), `icon`, `badge`. *(Foundation-relevant for the command palette, but data is static config, not a persisted entity.)* |

---

## 3. Quote → Order → Invoice semantics

### 3.1 Quote
- **Pricing model — line-item based.** Each line = `PROCESS | BASIS | QTY/WT | RATE (editable) | AMOUNT`. `AMOUNT = rate × qty-or-weight`. "+ Add line" adds rows; lines map ~1:1 to processes/steps plus a certification line.
- **Three observed bases:** `per lb` (Carburize 600 lb × $10.30 = $6,180), `per lot` (Temper 1 × $1,440), `flat` (Certification 1 × $800). Per-piece implied but **not shown**.
- **Worked example (Q-2841):** Carburize $6,180 + Temper $1,440 + Certification $800 = **Subtotal $8,420**; Discount $0; **Total $8,420**; Est. margin 42%.
- **Weight vs piece qty:** weight basis (600 lb) is distinct from piece quantity (480) — weight entered/derived separately; derivation not shown.
- **Header fields:** Q-#, status, customer, customer PO, part (id + name), material, quantity, required-by, quote date, valid-until (+30 days), salesperson, "Your quote limit" ($25,000), notes & terms (free text), plus a customer snapshot (terms, YTD, default cert, open orders).
- **Lifecycle:** `Draft → (Send quote) → Sent → Won`. Header actions: "Save draft" and "Send quote." Quotes over the salesperson's $25,000 limit route to **Approve** (awaiting manager approval) before Sent. A **Won** quote spawns an Order (activity: "Order created from Q-2841"). Win/Loss + Quote-Aging reporting implied.

### 3.2 Order (Work Order)
- **Created from a won quote.** Order-detail Activity log literally records "Order created from Q-2841."
- **Pricing carried over verbatim.** Order pricing card mirrors quote lines read-only: "Carburize · 600 lb" $6,180, "Temper" $1,440, "Certification" $800, Total $8,420 — same numbers/labels. `orderValue = quote total`.
- **Header fields:** WO-#, status, customer, customer PO, process summary, ordered date, due date, certify flag ("Yes · AMS 2759/3"), order value, parts list (multiple parts possible), process steps/traveler, pricing breakdown, activity log.
- **Multiple parts per WO** (TS-4471 ×480 + SP-119 ×120) via OrderLine.
- **Traveler model:** process steps are instantiated from the part's assigned Process Master (header "Recipe: PM-CARB-58 · rev C"). Each step carries number, operation, equipment/work-center, instructions, params (1700°F / 8.0 hr / 0.90% C / Oil quench), and a track-in/out point; on the order each step gains live state (done ✓ + operator + timestamp / in-process ◉ % + est. finish / scheduled). WO-48211 sequence matches PM-CARB-58: Receive & verify → Wash & rack → Carburize → Temper → Final inspect → Cert & ship. *(Traveler execution = later slice; for Q→O→I, model the carried-over header + pricing + cert flag.)*
- **Certification handling:** flagged at order header. Cert card: "Cert AMS 2759/3 will generate after final inspect. Releases automatically on hardness pass." Certs are their own entity (Pending → Released). **An unreleased cert blocks shipment** ("Cert AMS 2759/3 required before ship"; dashboard "X certs awaiting release · Blocking X shipments"). Cert also appears as a priced line ($800).

### 3.3 Invoice
- **Created per Work Order, triggered by ship.** When a WO ships it appears in Invoicing as a **To bill** row keyed to that WO, amount carried from the order, invoice # = `—`. Billing the row assigns an `INV-#####` and moves it to **Sent**. Subtitle counter: "9 shipped & uninvoiced" = To-bill queue size.
- **Strongly implies invoice-on-ship** (To-bill trigger = shipped state), not invoice-on-completion — but completion vs ship is **not disambiguated** (see Open Questions).
- **Amount = order value = quote total.** No separate invoice-line editing screen is shown.
- **Fields:** Invoice # (blank/`—` in To bill), customer, source WO ref ("WO-48120 · shipped"), amount, date (invoice/ship), status pill.
- **A/R handling:** Sent/unpaid invoices roll into A/R, aged into buckets (Current / 1–30 / 31–60 / 61–90 / 90+). A/R columns: Customer, Balance, Current, Past Due, Oldest (days). Dashboard tiles: Open A/R $262K, Past Due $31K, Invoiced MTD $396K. A **"Close [month] period"** action exists (period close; exact lock semantics unspecified). Paid invoices drop out of open A/R. Past-due example: Vulcan Forge 47 days, customer flagged "Hold."

### 3.4 Pipeline (full lifecycle context)
`Quote → Order → Schedule → Track → Cert → Ship → Invoice`. The first slice covers the two ends (Quote, Order header/pricing, Invoice/A-R) while Schedule/Track/Cert-execution are later.

---

## 4. Status vocabulary & glossary

### 4.1 Status vocabulary (consolidated, by entity)

**Quote:** Draft (amber, building) · Sent (blue, awaiting response) · Approve / *Awaiting Approval* (amber, exceeds $25K auth) · Won (green, accepted → order) · *Lost* (implied, reporting only).

**Order / Work Order:** Received (gray, arrived & counted, no processing) · Scheduled (gray, assigned to equipment/date) · In Process (blue, actively running) · On Hold / *On hold* / *Hold* (amber, paused — quality or credit) · Late (red, past due; "LATE" flag on tracking cards) · Ready to ship (green; kanban "Available to Ship") · Released · Shipped (green, in customer history).

**Certification:** Pending (amber, generated, awaiting release, blocks ship) · Released (green, approved → unblocks ship; auto-releases on hardness pass). Inspection result: Pass (auto-releases cert) / Fail (puts order on hold).

**Invoice:** To bill / *Uninvoiced* / *Shipped uninvoiced* (amber, shipped not billed, INV# = `—`) · Sent (blue, billed, awaiting payment) · Paid (green). Finance metric: *Invoiced* (MTD).

**Customer:** Active (green, good standing) · Hold (amber, credit/AR hold — new work may be restricted) · Dormant (gray, no recent orders, ~60 days).

**Process Master:** Active (current revision in use).

**Shop-floor equipment:** Running (green) · On hold · Idle ("No load · available", gray) · Alarm / Setpoint deviation.

**Tracking lifecycle columns:** Received → Wash & Rack → In Process → Final Inspect → Available to Ship.

**Quote metric:** Quoted (MTD dollar value issued).

### 4.2 Glossary (domain terms)

**Processes:** *Carburize* (diffuse carbon into low-carbon-steel surface ~1700°F controlled atmosphere then quench; PM-CARB-58). *Carbonitride* (carbon + nitrogen, lower temp; PM-CN-21). *Nitride* (nitrogen diffusion, low temp, minimal distortion, measured HV; PM-NIT-09). *Neutral harden* (through-harden in carbon-balanced atmosphere; PM-NH-15). *Vacuum harden* (in vacuum to prevent oxidation; PM-VAC-44). *Temper* (low-temp reheat e.g. 350°F/2 hr to reduce brittleness). *Anneal* (soften for machining; PM-ANN-03). *Stress relieve* (remove residual stress sub-critical). *Through harden* (hardness through full cross-section). *Quench / oil quench* (rapid cool → martensite).

**Metallurgy:** *Case depth* (hardened-layer depth, e.g. .020–.030 in). *Hardness Rc (Rockwell C)* (range e.g. Rc 58–62). *Hardness HV (Vickers)* (thin/nitrided cases, HV 650+). *Material grade* (4140/8620/4340).

**Production/shop:** *Work order (WO)* · *Traveler* (printed routing sheet, "Print traveler") · *Lot* (batch under one WO; sampling per lot e.g. 3 pc/lot) · *Rack/Fixture* (furnace basket; "2 racks of 240") · *Track-in / Track-out* (scan events driving live status) · *Process Master / Recipe / PM* (master recipe, rev-controlled) · *Process master step* (Receive & verify, Wash & rack, Carburize, Temper, Final inspect, Certify & ship).

**Equipment:** *Batch IQ furnace* (integral-quench, internal oil tank) · *Pit furnace* (top-loaded, nitriding/long parts) · *Continuous belt furnace* (conveyor, high volume) · *Temper oven* · *Vacuum furnace* · *Endo generator* (endothermic gas supply for atmosphere furnaces).

**Quality / specs / standards:** *Specification (spec)* · *AMS 2759/3* (SAE carburize & harden) · *AMS 2759/2* (low-alloy heat treat) · *AMS 2759/7 & /10* (carbonitride/nitride sub-specs) · *AMS 2750 / Pyrometry* (temperature-measurement & furnace surveys, TUS/SAT) · *MIL-S-6090* (military aircraft-steel heat treat) · *Standard* (AS9100D, ISO 9001, Nadcap HT, CQI-9) · *Nadcap (HT)* (aerospace/defense special-process accreditation) · *AS9100D* (aerospace QMS on ISO 9001) · *CQI-9* (AIAG heat-treat self-assessment) · *Certification (cert)* (post-inspection quality doc, e.g. C-9921; must release before ship).

**Pricing:** *Price key* (pricing profile, e.g. AERO-1) · *Step pricing* (per process step by basis: per lb / per lot / flat, with overrides + min charges).

**Views:** *Shop floor / Tracking* (live scan-driven by equipment/area) · *Schedule (equipment load)* (weekly furnace/oven plan).

---

## 5. Screen inventory & coverage gaps

### 5.1 Sidebar (main prototype — the flat structure to build)
- **(top, ungrouped):** Today
- **Sales:** Quotes (badge 12), Customers, Part Maintenance
- **Production:** Orders (badge 86), Process Master, Schedule, Tracking, Shop Floor
- **Quality:** Certifications (badge 7), Specifications, Standards
- **Finance:** Invoicing, A/R, Reports
- **(footer / standalone):** Patterns, Setup

### 5.2 Screens

| Screen | Group | Kind | First slice? |
|---|---|---|---|
| Today | (top) | dashboard | ⬜ (shell only — KPIs later) |
| **Quotes** | Sales | list | ✅ |
| **Quote Builder** | Sales | editor | ✅ |
| **Customers** | Sales | list | ✅ (reference) |
| **Customer Detail** (6 tabs: Overview/Contacts/Parts/Orders/Documents/Pricing) | Sales | detail | ✅ partial (Pricing tab = rate source) |
| **Part Maintenance** | Sales | list | ✅ (reference) |
| **Part Editor** | Sales | editor | ✅ (reference) |
| **Orders** | Production | list | ✅ |
| **Order Detail** | Production | detail | ✅ |
| Process Master | Production | list | ✅ reference (traveler stub) |
| Process Master Editor | Production | editor | ⬜ |
| Schedule | Production | board | ⬜ |
| Tracking | Production | board (kanban) | ⬜ |
| Shop Floor | Production | grid | ⬜ |
| Certifications | Quality | list | ⬜ (cert flag/block modeled in order) |
| Specifications | Quality | list | ✅ (reference) |
| Standards | Quality | list | ⬜ |
| **Invoicing** | Finance | list | ✅ |
| **A/R** | Finance | list | ✅ |
| Reports | Finance | dashboard | ⬜ |
| Setup | (footer) | grid | ⬜ |
| Patterns | (footer) | grid (component ref) | ⬜ (design-system reference) |

### 5.3 Coverage notes & gaps
- **No gaps vs the intended handoff:** the planned sidebar maps **1:1** onto the prototype. The prototype additionally exceeds the handoff with 5 detail/editor screens (Order Detail, Quote Builder, Customer Detail w/ 6 tabs, Part Editor, Process Master Editor) reached by clicking list rows.
- **No CSS variables / no per-screen data-props JSON** in the main prototype — all mock data is inline JS; screens switch via `state.route`, not separate components. The new build should formalize these into the typed mock data layer + real components/routes.
- **Command palette (⌘K)** enumerates the same destinations plus Create/Action quick commands; groups: Go to / Sales / Production / Quality / Finance / Config / Reference / Create / Action. Build it in the foundation slice.
- **Redesign file** is a script-less static iteration (~323 lines) with three art-direction explorations of the **Today dashboard only** (1A Workspace, 1B Pipeline, 1C Hub). It introduces alternate naming and concepts **not in the main sidebar** — treat as design variants, not modules:
  - "Parts & Recipes" (merged Sales item), "Furnace Floor" (vs "Shop Floor")
  - Quality group of **CARs / Maintenance / Certifications** → introduces CARs (corrective actions) and equipment Maintenance/pyrometry concepts
  - Drops the Finance group from visible nav; adds live SSI/SCADA furnace temps
  - **Decision needed:** adopt main-prototype nav (recommended for first slice) and defer redesign concepts.

---

## 6. Open business-rule questions for the first slice

Prioritized; **P1 = blocks Quote → Order → Invoice build, P2 = needed soon, P3 = can defer/stub**. These are the decisions the user must make; the prototype is silent or ambiguous on each (faithful — no rule invented).

### P1 — Must decide before building

**Q1. Where do quote-line RATEs come from?**
The only concrete rate source shown is the customer's Pricing tab ("Step pricing overrides · price key AERO-1": Carburize per lb $10.30 min $250, etc.). Rates are also editable inline on the quote.
- (a) Auto-populate from the part/customer Price Key (PricingRule), editable override per line *(matches what's shown)*
- (b) Manual entry only (price key is informational)
- (c) Price Key lookup with min-charge enforcement applied automatically
- (d) Hybrid: lookup default + manual override + min-charge floor

**Q2. Is "per piece" a supported basis, in addition to per lb / per lot / flat?**
- (a) Only the three observed bases
- (b) Add per-piece as a first-class basis
- (c) per-piece derived from per-lb via unit weight

**Q3. How is per-lb WEIGHT (600 lb) derived from piece quantity (480)?**
- (a) Entered manually per quote line
- (b) Computed from a Part unit-weight field × qty *(Part has no weight field today — would need adding)*
- (c) Both: default computed, manual override

**Q4. Quote → Order conversion trigger.**
Activity log says "Order created from Q-2841" but the action is unspecified.
- (a) Marking quote **Won** auto-creates the Order
- (b) Manual "Create order" action after Won
- (c) Receipt of customer PO drives creation
- (d) Won + manual confirm

**Q5. Invoice timing — on ship vs on completion.**
To-bill is tied to "shipped," but ship vs completion isn't disambiguated.
- (a) Invoice-on-ship (To-bill appears when WO → Shipped) *(best supported by prototype)*
- (b) Invoice-on-completion (Ready to ship)
- (c) Manual bill action regardless of status

**Q6. Multi-part quoting vs multi-part orders.**
Quote builder shows a **single part block**; orders carry **multiple parts** (480 + 120). Is the quote single-part or multi-part?
- (a) Quote is single-part; multi-part orders assembled separately *(as drawn)*
- (b) Quote supports multiple parts, each with its own line set
- (c) Quote = one part; multiple quotes → one order

**Q7. Partial shipment / partial invoicing.**
Orders hold multiple parts — can lines ship/invoice separately?
- (a) Whole WO ships & invoices as one unit *(simplest; matches single INV per WO)*
- (b) Per-OrderLine partial ship + partial invoice
- (c) Whole WO for first slice, partials later

### P2 — Needed during the slice

**Q8. Approval workflow above the $25,000 quote limit.**
Limit exists but approver/flow/scope undefined.
- (a) Per-user limit; over-limit → status Approve → any Manager role approves → Sent
- (b) Per-role limits
- (c) Per-user limit, specific named approver
- Decide: is the limit per-user or per-role, and what happens on rejection?

**Q9. Who can Send a quote vs. who must get approval; can Sent quotes be revised/re-sent (versioning)?**
- (a) Any salesperson sends ≤ limit; over-limit routes to Approve; Sent quotes are immutable (clone to revise)
- (b) Sent quotes editable + re-sent with version bump
- (c) Sent locked; "revise" creates Q-#### rev

**Q10. Discount handling.** Field exists but is $0.
- (a) Quote-level amount
- (b) Quote-level percentage
- (c) Line-level
- Plus: who is authorized to apply discounts (role-gated)?

**Q11. Est. margin (42%) — cost model.** Margin shown, cost source not exposed.
- (a) Out of scope for slice (display only / hardcoded)
- (b) Cost captured per process/lb on the Price Key
- (c) Cost = part standard cost
- Recommend stubbing margin in slice and flagging cost model as a later spec.

**Q12. Credit-hold enforcement.** Customer "Hold" (Vulcan Forge) exists; enforcement point undefined.
- (a) Hold blocks new orders + shipments, allows quoting
- (b) Hold blocks shipment only
- (c) Hold is advisory (warning banner, no block)

**Q13. Certification gating in the slice.** Unreleased cert blocks ship; cert auto-releases on hardness pass.
- (a) Model the order cert flag + "blocks ship" rule; cert release stubbed/manual for slice
- (b) Full cert lifecycle in slice
- Plus: what defines a hardness "pass," and what happens on **fail** (rework loop? re-quote?)?

### P3 — Can stub/defer

**Q14. Tax & freight.** No tax/freight/surcharge lines appear anywhere. Customer has `taxExempt` ("Yes · cert on file").
- (a) Tax-exempt shop — omit entirely
- (b) Add tax/freight lines (out of scope for slice)
- (c) Per-customer tax flag drives optional tax line

**Q15. Identifier numbering & formats** (Q-####, WO-#####, INV-#####, C-####). Schemes assumed, not specified — sequential? per-year? gaps allowed? Plus currency rounding rules.

**Q16. A/R period-close semantics.** "Close June period" exists; what it locks (invoices? cash receipts?) is unspecified. Cash-receipt / payment-application flow is **not shown** at all — define how an invoice moves Sent → Paid.

**Q17. Canvas background choice.** Main `#f6f7f9` vs redesign `#eef0f4` — pick one as the design-system canvas token (recommend `#f6f7f9`, main prototype).

**Q18. Nav naming / redesign concepts.** Adopt main-prototype nav (Shop Floor, separate Sales items, Finance group) vs redesign variants (Furnace Floor, Parts & Recipes, CARs/Maintenance). Recommend main for first slice; defer CARs/Maintenance.
