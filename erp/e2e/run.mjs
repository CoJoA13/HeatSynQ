#!/usr/bin/env node
// Playwright E2E harness (spec §12 / HANDOFF §5a). Drives the bundled Chromium against a
// throwaway `next dev` instance on port 3100, running the owner-reviewable flows in sequence.
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
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { login } from "./lib/auth.mjs";
import { warmRoutes } from "./lib/warmup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ERP_ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ERP_ROOT, "src", "app");
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
const ARTIFACTS_DIR = path.join(ERP_ROOT, "e2e-artifacts");
// #184 fix (b): the dev server's stdout+stderr, written on EVERY run rather than only when
// startup times out. Both implementers who hit #184 had to reason from a failure screenshot,
// with no way to see whether the server had logged a slow compile, a stack, or an OOM. Streamed
// live rather than dumped at the end so a run killed harder than SIGTERM still leaves it behind.
const DEV_SERVER_LOG = path.join(ARTIFACTS_DIR, "dev-server.log");
// Phase 8C: the backups flow writes REAL pg_dump archives, so the harness owns a throwaway folder
// rather than inheriting the developer's BACKUP_DIR (or, worse, writing into erp/backups and
// leaving archives behind). Created fresh in main(), removed in teardown().
const BACKUP_DIR = path.join(ERP_ROOT, "e2e-backups");
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
// Task 20 (Phase 5A) adds the 16th flow, `invoice-shipped-order`, as admin — it creates its own
// order/customer and leaves nothing later flows depend on, so it ran last (of 16) for the same
// reason void-order and credit-hold-block-and-override do (nothing after it needs its state).
// Task 17 (Phase 5B) adds the 17th flow, `receivables-apply-age-statement`, as
// admin (needs `write_off`, which the admin fixture role holds via ALL_PERMISSIONS) — it seeds
// its own shipped-and-invoiced order against its own fixture customer (the `invoice-shipped-
// order.mjs` precedent) and then drives the new `/receivables` screens (batch, apply, aging,
// statement print+archive) end to end.
// Task 9 (Phase 5C) adds the 18th flow, `close-month-end`, as admin (needs
// `close_ar_period`/`run_qbo_export`, both held via ALL_PERMISSIONS) — it sets the four Admin ->
// Billing GL defaults, seeds its own shipped-and-invoiced order + a partly-applied/written-off
// payment against its own fixture customer (no discount since #69 — a 600.00 check cannot settle a
// 1,000.00 invoice, and the flow asserts the offer's absence; the discount's happy path lives in
// `receivables-apply-age-statement`'s settling second check), closes the current month, exports the
// GL delta, then
// reopens/corrects/re-closes/re-exports and confirms the reversing delta. Ran last (of 18) for the
// same "nothing after it needs its state" reason as every other flow at the tail of this list — and
// deliberately AFTER `receivables-apply-age-statement`, whose own invoice stays FINALIZED (never
// unlocked) for the rest of the run and so lands inside the SAME calendar month's close scope; the
// close flow's own fixtures backfill that invoice's step code/payment type with GL accounts for
// exactly this reason (`e2e/lib/db-fixtures.ts`'s `arOpGlAccountName`/`closePaymentType` comments).
// Task 11 (Phase 6) adds the 19th and now-last flow, `quotes`, as admin — the full quoting
// lifecycle (ending statement default → quote with linked + free-text lines and a price break →
// print → order-entry auto-link → ship → draft invoice naming "Quote #N" → close-with-reason
// warning → follow-up/expired worklist) against its own fixture customer/part. It runs last for
// the usual nothing-after-needs-its-state reason, and running AFTER `close-month-end` (which
// leaves the current month CLOSED until teardown) is safe by construction: the flow's invoice is
// created and STAYS a DRAFT — `createInvoice` is not a posting mutation, so `assertPeriodOpen`
// never guards it — and a draft has no `finalizedAt`, so it can never enter the close flow's
// readiness/export scope either (which is also why the quote fixtures carry no GL accounts).
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
  // Round 3 Group B (#165) adds `cert-scope-create`, as admin (needs certs.create + shipping.*,
  // all held via ALL_PERMISSIONS) — raising a certification by hand at a chosen scope, which is
  // the other half of "an implemented route with no button": `POST /api/certs` had no caller
  // anywhere, and SHIPMENT scope had no route at all until this task added
  // `POST /api/shippers/[id]/certs`. Sits beside the other cert flow deliberately. It keys its own
  // order against the shipping fixture customer and ships it (the `cert-results-print` /
  // `ship-partial-then-complete` pattern), finalizes no invoice and touches no period, close or
  // template state, and leaves nothing any later flow reads — so its position is a readability
  // choice, not a dependency.
  { name: "cert-scope-create", as: "admin", module: "./flows/cert-scope-create.mjs" },
  { name: "void-shipment", as: "admin", module: "./flows/void-shipment.mjs" },
  { name: "credit-hold-block-and-override", as: "clerk", module: "./flows/credit-hold-block-and-override.mjs" },
  { name: "invoice-shipped-order", as: "admin", module: "./flows/invoice-shipped-order.mjs" },
  // Round 3 Group B (#161) adds `reverse-shipment`, as admin (needs `void_shipper`, held via
  // ALL_PERMISSIONS) — the reversing shipment, whose route and service have been complete and
  // 17-test-covered since Phase 4 with no screen able to call either. It creates its own order
  // against the invoicing fixture customer, invoices and FINALIZES it (the only state in which
  // `Order.status = REOPENED` is reachable — this flow is that status's only writer), reverses,
  // then unlocks/voids/re-reverses. Placed here, directly after `invoice-shipped-order` and well
  // before `close-month-end`, for the same reason that flow's own header gives: it ends with its
  // invoice UNLOCKED, so — having no `finalizedAt` — it can never enter the close's readiness or
  // export scope, and its step codes/surcharge are nobody else's fixture to backfill. Nothing
  // after it depends on its state.
  { name: "reverse-shipment", as: "admin", module: "./flows/reverse-shipment.mjs" },
  { name: "receivables-apply-age-statement", as: "admin", module: "./flows/receivables-apply-age-statement.mjs" },
  { name: "close-month-end", as: "admin", module: "./flows/close-month-end.mjs" },
  { name: "quotes", as: "admin", module: "./flows/quotes.mjs" },
  // Task 16 (Phase 7) adds the 20th flow, `templates-admin`, as admin — the first
  // template-designer screen: reach /admin/templates via the nav, see the 8 document types with
  // their Standard defaults starred, create/publish/re-draft a template, then re-log-in as the
  // restricted view-only user to prove the nav decision + §5.16. It creates ONE fully-owned
  // DocumentTemplate (reaped by name in db-fixtures.ts) and mutates no seeded/shared state, so it
  // runs last for the usual nothing-after-needs-its-state reason and is safe after the CLOSED
  // month close-month-end leaves behind (it touches no invoicing/period state).
  { name: "templates-admin", as: "admin", module: "./flows/templates-admin.mjs" },
  // Task 8 (Phase 8A) adds the 21st and now-last flow, `reports`, as admin — the read-only proof of
  // the reports platform: reach /reports via the nav, confirm the catalog (six native reports + the
  // two homed cross-area entries), open the Backlog report and filter + Excel-export it (the export
  // path shared by every report), then drive the Comparison scoreboard's figures and its This-week /
  // This-month presets. It creates NOTHING — no order/invoice/fixture, no seeded/shared mutation — so
  // it needs no db-fixtures reap entry and runs last for the usual nothing-after-needs-its-state
  // reason; being purely a read, it is safe after whatever period/close state the tail leaves behind.
  { name: "reports", as: "admin", module: "./flows/reports.mjs" },
  { name: "setup-checklist", as: "admin", module: "./flows/setup-checklist.mjs" },
  // Task 9 (Phase 8C) adds the 23rd and now-last flow, `backups`, as admin (needs
  // `manage_backups`, held via ALL_PERMISSIONS) — the only place the real host `pg_dump` binary is
  // exercised (vitest injects a fake dump command so the suite never depends on a host major
  // matching the postgres:18 server). It mutates only the harness-owned BACKUP_DIR, never a
  // seeded/shared DB fixture, so it needs no db-fixtures reap entry and runs last for the usual
  // nothing-after-needs-its-state reason.
  { name: "backups", as: "admin", module: "./flows/backups.mjs" },
];

