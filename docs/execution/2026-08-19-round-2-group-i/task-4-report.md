# Task 4 — #77, the standalone bad-debt write-off — implementer report

**Branch** `group-i-ready-issues` · **Commits** `c738663` (service + route + tests + CLAUDE.md),
`3f00bb5` (UI + E2E step) · **Scratch DB** `erp_scratch_i4` (created, migrated, dropped at close).

## What changed

**`erp/src/server/applications.ts`**

- NEW `writeOffInvoice(input, tx?)`, appended after `applyCredit`, with `WRITE_OFF` zod
  (`invoiceId`, `amount` `decimalField(12, 2, positive)`, `reason` optional-in-schema). `paymentId:
  null`, `appliedDate = todayDateOnly()`. Claim order is `voidApplicationInTx`'s single-invoice
  shape: unlocked stub read (refusing a non-INVOICE / non-FINALIZED / soft-deleted target before any
  lock is taken) → `claimOrder` → the invoice row `FOR UPDATE` → **re-validation of
  kind/status/deletedAt under the claim** → the over-application guard against the live open balance
  → `assertPeriodOpen` → `auditedCreate`. Serializable.
- `reason` is `.optional()` in the schema **on purpose**: that makes a MISSING reason and a
  whitespace-only one produce the same refusal — `"a write-off needs a reason"`, the exact string
  `resolveReason` already uses and `tests/applications.test.ts` already pins for the residual
  flavor. Required-in-zod would have given the two flavors different wording for the same mistake.
- `openItemsForCustomer` gains `writeOffs: OpenItemWriteOff[]` on every item and **retains** an
  INVOICE whose open balance is ≤ 0 when it carries at least one standalone write-off. The
  write-offs are picked out of the same application list the balance is derived from (one query, so
  flag and balance cannot describe different sets).

**NEW `erp/src/app/api/receivables/write-offs/route.ts`** — `mustCan(receivables, create)` +
`mustDo(write_off)`, both unconditional (this route writes nothing else, so there is no body to
peek at), then delegate. Body read is `req.json().catch(() => null)` so a malformed/`null` body
becomes zod's 400 rather than a bare 500 — the #8 lesson applied at birth.

**UI** — `ReceivablesSection.tsx` (Write off control + form + the write-off list with Void),
`customers/[id]/page.tsx` (the two new gates). Details under "the void surface" below.

**E2E** — a net-zero write-off/void round trip added to
`e2e/flows/receivables-apply-age-statement.mjs`.

**`CLAUDE.md`** — `writeOffInvoice` added to the period-lock paragraph's enumeration of posting
mutations that run Serializable. That list is a code fact my change made stale.

## The void-surface design decision (owner ruling, in scope)

**Chosen: keep the written-off invoice in `openItemsForCustomer`, at `open: 0`, flagged, with a
Void control per write-off.** Reasoning, and the alternatives:

- **Why not a separate "Written off" list** (its own array on the summary, its own small table)? It
  would have kept "open items" nominally pure, at the cost of a second read, a second type, a
  `customer-receivables.ts` change, and — the deciding point — a *second place* an invoice can
  appear. Retaining the row keeps one row per document, and the Void sits on the same row the
  write-off was made from, which is what the ruling actually asks for.
- **Why retaining it does not break #83.** The retained row's `open` is exactly zero, so it
  contributes nothing to the sum-to-the-net invariant. Pinned by a test that writes off one invoice
  and asserts the rows still sum to the aging net.
