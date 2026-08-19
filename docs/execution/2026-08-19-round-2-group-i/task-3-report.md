# Task 3 — #153, the parent-history union read — implementer report

Branch `group-i-ready-issues`. Feature commit `65c28da`.

## What landed

**NEW `erp/src/lib/audit-children.ts`** — a pure, client-safe registry (no `src/server` import;
the `permission-constants` / `audit-diff` precedent). `AUDIT_CHILDREN` maps a parent audit entity
to its child SPECS: the child's audit entity, the display label the panel prints, and `paths` —
the relation hops from the child up to the parent. `auditChildrenOf` is the only way in and
carries the `Object.hasOwn` guard, so no call site can forget it. `auditChildLabel(parent, row)`
is what HistoryPanel names a foreign row by, which means the read and the render share one source
of truth: the panel can never show a row it cannot name.

`paths` is a LIST per spec rather than one path per entry. That is what makes the two-FK case one
section with one label — an `Application` under an `Invoice` is reachable as both the invoice it
reduces (`invoiceId`) and the credit it spends (`creditInvoiceId`) — and it is where the dedupe
happens: the id sets union into a `Set` before any query is built.

Registry contents, derived by reading `AuditableModel` against `schema.prisma` and each
panel-bearing page's sections:

| Parent | Children |
| --- | --- |
| `part` | `partSpecification`, `partInspection`, `partPrice`, `partPriceBreak` (via `partPrice`), `partFieldValue`, `partAttachment`, `partProcessRevision` |
| `customer` | `customerAddress`, `customerContact`, `customerSurcharge`, `customerTemplateAssignment` |
| `order` | `orderAttachment` |
| `invoice` | `application` (two FKs) |
| `receiptBatch` | `payment`, `application` (via `payment`) |
| `surcharge` | `customerSurcharge` |

Absent parents mean "no audited children" and read exactly as before: `cert`, `shipper`, `quote`,
`processTemplate`, `processStepCode` and the eleven reference kinds all edit their children
through the parent's own before/after diff. `invoiceLine`, `surchargeStepCode` and the order's
lines/containers/serials are deliberately NOT entries — nothing is ever audited under those
entities, so an entry would resolve to zero rows forever while looking correct.

**NEW `readAuditWithChildren(entity, entityId, limit = AUDIT_PANEL_LIMIT)`** in `audit.ts`,
returning `{ rows, hasMore }` newest-first across the union, tie-broken on `id` like `readAudit`
(it matters more here — a union routinely writes several entries in one millisecond). One
`findMany` with an `OR` of `{ entity, entityId: { in: [...] } }` scopes and `take: limit + 1`, so
`hasMore` costs no second query. `readAudit` is **untouched**; `AUDIT_CHILD_ENTITIES` is a
`AuditableModel[]`-typed projection of the registry, which is how the compiler rejects a registry
entry naming a non-auditable entity (the leaf cannot import that union itself).

Child-id resolution **never filters `deletedAt`**, and the hop walk runs bottom-up from the
parent id. `hopIds` throws loudly on an unknown model name — the registry is a compile-time
constant, never user input, so a miss there is a programming error.

**Route** (`api/admin/audit/route.ts`): the exact-match branch calls `readAuditWithChildren` and
returns the envelope. `searchAudit` untouched. Permission gate unchanged, with the reasoning
written down: `admin.view` already authorizes the whole log unscoped, so the union exposes nothing
a caller could not already fetch child-by-child.

**Panel** (`HistoryPanel.tsx`): lands `res.rows`/`res.hasMore` inside the existing effect-scoped
`stale` guard (both `loadedKeyRef` and the invalidation wiring unchanged), renders a child-section
chip from `auditChildLabel`, and states the truncation when `hasMore` — phrased from the rows
actually rendered, so the sentence stays true whatever the cap is set to.

## The deviation that matters: the envelope has SEVEN consumers, not three

The brief named three (`HistoryPanel.tsx`, `tests/admin-routes.test.ts`,
`e2e/flows/credit-hold-block-and-override.mjs`) and asked me to grep for others. There are four
more, all reading the exact-match branch as a raw array:

- `erp/src/app/orders/[id]/page.tsx:315` — void-reason banner
- `erp/src/app/certs/[id]/CertDetail.tsx:217` — void-reason banner
- `erp/src/app/invoicing/[id]/InvoiceDetail.tsx:538` — discard-reason banner
- `erp/src/app/shipping/[id]/ShipmentDetail.tsx:451` — void-reason banner

Each does `entries[0]`. On an object that is `undefined`, so `latest?.action === "delete"` is
false and the banner silently drops to its generic fallback copy — no error, no 403, nothing to
show it had happened. Exactly the "failing while reporting success" class.

