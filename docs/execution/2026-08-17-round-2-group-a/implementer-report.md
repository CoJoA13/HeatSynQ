# Round 2, Group A — implementer report

**Branch:** `group-a-invoice-engine` · **Base:** `653be8c` · **PR:** #133
**Gate evidence below is re-run per round** — a fix round that reports the previous round's gates
is reporting nothing (review round 2 caught exactly that here).

Five implementation commits, one per coherent defect surface, plus the doc commits.

| Commit | Covers |
|---|---|
| `4530896` | #61 + #62 + #64 — the `recalculateInvoice` manual-line seam |
| `c3abc57` | #89 — readiness attributes a frozen null-GL line to its owning invoice |
| `f9091f2` | #63 + #59 — the finalize/unlock pair |
| `4beefb5` | #60 + #96 — transaction-scoped pricing reads, and the quote-link asymmetry |
| `e8f3a47` | the three fixtures #63's guard correctly broke |

## What changed, and why it is shaped this way

### #61 — one identity rule, not an operation-specific dedup

`overrideKey` (`invoices.ts`) maps a line to the order-side identity it overrides: order line + step
code for an OPERATION, the surcharge, the order charge, or the kind alone for the singletons
(FREIGHT/CERT/TAX). `recalculateInvoice` pairs each preserved MANUAL line to the derived line
carrying the same identity and **substitutes it into that line's slot**; anything unmatched is an
addition and still rides at the end (§5.5). The whole set is then renumbered 1..n and parent-wired
through the existing `wirePayloadParents`, so a substituted override keeps its place under its PART
line rather than becoming a trailing orphan — which also deleted the bespoke manual-parent remap
block recalculate used to carry.

**Deliberately generalized past operations.** The issue is written about an overridden operation,
but the grid stamps `MANUAL` on ANY amount edit, so a retyped TAX line regenerated its derived twin
the same way — two TAX lines, double tax. Fixing only operations would have left that live.

**This fallback took TWO review rounds to get right, and each round's defect was in the code written
for the previous one** — the project's own recorded lesson, demonstrated on itself.

*Round 1* found the step-exact identity insufficient: a derived operation can come back under a step
code the override does not name — the operator typed into the tier-3 "needs price" line (which
carries no step code) and the shop has since priced the part, or an operation's part price was
retired and re-added under a different code. The miss double-billed exactly as the original defect
did. Fix: an unmatched OPERATION override falls back to its ORDER LINE.

*Round 2* found that fallback was the mirror of the bug it fixed. Taking any free operation meant
that on a line pricing steps A and B, with A overridden and A's price then retired, the override took
**B's** slot — B's revenue never reached the invoice and its line vanished from customer paper. A
double bill traded for an under-bill. Fix: re-home **only onto an operation that has APPEARED
SINCE**, compared against the invoice's previous derived identities (read before the delete). An
operation already carrying its own derived line is a sibling, not the thing this override replaced;
when nothing qualifies, the override rides as an addition where the operator can see it — the honest
answer to a genuine ambiguity rather than a guess at money.

How much it takes is the remaining care: no step code ⇒ every qualifying operation on the line (it
stood for the whole line); a step code ⇒ exactly one.

One reachability correction the review supplied: the step-code ROW cannot be soft-deleted underneath
a live override — `assertLineRefs` → `assertRefExists` 400s on the preserved manual line first — so
the reachable mutation is always the PART PRICE row, which is what the tests do.

### #64 — tax recomputed over the final set, sharing one taxable-kind list

`pricing.ts` gains `taxOnLines(lines, rate)`, and `priceOrder`'s own TAX push now derives its base
from the same `TAXABLE_KINDS` constant, so the engine and the recalculate path cannot drift.
Recalculate recomputes the derived TAX line over the final ordered set — after substitution, after
additions. A **manually overridden** TAX line is skipped: re-deriving it would be exactly what #61's
ruling forbids.

This is what makes #61 honest. Without it an operation overridden from $937.44 to $100 would still
have been taxed on $937.44.

### #62 — server-side default, plus the half the issue did not name

`withChargeGl` applies the configured other-charge account to any CHARGE line arriving without one,
at both seams: `replaceInvoiceLines` (the whole-array save, so a hand-typed charge can never be
persisted posting to nothing) and the recalculate that preserves the row (so a draft written before
the account existed is repaired rather than left). `otherChargeGlRef` reads it OUTSIDE the
transaction, the `loadInvoiceDeps` discipline.

**The unnamed half:** `invoiceWarnings` only flagged lines with a `processStepCodeId`, so a
genuinely account-less charge — when the plant default is itself unset — stayed silent even after
the server default. It now flags every account-bearing kind, excluding only PART (a $0 header that
posts nothing) and TAX (whose account comes from the config at export time).

### #89 — both gaps, not a replacement

