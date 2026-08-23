import { describe, it, expect } from "vitest";
import { DECLARED_WIDTH_PX, figureDisplaySize } from "../scripts/lib/manual-figure-size.mjs";

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
 * The replacement rule reads the image's own intrinsic width: **the declared width when the image
 * is at least that wide, else its intrinsic width**, height scaled by the same ratio. It lives in
 * its own leaf so it can be tested — `build-manual.mjs` runs `build()` at module scope and cannot
 * be imported (the `e2e/lib/failure-classify.mjs` precedent from Task 2).
 *
 * `DECLARED_WIDTH_PX` is NOT the rendered column: the page lays figures out in an 800 CSS px
 * column (`.content` is `max-width:50rem`) and 1200 is only the declared-attribute cap that
 * reserves the space. The constant was called `MANUAL_COLUMN_PX` for one round and renamed once
 * that was measured.
 */

describe("figureDisplaySize", () => {
  it("caps a full-width capture at the declared width, whatever the capture scale was", () => {
    // 1440px viewport at deviceScaleFactor 2 — every figure in the manual before this change.
    expect(figureDisplaySize({ width: 2880, height: 1800 })).toEqual({ width: 1200, height: 750 });
    // The same screen at deviceScaleFactor 1, which is what capture writes now. Identical output:
    // that is the whole point — the page must not change when the capture scale does.
    expect(figureDisplaySize({ width: 1440, height: 900 })).toEqual({ width: 1200, height: 750 });
  });

  it("leaves an image NARROWER than the declared width at its intrinsic size", () => {
    // A 600 CSS px element clip at 1×. The old rule declared this at 250×150.
    expect(figureDisplaySize({ width: 600, height: 360 })).toEqual({ width: 600, height: 360 });
    expect(figureDisplaySize({ width: 1, height: 1 })).toEqual({ width: 1, height: 1 });
  });

  it("is resolution-independent only AT OR ABOVE the declared width — the honest half", () => {
    // Above it: the same screen at 1× and 2× declares the same size. This is the property the
    // rule was written for, and it covers every figure in docs/manual/img/ (narrowest: 1440).
    expect(figureDisplaySize({ width: 1440, height: 900 }))
      .toEqual(figureDisplaySize({ width: 2880, height: 1800 }));
    // Below it: it is NOT scale-independent, and the leaf header says so rather than claiming
    // otherwise. A 600 CSS px element clip declares 600 at 1× and 1200 at 2× — a PNG's IHDR
    // carries no device scale factor, so a build handed only bytes cannot recover the CSS size.
    expect(figureDisplaySize({ width: 600, height: 360 })).toEqual({ width: 600, height: 360 });
    expect(figureDisplaySize({ width: 1200, height: 720 })).toEqual({ width: 1200, height: 720 });
  });

  it("treats an image exactly the declared width as neither scaled up nor down", () => {
    expect(figureDisplaySize({ width: DECLARED_WIDTH_PX, height: 700 })).toEqual({
      width: DECLARED_WIDTH_PX,
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
