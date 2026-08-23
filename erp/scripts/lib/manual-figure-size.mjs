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
// The rule here is resolution-independent instead: the column width when the image is at least
// that wide, else the image's own intrinsic width, with the height scaled by the same ratio.
// A future capture-size change is then free.
//
// It lives in its own file because `build-manual.mjs` runs `build()` at module scope and so
// cannot be imported by a test — the same reason `e2e/lib/failure-classify.mjs` exists. Keep it
// pure: no fs, no process, no dependencies. `manual:build` is deterministic by design (same
// inputs -> same bytes), and integer arithmetic is part of how that holds.

/**
 * The width the manual lays a full-width figure out at. The rendered column is narrower still
 * (`.content` is `max-width:50rem`, and `figure img` is `max-width:100%`), so this is the DECLARED
 * size — an upper bound that fixes the aspect ratio and reserves the space.
 */
export const MANUAL_COLUMN_PX = 1200;

/**
 * @param {{ width: number, height: number }} size intrinsic pixel size, straight out of the IHDR
 * @returns {{ width: number, height: number }} the size to declare on the `<img>`
 */
export function figureDisplaySize({ width, height }) {
  if (width < MANUAL_COLUMN_PX) return { width, height };
  return {
    width: MANUAL_COLUMN_PX,
    // Clamp to 1: a 3000x1 strip would otherwise round to a declared height of 0, which collapses
    // the figure to nothing before its bytes decode.
    height: Math.max(1, Math.round((height * MANUAL_COLUMN_PX) / width)),
  };
}
