# Task 3 report — `documents.ts`: one store for four kinds, traveler migrated onto it

## Summary

Extracted the store/list/get logic out of `src/server/traveler.ts` into a new
`src/server/documents.ts`, so the three guarantees this project makes about printed
documents — permanent (no delete path anywhere), `fileData` never reaching the audit
layer, and byte-exact reprints — are written once instead of once per document kind.
`traveler.ts` now delegates all storage to `storeDocument` and keeps thin, order-scoped
wrappers (`listDocuments`, `getDocument`, `travelerFilename`) for its existing callers.
`GET /api/documents/[docId]` now reads the document's metadata to learn its kind before
choosing the permission gate, instead of a hardcoded `orders.view`.

## What was implemented

### `src/server/documents.ts` (new)

Exports exactly the brief's Produces block, verbatim names and signatures:

- `DocumentOwner` — the four-kind discriminated union, `SHIPPER`'s `orderId` sub-scope
  kept exactly as specified (not tightened).
- `DocumentMeta` — the widened metadata shape (no `orderNumber`/friendly numbers; those
  are the caller's to supply, matching how `printTraveler` already carried `orderNumber`
  alongside, never inside, its document metadata).
- `storeDocument(tx, owner, pdf)` — maps `DocumentOwner` onto the CHECK-matching column
  combination via an internal `ownerColumns` helper, then `auditedCreate("storedDocument",
  data, ...)` with metadata-only in the audit payload and `new Uint8Array(pdf)` in the
  actual write.
- `listDocumentsForOrder(orderId)` — the exact union query given in the brief's Step 3,
  with an order-existence 404 check ahead of it (parity with the old `listDocuments`).
- `listDocumentsForShipper(shipperId)` / `listDocumentsForCert(certId)` — direct
  `shipperId`/`certId` matches (no union needed; both own their column directly per the
  CHECK), each with the same existence-check pattern.
- `getDocument(docId)` — stored bytes, untouched, never filtered on any owner's
  `deletedAt`.
- `documentFilename(meta, orderNumber?, shipperNumber?)` — per-kind naming
  (`traveler-*`, `ticket-*`, `bol-*`, `cert-*`), falling back to the raw id when no
  friendly number is supplied. The four kinds' exact naming conventions beyond TRAVELER
  are not specified anywhere in the spec (Tasks 18/19 own those PDF layouts and, per the
  task instructions, call only `storeDocument` to persist a print) — I picked simple,
  unique, documented names rather than guessing at an undocumented convention.

### `src/server/traveler.ts`

- Removed its own `DocumentMeta`, `DOCUMENT_SELECT`, `DocumentSelected`, and the `toMeta`
  placeholder-404 guard entirely (documents.ts now properly owns that shape, per the task
  instruction not to preserve the placeholder).
- `printTraveler` now calls `storeDocument(tx, { kind: "TRAVELER", orderId, loadNumber:
  loadNumber ?? null }, pdf)` inside the same claim-holding transaction it already had —
  the claim/read/render/archive sequencing and all its fix-wave comments are untouched.
- `export const listDocuments = listDocumentsForOrder;` and `export { getDocument } from
  "./documents";` keep both names live at this import path, since
  `src/app/api/orders/[id]/documents/route.ts` (out of this task's file list) and
  `tests/traveler.test.ts` both depend on them.
- `travelerFilename` now delegates to `documentFilename`, building a minimal adapter
  `DocumentMeta` (kind/loadNumber only meaningful fields) plus the `orderNumber` second
  argument.

### `src/app/api/documents/[docId]/route.ts`

Reads `getDocument(docId)` first, then gates with `mustCan(user, AREA_BY_KIND[doc.kind],
"view")` — `TRAVELER → orders`, `SHIPPER`/`BOL → shipping`, `CERT → certs`. `requireUser()`
still runs first, so an unauthenticated request is still a 401 before any DB read.

### `tests/certs-schema.test.ts` (Step 6, two coverage gaps)

- `"rejects a SHIPPER document that names an order but no shipment"` — the missing CHECK
  case: a `SHIPPER` row with `orderId` set but `shipperId` NULL, via `$executeRaw`.
- A new `describe` block, `"SNAPSHOT_INCLUDE is a valid Prisma include for every audited
  model"`, iterating `Object.keys(SNAPSHOT_INCLUDE) as AuditableModel[]` and issuing one
  `findFirst({ include })` per entry. Required exporting `SNAPSHOT_INCLUDE` from
  `src/server/audit.ts` (it was a private `const`) — not in the brief's literal file list,
  but unavoidable to fulfill the brief's own explicit instruction to iterate the map from a
  test.

### `src/app/orders/[id]/DocumentsSection.tsx` (small, out-of-file-list fix)

The client-side local `StoredDocument` type mirrored the OLD `DocumentMeta` and included
an `orderNumber: number` field that documents.ts's new shape no longer returns (that field
is unused in the component's render, so this was a latent type/runtime-shape mismatch, not
a behavioral bug). Updated the mirror to match the new shape (`orderId: string | null`, no
`orderNumber`) and its comment. Zero behavioral change — verified `orderNumber` was never
read anywhere in the file before touching it.

