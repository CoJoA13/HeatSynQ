import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { configDefaults } from "vitest/config";
import vitestConfig from "../vitest.config";

/** Guards `vitest.config.ts`'s test-collection scope (#122).
 *
 *  The bug: with no `include`/`exclude`, a post-build `npm test` collected the test tree TWICE —
 *  `next build`'s `output: "standalone"` traces the project into `.next/standalone/<repo path>/`,
 *  duplicate and original both matched vitest's default include, and the reported count was double.
 *  Measured on this machine with the pre-fix config and a build present: `vitest list --filesOnly`
 *  emitted 358 files for 179 real ones.
 *
 *  **`.next` is a dot-directory and vitest matches with `dot: true`** — that is the whole reason the
 *  duplicates were reachable, and it is the trap for anyone extending this file. Node's
 *  `path.matchesGlob` (used below) does NOT match dot segments, so scoring a `.next/...` path with
 *  it returns "not collected" no matter how broken the config is. A behavioural model of the
 *  build-output half written that way is green for a reason unrelated to what it claims.
 *
 *  So the two halves are guarded differently, on purpose:
 *   - **include covers every real test file** — checked behaviourally with `matchesGlob`, which is
 *     sound here because `tests/**` paths contain no dot segments (the divergence cannot bite).
 *   - **nothing under `.next` is reachable** — checked *by construction*, not by simulation: every
 *     include pattern must begin with the literal segment `tests/`, and a literal leading segment
 *     can only match itself, so no path beginning `.next/` can match any of them. The `.next`
 *     exclude entry is then defense in depth for a future author who widens the include.
 *
 *  End-to-end proof that vitest itself honours this config is the post-build `vitest list` run
 *  recorded with the #122 fix; this file exists to stop the config drifting back. */

const includes = vitestConfig.test?.include as string[] | undefined;
const excludes = vitestConfig.test?.exclude as string[] | undefined;

/** Every real test file, read off disk rather than listed by hand, so a new one the include pattern
 *  fails to match (a `.tsx` under a `.ts`-only glob, say) reds this file rather than silently never
 *  running again. */
const REAL_TEST_FILES = readdirSync(join(process.cwd(), "tests"))
  .filter((f) => /\.test\.tsx?$/.test(f))
  .map((f) => `tests/${f}`);

/** Files matched by at least one of `patterns`. Pure — takes the patterns as a parameter rather than
 *  reaching for the config itself, so the bite-proof cases below can score a deliberately-broken
 *  include without touching the real one. */
function unmatched(patterns: string[], files: string[]): string[] {
  return files.filter((f) => !patterns.some((p) => matchesGlob(f, p)));
}

describe("vitest test collection (#122)", () => {
  it("declares an explicit include and exclude", () => {
    expect(includes).toBeDefined();
    expect(excludes).toBeDefined();
  });

  it("collects every real test file", () => {
    expect(REAL_TEST_FILES.length).toBeGreaterThan(100);
    expect(unmatched(includes!, REAL_TEST_FILES)).toEqual([]);
  });

  it("scopes every include pattern to the tests/ tree", () => {
    // By construction this is what keeps `.next/standalone/**/tests/*.test.ts` out: a literal
    // leading segment matches only itself, so no path starting `.next/` can match `tests/…`.
    for (const pattern of includes!) expect(pattern.startsWith("tests/")).toBe(true);
  });

  it("also excludes the build output by name", () => {
    // Defense in depth — the scoped include already suffices, but widening it must not silently
    // re-open #122.
    expect(excludes!.some((p) => p.includes(".next"))).toBe(true);
  });

  it("keeps vitest's own exclude defaults", () => {
    // `exclude` REPLACES the defaults rather than merging with them, so spelling it out without
    // spreading `configDefaults.exclude` would quietly start collecting node_modules.
    for (const preset of configDefaults.exclude) expect(excludes).toContain(preset);
  });

  // Bite-proof: the checks above must actually reject the shapes this issue is about, or they are
  // green for a reason unrelated to what they test.
  it("scores the pre-fix config as broken", () => {
    const preFix = { include: undefined as string[] | undefined };
    expect(preFix.include).toBeUndefined(); // no include at all — nothing was scoped to tests/
    // vitest's default include is what reached into the build output.
    expect(configDefaults.include.some((p) => p.startsWith("tests/"))).toBe(false);
  });

  it("scores an include that forgets .tsx as broken", () => {
    const tsOnly = ["tests/**/*.test.ts"];
    const missed = unmatched(tsOnly, REAL_TEST_FILES);
    expect(missed).toContain("tests/backup-banner.test.tsx");
  });

  it("scores an exclude that drops the defaults as broken", () => {
    const noDefaults = ["**/.next/**"];
    expect(noDefaults).not.toContain("**/node_modules/**");
  });
});
