# Round 3 Group B — "an implemented route with no button"

**Branch:** `round-3-group-b` off `main` at `5209b74`.
**Closes:** #161, #165.
**Rulings:** the owner's comments on both issues, 2026-08-19. Read them — they are the contract, and
both carry a sizing note that is more useful than the issue body.

Two tasks, **deliberately kept out of one another's diffs — the owner's own instruction**, so the two
surfaces stay independently reviewable. They are file-disjoint apart from `e2e/run.mjs`, where both
register a flow.

## What this group is

Two routes that exist, work, and are tested — and that **no screen can call**. Both were found by the
same sweep while writing the manual, verified three ways each (no client reference, no component
reference, no E2E flow). This is not a wiring chore: in #161's case the UI is already built to
*explain* reversals to an operator who cannot *create* one, and the refusal messages instruct a
correction flow whose last step has no button.

## Standing constraints for both tasks

- TDD: failing test → implement → pass → commit. Conventional commits, **no attribution trailer**.
- **All commands run from `erp/`.** A root-cwd `vitest`/`tsc` run collects the wrong files and fails
  confusingly.
- **`npm run test:e2e` is REQUIRED by both rulings**, not just by the standing rule — each task is a
  UI flow, and #161's reversal is the only writer of `OrderStatus.REOPENED`. It needs the dev server
  and the **DEV** database, which is currently PRISTINE. Keep it that way.
- **`npx eslint src tests` does NOT cover `e2e/`.** `node --check` every flow you touch.
- **A `.tsx` IS unit-testable here, contrary to what four of my earlier briefs said.** There is no
  jsdom, so clicks and effects are Playwright's — but initial render is testable via
  `renderToStaticMarkup`, and five suites now do it (`loads-section`, `backup-banner`,
  `practice-banner`, `setup-banner`, `receivables-void-control`). For a props-in/markup-out question
  — is this control disabled, with which title — **write the render test.** Assert the real attribute
  (`/\sdisabled=""/`), never `toContain("disabled")`: Tailwind's `disabled:*` classes contain the
  word, so the substring form passes with the feature deleted.
- **No migration, no audit-registry edit, no new allocating entry point.** #161's server side is
  already `retryAllocation`-wrapped; #165 may add a route but no new counter.
- Updating `docs/HANDOFF.md` and the manual is part of the work, not a follow-up.

---

## Task 1 — #161: the Reverse control

**Owner ruling: add it.** Reversing a shipment is a real shop action. The server is complete and
17-test-covered (`tests/shipper-reverse.test.ts`); the cost here is the surface plus the flow.

### What is already true (verified during recon)

- `POST /api/shippers/[id]/reverse` is gated `mustDo(user, "void_shipper")` — **the same special
  action as Void**, and no `shipping.*` CRUD grant substitutes. So the UI gate is
  `gateDo(perms, "void_shipper")`.
- Body is `{ reason, shipDate? }`; the service requires a non-empty reason
  (`shippers.ts`: *"A reason is required to reverse a shipment"*).
- The response goes through `shipperResponse`, so the §5.7 warning surface rides it exactly like
  every other shipment mutation. Whatever the page does with warnings elsewhere, do that.

### THE TRAP — do not copy `voidGate`

`ShipmentDetail.tsx`'s `voidGate` is a four-rung ladder: voided → `invoiceVoidBlock` → already-reversed
→ `gateDo(perms, "void_shipper")`. It is tempting to clone it. **The second rung would be a bug.**

`invoiceVoidBlock` disables Void because a finalized invoice freezes the shipment. **Reversal is the
correction for exactly that situation** — the issue says so in as many words, and `reverseShipper`
carries no invoice refusal at all (grep-verified: its only early guard is the reason). Cloning the
ladder would disable the Reverse control **in the one case it exists for**, and it would look
correct in review because it matches the neighbouring control.

So build the Reverse gate from what actually refuses a *reversal*, which you must read off
`reverseShipper` rather than infer:

- voided → disabled (see the E2E hazard below — this rung is mandatory);
- already reversed → the server has a second-reversal guard (Codex round 2 on PR #141); the control
  should say so up front rather than let the operator find out;
- is a reversal itself → decide from the service what reversing a reversal does, and say so;
- otherwise → `gateDo(perms, "void_shipper")`.

**Every rung's title must be the reason that rung fires** (§5.16 — disabled with the reason, never
hidden). Where the server already words a refusal, reuse that wording so the title and the refusal
cannot drift.

### The E2E hazard, which is sharper than the issue states

`e2e/flows/void-shipment.mjs` does not spot-check. It sweeps **every** `main input, main select,
main textarea, main button` on a voided shipment and asserts the unlocked set is **empty**:

```js
assert.deepEqual(unlocked, [], `voided shipment must lock every control; ...`)
```

