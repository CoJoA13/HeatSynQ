# Task 1 report — #162, the finance charge is shown but never levied

**Scope honoured:** informational only. No invoice, no invoice line, no aging entry, no GL posting,
no new entity, no migration, no audit-registry edit, no Serializable or allocating path. Nothing in
`src/server/statements.ts` changed except comments — the returned payload is byte-identical.

---

## What changed and why

### 1. The printed label — the load-bearing constraint

`src/lib/template-contracts/statement.ts`, `finance_charge.finance_charge.defaultLabel`:

```
- "Finance Charge:"
+ "Finance Charge (not billed, not in total):"
```

**I checked, and confirm, that the fix is made through the contract `defaultLabel` and NOT by
re-ordering the `finance_charge` section below `total`.** The section order in
`STATEMENT_CONTRACT.sections` is untouched, and `buildStatementDefinition` still walks
`completeSections(...)` in config order. The reason is verified in the code rather than assumed:
`defaultFieldConfig` (`template-contracts/types.ts:257`) writes `label: null`, so **no stored config
carries a label at all** — every one of them re-resolves the label against the current contract at
every print, which is exactly the #103 asymmetry the brief names. A section re-order, by contrast,
lives in `SectionConfig[]` order inside each stored config, so it would have reached the default
template and silently missed every already-published version. Both the contract and
`pdf/statement.ts`'s `financeChargeBlock` now carry a comment saying so, in the imperative ("Do not
'fix' it by moving the section"), because that is the shape the next reader will reach for.

**Drift guard checked, not assumed.** Because stored configs pin `label: null`, the seed migration's
SQL literal contains no label text, so `tests/template-seed.test.ts`'s three-copies drift guard is
untouched by this change. Verified by running it — green.

**Wording chosen for a reason.** It states both facts the owner ruling requires (not billed; not part
of the total) and it FITS: `totalLine` gives the label a 200pt column at 10pt, and I measured the
candidates against the real font metrics (`@foliojs-fork/pdfkit` `widthOfString`) across all four
contract families — 173.6pt Roboto, 175.1pt Liberation Sans, 161.2pt Liberation Serif. The obvious
longer phrasing, `"Finance Charge (not billed, not in Total Due):"`, measures **195.8pt Roboto /
198.4pt Liberation Sans** — inside the budget by 1.6pt, which is not a margin, so it was rejected.
"total" is lower case deliberately: `total_due`'s own label is overridable, so the finance label must
not quote it as if it were fixed.

### 2. The screen control

`Statements.tsx:511` "Assess finance charges" → **"Show finance charge (not billed)"** (the owner's
own suggested shape). The wire field keeps its name (`assessFinanceCharges` is the API contract);
only the operator-facing text changed.

### 3. The screen preview

`Statements.tsx:598-604` "Finance charge:" → **"Finance charge (not billed, not in total):"**, so the
preview reads exactly like the paper. Deliberately NOT moved below "Total due:" either — the screen
mirrors the print, and the print's order is the template's.

### 4. The spec, which contradicted the ruling

- `docs/superpowers/specs/…-heat-treat-erp-design.md:121` — the "per-invoice dispute/exempt;
  idempotent run (re-running cannot duplicate)" promise is gone, replaced with the informational
  statement, citing P5B §3 ruling 9, P5C §3 ruling 4 and the 2026-08-19 owner ruling.
- `:166` — "finance-charge run" struck from the idempotent multi-step operations list, with a
  parenthetical saying why so the removal is not silently reverted.

`§15` untouched. `git diff` on the spec confirms exactly those two lines changed and nothing else.

### 5. `financeChargeExempt` — left dead, with the reason recorded

Comment at `statements.ts:253ff` states plainly that it is a **live input with no writer**: read at
`:267` (`pastDueBalances.push({ open, exempt: inv.financeChargeExempt })`), so it is not inert and is
not safe to delete on "nothing sets it" grounds; that no UI writer may be added; and that the §7.6
"dispute/exempt" promise was removed in this same change precisely because nothing delivers it.

