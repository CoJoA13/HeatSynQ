# Round 3 Group C — "wording, and one wasted request"

**Branch:** `round-3-group-c` off `main` at `c436f74`.
**Closes:** #162, #160.
**Plan:** `docs/2026-08-20-backlog-round-3.md`. **Rulings:** spec §15, "Amendments after the manual
walkthrough (owner, 2026-08-19)" — landing in parallel on PR #166.

Two tasks, **fully file-disjoint**, run in parallel. Implementers **commit with explicit pathspecs,
never `git add -A`** (Group D's crossed-index incident is why).

## Why this group is first

#162 carries a real deadline. The statement's finance-charge label is a **template-contract default**
(`src/lib/template-contracts/statement.ts:97`), and per the #103 rule a stored config pins only what it
explicitly stores — so **a changed contract default is live at every print, including for
already-published versions.** Nothing has published a custom statement template on this install, so the
relabel is free today. It stops being free the moment one does, which is the acceptance month.

## Standing constraints for both tasks

- TDD: failing test → implement → pass → commit. Conventional commits, **no attribution trailer**.
- `npm run test:e2e` is **mandatory** (owner instruction) even where it verifies nothing new.
- **`npx eslint src tests` does not cover `e2e/`** — it exits 0 on an unparseable file. Use
  `node --check` on any edited flow. (Group I's standing lesson.)
- Updating `docs/HANDOFF.md` is part of the work, not a follow-up.
- **Neither task needs a migration, an audit-registry edit, or a new Serializable/allocating path.**
  Verified across the whole round-3 backlog. If you find yourself reaching for one, stop and report.

---

## Task 1 — #162: the finance charge is shown, never levied

**Ruling:** informational. **The posting half is deliberately NOT built.** Do not add an invoice, a
line, an aging entry, a GL posting, or a new entity. The work is wording, presentation, and making the
spec stop contradicting itself.

### What is true today (verified)

- `src/server/statements.ts:309` returns `totalDue: aging.net` — the charge is a sibling field at
  `:308` and contributes nothing.
- `POSTING_SOURCE_TYPES` (`src/lib/gl-constants.ts:6`) has five members; none is a finance charge.
  `bucketAging`'s snapshot (`aging.ts:52-56`) and `computeRollForward` (`close-periods.ts:152-192`)
  read invoices/applications/payments only.
- The charge is recomputed from scratch on every print. Nothing is stored.

### The four changes

1. **Relabel the control.** `src/app/receivables/statements/Statements.tsx:511` reads "Assess finance
   charges". "Assess" means *to levy*. It must say plainly that the figure is shown, not billed.
2. **Make the printed line self-describing.** `defaultLabel: "Finance Charge:"` at
   `src/lib/template-contracts/statement.ts:97`, rendered by `financeChargeBlock`
   (`src/server/pdf/statement.ts:331-335`), prints immediately above a Total Due that excludes it. The
   label must carry that fact.
   **DO NOT fix this by reordering the contract's `finance_charge` section below `total`.** Stored
   configs render in their own stored order, so a reorder reaches the default template and **silently
   misses every published one** — the exact asymmetry the #103 rule describes. A `defaultLabel` change
   reaches all of them consistently; a reorder does not. This is the load-bearing constraint of the task.
3. **The screen preview has the same inconsistency** — `Statements.tsx:598-604` prints the charge
   above Total Due too. Both surfaces, not just the PDF.
4. **Correct the main spec, which now contradicts the ruling.** `§5:121` promises *"per-invoice
   dispute/exempt; idempotent run (re-running cannot duplicate)"* and `§12:166` lists the
   *"finance-charge run"* among idempotent multi-step operations. Under the informational reading there
   is no run, nothing is stored, and nothing can duplicate. Both lines must go or be corrected — P5B §3
   ruling 9 and P5C §3 ruling 4 already said "informational, posts nothing", and these two lines are the
   only spec text still leaning the other way. Leaving them is how this gets re-filed.

### `financeChargeExempt` — leave it dead, and say why

The owner ruled it stays unwritten. Note in the comment that it is **not inert**: `statements.ts:258`
honours it, so it is a live input with no writer — and that the `§5:121` "dispute/exempt" promise is
being removed in this task precisely because nothing delivers it. Do not add a UI writer.

### Tests

Three suites carry the literal string and **will go red** — that is expected, update them:
`tests/statement-pdf.test.ts:84,87`, `tests/template-contracts.test.ts:1071` (pins
`labels.finance_charge === "Finance Charge:"`), `tests/template-preview.test.ts:269`.

**Add one case to `tests/statements.test.ts` pinning that `totalDue` deliberately EXCLUDES the finance
charge**, so the next reader cannot re-file this as a bug. `tests/finance-charges.test.ts` is untouched
— the calculator is correct.

**E2E is the real gate.** `e2e/flows/receivables-apply-age-statement.mjs:228` matches
`getByLabel("Assess finance charges", { exact: true })` and **breaks on the relabel**. Update it,
`node --check` it, and run the full `npm run test:e2e`.

### Docs

`docs/manual/07-receivables.md` currently describes the charge as "printed, not charged" — that
description becomes correct rather than a caveat; make it explicit. Plus HANDOFF.

---

## Task 2 — #160: one 404 per signature-less user

**Copy the house precedent verbatim.** `src/server/templates.ts:505` solves the identical problem with
`hasLogo: v.logoMimeType !== null`, surfaced at `src/app/admin/templates/page.tsx:22`.

### The change

Add `signatureMimeType: true` to `listUsers`' select (`src/server/users.ts:32-59`) and derive
`hasSignature: u.signatureMimeType !== null`. **NEVER `signatureImage: true`** — `listUsers` was
explicitly narrowed to keep up to `SIGNATURE_MAX_BYTES` per row out of a list that renders no bytes,
and that narrowing has **no test guarding it** (see below).

Thread it into `UserSignatureControl` (`src/components/UserSignatureControl.tsx:29`) as the initial
`hasImage` instead of `useState(true)`. Keep the `onError` fallback as the belt for a race. Update the
component's docblock — it currently documents the *absence* of this flag as the justification for the
optimistic design.

`src/app/admin/users/page.tsx:11` holds a hand-maintained local `User` mirror (client components cannot
import `src/server/**`). Adding the field to the service without the mirror **fails `tsc` at the call
site** — that is the gate, use it.

**Fidelity note for the comment, because a reviewer will ask:** `setSignature` (`users.ts:186`) and
`clearSignature` (`users.ts:195`) always write both columns together, and `getSignature` (`users.ts:205`)
returns null unless both are non-null. Only a hand-written DB row could desync them, and in that
direction the flag reads "no signature" while GET 404s — so the `onError` belt still lands right.

### Tests — one of them matters more than the feature

New cases beside the existing `listUsers` tests: `hasSignature` false on a fresh user, true after
`setSignature`, false again after `clearSignature`.

**And the one that is currently missing entirely: assert the listed row has NO `signatureImage`
property.** There is no such guard today. The analogous guards exist elsewhere
(`tests/sessions.test.ts:71`, `tests/audit.test.ts:83`) but not for this read — so an implementer who
derived the flag from `signatureImage: true` would silently reinstate the regression with every suite
green. Add it in this change.

Nothing pins the payload shape (`tests/users.test.ts:18` uses `toMatchObject`; `api<T>` is a bare cast
at `src/lib/fetcher.ts:20`), so nothing else breaks.

### Do NOT re-baseline the control on later loads

`<tr key={u.id}>` (`page.tsx:106`) is stable and `UserSignatureControl` is unkeyed, so
`useState(hasSignature)` seeds once at mount. The tempting "fix" is to copy `TitleCell`, which the page
deliberately remounts via `key={`${u.id}-${u.title}`}`. **That would be wrong here**: after an upload the
control would remount and reset to the page's stale `false`. Keep the unkeyed seed and **state in a
comment that the TitleCell precedent is deliberately not followed, and why** — otherwise it comes back
as a review round.

### The harness edit is a DELETION, not a note

The issue says to add a note to `docs/manual/sweep.md`. **That is wrong** — sweep.md is machine-generated
(`e2e/manual-capture.mjs:1401`), and the generator's own docblock says triage notes live in the generator
because the report is rebuilt from scratch every run. The actual edit is **deleting the
`KNOWN_EXPECTED["admin-users"]` entry** (`e2e/manual-capture.mjs`, ~`:134-143`), which names #160 and is
the source of `sweep.md:34`.

### Verification — be honest about what proves this

No vitest and no Playwright flow can observe *"a request is not fired"*. No E2E flow exercises
`/admin/users` at all (checked all 23). **`npm run manual:capture` is the only real verification**: it
must come back with the users row clean and the sweep at 50 PASS / 0 FAIL. Run it. Run `test:e2e` too,
as required, and say plainly in the report that it is regression insurance rather than verification.

### Docs

`docs/manual/walkthrough.md:15-19` states "49 PASS … and 1 FAIL, /admin/users, which is #160" — becomes
50/50 with no FAIL; its "Filed from this walkthrough" table (`:37`) carries the #160 row. `docs/HANDOFF.md`
names #160 twice. **CLAUDE.md needs no edit** — no convention changes — worth saying, because the reflex
here is to touch all three.

### Two verified negatives, so nobody adds work defensively

- **No audit wiring.** The users page mounts no `HistoryPanel` (grepped: zero hits), `hasSignature` is a
  derived projection of an existing column, and there is no new model or child section. No
  `invalidateHistory()`, no `INVALIDATION_SITES` entry.
- **No migration.** `signatureMimeType` already exists (`prisma/schema.prisma:26`).

### One more consumer, confirmed harmless

`src/app/quotes/[id]/QuoteDetail.tsx:249` fetches the same list as `UserOption[]`. `api<T>` is an
unvalidated cast, so the added field is structurally harmless and QuoteDetail needs no change. Confirmed
rather than assumed — say so in the report.
