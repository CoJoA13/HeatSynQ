# Round 2 Group I — the ready issues — brief

Branch `group-i-ready-issues`, opened 2026-08-19 from `8c353e3`. Issues in this PR: **#69, #8,
#137, #77, #153**. Round 2's grouped work had closed and the whole remaining backlog was
owner-gated; the owner answered eleven questions on 2026-08-19, six of which closed or
scoped issues outright (#134, #4, #71 closed; #69, #8, #153 ruled) and four of which shaped
the work below. Five-agent recon ran at HEAD before any code; its corrections are the whole
first half of this brief, because **two of them changed what the work IS**.

## The two recon findings that changed the work

1. **#8 was ruled against stale documentation, and is already built.** `deleteRole` has
   required a reason since **2026-08-01** (`47d6d0a`, Phase 2C-1): service-enforced
   (`roles.ts:63-70` — trims, refuses empty with a field-anchored 400, passes `why` to
   `auditedSoftDelete`), route reads the body, UI prompts. Its own JSDoc states the owner's
   exact ruling — "carries the role's permission grants away, and frees the role name for
   reuse" — and records why every-delete was rejected. HANDOFF §5.17's "(still to build)" is
   what was stale. **Owner ruling on the correction (2026-08-19): close it as already
   satisfied**, keeping the doc corrections and a regression pin. Recon then found one real
   (small) defect worth the pin: the route hand-rolls its body read, so a literal `null` JSON
   body throws a TypeError out of the handler instead of the 400 every sibling route returns.
2. **#69's arithmetic was put to the owner wrongly the first time.** The original question's
   example was flat-percent-of-cash, which strands $0.40 on the ordinary case (a $1,000
   invoice at 2/10 settled by a $980 remittance) and contradicts both the 5B design spec
   ("× the amount being **settled**") and a pinned test. Re-asked with the numbers. **Owner
   ruling: the discount is earned ONLY on a full early payment.** A partial payment inside
   the window earns nothing at all. That is a *settlement guard*, not the pro-rata basis
   change recon designed — the open-balance basis it already computes is correct, and the new
   rule is that a DISCOUNT must close the invoice. It also removes #69 from `applications.ts`'s
   deep water, which is what lets #77 have that file to itself in wave 2.

## Owner rulings this group implements (spec §15 carries #69/#8; see the issues for the rest)

- **#69 — the discount is earned only by a payment that SETTLES the invoice.** Partials earn
  nothing. **The reading being implemented, stated so it can be corrected:** the *settling*
  payment must fall inside the window (the window has always lived on the payment's
  `receivedDate`), and the eligible figure is the percentage of the **remaining open
  balance** — so a customer who part-paid earlier may still settle the remainder early and
  earn the percentage on what remains. The frozen `termsDiscountPercent`/`termsDiscountDays`
  (#79) stay the only percentage source, still with no fallback to the live customer relation.
- **#8 — close as already satisfied**, with the doc corrections and a regression pin.
- **#153 — build the union read, no schema and no backfill.**
- **#77 — the write-off must be undoable from the screen that made it** (owner, 2026-08-19),
  and its **amount is editable, defaulting to the full open balance**.

## Controller calls (recon-grounded; no owner input needed)

- **#77's date is `todayDateOnly()`, not operator-chosen** (recon's own recommendation,
  matching `applyCredit`): a backdate into an *open* prior month silently moves that month's
  aging buckets and roll-forward. `assertPeriodOpen` would permit it; we decline it.
- **#77's GL question does not exist**: 5C ruling 3 already pinned ONE write-off account
  (`BillingConfig.writeOffGlAccountId`) and explicitly ruled the residual-vs-bad-debt split
  out. A standalone write-off posts DR write-off / CR A/R identically. No chart change.
- **#137 fix 2 is a tri-state, not a deletion**: `familyLookup: "pending" | "known" |
  "unknown"` keeps round 4's protection while the lookup can still answer and falls open
  otherwise. **Also render the customer's code/name in the Preview header** — once the gate
  falls open, a `receivables.view`-only user has no other way to see who they are printing
  for (the payload already carries it).
- **#137's residual all-failed-200 shapes** (a missing published STATEMENT template, a corrupt
  `invoice_number_prefix`) are the same "failing while reporting success" class but are NOT
  parse errors and are out of this issue's stated scope → **file as a follow-up issue at
  close-out**, do not widen.
- **#153 scope**: `storedDocument` rows do NOT roll into panels (prints are already listed by
  each page's DocumentsSection, and one row per reprint would drown the edit history); child
  DOCUMENTS (cert/shipper/invoice) do NOT roll into the ORDER panel (each has its own page and
  panel); the read is **capped at 200** with an explicit "showing the most recent N" line —
  silent truncation is the same class of lie as a "No history" on a 403.
- **#8's recorded tension is settled, do not re-litigate**: every reference kind technically
  frees a partial-unique identifier, but §5.14 blocks deleting a reference row anything points
  at, so a permitted delete clears nothing — the owner's own text subordinates that arm, and
  spec §15 names the revisit trigger.
- Two adjacent CONCURRENCY findings recon surfaced under #8 are **out of scope and get filed at
  close-out**: `deleteRole`'s holder count is a pre-transaction read at default isolation while
  `users.ts` sets `roleId` with no in-transaction liveness read (both sides can commit, leaving
  a live user pointing at a soft-deleted role — no SSI pairing like `createPart`↔`deleteCustomer`
  has); and `users.ts:105` resolves a soft-deleted role's permissions for the lockout guard.

## Tasks — two waves

**Wave 1 (parallel — file-disjoint):**

- **Task 1 — #69 + #8.** *#69*: the eligible figure stays `pct × open balance`; add the
  **settlement requirement** at BOTH sites. (a) `discountAvailable` (`applications.ts:128-148`)
  offers the figure only when this payment's unapplied cash can actually settle the remainder
  (cash ≥ open − eligible); otherwise it offers nothing. (b) `applyPayment`'s independent cap
  in `resolveReason` (`:582-596`) refuses a DISCOUNT unless the invoice lands at **exactly
  zero** — cash + discount == open — naming the rule. **LOAD-BEARING**: pre-aggregate
  `payCentsByInvoice` from `data.lines` BEFORE the sequential line loop; deriving "cash so far"
  inside the loop makes the answer depend on payload ORDER (`[DISCOUNT, PAYMENT]` refused,
  `[PAYMENT, DISCOUNT]` allowed). Keep the #81 total-based ceiling as the belt. The two-step
  flow (a DISCOUNT-only follow-up call against a $20 remainder) must keep working — it settles,
  so it qualifies. The pinned full-payment test (`tests/applications.test.ts:473-490`, 980 + 20
  → open 0) must stay GREEN; every test that takes a discount on a partial must flip to a
  refusal, with the new message pinned. Update the §4.3 header block and the 5B design spec
  wording to state the settlement rule and the owner ruling date. *#8*: swap the hand-rolled
  body read for `reasonFromBody` (`http.ts`, the shape 14 other routes use — note
  `catch(() => null)`), fix the now-false "mirrors deleteCustomer's route" comment, correct
  HANDOFF §5.17 and add "(built)" to the spec §15 row, and add **NEW `tests/roles-routes.test.ts`**
  cloned from `tests/customer-routes.test.ts:58-77` — RED first on `body: "null"` → 400
  (TypeError today), plus the happy path and the no-body pin. Route tests pass ctx.
- **Task 2 — #137, the three statements-screen defects.** (1) clear `preview` INSIDE
  `loadPreview`'s existing `isCurrent(t)` guard (never outside it, never at the top — that
  would blank a good preview on every keystroke), and extend the `printTitle` chain with a
  `preview === null` branch. **Gate on `preview === null`, NOT on `error`** — `error` is a
  shared bucket also written by the customers-options catch, so the issue's literal wording
  would re-disable Print for exactly the user fix 2 is opening up. (2) the tri-state
  `familyLookup` per the controller call, plus the customer identity in the Preview header;
  record in the comments that the SERVER (`route.ts:46`) is now the authority and the client
  gate is belt-and-braces. (3) hoist `parseAsOf(asOf)` in `statements.ts` to just after the
  `asOf` default and BEFORE the parent lookup, so it sits outside every per-member `try` and a
  malformed date 400s instead of answering 200 with N failures; `buildStatementInTx` keeps its
  own parse (it is the boundary for single-print callers). **Extract the `printTitle` chain as
  an exported pure function** so it is testable in this repo's node-only vitest env — the
  `runControlState` / `tests/backups-page-state.test.ts` precedent. Keep the partial-results
  test green: the hoist must not turn genuinely member-specific failures into a throw.
- **Task 3 — #153, the parent-history union read.** NEW client-safe leaf
  `src/lib/audit-children.ts`: a pure REGISTRY keyed by parent entity → child specs (relation
  hops + FK + display label), plus the labels the panel renders. NEW
  `readAuditWithChildren(entity, entityId, limit = 200)` beside `readAudit` — **leave
  `readAudit` exactly as it is**; 40+ existing call sites pin it as the exact-match primitive.
  Guard the registry lookup with `Object.hasOwn` (`entity` reaches it straight from a query
  param — this is the Phase 1 `__proto__` crash). **Child-id resolution must never filter
  `deletedAt`** — the child's own *delete* entry is exactly the row the panel most needs; pin
  that with a delete-row-specific assertion, not a count. Cover child-of-child
  (`partPriceBreak` via `partPrice`, including a break whose parent price is itself
  soft-deleted) and dedupe an `application` reachable under `invoice` by two FKs. The route
  returns `{ rows, hasMore }`; the envelope has exactly **three** consumers —
  `HistoryPanel.tsx:73`, `tests/admin-routes.test.ts:43`, and
  `e2e/flows/credit-hold-block-and-override.mjs:69`. Miss the E2E one and the gate goes red for
  an unrelated reason. Panel labels foreign rows by child entity and states the truncation.

**Wave 2 (after Task 1's `applications.ts` edits are committed):**

- **Task 4 — #77, the standalone bad-debt write-off.** NEW `writeOffInvoice` service modelled
  on `applyCredit` (the closest sibling: one target invoice, no payment row): zod
  `{ invoiceId, amount (12,2 positive), reason }`, **`paymentId: null`**, `appliedDate =
  todayDateOnly()`. Claim discipline clones `voidApplicationInTx`'s SINGLE-invoice shape —
  unlocked stub read to refuse an untargetable row before taking any lock, then
  `claimOrder(tx, stub.orderId)`, then the invoice row claim, then **re-validate
  kind/status/deletedAt under the claim** (a concurrent `unlockInvoice`/`discardInvoice` must
  not let a write-off settle now-editable or discarded paper). `assertPeriodOpen` under the
  claims, before the write. **STANDING INVARIANT: the transaction runs Serializable** — a Read
  Committed downgrade silently breaks the posting-vs-close SSI pairing, and the brief requires
  the **dangerous-direction test** that goes red if anyone downgrades it. Reason refusal reuses
  the EXISTING wording ("a write-off needs a reason") — the two flavors must read identically.
  Route: POST `/api/receivables/write-offs`, `mustCan(receivables, create)` + `mustDo(write_off)`,
  all guards inside the service. UI home is the customer A/R section (`ReceivablesSection`), not
  the invoice page (which has no A/R panel at all): a `Write off` control on the INVOICE arm of
  `OpenItemRow`, expanding to an amount + reason, reusing the `inFlight` ref single-flight
  verbatim (two clicks in one tick both POST — `disabled={saving}` is NOT a single-flight) and
  the local `applyError` state so a refused amount stays correctable in place. §5.16 gate is
  the combined `receivables.create` + `write_off`, disabled-with-whichever-blocks.
  **THE VOID SURFACE IS IN SCOPE (owner ruling).** `voidApplication` already works on a
  null-payment row, but nothing can reach it: BatchDetail lists applications per PAYMENT, and
  `openItemsForCustomer` filters `open <= 0`, so a fully written-off invoice vanishes from the
  only table that could anchor the undo. Keep written-off invoices reachable — flagged, with a
  Void control — so the screen that wrote it off can undo it. This is §5.14's "a block must
  name a route out of itself". GL/close/aging/statements need **no change** (all paymentId-blind)
  — but verify each with a test rather than an assumption.

## Conventions (in force from the start)

- **Per-task scratch DBs, with the override that actually works**:
  `DATABASE_URL_TEST=…scratch npm test` — NOT `DATABASE_URL` (`tests/helpers/setup.ts:4`
  reassigns it, so the obvious override silently runs against shared `erp_test`; H2 lost two
  runs to that). `CREATE DATABASE`, `migrate deploy` against it, drop when done.
- Explicit-pathspec commits ONLY; the controller commits no file an implementer owns;
  controller minors get solo verification.
- TDD per task: failing test → implement → pass → commit. No attribution trailers.
- One fresh task-reviewer per task; fix rounds until approved.
- PR body: **one `Closes #n` sentence per issue**.

## Gates

Per task: `npm test`, `npx tsc --noEmit`, `npx eslint src tests` from `erp/` on the task's own
scratch DB. **E2E at group level** after wave 2 + reviews — every task here touches UI or a
route, and #153 changes an envelope one flow reads directly. Targeted attention: receivables
(apply/age/statement — the flow that reads the audit API), customer A/R section (the new
write-off + void), close month-end, admin roles, and any part/customer History panel.