## Ambiguities resolved (per the task's own "Ambiguity I am resolving for you")

- Both Step 6 tests added to `tests/certs-schema.test.ts`, alongside the existing CHECK
  cases, as directed.
- The `SNAPSHOT_INCLUDE` smoke test iterates the map and issues one `findFirst({ include })`
  per entry, as directed — verified it actually catches a bad relation name (see TDD
  evidence below), not just that it "does nothing."
- `tests/traveler.test.ts` was not touched — confirmed via `git diff` producing zero output
  for that file both before and after the full change.
- The document route reads metadata (via `getDocument`, which returns both metadata and
  bytes in one query — documents.ts has no lighter-weight metadata-only fetch, and this
  route is not the place to add one) before gating, so nothing is sent to an unauthorized
  caller.

## Tests

New file `tests/documents.test.ts` (16 tests): the brief's 3 required tests verbatim
(multi-order BOL union, no bytes in audit payload, byte-for-byte round trip), plus
additional coverage I judged worth adding given `storeDocument`/`listDocumentsForShipper`/
`listDocumentsForCert`/`documentFilename` have no other test file: per-kind owner-column
mapping, shipper/cert listing (including that a CERT document doesn't leak into a shipper's
list and vice versa), 404s for every list/get function, `documentFilename` for all four
kinds including the id-fallback path, and the widened route gate (`shipping.view` fetching
SHIPPER 200 / CERT 403, `certs.view` fetching CERT 200 / BOL 403, and 401 signed out).

