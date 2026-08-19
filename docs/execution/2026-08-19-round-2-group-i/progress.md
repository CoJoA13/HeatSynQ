# Round 2 Group I — the ready issues — progress ledger

Branch `group-i-ready-issues`, opened 2026-08-19 from `8c353e3`.
Issues in this PR: **#69, #8, #137, #77, #153**.

## Kickoff (2026-08-19)

Round 2's grouped work had closed and the entire remaining backlog was owner-gated, so the
owner was asked **eleven questions in one sitting**. Six closed or scoped issues outright —
**#134** (typed no-step-code price keeps absorbing; the warning is the mechanism), **#4**
(delivery flags are informational; automatic emails are a §3 non-goal and the issue's
Phase-4/5 premise never materialized) and **#71** (A/R stays single-customer scoped) closed;
**#69**, **#8** and **#153** ruled. Four shaped this group's work. All are in spec §15 or on
the issues.

Five-agent recon then ran at HEAD before any code, and **two of its findings changed what the
work IS** — both recorded in the brief:

1. **#8 had been ruled against stale documentation.** `deleteRole` has required a reason since
   2026-08-01 (`47d6d0a`); its own JSDoc states the owner's exact rule and records why
   every-delete was rejected. HANDOFF §5.17's "(still to build)" was the stale part. Re-put to
   the owner → **close as already satisfied**, keeping the doc corrections plus a regression
   pin. Recon did find one real defect worth pinning: the route hand-rolled its body read, so a
   literal `null` JSON body threw a TypeError instead of the 400 its fourteen siblings return.
2. **#69's arithmetic had been put to the owner WRONGLY the first time.** The original
   question's example was flat-percent-of-cash, which strands $0.40 on the ordinary case (a
   $1,000 invoice at 2/10 settled by a $980 remittance) and contradicts both the 5B design spec
   ("× the amount being **settled**") and a pinned test. Re-asked with the numbers → **the
   discount is earned only by a payment that SETTLES the invoice**; a partial earns nothing.
   That is a settlement GUARD, not the pro-rata basis change recon had designed — and it kept
   #69 out of `applications.ts`'s deep water, which is what let #77 own that file in wave 2.

Also settled at kickoff, from recon: **#77 needs no owner GL ruling** — 5C ruling 3 already
pinned one write-off account and ruled the residual-vs-bad-debt split out. The owner's two #77
answers (**the write-off must be undoable from the screen that made it**; **the amount is
editable, defaulting to the full balance**) are in the brief.

Brief committed first (`cce4bad`). Wave 1 dispatched as three file-disjoint implementers.

## Brief flaws found by implementers (recorded, per the house habit)

1. **"The envelope has exactly three consumers" was wrong — it has seven** (#153). The brief
   carried recon's grep verbatim. Four CLIENT pages also read the exact-match branch as a raw
   array for their void/discard-reason banners (order hub, CertDetail, InvoiceDetail,
   ShipmentDetail), each doing `entries[0]` — which on an object is `undefined`, so all four
   banners would have silently dropped to their generic fallback with nothing to show the
   failure. The implementer found them and fixed them to be CORRECT under the union (take the
   newest row whose `entity` is the parent's own) rather than merely to survive it.
2. **"The two-step discount flow must keep working" described behavior that never existed**
   (#69). The pre-existing #81 cap (`pct × open < open`) already makes a DISCOUNT-only
   follow-up call impossible at HEAD — the new settlement guard is not what blocks it. Pinned
   by a test asserting WHICH message fires, so the two rules cannot be confused later.

## Task verdicts

**Task 2 (#137, the statements screen)** — implementer `bb62c9c`/`3cf699a` (+ fix round
`03de2fe`). Review: **Spec ✅ · Approved (round 1)**, zero Important. The reviewer verified all
three fixes line by line, checked the #136 server 409 at its source rather than trusting the
brief, and confirmed gate precedence unchanged. Both implementer deviations judged correct in
the real code: gating on `preview === null` rather than the issue's literal `error` (a shared
bucket the customer-options catch also writes — gating on it would permanently disable Print
for exactly the caller fix 2 unlocks, with no re-fetch path), and the tri-state falling open on
`"unknown"`. The implementer also strengthened beyond the brief: an effect-scoped `stale` flag
on a fetch-into-state effect that had neither ticket nor flag. Fix round applied two Minors,
**one of which is a lesson**: a comment asserted a React Compiler constraint that does not
exist — the reviewer varied TWO things where the implementer's bisect varied one, and an
object-taking signature lints clean; the alias alone is the trigger, and the cited precedent
(`runControlState`) takes a gate-shaped object. In this repo a wrong reason in a comment is a
defect in its own right, so it was corrected in the report too rather than quietly softened.
The second Minor names `loadPreview`'s catch as load-bearing and UNPINNED — deleting
`setPreview(null)` leaves all ten gate tests green while restoring the filed defect; no pin was
manufactured, since a genuine one needs a DOM env this repo deliberately does not have.
Four record-only: the defect-1/2 RED was structural (all cases failed on "not a function")
though verified non-vacuous analytically; the divisions-route document-count assertion pins
less than it appears; the 409's "use Print per division" half is unreachable for the caller the
gate opens; and the `stale` race needs StrictMode's double-invoke to be reachable.