Configuring the plant default and re-raising already-finalized paper are **two independent fixes**,
and either can be outstanding alone. So `resolveReadiness` keeps setting `hasFreight`/`hasCharge`
(which name the config to set) *and* records the owning invoice in a new `invoicesMissingGl`, which
`readinessGaps` emits **unconditionally** — the shape the step-code, surcharge and cert branches
already had, which is exactly why only FREIGHT/CHARGE were ever exposed.

The gap's label names the document and says to unlock and re-finalize; its href links to
`/invoicing/<id>`. **The issue's stated blocker was wrong** — it says "there is no invoice detail
page to anchor its fix-link", but `/invoicing/[id]` has existed since 5A. Verified before relying
on it.

Labelling needed a document number, which would have been the **third** copy of `documentNumber`
(`invoices.ts` had it private; `statements.ts` carried its own with a comment admitting it was a
duplicate). Both now import `invoiceDocumentNumber` from the client-safe `invoice-constants.ts`.

### #63 / #59 — the finalize/unlock pair

`finalizeInvoiceInTx` refuses an invoice with zero lines, before the `needsPrice` check that the
empty set made vacuous. Per the ruling the guard is on the empty set, never a zero total.
`unlockInvoiceInTx` branches on `invoice.kind` exactly as `finalizeInvoiceInTx` does, so only an
INVOICE hands its order back to the ledger.

### #60 / #96

`listPartPrices` takes a trailing `db: Prisma.TransactionClient = prisma` (the `listAddresses`
precedent) and both invoice call sites pass their `tx`. `buildPricingInput` validates a zero-net
line's quote link before the seam-#3 skip, so the rider path throws where the lead path already did.

## Testing

Every test that pins a BEHAVIOUR CHANGE was **RED-verified**. Characterization tests — ones that
pin behaviour already shipped in an earlier round — are listed separately below and are NOT evidence
that anything works; review round 2 was right to insist on the distinction, and round 3 on applying
it to round 2's own tests.

RED-verified, each failing for the filed reason before its fix:

| Test | RED failure |
|---|---|
| #61 override | 2 OPERATION lines, total **$1037.44** — the double bill, exactly |
| #61 undo path | override not restored |
| #64 manual charge tax | taxTotal **4**, expected 6 |
| #61+#64 override tax | subtotal **150**, expected 50 |
| #61 TAX override | **2** TAX lines |
| #62 default | `glAccountId` **null** |
| #62 warning | warnings **empty** |
| #63 | promise **resolved instead of rejecting** |
| #59 | order **SHIPPED**, expected INVOICED |
| #89 (×2) | readiness gap **undefined** — it read clean |
| #96 | promise **resolved instead of rejecting** — the silent skip |

#60 and #96 are green-by-construction against unmodified code paths, so both were verified by
**stashing the fix, watching the test fail, restoring it, watching it pass**.