`tests/certs-schema.test.ts` grew from 11 to 13 tests (Step 6's two additions).

`tests/traveler.test.ts` — all 28 tests, unmodified file, still pass.

## TDD evidence

**RED** — wrote `tests/documents.test.ts` in full, then moved `src/server/documents.ts`
aside (`mv src/server/documents.ts /tmp/documents.ts.bak`) to force the import-resolution
failure the brief's Step 2 predicts, and ran:

```
$ npx vitest run tests/documents.test.ts
 FAIL  tests/documents.test.ts [ tests/documents.test.ts ]
Error: Cannot find module '@/server/documents' imported from
'.../tests/documents.test.ts'.
 Test Files  1 failed (1)
      Tests  no tests
```

Matches the brief's stated expectation exactly ("cannot resolve `@/server/documents`").
Restored the file (`mv /tmp/documents.ts.bak src/server/documents.ts`).

**GREEN**:

```
$ npx vitest run tests/documents.test.ts
 ✓ tests/documents.test.ts (16 tests) 776ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

**RED/GREEN for the SNAPSHOT_INCLUDE smoke test** (proving it isn't vacuous): temporarily
renamed `cert.requirements` to `cert.requirementsBOGUS` in `SNAPSHOT_INCLUDE` and reran the
new test —

```
$ npx vitest run tests/certs-schema.test.ts -t "issues one findFirst"
Unknown field `requirementsBOGUS` for include statement on model `Cert`. ...
 Tests  1 failed | 12 skipped (13)
```

— then restored `audit.ts` byte-for-byte (`diff` confirmed identical) and reran to GREEN:

```
$ npx vitest run tests/certs-schema.test.ts
 ✓ tests/certs-schema.test.ts (13 tests) 783ms
```

**Permission-sweep regression caught and fixed mid-task**: after moving the audited create
out of `traveler.ts`, `npm test` flagged `tests/permissions-sweep.test.ts` — the "no
service mutates Prisma outside an audit helper" check flagged `traveler.ts` as an offender.
Root cause: a doc comment (fix-wave R2 finding 4, describing `voidOrder`'s own update via
`tx.order.update(...)`) still literally contained the pattern `.update(`, and with the
real `auditedCreate` call gone from the file, the sweep's file-level heuristic (mutation
pattern present, audit pattern absent) tripped on prose, not code. Reworded the comment to
describe the same fact without the code-shaped token; reran the sweep to confirm it passes
for the right reason (the file genuinely performs zero direct Prisma mutations now, since
storage moved to `documents.ts`).

## Gates — all green

```
npm test        → 78 test files, 1047 tests passed
npx tsc --noEmit → clean
npx eslint src tests → clean
npm run build    → compiled successfully, all routes generated
```

## Files changed

- `erp/src/server/documents.ts` (new)
- `erp/src/server/traveler.ts` (modified — storage delegated, `printTraveler` migrated,
  `listDocuments`/`getDocument`/`travelerFilename` now thin wrappers)
- `erp/src/server/audit.ts` (modified — `SNAPSHOT_INCLUDE` exported for the new smoke test)
- `erp/src/app/api/documents/[docId]/route.ts` (modified — widened gate)
- `erp/src/app/orders/[id]/DocumentsSection.tsx` (modified — stale `orderNumber` field
  removed from the client-side type mirror)
- `erp/tests/documents.test.ts` (new, 16 tests)
- `erp/tests/certs-schema.test.ts` (modified — 2 new tests, +1 import)

Commit: `refactor(documents): one stored-document service for all four kinds`
(`7c6ab60` on `phase-4-certs-shipping`).

## Self-review

**Completeness against the brief**: all 8 steps done. All 8 "Produces" interfaces exist
with the exact names and signatures given. `printTraveler` calls `storeDocument` inside its
existing claim-holding transaction, unchanged sequencing/locking. `travelerFilename`
delegates to `documentFilename`. Route gate widened exactly per the kind→area table in the
brief. Both Step 6 coverage gaps closed. `tests/traveler.test.ts` byte-identical to before
(`git diff` empty).

**Naming**: matches the brief's exact names (`DocumentOwner`, `DocumentMeta`,
`storeDocument`, `listDocumentsForOrder`, `listDocumentsForShipper`, `listDocumentsForCert`,
`getDocument`, `documentFilename`). No name deviations.

**YAGNI**: did not add `assertPrintable` (explicitly Task 10's, per the task instructions).
Did not add a metadata-only fetch variant of `getDocument` for the route (would be
premature — nothing needs it yet, and streaming bytes into memory before a 403 is a minor,
accepted cost, not a real leak, since the bytes never leave the server on a denied
request). `documentFilename`'s naming for SHIPPER/BOL/CERT is intentionally minimal (no DB
joins, no persistence) since Tasks 18/19 own the actual print layouts and, per the parent
task's own instructions, call only `storeDocument`.

**Test quality**: beyond the brief's 3 required tests, added coverage for every other
exported function documents.ts now owns, since none of them had any test file before this
task. Verified the new SNAPSHOT_INCLUDE smoke test is not vacuous by deliberately breaking
a relation name and confirming it fails, then restoring and confirming it passes again.

**Pristine output**: full suite green (1047/1047), tsc clean, eslint clean, build clean.

## Concerns

- **`documentFilename`'s per-kind naming convention (`ticket-*`, `bol-*`, `cert-*`) is my
  own choice, not something specified anywhere in the spec or brief.** It's simple,
  documented, and doesn't foreclose anything (any caller can pass friendly numbers or not),
  but whoever implements Tasks 18/19 should treat these names as a starting point, not a
  contract, if the owner has an opinion about exact download filenames for those three
  kinds.
- **Exporting `SNAPSHOT_INCLUDE` from `audit.ts`** was necessary to satisfy the brief's own
  explicit Step 6 instruction but is a file outside the brief's literal "Modify" list. The
  change is additive (one `export` keyword plus a comment) and doesn't alter any existing
  behavior — confirmed via the full test suite.
- **`src/app/orders/[id]/DocumentsSection.tsx`** was also touched, outside the brief's file
  list, to fix a client-side type that would otherwise silently claim a field
  (`orderNumber`) the API no longer returns. It's a type-only fix (unused field), zero
  runtime behavior change, verified by grep before touching it.

---

## Review round 2 — fixes

The review came back "Needs fixes": two Important findings and one Minor. All three are fixed
below, covering tests re-run, and the three gates re-run clean.

### Important 1 — filename regression on every document download

**Root cause.** `src/app/api/documents/[docId]/route.ts` called `documentFilename(doc)` with no
number argument. `documentFilename`'s TRAVELER branch then fell back to `meta.orderId` — a raw
cuid — because the pre-extraction `traveler.ts` had joined `order: { select: { orderNumber: true
} } }` into its own `DOCUMENT_SELECT` specifically so this route could build a friendly name, and
the extraction dropped that join without adding a substitute at the one call site that needed it.
Confirmed exactly as described: this was a real behavior change in a file the brief scoped me to,
under a brief whose own acceptance bar was "behaviour is identical" — noted for next time, per the
reviewer's ask.

**Fix.** Added `resolveDocumentFilename(meta: DocumentMeta): Promise<string>` to
`src/server/documents.ts` — the one caller-side lookup this needs, generalized to all four kinds:

- `TRAVELER` — looks up `order.orderNumber` by `meta.orderId`.
- `SHIPPER` — looks up `shipper.shipperNumber` by `meta.shipperId`, plus `order.orderNumber` by
  `meta.orderId` when the ticket is scoped to one order (parallelized with `Promise.all`).
- `BOL` — looks up `shipper.shipperNumber` by `meta.shipperId`.
- `CERT` — looks up the owning order's `orderNumber` via `cert.orderId` (a cert carries no number
  of its own, spec §3.19; the owning order's number is what spec §10.3's cert layout itself prints
  under "Order No.", so it's the natural friendly identifier).

Each branch calls the existing synchronous `documentFilename(meta, orderNumber?, shipperNumber?)`
with what it found, so the naming rule itself stays in one place. `documentFilename`'s `CERT`
branch was changed to use `orderNumber` (falling back to `meta.certId` when none is given, e.g.
from `travelerFilename`-style direct calls that don't know it) — previously it ignored the
`orderNumber` argument entirely for `CERT`.

`src/app/api/documents/[docId]/route.ts` now calls `await resolveDocumentFilename(doc)` instead of
the synchronous `documentFilename(doc)`.

**Test.** Added a new describe block in `tests/documents.test.ts`, `"GET /api/documents/[docId]
names the download with a friendly filename"` (6 tests), asserting the literal
`Content-Disposition` header string — not just status/content-type/`.toContain("inline")` — for:
a plain TRAVELER (`traveler-<orderNumber>.pdf`), a per-load TRAVELER
(`traveler-<orderNumber>-load-3.pdf`), a whole-set SHIPPER ticket (`ticket-<shipperNumber>.pdf`),
a single-order SHIPPER ticket (`ticket-<shipperNumber>-order-<orderNumber>.pdf`), a BOL
(`bol-<shipperNumber>.pdf`), and a CERT (`cert-<orderNumber>.pdf`). Also updated the existing
`documentFilename` unit test for `CERT` to assert the new `orderNumber`-driven convention
alongside the existing id-fallback case.

```
$ npx vitest run tests/documents.test.ts
 ✓ tests/documents.test.ts (27 tests) 2033ms
 Test Files  1 passed (1)
      Tests  27 passed (27)
```

### Important 2 — the union widened `GET /api/orders/[id]/documents`'s authorization surface

**Root cause.** Before Task 3, `listDocuments`'s bare `{ orderId }` filter could never match a BOL
or cert row (those never set `orderId`, or only did as the deliberate SHIPPER sub-scope). After
the union query, the `cert: { orderId }` and `shipper: { orders: { some: { orderId } } } }`
branches make them reachable, so an `orders.view`-only caller hitting `GET
/api/orders/[id]/documents` could learn that a shipment's BOL or a certification exists for that
order, despite holding neither `shipping.view` nor `certs.view`.

**Owner ruling (2026-08-04):** the list shows only the document kinds the viewer may actually open.

**Fix**, modeled on `search.ts`'s `globalSearch` per-group permission filtering (read first, as
instructed):