A Reverse control that is present-but-enabled on a voided shipment reds a flow this task does not
otherwise touch. The voided rung above is what prevents that. **Run the whole E2E suite, not just
your new flow** — that assertion is in a different file.

### The new flow

Register in `e2e/run.mjs`. It must drive the reversal end to end and prove the page then renders the
story it already knows how to tell:

- the pair-freeze banner (#139: a live reversal pair refuses edits to *either* document);
- the Void precedence (#65: voiding the original is refused naming the reversal; voiding the
  reversal is the blessed undo);
- **`OrderStatus.REOPENED` reachable from a screen for the first time** — the board already offers
  the filter, and this is what makes it match something. Assert it.

### Ruling point 4 — verify, do not assume

The ruling says the "void the reversal, edit, re-reverse" refusals **become true** under this change
rather than needing rewording. **Check each one names a step the operator can now actually take**,
and say in the report which messages you checked and where they are. A refusal naming a route that
now exists is the whole point; one that still names an impossible step is this group's own defect
class.

---

## Task 2 — #165: create a cert at a chosen scope

**Owner ruling: build it** — a missed certificate must be raisable by hand. **Sized M, not S**, and
the sizing note is load-bearing.

### The constraint that decides the shape

`POST /api/certs` is `.strict()` and **deliberately omits `shipperId`**. Its docblock records why:
`shipperId` is resolved server-side only, and *"this route structurally cannot produce a
SHIPMENT-scope cert."* `createCert`'s `assertScopeShape` then refuses a SHIPMENT scope with no
shipper.

**Do not relax that schema.** Doing so reverses a documented decision in the very file whose comment
is the record of it. SHIPMENT scope needs a **new route that resolves `shipperId` from its path** —
the shape `POST /api/orders/[id]/certs` already uses for LOAD (`orderId` from the path, `scope` fixed,
client supplies nothing else). Follow that precedent: path-resolved id, fixed scope, `.strict()` body.

So the server side is:

| Scope | Route | Status |
|---|---|---|
| LOAD | `POST /api/orders/[id]/certs` | exists, used by the order hub |
| ORDER | `POST /api/certs` with `{ orderId, scope: "ORDER" }` | exists, **no caller** |
| SHIPMENT | — | **must be built** |

### Placement is yours to decide, and to justify

The ruling deliberately left it open. The order hub hosts the LOAD control today
(`CertificationsSection.tsx`, posting `{ loadNumber }` to `/api/orders/[id]/certs`) and is the natural
home for the ORDER-scope choice; a SHIPMENT-scope cert may belong on the shipment page instead.
**Decide from the code and say which and why in the report** — a reviewer will ask.

### Two rules you must not reimplement

1. **Uniqueness is service-enforced under the order claim, not indexed.** `Cert` has no unique column
   at all, and Postgres treats NULLs as distinct, so no index could express one-live-cert-per-scope-
   instance (CLAUDE.md). **The UI must not attempt its own uniqueness check** — it would be a second
   opinion that can disagree with the claim-guarded one.
2. **Handle the blind-collision case** (named in the walkthrough's rough edges): a blind `createCert`
   collides with the eagerly-created cert without hinting one already exists. Whatever the control
   does, the operator should **learn that a live cert already covers that scope instance** — not just
   be refused. That is §5.14 again: name the thing that is blocking you.

### E2E

Register a flow in `e2e/run.mjs`. Both new scopes, and the collision case if it can be driven.

---

## Task 3 — documentation

- **`docs/manual/04-shipping.md`** — reversal now has a control. The chapter currently describes the
  reversal *story* (banners, Void precedence) without a way to start one.
- **`docs/manual/05-certifications.md`** — the scope choice.
- **`docs/manual/walkthrough.md`** — both issues appear in its rough-edges/defect rows. Check them;
  Group A's whole-branch review caught one stale row there and the residue caught two more.
- **`docs/HANDOFF.md`** — the group entry.
- Spec §15 only if a contract is amended. Both are owner rulings already recorded; check first.
- `npm run manual:build` after any chapter edit. **Do not run `manual:capture`** — a fresh capture
  fails the 16 MB publish ceiling outright (#169), so new figures are not available to this group.

---

## Review

One `task-reviewer` per task, then a whole-branch review. The stop-reviewing ruling applies from
round 6.

The three things most likely to be got wrong:

1. **Cloning `voidGate` onto Reverse**, which disables the control in the exact case reversal exists
   for — and looks right because it matches the control beside it.
2. **Relaxing `POST /api/certs`'s `.strict()` schema** to get SHIPMENT scope, reversing a decision
   the file itself records.
3. **A test that cannot fail.** Four were found and fixed across the previous two branches, every one
   caught by running something rather than reading it. If you assert a control is disabled, assert
   the attribute; if you assert a query does not happen, patch the client the code actually uses.
