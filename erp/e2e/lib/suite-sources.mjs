// The set of suite sources the static sweeps read (#192). Before this, every enforcement point read
// `e2e/flows/*.mjs` and NOTHING else — so a bad board-row locator, an `assert.rejects`-wrapped
// `waitFor`, a raw `page.request` mutation or a plain-`Error` flow assertion written INTO a shared
// helper (`boardRow`/`assertNeverVisible` themselves live in `e2e/lib/`) was invisible to all of
// them, while being WORSE than the same line in one flow because every flow calls it. The sweeps
// read this one list at both points — `run.mjs` before flow 1, `tests/e2e-harness.test.ts` centrally
// — so a file can never be swept by one and skipped by the other.
//
// The two detector modules are the only exclusions: they hold the sweep patterns as regex/string
// literals, so sweeping them would self-match. Everything else under flows/ and lib/ — including
// this lister — is swept.
import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const EXCLUDED = new Set(["failure-classify.mjs", "flow-lint.mjs"]);
const SUBDIRS = ["flows", "lib"];

/** The swept `.mjs` under one subdir, as `<subdir>/<file>` relative paths, sorted and de-excluded. */
function relPathsFor(names, subdir) {
  return names
    .filter((f) => f.endsWith(".mjs") && !EXCLUDED.has(f))
    .sort()
    .map((f) => `${subdir}/${f}`);
}

/**
 * Every swept suite source as `{ relPath, source }`, where `relPath` is `flows/<file>.mjs` or
 * `lib/<file>.mjs` relative to `e2eDir` — so a refusal can print `e2e/lib/ui.mjs:12`. Async form for
 * `run.mjs`, whose startup path is already async.
 */
export async function suiteSources(e2eDir) {
  const out = [];
  for (const subdir of SUBDIRS) {
    for (const rel of relPathsFor(await readdir(path.join(e2eDir, subdir)), subdir)) {
      out.push({ relPath: rel, source: await readFile(path.join(e2eDir, rel), "utf8") });
    }
  }
  return out;
}

/** The same set, read synchronously — for `tests/e2e-harness.test.ts`, whose corpus sweeps are sync
 *  and must read exactly the population `run.mjs` refuses on, from this one place rather than a
 *  second copy of the exclusion rule. */
export function suiteSourcesSync(e2eDir) {
  const out = [];
  for (const subdir of SUBDIRS) {
    for (const rel of relPathsFor(readdirSync(path.join(e2eDir, subdir)), subdir)) {
      out.push({ relPath: rel, source: readFileSync(path.join(e2eDir, rel), "utf8") });
    }
  }
  return out;
}
