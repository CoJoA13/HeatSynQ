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

**Task 1 (#69 + #8)** — implementer `5bfe003`/`bed28b6`/`7b2e604`. Review: **Spec ✅ ·
Approved (round 1)**, zero Important — and the review did the work the money deserved. It
**derived** the two sites' consistency rather than trusting the prose: any accepted DISCOUNT
satisfies `PAYMENT + DISCOUNT = open` and `DISCOUNT ≤ elig`, hence `PAYMENT ≥ open − elig`,
which is exactly `discountAvailable`'s test — so **the save can never accept a discount the
offer would have refused**, multi-invoice payloads included. It traced half-cent rounding
through two constructions (333.33 @ 1.5%, 1000.25 @ 2%), confirmed the order-independence pin
goes RED if the aggregation moves back into the loop, and re-derived every changed E2E figure
by hand. The implementer's **WRITE_OFF exclusion was endorsed with an argument the brief had
not made**: including it would open a `PAYMENT 500 + DISCOUNT 20 + WRITE_OFF 480` loophole —
absorbing a short-pay is not being paid early. #8's RED was verified real at base (`JSON.parse
("null")` returns null without invoking the catch, so `null.reason` threw a TypeError past
`handle`). Six polish minors, one of them a contract-hygiene catch worth keeping: **spec §15
recorded the implementer's WRITE_OFF reading inline with the owner's ruled text**, unmarked —
§15 is the contract, so a derived reading must be labelled as derived and pending
confirmation. The controller-owned record carried the same class of error and was corrected in
the same breath: HANDOFF's rolling paragraph still stated the **superseded** first #69 ruling,
so the handoff and spec §15 asserted opposite policies until it was fixed.

**Task 3 (#153, the parent-history union read)** — implementer `65c28da`/`bbe47d0` (+ fix round
`3f9ad04`/`fdcaca5`). Review: **Needs fixes (round 1) → Approved (round 2)**. Round 1 verified
the two load-bearing properties at diff and query level (`readAudit` byte-identical; no
`deletedAt` filter anywhere in the walk, with no Prisma extension able to reintroduce one),
re-grepped the consumer list independently, and endorsed the implementer's self-directed
`receiptBatch → application` entry as the registry's own rule applied consistently.

**The one Important is the group's best finding, and it was about a GUARANTEE, not a defect.**
The leaf's header stated that the sweep test "executes every hop against the real schema", so
a typo'd FK could not ship. It didn't: the walk short-circuits on `level.length > 0`, and the
sweep walked whole chains from a bogus parent id — so the OUTER hop returned `[]`, the loop
exited, and **the inner hop of every two-hop path never ran**. `application.paymentId` was
validated by nothing, on exactly the "a future audited child is one registry entry" shape the
design exists to make safe. No live defect (both column names checked against the schema) —
the advertised guarantee was simply false. Fixed test-only plus one `export` so the tested
path is the wired path: every `(model, fk)` pair now executes INDIVIDUALLY, with a
`covered`-vs-`expected` set comparison whose job is to fire when a future edit reintroduces a
chain walk. The implementer added the missing negative half too — an unknown model must THROW,
since an empty list is indistinguishable from a correct hop finding no children.
**Both sides proved it by injection**: `fk: "paymentIdd"` reds the new sweep, and the reviewer
re-ran it independently in a scratch copy and found the decisive detail — the round-1-style
assertion **passed** with the typo in place, confirming the finding from the other direction.
Six minors applied, incl. three banner comments that still claimed `entries[0]`, a JSDoc
claiming a runtime re-assertion that never existed, and a CLAUDE.md paragraph trimmed back to
its prior length. One declined-and-endorsed: scoping the banner fetch was rejected in favour of
documenting, since a `parentOnly` param would widen a shared route's contract for a state that
cannot currently arise.

**Task 4 (#77, the standalone bad-debt write-off)** — implementer `c738663`/`3f00bb5`/`8865cb6`
(+ fix round `50cf2cf`/`3f90465`/`afeefa3`). Review: **Needs fixes (round 1)**, one Important,
no Critical. The reviewer verified the whole posting discipline in order (stub read refusing an
untargetable row before any lock → `claimOrder` → invoice `FOR UPDATE` → re-read → re-validate
kind/status/deletedAt → over-application vs the live balance → `assertPeriodOpen` → audited
write on `tx`, all Serializable), ran the suites (54 passed, pristine), and confirmed the
structural isolation pin is a LIVE assertion on the intercepted transaction option rather than
a comment. Every paymentId-blind claim was verified by a real test — GL postings through a real
`closePeriod`+`exportClose`, roll-forward `writeOffTotal`/variance 0, aging, statements.

**The implementer's dangerous-direction deviation was endorsed as stronger than the repo's own
precedent.** They MEASURED that the brief's single test cannot work: downgrading
`writeOffInvoice` alone leaves it green, because a Read Committed transaction re-reads the
period fresh and refuses on the ordinary guard — **the stale snapshot IS the Serializable
exposure**. So the behavioural half is RED-verified by downgrading `closePeriod` (exactly what
`close-periods.test.ts`'s existing finalize-vs-close test does) and a structural pin guards this
service's half — which the precedent lacks.

**The Important is what happens when a feature becomes first-class.** `hasReceivableActivity`
matches any live application with no type or payment predicate, so a standalone write-off now
blocks unlock and void-order — correct behavior, but the refusals still said "void the payments
applied to it first". Before this task a `WRITE_OFF` always carried a `paymentId`, so those
strings were always true; they became reachable and FALSE, sending the operator to the receipt
batches to void a payment that does not exist while the actual correction is the Receivables
section this task built. That is §5.14 — the very rule the void surface exists to satisfy.
Fixed via one shared `WRITE_OFF_VOID_HINT` constant, with new coverage proving not just the
refusal but that **voiding the write-off then permits the unlock** (a named route out only
counts if it unblocks), RED-verified by reverting the wording so the failure prints the false
instruction itself. Three minors applied.

## The group-level E2E catch (why that gate exists)

The first full run failed **1 of 23** — `receivables-apply-age-statement`, with
`SyntaxError: Identifier 'invoiceRow' has already been declared`. The flow never parsed, so it
ran no assertions at all. Cause: **the one file two tasks edited.** Task 1's fix round added a
settling-payment step and Task 4 added the write-off/void step, each declaring `invoiceRow` in
the same function scope. Neither implementer could have caught it alone — Task 1 ran
`node --check` before Task 4's commit existed, and Task 4 verified its selectors against a live
DOM, which proves the selectors and says nothing about whether the file parses.

**The propagatable finding: `npx eslint src tests` does not cover `e2e/` at all.** The
implementer re-introduced the collision and ran eslint on the file — **exit 0, nothing
reported, on a file that cannot be parsed**. `node --check` catches it in milliseconds. After
the fix they parsed every declaration in the file rather than trusting a name list (41
declarations, zero duplicates) and `node --check`ed every `e2e/` module.

The re-run then failed **1 of 23 again**, on the same flow but for a different reason — the
first failure had masked it. Task 1's settling-apply assertion timed out; the apply itself had
SUCCEEDED (its response gate requires `res.ok()`), so the defect was the assertion's anchor.
The controller's hypothesis — "a successful apply closes the panel" — was **wrong in its
mechanism**, and the implementer's correction is the reusable rule: the panel never closes
(`apply()` never touches `expandedPaymentId`); the **candidate table inside it** unmounts,
because it renders only under `rows.length > 0` and a settling apply empties the family's last
open invoice out of that list. So: *a settling apply destroys the candidate table it was driven
from* — post-apply assertions must not anchor there, pre-apply ones may. A grep found three
anchors on that columnheader across two flows; only the settling one is affected, and the other
two are now documented as latent in place. Two intermittent races went in with the fix (the
detached-wait ordering doubling as the reload wait; the discount row filtered on amount as well
as type, since a stale table's "Discount" COLUMN HEADER satisfies a type-only filter).
**Neither E2E defect was reachable by any other gate** — the unit suite, tsc, eslint and the
build were green throughout both.

## Group tally

Four implementation tasks, five reviews — **two Approved round 1 (#137, #69+#8), two requiring
one fix round each (#153 approved on round 2; #77's §5.14 messages), zero Critical across the
group**. Five issues closed by the PR (#69, #8, #137, #77, #153); three more closed at kickoff
by owner ruling (#134, #4, #71). One follow-up filed on-branch (**#155**, the discount's
unreachable two-step composition plus the §5.14 silent-hide). No schema change and no migration
anywhere in the group.

## Gates (final tree)

| Gate | Result |
|---|---|
| `npm test` | **3446 passed / 204 files** (Group H2 closed at 3362/200) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean |
| `npm run test:e2e` | **23/23 flows** (first run 22/23 twice, both on the one file two tasks edited) |
