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

The replacement is resolution-independent, exactly as the issue words it:

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
