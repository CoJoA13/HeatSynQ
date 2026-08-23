// The set of suite sources the static sweeps read (#192). Before this, every enforcement point read
// `e2e/flows/*.mjs` and NOTHING else — so a bad board-row locator, an `assert.rejects`-wrapped
// `waitFor`, a raw APIRequestContext mutation or a plain-`Error` flow assertion written INTO a shared
// helper (`boardRow`/`assertNeverVisible` themselves live in `e2e/lib/`) was invisible to all of
// them, while being WORSE than the same line in one flow because every flow calls it. The sweeps
// read this one list at both points — `run.mjs` before flow 1, `tests/e2e-harness.test.ts` centrally
// — so a file can never be swept by one and skipped by the other.
//
// The swept set is the `.mjs` suite sources — the in-process flow surface: every `.mjs` under flows/
// and lib/ EXCEPT the two detector modules, which hold the sweep patterns as regex/string literals
// and would self-match. The `.ts` subprocess CLIs (lib/db-fixtures.ts, lib/manual-ids.ts) are out of
// scope by extension and by design: they run as `npx tsx` processes, not inside a flow, so their
// plain-Error throws are harness/CLI errors classifyFailure never sees — guarding them would be wrong.
import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const EXCLUDED = new Set(["failure-classify.mjs", "flow-lint.mjs"]);
const SUBDIRS = ["flows", "lib"];

// RECURSIVE enumeration (Codex P2): the contract is `flows/** + lib/**`, so a helper nested in a
// subdirectory (`e2e/lib/orders/board.mjs`) must be swept too — a non-recursive read would let the
// sweeps be bypassed just by organising helpers into folders. `readdir(..., { recursive: true })`
// returns each `.mjs` as a subdir-relative path (POSIX-separated here); the exclusion set only names
// the two top-level detector modules, so a differently-located file is (correctly) never excluded.
/** The swept `.mjs` under one subdir, as `<subdir>/<relpath>` relative paths, sorted and de-excluded. */
function relPathsFor(names, subdir) {
  return names
    .filter((f) => f.endsWith(".mjs") && !EXCLUDED.has(f))
    .sort()
    .map((f) => `${subdir}/${f}`);
}

/**
 * Every swept suite source as `{ relPath, source }`, where `relPath` is `flows/<...>.mjs` or
 * `lib/<...>.mjs` relative to `e2eDir` — so a refusal can print `e2e/lib/ui.mjs:12`. Async form for
 * `run.mjs`, whose startup path is already async.
 */
export async function suiteSources(e2eDir) {
  const out = [];
  for (const subdir of SUBDIRS) {
    for (const rel of relPathsFor(await readdir(path.join(e2eDir, subdir), { recursive: true }), subdir)) {
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
    for (const rel of relPathsFor(readdirSync(path.join(e2eDir, subdir), { recursive: true }), subdir)) {
      out.push({ relPath: rel, source: readFileSync(path.join(e2eDir, rel), "utf8") });
    }
  }
  return out;
}
