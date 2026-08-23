# Task 5 report — Gate infrastructure (#169): figures the repo can actually regenerate

Branch `gate-infrastructure`. Two files of substance (`erp/e2e/manual-capture.mjs`,
`erp/scripts/build-manual.mjs`), one new leaf, one new test, the lint gate widened, plus the
regenerated figures and page.

**Headline: `npm run manual:capture && npm run manual:build` now produces a publishable page with
no hand step anywhere. 13,062,687 bytes of the 16,777,216 ceiling — 77.9%, with 3.54 MB of
headroom — down from 15,317,815 (91.3%) that only fitted because ImageMagick had been run over
`docs/manual/img/` by hand. No compression of any kind was applied at any point in this task.**

---

## 1. What changed

| File | Change |
|---|---|
| `erp/e2e/manual-capture.mjs` | `DEVICE_SCALE` default `2` → `1`; the comment above it rewritten to say why, and to name the coupling |
| `erp/scripts/lib/manual-figure-size.mjs` | **new.** The figure-sizing rule, as a pure dependency-free leaf |
| `erp/scripts/build-manual.mjs` | consumes the leaf; `IMG_SCALE_NUM`/`IMG_SCALE_DEN`/`displayPx` deleted; three comment blocks corrected from present tense to past |
| `erp/tests/manual-figure-size.test.ts` | **new.** 6 cases, RED-verified against the old rule |
| `CLAUDE.md`, `.github/workflows/ci.yml` | lint gate → `npx eslint src tests e2e scripts prisma` |
| `CLAUDE.md`, `docs/HANDOFF.md`, `docs/manual/dataset.md` | the standing docs |
| `docs/manual/img/*.png` (50), `docs/manual/manual.html`, `docs/manual/sweep.md` | regenerated |

### (a) The capture scale

`DEVICE_SCALE = Number(process.env.MANUAL_SCALE ?? 1)`. The env knob already existed, so this is a
default, not new machinery. The old comment justified 2× as *"so the PNGs stay legible when a manual
embeds them and scales them down"* — measurement says the density was never reaching a reader
(§4).

### (b) The coupled change, in the same commit

`build-manual.mjs` computed display size as `Math.round(px * 10 / 24)`. That constant **is**
`1200/2880`: it hardcoded "captured at deviceScaleFactor 2 on a 1440px viewport". Landing (a)
without it renders every figure at half size.

The replacement is resolution-independent, exactly as the issue words it (the constant was renamed
to `DECLARED_WIDTH_PX` in the fix round — see §12.3 — so this snippet is as it landed here, not as
it stands):

```js
export const MANUAL_COLUMN_PX = 1200;

export function figureDisplaySize({ width, height }) {
  if (width < MANUAL_COLUMN_PX) return { width, height };
  return {
    width: MANUAL_COLUMN_PX,
    height: Math.max(1, Math.round((height * MANUAL_COLUMN_PX) / width)),
  };
}
```

Two decisions inside it worth naming:

- **It lives in its own file.** `build-manual.mjs` runs `build()` at module scope — importing it
  from a test would run the whole build — so the rule could not otherwise be tested at all. This is
  Task 2's precedent (`e2e/lib/failure-classify.mjs`) applied a second time. The script's
  "ZERO DEPENDENCIES" header now says the leaf is its one non-builtin import, so the claim stays
  true rather than quietly weakened.
- **The `Math.max(1, …)` clamp** is not in the issue. A very wide, very short image (a 3000×1
  rule) would round to a declared height of `0`, which collapses the figure before its bytes
  decode. Nothing in `img/` is that shape today; the clamp costs nothing and removes the case.

I did **not** take option 2 or 3 from the issue. No image encoder was added, nothing shells out,
and `manual:build` is still Node built-ins only — which §3 verifies rather than asserts.

---

## 2. The acceptance test: capture → build, no hand step

### `npm run manual:capture`

**Exit status 0.** Wall clock 70.6 s, 45 routes discovered from `src/app/**/page.tsx`, 50 screens
captured.

`docs/manual/sweep.md`, read in full:

| Outcome | Screens |
|---|---:|
| PASS | 50 |
| WARN | 0 |
| FAIL | 0 |
| ERROR | 0 |
| SKIPPED | 0 |

**No console errors, no uncaught page errors, no failed requests.** Nothing was filtered as
dev-server noise. Four screens are flagged as rendering "almost nothing" — `/login`,
`/admin/roles`, `/admin/surcharges`, `/practice` — and all four carry a standing
reviewed-and-cleared annotation in the sweep itself (roles and surcharges render lists rather than
tables, so the "no table rows" half of the heuristic cannot see them; `/practice` is correctly
empty on the production database). That is the same four as the previous sweep: not a regression,
and not caused by this change.

### `npm run manual:build`

**Exit status 0.** 14 chapters, 46 figures, 45 distinct images, and the five-unreferenced-captures
note printed as a note (§6).

### The number

```
docs/manual/manual.html   13,062,687 bytes
publish ceiling           16,777,216 bytes
                          77.9% — 3,714,529 bytes (3.54 MB) of headroom
```

