#!/usr/bin/env node
// Playwright E2E harness (spec §12 / HANDOFF §5a). Drives the bundled Chromium against a
// throwaway `next dev` instance on port 3100, running sixteen owner-reviewable flows in sequence.
// Each flow gets its own browser context (so it gets its own video.webm) and its own numbered
// screenshot sequence under e2e-artifacts/<flow>/.
//
// `npm run test:e2e` == `node e2e/run.mjs` (package.json). `HEADED=1 npm run test:e2e` runs
// headed. Exits non-zero if any flow fails; dev-DB fixtures are always cleaned up — normal
// completion, a flow throwing, or a Ctrl-C mid-run (SIGINT/SIGTERM handlers below run the same
// teardown) — and a self-heal in db-fixtures.ts's create() means even a run that skipped its own
// teardown (killed harder than a SIGTERM, or a bug) doesn't wedge the next one.
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { login } from "./lib/auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ERP_ROOT = path.resolve(__dirname, "..");
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
const ARTIFACTS_DIR = path.join(ERP_ROOT, "e2e-artifacts");
const HEADED = Boolean(process.env.HEADED);

// Order matters for two reasons: later flows build on state earlier ones leave behind (the
// template and its two steps from template-build-and-load are what typed-fields, revision-cut
// and blocked-code-delete all go on to use), and the last two run as the restricted user rather
// than admin.
//
// Task 17 (Phase 3) adds the last four, all as admin (the restricted fixture user holds only
// parts.view/processes.view — none of orders.*/void_order): order-entry-full creates the one
// order the other three all operate on (its id/number travel via `ctx.created`, set at the end of
// that flow), board-search-scan and loads-after-print both need it live, and void-order runs last
// because voiding it leaves nothing for a later flow to build on.
// Task 20 (Phase 4) adds the last five, per design spec §13. Unlike the four Phase 3 order flows
// (which share one order), each Phase 4 flow creates its own order(s) through the real entry page
// against its own fixture customer, so they carry no cross-flow state — only the run order
// matters for the numbering the demo doc narrates. `credit-hold-block-and-override` starts as the
// fixture "clerk" (shipping permissions but NOT action.override_credit_hold — the blocked half)
// and re-logs-in as the fixture admin mid-flow for the override half.
// Task 20 (Phase 5A) adds the 16th and last flow, `invoice-shipped-order`, as admin — it creates
// its own order/customer and leaves nothing later flows depend on, so it runs last for the same
// reason void-order and credit-hold-block-and-override do (nothing after it needs its state).
const FLOWS = [
  { name: "template-build-and-load", as: "admin", module: "./flows/template-build-and-load.mjs" },
  { name: "typed-fields", as: "admin", module: "./flows/typed-fields.mjs" },
  { name: "revision-cut", as: "admin", module: "./flows/revision-cut.mjs" },
  { name: "blocked-code-delete", as: "admin", module: "./flows/blocked-code-delete.mjs" },
  { name: "permission-gating", as: "restricted", module: "./flows/permission-gating.mjs" },
  { name: "processes-list", as: "restricted", module: "./flows/processes-list.mjs" },
  { name: "order-entry-full", as: "admin", module: "./flows/order-entry-full.mjs" },
  { name: "board-search-scan", as: "admin", module: "./flows/board-search-scan.mjs" },
  { name: "loads-after-print", as: "admin", module: "./flows/loads-after-print.mjs" },
  { name: "void-order", as: "admin", module: "./flows/void-order.mjs" },
  { name: "ship-partial-then-complete", as: "admin", module: "./flows/ship-partial-then-complete.mjs" },
  { name: "multi-order-shipment", as: "admin", module: "./flows/multi-order-shipment.mjs" },
  { name: "cert-results-print", as: "admin", module: "./flows/cert-results-print.mjs" },
  { name: "void-shipment", as: "admin", module: "./flows/void-shipment.mjs" },
  { name: "credit-hold-block-and-override", as: "clerk", module: "./flows/credit-hold-block-and-override.mjs" },
  { name: "invoice-shipped-order", as: "admin", module: "./flows/invoice-shipped-order.mjs" },
];

// Mutable, module-level: both main()'s own finally block and the SIGINT/SIGTERM handlers below
// need to reach whatever's currently been acquired, and a signal can land at any point during
// main()'s execution — there is no single function-local scope both paths share.
const state = {
  devServer: null, browser: null, fixtures: null,
  created: { templateIds: [], orderId: null, orderNumber: null },
  cleanupFailed: null,
};
let teardownPromise = null;

