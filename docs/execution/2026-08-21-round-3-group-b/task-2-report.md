# Task 2 — #165: create a certification at a chosen scope

**Branch:** `round-3-group-b`. **Scope:** the cert surface only — Task 1's files
(`ShipmentDetail.tsx`, `e2e/flows/reverse-shipment.mjs`, `tests/shipment-reverse-control.test.tsx`)
were not touched, and the only file both tasks write is `e2e/run.mjs`, where each registers a flow.

---

## 1. What changed, and why

| File | What |
|---|---|
| `erp/src/app/api/shippers/[id]/certs/route.ts` | **New.** The SHIPMENT-scope creation route. |
| `erp/src/app/api/certs/route.ts:14-30` | Docblock only: records that #165 routed AROUND the decision rather than relaxing it, and names where SHIPMENT scope now lives. |
| `erp/src/server/certs.ts:196-215` | The SHIPMENT branch of `createCertInTx` now also requires that the shipment actually CARRIES the order. |
| `erp/src/app/orders/[id]/CertificationsSection.tsx` | The scope picker + the §5.14 collision notice; the LOAD gap block folded onto the same shared create path. |
| `erp/src/app/orders/[id]/page.tsx:706` | Passes the new `shipmentsGate` (`shipping.view`). |
| `erp/src/server/shippers.ts:1057-1064` | Comment only: `addOrderToShipper` claimed "nothing else could create it later", which my change makes false. |
| `erp/tests/cert-shipment-scope.test.ts` | **New.** Route + service coverage. |
| `erp/tests/certifications-section.test.tsx` | **New.** Render + pure-helper coverage. |
| `erp/e2e/flows/cert-scope-create.mjs`, `erp/e2e/run.mjs:92-101` | **New flow**, registered beside `cert-results-print`. |

### The three-scope surface, after this task

| Scope | Route | Caller |
|---|---|---|
| ORDER | `POST /api/certs` `{ orderId, scope: "ORDER" }` | the hub's scope picker — **its first caller in the application** |
| LOAD | `POST /api/orders/[id]/certs` `{ loadNumber }` | the §4.1 gap block (as before) **and** the picker |
| SHIPMENT | `POST /api/shippers/[id]/certs` `{ orderId }` | the picker |

---

## 2. Where the control went, and why

**The order hub's `CertificationsSection`, for all three scopes.** Argued from the code:

1. **`Cert.orderId` is mandatory and `Cert` has no identity of its own** (spec §3.19 — its label is
   the order number plus its scope instance). Every cert, at every scope, is one of *this order's*
   things. There is exactly one screen that is already the home of "does this order have the
   certificate it needs": this section, which already **lists all three scopes**, including
   SHIPMENT with its `Shipper #N` subject (`CertificationsSection.tsx:84-88`). Read and write now
   live in one place instead of two.