Below the build's own 85% soft threshold, so it printed no ceiling warning at all — the first time
that has been true.

For comparison, both measured on this branch:

| | `img/` on disk | `manual.html` | % of ceiling |
|---|---:|---:|---:|
| Before (2× capture, **hand-compressed with `magick`**) | 11,833,311 | 15,317,815 | 91.3% |
| After (1× capture, **nothing hand-run**) | 10,013,307 | 13,062,687 | 77.9% |

**No ImageMagick, no `magick`, no image tool of any kind was run against `docs/manual/img/` in this
task.** The `img/` figure above is what Playwright wrote. If that had not been true the task would
have failed and this report would say so.

### Determinism

`manual:build` run twice, immediately:

```
f9d8b1e945bfc36dbfde38ac453cc7fd291e4b1d60ffb5f6fa40a437929bee16   run 1
f9d8b1e945bfc36dbfde38ac453cc7fd291e4b1d60ffb5f6fa40a437929bee16   run 2
```

`cmp` reports byte-identical. Stronger than that: the same digest came back **after** an
intervening mutate-and-revert cycle (a probe figure added to chapter 1 and a probe PNG added to
`img/`, built, then both removed and rebuilt — §3), so the output depends on the inputs and on
nothing else.

---

## 3. Verifying the sizing rule — three separate proofs

### Unit, RED-verified

`erp/tests/manual-figure-size.test.ts`, 6 cases. RED was established by substituting the OLD rule
(`round(px * 10/24)`) into the leaf and running the file: **5 of 6 failed.** The two that matter
most: `1440×900` (a 1× capture) expected `1200×750`, got **`600×375`** — the half-size failure the
issue predicted — and `600×360` (a narrow clip) expected `600×360`, got **`250×150`** — the live
distortion. The only case that survived the old rule is "is it a pure integer function", which both
rules satisfy; it is in there for determinism, not for the sizing decision. Restored, all 6 pass.

```
npx vitest run tests/manual-figure-size.test.ts   →  6 passed (6)
```

The suite was not run whole — the group's controller runs `npx vitest run` centrally.

### End-to-end, through the real build

A synthetic 600×360 PNG (written with `zlib` in Node, no image tool) was dropped into
`docs/manual/img/` and referenced from chapter 1, and `manual:build` run:

```
<figure><img src="data:image/png;base64,…" alt="Narrow clip probe" width="600" height="360" …>
```

Intrinsic width, as required. Under the old factor the same probe declared **`250×150`**, measured
in the same way. Both the probe PNG and the chapter edit were reverted, and the rebuilt page
returned to the digest above.

### The coupling, demonstrated rather than argued

With the new 1× captures in place and the OLD rule restored, the very first figure declares:

```
alt="The sign-in screen" width="600" height="375"      ← old rule + new capture: HALF SIZE
alt="The sign-in screen" width="1200" height="750"     ← as shipped
```

That is the failure the issue warned about, reproduced deliberately and then undone.

---

## 4. Spot-check of the rendered page — how I checked

Not by eye. `manual.html` was opened from `file://` in the bundled Chromium at a 1440×900 viewport
and every `<img>` measured from the DOM: declared attributes, `naturalWidth`/`naturalHeight`, and
`getBoundingClientRect()`. All 47 images (46 chapter figures plus the probe, during the probe
build):

- **The content column is 800 CSS px** (`.content` is `max-width:50rem`). Measured, not assumed —
  and it is the number that settles the density argument: a 1440px capture is still shown at 800,
  i.e. 1.8× oversampled, so 2× capture was 3.6× oversampled and no reader was ever seeing it.
- **Every full-width figure renders 800 × (its aspect ratio)** — identical to before this change.
  Nothing renders at half size.
- **The narrow probe renders at 600 CSS px**, its intrinsic width, not 250 and not 800.
- **Zero aspect-ratio mismatches** across all 47 (declared ratio vs intrinsic ratio, tolerance
  0.01), so the reflow reservation is honest for every figure.

Legibility was also checked directly, since dropping to 1× costs sharpness by definition: the
`receivables-aging.png` capture was opened and read — the full A/R aging table, six customer rows,
seven money columns, all figures legible at 1440×900.

**The live distortion the issue predicted: real, but not currently visible.** Every capture in
`img/` today is a full-page shot at viewport width, so every one of them is at least the column
width and was being sized correctly by accident. There is no element-clip figure in the manual, so
no current figure was rendering wrong. The defect was latent, and the probe above is what
demonstrates it — the answer to "check whether any current figure is affected" is **none**.

---

## 5. #170 and `invoicing-detail.png` — the number, for the issue

Not fixed here, as instructed. Measured so #170 can carry it.

> **Superseded by §12.5 (fix round).** The arithmetic below reproduces exactly, but it prices every
> hypothetical at the FLEET density when that figure's own density is 1.61x the fleet, which makes
> the low end of the range optimistic. §12.5 restates it with the basis named, and the corrected
> number is the one now on #170.

