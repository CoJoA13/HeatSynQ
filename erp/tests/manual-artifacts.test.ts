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
 * The one figure allowed to be wider than the capture viewport, with the reason and the issue.
 * This is an EXEMPTION LIST, not a raised bound: a second over-wide figure must be a decision.
 * When #170 lands, `invoicing-detail.png` comes back at 1440 and the "no stale exemption" case
 * below reds until this entry is deleted.
 */
const OVER_WIDE: Record<string, string> = {
  "invoicing-detail.png":
    "#170 — the invoice History panel prints raw snapshot JSON unwrapped, so the page overflows " +
    "horizontally and its full-page shot is wider than the viewport",
};

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

  it("is captured by a harness whose scale default is still 1", () => {
    // Belt to the artifact's braces: this reds the moment someone changes the DEFAULT, before any
    // re-capture has happened, and names the file to look at.
    const scale = sourceConstant(
      "e2e/manual-capture.mjs",
      /const DEVICE_SCALE = Number\(process\.env\.MANUAL_SCALE \?\? (\d+)\);/,
    );
    expect(scale).toBe("1");
  });
});
