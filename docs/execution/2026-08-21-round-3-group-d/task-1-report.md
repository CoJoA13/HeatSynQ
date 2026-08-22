# Task 1 report — Round 3 Group D (#158)

Branch `round-3-group-d`. All commands from `erp/`.

## 1. The RED sweep's output — the enumerated work-list

The page-keyed sweep was written first and run before any wiring. Its failure, verbatim:

```
 FAIL  tests/audit-children.test.ts > #158 — a page with a panel that mutates must invalidate > every panel-mounting file that mutates imports and calls invalidateHistory
AssertionError: expected [ …(9) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/app/admin/step-codes/page.tsx must import invalidateHistory",
+   "src/app/admin/surcharges/page.tsx must import invalidateHistory",
+   "src/app/certs/[id]/CertDetail.tsx must import invalidateHistory",
+   "src/app/invoicing/[id]/InvoiceDetail.tsx must import invalidateHistory",
+   "src/app/orders/[id]/page.tsx must import invalidateHistory",
+   "src/app/processes/templates/[id]/page.tsx must import invalidateHistory",
+   "src/app/quotes/[id]/QuoteDetail.tsx must import invalidateHistory",
+   "src/app/shipping/[id]/ShipmentDetail.tsx must import invalidateHistory",
+   "src/components/ReferenceTable.tsx must import invalidateHistory",
+ ]
```

Nine files, enumerated by the tool. It matches the brief's measured census exactly — twelve
panel-mounting files, three already wired. **Every one of the twelve mutates**, so today's
allowlist is empty.

## 2. The three recorded decisions

### Decision 1 — what counts as "issues a mutating request"

**A word-bounded, case-sensitive `POST|PUT|PATCH|DELETE` token anywhere in the file**
(`MUTATING_TOKEN`, `tests/audit-children.test.ts:241`). Deliberately an *over*-match rather than
`method: "POST"`.

Reasoning: a precise regex is the failure mode being fixed, one level up. Over-matching fails
**closed** — a mutation built from a variable (`method: del ? "DELETE" : "PUT"`), an init object
hoisted above the call, or a shape nobody has invented yet still carries one of these four words,
and the file is then called mutating and must wire. `\b` excludes `PUT` inside `INPUT`/`OUTPUT` and
`POST` inside `POSTED`; case-sensitivity excludes prose ("Delete", "post"). The cost of
over-matching is a false positive, and Decision 2's allowlist is where a false positive gets
written down with a reason rather than silently exempting the file.

Two **loud** guards back it (`tests/audit-children.test.ts:244-257`, asserted at `:308-321`):

- every `method:` value in a panel-mounting file must be one of the seven HTTP-method **string
  literals** — anything else (a variable, a ternary, a spread) is an unclassifiable shape and
  fails the sweep by name;
- `OPAQUE_TRANSPORT` fails on `sendBeacon`, `XMLHttpRequest`, `formAction`, `useActionState`,
  `useFormState`, and `<form action=` — transports that carry no HTTP-method literal at all. None
  is used anywhere in this codebase today (verified by grep across `src/`); their appearance means
  the detection has gone blind.

**What it would still miss, stated plainly:** a mutation issued by an **imported helper** whose
calling file contains none of those tokens. Nothing static can see that, and I did not pretend to.
The guards cover transports, not indirection. (Minor, accepted: because the `method:` guard scans
raw source, a future *comment* containing `method: something` would trip it. That is a loud false
positive, which is the side to err on.)

### Decision 2 — how a panel-mounting page with no mutation is excluded

`NON_MUTATING_PANEL_PAGES` (`tests/audit-children.test.ts:268`): a `Record<file, reason>`, **empty
today**. An exclusion is an entry with a reason, never a silent absence — a file that drops out of
the census by being forgotten looks identical to one that is genuinely read-only.

It cannot rot into a blanket exemption: `tests/audit-children.test.ts:338-346` fails an entry whose
reason is a stub, an entry naming a file that no longer mounts a panel, and — the load-bearing one
— an entry whose file *does* mutate. The mechanism exists so the FIRST read-only panel page is
written down rather than discovered by its absence.

### Decision 3 — the page-keyed sweep sits BESIDE the entity-keyed one

Not a replacement. The division is stated in the test file itself
(`tests/audit-children.test.ts:272-299`) and repeated here:

- **Page-keyed (`#158`)** is complete over the files that MOUNT a panel — the file set is derived
  from the tree by `panelMountingFiles()`, so there is no list to under-fill. It catches (a) the
  parent-own gap in #158's title, including the five panel entities with no registered children at
  all (`cert`, `shipper`, `quote`, `processTemplate`, `processStepCode`, plus the reference kinds),
  which the entity map cannot express at all; and (b) a SECOND page writing an already-covered
  child entity, which the "at least one file" rule cannot see — the live
  `admin/surcharges/page.tsx` break the owner found, while the entity map stayed green.
