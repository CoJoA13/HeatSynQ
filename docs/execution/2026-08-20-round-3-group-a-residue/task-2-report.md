# Task 2 (#174) — implementer report

**Branch:** `round-3-group-a-residue` (Task 1's head, `a66b277`).
**Gates:** `npx tsc --noEmit` clean · `npx eslint src tests` clean · the three named suites green
(`write-offs` 51, `customer-receivables` 10, `customer-routes` 10) · full `npx vitest run` — **204
files, 3498 tests, all passing**, one process.

---

## 1. What changed, and why

The customer's Receivables section rendered a **Void** per standalone write-off with no period
awareness. #157 bounded RETENTION, which removes the *settled* row once every write-off on it is
dead — but an invoice with `open > 0` is an open item on its own merits, so it is retained whatever
its write-offs' months are, and it kept listing them with an **enabled** Void that always 409s.
§5.16's convention is disabled-with-the-reason; an enabled control that always fails is the one
variant it rules out.

### 1.1 The flag — `erp/src/server/applications.ts`

| Location | What |
|---|---|
| `applications.ts:456-469` | `voidable: boolean` on `OpenItemWriteOff`, with the docblock stating it is derived from the map already in hand and that retention now reads it |
| `applications.ts:545-547` | the derivation: `voidable: !closedWriteOffMonths.has(monthKey(a.appliedDate))` |
| `applications.ts:552-557` | `stillVoidable` now reads `writeOffs.some((w) => w.voidable)` instead of re-testing the map |
| `applications.ts:558-563` | the drop-test comment, which said the closed sibling's Void "refuses with `assertPeriodOpen`'s message" — the behaviour this task replaces |

`stillVoidable` moving onto the flags is the one change past the literal brief, and it is a
narrowing, not a widening: `writeOffs` is `standalone.map(...)`, so `writeOffs.some(w => w.voidable)`
is element-for-element the predicate it replaced. The point is that "is this row worth keeping" and
"is this control still live" become **one** decision — two spellings of it are how a row gets
retained for an undo the screen has already disabled.

### 1.2 The control — `erp/src/app/customers/[id]/ReceivablesSection.tsx`

| Location | What |
|---|---|
| `:34-39` | file-header paragraph: the #157 bound covers the settled row only, #174 is the rest |
| `:57-64` | the client mirror of `OpenItemWriteOff` gains `voidable`, with a keep-in-step note |
| `:74-85` | `closedPeriodTitle(w)` — the tooltip, and why the month is sliced from `appliedDate` |
| `:433-451` | the Void button: `disabled` gains `!w.voidable`, `title` becomes the two-rung ladder |

### 1.3 Documentation — deliberately NOT touched, flagged for Task 4

Nothing in `docs/manual/07-receivables.md` is **falsified** by this change: `:196` says each write-off
comes "with its own **Void** control" (still true — it is there, disabled) and `:200-203` describes
the settled row dropping off, which is #157's and unchanged. What the chapter now *omits* is the
still-open row's disabled Void. The brief assigns the manual and `manual:build` to **Task 4**, and
two tasks regenerating `manual.html` in one checkout is the crossed-index hazard the predecessor
flagged, so I left it. **Task 4 should add, after `07-receivables.md:203`:**

> An invoice that still has a balance stays on the list whatever its write-offs' months are — it is
> an open item in its own right. Its closed-month write-offs are still listed, but their **Void** is
> greyed out and says why: *"The accounting period 2026-07 is closed — reopen it to make this
> change."*

Same for `docs/HANDOFF.md`, which Task 4 owns.

---

## 2. No extra query was added, and how I confirmed it

`closedMonthsForDisplay` is called **once** in `applications.ts` (`grep -c 'closedMonthsForDisplay('`
→ `1`), before the loop, on the caller's own `db`, exactly as #157 left it. The awaited reads inside
`openItemsForCustomer` are the same four as before the change, in the same order:

```
db.customer.findFirst   →   db.invoice.findMany   →   closedMonthsForDisplay(db, …)   →   db.payment.findMany
```

The flag is computed from `closedWriteOffMonths`, the `Map` that read already returns; the
per-write-off cost is one `Map.has`. No `db.`/`prisma.` call was added anywhere in the diff
(`git diff src/server/applications.ts` shows three added lines of code and the rest comments).

I did **not** add a `closedMonthsForDisplay` caller, so `tests/period-locks.test.ts`'s call-site
allowlist is untouched and still passes (run and green). Nothing was moved in front of a write:
this is a page read, and the display read stays lock-free.

---

## 3. The two disabled cases, exactly

The Void button now has two non-`saving` reasons to be disabled. The tooltip is a **ladder**, the
same shape the Apply and Write off controls on this page already use:

```tsx
disabled={!voidGate.allowed || !w.voidable || saving}
title={!voidGate.allowed ? voidGate.title
  : !w.voidable ? closedPeriodTitle(w)
    : undefined}
```

| Case | Tooltip, exactly |
|---|---|
| missing permission | **`Requires receivables.delete`** — `voidGate.title`, from `gate(perms, "receivables.delete")` (`permission-ui.ts:9`, `customers/[id]/page.tsx:197`) |
| closed period | **`The accounting period 2026-07 is closed — reopen it to make this change`** (the month varies) |

**When both are true, the permission wins**, and that is not a coin toss: it is the order the server
refuses in. `DELETE /api/receivables/applications/[id]` runs
`mustCan(requireUser(), "receivables", "delete")` **before** it calls `voidApplication`, so a caller
lacking the permission gets a 403 and `assertPeriodOpen` is never reached. The tooltip therefore
names what a click would actually have produced. The reasoning is written at the JSX
(`ReceivablesSection.tsx:433-439`) rather than left to be re-derived.

**Why the month is sliced client-side.** `periodLabel` lives in `src/server/period-locks.ts` and a
`"use client"` file must not import from `src/server/**`, so the tooltip is composed from the wire
fields: `w.appliedDate.slice(0, 7)`. That is exact by construction — `appliedDate` is
`formatDateOnly`'s UTC `yyyy-mm-dd` (`business-days.ts:36`) and `periodLabel` is that same UTC year
and month (`period-locks.ts:30-32, 86-88`) — and it is **pinned mechanically**: the test *"names the
same month the void refusal names"* composes the sentence the way the client does, from
`appliedDate` alone, and asserts `voidApplication` rejects with **that exact string**. A change to
`periodLabel`'s format or to `assertPeriodOpen`'s wording reds it. (I did not add a second
`closedPeriod` field to the row: it would have been a second answer to a question `appliedDate`
already answers, and the pin makes the derivation safe.)

---

## 4. Every consumer of the widened row shape

Grepped `OpenItemWriteOff`, `writeOffs`, `openItemsForCustomer` and `customerReceivablesSummary`
across `src`, `tests` and `e2e`. The complete list:

| Consumer | Handling |
|---|---|
| `src/server/applications.ts` — the type and its one construction site | widened; the two `writeOffs: []` sites (CREDIT, PAYMENT rows) need nothing |
| `src/server/customer-receivables.ts:30,32` — re-exports `CustomerOpenItem` in `CustomerReceivablesSummary` | structural, no field list of its own; nothing to change |
| `src/app/api/customers/[id]/receivables/route.ts:11` — **the wire** | `NextResponse.json(await customerReceivablesSummary(...))`, a pure passthrough with no mapping; a boolean serializes totally, so the JSON gains one key |
| `src/app/customers/[id]/ReceivablesSection.tsx:62` — the hand-maintained client mirror | widened in step (it cannot import the server type) |
| `tests/write-offs.test.ts` (7 sites) | additive field; all pre-existing assertions are `toHaveLength`/`toMatchObject`/field reads — none is an exact-object `toEqual` on a write-off, so none needed changing |
| `tests/customer-receivables.test.ts` | its two `toEqual` calls are on **empty** arrays (`openItems`), unaffected; new coverage added |
| `tests/customer-routes.test.ts:243-253` — the route test, which reads `res.json()` as a narrowed literal type | its declared shape names `openItems: { id, kind, open }[]` and asserts on those three only. **This is the Group A trap and it does not bite here**, because the change is purely ADDITIVE: no field was renamed or removed, so no stale assertion can survive a real behaviour change. Run and green. |

`e2e/` has no `voidable`/`writeOffs` reference; `receivables-apply-age-statement.mjs` clicks **Void**
on a write-off it created today in an open month, so that control is enabled exactly as before. I
did **not** edit any `.mjs`, so the `node --check` caveat does not apply, and I did not run
`test:e2e` (the orchestrator runs it at group close).

---

## 5. Tests

### 5.1 `erp/tests/write-offs.test.ts:580-675` — a new `#174` block

| Test | Catches | RED? |
|---|---|---|
| `flags each write-off by ITS OWN month, on a row retained for its own open balance` | **the defect itself.** Two write-offs, two months, ONE row with `open: 500` — a row-level constant fails one of the two | **RED-verified** |
| `names the same month the void refusal names` | drift between the client-composed tooltip and `assertPeriodOpen`'s 409, in either direction (label format or wording) | **RED-verified** |
| `flags the retained settled row's write-offs, and drops the row when the last one dies` | #157's own shape keeps its flags, and the retention rule and the flags stay one decision — the row survives exactly while one is `voidable` | **RED-verified** |
| `changes nothing about which rows appear while no month is closed` | the brief's "must not alter which rows appear" — the discriminating negative | **RED-verified** (only because it asserts `[true]`; the row set half passes on both sides, which is the point) |

### 5.2 `erp/tests/customer-receivables.test.ts:300-321`

| Test | Catches | RED? |
|---|---|---|
| `carries each write-off's `voidable` through the composed read (#174)` | the flag being lost across `customerReceivablesSummary`'s RepeatableRead composition — the object the route hands to `NextResponse.json`. Two invoices in different months, one month closed, `[true]` and `[false]`; also re-asserts #83's sum-to-net, since a flag must move no money | **RED-verified** |

`invoice()` in that file gained optional date overrides (`:14-38`) so two invoices can sit in
different months; every existing caller takes the unchanged defaults, which the aging buckets are cut
to. Two helpers were added beside it — `standaloneWriteOff` (a dated null-payment write-off; the
service stamps `todayDateOnly()` on purpose) and `closeMonthRaw` (lifted from `write-offs.test.ts`,
which documents why a raw `ClosePeriod` row is the right fixture: the retention read and
`assertPeriodOpen` both look for exactly that row, and a real close would be measuring the
roll-forward instead).

**All five new tests were RED-verified in one run against the unchanged server** — 5 failed / 56
passed, each failure `expected undefined to be false/true`, i.e. the field genuinely absent. Then
implemented, and the same command runs 61/61 green.

---

## 6. What I could NOT verify mechanically

- **There is no DOM test environment in this repo, so the client half is untested.** Nothing renders
  `ReceivablesSection.tsx` in vitest. That the button is disabled, that the ladder picks the right
  rung when both reasons apply, and that the tooltip text reaches the DOM are all **unverified by
  any automated check in this task**. What *is* verified is the string it composes (§3's pin, from
  the server side) and the flag it branches on. I am not implying coverage that does not exist.
- **Playwright is the only mechanised check on the rendering, and no existing flow covers this
  state.** `receivables-apply-age-statement.mjs` writes off and voids inside an open month, so its
  Void is enabled and the flow is unaffected — but nothing drives a *closed*-month write-off on a
  still-open invoice through the UI. Adding one would need a flow that closes a month mid-run
  against the DEV database, which the brief keeps pristine; I did not attempt it. Worth a decision
  at group close rather than a silent gap.
- **The tooltip wording is my call.** The issue asked for "the same sentence `assertPeriodOpen`
  throws", so I used it verbatim rather than a Void-specific paraphrase ("… to void this
  write-off"). The verbatim form is what makes the §3 pin possible; a paraphrase would have been
  unpinnable across the client/server boundary.

---

## 7. Adjacent defects noticed and deliberately NOT fixed

1. **The amber "Written off" badge is not period-aware.** A row whose write-offs are all dead still
   reads exactly like one whose undo is live. It is a true statement either way (the invoice *was*
   written off), so it is not the false-affordance class this task is about, and the disabled Void
   beneath it now carries the distinction. Not worth a control of its own; noting it so a reviewer
   sees it was considered.
2. **`voidWriteOff` has no client-side period pre-check**, only the disabled button. Deliberate, and
   consistent with `submit`/`submitWriteOff`, which likewise trust the gate and let the server be the
   authority. A stale page (loaded before a close committed) will still 409 with a true message —
   which is correct: the server is the only thing that can know, and `closedMonthsForDisplay` is a
   display read by contract and may never become a guard.
3. **`docs/manual/07-receivables.md` is incomplete rather than wrong** — see §1.3, with the exact
   paragraph for Task 4.
