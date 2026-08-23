import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The committed manual, checked as an ARTIFACT (#169 fix round).
 *
 * `npm run manual:capture` and `npm run manual:build` were both unguarded: nothing in CI ran
 * either, and no test looked at what they had produced. The build's own ceiling check only fires
 * when someone runs the build, and the capture scale had no check at all — which is how
 * `DEVICE_SCALE` and `build-manual.mjs`'s display factor stayed silently coupled for a whole phase
 * (Task 5's report recorded that as "the untested half of a coupled pair").
 *
 * These are deliberately cheap: no browser, no database, no build. They read the committed bytes
 * in `docs/manual/` and the two source constants those bytes are supposed to satisfy. The third
 * guard — that a rebuild is a no-op diff — cannot be a unit test (it would rewrite a tracked file
 * mid-suite), so it lives in `.github/workflows/ci.yml` instead.
 */

const ERP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(ERP_ROOT, "..");
const MANUAL_DIR = path.join(REPO_ROOT, "docs", "manual");
const IMG_DIR = path.join(MANUAL_DIR, "img");

/** Pull a constant out of a harness that cannot be imported — both files run at module scope. */
function sourceConstant(file: string, re: RegExp): string {
  const src = readFileSync(path.join(ERP_ROOT, file), "utf8");
  const m = src.match(re);
  if (!m) throw new Error(`${file}: ${re} matched nothing — the constant was renamed or reshaped`);
  return m[1];
}

/** Intrinsic size straight out of a PNG's IHDR — the same 24-byte read `build-manual.mjs` does. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Figures allowed to be wider than the capture viewport, each with its reason and issue. This is an
 * EXEMPTION LIST, not a raised bound: an over-wide figure must be a decision, not a drift.
 *
 * Currently EMPTY, and that is the healthy state. Its one occupant, `invoicing-detail.png`, was the
 * #170 symptom — the invoice History panel printed raw snapshot JSON unwrapped, so the page
 * overflowed horizontally. #170 fixed the render (the diff value now wraps and scrolls in its own
 * box, `src/components/HistoryPanel.tsx`) and added the live capture-time guard pinned below, so the
 * re-captured figure came back at 1440 and the entry was deleted. An entry here is a standing
 * over-wide figure waiting to be fixed, not a resting place.
 */
const OVER_WIDE: Record<string, string> = {};

describe("the committed manual page", () => {
  it("is under the publishing ceiling build-manual.mjs states", () => {
    const limitMb = Number(
      sourceConstant("scripts/build-manual.mjs", /const PUBLISH_LIMIT = (\d+) \* 1024 \* 1024;/),
    );
    expect(limitMb).toBe(16);
    const limit = limitMb * 1024 * 1024;

    const bytes = statSync(path.join(MANUAL_DIR, "manual.html")).size;
    // Reported either way: the margin is the number to spend when adding figures, and a test that
    // only says "pass" tells whoever is adding one nothing.
    console.log(
      `manual.html: ${bytes.toLocaleString()} B of ${limit.toLocaleString()} ` +
        `(${((bytes / limit) * 100).toFixed(1)}%, ${(limit - bytes).toLocaleString()} B left)`,
    );
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(limit);
  });
});

describe("the committed manual figures", () => {
  const files = readdirSync(IMG_DIR).filter((f) => f.endsWith(".png")).sort();

  it("has figures at all — the width sweep below must not pass vacuously", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  /**
   * The capture-scale pin, taken from the ARTIFACT rather than from a browser. `manual:capture`
   * writes at `deviceScaleFactor` 1 on a 1440px viewport (#169), so a full-page shot is 1440
   * physical px wide. Put the scale back to 2 and every figure here becomes 2880 — which is
   * exactly the regression that pushed `manual.html` past the publish ceiling and made an
   * undocumented ImageMagick pass load-bearing.
   */
  it("were all captured at deviceScaleFactor 1 — no figure is wider than the viewport", () => {
    const viewportWidth = Number(
      sourceConstant("e2e/manual-capture.mjs", /const VIEWPORT = \{ width: (\d+),/),
    );
    expect(viewportWidth).toBe(1440);

    const tooWide: string[] = [];
    for (const f of files) {
      if (f in OVER_WIDE) continue;
      const size = pngSize(readFileSync(path.join(IMG_DIR, f)));
      expect(size, `${f} is not a readable PNG`).not.toBeNull();
      if (size!.width > viewportWidth) tooWide.push(`${f} (${size!.width}×${size!.height})`);
    }
    expect(
      tooWide,
      `wider than the ${viewportWidth}px capture viewport — re-capture with MANUAL_SCALE unset ` +
        `(#169), or add a documented entry to OVER_WIDE if the page genuinely overflows`,
    ).toEqual([]);
  });

  it("carries no stale over-wide exemption", () => {
    const viewportWidth = Number(
      sourceConstant("e2e/manual-capture.mjs", /const VIEWPORT = \{ width: (\d+),/),
    );
    for (const [name, reason] of Object.entries(OVER_WIDE)) {
      expect(files, `${name} is exempted but no longer exists — drop the entry`).toContain(name);
      const size = pngSize(readFileSync(path.join(IMG_DIR, name)));
      expect(
        size!.width,
        `${name} no longer exceeds ${viewportWidth}px — the exemption (${reason}) is stale, delete it`,
      ).toBeGreaterThan(viewportWidth);
    }
  });

  /**
   * The height-cap pin, the same shape as the width pin above and for the same reason: nothing
   * else checks that `MAX_SHOT_HEIGHT` is honoured. It was silently NOT honoured for phases — a
   * bare `clip` resolves against the viewport — and when the fix landed, the number itself had
   * never been priced (#169). Re-sizing it is now a decision that shows up here: lower it and this
   * stays green only after a re-capture, raise it and the figures it lets through are the ones
   * whoever raised it chose to pay for.
   */
  it("respects the capture harness's MAX_SHOT_HEIGHT", () => {
    const cap = Number(sourceConstant("e2e/manual-capture.mjs", /const MAX_SHOT_HEIGHT = (\d+);/));
    expect(cap).toBeGreaterThan(0);

    const tooTall: string[] = [];
    for (const f of files) {
      const size = pngSize(readFileSync(path.join(IMG_DIR, f)));
      expect(size, `${f} is not a readable PNG`).not.toBeNull();
      if (size!.height > cap) tooTall.push(`${f} (${size!.width}×${size!.height})`);
    }
    expect(
      tooTall,
      `taller than MAX_SHOT_HEIGHT (${cap}) — re-run npm run manual:capture, or change the ` +
        `constant deliberately and price it (its docstring carries the measurement)`,
    ).toEqual([]);
  });

  it("is captured by a harness whose scale default is still 1", () => {
    // Belt to the artifact's braces: this reds the moment someone changes the DEFAULT, before any
    // re-capture has happened, and names the file to look at.
    const scale = sourceConstant(
      "e2e/manual-capture.mjs",
      /const DEVICE_SCALE = Number\(process\.env\.MANUAL_SCALE \?\? (\d+)\);/,
    );
    expect(scale).toBe("1");
  });

  /**
   * The RUNTIME half of the width guard (#170). The two width tests above are the committed-bytes
   * backstop — they red only once an over-wide PNG has been captured AND committed. This pins the
   * live gate that stops such a PNG being produced in the first place: `shoot()` measures the page's
   * scrollWidth, marks the row `overWide` when it exceeds the viewport, and `statusOf` treats that
   * as a FAIL so the run exits non-zero. #170 (the invoice History panel's unwrapped JSON) reached
   * the published manual reported PASS precisely because no such live gate existed. A refactor that
   * drops any of the three pieces reds here, naming the file, rather than silently re-blinding the
   * capture to horizontal overflow.
   */
  it("gates the capture run on horizontal overflow, not just the committed artifact", () => {
    const src = readFileSync(path.join(ERP_ROOT, "e2e/manual-capture.mjs"), "utf8");
    // shoot() measures the page's own scroll width (not the viewport's clientWidth).
    expect(src, "shoot() must measure document scrollWidth").toContain(
      "width: document.documentElement.scrollWidth",
    );
    // The verdict is strict `>` against the same VIEWPORT.width the artifact pins use, so a fitting
    // page (exactly VIEWPORT.width) never trips it.
    expect(src, "the over-wide verdict must compare against VIEWPORT.width").toContain(
      "const overWide = width > VIEWPORT.width;",
    );
    // statusOf() must fold overWide into the FAIL condition, or the measurement gates nothing.
    const statusOf = src.match(/function statusOf\(row\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(statusOf, "statusOf() lost its body — the match reshaped").not.toBe("");
    expect(statusOf, "statusOf() must FAIL on row.overWide").toContain("row.overWide");
  });
});