- **Entity-keyed (`#153`)** catches what the page sweep cannot see: a file that mounts NO panel but
  writes a registered child of a panel mounted elsewhere — every `parts/[id]/*Section.tsx`,
  `customers/[id]/SurchargeOverridesSection.tsx`. Nothing in the page sweep looks at those files.

`INVALIDATION_SITES` keeps its exact-key-equality assertion against the registered **child** set
unchanged (no parent keys added, so it stays green by construction). Two edits to it:

- `src/app/admin/surcharges/page.tsx` added to `customerSurcharge`'s list
  (`tests/audit-children.test.ts:164-170`) — truthful now that it wires.
- its header now says the per-entity lists are **best effort** and the check requires only one
  named file (`tests/audit-children.test.ts:142-152`), because "every file that writes this
  entity" is not derivable from source. Claiming completeness there would be a comment claiming
  more than the test delivers.

## 3. What changed per file, and which mutation each call sits on

Criterion for placing a call: **a mutation that leaves a panel MOUNTED and stale.** Actions that
navigate away (`router.push`) or unmount the panel (delete-then-deselect) are skipped and listed
below with the reason — the `customers/[id]/page.tsx` precedent is selective the same way (4 calls
across 10 mutations).

Where a page has a shared success seam (`applyMutation`, `save`, `call`), the call goes **there**,
once, rather than at each site.

| File | `file:line` | Mutation whose success path it sits on |
|---|---|---|
| `src/app/admin/step-codes/page.tsx` | `:148` | `save()`'s `PUT /api/admin/step-codes/{id}` — the shared seam for every scalar edit, active toggle and field-def change on the selected code (`processStepCode`, the panel's entity) |
| `src/app/admin/surcharges/page.tsx` | `:157` | `save()`'s `PUT /api/admin/surcharges/{id}` — every scalar edit (`surcharge`) |
| | `:195` | `toggleStepCode()`'s `PUT …/step-codes` — the replace-grid audited through the surcharge itself (`SNAPSHOT_INCLUDE.surcharge`) |
| | `:278` | `clearCustomerOverride()`'s `DELETE /api/customers/{id}/surcharges` — **the owner's live #153 child-contract break**; `customerSurcharge` is a registered child of `surcharge` |
| `src/components/ReferenceTable.tsx` | `:158` | `toggleFlag()`'s `PUT /api/admin/reference/{kind}/{id}` — the row stays on screen, its per-row panel mounted; an `isDefault` flip also demotes a sibling row (global signal covers it) |
| `src/app/processes/templates/[id]/page.tsx` | `:108` | `saveName()` `PATCH` |
| | `:129` | `toggleActive()` `PATCH` |
| | `:168` | `addStep()` `POST …/steps` |
| | `:184` | `saveBoilerplate()` `PATCH …/steps/{id}` |
| | `:199` | `removeStep()` `DELETE …/steps/{id}` |
| | `:216` | `move()` `POST …/reorder` |
| `src/app/certs/[id]/CertDetail.tsx` | `:271` | `patchNotes()`'s `PATCH /api/certs/{id}` (`auditedUpdate("cert", …)`) |
| | `:305` | `saveReadings()`'s `PUT …/results` (`auditedUpdate("cert", …)`, cert-results.ts:105/298) |
| | `:343` | `printCertAction()`'s `POST …/print` — the FIRST print stamps `printedAt` through `auditedUpdate("cert", …)` (certs.ts:762); a reprint writes no cert row |
| | `:392` | `voidAction()`'s `DELETE` (`auditedSoftDelete("cert", …)`, page stays mounted read-only) |
| `src/app/invoicing/[id]/InvoiceDetail.tsx` | `:480` | `applyMutation` — the shared seam for the lines save, the header `PATCH`, Recalculate, Finalize and Unlock (all `auditedUpdate("invoice", …)`). Placed **before** the `mutations.accept` gate: the server state changed even when the response is superseded |
| | `:671` | `discard()`'s `DELETE` (`auditedSoftDelete`, page stays mounted read-only) |
| `src/app/orders/[id]/page.tsx` | `:245` | `applyMutation` — covers the header `PATCH`, Link and Unlink here **and every write the five co-located sections make through the same callback** (`LinesSection`, `ContainersSection`, `SerialsSection`, `ChargesSection`, `LoadsSection`), all of which are the order's own before/after diff. Before the accept gate |
| | `:442` | `voidAction()`'s `DELETE` (`auditedSoftDelete("order", …)`, page stays mounted read-only) |
| `src/app/quotes/[id]/QuoteDetail.tsx` | `:293` | `save()`'s `PATCH` — one `auditedUpdate("quote", …)` wraps header + the whole lines/prices/breaks tree |
| | `:328` | `closeQuote()`'s `POST …/close` |
| | `:365` | `reopenQuote()`'s `POST …/reopen` (rewritten from `adopt(await api(...))` to a named binding so the signal precedes the adopt) |
| | `:577` | `attachPart()`'s `POST …/attach-part` (`auditedUpdate("quote", …)`, quotes.ts:1404) |
| `src/app/shipping/[id]/ShipmentDetail.tsx` | `:324` | `applyMutation` — the header `PATCH`, Add order, Remove order, **and every write `ShipmentOrderPanel` makes through the same callback**. Before the accept gate |
| | `:423` | `printDoc()`'s `POST …/print` — the FIRST BOL print allocates `bolNumber` through `auditedUpdate("shipper", …)` (shippers.ts:2463) |
| | `:666` | `voidAction()`'s `DELETE` (`auditedSoftDelete("shipper", …)`, page stays mounted read-only) |
| `src/app/receivables/batches/[id]/BatchDetail.tsx` | `:437` | `applyMutation` — add payment, void payment, post, reopen. Before the accept gate |
| | `:614` | `voidBatchAction()`'s `DELETE` — does NOT route through `applyMutation` (it answers `{ ok: true }`), page stays mounted read-only |