function runDbScript(command, payload) {
  const args = ["tsx", path.join("e2e", "lib", "db-fixtures.ts"), command, JSON.stringify(payload ?? {})];
  const out = execFileSync("npx", args, { cwd: ERP_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const line = out.trim().split("\n").filter(Boolean).pop();
  return line ? JSON.parse(line) : null;
}

/** Binds `port` briefly to find out whether something's already listening on it — the standard
 *  idiomatic Node check (attempting to bind, not attempting to connect, is authoritative: a
 *  service that's up but not yet accepting connections would otherwise read as "free"). */
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

async function waitForServer(url, timeoutMs, devServer) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // next dev silently falls back to the next free port (3101, 3102, ...) instead of failing
    // when the requested one is taken — polling BASE_URL would then time out after the full
    // 60s with no clue why. Catch that from its own announced output instead of waiting it out.
    const portMismatch = devServer.getOutput().match(/Port (\d+) is in use, trying (\d+) instead/);
    if (portMismatch) {
      throw new Error(
        `next dev could not bind port ${portMismatch[1]} (already in use) and fell back to ` +
        `port ${portMismatch[2]} instead — refusing to continue against the wrong port. Free ` +
        `port ${PORT} (an orphaned dev server from a previous run? \`fuser -k ${PORT}/tcp\`) ` +
        `and re-run.`,
      );
    }
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // connection refused while next dev is still booting — keep polling
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url} to come up`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function startDevServer() {
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: ERP_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so killDevServer can take down webpack's worker processes with it, not
    // just the `next` wrapper.
    detached: true,
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  child.getOutput = () => out;
  return child;
}

/** Sends SIGTERM to the dev server's whole process group and waits (briefly) for it to actually
 *  exit — not fire-and-forget: the next run's `isPortFree` check runs almost immediately after
 *  (Ctrl-C, then re-run), and a signal having been *sent* is not the same guarantee as the port
 *  having actually been *freed*. Falls back to SIGKILL if it hasn't gone within the timeout. */
function killDevServer(child, timeoutMs = 5000) {
  if (!child || child.killed || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => resolve();
    child.once("exit", onExit);
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      resolve();
    }, timeoutMs).unref();
  });
}

/**
 * The one teardown path — dev server, dev-DB fixtures, browser — shared by main()'s own finally
 * block AND the SIGINT/SIGTERM handlers below, so a signal that lands mid-run and one that lands
 * after a clean finish never race each other into doing it twice.
 *
 * Single-flight via a cached PROMISE, not a boolean flag: an earlier version used `if (tornDown)
 * return;` with `tornDown` set synchronously up front, which made a second caller return
 * immediately without ever awaiting the first caller's in-flight work. In practice that let a
 * SIGINT during a flow race main()'s own error path: the signal handler's teardown() call "won"
 * (set the flag first) and started actually closing things, but main()'s interrupted `await` woke
 * up, propagated an error through runFlow, hit main()'s `finally { await teardown(); }` — which,
 * seeing the flag already set, returned INSTANTLY rather than waiting — and let main()'s own
 * rejection settle and the process look "idle" before the signal handler's kill-server/cleanup-
 * fixtures steps had actually run. Caching the promise itself means every caller awaits the exact
 * same in-flight (or already-settled) work, so nothing can observe teardown as "done" before it
 * is. killDevServer and the DB cleanup — the two steps that matter most for not leaking anything
 * — run before the (slower, less consequential if it lingers a moment) browser.close().
 */
function teardown() {
  if (!teardownPromise) {
    teardownPromise = (async () => {
      if (state.devServer) await killDevServer(state.devServer);
      if (state.fixtures) {
        console.log("\nCleaning up dev-DB fixtures (erp)...");
        try {
          runDbScript("cleanup", { ...state.fixtures, templateIds: state.created.templateIds });
          console.log("  cleanup ok");
        } catch (err) {
          // Recorded, not just logged (Codex, PR #22): this used to swallow the failure, so a
          // broken cleanup — a new foreign key missing from the deletion order, say — let the run
          // print "All 6 flows passed" and exit 0 while leaving fixture rows and sessions behind
          // in the developer's database. The whole contract of this harness is that it cleans up
          // after itself, so failing to is a failed run.
          state.cleanupFailed = String(err);
          console.error(`  cleanup FAILED — dev DB may still hold E2E fixture rows: ${err}`);
        }
      }
      if (state.browser) await state.browser.close().catch(() => {});
    })();
  }
  return teardownPromise;
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.error(`\nReceived ${signal} — cleaning up (dev server + dev-DB fixtures) before exit...`);
      teardown()
        .catch((err) => console.error("Error during signal teardown:", err))
        .finally(() => process.exit(1));
    });
  }
}

async function runFlow(browser, flow, ctx, results) {
  const flowDir = path.join(ARTIFACTS_DIR, flow.name);
  await mkdir(flowDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir: flowDir, size: { width: 1280, height: 900 } },
  });
  // Next dev compiles each route on its first hit; under a loaded machine (this harness itself
  // launches a fresh next dev + Chromium per run) that first compile can occasionally outrun
  // Playwright's 30s default. Generous, not unlimited — a genuinely hung page still times out.
  context.setDefaultNavigationTimeout(60000);
  context.setDefaultTimeout(45000);
  const page = await context.newPage();

  let shotIndex = 0;
  const shot = async (label) => {
    shotIndex += 1;
    const file = path.join(flowDir, `${String(shotIndex).padStart(2, "0")}-${label}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };

  console.log(`\n=== ${flow.name} (as ${flow.as}) ===`);
  let ok = true;
  let error = null;
  try {
    // Both sets of credentials come from the fixtures this run created. The full-permission ones
    // used to be a hardcoded `admin`/`admin` — the seeded pair README §"first run" tells you to
    // change after first login, so the four flows using them broke for any developer who did.
    const creds = flow.as === "restricted"
      ? { username: ctx.fixtures.restrictedUsername, password: ctx.fixtures.restrictedPassword }
      : flow.as === "clerk"
        ? { username: ctx.fixtures.clerkUsername, password: ctx.fixtures.clerkPassword }
        : { username: ctx.fixtures.adminUsername, password: ctx.fixtures.adminPassword };
    await login(page, ctx.baseURL, creds.username, creds.password);
    await shot("logged-in");

    const mod = await import(flow.module);
    await mod.run(page, shot, ctx);
    console.log(`  PASS`);
  } catch (err) {
    ok = false;
    error = err;
    console.error(`  FAIL: ${err?.stack ?? err}`);
    await shot("failure").catch(() => {});
  } finally {
    const video = page.video();
    await context.close().catch((closeErr) => {
      console.error(`  (error closing browser context: ${closeErr})`);
    });
    if (video) {
      try {
        const videoPath = await video.path();
        await rename(videoPath, path.join(flowDir, "video.webm"));
      } catch (renameErr) {
        console.error(`  (could not finalize video: ${renameErr})`);
      }
    }
  }
  results.push({ name: flow.name, ok, error });
}

