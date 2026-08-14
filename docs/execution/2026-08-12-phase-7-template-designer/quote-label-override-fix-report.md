# Quote label-override print — the pre-existing Task-14 vitest failure, diagnosed and fixed

**Date:** 2026-08-12 · **Branch:** `phase-7-template-designer`
**Failing test:** `erp/tests/quote-templates.test.ts` → *"a label override prints through the real path and stamps the assigned version"* (the `printQuote` describe).
**Symptom:** `expect(drawnText(pdf)).toContain("QUOTE-STYLE-MARKER")` → `expected '' to contain 'QUOTE-STYLE-MARKER'` — the WHOLE decoded page was empty, not just the marker.

---

## Diagnostic verdict: (B) a DECODER bug — the render is correct; `drawnText` mis-decoded these particular bytes.

The render was never wrong. The defect is entirely in the test-side PDF decoder `parseObjects` in `erp/tests/helpers/pdf.ts`.

### Evidence that decided it

1. **The pure builder + real renderer works.** Rendering `buildQuoteDefinition(sampleData(), validateConfig("QUOTE", cfgWithTitle="QUOTE-STYLE-MARKER"))` through the real `renderPdf` and decoding with `drawnText` returned the marker (768 chars). The definition carried the override (`JSON.stringify(def).includes("QUOTE-STYLE-MARKER") === true`), and the rendered bytes decoded fine. → not a `quote.ts` render bug.

2. **A faithful DB reproduction of the exact `printQuote` flow also works.** publish-custom-template → assign → `printQuote` for a fresh customer decoded to 617 chars including the marker; the resolved config's title field was exactly `{key:"title",label:"QUOTE-STYLE-MARKER"}`. → not the print path, not the config round-trip, not the two-money/two-pass logic.

3. **Captured the ACTUAL failing bytes** (temporary dump from the real test, since the failure is data-dependent on the module-level `seq` counter). The failing PDF is structurally intact: page object 7, `/Contents 5 0 R`, `/Pages` Kids `[7 0 R]`, `/Count 1`. `pagesInOrder` finds the page. The failure is inside page 7's content stream.

4. **Root-caused on object 5** (`docs`-external scratch analysis of the dumped `fail.pdf`):
   - obj 5 declares `<< /Length 2145 /Filter /FlateDecode >>`.
   - Inflating the **declared-length** byte range → **OK, 15850 bytes, 101 `Tf` + 101 `TJ` operators.**
   - Inflating the decoder's **endstream-scan** byte range → **"unexpected end of file"** (length 2144, i.e. one byte short).
   - The compressed data contains **no** literal `endstream` (so it is not a false-match-in-binary case).

### The root cause (one sentence)

`parseObjects` located a stream's end by scanning for the literal `endstream` keyword and then **greedily** stripping every trailing CR/LF byte — `while (e > dataStart && (pdf[e-1]===0x0a || pdf[e-1]===0x0d)) e--` — which, when the FlateDecode stream's final compressed byte is itself a `0x0a`/`0x0d` (arbitrary; a deflate stream ends in the Adler-32 checksum's low byte), ate that real data byte along with the spec's single separator EOL, truncating the stream by one byte so `zlib.inflateSync` threw and the decoder fell back to `Buffer.from(bytes)` (raw compressed garbage) → every text run decoded to nothing → `drawnText === ''`.

This is a **latent ~1-in-128 flake across the entire decode-based suite**, not specific to quotes or to the title label. The title-override test tripped it only because that particular customer/quote-number/title combination compressed to a stream whose last byte was `0x0a`. Because the module `seq` counter makes the fixture data deterministic per file-run, the failure was stable and reproducible in isolation.

---

## The fix

`erp/tests/helpers/pdf.ts`, `parseObjects` — bound a stream by its **authoritative direct `/Length N`** (what every real PDF reader uses), falling back to the `endstream` scan only when the length is absent or an indirect reference (`/Length 5 0 R`, excluded by a negative lookahead). The scan fallback now strips **exactly one** spec-mandated EOL (CRLF, LF or CR), never greedily.

- pdfkit and pdf-lib (the only two writers in this app — direct render and the `renderSheetGroups` merge) both emit a **direct** `/Length`, so every real render now takes the byte-exact path.
- The "missing terminator" loud-error guard (Task 6 review carry) is preserved; the sequential resume offset (`indexOf("endobj", endstreamIdx)`) is unchanged.
- Single point of truth: `drawnPages`, `textRunsWithY`, `paintedImageCounts`, and `pageCount` all consume `parseObjects`, so all decode helpers are fixed at once.

No production code changed — the defect and the fix are entirely in the test harness. `erp/src/server/pdf/quote.ts` was confirmed correct and untouched.

### Regression test (RED→GREEN captured)

`erp/tests/render-primitives.test.ts` (the decoder's home suite) — new describe *"parseObjects — a stream is bounded by its declared /Length, not an endstream scan"*:
- **(a)** deterministic uncompressed streams whose own bytes end in LF and in CR — pins the byte-range over-trim exactly;
- **(b)** a faithful FlateDecode stream whose compressed bytes end in LF (deterministic `sha256(i)` payload search) — the exact production symptom (inflate would have thrown).

Against the **old** decoder all three go RED; with the fix all three (and the full file, 31/31) go GREEN.

---

## Why the fix is safe

The eight document builders are all config-consumers sharing this one decoder and render path, so the concern was breaking the ~30 other decode-based assertions. The change is strictly more correct (uses the declared length) and only alters behavior for direct-`/Length` streams, which every render in the suite has:

- **Full vitest suite: 146 files, 2706 passed** (was 2702 passing + 1 red; now the fixed quote test + 3 new cases). Covers every decode-based suite — traveler, traveler-templates, ticket, bol, cert, invoice, statement, quote-pdf (the golden), quote-templates, render-primitives.
- `quote-pdf.test.ts` (the golden) stays green; `quote.ts` was never touched.
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm run build` — clean (standalone build; no `src/**` change).
- `npm run test:e2e` — see gate table (the fix touches the shared decoder helper, so the E2E gate was run even though no `src/**` or `e2e/**` file changed and E2E cannot exercise this Node decoder).

## Watched gate numbers

| Gate | Result |
|------|--------|
| `npm test` (vitest) | **2706 passed / 2706** (146 files) |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx eslint src tests` | clean (exit 0) |
| `npm run build` | clean (exit 0) |
| `npm run test:e2e` | **20 / 20 flows passed** (exit 0) |