Two of these seams (`orders/[id]/page.tsx`, `shipping/[id]/ShipmentDetail.tsx`) reach beyond the
panel-mounting file into co-located section components, because those sections mutate through the
page's own callback rather than issuing their own request. That was not planned; it fell out of
wiring the shared seam and it materially shrinks the residual gap in §7.

### Skipped deliberately (a mutation with no stale mounted panel)

- `step-codes` `add()` / `removeCode()` — a create selects nothing; a delete does
  `setSelected(null)`, which unmounts the panel.
- `surcharges` `add()` / `removeRow()` — same two shapes.
- `ReferenceTable` `add()` / `remove()` — a created row has no open panel; a deleted row leaves
  `rows`, so its inline panel unmounts.
- `processes/templates` `removeTemplate()` — `router.push("/processes")`.
- `invoicing` `raiseCredit()` — `router.push` to the new credit; `createCredit` writes only the new
  credit's row, never the source invoice's (invoices.ts:1806).
- `invoicing` `printInvoice()` and `quotes` `printQuote()` — verified: both write only a
  `storedDocument` row, and `storedDocument` deliberately rolls into no panel (audit-children.ts
  scope note). Contrast the cert and BOL prints above, which do stamp their parent.
- `quotes` `deleteQuote()` — `router.push("/quotes")`.
- `shipping` `reverseAction()` — `router.push` to the reversal.

## 4. `BatchDetail.tsx`'s redundant calls were DELETED

`applyMutation` (`:437`) now carries the call, so the two per-mutation calls were **removed**, not
left alongside:

- `addPayment()` — the former `invalidateHistory(); // #14 item 1 — payment is a registered child…`
- `voidPaymentAction()` — the former `invalidateHistory(); // #14 item 1`

Both are `-` lines in the diff. The file's count went 4 → 4 for a different reason: two deleted,
two added (`applyMutation` + `voidBatchAction`). The **other** two calls in that file (`:225`, `:251`) are in the `PaymentApplyPanel` sub-component, which does *not* route through
`applyMutation` (verified: only four call sites use it, all in `BatchDetail` itself) — those are
not redundant and stay.

## 5. Tests added or changed, and which were RED-verified

All in `tests/audit-children.test.ts`. New describe: `#158 — a page with a panel that mutates must
invalidate`.

| Test | RED-verified how |
|---|---|
| `every panel-mounting file that mutates imports and calls invalidateHistory` | **Yes** — ran before any wiring; output in §1 (9 files) |
| `understands every request shape in the panel-mounting files` | **Yes** — temporarily rewrote `orders/[id]/page.tsx`'s void as `{ method: verb, … }`; failed with `"src/app/orders/[id]/page.tsx: method: verb"`, then restored |
| `finds the panel-mounting files by walking the tree` | **Yes** — temporarily changed the walk's extension filter to `.no-such-ext`; failed, then restored |
| `the mutation detector matches every shape it claims to, and no prose` | **Yes** — temporarily narrowed `MUTATING_TOKEN` to `/\bPOST\b/`; failed, then restored |
| `every allowlisted page really mounts a panel and really does not mutate` | **Yes** — temporarily allowlisted `orders/[id]/page.tsx` with a reason; failed on the "it mutates" assertion, then restored |

