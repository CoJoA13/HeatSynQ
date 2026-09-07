// WHAT THE E2E WARM-UP COSTS IN MEMORY, on whatever `next` is currently installed.
//
//   node scripts/warmup-memory-probe.mjs                 # from erp/
//   PROBE_LABEL=16.3.4 PROBE_CEILING_MB=14000 node scripts/warmup-memory-probe.mjs
//
// WHY THIS IS COMMITTED. The 2026-09-04 warm-up measurements in HANDOFF §4 were taken with a probe
// that was never committed and has since been deleted, so when #209 needed re-measuring on
// 2026-09-07 the instrument had to be rebuilt — and it came out different (concurrent rather than
// sequential), which is the entire reason 16.2.12 reads ~7.2 GB in the newer table and 8821 MB in
// the older one. Two true numbers that cannot be compared is the worst outcome a measurement can
// have. This file exists so the NEXT measurement is comparable to the last one.
//
// THIS IS NOT A NEW INSTRUMENT. It replays the memory-relevant phase of `e2e/run.mjs` — that file's
// own `startDevServer()` argv (including `--disable-source-maps`), `waitForServer` on `/login`, then
// `warmRoutes` at its own defaults (concurrency 4, 240 s budget, every route under `src/app`) — and
// meters it with `devServerMemoryMeter` COPIED VERBATIM below. The copy is asserted still
// byte-identical to run.mjs at startup and the probe REFUSES to run otherwise, because a probe
// measuring a meter the harness no longer uses produces a number that still looks authoritative.
//
// THREE DELIBERATE DEVIATIONS from run.mjs, all reported in the output:
//   1. Its own port and log file, so it can never fight `test:e2e` (3100) or `manual:capture` (3200).
//   2. A CEILING watchdog. run.mjs has none — on next 16.3.x that is how a CI runner and two desktop
//      sessions died. Crossing it kills the server group; that is a RESULT, not a failed run, and it
//      makes the reported peak a censored FLOOR (see `peakCensored`).
//   3. It counts warm-up completions by wrapping `globalThis.fetch`, because warmup.mjs's `log`
//      callback fires only at the end. Attribution to a single route is approximate at concurrency
//      4 and is reported as "after N routes", never "route X cost Y".
//
// It runs NO flow, creates NO fixture, and issues only the warm-up's own cookie-less GETs, so it
// writes nothing to any database. Linux-only, matching every other assumption in this harness.
//
// HOW TO RUN AN HONEST A/B (the protocol behind HANDOFF §4, 2026-09-07):
//   * `rm -rf .next` before EVERY run — a warm cache understates both memory and wall clock, and
//     CI is always cold.
//   * Keep the rest of the box quiet. A local warm-up is the largest memory consumer this repo has.
//   * Run the CONTROL TWICE, once on each side of the variable. Two runs of one version are the
//     only thing that tells you the noise floor; on 2026-09-07 it was 1.4 %, which is what let a
//     3.6× difference mean something.
//   * **Never compare a censored peak against a completed one.** A run the watchdog killed stopped
//     partway with only the sampler surviving (`devServerPeakRssMb` matches no live PID once the
//     group is dead), so its number is a floor in a column of maxima. Compare `trail` at equal
//     route counts instead — that is the same work on both sides.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, createWriteStream, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ERP_ROOT = process.env.PROBE_ERP_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(ERP_ROOT, "src", "app");
// 3300 by default: `test:e2e` owns 3100 and `manual:capture` owns 3200, and this must never be able
// to answer for — or be answered by — either of them.
const PORT = Number(process.env.PROBE_PORT ?? 3300);
const BASE_URL = `http://localhost:${PORT}`;
const BACKUP_DIR = path.join(ERP_ROOT, "e2e-backups");
// Sized by judgement, not measurement: high enough to clear a healthy warm-up with real headroom
// (16.2.12 peaks around 7.2 GB), low enough that killing at it leaves any machine that can run this
// suite far from an OOM. It exists so a runaway version kills its own dev server rather than the box.
const CEILING_MB = Number(process.env.PROBE_CEILING_MB ?? 14000);
const LABEL = process.env.PROBE_LABEL ?? "unlabelled";
const OUT_DIR = process.env.PROBE_OUT_DIR ?? path.join(ERP_ROOT, "e2e-artifacts");
const DEV_LOG = path.join(OUT_DIR, `probe-dev-server-${LABEL}.log`);