Fixed in all four, and fixed to be correct under the union rather than merely to survive it: each
now takes the newest row whose `entity` is the parent's own (`rows.find((e) => e.entity ===
"order")` etc.), with `entity` added to the local `AuditEntry` type. `rows[0]` would have been
wrong the moment an attachment or application entry landed after the void — the existing "once
voided, no mutator can touch it" comments reason about the PARENT only, and I did not want the
banner resting on an assumption about every child section's guards.

Grep is clean at seven; `src/app/admin/audit/page.tsx` uses the search branch (no `entityId`) and
is unaffected.

## Tests — NEW `erp/tests/audit-children.test.ts`, 20 cases

- **Registry sweep.** Every child entity is asserted present in `SNAPSHOT_INCLUDE`, and
  `readAuditWithChildren(parent, "no-such-id")` is run for every parent — which executes the
  PRODUCTION walk over every hop of every path. That is what catches a typo'd model or column,
  since the leaf must name them as plain strings to stay browser-importable.
- **Every part section** (all seven) lands under the part, each row labelable.
- **Newest-first ACROSS the union**, asserted as an exact `(entity, entityId)` sequence with a
  parent edit sandwiched between two child edits.
- **Soft-deleted child** asserted on the DELETE ROW specifically. A count assertion would pass a
  naive `deletedAt: null` filter, because such a filter still finds the row's earlier CREATE entry
  through the live parent.
- **Child-of-child** both arms: a break under a live price, and the same break after
  `deletePartPrice` soft-deletes its parent — plus a break whose own delete AND whose parent's
  delete have both happened.
- **Two-FK dedupe**, three cases: the realistic split shape (credit C applied to invoice I, listed
  once under each end); the degenerate both-FKs-on-one-invoice row, where two audit entries must
  come back as two rows and not four, asserted on distinct audit-row ids; and non-leakage to the
  other invoice.
- **Scoping** — part A's price and break never under part B, and B's union is B's own rows only
  (the `customer-child-scoping.test.ts` precedent); same for two customers.
- **Cap + `hasMore`** at, below and above the row count; `AUDIT_PANEL_LIMIT === 200` pinned.
- **`?entity=__proto__`** at the route returns `{ rows: [], hasMore: false }`, plus
  `auditChildrenOf` returning `[]` for `__proto__`/`toString`/`constructor`.
- **`readAudit` unchanged** — still a bare array, still parent-only, and strictly shorter than the
  union for the same key.

`tests/admin-routes.test.ts` moved to `body.rows` and now also pins `hasMore: false`. The E2E flow
destructures `{ rows }`.

## Docs

`CLAUDE.md`'s Audit paragraph rewritten in place (superseded wording displaced, not appended):
adding an auditable entity is now stated as **three** edits — `AuditableModel`,
`SNAPSHOT_INCLUDE`, and an `AUDIT_CHILDREN` entry when the model is a child section of a
panel-bearing parent — with `readAudit`-stays-exact, the `Object.hasOwn` guard, the never-filter-
`deletedAt` rule (including why a count assertion cannot pin it), the stated cap, and the two
deliberate exclusions (`storedDocument`; child documents under the order panel).

`docs/HANDOFF.md` and spec §15 are NOT touched — the brief allocates doc edits per task and gave
Task 3 CLAUDE.md only; HANDOFF is being edited by Task 1 concurrently. A HANDOFF line for #153 is
a close-out item for the controller.

## Gates

Run from `erp/` against scratch DB `erp_scratch_i3` (created, migrated, dropped after):

| Gate | Result |
| --- | --- |
| `DATABASE_URL_TEST=…erp_scratch_i3 npm test` | **203 files / 3407 tests passed** |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |

E2E not run (group-level per the brief), but the flow file that reads the envelope is updated.

Note: the shared worktree carried Task 1's in-progress `applications.ts` edits during the full
run; everything was green regardless.

## TDD evidence (added in fix round 1 — the original report showed only final gates)

`tests/audit-children.test.ts` was written and run BEFORE any implementation existed. RED, on the
scratch DB:

```
 Test Files  1 failed (1)
      Tests  16 failed | 2 passed (18)
```

The two passes were the pure-registry cases (`auditChildrenOf` prototype guard, `auditChildLabel`)
— the leaf existed, `readAuditWithChildren` did not. GREEN after implementation: 20 passed.

Full-suite tail, first green run (pre-review):

```
 Test Files  203 passed (203)
      Tests  3407 passed (3407)
   Start at  12:13:44
   Duration  541.39s (transform 1.75s, setup 387ms, collect 27.03s, tests 497.82s, environment 15ms, prepare 4.61s)