Changed: `INVALIDATION_SITES.customerSurcharge` gained a second file, and the map's header comment
now states the "at least one file / best effort" limitation. Its two existing checks are unchanged
and still pass.

Not added, and deliberately: no `renderToStaticMarkup` test. Five suites in this repo do render
`.tsx`, but invalidation is an **effect**, not initial markup — such a test could not reach this
defect, and writing one would be theatre.

## 6. What the sweep cannot pin

Stated in the test file at `tests/audit-children.test.ts:289-299`, and true as written:

- It **cannot** prove the call sits on the success path of the **right** mutation. It proves the
  file imports the symbol and calls it somewhere.
- It **cannot** prove a mounted panel actually refetches — there is no DOM test environment here.
  The listener register/invalidate/unsubscribe contract is pinned separately in
  `tests/history-invalidation.test.ts`, and `HistoryPanel`'s own effect subscribes through that
  same export, so the tested path is the wired path; the join between "invalidate fires" and "this
  panel re-renders" is unpinned by construction.
- Neither sweep sees a mutation issued through an **imported helper** carrying none of the four
  tokens in the calling file.

The equivalent statement on the older entity-keyed describe was left in place and is still
accurate; the new one does not repeat its claims more strongly.

## 7. Adjacent defect noticed and NOT fixed — recommend a follow-up issue

The rule this group implements is *file*-scoped: a file that mounts a panel and mutates must
invalidate. A **co-located section component** that mutates, on a page whose `page.tsx` mounts the
panel, is outside it — and is the same live defect one directory over.

Measured on the post-fix tree, section files that mutate and still have **zero** invalidations:

```
3 mut, 0 inv  src/app/customers/[id]/ReceivablesSection.tsx     (writes `application`; the customer
                                                                 panel does not register it — no
                                                                 stale panel, correctly absent)
3 mut, 0 inv  src/app/orders/[id]/CertificationsSection.tsx
1 mut, 0 inv  src/app/orders/[id]/ChargesSection.tsx  *
1 mut, 0 inv  src/app/orders/[id]/ContainersSection.tsx  *
1 mut, 0 inv  src/app/orders/[id]/DocumentsSection.tsx
1 mut, 0 inv  src/app/orders/[id]/InvoicesSection.tsx
4 mut, 0 inv  src/app/orders/[id]/LinesSection.tsx  *
2 mut, 0 inv  src/app/orders/[id]/LoadsSection.tsx  *
1 mut, 0 inv  src/app/orders/[id]/SerialsSection.tsx  *
3 mut, 0 inv  src/app/shipping/[id]/ShipmentOrderPanel.tsx  *
```

`*` = **already covered in practice** by this task, because those writes go through the page's
`applyMutation`, which now invalidates. They carry no call of their own, so a *directory*-scoped
sweep would still flag them.

Genuinely uncovered and worth a ruling: `orders/[id]/CertificationsSection.tsx`,
`orders/[id]/DocumentsSection.tsx`, `orders/[id]/InvoicesSection.tsx` — these issue their own
requests. Whether they should invalidate depends on the audit-children scope call already recorded
(child DOCUMENTS deliberately do NOT roll into the order panel), so this is a question for the
owner, not something to decide here. I did not widen the sweep to directory scope: the brief's
census is file-scoped and was measured deliberately, and widening it would change the group's
stated shape without a ruling.

## 8. Docs not updated — flagged rather than edited

Two doc touch-points that a group close should carry, which I did not make:

1. **`CLAUDE.md`**, audit paragraph: it currently says the wiring contract is pinned by
   "`tests/audit-children.test.ts`'s `INVALIDATION_SITES` manifest". That is now one of **two**
   sweeps; the sentence should also name the page-keyed one ("a client file that mounts a
   `<HistoryPanel>` and issues a mutating request must import and call `invalidateHistory`").
2. **`docs/HANDOFF.md`** — the group-close entry.

I did not edit `CLAUDE.md` myself: it is the project's operating instruction file, and my task
brief is an agent message, which cannot authorize changing it. Owner/parent call.

## 9. Gates

```
npx tsc --noEmit                                   exit 0
npx eslint src tests                               exit 0
DATABASE_URL_TEST=…erp_test_d1 npx vitest run      208 files, 3542 tests, all passing (431s)
```

`npm run test:e2e` **not run** — reserved for group close per the brief (and #184).