### 6. Docs

`docs/manual/07-receivables.md` — the control renamed in the controls table, the preview paragraph
now names the finance line, and the caveat block is rewritten as a positive statement ("shown, never
billed — by design, not by omission"), adding that there is no run and nothing stored so nothing can
duplicate, plus a short paragraph on why there is no per-invoice exemption.

---

## TDD — the failures actually observed

Tests written and run BEFORE the implementation, red first:

```
FAIL tests/template-contracts.test.ts > the statement contract > reproduces the form labels exactly
AssertionError: expected 'Finance Charge:' to be 'Finance Charge (not billed, not in to…'
  Expected: "Finance Charge (not billed, not in total):"
  Received: "Finance Charge:"

FAIL tests/statement-pdf.test.ts > labels the finance charge as neither billed nor part of the total (#162)
AssertionError: expected 'LETTER 24 24 24 40 Roboto 9 Statement…' to contain 'Finance Charge (not billed, not in to…'
  (received definition text contained "… 200 Finance Charge: 10 right 100 $6.00 …")
```

`Test Files 2 failed (2) | Tests 2 failed | 102 passed`. After the one-line contract change, both
green with no other edit.

**Second, separate red — the no-wrap pin.** `tests/statement-pdf.test.ts` gains
`"prints that label on ONE line — it fits the 200pt label column (#162)"`. My first attempt at it
used `drawnText(pdf).toContain(label)` and **passed against a deliberately over-long 76-character
label**, i.e. it was vacuous: `drawnPages` concatenates runs with `""`, so a wrapped label
reassembles across the line break. I probed it, saw the pass, and replaced it with a
`textRunsWithY`-based helper that reads only the single baseline the label's first run sits on. The
probe against the same over-long label then failed correctly:

```
FAIL tests/statement-pdf.test.ts > TEMP non-vacuity probe
  Expected: "Finance Charge (not billed and definitely not part of the Total Due below):"
  Received: "Finance Charge (not billed and definitely not $6.00"
```

(The over-long label's runs sat at y=522.23 and y=510.51 — two baselines. The shipped label's runs
all sit at y=522.23.) The probe was then deleted; only the real assertion remains.

**`tests/statements.test.ts` — the `totalDue`-excludes-the-charge pin passed on its first run, and
that is by design, not an oversight.** It is a regression pin on behaviour the ruling says is already
correct, so there was nothing to make fail. Reported here rather than dressed up as TDD. It is not
vacuous: it asserts a **non-zero** charge (6.00) first, then that `totalDue === aging.net`, then that
an assessed run and an un-assessed run of the same data agree on `totalDue`, `aging` and `openItems` —
so the charge adds a line and never a number.

---

## Gates

| Gate | Command | Result |
|---|---|---|
| My suites | `DATABASE_URL_TEST=…/erp_test_c1 npx vitest run tests/statement-pdf.test.ts tests/template-contracts.test.ts tests/template-preview.test.ts tests/statements.test.ts` | **137 passed, 4 files** |
| Adjacent template suites (belt) | same, plus `tests/finance-charges.test.ts tests/statement-templates.test.ts tests/template-seed.test.ts tests/template-editor.test.ts` | **235 passed, 8 files** |
| Typecheck | `npx tsc --noEmit` | **clean** |
| Lint | `npx eslint src tests` | **clean** |
| E2E parse | `node --check e2e/flows/receivables-apply-age-statement.mjs` | **OK** |

Ran on the private scratch DB `erp_test_c1` via `DATABASE_URL_TEST` throughout — never `DATABASE_URL`.

`npm test` and `npm run test:e2e` deliberately NOT run: the controller runs those once for the group
(explicit instruction, which overrides the brief's "run the full `npm run test:e2e`"). The E2E risk
this change carries is the one selector, `getByLabel("Show finance charge (not billed)", { exact: true })`
— same shape as the adjacent `"Combine family"` locator that already works, and Playwright trims and
normalises whitespace under `exact`. Also checked: the flow's `page.locator("p", { hasText: "Total due:" })`
still resolves uniquely — `hasText` is a case-insensitive substring match and the relabelled preview
paragraph reads "…not in total): 6.00", which does not contain "total due".

---

## Brief defects and inaccuracies found

1. **`§5:121` is a mis-citation.** Line 121 of the main spec sits under **§7.6 "Invoicing, A/R,
   QuickBooks Online"**, not §5. (`§12:166` is correct.) I corrected the right line; the comment I
   left in `statements.ts` cites §7.6.

2. **`tests/template-preview.test.ts:269` does NOT "go red" on the relabel — it goes silently
   vacuous.** The brief lists it among three suites that "will go red". It is a *negative* assertion
   (`not.toContain("Finance Charge:")`), so after the relabel it passes for the wrong reason: the
   string no longer exists anywhere. I weakened the literal to the stem `"Finance Charge"`, which is
   non-vacuous and strictly stronger, and left a comment recording the trap. Anyone who had taken the
   brief literally would have seen only two of the three suites fail and might have concluded the
   third was already fine.

3. **`tests/statement-pdf.test.ts:84,87` would not have gone red either** — both are
   `toContain("Finance Charge")` without the colon, which the new label still satisfies. The brief
   names those two line numbers as carrying "the literal". They carry a prefix of it. I left the
   existing case alone (it is about presence/absence, not wording) and added a separate case that
   pins the whole label.

4. **`docs/manual/manual.html` carries the stale strings and is outside my file list.** Lines 699 and
   705 are a compiled single-page build of the manual chapters ("Assess finance charges" in the
   controls table and the whole old caveat paragraph). There is no generator script for it anywhere
   in the repo (grepped), and `docs/manual/README.md` does not mention it, so I could not regenerate
   it and did not hand-patch it. **Someone needs to regenerate or hand-patch `manual.html`, or the
   published manual will contradict both the app and `07-receivables.md`.**

5. **`docs/manual/walkthrough.md:40`** — the "Filed from this walkthrough" table's #162 row still
   describes the control as *"Assess finance charges" prints a finance charge that is never charged*.
   That file belongs to Task 2's file list, not mine, so I did not touch it. Task 2's implementer or
   the controller should decide whether the row is updated or left as the historical filing text (it
   reads as a record of what was filed, so leaving it is defensible — but the quoted control name is
   now wrong).

6. **`docs/manual/img/receivables-statements.png` still shows the old checkbox label.** It regenerates
   from `npm run manual:capture`, which Task 2 is running anyway — worth confirming the new label
   appears in the regenerated screenshot.

7. **A third stale spec line the brief did not name: `§13`, line 172** — *"every business rule in §7
   … (…, FC idempotency, export idempotency, …) gets automated tests written before implementation"*.
   Same stale premise as the two corrected lines: there is no FC idempotency to test. The brief
   restricted me to "the §5:121 and §12:166 corrections ONLY", so **I did not touch it** — flagging it
   so it does not become the thing that re-opens #162. Also worth a glance, though weaker:
   `docs/manual/12-administration.md:227` describes the billing rate as "The monthly late charge
   rate", which still implies a levy. Neither file is in my list.

---

## Deliberately not done

- No posting of any kind — no invoice, line, aging entry, GL posting, entity, or migration.
- No `financeChargeExempt` writer, no UI for it, and the column was not removed.
- No re-order of the `finance_charge` section relative to `total`, on either surface.
- No change to what `statements.ts` returns (`totalDue: aging.net` is untouched; comments only).
- No edit to `docs/HANDOFF.md` (controller owns it), `docs/superpowers/specs/…§15`,
  `docs/manual/walkthrough.md`, `docs/manual/manual.html`, or spec §13.
- No git state changes of any kind — edits left in the working tree for the controller to commit.