// Mutable, module-level: both main()'s own finally block and the SIGINT/SIGTERM handlers below
// need to reach whatever's currently been acquired, and a signal can land at any point during
// main()'s execution — there is no single function-local scope both paths share.
//
// `created.receivablesBatchId` (Task 17, Phase 5B): a `ReceiptBatch` has no customer column of
// its own (unlike an Order/Invoice/Shipper/Cert), so `deleteReceivables` (db-fixtures.ts) can only
// FIND one via a live `Payment` referencing it — a batch this flow created but never got as far as
// adding a payment to (a crash, or a selector bug — exactly what happened once during this task's
// own development) is otherwise invisible to both `cleanup()` and `reapLeftovers()`'s customer-
// scoped sweeps, forever. The `receivables-apply-age-statement.mjs` flow records its own batch's
// id here the moment it reads it back off the URL — the `templateIds` precedent (a live-built
// row's id is only known once the flow that created it has run) — so `cleanup()` below has an
// id-driven backstop alongside the payment-scoped sweep. Still not airtight: a crash hard enough
// to skip this module's own `finally { await teardown(); }` (never SIGTERM, no live process) loses
// this in-memory value the same way it loses everything else not yet written to the dev DB.
// `created.closeBatchId`/`closePeriodYear`/`closePeriodMonth` (Task 9, Phase 5C): the
// close-month-end flow's own id-driven cleanup backstops, the SAME reasoning as
// `receivablesBatchId` above but kept as separate fields (never reusing `receivablesBatchId`) so
// the two A/R flows' backstops can never clobber each other if both are live in one run.
const state = {
  devServer: null, browser: null, fixtures: null,
  created: {
    templateIds: [], orderId: null, orderNumber: null, receivablesBatchId: null,
    closeBatchId: null, closePeriodYear: null, closePeriodMonth: null,
  },
  cleanupFailed: null,
  // #184 fix (c): every dev-DB write a flow makes OUTSIDE the browser. `ctx.lockRevision` is the
  // only one (revision-cut calls it to stand in for Phase 3's order save), and it is invisible to
  // the page.on("response") mutation count that decides whether a retry is safe — so it is
  // counted here instead. runFlow snapshots this before the attempt and diffs it after.
  outOfBandWrites: 0,
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
    env: { ...process.env, PORT: String(PORT), BACKUP_DIR },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so killDevServer can take down webpack's worker processes with it, not
    // just the `next` wrapper.
    detached: true,
  });
  let out = "";
  // #184 fix (b). Two consumers, deliberately: the in-memory string is what waitForServer's
  // port-fallback detection greps and what the startup-failure path dumps to the console, and the
  // file is the artifact a reviewer reads afterwards. Appending as the data arrives (rather than
  // writing `out` once at teardown) means a run that is SIGKILLed, OOM-killed or that hangs still
  // leaves the log on disk — which is precisely the case #184 left nobody able to diagnose.
  const logStream = createWriteStream(DEV_SERVER_LOG, { flags: "a" });
  logStream.on("error", (err) => console.error(`  (could not write ${DEV_SERVER_LOG}: ${err})`));
  const record = (d) => { const text = d.toString(); out += text; logStream.write(text); };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.getOutput = () => out;
  child.closeLog = () => new Promise((resolve) => logStream.end(resolve));
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
      if (state.devServer) {
        await killDevServer(state.devServer);
        // After the kill, so the log carries the server's own shutdown output too.
        await state.devServer.closeLog?.();
      }
      if (state.fixtures) {
        console.log("\nCleaning up dev-DB fixtures (erp)...");
        try {
          runDbScript("cleanup", {
            ...state.fixtures,
            templateIds: state.created.templateIds,
            receivablesBatchId: state.created.receivablesBatchId,
            closeBatchId: state.created.closeBatchId,
            closePeriodYear: state.created.closePeriodYear,
            closePeriodMonth: state.created.closePeriodMonth,
          });
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
      await rm(BACKUP_DIR, { recursive: true, force: true });
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

// #184 fix (c). A `Failed to fetch` with no HTTP status is categorically different from an
// assertion failure — the app returned NOTHING rather than returning something wrong — and
// printing the two identically is what made the honest report ("23 of 24, and I cannot show you a
// clean run") indistinguishable from a careless one.
//
// Classification is driven primarily by what the BROWSER observed, not by the thrown error's
// text, because in all three of #184's recorded signatures the thrown error was an ordinary
// locator timeout: the page rendered, the client fetch behind a panel got no response, the panel
// showed "Failed to fetch", and the flow then timed out waiting for content that was never going
// to arrive. Only a `page.on("requestfailed")` record distinguishes that from a genuine
// assertion. The error text is a secondary signal for the two shapes that leave no
// `requestfailed` record: a transport error Playwright raises directly (`net::ERR_*`, a dropped
// socket), and a NAVIGATION timeout — `page.goto` waiting out its full 60s is the server failing
// to answer a page request at all, and Playwright cancels the pending request as `ERR_ABORTED`,
// which the ignore list below (correctly) drops. Anchored on `page.goto:` deliberately: a LOCATOR
// timeout ("Timeout 45000ms exceeded" waiting for an element, or a flow's own hand-rolled
// "Timed out waiting for ...") is an assertion failure and must stay one.
const NETWORK_ERROR_TEXT = /net::ERR_|NS_ERROR_|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|page\.goto: Timeout \d+ms exceeded/i;

// `net::ERR_ABORTED` is normal traffic, not a fault: Chromium reports it for an in-flight fetch
// superseded by a navigation, for a cancelled preload, and for a navigation that turns into a
// download (which the print flows do repeatedly). Counting it would classify healthy flows as
// network failures and retry them for no reason.
const IGNORED_REQUEST_FAILURES = /^net::ERR_ABORTED$/;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Measured while fixing #184, and worth naming in the output because it is the one cause anybody
// has actually caught in the act. Chromium flushes its socket pools and aborts every in-flight
// request with `net::ERR_NETWORK_CHANGED` whenever the HOST's network configuration changes — and
// on Linux, every container start or stop creates or destroys a `veth` pair, which is exactly such
// a change. A machine running any container-churning workload alongside the suite (another
// project's Testcontainers-style test run is the case that was caught) therefore breaks whatever
// requests happen to be open at that instant, all of them at once, with nothing wrong on either
// side of the connection. It has nothing to do with `next dev`: a 90-second probe against a
// 30-line static Node server on 127.0.0.1 lost 36 of 1380 requests this way, in simultaneous
// batches — the same "every panel of the page failed at once" shape #184 recorded.
const NETWORK_CHANGED_HINT =
  "  net::ERR_NETWORK_CHANGED is a HOST-level event, not an app fault: Chromium aborts every\n" +
  "  in-flight request when the machine's network configuration changes, and on Linux each\n" +
  "  container start/stop creates or destroys a veth pair that counts as one. Check whether\n" +
  "  something else on this machine was starting containers (`docker events`) before looking\n" +
  "  for a defect in the flow.";

/** The session endpoints, excluded from the mutation count: `login()` POSTs on every attempt and
 *  re-logging-in is idempotent, and logout only drops the row login just made. */
function isSessionEndpoint(url) {
  try {
    const { pathname } = new URL(url);
    return pathname === "/api/auth/login" || pathname === "/api/auth/logout";
  } catch {
    return false;
  }
}

function classifyFailure(error, netFailures) {
  if (netFailures.length > 0) return "network";
  return NETWORK_ERROR_TEXT.test(String(error?.message ?? error ?? "")) ? "network" : "assertion";
}

async function runFlow(browser, flow, ctx, attempt) {
  // Attempt 1 keeps the historical path so nothing that reads `e2e-artifacts/<flow>/` moves; a
  // retry gets its OWN directory, because the failed attempt's screenshots and video are the
  // whole reason the retry is allowed to be reported at all.
  const flowDir = path.join(ARTIFACTS_DIR, attempt === 1 ? flow.name : `${flow.name}__attempt-${attempt}`);
  await mkdir(flowDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir: flowDir, size: { width: 1280, height: 900 } },
  });

  // Context-level (not page-level) so a popup or a second tab a flow opens is instrumented too.
  //
  // `committed` is the count the retry decision turns on: a mutating, non-session request that
  // came back 2xx definitely changed the dev DB, so re-running the flow from step 1 would
  // duplicate it. `indeterminate` is the count that must ALSO be zero — a mutating request that
  // got no response at all may well have committed server-side before the connection dropped, and
  // an in-flight one at the moment of failure is no better known. `attempted - answered` captures
  // both without needing to know which.
  const netFailures = [];
  let attempted = 0, answered = 0, committed = 0;
  context.on("request", (request) => {
    if (MUTATING_METHODS.has(request.method()) && !isSessionEndpoint(request.url())) attempted += 1;
  });
  context.on("response", (response) => {
    const request = response.request();
    if (!MUTATING_METHODS.has(request.method()) || isSessionEndpoint(request.url())) return;
    answered += 1;
    if (response.status() >= 200 && response.status() <= 299) committed += 1;
  });
  context.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "unknown";
    if (IGNORED_REQUEST_FAILURES.test(errorText)) return;
    netFailures.push(`${request.method()} ${request.url()} — ${errorText}`);
  });
  const outOfBandBefore = state.outOfBandWrites;
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

  console.log(`\n=== ${flow.name} (as ${flow.as})${attempt > 1 ? ` [attempt ${attempt}]` : ""} ===`);
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
    console.log(attempt > 1 ? `  RETRIED-PASS (attempt ${attempt})` : `  PASS`);
  } catch (err) {
    ok = false;
    error = err;
    console.error(`  FAIL [${classifyFailure(err, netFailures)}]: ${err?.stack ?? err}`);
    if (netFailures.length > 0) {
      console.error(`  ${netFailures.length} request(s) got no response — the network-level ` +
        `evidence for that classification:`);
      for (const f of netFailures.slice(0, 5)) console.error(`    ${f}`);
      if (netFailures.length > 5) console.error(`    ... and ${netFailures.length - 5} more`);
      if (netFailures.some((f) => f.includes("net::ERR_NETWORK_CHANGED"))) console.error(NETWORK_CHANGED_HINT);
    }
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
  return {
    ok,
    error,
    kind: ok ? null : classifyFailure(error, netFailures),
    // The dev-DB writes this attempt is known to have made, plus the ones whose outcome it cannot
    // know. `ctx.lockRevision` writes straight to the DB and never touches the browser, so it is
    // folded into `committed` here rather than being tracked as a separate concept downstream.
    committed: committed + (state.outOfBandWrites - outOfBandBefore),
    indeterminate: attempted - answered,
    netFailures,
  };
}

