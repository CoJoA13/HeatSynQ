import { describe, it, expect } from "vitest";
import { MANUAL_COLUMN_PX, figureDisplaySize } from "../scripts/lib/manual-figure-size.mjs";

/**
 * The manual's figure-sizing rule (#169, gate-infrastructure Task 5).
 *
 * `build-manual.mjs` used to compute a figure's declared `width`/`height` as
 * `round(intrinsic × 10/24)`. That constant is `1200/2880` — it hardcoded "captured at
 * deviceScaleFactor 2 on a 1440px viewport". Task 5 drops the capture to deviceScaleFactor 1, so
 * the old factor would have rendered every figure at half size, and it was ALREADY distorting
 * anything narrower than a full-width shot (a 600 CSS px element clip captured at 2× is 1200
 * physical px and was declared at 500, where 1:1 is 600).
 *
 * The replacement rule is resolution-independent: **the column width when the image is at least
 * that wide, else its intrinsic width**, height scaled by the same ratio. It lives in its own
 * leaf so it can be tested — `build-manual.mjs` runs `build()` at module scope and cannot be
 * imported (the `e2e/lib/failure-classify.mjs` precedent from Task 2).
 */

describe("figureDisplaySize", () => {
  it("caps a full-width capture at the column width, whatever the capture scale was", () => {
    // 1440px viewport at deviceScaleFactor 2 — every figure in the manual before this change.
    expect(figureDisplaySize({ width: 2880, height: 1800 })).toEqual({ width: 1200, height: 750 });
    // The same screen at deviceScaleFactor 1, which is what capture writes now. Identical output:
    // that is the whole point — the page must not change when the capture scale does.
    expect(figureDisplaySize({ width: 1440, height: 900 })).toEqual({ width: 1200, height: 750 });
  });

  it("leaves an image NARROWER than the column at its intrinsic size", () => {
    // A 600 CSS px element clip at 1×. The old rule declared this at 250×150.
    expect(figureDisplaySize({ width: 600, height: 360 })).toEqual({ width: 600, height: 360 });
    expect(figureDisplaySize({ width: 1, height: 1 })).toEqual({ width: 1, height: 1 });
  });

  it("treats an image exactly the column width as neither scaled up nor down", () => {
    expect(figureDisplaySize({ width: MANUAL_COLUMN_PX, height: 700 })).toEqual({
      width: MANUAL_COLUMN_PX,
      height: 700,
    });
  });

  it("preserves the aspect ratio of an over-wide capture", () => {
    // invoicing-detail.png: the invoice page overflows horizontally (#170), so its full-page shot
    // is wider than the 2880 every other one is. 5934×5736 → 1200 wide, height by the same ratio.
    const out = figureDisplaySize({ width: 5934, height: 5736 });
    expect(out.width).toBe(1200);
    expect(out.height).toBe(Math.round((5736 * 1200) / 5934));
    // Within a pixel of the source ratio — the browser lays out from these two numbers, so a
    // wrong ratio is a visible reflow jump as the data: URI decodes.
    expect(Math.abs(out.width / out.height - 5934 / 5736)).toBeLessThan(0.001);
  });

  it("is a pure integer function — same input, same bytes (manual:build is deterministic)", () => {
    const a = figureDisplaySize({ width: 2880, height: 6388 });
    const b = figureDisplaySize({ width: 2880, height: 6388 });
    expect(a).toEqual(b);
    expect(Number.isInteger(a.width)).toBe(true);
    expect(Number.isInteger(a.height)).toBe(true);
  });

  it("never returns a zero height for a very wide, very short image", () => {
    // 1px of height across a 3000px strip would round to 0, and a declared height of 0 collapses
    // the figure. Clamped to 1 rather than allowed to vanish.
    expect(figureDisplaySize({ width: 3000, height: 1 })).toEqual({ width: 1200, height: 1 });
  });
});
