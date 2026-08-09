# Task 15 — implementation report

**Commit:** (to be filled in after commit — see bottom)

## What was built

### 1. Backend endpoints added

Two new read endpoints, both thin `handle(...)` wrappers delegating to a service function —
neither re-derives balance math.

- **`GET /api/receivables/statements/documents?customerId=`**
  (`src/app/api/receivables/statements/documents/route.ts`) — every `STATEMENT` document archived
  for a customer, newest first. Gated `receivables.view` (the build/print route's own gate).
  400s a missing `customerId`. Delegates to a new `listDocumentsForCustomer(customerId)` in
  `src/server/documents.ts`, added alongside the existing `listDocumentsForShipper`/
  `listDocumentsForCert`/`listDocumentsForInvoice` — `customerId` is a column only the `STATEMENT`
  kind ever populates (`ownerColumns`'s existing mapping), so no kind filter is needed, the same
  reason `listDocumentsForShipper` needs none for its `SHIPPER`/`BOL` pair. It does **not** filter
  the owning customer on `deletedAt: null` — matches the `listDocumentsForOrder`/`listDocumentsForShipper`/
  `listDocumentsForCert` precedent: a deleted customer's past statements stay listable forever
  (spec §5.6's "voided owner, still-reprintable paper" rule). 404s an unknown customer id.

  I considered folding this into the *existing* `GET /api/receivables/statements` (which already
  takes `customerId` for the build-preview). Rejected: that route already has a fixed, different
  response shape (`StatementData`, a preview) keyed off the same `customerId` param — overloading
  it on the presence/absence of other query params would mean branching the response shape, which
  is exactly the kind of ambiguity `CLAUDE.md`'s "handlers stay thin" principle warns against. A
  sibling route under `statements/` mirrors the *shape* of the precedent (`GET
  /api/invoices/[id]/documents`) without needing a fake `[id]` segment for something that isn't
  its own persisted entity.

- **`GET /api/customers/[id]/receivables`** (`src/app/api/customers/[id]/receivables/route.ts`) —
  the customer page's A/R summary: net balance + the five aging buckets + Unapplied, and the open
  items list. Gated `receivables.view`, **not** `customers.view` — this is A/R data, matching the
  `aging`/`applications` GET routes' own gate, not customer master data. Delegates to a new
  `customerReceivablesSummary(customerId)` in a new leaf file, `src/server/customer-receivables.ts`:

  ```ts
  export async function customerReceivablesSummary(customerId: string): Promise<CustomerReceivablesSummary> {
    const [rows, openItems] = await Promise.all([
      agingReport({ customerId }),
      openInvoicesForPayer(customerId),
    ]);
    const aging = rows.find((r) => r.customerId === customerId);
    if (!aging) throw new HttpError(404, "Customer not found");
    return { aging, openItems };
  }
  ```

  Composes Task 10's `agingReport` and Task 13's `openInvoicesForPayer` — no balance arithmetic of
  its own. `agingReport({ customerId })` always returns a row keyed on that same id (the
  customer's own row when childless, or the synthesized family-total row — still keyed on the
  parent's id — when it has live children), so this always answers "this customer's" net/buckets,
  rolled up with family when the customer is itself a family head. `openInvoicesForPayer` already
  resolves the payer's family independently. Kept as its own file (the `invoice-guards.ts`
  precedent CLAUDE.md names) rather than added to either `aging.ts` or `applications.ts`, since
  neither of those two modules imports the other today and I didn't want to create that coupling
  for a two-call composition. 404s an unknown customer.

Both routes were tested happy-path + 403 (plus 401 and 404 for the customer route, matching that
file's existing style):

- `tests/receivables-routes.test.ts` — 3 new tests under `describe("GET
  /api/receivables/statements/documents")`: missing-`customerId` 400, 403-then-200 (empty list,
  then one row after a real print via the existing `POST /api/receivables/statements` route,
  asserting the `x-document-id` header matches the listed row), and 404 for an unknown customer.
- `tests/customer-routes.test.ts` — 2 new tests: 401/403/200 with a real FINALIZED invoice
  (asserts `aging.net`/`openItems[0].open` both read 400, matching the seeded invoice total), and
  404 for an unknown customer.

### 2. Statements screen (`src/app/receivables/statements/{page.tsx,Statements.tsx}`)

Client component, `"use client"`, gated `receivables.view` for everything except the "Run for
everyone" button (`receivables.create`, matching the run route's own gate exactly). `page.tsx` is
the plain `export default function StatementsPage() { return <Statements />; }` wrapper, the
`receivables/aging/page.tsx` precedent.

- **Selection**: customer/family `<select>` (fed by `/api/customers`, gated `customers.view` —
  the `AgingReport.tsx` picker precedent), an as-of `<input type="date">`, a "Combine family"
  checkbox, and an "Assess finance charges" checkbox — **off by default**, per the brief.
- **Preview**: once a customer is picked, `GET /api/receivables/statements?customerId=&asOf=&combineFamily=&assessFinanceCharges=`
  (Task 12's `buildStatement` — a build-only preview, no archive) renders the aging strip, the
  open-items table, an optional finance-charge line, and the total due — so the operator sees
  what they're about to print before committing to it.
- **Print (single)**: `POST /api/receivables/statements` with the same four fields, the
  `InvoiceDetail.tsx` `printInvoice` fetch-blob-and-open-a-tab precedent exactly (handles a
  popup-blocked browser by naming the fallback — "already archived, see Documents below" — instead
  of silently failing).
- **Run for everyone with a balance**: `POST /api/receivables/statements/run` with `{asOf,
  assessFinanceCharges}` (no `combineFamily` — the run route's own schema doesn't accept it;
  `runStatements` never combines family, per that function's own header comment). Confirms via
  `confirm()` before firing (a plant-wide bulk print), then reports how many statements were
  archived.
- **Documents**: `StatementDocumentsList`, the `InvoiceDocumentsList` precedent, scoped by
  `customerId` against the new `GET /api/receivables/statements/documents` route, each row linking
  to `/api/documents/<id>`. Refreshed (via a `refresh` counter prop) after every successful single
  print or run — a just-archived statement appears without a reload.
- `?customerId=` in the URL preselects the customer — how the customer page's new "Statement" link
  arrives here with its target already chosen, rather than making the operator pick again.
  `useSearchParams()` needs a `Suspense` boundary during prerender (Next requirement), so
  `Statements` wraps the real screen the same way `orders/[id]/page.tsx`'s `OrderHubPage` does.

### 3. Customer A/R section (`src/app/customers/[id]/ReceivablesSection.tsx`)

Mounted in `src/app/customers/[id]/page.tsx` right before `HistoryPanel` (the order hub's
`InvoicesSection` placement — last operational section before history). Follows
`InvoicesSection.tsx`'s exact shape: fetch-into-state on mount via `GET
/api/customers/[id]/receivables`, a `loaded` flag distinct from "empty" (HANDOFF §5.15), ticket-
gated on both the success and rejection path (`useLatest`), and a §5.16 permission-denied message
in place of a silently empty section when the caller lacks `receivables.view`.

Renders: net balance, the inline aging strip (five buckets + Unapplied + Net, reusing
`AGING_BUCKETS`/`AGING_BUCKET_LABELS` from `src/lib/ar-constants.ts`), the open-items table (each
row linking to `/invoicing/[id]`), and two links — **"Statement"** (`/receivables/statements?customerId=<id>`)
and **"Apply payment"** (`/receivables`, the batch worklist — see Concerns below for why there's
no more specific target).

`viewGate: Gate` is passed in from the page (computed there as `gate(perms, "receivables.view")`),
the same convention `InvoicesSection`/`ShipmentsSection` use — not the raw-`perms`-array
convention `SurchargeOverridesSection` uses; both exist in this codebase and the brief named
`InvoicesSection` as the explicit precedent to follow.

### 4. The `/receivables` sub-nav (`src/app/receivables/ReceivablesNav.tsx`)

Closes the gap Task 14 flagged (nothing linked to `/receivables/aging` or `/receivables/statements`
before this task). A small client component — three `<Link>`s (Batches/`/receivables`,
Aging/`/receivables/aging`, Statements/`/receivables/statements`) with an active-tab underline,
mirroring `Shell.tsx`'s own `navIsActive` (exact match for the section root, prefix match for
sub-pages) at a smaller scale, since no other multi-page area in this app has its own sub-nav to
copy from directly. Mounted at the top of all three screens: `ReceivablesList.tsx`,
`AgingReport.tsx` (both branches — the permission-denied early return and the main render), and
`Statements.tsx` (same two branches). **Not** mounted on `/receivables/batches/[id]` — the brief
scoped the sub-nav to the three list-level screens only.

## Gates (all foreground, per the brief)

- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm run build` — clean; `/api/customers/[id]/receivables`, `/api/receivables/statements/documents`,
  and `/receivables/statements` (static, `○`) all appear in the route manifest.
- `npm test` — run once at the end (backend endpoints were added). Exceeded the 120s foreground
  shell timeout and was auto-moved to background by the tool; I did not poll or start a second run
  against the shared test DB — waited for the tool's own completion notification, then read the
  finished output. **120/120 test files, 1854/1854 tests passed**, including
  `tests/receivables-routes.test.ts` (17 tests, +3 new) and `tests/customer-routes.test.ts`
  (8 tests, +2 new).

No dev server was started (host resource constraints, per the parent instructions); browser
verification is deferred to Task 17's E2E as directed — the brief's own Step 3 was skipped for the
same reason.

## Self-review

- Every new client file is a local mirror of its server-side row shape, none import from
  `src/server/**` — verified by grep (`grep -rn "@/server" src/app/receivables/statements
  src/app/customers/\[id\]/ReceivablesSection.tsx` returns nothing).
- Both new routes gate `receivables.view` (or, for the run action, `receivables.create` —
  unchanged, matching the existing run route); the customer summary route deliberately does *not*
  couple to `customers.view`, matching `aging`/`applications`'s own precedent that A/R data lives
  behind the A/R permission, not the customer-master permission.
- `assessFinanceCharges` defaults to `false` (unchecked) on the statements screen, per the brief.
- No balance arithmetic was written in either new endpoint or either new component — every money
  figure traces back to `agingReport`, `openInvoicesForPayer`, or `buildStatement`/`printStatement`/
  `runStatements`, all pre-existing.
- Decimal→number: neither new route touches a `Decimal` directly — `agingReport` and
  `openInvoicesForPayer` already return plain numbers, and `listDocumentsForCustomer` returns
  `DocumentMeta` (no money fields at all).
- The sub-nav's active-tab logic was checked against all three mount points, including both
  branches of `AgingReport.tsx` and `Statements.tsx` that return early on a permission denial —
  both branches also render the nav, so a caller without `receivables.view` can still navigate
  between the three screens (each of which independently reports why it's blocked) rather than
  getting stuck on whichever one they landed on first.
- Confirmed the new customer-receivables route does not filter or expose anything beyond what
  `agingReport`/`openInvoicesForPayer` already return to any other `receivables.view` holder
  (`GET /api/receivables/aging?customerId=`, `GET /api/receivables/applications?customerId=`) — no
  new information disclosure surface.

## Concerns / follow-ups (none blocking)

- **"Apply payment" has no more specific target than the batch worklist.** Applying a payment in
  this codebase happens inside `BatchDetail.tsx`'s own per-payment "Apply" expander, keyed to one
  *existing* payment row within one *existing* batch — there is no standalone "apply a payment for
  customer X" screen or deep-link target to route to. The customer-page link therefore lands on
  `/receivables` (the worklist, where a batch/payment gets created), not a customer-scoped apply
  flow. Flagging this as a scoping gap in the existing apply UI rather than guessing at a new
  target — building a customer-preselected apply flow would be new scope beyond this task's brief.
- **The customer/family `<select>` on the statements screen omits inactive customers** (plain
  `/api/customers`, no `?includeInactive=1`) — the same tradeoff `AgingReport.tsx`'s picker and
  `BatchDetail.tsx`'s payer picker already accept, not something this task introduced or was asked
  to fix.
- **A `?customerId=` deep link to an inactive/family-scoped customer** could preselect an id that
  never appears as an `<option>` in the (active-only) dropdown — the `<select>`'s value would then
  match nothing displayed, though the preview/documents fetch still uses the raw `customerId`
  state correctly regardless. Same class of edge case as the two items above; not fixed here for
  the same reason.