/**
 * #184 fix (c), the design call. The issue asked for a blind single retry on a network-level
 * failure. A blind retry is NOT safe in this harness: the flows create real orders through the
 * real UI against a real dev database, and `template-build-and-load` leaves behind a template
 * three later flows consume — so re-running a flow that failed at step 40 would repeat everything
 * it did in steps 1–39, and the second attempt's failure would then be the harness's own doing.
 *
 * The retry is safe exactly when the attempt has not yet successfully changed anything, and that
 * is observable rather than assumed: zero mutating requests answered 2xx, zero mutating requests
 * with an unknown outcome, zero out-of-band dev-DB writes. Every signature #184 recorded — a whole
 * page's panels failing at once, a 5 KB blank screenshot — is a first-load failure, which is
 * exactly the case this admits and the case that has nothing to undo.
 *
 * Returns null when a retry is allowed, or the reason it is being refused.
 */
function retryRefusal(result) {
  if (result.kind !== "network") return `not retried: ${result.kind} failure, not a network-level one`;
  if (result.committed > 0) return `not retried: ${result.committed} mutating request(s) already committed`;
  if (result.indeterminate > 0) {
    return `not retried: ${result.indeterminate} mutating request(s) with an unknown outcome ` +
      `(no response — they may have committed before the connection dropped)`;
  }
  return null;
}