async function main() {
  const results = [];

  try {
    await rm(ARTIFACTS_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });

    if (!(await isPortFree(PORT))) {
      throw new Error(
        `Port ${PORT} is already in use — an orphaned dev server from a previous run (a Ctrl-C ` +
        `before this harness handled signals?) or another process. Free it (\`fuser -k ` +
        `${PORT}/tcp\` or \`lsof -i:${PORT}\` to find what's holding it) and re-run.`,
      );
    }

    console.log("Creating dev-DB fixtures (erp)...");
    state.fixtures = runDbScript("create");
    console.log(`  customer ${state.fixtures.customerCode}, part ${state.fixtures.partNumber}, ` +
      `step codes ${state.fixtures.stepCodeA.code}/${state.fixtures.stepCodeB.code}, ` +
      `users ${state.fixtures.adminUsername}/${state.fixtures.restrictedUsername}`);

    console.log(`Starting next dev on port ${PORT}...`);
    state.devServer = startDevServer();
    try {
      await waitForServer(`${BASE_URL}/login`, 60000, state.devServer);
    } catch (err) {
      console.error(`--- next dev output ---\n${state.devServer.getOutput()}\n-----------------------`);
      throw err;
    }
    console.log("  dev server is up");

    // handleSIGINT/handleSIGTERM default to true — Playwright would otherwise install its OWN
    // signal handlers that close the browser (and exit) on Ctrl-C, racing installSignalHandlers()
    // above: whichever handler's process.exit() lands first wins, and Playwright's has no idea
    // the dev server needs killing or the dev-DB fixtures need cleaning up first. Disabling both
    // hands exclusive control of the shutdown sequence to teardown() above, in the order it
    // chooses (dev server, then fixtures, then browser).
    state.browser = await chromium.launch({ headless: !HEADED, handleSIGINT: false, handleSIGTERM: false });

    const ctx = {
      baseURL: BASE_URL,
      fixtures: state.fixtures,
      created: state.created,
      lockRevision: (partId, revisionNumber) => runDbScript("lock-revision", { partId, revisionNumber }),
    };

    // Deliberately sequential, not Promise.all: every flow after the first depends on state an
    // earlier one left in the dev DB (the template template-build-and-load creates, the values
    // typed-fields saves, the revision revision-cut cuts).
    for (const flow of FLOWS) {
      await runFlow(state.browser, flow, ctx, results);
    }
  } finally {
    await teardown();
  }

  console.log("\n=== Results ===");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0 || results.length !== FLOWS.length) {
    console.error(`\n${failed.length} of ${FLOWS.length} flow(s) failed.`);
    process.exitCode = 1;
  } else if (state.cleanupFailed) {
    console.error(`\nAll ${FLOWS.length} flows passed, but dev-DB cleanup FAILED — fixture rows ` +
      `are still in the erp database and the next run's self-heal will have to reap them. ` +
      `Treating the run as failed: ${state.cleanupFailed}`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${FLOWS.length} flows passed. Artifacts: ${ARTIFACTS_DIR}`);
  }
}

installSignalHandlers();
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