| | |
|---|---|
| Dimensions | **2974 × 2868** — the only figure not 1440 wide, because the invoice page overflows horizontally |
| On disk | **1,213,061 bytes** = 12.1% of all of `img/` |
| Inlined as base64 | **1,617,416 bytes** = **12.4% of the whole 13.06 MB page** |

What it would cost if #170 were fixed: the other 49 figures give a measured **0.0877 bytes/px**
over 100.3 Mpx, and the same screen at 1440 wide would be 1440 × H.

| Hypothetical | On disk | Inlined |
|---|---:|---:|
| 1440 × 2868 (JSON rewrapped into a scroller — page height unchanged) | ~362 KB | ~483 KB |
| 1440 × 4302 (page 1.5× taller) | ~544 KB | ~725 KB |
| 1440 × 5937 (page 2.07× taller — total text area preserved) | ~750 KB | ~1,000 KB |

So **fixing #170 frees roughly 0.6–1.1 MB of the page**, on top of removing the defect. Worth
adding for whoever picks it up: that figure is displayed at 800 CSS px, so its 2974 px of
horizontal detail is downscaled 3.7× and **the raw snapshot JSON is unreadable in the manual
anyway** — the figure is paying full price for content no reader can use.

---

## 6. The five unreferenced captures

`manual:build` reports, as a note and not an error:

```
note: 5 captured screenshot(s) no chapter references: admin-templates-edit.png,
      interaction-disabled-with-reason.png, orders-detail.png, orders-new.png, setup.png
```

Left exactly as they are. Nothing deleted, and the note is still a note — capture photographs every
screen and the manual chooses a subset, which is the design.