mkdirSync(OUT_DIR, { recursive: true });
const { warmRoutes, warmupRefusal } = await import(path.join(ERP_ROOT, "e2e/lib/warmup.mjs"));

// ---------------------------------------------------------------------------------------------
// VERBATIM FROM e2e/run.mjs. Do not edit either copy without the other: the assertion below reads
// run.mjs and refuses to run if these three function bodies are no longer byte-identical to it.
// ---------------------------------------------------------------------------------------------
function devServerPeakRssMb(child) {
  if (!child?.pid) return 0;
  try {
    const out = execFileSync("ps", ["-eo", "pgid=,pid="], { encoding: "utf8" });
    let kb = 0;
    for (const line of out.split("\n")) {
      const [pgid, pid] = line.trim().split(/\s+/);
      if (Number(pgid) !== child.pid || !pid) continue;
      try {
        // VmHWM — the kernel's own peak-RSS counter for the process, not a sample.
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        kb += Number(status.match(/^VmHWM:\s+(\d+) kB$/m)?.[1] ?? 0);
      } catch {
        // This PID vanished between the `ps` listing and the read. That is the EXPECTED case here,
        // not an anomaly — the transient compile workers are the whole reason this function is
        // paired with a sampler — so it must skip the dead process and keep every reading already
        // collected. Letting it reach the outer catch would return 0 and discard the long-lived
        // server's high-water mark, which is the one figure that actually matters.
      }
    }
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
}

function devServerRssMb(child) {
  if (!child?.pid) return 0;
  try {
    const out = execFileSync("ps", ["-eo", "pgid=,rss="], { encoding: "utf8" });
    let kb = 0;
    for (const line of out.split("\n")) {
      const [pgid, rss] = line.trim().split(/\s+/);
      if (Number(pgid) === child.pid) kb += Number(rss) || 0;
    }
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
}

function devServerMemoryMeter(child) {
  let peak = 0;
  const sample = () => { const mb = devServerRssMb(child); if (mb > peak) peak = mb; };
  sample();
  const timer = setInterval(sample, 500);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return Math.max(peak, devServerPeakRssMb(child));
    },
  };
}
// ------------------------------- end verbatim copy --------------------------------------------

// FAIL CLOSED on drift. A probe measuring a meter the harness no longer uses is worse than no
// probe: the number would still look authoritative. `fn.toString()` returns the source as written,
// so a verbatim copy of a zero-indent top-level function is byte-identical to run.mjs's own text.
const RUN_MJS = readFileSync(path.join(ERP_ROOT, "e2e/run.mjs"), "utf8");
for (const fn of [devServerPeakRssMb, devServerRssMb, devServerMemoryMeter]) {
  if (!RUN_MJS.includes(fn.toString())) {
    console.error(`REFUSING: ${fn.name} is no longer byte-identical to the copy in e2e/run.mjs. ` +
      `Re-copy it before trusting any number from this probe.`);
    process.exit(2);
  }
}

