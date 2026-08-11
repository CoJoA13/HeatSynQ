# Task 9 report — Order entry, order hub, and part page surfaces

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Implementer:** Task 9 subagent

## What was built

UI only — zero server changes, and none proved necessary: every read and write the three surfaces
need already existed (Task 5's `/api/quotes/eligible` `{ candidates, autoLink }` payload, the
three-way `quoteLineId` key on LINE/UPDATE_LINE, and the per-line `quoteLineId`/`quoteId`/
`quoteNumber` on `OrderDetail`).

**Commit 1 — the entry form (`e8726e1`).** `QuoteLinkPicker`
(`erp/src/app/orders/new/QuoteLinkPicker.tsx`), the shared control for the CREATE paths: per
picked part it fetches `/api/quotes/eligible` (customer + part + the form's received-date
override, param omitted while untouched — the entry-defaults precedent, so preview and save read
the same "today") and renders the resolution — "Quote link (auto): Quote #1006 (effective … to
…)" linked, or "No eligible quote — part prices apply" — plus a select: `Auto — Quote #N` /
every candidate latest-effective-first as served / `No quote`, with "reset to auto" once touched
(the cert-override pattern on the same page). `LineDraft` gains `quoteLineIdOverride?: string |
null` — the three-way pick as state — wired through `normalizeLine` (`pickOrUndefined`: null and
id survive, garbage degrades to auto), `isDraftEmpty`, and `buildCreateBody` (the key is written
only when the pick is not `undefined`). A part swap resets the pick to auto (§5.2's
clear-and-re-resolve, applied at the only client-side part-swap point). Stale-response ordering
via `useLatest`; fetch failures render in place ("Could not check quotes: … — saving still
applies the server's auto-link"), never `.catch(() => {})`.

**Commit 2 — the hub (`182a526`).** `OrderLine` mirrors the three link fields; the Lines table
gains a Quote column showing the STORED link ("Quote #1006" → `/quotes/<id>`, "—" when none) with
a "change" affordance (editGate, §5.16). `LineQuoteRepick` mounts only when opened: fetches
eligibility against the order's CURRENT received date (§5.2's re-pick rule), offers a
"— keep Quote #N —" placeholder / the candidates minus the current link (re-picking itself would
mint an empty audit diff) / "No quote" only while linked, and PATCHes `{ quoteLineId }` only on
an explicit selection. The add-rider form gets the same `QuoteLinkPicker` as entry — addLine is a
create path with the same three-way semantics, judged against the order's stored received date
(ruling 6), so the fetch pins `receivedDate` — and the POST carries the key only for an explicit
pick; the pick resets to auto when the rider's part changes.

**Commit 3 — the part page (`6916a82`).** `ActiveQuotesSection`
(`erp/src/app/parts/[id]/ActiveQuotesSection.tsx`): spec §4.2's indicator, rendered beside
Pricing (an active quote is what displaces those part prices, §7.5).

## The ABSENT-vs-explicit discipline (how the untouched control stays ABSENT)

The guarantee is structural, not behavioral: **the control's state IS the three-way pick, and the
previewed auto-link's id is never copied into it.** Untouched, the select sits on the `"auto"`
sentinel, which maps to `undefined`; `buildCreateBody` (and the add-rider POST) write `quoteLineId`
only when the pick is not `undefined`, so there is no code path by which the displayed id can
enter the body — the server's resolution at save time stays authoritative (a quote cut or closed
between preview and save wins). An explicit selection moves the state to the picked id (validated
server-side by `judgeQuoteLine` with the line and reason named) or to `null` ("No quote").

On the hub's saved lines the same discipline holds through a different mechanism: the re-pick
PATCHes only on an explicit selection — an untouched, closed, or never-opened control sends **no
request at all**, which is `updateLine`'s absent-key KEEP; the stored id is never echoed back, and
a plain qty edit's body is `{ "qty": N }` alone.

