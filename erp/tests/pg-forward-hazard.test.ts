import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SUPPRESSED_PG_DEPRECATION } from "./helpers/setup";

// The pg@9 tripwire (issue #32). DB-free, the partial-unique-sweep style: static checks over
// the installed pg package, so a deliberate driver upgrade cannot land without confronting the
// suppression in tests/helpers/setup.ts.
//
// Background: @prisma/adapter-pg's query interpreter fires an `include`'s sibling relation
// loads on ONE connection concurrently (client-engine-runtime query-interpreter.ts — the
// `case 'join'` runs `Promise.all(node.args.children.map(...))`). pg 8 deprecates-and-QUEUES
// the overlapping `client.query()` calls, so results stay correct and the only cost is a
// DeprecationWarning, which setup.ts's process.emitWarning filter drops. pg@9's changelog
// removes that deprecate-and-queue path — taking with it the warning the filter matches AND
// possibly the queuing correctness itself (overlapping calls may throw instead of queue,
// turning a cosmetic suppression into a masked correctness bug). pg currently arrives only
// transitively via @prisma/adapter-pg's `^8.16.3` (which can never resolve to 9.x), so this
// fires exactly when someone deliberately upgrades the exact-pinned Prisma stack — the moment
// the suppression must be re-evaluated, per setup.ts's REMOVE note.
//
// Deliberately NOT tested here: dynamically provoking the warning (a 5+-sibling `include`
// inside a transaction). That variant is coupled to the measured warning threshold, to adapter
// internals, and to DB state — the static literal check below covers the same drift risk.
//
// Manual re-check procedure (what the Group F recon did, and what to repeat before touching
// the suppression): recover the interpreter source from
// node_modules/@prisma/client/runtime/client.js.map's sourcesContent (source path
// ../../client-engine-runtime/src/interpreter/query-interpreter.ts) and look for the
// `case 'join'` block's `Promise.all(node.args.children.map(...))` — while that concurrent
// sibling-load shape is present, the suppression is still needed. Not asserted here because it
// would couple the suite to Prisma shipping sourcesContent in its published runtime.

const require = createRequire(import.meta.url);

describe("pg forward hazard (issue #32)", () => {
  it("pg stays on major 8 — a pg@9 upgrade must re-evaluate the setup.ts deprecation suppression", () => {
    // pg's exports map explicitly exposes "./package.json", so this resolves the installed copy.
    const { version } = require("pg/package.json") as { version: string };
    const major = Number.parseInt(version, 10);
    expect(
      major,
      `pg resolved to ${version}. pg@9 removes the deprecate-and-queue path for overlapping
client.query() calls on one connection — the very behavior @prisma/adapter-pg's concurrent
sibling relation loads rely on, and the premise of the DeprecationWarning suppression in
tests/helpers/setup.ts (its process.emitWarning filter). Under pg@9 that suppression is at
best dead and at worst hides a correctness failure (overlap may throw instead of queue).
Before upgrading: re-run the interpreter re-check documented at the top of this file, then
remove or rework the setup.ts filter per its REMOVE note. Tracked as issue #32.`,
    ).toBeLessThan(9);
  });

  it("the suppressed deprecation literal still exists in pg — the setup.ts filter is not stale", () => {
    // If a future pg 8.x drops or rewords the deprecation message, the setup.ts filter no longer
    // matches anything: dead suppression at best, or — if the pattern became an error instead —
    // a masked failure. Assert the exact literal the filter matches is still what pg emits.
    const clientJs = readFileSync(
      join(dirname(require.resolve("pg/package.json")), "lib/client.js"),
      "utf8",
    );
    expect(
      clientJs.includes(SUPPRESSED_PG_DEPRECATION),
      `pg's lib/client.js no longer contains the deprecation message that
tests/helpers/setup.ts suppresses ("${SUPPRESSED_PG_DEPRECATION}"). The filter is stale —
either pg dropped/reworded the warning (delete or update the filter) or the deprecation
became an error (see issue #32).`,
    ).toBe(true);
  });
});