- `src/server/documents.ts` gained `AREA_FOR_KIND: Record<DocumentKind, Area>` — the one map both
  the download route's gate and this filtering now share, so they can't silently diverge on which
  area guards which kind.
- `listDocumentsForOrder(orderId: string, viewer?: PermUser)` — `viewer` is a new, **optional**
  second parameter. When given, `AREA_FOR_KIND` decides which kinds `can(viewer, area, "view")`
  allows, and the Prisma query adds `kind: { in: allowedKinds }` (ANDed with the existing union
  `OR`) so a kind the caller cannot view is silently dropped from the result — never a 403 for the
  whole call, matching `globalSearch`'s "missing permission empties the group, doesn't fail the
  request" shape. When `viewer` is holding nothing, `allowedKinds` is empty and the function
  short-circuits to `[]` without a query.
- `viewer` is optional, not required, for one concrete reason: `traveler.ts`'s `listDocuments`
  alias (`export const listDocuments = listDocumentsForOrder`) is called directly and unfiltered
  throughout `tests/traveler.test.ts` — a file the original task brief requires stay byte-identical
  — testing print/archive plumbing, not authorization. Making `viewer` required would have forced
  edits to that file to keep it compiling, which the original brief's acceptance bar explicitly
  forbids. Omitting `viewer` preserves the pre-fix "see everything" behavior for those trusted,
  non-request call sites; the one HTTP-facing caller (`src/app/api/orders/[id]/documents/route.ts`)
  is the one place a `viewer` is required in practice, and it now always passes one.