**Proven on the wire** (dev-server smoke, fetch spy): untouched entry save → line keys exactly
`["partId","qty","weight","serials"]`, server auto-linked #1002; hub re-pick → `{"quoteLineId":
"<id>"}`; "No quote" → `{"quoteLineId":null}`; qty edit → `{"qty":6}`; add-rider explicit pick →
`{...,"quoteLineId":"<id>"}`.

## Received-date behavior (ruling 6)

Entry: the preview effect depends on the received-date override, so a change re-runs every line's
fetch — every entry line is unsaved, so this is exactly "refresh the preview for unsaved lines"
(verified live: backdating one day flipped the auto-pick from #1002 to #1003 and dropped #1002
from the candidates). Hub: the displayed link is the stored `quoteNumber` — a received-date edit
re-fetches nothing and re-judges nothing; only opening the re-pick reads eligibility, against the
current received date.

## The hub edit-surface finding

The hub's line editor (per-field onBlur PATCH to `updateLine`, LinesSection) **does** allow
`quoteLineId` changes — Task 5 gave `UPDATE_LINE` the key with absent=keep/null=unlink/id=re-pick
semantics — so display-only would have under-served it; **the re-pick control was added** (the
`LineQuoteRepick` shape above), not display-only. The hub has no separate overview/parts split —
its per-line display convention is the Lines table, so the Quote column lives there.

## What serves the part-page indicator

`GET /api/quotes/eligible` with `customerId` + `partId` and **no** `receivedDate` — the route's
absent-date default is today, and "eligible as of today" IS "in-date + OPEN" (§5.2's one rule),
already in ruling 7's latest-effective-first order (served order rendered as-is, no client
re-sort to drift from the server's tie-break). No new read, no route widening — the brief's
closest-fit call, taken. The route's `orders.view` gate is NAMED to a viewer who lacks it
("Requires orders.view to see which open quotes cover this part"), never a silently absent
section; the same naming applies on the entry picker (degraded preview, save still auto-links).

## Invoice grid check (brief item 4)

The wiring is coherent: hub InvoicesSection → `/invoicing/[id]`, where `sourceLabel`
(InvoiceDetail.tsx) reads the FROZEN `sourceQuoteNumber` unconditionally and renders
"Quote #1006" per §7.5. Nothing odd found in code review of the display path. A full live
hub→invoice run was blocked in the smoke session by the "Only a fully shipped order can be
invoiced" gate (correct behavior); Task 11's E2E flow drives entry→ship→invoice end to end.

## Deviations

1. **The add-rider form got the full preview + re-pick control**, though the plan's hub bullet
   names only the per-line display. Spec §5.2's "at order save (create and `addLine`): the entry
   UI shows the resolution before save and offers re-pick/unlink" — `addLine` IS the hub's
   add-rider, so a rider added blind would have violated the Display bullet's intent. Shares
   `QuoteLinkPicker` with entry (LinesSection already imports from `../new`, the Combobox
   precedent).
2. **The hub re-pick excludes the current link from its options** and offers "No quote" only
   while linked — not spec'd either way; chosen so an explicit re-pick of the already-stored id
   (a no-op write) can't mint an empty audit diff.
3. **A stale explicit pick warns inline** ("not eligible as of this received date — Save will
   refuse it") with a synthetic select option naming the condition — a controlled select whose
   value matches no option renders blank, the misrepresenting-stored-state shape this codebase
   flags; the server's named 400 remains the authority.
4. **No new vitest tests** — UI-only, no server change; the repo has no component-test layer
   (the Task 8 precedent), and the behavior contract is pinned by Task 5's suite server-side.
   The new-flow E2E lands in Task 11 per the plan; this task's verification is the live smoke
   narrative above plus the full existing E2E suite.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **129 files passed, 2094 tests passed, 0 failed** (unchanged from Task 8 — UI-only task) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; 75/75 static pages |
| `npm run test:e2e` | **all 18 flows passed** — watched to completion ("All 18 flows passed", "cleanup ok", exit 0). Three attempts, honestly accounted: (1) never booted — the smoke session's own preview dev server (port 3000) held Next 16's single-dev-instance lock, so the harness's port-3100 server refused to start and the run timed out waiting for /login; the harness still ran its fixture teardown ("cleanup ok"). (2) The clean rerun was 16-flows green when the session turn died under it; the harness's SIGTERM handler ran the same teardown ("cleanup ok"), so no verdict was recorded — per the no-unverified-green-claims rule, that run counts for nothing. (3) The recorded result: a fresh full run watched to its own exit sentinel. Dev-DB fixtures cleaned after every attempt: the harness's teardown (all three, including the SIGTERM path), plus this task's smoke fixtures deleted via the app's own delete paths (order voided, quotes/part/step code/customer soft-deleted with reasons, draft cleared) |

## For the reviewer to scrutinize

- The ABSENT-discipline claim end to end: `LineDraft.quoteLineIdOverride`'s undefined/null/id
  round trip through `JSON.stringify` (drops undefined) → autosave → `pickOrUndefined`, and
  whether any path can write the previewed id into the pick state.
- The hub re-pick's "no request = keep" reading of updateLine's absent-key semantics, and
  deviation 2's exclusion of the current link.
- Deviation 1 (add-rider control) — scope judgment call on the plan's hub bullet.
- The part-page indicator riding the `orders.view`-gated eligible route (§5.15): a parts-area
  viewer without orders.view sees the named reason, not the list — accepted as the §5.16-style
  degradation rather than STOPping for a new `parts`-gated read.
- The entry picker fetching per line with `useLatest` ordering — N lines with the same part fetch
  N times (no cache; matches the lead-check's one-fetch-per-pick precedent).
