# Round 3 Group D — "the History panel goes stale on its own page"

**Branch:** `round-3-group-d` off `main` at `04ccb28`.
**Closes:** #158.
**This is the LAST group of round 3**, and it was scheduled last on purpose: its correctness is a
**census of every client mutation site**, and Groups A and B both added sites. Landing it earlier
would have shipped those as fresh staleness gaps on day one.

## The defect, stated once

`invalidateHistory()` (the module-level listener-Set idiom in `HistoryPanel.tsx`) makes every
mounted History panel refetch. It is wired into the parts page, the customer page and the receipt
batch page. **It is not wired anywhere else.**

Measured on `main` at `04ccb28` — this is the work-list, not an estimate:

| `invalidateHistory()` calls | File mounting a `<HistoryPanel>` |
|---|---|
| 4 | `src/app/customers/[id]/page.tsx` |
| 4 | `src/app/receivables/batches/[id]/BatchDetail.tsx` |
| 1 | `src/app/parts/[id]/page.tsx` |
| **0** | `src/app/admin/step-codes/page.tsx` |
| **0** | `src/app/admin/surcharges/page.tsx` |
| **0** | `src/app/certs/[id]/CertDetail.tsx` |
| **0** | `src/app/invoicing/[id]/InvoiceDetail.tsx` |
| **0** | `src/app/orders/[id]/page.tsx` |
| **0** | `src/app/processes/templates/[id]/page.tsx` |
| **0** | `src/app/quotes/[id]/QuoteDetail.tsx` |
| **0** | `src/app/shipping/[id]/ShipmentDetail.tsx` |
| **0** | `src/components/ReferenceTable.tsx` |

Nine of twelve panel-mounting files never invalidate. Edit a customer, an order, an invoice, a
shipper, a cert, a role, a template — the panel on that same page will not show it until a reload.

## The design call that is the whole point of this group

**The existing manifest is keyed by ENTITY, and that is why it missed a live break.**

`INVALIDATION_SITES` (`tests/audit-children.test.ts`) maps a registered *child* entity to the client
file(s) that write it, and the check requires **at least one** named file — never all of them. So
`admin/surcharges/page.tsx` mounts `<HistoryPanel entity="surcharge">`, deletes a `customerSurcharge`
(a registered child of `surcharge`), has **zero** `invalidateHistory` calls, and the sweep is blind
to it, because `customerSurcharge` already names a different file that does wire it.

**Re-key the census by PAGE, not by entity.** The rule that catches both failure modes at once:

> A client file that mounts a `<HistoryPanel>` **and** issues a mutating request must import and
> call `invalidateHistory`.

That covers the parent-own gap in #158's title *and* the second-page-writes-a-child gap the entity
map cannot express, because both are the same shape: a page with a panel that mutates. It also has
no "at least one" weakness to be incomplete about — there is no per-entity list left to under-fill.

Three things to decide and record, not to improvise:

1. **What counts as "issues a mutating request".** `api(..., { method: "POST" | "PUT" | "PATCH" |
   "DELETE" })` and bare `fetch` with the same, at minimum. State the detection, and make it fail
   loudly rather than silently under-matching — a sweep that misses a mutation shape is the same
   class of defect as the one being fixed.
2. **A panel-mounting page with NO mutation is a legitimate exclusion.** Express it as an explicit
   allowlist with a reason per entry, never as a silent absence.
3. **The old entity-keyed check asserts EXACT KEY EQUALITY with the registered child set**
   (`tests/audit-children.test.ts`), so it cannot simply grow parent keys. Decide whether the
   page-keyed sweep **replaces** it or sits beside it — and if beside, say what each one still
   catches that the other does not. Do not leave two overlapping checks with no stated division.

## The work

TDD, and the shape is unusually clean here: **write the new sweep first and let it enumerate the
nine files.** Its RED output is the authoritative work-list — better than any list I could write,
and it cannot silently omit a file.

Then wire them. The fix is the same one-liner per site: `invalidateHistory()` on the **success
path**, before the follow-up load (`src/app/parts/[id]/page.tsx` is the wired precedent; the
`#124/#131` ordering).

**Delete, do not duplicate:** `BatchDetail.tsx`'s existing calls at the two per-mutation sites become
redundant once `applyMutation` carries the call. Leaving both is the kind of belt-and-braces that
reads as intentional and is not.

## Standing constraints

- **All commands run from `erp/`.** A root-cwd `vitest`/`tsc` run collects the wrong files.
- `npm run test:e2e` at group close, per the standing rule. The dev DB is currently **pristine**;
  keep it that way. Note **#184**: a false failure is likely if you run it straight after a full
  vitest run — if you hit one, re-run before reporting, and say so.
- **`npx eslint src tests` does not cover `e2e/`.** `node --check` anything there.
- **A `.tsx` IS unit-testable here** via `renderToStaticMarkup` — five suites do it. That does **not**
  reach this defect: invalidation is an effect, not initial markup. Say so plainly rather than
  reaching for a test that cannot see it.
- **No migration, no audit-registry entity added, no new allocating entry point, no new Serializable
  mutation.** This is wiring plus a test redesign.

## What this group CANNOT pin, and must say so

The sweep cannot prove the call sits on the **success path of the right mutation**, nor that a
mounted panel actually refetches — there is no DOM environment for the effect. The existing file
already states this; keep the statement true and current rather than deleting it. **A comment
claiming more than the test delivers is this session's most-repeated defect** — four were found and
corrected across the previous three branches, two of them mine.

## Review

One `task-reviewer` for the implementation, then a whole-branch review. The stop-reviewing ruling
applies from round 6.

Most likely to go wrong:

1. **A sweep that under-matches.** If the mutation detection misses a shape, the census is wrong and
   the group's whole premise fails silently — the exact defect being fixed, one level up.
2. **A call on the wrong side of the await**, so the panel refetches before the write lands.
3. **Leaving `BatchDetail.tsx`'s redundant calls in place** because removing them looks like a
   regression.