async function main() {
  const results = [];

  try {
    await rm(ARTIFACTS_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await rm(BACKUP_DIR, { recursive: true, force: true });
    await mkdir(BACKUP_DIR, { recursive: true });

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

    // #184 fix (a). `waitForServer` above compiled exactly ONE route (`/login`); everything else
    // used to compile on its first hit inside a flow, under whatever load the machine still
    // carried. See e2e/lib/warmup.mjs for how the route set is derived (from the filesystem,
    // never a hand-list) and why every request is a cookie-less GET.
    console.log("Warming every route so no flow pays for a cold compile...");
    await warmRoutes(BASE_URL, APP_DIR, { log: (line) => console.log(line) });

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
      lockRevision: (partId, revisionNumber) => {
        // Counted (see state.outOfBandWrites): this is a dev-DB write the browser never sees, so
        // the retry decision would otherwise believe the flow had changed nothing.
        state.outOfBandWrites += 1;
        return runDbScript("lock-revision", { partId, revisionNumber });
      },
    };

    // Deliberately sequential, not Promise.all: every flow after the first depends on state an
    // earlier one left in the dev DB (the template template-build-and-load creates, the values
    // typed-fields saves, the revision revision-cut cuts).
    for (const flow of FLOWS) {
      let result = await runFlow(state.browser, flow, ctx, 1);
      let retried = false;
      if (!result.ok) {
        const refusal = retryRefusal(result);
        if (refusal) {
          console.error(`  ${refusal}`);
        } else {
          console.error(`  network-level failure with nothing committed — retrying once`);
          retried = true;
          result = await runFlow(state.browser, flow, ctx, 2);
        }
      }
      results.push({ name: flow.name, retried, ...result });
    }
  } finally {
    await teardown();
  }

  console.log("\n=== Results ===");
  for (const r of results) {
    // A retried flow NEVER prints as a plain PASS — the point of the classification is that a run
    // that needed a retry and a run that did not are visibly different afterwards.
    const verdict = r.ok ? (r.retried ? "RETRIED" : "PASS   ") : "FAIL   ";
    const note = r.ok
      ? (r.retried ? "  (attempt 1 failed network-level; attempt 2 passed)" : "")
      : `  (${r.kind}-level${r.retried ? ", failed twice" : `; ${retryRefusal(r)}`})`;
    console.log(`  ${verdict}  ${r.name}${note}`);
  }
  const failed = results.filter((r) => !r.ok);
  const retriedOk = results.filter((r) => r.ok && r.retried);
  if (retriedOk.length > 0) {
    console.warn(`\n${retriedOk.length} flow(s) only passed on a retry after a network-level ` +
      `failure: ${retriedOk.map((r) => r.name).join(", ")}. The run is green, but the dev server ` +
      `dropped a request — see ${DEV_SERVER_LOG} and the __attempt-2 artifact directories.`);
  }
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