- **Why only NULL-PAYMENT write-offs qualify.** A residual write-off is already reachable from its
  receipt batch (`BatchDetail`'s per-payment application list). Retaining those too would park every
  invoice ever settled with a residual in a table headed "Open items", forever, to duplicate a
  control that already exists. Pinned by a test asserting a cash + payment-sourced-residual
  settlement does NOT retain the row.
- **The knock-on I had to fix:** `openInvoices` (the credit-apply target list) now filters
  `open > 0`. Without it, a retained zero-balance invoice would be offered as a credit target and
  prefill an amount of `0.00` that `applyCredit`'s schema refuses.
- **The one thing worth putting to the owner:** retention is unbounded — a written-off invoice stays
  listed until someone voids it. That is the literal reading of the ruling (and the alternative, a
  cutoff window, would be an invented policy), but a shop with years of bad debt will accumulate
  zero rows in that table. Flagged here rather than decided.

Void itself reuses `BatchDetail`'s `prompt`-then-`DELETE` shape and is gated `receivables.delete`,
which is what `DELETE /api/receivables/applications/[id]` enforces.

## Deviations from the brief, with reasons

1. **The dangerous-direction test needed a second half, and its RED lever is the OTHER side of the
   pairing.** The brief asked for a test that goes RED "if anyone downgrades it". I wrote the
   behavioural test first and measured it: downgrading **`writeOffInvoice`** to Read Committed left
   it GREEN. That is structural, not a test bug — a Read Committed transaction takes a fresh
   snapshot at its period read, so it SEES the committed close and refuses on the ordinary guard.
   The exposure a Serializable posting mutation has is precisely its stale snapshot, and Read
   Committed does not have one; no behavioural test can red on that half. So:
   - the behavioural test stays, and is RED-verified by dropping **`closePeriod`**'s
     `isolationLevel` — the exact lever `close-periods.test.ts` documents for its own twin;
   - a **structural pin** was added beside it (`transactionOptions`, the `tests/attachments.test.ts`
     precedent) asserting `writeOffInvoice` opens exactly one `{ isolationLevel: "Serializable" }`
     transaction. That one reds the instant anyone downgrades this service.
   Between the two, both halves of "the pairing is all-Serializable" are guarded. The test file's
   header states this in full so the next reader does not have to re-derive it.
2. **`writeOffInvoice` takes an optional `tx`.** The brief modelled the signature on `applyCredit`,
   which takes none. The discriminating concurrency test needs a Read-Committed competitor (else it
   proves SSI, not the invoice-row claim), so the parameter exists for exactly that caller — the
   `applyPayment` precedent directly above it, documented the same way.
3. **A new E2E flow FILE would have been unsafe; the step went into the existing receivables
   flow.** A new flow seeding its own shipped→invoiced order would put another FINALIZED invoice,
   dated today, into the dev DB — inside `close-month-end`'s readiness/export scope, whose
   assertions are exact. The step is instead a **net-zero round trip** inserted between the
   statement assertions and the settling apply: it writes off the whole 470.00, proves the row stays
   listed and flagged at zero, then voids it and hands the 470.00 back. All it leaves behind is one
   soft-deleted `Application`, which no balance, aging, close or GL read ever sees.
4. **The row-local error moved up one row.** `applyError` used to render inside the credit form's
   expanded row. A failed VOID has no form open, so its message would have rendered into nothing.
   It is now one error row for the whole item — still row-local, never the section-level `error`
   that would unmount the form holding the amount being corrected.
5. **One `CLAUDE.md` line touched** (the posting-mutation enumeration). The docs rule is
   "in the same breath"; HANDOFF's round-2 paragraph is the controller's close-out prose and I left
   it alone, and per the brief spec §15 carries #69/#8 only, so I added no §15 row.

## Gates

| Gate | Result |
| --- | --- |
| `npm test` (scratch `erp_scratch_i4`) | **3443 passed / 204 files**, 0 failed (472s) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run test:e2e` | **not run — group-level per the brief.** The new step is unrun; see below. |

Suite tail:

```
 Test Files  204 passed (204)
      Tests  3443 passed (3443)
   Duration  472.28s
```

### RED evidence

- **New file first run** (before `writeOffInvoice` existed): `Tests 25 failed | 1 passed (26)`.
- **Invoice-row claim removed** (`SELECT … FOR UPDATE` commented out of `writeOffInvoiceInTx`): the
  concurrency test fails at its discriminator — the competitor **resolves** instead of refusing, so
  both 700s commit to 1400:
  ```
  await expect(competitor).rejects.toMatchObject({ status: 400, … })
  - Expected: Error { "message": "rejected promise" }   + Received: undefined
  ```
  Restored → green. (The 200 ms "still blocked" race in that test is explicitly NOT the
  discriminator; it survived the regression, the final assertion did not.)
- **`closePeriod` downgraded to Read Committed**: the dangerous-direction test fails with
  `expected 'resolved' not to be 'resolved'` — the write-off posts into the closed month. Restored →
  green.
- **`writeOffInvoice` downgraded to Read Committed**: the structural pin fails on
  `expect(opts).toEqual([{ isolationLevel: "Serializable" }])`; the behavioural test stays green
  (finding 1 above). Restored → green.

### Manual UI verification (because the E2E gate is the controller's)

The component is a client component, so the node-only vitest env cannot render it. I drove the real
UI instead: `next dev` pointed at the scratch DB (`.env` temporarily repointed and restored; the DEV
database was never touched), a seeded customer with one open 1000.00 invoice. Observed:

- the form opens with **1000.00 prefilled** (the owner's full-open-balance default) and the labels
  the E2E step selects on (`Amount to write off`, `Reason for the write-off`, `Write off balance`);
- after submitting, the row is **still listed**, Open `0.00`, badge `Written off`, the write-off
  line `Written off 1000.00 · on 2026-08-19 · — <reason>` with a `Void` button; net `0.00`; the
  `Write off` control now disabled with `title="Nothing left to write off on this invoice"`;
- `Void` prompts `Void the write-off of 1000.00 against 991001? … Reason for voiding (recorded in
  the audit history):` and, on accept, restores net `1000.00`, Open `1000.00`, badge gone;
- an over-amount (5000.00) leaves the form **open with the typed value**, showing
  `That exceeds the invoice's open balance of 1000` beneath the row — §5.14 in the shape the brief
  asked for.

## What the reviewer should probe

1. **The retention rule's edges** (`openItemsForCustomer`): the point-in-time `liveAsOf` cut applies
   to the write-offs too, so a write-off dated after `asOf` neither reduces the balance nor retains
   the row — I believe that is right (it does not exist yet as of that date) but it is the subtlest
   interaction in the change, and only the "today" case has a test.
2. **The unbounded retention** called out above — a policy question, not a defect.
3. **The E2E step's selectors are unrun.** The manual pass above exercised every one of them against
   the real DOM, but not through Playwright, and not against the flow's own fixture (whose document
   number carries the invoice prefix — my assertions filter rows by ORDER NUMBER and assert on the
   `Written off` span's exact text, both prefix-independent, which is the part to check).
4. **Whether the `applyError` row move** reads as an improvement or as churn in #75's code.
5. **The `tx?` parameter** — whether a test-only seam on a public service is acceptable here given
   `applyPayment`'s identical precedent.
