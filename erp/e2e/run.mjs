#!/usr/bin/env node
// Playwright E2E harness (spec §12 / HANDOFF §5a). Drives the bundled Chromium against a
// throwaway `next dev` instance on port 3100, running six owner-reviewable flows in sequence.
// Each flow gets its own browser context (so it gets its own video.webm) and its own numbered
// screenshot sequence under e2e-artifacts/<flow>/.
//
// `npm run test:e2e` == `node e2e/run.mjs` (package.json). `HEADED=1 npm run test:e2e` runs
// headed. Exits non-zero if any flow fails; dev-DB fixtures are always cleaned up in a finally
// block, whether flows pass or not.
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
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
const FLOWS = [
  { name: "template-build-and-load", as: "admin", module: "./flows/template-build-and-load.mjs" },
  { name: "typed-fields", as: "admin", module: "./flows/typed-fields.mjs" },
  { name: "revision-cut", as: "admin", module: "./flows/revision-cut.mjs" },
  { name: "blocked-code-delete", as: "admin", module: "./flows/blocked-code-delete.mjs" },
  { name: "permission-gating", as: "restricted", module: "./flows/permission-gating.mjs" },
  { name: "processes-list", as: "restricted", module: "./flows/processes-list.mjs" },
];

function runDbScript(command, payload) {
  const args = ["tsx", path.join("e2e", "lib", "db-fixtures.ts"), command, JSON.stringify(payload ?? {})];
  const out = execFileSync("npx", args, { cwd: ERP_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const line = out.trim().split("\n").filter(Boolean).pop();
  return line ? JSON.parse(line) : null;
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
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

function killDevServer(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
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
    const creds = flow.as === "restricted"
      ? { username: ctx.fixtures.restrictedUsername, password: ctx.fixtures.restrictedPassword }
      : { username: "admin", password: "admin" };
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
  let devServer = null;
  let browser = null;
  let fixtures = null;
  const created = { templateIds: [] };
  const results = [];

  try {
    await rm(ARTIFACTS_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });

    console.log("Creating dev-DB fixtures (erp)...");
    fixtures = runDbScript("create");
    console.log(`  customer ${fixtures.customerCode}, part ${fixtures.partNumber}, ` +
      `step codes ${fixtures.stepCodeA.code}/${fixtures.stepCodeB.code}, ` +
      `restricted user ${fixtures.restrictedUsername}`);

    console.log(`Starting next dev on port ${PORT}...`);
    devServer = startDevServer();
    try {
      await waitForServer(`${BASE_URL}/login`, 60000);
    } catch (err) {
      console.error(`--- next dev output ---\n${devServer.getOutput()}\n-----------------------`);
      throw err;
    }
    console.log("  dev server is up");

    browser = await chromium.launch({ headless: !HEADED });

    const ctx = {
      baseURL: BASE_URL,
      fixtures,
      created,
      lockRevision: (partId, revisionNumber) => runDbScript("lock-revision", { partId, revisionNumber }),
    };

    // Deliberately sequential, not Promise.all: every flow after the first depends on state an
    // earlier one left in the dev DB (the template template-build-and-load creates, the values
    // typed-fields saves, the revision revision-cut cuts).
    for (const flow of FLOWS) {
      await runFlow(browser, flow, ctx, results);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (devServer) killDevServer(devServer);
    if (fixtures) {
      console.log("\nCleaning up dev-DB fixtures (erp)...");
      try {
        runDbScript("cleanup", { ...fixtures, templateIds: created.templateIds });
        console.log("  cleanup ok");
      } catch (err) {
        console.error(`  cleanup FAILED — dev DB may still hold E2E fixture rows: ${err}`);
      }
    }
  }

  console.log("\n=== Results ===");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0 || results.length !== FLOWS.length) {
    console.error(`\n${failed.length} of ${FLOWS.length} flow(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${FLOWS.length} flows passed. Artifacts: ${ARTIFACTS_DIR}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