Round 1 added five tests, of which **three were RED and two were green on arrival** — stated plainly
because review round 2 was right to ask. The three: the two #61 step-code cases (`length 1 but got
2`) and the save-seam tax (`expected 4 to be 6`). The two guards: the manually-overridden-TAX-on-save
case, and "keeps a SECOND priced operation billed", which round 2 correctly identified as never
entering the new fallback branch at all — its override has a live step code, so it pins the
already-working exact-match path. Round 2's own test (`never re-homes an override onto a PRE-EXISTING
sibling`) is the one that actually exercises it, and it was RED at `[40]` — operation B's $100 line
missing entirely.

A green-on-arrival test is worth keeping as a regression guard, but it must not be described as
evidence the change works. Round 1's report did describe one that way; this corrects it.

**Round 2 added three tests; only one was RED** (round 3's finding, and it is right):

| Round-2 test | Status |
|---|---|
| `never re-homes an override onto a PRE-EXISTING sibling` | **RED** at `[40]` — B's $100 line missing entirely |
| the partial-CREDIT re-tax | **characterization.** It exercises the save-seam re-tax round 1 shipped and round 2 did not touch. It documents an untested extension rather than proving a fix |
| the gl-export "no step-code gap" assertion | **RED** — the narrowed branch did not exist before round 2 |

**Round 3 added two**, both RED against round 3's own changes: the tier-3 stand-in warning, and the
`priceSource`/step-code assertions on the sibling test (which round 3 noted the numbers alone could
not distinguish from the override merely wearing B's amount).

**Two of my own assertions were wrong rather than the code**, and were corrected rather than worked
around: an "the override is not the last line" check that a two-line invoice satisfies trivially
(replaced with the full kind/position shape), and a candidate-list check that an order with a live
draft correctly fails (replaced with the actual recovery route — recalculate rebuilds, then it
bills).

**Three fixtures changed, all correctly broken by #63's guard** — which is enforced in the service,
not the route, so no caller can bypass it. `invoice-routes`' `finalizableInvoice` replaced its lines
with an **empty array** specifically to dodge `needsPrice`, i.e. it constructed the exact state the
guard now refuses; it types one manual charge instead. `close-periods` and `period-locks` create
invoice rows directly and gained one line each, so a finalize still reaches the period guard those
tests are measuring.

## Gates

Re-run in full at every round, never carried forward:

| Gate | Round 0 (`e8f3a47`) | Round 1 (`d7ee2bb`) | Round 2 (`db287a2`) | Round 3 |
|---|---|---|---|
| `npm test` | 3095 / 182 files | 3101 / 182 | 3103 / 182 | **3104 / 182** |
| `npx tsc --noEmit` | clean | clean | clean |
| `npx eslint src tests` | clean | clean | clean |
| `npm run build` | clean | clean | clean |
| `npm run test:e2e` | 23/23 | 23/23 | **23/23** |

Each E2E run was watched to completion rather than reported from a launch. The build emits one
pre-existing Next.js workspace-root/lockfile warning, unrelated to this branch.

## Docs updated in the same breath

`CLAUDE.md` (two standing rules: transaction-scoped reads, and MANUAL-as-override + the empty-line
finalize guard), `HANDOFF.md` §4/§6/§9, `docs/2026-08-17-backlog-round-2.md`, and the spec's §15
decision log.

## Review round 1 — what the reviewer found, and what was done

Verdict: Spec Compliance ❌ / Task quality **Needs fixes**, on one Important finding plus a second
raised as a judgement call. Both were reproduced as failing tests before being fixed.

| Finding | Disposition |
|---|---|
| **#61 still double-bills when the derived line's step code changes** — including the needs-price-then-priced path the branch's own comments named | **Fixed.** Order-line fallback with the two-way take rule above. Two RED tests (needs-price→priced; step code replaced), plus a third pinning that a second priced operation stays billed when only the first is overridden — the guard against over-correcting into an under-bill. |
| **A manual charge saved and finalized WITHOUT a recalculate goes out under-taxed** — raised as "the human decides whether to close it here or file it" | **Fixed here.** Verified reachable first: `InvoiceDetail.tsx` has independent Save-lines and Recalculate buttons and nothing sequences them. It is #64 at a second seam, and it is wrong money on customer paper in the acceptance month, so it belongs in this branch rather than a new issue. |
| Frozen null-GL OPERATION/SURCHARGE/CERT gap points at a config that is already correct | **Fixed**, together with the next row: the invoice attribution is now unconditional for every frozen null-GL line. |
| Residual readiness-clean → export-500 path (cert step code row hard-deleted) | **Fixed** by that same widening — the invoice gap fires where the cert branch recorded nothing. |
| `invoiceWarnings` has no amount test, unlike `resolveReadiness` | **Fixed** — a $0 line posts nothing and is no longer flagged, so the warning and the export agree. |
| #96 runs the full price-row read purely to validate | **Fixed** — `assertQuoteLinkSound` extracted; the validation path now costs the one read the report claimed. |
| Doc/code contradiction on the OPERATION key | **Fixed** in `invoices.ts`, `CLAUDE.md`, HANDOFF §6 and this report — the comment asserted the rule the fix has now actually implemented. |
| An added manual CHARGE sorts below the TAX line | **Not changed.** Pre-existing §5.5 ordering (additions ride at the end, and the engine's last line is TAX), not introduced here. Filed rather than widened into this branch. |
| `assertLineRefs`' widened parameter type lets a caller omit a field silently | **Not changed.** For `InvoiceLineCreateManyInput` an omitted key means null, so "nothing to check" is correct; the residual risk is a typo, and no caller omits one. Noted rather than churned. |

The reviewer also confirmed, by reading rather than trusting the report: the canonical
`withDbErrors → Serializable → claim → audited → tx` nesting is intact in both rewritten writers;
every `prisma.` in `invoices.ts` is outside a transaction; `taxOnLines` and `priceOrder` compute
bit-identical bases; header totals cannot disagree with the TAX line; positions stay contiguous 1..n;
and the three fixture changes touch nothing the affected tests were measuring.

## Review round 2 — what it found, and what was done

Verdict: Spec Compliance ❌ / Task quality **Needs fixes**, on one Important finding in the code
round 1 wrote. Re-gated in full afterwards (table above).

| Finding | Disposition |
|---|---|
| **The order-line fallback steals a pre-existing sibling's slot**, under-billing and erasing that operation from the paper — the mirror of the defect round 1 fixed | **Fixed.** Re-homing is now restricted to an operation that has appeared since, compared against the invoice's previous derived identities. RED-verified at `[40]` with the sibling's $100 line gone. |
| Round 1's "limit" test never enters the fallback branch, so it pins nothing new | **Accepted and fixed.** Kept as a regression guard on the exact-match path, with a new test that genuinely exercises the fallback, and the report corrected to say which round-1 tests were green on arrival. |
| The binding docs assert the guarantee the code broke (`CLAUDE.md`, HANDOFF §6) | **Fixed** — and this is the second round running that doc and code disagreed on this same rule. Both now describe what the code does. |
| **No gate evidence for the fix commit itself** — the report still carried round 0's head SHA and numbers | **Fixed.** Gates are now a per-round table, re-run every round; a fix round reporting the previous round's gates reports nothing. |
| The misleading source-side gap still fires alongside the new invoice gap | **Now actually fixed**, not merely mitigated: a step code or surcharge is named only when it genuinely lacks an account. Round 1's disposition table called this "Fixed" when it was not — corrected. |
| Stale `invoicesMissingGl` docstring still says FREIGHT/CHARGE only | **Fixed.** |
| "A step code retired and replaced" is not reachable as written (`assertRefExists` 400s first) | **Fixed** in the commit rationale, `CLAUDE.md`, HANDOFF and this report — the reachable mutation is the part-price row. |
| Orphaned JSDoc above `assertQuoteLinkSound` | **Fixed.** |
| The save-seam re-tax silently extends to CREDIT drafts, untested and undocumented | **Fixed** — a test now pins that a partial credit re-derives its tax proportionally (`-2`, not the copied `-4`), and it is written down. |

Round 2 also verified by reading: `absorbed` is threaded through the write set, totals, tax base and
parent wiring; cross-order-line absorption is impossible; iteration is deterministic and
order-independent in total; `assertQuoteLinkSound` is a faithful extraction; the save-seam tax
mutation is correctly sequenced before `totalsFromLines`; `taxOnLines` cannot self-feed (TAX is not a
taxable kind); `divideRound` is sign-symmetric, so re-deriving a credit's tax returns the exact
negation with no cent drift; and `PartPrice`/`QuotePrice` uniqueness means two computed operations
can never collide on one identity.

## Review round 3 — APPROVED

Verdict: Spec Compliance ✅ / Task quality **Approved**. No Critical, and **no correctness,
concurrency or data-integrity defect** in round 2's code. Round 3 re-derived each row of round 2's
disposition table rather than trusting it, and confirmed by walking the cases: `previous` is genuinely
pre-delete state; the discriminator is idempotent across consecutive recalculates (the override
re-writes its OWN step code, so the identity it displaced never re-enters `alreadyBilled`); it blocks
no legitimate re-home; a legacy double-billed invoice heals rather than freezing in; and no in-scope
line can produce zero gaps.

| Finding | Disposition |
|---|---|
| **A tier-3 (no-step-code) override absorbs operations priced onto its line AFTERWARDS** — the appeared-since guard is structurally inert in that branch | **Surfaced, not silently changed.** Round 3 calls this *plan-mandated*: `CLAUDE.md` says a no-step-code override "covers every qualifying operation", and newly priced work qualifies. The stored state genuinely cannot tell "the work this price was typed for" from "work added since", so a smarter heuristic would be a guess at money. `invoiceWarnings` now says so on the line itself, and the money question is filed for the owner rather than decided here. |
| Round 2's "orphaned JSDoc — Fixed" is the one row that was not fixed; the block was mis-attached | **Fixed properly.** The tier-1 contract is back on `quotePriceRowInputs`; `assertQuoteLinkSound` has its own two-assert doc. Second round running that a disposition table over-claimed — recorded rather than quietly corrected. |
| RED evidence missing for two of round 2's three tests, under a blanket claim | **Fixed** — the Testing section now separates RED-verified from characterization tests, per round. |
| Stale gate figures in the binding docs (HANDOFF, the round-2 doc still said 3095) | **Fixed.** |
| `derivedIdentity === undefined ||` is unreachable and fails permissive | **Fixed** — it now fails CLOSED. Unreachable either way, but the permissive direction would silently resurrect the sibling erasure round 2 closed. |
| The sibling test's numbers cannot rule out one alternative shape | **Fixed** — it now asserts the $100 line is `PART_PRICE` and carries B's step code. |

## Known limits, stated rather than hidden

- **`overrideKey` keeps the FIRST claimant of a slot.** Two manual lines sharing one identity is not
  reachable through the grid (an override is an edit of an existing row); the second rides as an
  addition rather than being silently dropped.
- **#62 defaults but cannot invent.** With no other-charge account configured the line still saves
  account-less — that is what the widened `invoiceWarnings` and #89's readiness gap are for. Fixing
  it properly means configuring the account, which is an accounting-meeting answer (Q8).
- **#96 costs one extra query per zero-net linked line.** Rare, and the alternative was leaving a
  corruption check dependent on which position a line occupies.