/**
 * IS THE SERVER THAT ANSWERED THE ONE WE SPAWNED? (Run B, 2026-09-07 — the probe's own worst bug.)
 *
 * The first B run reported next@16.3.4 booting in 0.1 s, warming all 243 routes in 1.1 s and
 * peaking at 225 MB — a number that reads as "the regression is fixed" and is entirely false. An
 * orphaned 16.2.12 server from run A still held the port, `next dev` 16.3.4 died with EADDRINUSE
 * (16.3 no longer does 16.2's "Port N is in use, trying N+1 instead" fallback, so run.mjs's own
 * port-mismatch guard could not fire either), and `waitForServer`'s very first fetch was answered
 * by the ORPHAN — fully warm, hence instant — while the meter watched our own dying wrapper.
 *
 * A measurement instrument that reports a small, reassuring number when it has measured nothing is
 * strictly worse than one that crashes. So three guards, all of which must pass:
 *   - the port is free BEFORE the spawn (run.mjs's isPortFree);
 *   - the child is still alive after waitForServer returns;
 *   - the PID actually LISTENING on the port belongs to our child's process group.
 * The third is the load-bearing one: it is the only one that can tell "our server answered" from
 * "something answered".
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

function listenerPgid(port) {
  try {
    const out = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
    const pid = out.match(/pid=(\d+)/)?.[1];
    if (!pid) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // field 5 is pgrp; the comm field can contain spaces, so slice past its closing paren first.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return null;
  }
}

function startDevServer() {
  const child = spawn("npx", ["next", "dev", "-p", String(PORT), "--disable-source-maps"], {
    cwd: ERP_ROOT,
    env: { ...process.env, PORT: String(PORT), BACKUP_DIR },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let out = "";
  const logStream = createWriteStream(DEV_LOG, { flags: "a" });
  logStream.on("error", () => {});
  const record = (d) => { const text = d.toString(); out += text; logStream.write(text); };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.getOutput = () => out;
  child.closeLog = () => new Promise((resolve) => logStream.end(resolve));
  return child;
}

async function waitForServer(url, timeoutMs, devServer) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const portMismatch = devServer.getOutput().match(/Port (\d+) is in use, trying (\d+) instead/);
    if (portMismatch) {
      throw new Error(`next dev fell back from ${portMismatch[1]} to ${portMismatch[2]} — wrong port, refusing.`);
    }
    if (devServer.exitCode !== null) throw new Error(`next dev exited (${devServer.exitCode}) before answering.`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch { /* still booting */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url} to come up`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** SIGKILL the group and WAIT for it to actually go — a signal having been SENT is not the port
 *  having been FREED, which is how run B came to measure run A's server (see listenerPgid). */
async function killGroup(child) {
  if (!child) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (let i = 0; i < 100; i += 1) {
    if (await isPortFree(PORT)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`WARNING: port ${PORT} still held 10s after SIGKILL — the next run must not start.`);
}

// --- progress counter: warmup.mjs's own `log` fires only at the end, so count completions here.
let completed = 0;
// Gated on the warm-up having actually STARTED. `waitForServer` polls the same base URL, and its
// one successful poll was counted as a warmed route in the first smoke run (81 counted against 80
// warm-up successes). An off-by-one is not fatal to a memory figure, but "after N routes" is a
// number this measurement reports, and a reported number that is quietly wrong by one is the
// beginning of a reported number that is quietly wrong by more.
let counting = false;
const trail = [];        // [routesDone, rssMb] every 10 completions — the shape of the curve
const realFetch = globalThis.fetch;
let devServer = null;
globalThis.fetch = async (...args) => {
  const res = await realFetch(...args);
  const url = String(args[0] ?? "");
  if (counting && url.startsWith(BASE_URL)) {
    completed += 1;
    if (completed % 10 === 0 && devServer) trail.push([completed, devServerRssMb(devServer)]);
  }
  return res;
};

const started = Date.now();
const result = {
  label: LABEL, port: PORT, ceilingMb: CEILING_MB,
  nextVersion: JSON.parse(readFileSync(path.join(ERP_ROOT, "node_modules/next/package.json"), "utf8")).version,
  node: process.version,
};

if (!(await isPortFree(PORT))) {
  console.error(`REFUSING: port ${PORT} is already in use. A previous probe's dev server is still ` +
    `alive, and measuring against it reports the PREVIOUS version's warm cache as this one's. ` +
    `\`fuser -k ${PORT}/tcp\` and re-run.`);
  process.exit(2);
}

