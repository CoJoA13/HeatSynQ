// The manual's figure-sizing rule — a pure, dependency-free leaf (#169).
//
// `build-manual.mjs` declares a `width`/`height` on every `<img>` so the page does not reflow as
// megabytes of inline `data:` URIs decode. What those two numbers should BE is the question this
// file answers, and it used to be answered by a magic constant: `round(intrinsic * 10/24)`, which
// is `1200/2880` — the DSF-2-at-1440 capture assumption, hardcoded. Two consequences:
//
//   1. Changing the capture scale (which #169 does: `manual:capture` now writes 1x) would have
//      rendered every figure at HALF SIZE, silently.
//   2. It was already wrong for anything narrower than a full-width shot. A 600 CSS px element
//      clip captured at 2x is 1200 physical px, and the old factor declared it at 500 — where
//      1:1 is 600.
//
// The rule here reads each image's own intrinsic width instead: the declared width when the image
// is at least that wide, else the image's own intrinsic width, with the height scaled by the same
// ratio.
//
// HOW FAR THAT RESOLUTION-INDEPENDENCE ACTUALLY GOES, stated honestly: it holds for images AT OR
// ABOVE `DECLARED_WIDTH_PX`, which is every figure in `docs/manual/img/` today (the narrowest is
// 1440). BELOW it the declared width is the intrinsic PHYSICAL width, so the same 600 CSS px
// element clip declares 600 at scale 1 and 1200 at scale 2. That is inherent in the rule #169
// mandated rather than a defect in this implementation — a PNG's IHDR carries no device scale
// factor, so a build that is handed only bytes cannot recover the CSS size. A future capture-scale
// change is therefore free for full-width shots and would need a declared scale for narrow clips,
// of which there are none.
//
// It lives in its own file because `build-manual.mjs` runs `build()` at module scope and so
// cannot be imported by a test — the same reason `e2e/lib/failure-classify.mjs` exists. Keep it
// pure: no fs, no process, no dependencies. `manual:build` is deterministic by design (same
// inputs -> same bytes), and integer arithmetic is part of how that holds.

/**
 * The width the manual DECLARES on a full-width figure. Deliberately not called the column width:
 * the rendered column is 800 CSS px (`.content` is `max-width:50rem`, and `figure img` is
 * `max-width:100%`), so this number never reaches the layout. It is an upper bound whose only job
 * is to fix the aspect ratio and reserve the space before the bytes decode.
 *
 * Which is also the density argument, in one line: a 1440px capture shown at 800 is already 1.8x
 * oversampled, so the 2x capture #169 retired was 3.6x oversampled and no reader ever saw it.
 */
export const DECLARED_WIDTH_PX = 1200;

/**
 * @param {{ width: number, height: number }} size intrinsic pixel size, straight out of the IHDR
 * @returns {{ width: number, height: number }} the size to declare on the `<img>`
 */
export function figureDisplaySize({ width, height }) {
  if (width < DECLARED_WIDTH_PX) return { width, height };
  return {
    width: DECLARED_WIDTH_PX,
    // Clamp to 1: a 3000x1 strip would otherwise round to a declared height of 0, which collapses
    // the figure to nothing before its bytes decode.
    height: Math.max(1, Math.round((height * DECLARED_WIDTH_PX) / width)),
  };
}
