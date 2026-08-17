# Round 2, Group A — the invoice engine · task brief

**Branch:** `group-a-invoice-engine` · **PR:** #133 · **Base:** `653be8c`
**Source of scope:** `docs/2026-08-17-backlog-round-2.md`, Group A.

## Why this group exists

The parallel-run acceptance month is gated on two owner conversations, not on code. This is what
gets worked while those answers come back — and Group A is first because it is **the acceptance
month's own path**. Every issue in it produces wrong money on paper the customer sees, or a broken
GL export, during the exact month the shop is judging whether to trust the system.

## Scope — eight issues

| # | Defect |
|---|---|
| #61 | Recalculate double-bills a manually overridden operation (regenerated line + preserved override) |
| #62 | A manually added charge line gets no GL account and no way to assign one |
| #64 | Recalculate computes no tax on preserved manual charge lines |
| #63 | An emptied invoice finalizes into a $0 INVOICED order that cannot be rebilled |
| #89 | A frozen null-GL freight/charge line reads CLEAN in readiness and 500s the export |
| #59 | Unlocking a CREDIT recomputes the order's status back to ship-derived |
| #60 | Invoice pricing reads part prices on the top-level client inside a Serializable transaction |
| #96 | A zero-net LEAD line's corrupt quote link 500s where a rider is silently skipped |

**#61/#62/#64 are one task, not three** — all three are the `recalculateInvoice` manual-line seam,
and sequencing them separately means the second and third each rewrite the first.

**#62 and #89 are the same defect from opposite ends** — one lets a line be saved with no account,
the other lets readiness declare that fine. Fixing either alone leaves the hole.

## Owner rulings taken before the branch opened (2026-08-17)

1. **#61 — the manual override WINS, silently.** Suppress the regenerated twin, keep the typed
   amount, and let tax follow the override. **No revert control**: the undo is remove the row, save,
   recalculate — which becomes a tested contract. Rejected alternative: recalculate discards every
   override, which would silently destroy a deliberate edit made for an unrelated reason.
2. **#62 — default the GL account SERVER-SIDE** to the configured other-charge account. **No
   operator picker**: the GL list route is `admin.view`-gated (which an invoicing clerk must not
   hold) and ruling 15 excludes `glAccount` from the open pick-list route on purpose. Revisit only
   if the accountant asks for charges split across accounts.
3. **#63 — a $0 invoice is legitimate paper** (warranty, rework, no-charge). Guard the **empty line
   set**, not a zero total, and guard at **finalize** so a draft may be emptied mid-rebuild.

## Constraints binding this work

- TDD per issue: failing test → implement → pass → commit. **RED-verify every test** (round 1's
  lesson 1 — three of that round's defects were in TESTS, not production code).
- Every standing rule in `CLAUDE.md` applies, in particular: the row-lock discipline, the
  frozen-paper read rule (§5.4), and "docs are part of the work, not a follow-up".
- Gates: `npm test`, `tsc --noEmit`, `eslint src tests`, `npm run build`, and `npm run test:e2e`
  **watched to completion** — this touches invoicing UI and flow behaviour.