**`orders-detail.png` filed as [#191](https://github.com/CoJoA13/HeatSynQ/issues/191)**
(`ready-for-agent`, `documentation`), not fixed here. Chapter 2 has a section titled "The order
hub" whose paragraph lists the header, lines, loads, containers, serials, charges, documents and
History panel — and carries no picture of any of it. Orders is the only detail screen in the manual
the reader never sees; quotes, shipping, certs, invoicing, customers and parts all show list **and**
record. The screenshot is captured every run. The issue carries the table, the suggested caption,
and the ~388 KB budget against the 3.54 MB of headroom this task created.

---

## 7. The lint gate

`npx eslint src tests e2e` → **`npx eslint src tests e2e scripts prisma`**, in `CLAUDE.md`'s gate
block and in `.github/workflows/ci.yml`'s Lint step.

`build-manual.mjs` had never been linted, and I was about to change it — Task 3's finding.

**Both new directories are clean; nothing had to be fixed.** I did not take that on trust: ESLint
exits 0 both when a directory is clean and when it matched no files at all, so each was probed by
dropping a deliberately-bad file in and confirming it was reported —
`scripts/__lintprobe.mjs` (two warnings: `no-unused-vars`, `no-unused-expressions`) and
`prisma/__lintprobe.ts` (one). Both probes removed. So the gate genuinely reaches `.mjs` under
`scripts/` and `.ts` under `prisma/`.

**`prisma/` was cheap, so it went in too**, per the brief's conditional. It costs three files
(`seed.ts`, `demo-seed.ts`, `manual-seed.ts`) — `prisma/generated/**` is already in the config's
`ignores`, and `migrations/**` is `.sql`, which ESLint does not match. `scripts/backup.sh` is
likewise not a JS file and is untouched.

---

## 8. Gates

| Gate | Result |
|---|---|
| `npm run manual:capture` | **exit 0** — 50 PASS, 0 FAIL/ERROR/WARN/SKIPPED, sweep clean |
| `npm run manual:build` ×2 | **exit 0**, byte-identical (`f9d8b1e9…`), 13,062,687 B / 16,777,216 B |
| `npx tsc --noEmit` | **clean** |
| `npx eslint src tests e2e scripts prisma` | **clean** |
| `node --check` on all three `.mjs` touched | **clean** |
| `npx vitest run tests/manual-figure-size.test.ts` | **6 passed** |
| `npm run test:e2e` (dataset loaded) | **exit 1 — REFUSED, correctly.** §9 |
| `npm run test:e2e` (after `db:reset`) | **25/25 PASS, 0 RETRIED, exit 0.** §9 |

Full `npx vitest run` deliberately not run — the controller runs it centrally.

---

## 9. `npm run test:e2e`, run twice, reported honestly

**Run 1, against the dev database carrying the demonstration dataset — refused in about a second,
which is the correct outcome and is Task 3's work proving itself:**

```
Error: Refusing to run the flows: the dev database (erp) holds state the E2E suite cannot run against:
  - 1 OPEN receipt batch(es) carry a payment dated in 2026-08. close-month-end asserts a plant-wide
    unpostedBatchCount of 0 and will not post a batch it did not create. The demonstration dataset
    leaves exactly one open on purpose, to teach the reconciliation.
  - 2026-08's continuity schedule does not reconcile (variance 1250). ...
The E2E suite and the demonstration dataset cannot share a database (docs/manual/dataset.md).
  To run the suite:      npm run db:reset  ...
```

Exit 1. Named, evidenced, with a recipe that exists. Both listed reasons are precisely the two the
dataset creates on purpose.

**Run 2: `npm run db:reset -- --yes` (truncated 74 tables, restored the singletons and the eight
Standard templates, re-seeded admin — ~1 s), then the full suite. `All 25 flows passed.` Exit 0.**

The pre-flight now reports the clean state instead of refusing:

```
Dev DB pre-flight for 2026-08: no close period, 0 unposted batch(es), variance 0,
  0 ambient readiness gap(s)
```

25 PASS, **0 RETRIED**, 0 FAIL. Warm-up compiled 243 routes (45 pages, 198 API) in 20.8 s before
flow 1, and the flow-lint sweep cleared all 25 flow files. Full log captured to a file and read
before this was written; nothing in it was skipped or summarised away.

Neither run exercises the code this task changed — `manual-capture.mjs` and `build-manual.mjs` are
not on any flow's path, and `run.mjs` was not touched. It was run because `CLAUDE.md` says to run
it whenever a change touches any UI, function or flow, and because run 1 is the proof Task 3 asked
for.

---

## 10. Rebuilding the dataset — a side verification worth recording

The capture needs the demonstration dataset, so `docs/manual/dataset.md`'s "Rebuilding it" sequence
was run end to end from a dropped database (2026-08-22). **It reproduced exactly**: every A/R aging
bucket, every per-customer row, the 11,334.96 of unapplied cash, the +13,501.35 Net, and August's
1,250.00 continuity variance — which chapter 8 quotes in prose, so a drift there would have made
the manual wrong. Verified by reading the figures off the new `receivables-aging.png` against
`dataset.md`'s table.

That is a real result about the seed: its back-dating is relative to the seed date, so the bucket
distribution is stable across rebuild dates rather than being a property of 2026-08-19.
`dataset.md` records it.

---

## 11. Found, not fixed

1. **#170 is still live and is now the single largest line item in the page** (§5). Out of scope by
   instruction; the number is above and belongs on the issue.
2. **#191 — chapter 2 never shows the order hub** (§6). Filed, not fixed.
3. **`e2e/manual-capture.mjs` is not covered by the lint gate's spirit in one respect**: it is
   linted (as `e2e/`), but nothing tests it. `DEVICE_SCALE` is the second constant in this pair to
   have had a silent coupling to the other file; the sizing half is now pinned by a test and the
   capture half is not. There is no obvious cheap test for "the capture writes at scale N" that
   does not start a browser, so this is recorded rather than fixed.
4. **The manual has no element-clip figure**, so the fixed distortion has no live regression guard
   beyond the unit test. If one is ever added, that test is the thing that keeps it honest.

---

# Fix round — the six minors

Six findings, all taken. One of them (Minor 1) changed a figure and therefore the page, so the
demonstration dataset was rebuilt and the whole manual re-captured; the new byte count is below and
in `docs/HANDOFF.md`.

## 12.1 Minor 1 — a generated report asserted something untrue

`page.screenshot({ clip })` **without** `fullPage: true` resolves the clip against the **viewport**.
So the clipped branch wrote the top **900** CSS px while `sweep.md` published *"Screenshot clipped to
the top 6000px of a 7627px page"* — and `MAX_SHOT_HEIGHT` had, in effect, no meaning beyond deciding
*when* to abandon a full-page shot. Pre-existing, not a Task 5 regression: the old 2x file was
2880x1800, which is the same 900 CSS px.

**Taken the preferred way: the code was made true, not the note weaker.** `fullPage: true` alongside
the clip, so the cap means `min(pageHeight, 6000)` — continuous, and what the docstring always
claimed. Playwright accepts the pair and produced exactly 1440x6000, verified by probe before the
change was adopted (`MANUAL_ONLY=/admin/audit` into a scratch `MANUAL_OUT_DIR`, so nothing in
`docs/manual/` was touched while measuring).

Three places now state one contract: `MAX_SHOT_HEIGHT`'s docstring, `shoot()`'s screenshot options,
and the sweep's wording. The sweep header also states the capture scale now (`1440x900 at
deviceScaleFactor 1 — a full-page shot is 1440px wide`), because that is a contract a test pins, not
an incidental.

### The byte impact, plainly

| | Before | After |
|---|---:|---:|
| `admin-audit.png` | 1440x900, 171,132 B | **1440x6000, 996,750 B** |
| `docs/manual/img/` | 10,013,307 B | 10,877,437 B |
| `manual.html` | 13,062,687 B (77.9%) | **14,213,844 B (84.7%)** |
| Headroom to 16 MB | 3.54 MB | **2.44 MB** |

**+1,151,157 B on the page, and it lands 46,789 B under the build's own 85% soft warning** — so the
build still prints no warning, but the next figure of any size will trip it. That is the warning
doing its job rather than a problem, and #170 is where the room comes back from (§12.5). Said
plainly because the reviewer asked for it said plainly: this spends about a third of the headroom
Task 5 created, on one figure, to make one sentence true.

The figure itself is in family rather than an outlier — declared 1200x5000, rendered 800x3333, where
`parts-detail.png` already renders 800x2858.

## 12.2 Minor 2 — the leaf header over-stated its own guarantee

"Resolution-independent" and "a future capture-size change is then free" hold only **at or above**
`DECLARED_WIDTH_PX`. Below it the declared width is the intrinsic *physical* width, so a 600 CSS px
element clip declares 600 at scale 1 and 1200 at scale 2.

The header now says so, and says why it is inherent rather than a defect in the implementation: **a
PNG's IHDR carries no device scale factor**, so a build handed only bytes cannot recover the CSS
size. That is a property of the rule #169 mandated, not of this code. No such figure exists today
(narrowest intrinsic width: 1440). A test case pins both halves — equal output at 1x and 2x above
the threshold, unequal below it — so the honest half is asserted rather than only described.

## 12.3 Minor 3 — `MANUAL_COLUMN_PX` was not the column

Renamed to **`DECLARED_WIDTH_PX`** (leaf, test, and both prose sites). The rendered column is **800**
CSS px; 1200 is the declared-attribute cap whose only job is to fix the aspect ratio and reserve the
space. No conclusion changes and the density argument gets *stronger*: 1440 shown at 800 is 1.8x
oversampled, so the retired 2x capture was 3.6x — which is now the line the constant's docstring
carries, since that is the argument the constant exists inside.

`CLAUDE.md`'s `manual:build` paragraph repeated #169's loose "1200px column" and is fixed;
its `manual:capture` paragraph already had it right and was left alone.

## 12.4 Minor 4 — nothing guarded the committed page

Three guards, all browser-free.

**(a) CI rebuilds the manual and requires a no-op diff** — `.github/workflows/ci.yml`, in the **`ci`
job**, between Lint and Build. Why there, given that job runs 12+ minutes against a 15-minute cap:
`manual:build` is **0.18 s** measured, i.e. 0.02% of the budget, and it needs nothing the job does
not already have — no database, no Prisma client, no browser, only the checkout and Node. A separate
parallel job would cost *no* wall clock, which is the better argument on cost and the worse one on
effect: **`ci` is the check the branch protection rules require, and a docs-rot guard that cannot
block a merge is the rot again.** The step prints `--stat` rather than the diff itself, because the
diff is a 13 MB single-line base64 payload.

**(b) and (c) `erp/tests/manual-artifacts.test.ts`** (new, 5 cases) — the artifact half:

- `manual.html` is under the ceiling, with the 16 MB read out of `build-manual.mjs`'s own
  `PUBLISH_LIMIT` rather than restated, and the remaining margin printed either way (a test that
  only says "pass" tells whoever is adding a figure nothing).
- **every PNG's IHDR width is <= the capture viewport width**, with the viewport read out of
  `manual-capture.mjs`'s own `VIEWPORT`. That **pins `DEVICE_SCALE = 1` from the artifact itself**,
  with no browser — closing the "untested half of a coupled pair" §11.3 recorded.
- `invoicing-detail.png` is the one exemption, an **entry with a reason** (#170) rather than a raised
  bound, plus a staleness case: when #170 lands and the figure comes back at 1440, that case reds
  until the entry is deleted.
- a belt on the source: the `MANUAL_SCALE ?? 1` default itself, so changing it reds *before* any
  re-capture has happened.
- and a "there are figures at all" case, so the width sweep cannot pass vacuously on an empty glob.

Neither harness can be imported (both run at module scope), so both constants are lifted by regex
against the real source, and a regex that matches nothing throws by name rather than defaulting.

**RED-verified, every new assertion:** dropping the #170 exemption reds the width sweep with
`invoicing-detail.png (2974x2868)` and reds the staleness case; putting `MANUAL_SCALE ?? 2` back reds
the scale belt; moving `PUBLISH_LIMIT` to 12 reds the constant guard, and following it to 12 in the
test reds the size check with `expected 13062687 to be less than or equal to 12582912`. All restored.

## 12.5 Minor 5 — the #170 estimate's basis

The original arithmetic reproduces exactly, and it is priced at the wrong rate. The fleet is
**0.0897 B/px** (the other 49 figures, recomputed after the re-capture), but `invoicing-detail.png`'s
**own** density is **0.1445 B/px — 1.61x the fleet**, because antialiased JSON text compresses badly
per pixel.

| | Recovered |
|---|---:|
| JSON behind a scroller (option 1), page height unchanged — those pixels become ordinary UI, so the fleet rate applies | **~1.09 MB** |
| JSON still visible, page height unchanged — priced at its own 0.1445 B/px | 0.80 MB |
| Reflow makes the page 1.5x taller | 0.43 MB |
| Reflow makes the page ~2x taller (text area preserved) | ~0 — nothing |

Quoted from here on as **"~1 MB in the likely case, less if the reflow makes the page much taller"**,
with the basis named. §5 above is marked superseded rather than silently edited.

Current figures for the record: 2967x2868 (the re-capture shifted it by 7px), 1,229,354 B on disk,
**1,639,140 B inlined = 11.5% of the page** — still the single largest line item, now with
`admin-audit.png` second at 9.35%.

## 12.6 Minor 6 — the number is on the issue

Posted to #170 as a comment:
<https://github.com/CoJoA13/HeatSynQ/issues/170#issuecomment-5383534566>. Factual, no customer data,
no account numbers, no names — the repo is public. It leads with the fact that **the dimensions in
the issue body are pre-#169** (captured at 2x, so every number there halves), carries the table
above with the density caveat stated, notes the page is at 84.7% of the ceiling, and closes on the
point that the JSON is unreadable in the manual anyway (2967 intrinsic px shown at 800), which is an
argument for option 1's shape rather than for capturing the screen differently.

## 12.7 The re-capture, and the dev database

The dataset was rebuilt from a dropped database by `docs/manual/dataset.md`'s exact sequence, the
full capture run, and `npm run db:reset -- --yes` run afterwards — **the dev database is back to its
pristine post-reset state**, which is where this round found it.

`npm run manual:capture`: **exit 0, 50 PASS, 0 WARN/FAIL/ERROR/SKIPPED, sweep clean**, no console
errors, no page errors, no failed requests. The same four standing sparse screens (`/login`,
`/admin/roles`, `/admin/surcharges`, `/practice`), all four already annotated as reviewed-and-cleared.

**Only 18 of the 50 PNGs changed at all** — the rest are byte-identical to the ones committed
yesterday, which is a real statement about the seed's determinism, and the 18 are the detail screens
carrying ids and audit timestamps. `invoicing-detail.png` moved 2974 -> 2967 px wide for the same
reason.

## 12.8 Gates

| Gate | Result |
|---|---|
| `npm run manual:capture` | **exit 0** — 50 PASS, 0 FAIL/ERROR/WARN/SKIPPED |
| `npm run manual:build` x2 | **exit 0**, byte-identical (sha256 `8a9899a7…`), 14,213,844 B / 16,777,216 B |
| `git diff` after a second build | **empty** — the committed page is a no-op rebuild |
| `npx tsc --noEmit` | **clean** |
| `npx eslint src tests e2e scripts prisma` | **clean** |
| `node --check` on all three `.mjs` touched | **clean** |
| `npx vitest run tests/manual-figure-size.test.ts` | **7 passed** (6 + the resolution-independence case) |
| `npx vitest run tests/manual-artifacts.test.ts` | **5 passed**, each RED-verified |
| `actionlint` on `ci.yml` | **clean** |
| `actionlint -shellcheck` on `ci.yml` | one finding, **pre-existing and not mine** — §12.9 |
| `npm run test:e2e` | **not run** — §12.9 |

## 12.9 Found, not fixed

1. **`shellcheck` reports `SC2034: i appears unused` in the `docker` job's boot loop**
   (`.github/workflows/ci.yml:122`, `for i in $(seq 1 60)`). Pre-existing, in a job this round did
   not touch, and a one-character fix (`for _ in`) — left alone rather than reaching into an
   unrelated job during a fix round. `actionlint` on its own is clean, including the new step.
2. **`npm run test:e2e` was not run, and nothing this round changed is on its path.** Verified rather
   than assumed: nothing under `e2e/flows/`, `e2e/run.mjs` or `e2e/lib/` imports `manual-capture.mjs`
   or the figure leaf, and both `flow-lint` sweeps scope to `e2e/flows/` specifically, so the edits
   to `e2e/manual-capture.mjs` are outside every sweep and every flow. The suite was run twice during
   the main round (§9) and the code it exercises has not moved since.
3. **The page is at 84.7% of the ceiling with 2.44 MB spare.** #191's proposed order-hub figure
   (~388 KB) would put it near 87% and trip the soft warning. Not a defect; a budget fact that
   belongs next to both issues.

---

# Second fix round — right-sizing `MAX_SHOT_HEIGHT` (owner ruling, 2026-08-22)

The owner reversed his own "prefer making the code true, there is headroom" instruction from
§12.1. **The correctness fix stays** (`fullPage: true` alongside the clip); the *number* was the
part chosen blind, and honouring it spent about a third of the headroom §2 had just won on one
screenshot of an audit log. This round prices the constant and changes it.

**`MAX_SHOT_HEIGHT = 6000` → `4000`. `manual.html` 14,213,844 → 12,995,012 B (84.7% → 77.5%),
headroom 2.44 MB → 3.61 MB.**

## 13.1 The measurement

Every number below is a real Playwright capture at that cap, taken with `MANUAL_ONLY` +
`MANUAL_OUT_DIR` into a scratch tree so `docs/manual/` was never touched while measuring. The cap
was made env-driven for the probe runs only and the file restored with `git checkout` afterwards.

### There is a shelf in the data, and it is not where 6000 sits

The cap is fleet-wide, so it cannot say "lists get one number, records get another". What it *can*
do is clear every screen whose height is **structure** and cut the ones whose height is
**repetition**. Measured on the demonstration dataset, that line is sharp:

| Screens | Height |
|---|---|
| 48 of 50 | ≤ **3508 px** — tallest is the template editor (`admin-templates-edit`, `interaction-template-editor`) |
| `/parts/[id]` | **5145 px**, of which the bottom **1712 px** is its own History panel |
| `/admin/audit` | **7627 px** — 200 rows of 37 px |

So exactly **two** screens exceed the shelf, and both exceed it for the same reason: they end in a
list of audit rows. Any cap in `[3508, 5145]` clips those two and nothing else. Below 3508 the
template editor starts losing structure; above 5145 only the audit log is clipped at all.

### What each candidate costs

Disk bytes for the only two figures a cap in that band touches:

| Cap | `admin-audit.png` | `parts-detail.png` | Pair total | vs 6000 | ≈ page (×4/3) |
|---:|---:|---:|---:|---:|---:|
| 3600 | 606,149 | 306,913 | 913,062 | −1,083,596 | −1.38 MB |
| 3800 | 634,561 | 339,648 | 974,209 | −1,022,449 | −1.30 MB |
| **4000** | **667,784** | **446,044** | **1,113,828** | **−882,830** | **−1.12 MB** |
| 4200 | 696,053 | 557,305 | 1,253,358 | −743,300 | −0.94 MB |
| 5000 | 826,277 | 1,003,150 | 1,829,427 | −167,231 | −0.21 MB |
| 6000 | 979,333 | 1,017,325 *(5145, unclipped)* | 1,996,658 | — | — |

The audit shot is almost perfectly linear at **163 B/px** of clip height. The part record is not,
and the non-linearity is the whole argument — see §13.3.

## 13.2 Why 4000 and not one of its neighbours

**Against 5000–5150 ("match the tallest un-clipped figure").** This is the anchor the brief
offered, and priced it recovers only **~0.21 MB of page** — it barely moves. It is also the wrong
anchor on inspection: `parts-detail.png` is not a clean ceiling, because **40% of its height and
over half its bytes are its own History panel**, which is the same repeating audit content the cap
exists to bound. Anchoring the cap to it means letting one un-priced figure justify another.

**Against 3600–3800 (the cheapest options in the band).** 3600 leaves **92 px** of margin over the
tallest structural screen — the template editor's height is data-dependent, and 92 px is one row.
3800 leaves 292 px. Both are cheaper, and 3600 would save a further 0.26 MB, but the margin is not
worth 0.26 MB of a page that now has 3.6 MB spare.

**4000 leaves 492 px (14%) of margin over the tallest structural screen**, which is the number that
made the choice.

## 13.3 What 4000 actually keeps — and the second #170

The part record's History panel is 19 rows. Measured in the DOM:

- rows 1–12 (y 3362→3822) are compact **37 px** rows — one per entity: custom field, inspection,
  specification, pricing, price break, process steps
- rows 13–17 (y 3822→4999) are **357, 309, 261, 181 and 69 px** of raw `steps: [{"id":"c…` JSON

The byte curve says the same thing independently: **3600→3800 costs 164 B/px; 3800→4000 costs
532 B/px.** That is the `invoicing-detail.png` pathology (#170) on a second screen — antialiased
JSON text compresses badly per pixel, and it is displayed at 800 CSS px where it is unreadable
anyway.

**4000 cuts the part record exactly at the top of that JSON block.** The figure keeps every section
`10-parts-and-processes.md` names in prose — *"Identity, Specifications, Inspections, Pricing,
Active quotes, Custom fields, Attachments, Process steps, and the History panel"* — plus 12 of the
panel's 19 rows, so the chapter's sentence stays true of its own picture.

For `/admin/audit`, 4000 shows **~102 of 200 rows** where 6000 showed ~156. **Neither reaches the
end of the page**, which is the point: the extra 2000 px was buying more of the same, not a
conclusion.

Rendered in the manual (declared 1200 wide, `.content` renders at 800): both clipped figures are
**800×2222**, against **800×1949** for the tallest un-clipped figure. At 6000 the audit shot
rendered **800×3333** — 71% taller than anything else in the book, to show that an audit list has
many rows.

## 13.4 The re-capture — and what actually moved

`npm run manual:capture` against the demonstration dataset (rebuilt from a dropped database by
`docs/manual/dataset.md`'s exact sequence, as §12.7): **exit 0, 50 PASS, 0 WARN/FAIL/ERROR/SKIPPED,
sweep clean**, no console errors, no page errors, no failed requests, the same four standing sparse
screens.

**17 of the 50 PNGs moved; exactly 2 changed HEIGHT.** The brief asked for "only the clipped screens
should change" — confirmed the strict way, by dimension rather than by digest:

| | Before | After |
|---|---|---|
| `admin-audit.png` | 1440×**6000**, 996,750 B | 1440×**4000**, 667,784 B |
| `parts-detail.png` | 1440×**5129**, 1,024,243 B | 1440×**4000**, 446,044 B |

The other 15 kept their dimensions **to the pixel** and drifted only in content — new cuids, new
audit timestamps — because the dataset was rebuilt for the capture. (`invoicing-detail.png` moved
2967→2974 px wide for the same reason, back to what the pre-fix-round capture had; a cap cannot
change a width.) The probe runs prove the cap is inert for anything shorter than it: `home`,
`orders-detail`, `customers-detail`, `invoicing-detail` and `admin-templates-edit` are byte-identical
at caps 3600, 4200, 5000 and 9000, and diverge only at 3000 — where three of them are genuinely
clipped, which is the reason the band's floor is 3508 and not lower.

## 13.5 The final numbers

```
docs/manual/manual.html   12,995,012 bytes
publish ceiling           16,777,216 bytes
                          77.5% — 3,782,204 bytes (3.61 MB) of headroom
docs/manual/img/           9,962,505 bytes
```

**−1,218,832 B against the 14,213,844 this round started from.** The build's 85% soft warning is at
14,260,633 B: the page was 46,789 B under it and is now **1,265,621 B clear**. #191's proposed
order-hub figure (~388 KB inlined) lands near **80%**, not the ~87% §12.9 warned about.

For the record, the largest line items now: `invoicing-detail.png` at 1,627,796 B inlined (12.5% of
the page, still #170's), then `admin-audit.png` at 890,380 B (6.9%) and `parts-detail.png` at
594,728 B (4.6%).

## 13.6 The three places that state the cap, and the doc that named it

The brief's original finding was that code, report and doc must agree. They do:

- **`MAX_SHOT_HEIGHT`'s docstring** now carries the measurement — the shelf, the margin, the
  532-vs-164 B/px cut, and what each figure retains — so the number is defensible from the code.
- **`shoot()`'s inline comment** no longer quotes a literal `6000` in its account of the old bug; it
  refers to the constant, so the anecdote cannot go stale again.
- **`sweep.md`'s two mentions are generated from the constant** and now read *"clipped to the top
  4000px"* in the header and *"…of a 7627px page"* / *"…of a 5145px page"* per screen.
- **`CLAUDE.md`** stated the literal `6000` in its account of the bug. Rewritten to state the rule
  without a number (per this file's own "no counts that ordinary commits move") and to point at the
  docstring for the pricing.
- **`docs/HANDOFF.md`** carries the ruling, the shelf, the new byte count and the new headroom.

## 13.7 A guard, so the number stays a decision

`erp/tests/manual-artifacts.test.ts` gains a sixth case: **every committed PNG's IHDR height is
≤ `MAX_SHOT_HEIGHT`**, with the cap lifted by regex from `manual-capture.mjs` — the exact shape of
the width case that pins `DEVICE_SCALE`. Nothing checked this constant at all, which is how it went
phases unhonoured (§12.1) and then, once honoured, unpriced.

**RED-verified before the re-capture**: against the committed 6000-px figures it failed naming
`admin-audit.png (1440×6000)` and `parts-detail.png (1440×5129)` — precisely the two screens the
analysis predicted, arrived at independently.

## 13.8 `SC2034` — fixed, as instructed

The `docker` job's boot loop in `.github/workflows/ci.yml` — line 127, which `actionlint` reports
at its step (`122:9`) — went `for i in $(seq 1 60)` → `for _ in`. The loop variable was never read.

Verified both directions rather than asserted: with `for i` restored, `actionlint -shellcheck`
exits 1 with `SC2034:warning:5:1: i appears unused`; with `for _` it exits **0**. Plain `actionlint`
was and remains clean.

## 13.9 Gates

| Gate | Result |
|---|---|
| `npm run manual:capture` | **exit 0** — 50 PASS, 0 WARN/FAIL/ERROR/SKIPPED, sweep clean |
| `npm run manual:build` ×2 | **exit 0**, byte-identical (sha256 `562b936a…`), 12,995,012 B / 16,777,216 B |
| `git diff` after a rebuild of the committed page | **empty** |
| `npx vitest run tests/manual-artifacts.test.ts tests/manual-figure-size.test.ts` | **13 passed** (6 + 7); the new height case RED-verified |
| `npx eslint src tests e2e scripts prisma` | **clean** |
| `npx tsc --noEmit` | **clean** |
| `node --check erp/e2e/manual-capture.mjs` | **clean** |
| `actionlint` / `actionlint -shellcheck` on `ci.yml` | **both clean** — §13.8 |
| `npm run db:reset -- --yes` | run — the dev database is left pristine |
| full `npx vitest run`, `npm run test:e2e` | **not run**, by instruction |

## 13.10 Found, not fixed

1. **`/parts/[id]`'s History panel prints raw process-step JSON unwrapped**, at 532 B/px — the same
   defect as #170, on a second screen, and now the reason the part figure is clipped rather than
   whole. #170 is scoped to the invoice page; whoever fixes it should look at `HistoryPanel`'s diff
   rendering generally rather than at one route.
2. **The cap is fleet-wide and the two screens it clips are clipped for a content reason.** If the
   JSON above is ever wrapped, `parts-detail` drops well under 4000 on its own and the cap stops
   touching it — no code change needed, which is the right shape.