- `src/app/api/orders/[id]/documents/route.ts` now reads `const user = requireUser()` and calls
  `listDocuments(id, user)` instead of `listDocuments(id)`.

**Test.** New describe block in `tests/documents.test.ts`, `"listDocumentsForOrder drops kinds the
caller may not view"` (5 tests): a service-level test building a `PermUser` directly and asserting
an `orders.view`-only viewer sees only the TRAVELER, a viewer with all three areas sees all three
documents, and a viewer with none sees nothing; a service-level test confirming an omitted `viewer`
stays unfiltered; and three route-level tests against the real `GET /api/orders/[id]/documents`
handler with real sessions (`signInWith`) — an `orders.view`-only session sees the traveler and not
the BOL or the cert (the reviewer's exact scenario), a session holding all three areas sees every
kind, and a session missing `orders.view` (even while holding `shipping.view`/`certs.view`) still
403s at the route's own gate.

```
$ npx vitest run tests/documents.test.ts
 ✓ tests/documents.test.ts (27 tests) 2033ms
 Test Files  1 passed (1)
      Tests  27 passed (27)
```
(same run as Important 1 — both fixes landed in the same test file pass.)

### Minor 3 — `AREA_BY_KIND` should be `Record<DocumentKind, Area>`

Folded into Important 2's fix: rather than keep a second, separately-typed map in the route,
`AREA_FOR_KIND: Record<DocumentKind, Area>` now lives once in `src/server/documents.ts` (exported)
and both `src/app/api/documents/[docId]/route.ts` and `listDocumentsForOrder`'s filtering read the
same constant. A fifth `DocumentKind` value added to the Prisma enum without a corresponding entry
here is now a `tsc` compile error, not a runtime fail-closed 403 discovered later.

### Covering tests re-run

```
$ npx vitest run tests/documents.test.ts
 ✓ tests/documents.test.ts (27 tests) 2033ms
 Test Files  1 passed (1)
      Tests  27 passed (27)

$ npx vitest run tests/traveler.test.ts
 ✓ tests/traveler.test.ts (28 tests) 3670ms
 Test Files  1 passed (1)
      Tests  28 passed (28)
$ git diff --stat tests/traveler.test.ts
(empty — file is still byte-identical to main)
```

`GET /api/orders/[id]/documents` is covered by both `tests/traveler.test.ts` (unchanged: "GET
/api/orders/[id]/documents lists, GET /api/documents/[docId] streams the bytes", still green) and
the new permission-filtering describe block in `tests/documents.test.ts` above, which is the file
that specifically covers this route's new filtering behavior.

### Gates re-run

```
$ npm test
 Test Files  78 passed (78)
      Tests  1058 passed (1058)

$ npx tsc --noEmit
(clean)

$ npx eslint src tests
(clean)

$ npm run build
✓ Compiled successfully
```

### Files changed (round 2, on top of round 1)

- `erp/src/server/documents.ts` — `AREA_FOR_KIND`, `listDocumentsForOrder(orderId, viewer?)`,
  `documentFilename`'s `CERT` branch now uses `orderNumber`, new `resolveDocumentFilename`.
- `erp/src/app/api/documents/[docId]/route.ts` — gates via the shared `AREA_FOR_KIND`; names the
  download via `await resolveDocumentFilename(doc)`.
- `erp/src/app/api/orders/[id]/documents/route.ts` — passes the session user through to
  `listDocuments(id, user)`.
- `erp/tests/documents.test.ts` — 11 new tests (27 total, up from 16): 6 for the filename
  regression, 5 for permission-filtered listing; 1 existing test extended for the `CERT`
  filename convention change.