```

## Fix round 1 (review verdict: Spec ✅ · Needs fixes — one Important, no Critical)

**IMPORTANT — the sweep test did not validate what the source claimed it validated. Fixed, and the
fix is proven to catch the regression.**

The reviewer was right and the diagnosis was exact. `readAuditWithChildren` walks a path only
while the previous hop returned ids (`i >= 0 && level.length > 0`), so the old sweep — which
walked whole chains from a bogus parent id — exited after the first hop. For a two-hop path the
INNER hop never executed. `{ model: "application", fk: "paymentId" }` was therefore validated by
nothing, on precisely the "a future audited child = one registry entry" shape the design exists to
make safe. No live defect (both columns are correct), but the advertised guarantee was not the
delivered one.

Fixed test-only, plus one source change to make the test drive the real code:

- `hopIds` is now **exported** from `audit.ts`, so the sweep runs every `(model, fk)` pair through
  the production hop executor rather than a replica — the `subscribeHistoryInvalidations`
  precedent ("the tested path IS the wired path"). Its JSDoc records why the sweep must drive hops
  individually.
- The sweep executes **each hop independently** and builds a `covered` set as it goes, compared
  against an `expected` set derived from the registry by a separate walk. If the execution ever
  stops reaching some hops — exactly what happened here — `covered` shrinks while `expected` stays
  complete and the assertion fires. That is the non-tautological part: it guards the failure mode
  that actually occurred.
- Added the missing negative half: an unknown model must **throw**, not resolve empty. An empty
  list is indistinguishable from a correct hop finding no children, which is how a typo ships
  green.
- Added real-data coverage for the one uncovered chain: a receipt batch → payment → application
  fixture asserting both levels resolve under the batch, plus scoping to a second batch.
- Kept the end-to-end "parent with no rows reads empty" case as its own test, with an honest name.

**Proof the fix works.** Injected `fk: "paymentIdd"` into the inner hop and re-ran: the new sweep
fails (`executes EVERY registry hop against the real schema` ×) while every other case still
passes. Reverted before the gates below. The old chain-walking sweep would have passed that
injection — that is the whole finding.

**Minors, all applied:**

- The three contradicting comments (`orders/[id]/page.tsx`, `CertDetail.tsx`,
  `ShipmentDetail.tsx`) no longer claim the delete entry "is always `entries[0]`". They now say it
  is the parent's own newest row, found by `entity` rather than by position.
- `AUDIT_CHILD_ENTITIES`'s JSDoc no longer claims a runtime re-assertion that did not exist. It
  leads with the compile-time annotation as the real value — and the test now imports the constant
  and pins that it enumerates the whole registry, so the export is load-bearing rather than
  dangling and the comment is true.
- The dedupe test keeps its contract but now says plainly that the **SQL shape** (one `findMany`
  with an `OR` of `entityId: { in: [...] }`) is the primary guarantee, the `Set` is belt, and what
  the test is really insurance against is a future rewrite that queries per path and concatenates.
- The cap-vs-banner failure mode is named at all four banner sites (fully at the order hub, by
  reference at the other three): the union is capped where `readAudit` was not, so a parent holding
  more child rows than the cap NEWER than its own delete entry would push that entry out of the
  window and drop the banner to generic copy. Not reachable today — a voided parent takes no
  further child edits — but named for whoever changes the cap or the registry. Not scoped away,
  since a "parent rows only" query param would widen the route surface for a case that cannot
  currently occur.
- `CLAUDE.md`'s Audit paragraph trimmed to roughly its pre-#153 length: the two rules a future
  implementer must not miss (the registry is the third edit alongside `AuditableModel`/
  `SNAPSHOT_INCLUDE`; never filter `deletedAt` in the walk, pinned on a delete row not a count),
  plus `readAudit`-stays-exact and the envelope. Everything else now lives only in the leaf's
  header, which the paragraph points at.

**Gates after fixes** (scratch DB `erp_scratch_i3`, recreated and dropped):

| Gate | Result |
| --- | --- |
| `DATABASE_URL_TEST=…erp_scratch_i3 npm test` | **203 files / 3411 tests passed** |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx eslint src tests` | clean (exit 0) |

```
 Test Files  203 passed (203)
      Tests  3411 passed (3411)
   Start at  12:37:32
   Duration  430.35s (transform 1.66s, setup 380ms, collect 25.63s, tests 388.53s, environment 15ms, prepare 4.51s)
```

Not pushed, per instruction. No HANDOFF/spec §15 edits.

## Open concerns

1. **Query shape at scale.** The union is one `findMany` with an `OR` over per-entity `id IN (…)`
   sets. `AuditLog` is indexed `(entity, entityId)`, so each arm is index-servable, but a part with
   hundreds of price/break rows produces a large `IN` list. Nothing in the documented 1–5-user
   deployment gets near a problem; worth a look if a panel ever feels slow.
2. **`documentTemplate` has no registry entry** because it has no History panel today. If one is
   added, `documentTemplateVersion` and `customerTemplateAssignment` are its children — the leaf's
   header says so.
3. **`receiptBatch` → `application` via `payment`** was a hop I added on my own reading of what the
   batch page shows (it lists applications per payment) — the only entry not named in the issue or
   brief. Review round 1 judged it right (the batch page mounts that panel and its principal
   actions are applications), and it now has behavioural coverage as well as hop coverage.