devServer = startDevServer();
let ceilingHit = null;
const watchdog = setInterval(() => {
  const mb = devServerRssMb(devServer);
  if (mb > CEILING_MB && !ceilingHit) {
    ceilingHit = { mb, routesDone: completed };
    console.error(`\n!! CEILING ${CEILING_MB} MB crossed at ${mb} MB after ${completed} routes — killing the server group.`);
    void killGroup(devServer);
  }
}, 500);
watchdog.unref?.();

// Declared OUT here so the catch can still drain it. Adversarial review, 2026-09-07: it used to be
// a `const` inside the try, so every throwing path reported `Math.max(devServerRssMb, devServerPeakRssMb)`
// instead — and once the group is dead BOTH of those match no PID in the pgid and return 0. A run
// that died reported a peak of 0 MB under a comment promising the opposite.
let memory = null;
try {
  await waitForServer(`${BASE_URL}/login`, 120000, devServer);
  if (devServer.exitCode !== null) throw new Error(`next dev exited (${devServer.exitCode}) — something ELSE answered on ${PORT}.`);
  const pgid = listenerPgid(PORT);
  result.listenerPgid = pgid;
  if (pgid !== devServer.pid) {
    throw new Error(`the process listening on ${PORT} is in group ${pgid}, not ours (${devServer.pid}) ` +
      `— an orphaned dev server answered. Refusing to report its numbers as this version's.`);
  }
  result.bootMs = Date.now() - started;
  result.rssAfterBootMb = devServerRssMb(devServer);
  console.log(`  up in ${(result.bootMs / 1000).toFixed(1)}s, ${result.rssAfterBootMb} MB after /login`);

  const warmStarted = Date.now();
  counting = true;
  memory = devServerMemoryMeter(devServer);
  const warm = await warmRoutes(BASE_URL, APP_DIR, { log: (line) => console.log(line) });
  result.peakMb = memory.stop();
  result.warmMs = Date.now() - warmStarted;
  result.warm = {
    count: warm.count, pages: warm.pages, apis: warm.apis, skipped: warm.skipped,
    failures: warm.failures.length, pagesRedirected: warm.pagesRedirected,
    slowest: warm.slowest.map((r) => `${r.route} ${(r.ms / 1000).toFixed(1)}s`),
  };
  result.refusal = warmupRefusal(warm);
  console.log(`  dev server peak RSS through warm-up: ${result.peakMb} MB`);
} catch (err) {
  result.error = String(err?.message ?? err);
  // A failed run must report the peak it reached WHERE ONE SURVIVES — and on a dead process group
  // neither `ps` read does, so the meter's own closure is the only estimator left standing.
  result.peakMb = Math.max(memory?.stop() ?? 0, devServerRssMb(devServer), devServerPeakRssMb(devServer));
  console.error(`  probe error: ${result.error}`);
} finally {
  clearInterval(watchdog);
  result.ceiling = ceilingHit;
  // THE CEILING READING IS PART OF THE PEAK, and until 2026-09-07 it was not. Once the watchdog
  // SIGKILLs the group, `devServerPeakRssMb` matches no live PID and returns 0, so `memory.stop()`'s
  // `Math.max(sampler, VmHWM-sum)` silently degenerates to the sampler alone — which is how run B
  // reported 13776 MB while `ceiling.mb` recorded 14002 MB in the very next field. A "peak" lower
  // than a stored reading of the same metric is the tell; folding it in removes the inversion.
  if (ceilingHit) result.peakMb = Math.max(result.peakMb ?? 0, ceilingHit.mb);
  // A CENSORED FLOOR MUST NOT BE READABLE AS A COMPLETED PEAK. run A finished all 243 routes with
  // both estimators; a killed run stopped partway with one. They are different constructs, and
  // printing them in one column invites a ratio that understates the regression by ~2x — compare
  // `trail` at equal route counts instead.
  result.routesCompleted = completed;
  result.peakCensored = Boolean(ceilingHit) || completed < (result.warm?.count ?? Infinity);
  result.trail = trail;
  result.totalMs = Date.now() - started;
  await killGroup(devServer);
  await devServer.closeLog?.();
}

console.log(JSON.stringify(result, null, 2));