2. **The shipment page is the weaker home for SHIPMENT scope**, and the reason is structural, not
   aesthetic: a shipment can carry several orders (`ShipperOrder`, and
   `shippers.ts`'s `addOrderToShipper`), so a control there must first ask *which order* — a
   question the hub has already answered. From the hub the only open question is *which of this
   order's shipments*, which the picker asks directly. `readCertPdfData`'s SHIPMENT branch
   (`certs.ts:534-545`) reads shipped quantities per `(shipperId, orderId)` pair, so the pair —
   not the shipment — is the unit the operator is really choosing.
3. It also keeps the two §4.1 obligations (the load gap block, the orphan warning) beside the
   manual raise, so the guided path is read first and the manual one second — they are literally
   adjacent in the markup, gap block then picker.

Secondary, and stated for honesty rather than as an argument: `ShipmentDetail.tsx` was off-limits
for this task by the owner's split. The code argument above stands without it — I would place it
here regardless, and I would place a *shipment-side shortcut* (if one is ever wanted) as a link
INTO this section rather than a second create surface.

**LOAD is in the picker too**, per the issue's "ORDER, SHIPMENT or LOAD". The gap block only
appears when the order's frozen resolution is `(required, LOAD)`; an order scoped ORDER whose
customer asks for a per-load certificate had no control at all. Both paths call the same
`createCertFor` (`CertificationsSection.tsx:226`), so they cannot drift.

---

## 3. The new route's shape

`erp/src/app/api/shippers/[id]/certs/route.ts`:

```ts
const CREATE_BODY = z.object({ orderId: z.string().min(1) }).strict();

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "certs", "create");
  const data = CREATE_BODY.parse(await req.json());
  const { id } = await params;
  return NextResponse.json(await createCert({ orderId: data.orderId, scope: "SHIPMENT", shipperId: id }));
});
```

Point for point against `POST /api/orders/[id]/certs`, the LOAD precedent:

- **the id that decides the scope instance comes from the path** (`shipperId` there, `orderId`
  here) — so `shipperId` is *still* never read off a request body, which is the whole content of
  the Task 11 Step 0 decision;
- **`scope` is fixed in the route**, not accepted;
- **`.strict()` body of only what the path cannot supply** — for LOAD that is `loadNumber`; here it
  is *which order on this shipment*, because a shipment can carry several;
- **`certs.create` alone** — the same gate as the sibling. This mints a certification, it does not
  change the shipment, so no `shipping.*` grant is required (the *UI* needs `shipping.view` to
  NAME a shipment, which is a different thing and is gated separately — see §5);
- **no permission or business rule is re-decided in the route.** Liveness of the shipment, the
  order/shipment pairing, and one-live-cert-per-scope-instance are all `createCert`'s, under its
  own `claimOrder`.

`POST /api/certs` is untouched apart from its docblock. Its `.strict()` schema still omits
`shipperId`, still 400s on one, and `tests/cert-routes.test.ts:120` ("rejects a client-supplied
shipperId outright") still passes. I added a second pin from the other direction:
`tests/cert-shipment-scope.test.ts` asserts `POST /api/certs` with `scope: "SHIPMENT"` still fails
with the service's *"Shipper is required for a shipment-scope certification"*.

### The one service change: the shipment must carry the order

`certs.ts:205-215`. Before this task the only callers of SHIPMENT scope were `saveNewShipper` and
`addOrderToShipper`, both of which pass a pairing they wrote a statement earlier — so an unpaired
`(order, shipment)` was unreachable and therefore unguarded. A hand-raised cert can name any pair,
and a cert whose shipment never carried the order prints **every line's shipped quantity as zero
under a bare order label** (`readCertPdfData`'s SHIPMENT branch reads `ShipperLine`s through the
`ShipperOrder` row, and `orderLabel` falls back to the bare number when `sequence` is null). That
is precisely "a printable record of nothing", which is the reason `createCertInTx` already gives,
in those words, for refusing a LOAD number the order does not have.

Placed **under the `claimOrder` already taken**, beside the LOAD check, not in the route: a
concurrent `addOrderToShipper`/`removeOrderFromShipper` claims this same order row, so the read
serializes with them. Creation-time only, like the LOAD check — a later removal orphans the cert
and keeps it live, which is the documented §4.1 behaviour and `removeOrderFromShipper`'s own void
already handles.

---

## 4. What the operator sees on a collision

Two things, one above the other. **The server's own refusal is never replaced or reworded:**

> This order already has a certification for that scope

(`certs.ts:228`, rendered in the section's existing red banner.) Beneath it, new, in amber:

> **A live certification already covers this order.** *Open it*
> **A live certification already covers Load 3.** *Open it*
> **A live certification already covers Shipper #1042.** *Open it*

"*Open it*" is a link to `/certs/<id>`. The sentence comes from `coverageNotice`
(`CertificationsSection.tsx:78-80`), which reuses the section's existing `subject()` helper — so
the collision notice, the table's Subject column and the orphan warning cannot drift apart on how
a scope instance is named. `"this order"` is the ORDER-scope case, where `subject()` is `""`.

How it is derived — and why it is **not** a second uniqueness rule:

- the create **always posts**; nothing is filtered, hidden or disabled on the basis of coverage.
  The picker offers every scope instance this order has, covered or not;
- the server refuses (or does not) under the order claim, exactly as before;
- **only after a refusal** does the section refetch and ask `coveringCert(rows, attempt)`
  (`CertificationsSection.tsx:68-76`) which of the order's own live rows matches the scope instance
  that was just attempted. If none matches — a permission failure, a network failure, a voided
  order — no notice renders and the server's message stands alone.

The refetch on the failure path is the actual fix (`CertificationsSection.tsx:241-244`). The old
`createForLoad` reloaded only on success, so the row that was blocking the operator was frequently
not even on screen. This is the walkthrough's blind-collision rough edge: the refusal named a scope
and nothing the operator could open.

---

## 5. Permission and gating notes

- The route: `certs.create`.
- The picker and its button: `createGate`, which the page already void-locks
  (`page.tsx:702`) — a voided order renders the control **disabled with "Order is voided"**, never
  hidden (§5.16).
- SHIPMENT **targets** need `shipping.view`, because listing them means calling
  `GET /api/orders/[id]/shipments`, which is gated on it. The page passes that as a separate
  `shipmentsGate` (`page.tsx:706`), the section fires the fetch only when the caller holds it (the
  hub's own precedent for its customer/parts fetches — never a call guaranteed to 403), and when
  it does not, the picker **says so** rather than looking like the order has never shipped:

  > Shipment-scope targets are not listed — Requires shipping.view.

  A shipment-list *failure* gets its own line and its own channel, the `loadError` precedent.
- Only LIVE shipments are offered. A voided one is refused by `createCert` itself ("that shipment
  does not exist or has been voided"), so offering it would offer a guaranteed refusal. That is a
  liveness fact read off the shipment's own row, not a coverage judgement.

---

## 6. Tests

Command used throughout: `DATABASE_URL_TEST="postgresql://erp:erp_local_dev@localhost:5432/erp_test_b2" npx vitest run …`

### `tests/cert-shipment-scope.test.ts` (8 cases) — RED-verified

The whole file was **RED before the route existed** (module-resolution failure, captured), and two
cases stayed red after it was written, which is the useful half:

| Case | RED evidence |
|---|---|
| requires `certs.create` (401 / 403 / 200) | red on missing module |
| mints a SHIPMENT cert whose shipper is the PATH's; resolves `shipperNumber` + `sequence` | red on missing module |
| refuses any extra body key — `shipperId`, `scope`, `loadNumber` (`.strict()`) | red on missing module |
| refuses a voided shipment | red on missing module |
| refuses a second live cert for the same order+shipment, **asserting the exact sentence** | red on missing module |
| `POST /api/certs` still refuses `scope: "SHIPMENT"` | red on missing module |
| **`createCert` refuses a shipment that does not carry the order** | **red against the finished route** — `AssertionError: promise resolved "{ …(21) }" instead of rejecting`. This is the guard from §3. |
| accepts a shipment carrying several orders, for each | red on missing module |

The multi-order case also caught a real fact I had wrong first time: `ShipperOrder` is
`@@unique([orderId, sequence])`, so `sequence` is the **order's** shipment count, not a position on
the shipment — two orders' first shipment are both `-1`. Fixed in the helper and pinned in the
assertion.

### `tests/certifications-section.test.tsx` (11 cases) — mutation-verified

`renderToStaticMarkup`, per the brief. The three render assertions were each proved to fail by
mutating the source and re-running (file restored from a backup afterwards; `git diff --stat`
confirmed the restore):

| Assertion | Mutation | Result |
|---|---|---|
| create button **disabled** with the reason | dropped `createGate.disabled` from the button's `disabled` expression | that case went red, the other 10 stayed green |
| picker option **values** (`ORDER`, `LOAD:1`, `LOAD:2`) | changed the option value to `String(l.loadNumber)` | that case went red |
| the "why shipment targets are missing" line | reworded the sentence | that case went red |

Disabled is asserted as `/\sdisabled=""/` on the **button's own opening tag**, never
`toContain("disabled")` — the button's Tailwind classes are `disabled:cursor-not-allowed
disabled:bg-slate-400`, so the substring form is true of every render and would pass with the gate
deleted. The enabled case is asserted beside it. The option-value assertion is `[ >]`-anchored
because React marks the selected option `selected=""`.

The other 8 cases are the pure helpers: `coveringCert` (finds the live row; **ignores a voided
one** — voiding is how the operator frees a scope instance; matches a load only by its number;
matches a shipment by `shipperId`, never by merely being shipment-scoped), `coverageNotice`'s three
exact sentences, and `targetKey`/`parseTarget` round-tripping, with `parseTarget` returning **null**
for a key it did not emit rather than falling back to ORDER (which would turn a garbage key into a
silent order-scope create).

### E2E — `e2e/flows/cert-scope-create.mjs`, registered at `e2e/run.mjs:101`

Keys its own order against the shipping fixture customer using the part whose `certRequired` is
**false**, so order save mints nothing and every cert in the flow is one the surface raised. Then:

1. asserts the picker offers this order **and no shipment target** — with the shipments `GET`
   explicitly awaited, so the absence is a settled fact rather than a race;
2. raises ORDER scope, waiting on a `POST /api/certs` that must be `ok()` — *the route's first
   exercise from a screen in the product's history* — and confirms the `By order` row appears;
3. raises it again, waiting on a `POST /api/certs` that must be **400**, and asserts both the
   server's sentence and the collision notice, then reads the "Open it" `href` and asserts it
   matches `/certs/…`;
4. ships the order in full through `/shipping/new`;
5. asserts the picker now carries `option[value="SHIPMENT:<id>"]` whose text is
   `By shipment — Shipper #N`, raises it against `POST /api/shippers/<id>/certs`, and confirms the
   `By shipment` row and its `Shipper #N` subject;
6. collides again and asserts the notice names **`Shipper #N`, not "this order"**, and that its
   link differs from the order-scope cert's — the two live certs on this order are different scope
   instances and the notice has to tell them apart.

---

## 7. Gate results

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `node --check e2e/flows/cert-scope-create.mjs` | clean |
| `node --check e2e/run.mjs` | clean |
| `npx vitest run` (full, `erp_test_b2`) | **208 files, 3537 tests, all passed** (446s) — re-run on the final tree after the last comment edits |
| `npm run test:e2e` | see below |

### The E2E run, stated plainly

**I ran it twice. The first run was 20 of 25; the second was 25 of 25 (exit 0).**

**Run 1 — 20/25.** The five failures were flows 1–5:
`template-build-and-load`, `typed-fields`, `revision-cut`, `blocked-code-delete`,
`permission-gating`. **My flow passed**, as did the other 19.

The failure screenshot (`e2e-artifacts/template-build-and-load/05-failure.png`, since overwritten
by run 2) showed the part designer with **"Failed to fetch" on every panel at once** — the page
error, the Active-quotes panel, Attachments, and "History could not be loaded". That is `fetch()`
rejecting at the network level, not a 4xx from any handler: the dev server was momentarily
unreachable. `run.mjs`'s own flow list records that flows 2–4 consume the template flow 1 builds,
so one root failure accounts for the block; flow 5 is the restricted-user pass over the same part
designer. Contributing factor: I started that run seconds after a 7.5-minute full vitest run, into
`next dev`'s cold first-compile.

I did **not** treat this as a pass. I re-ran the whole suite with full output captured.

**Run 2 — 25/25, exit 0, no `FAIL` line anywhere in the log.** Same tree, same flow order.

I am reporting run 1 rather than only run 2 because "it passed the second time" is a fact a
reviewer should have, not one I should file off. My read is a transient dev-server/network hiccup;
the honest limit of that read is in §9.

### Dev-DB state left behind

Verified empty after run 2 (and before run 1):

```
close_periods | orders | shippers | certs | customers | parts | invoices | batches | templates | sessions
      0       |   0    |    0     |   0   |     0     |   0   |    0     |    0    |     8     |    0
```

`templates = 8` is the seeded Standard set, the baseline. **No `ClosePeriod` leftover** — the hazard
Task 1 hit. Both runs reported `cleanup ok`.

---

## 8. What I did not do

- **No documentation.** The brief makes `docs/manual/05-certifications.md`,
  `docs/manual/walkthrough.md`, `docs/HANDOFF.md` and `npm run manual:build` its own **Task 3**, and
  my file scope excluded them. The chapter needs a paragraph on the scope picker and the
  walkthrough's blind-collision rough-edge row is now stale — both are §4's material, ready to
  lift. Flagging rather than doing, per the brief.
- **No migration, no audit-registry edit, no new allocating entry point** — none needed. `Cert` was
  already in `AuditableModel`/`SNAPSHOT_INCLUDE`; `createCert` already audits through
  `auditedCreate`; no counter is consumed.
- **No UI uniqueness check.** Stated here because it is the thing most likely to be looked for: the
  picker offers covered instances, the button stays enabled, and the only coverage question the
  client asks is asked *after* a refusal, to identify a row.

---

## 9. What I could not verify mechanically

1. **Clicks, effects and anything needing a fetch to land**, in the unit suite — no jsdom. The
   picker's SHIPMENT options, the collision banner and the failure-path refetch are all render-time
   invisible; they are proved by the Playwright flow instead, and `coveringCert`/`coverageNotice`
   are proved as pure functions. This is the standing split, not a gap I introduced.
2. **Run 1's five failures — root cause is a reading, not a measurement.** I have the screenshot
   signature (every fetch on one page failing at once) and the fact that a clean re-run of the same
   tree passed 25/25, but I did not capture run 1's stdout, so I do not have the underlying
   Playwright error strings. A reviewer wanting certainty should re-run; my flow passed in both.
3. **The pairing guard's concurrency argument is by inspection.** `claimOrder` serializes the read
   against `addOrderToShipper`/`removeOrderFromShipper` (both claim the same order row) — I did not
   write an interleaving test for it, because the guard is a creation-time data-shape check like the
   LOAD one beside it, not a cross-transaction invariant. The uniqueness check that *is* one is
   already interleaving-tested (`tests/certs.test.ts`'s Read-Committed race).
4. **Whether the manual's figures need re-capture.** `manual:capture` is forbidden to this group
   (#169, the 16 MB ceiling), so the certifications chapter's screenshots will not show the picker
   until that is resolved.

---

## 10. Adjacent defects noticed and not fixed

1. **`certsForOrder` is not permission-scoped to the shipment it names.** The section renders
   `Shipper #N` for a SHIPMENT-scope cert (`CertificationsSection.tsx:84-88`) off `CertRow`'s
   `shipperNumber`, which `GET /api/orders/[id]/certs` returns under `certs.view` alone. So a
   caller without `shipping.view` cannot *pick* a shipment but can already *read* a shipper number
   for one that is certified. Pre-existing, unchanged by this task, and arguably correct (the
   number is part of the cert's own identity, §3.19) — but it makes the new `shipmentsGate` hint
   read as stricter than the section actually is. Worth an owner ruling rather than a silent
   tightening.
2. **`ShipmentsSection.tsx:42-46` has no stale-load guard.** It sets state straight out of a `.then`
   with no `useLatest` ticket and no cleanup flag, unlike every other fetch on the hub. Not
   reachable today — its deps are fixed for the page's life — but it is the one fetch on this page
   outside the discipline, and I read it closely while deciding where the picker's shipment list
   should come from. Not mine to change in this diff.
3. **The gap block's per-load buttons still only render for *uncovered* loads** — a genuine
   client-side coverage filter, predating this task, and exactly the shape the ruling warns
   against. It is defensible where it is (it is the §4.1 *gap* display, whose entire job is to show
   what is uncovered), and the picker beside it now offers every load unconditionally, so the
   operator has an unfiltered path. Left alone deliberately; noting it so a reviewer who spots the
   inconsistency knows it was seen.
