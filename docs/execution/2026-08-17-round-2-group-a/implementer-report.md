# Round 2, Group A — implementer report

**Branch:** `group-a-invoice-engine` · **Base:** `653be8c` · **Head:** `aab7f63` · **PR:** #133

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

**Corrected in review round 1 — the step-exact identity was not sufficient**, and the miss
double-billed exactly as the original defect did. A derived operation can legitimately come back
under a step code the override does not name: the operator typed into the tier-3 "needs price" line
(which carries no step code at all) and the shop has since priced the part, or a step code was
retired and replaced. An unmatched OPERATION override now falls back to its ORDER LINE. How much it
takes there is deliberate: one carrying **no** step code overrode a line standing for the whole order
line, so it covers every operation that line now prices; one whose step code merely no longer exists
replaced ONE operation, so it takes one. Turning a double bill into an under-bill by dropping a
sibling operation's revenue would not be a fix, and a test pins that limit.

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

Every behavioural test was **RED-verified**, each failing for the filed reason before the fix:

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

| Gate | Result |
|---|---|
| `npm test` | **3095 passed / 182 files** (from 3080) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean |
| `npm run test:e2e` | **23/23**, watched to completion |

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

## Known limits, stated rather than hidden

- **`overrideKey` keeps the FIRST claimant of a slot.** Two manual lines sharing one identity is not
  reachable through the grid (an override is an edit of an existing row); the second rides as an
  addition rather than being silently dropped.
- **#62 defaults but cannot invent.** With no other-charge account configured the line still saves
  account-less — that is what the widened `invoiceWarnings` and #89's readiness gap are for. Fixing
  it properly means configuring the account, which is an accounting-meeting answer (Q8).
- **#96 costs one extra query per zero-net linked line.** Rare, and the alternative was leaving a
  corruption check dependent on which position a line occupies.
