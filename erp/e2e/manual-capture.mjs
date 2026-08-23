#!/usr/bin/env node
// Screenshot + health-sweep harness for the user manual (docs/manual/).
//
// `npm run manual:capture` == `node e2e/manual-capture.mjs`. It visits EVERY screen in the app,
// writes one full-page PNG per screen into docs/manual/img/, and writes docs/manual/sweep.md — a
// per-screen health report (own API request statuses, console errors/warnings, failed network
// requests, real-content-vs-empty-state, wall-clock load time). It exits non-zero when any screen
// produced a console error, an uncaught page error, or a failed request, so it doubles as a
// verification gate before the shop's acceptance month.
//
// It deliberately REUSES e2e/run.mjs's machinery rather than becoming a second harness: the same
// bundled Chromium, the same `next dev` spawn/wait/kill sequence with its detached process group,
// the same `execFileSync("npx", ["tsx", ...])`-and-parse-one-line-of-JSON contract for reaching the
// database, and the same `login()` helper from e2e/lib/auth.mjs.
//
// THE ONE CRITICAL DIFFERENCE FROM run.mjs: this harness is READ-ONLY against the dev database.
// run.mjs creates dev-DB fixtures and reaps them afterwards; this one creates nothing and deletes
// nothing, because it is pointed at the real demonstration dataset the manual is written against —
// wiping or polluting that dataset is the one outcome that would make this tool worse than
// useless. It discovers ids for the dynamic routes with e2e/lib/manual-ids.ts (SELECTs only) and
// never calls e2e/lib/db-fixtures.ts.
//
// The interaction captures are the only places it types into the app at all, and each is bounded:
//   * none of them presses a save/post/apply/publish control;
//   * the ONE unavoidable write in the whole run is `/orders/new`'s 2-second draft autosave, which
//     fires on any edit. That is handled honestly rather than ignored — see captureOrderEntry():
//     the harness refuses to touch the form at all if a draft banner was ALREADY showing when it
//     arrived (that draft belongs to a real person and discarding it would destroy their work),
//     and discards only a draft it created itself.
//   * opening a template draft is a real mutation and is therefore OPT-IN (MANUAL_OPEN_DRAFT=1),
//     never the default. Without it, a template with no open draft is reported, not mutated.
//
// Ports: run.mjs owns 3100. This harness owns 3200, so a capture and an E2E run can never fight
// over a port or a dev server. Set MANUAL_BASE_URL to attach to an already-running server instead
// (e.g. MANUAL_BASE_URL=http://localhost:3000) — the harness then starts nothing and kills nothing.
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readdir, writeFile, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { login } from "./lib/auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ERP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ERP_ROOT, "..");
// MANUAL_OUT_DIR redirects the whole output tree, which is what makes a PARTIAL run safe: a smoke
// test over one or two routes must never overwrite docs/manual/sweep.md, because a sweep that
// covers three screens while claiming to be the sweep is worse than no sweep at all.
const MANUAL_DIR = process.env.MANUAL_OUT_DIR
  ? path.resolve(process.env.MANUAL_OUT_DIR)
  : path.join(REPO_ROOT, "docs", "manual");
const IMG_DIR = path.join(MANUAL_DIR, "img");
const SWEEP_FILE = path.join(MANUAL_DIR, "sweep.md");
const APP_DIR = path.join(ERP_ROOT, "src", "app");

/** MANUAL_ONLY=/parts,/reports/backlog restricts the run to those routes — for developing the
 *  harness itself, never for a real capture. Interaction captures are skipped while it is set
 *  (they assume the full run's context), unless MANUAL_INTERACTIONS=1 asks for them back. */
const ONLY_ROUTES = process.env.MANUAL_ONLY
  ? new Set(process.env.MANUAL_ONLY.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const RUN_INTERACTIONS = process.env.MANUAL_INTERACTIONS === "1" || !ONLY_ROUTES;

const PORT = 3200;
const ATTACH_URL = process.env.MANUAL_BASE_URL ?? null;
const BASE_URL = ATTACH_URL ?? `http://localhost:${PORT}`;
const HEADED = Boolean(process.env.HEADED);

/** Opt-in permission to create a template DRAFT so the template editor can be photographed.
 *  Off by default: it is the only genuinely additive write the harness can make, and the owner's
 *  prime directive is not to assume. See captureTemplateEditor(). */
const ALLOW_OPEN_DRAFT = process.env.MANUAL_OPEN_DRAFT === "1";

// The demonstration dataset's own administrator. NOT `admin`/`admin`: the seed deliberately moves
// the password off the default in `finishFirstRun` (prisma/manual-seed.ts's `ADMIN_PASSWORD`) and
// dismisses the first-run checklist, because otherwise the §5.7 "still using the default password"
// banner and the "Setup isn't finished" banner ride on top of all 45 manual figures. That seed
// constant is the source of truth for this value — if it changes, change it here too (or just pass
// MANUAL_PASS). A shop running against its own data overrides both with the env vars.
const USERNAME = process.env.MANUAL_USER ?? "admin";
const PASSWORD = process.env.MANUAL_PASS ?? "heatsynq-demo";

/** Desktop capture viewport. Full-page screenshots extend past the height; the WIDTH is what
 *  determines the layout the manual shows, so it stays fixed. */
const VIEWPORT = { width: 1440, height: 900 };

/** Captured 1:1 (#169). It was 2× — "so the PNGs stay legible when scaled down" — but the manual
 *  lays a full-width figure out at 1200 declared px and renders it narrower still, so the extra
 *  density was never reaching a reader; what it did reach was the file size. A 2× run writes
 *  ~24 MB of PNGs, and `manual.html` inlines all of them as `data:` URIs against a 16 MB publish
 *  ceiling, so the page only ever fitted because someone ran ImageMagick over `img/` by hand — a
 *  step that existed nowhere in this repo, which is the rot `manual:build` was written to end.
 *
 *  `scripts/lib/manual-figure-size.mjs` is COUPLED to this: the display rule reads each image's
 *  own intrinsic width now instead of assuming this constant, which is what makes changing it
 *  safe. Raising it back to 2 renders identically and just costs bytes; the capture is unaffected
 *  either way, since the CSS layout does not change — only the raster is denser, so
 *  `MAX_SHOT_HEIGHT` below still measures CSS pixels and means the same thing. */
const DEVICE_SCALE = Number(process.env.MANUAL_SCALE ?? 1);

/** Full-page shots of a heavily-seeded list can run to tens of thousands of pixels. Past this
 *  height the capture is clipped to the top MAX_SHOT_HEIGHT px OF THE PAGE — not of the viewport —
 *  and the clip is RECORDED in sweep.md for that screen, never silently applied.
 *
 *  See shoot(): honouring "of the page" needs `fullPage: true` ALONGSIDE the clip. Without it
 *  Playwright clamps the clip to the viewport, so this constant stopped mattering entirely and the
 *  sweep's note said 6000 while the file held 900 (#169 fix round). Keep the two in step: this
 *  docstring, shoot()'s screenshot options, and the sweep wording are one contract in three
 *  places. */
const MAX_SHOT_HEIGHT = 6000;

const CONTENT_TIMEOUT_MS = 30000;
/** How long the in-flight request count must sit at zero for a page to count as settled. */
const QUIET_MS = 500;
/** `/orders/new` autosaves a draft 2s after an edit; this is the margin the harness waits before
 *  assuming its own draft has landed and can be discarded again. */
const DRAFT_AUTOSAVE_MS = 3500;

// ---------------------------------------------------------------------------------------------
// Noise the dev server itself generates, which is NOT an application fault and must not gate the
// run. Every match is still COUNTED and LISTED in sweep.md's "Filtered dev-server noise" section —
// filtered, never swallowed. Keep this list short and specific; a broad pattern here would hide
// exactly the real bugs this harness exists to catch.
// ---------------------------------------------------------------------------------------------
const NOISE_PATTERNS = [
  /Download the React DevTools/i,        // React's standing dev-build suggestion, once per load
  /\[Fast Refresh\]/i,                   // Next dev HMR chatter
  /webpack-hmr/i,
  /__nextjs_original-stack-frame/i,      // dev-only stack-frame lookups
  /_next\/static\/webpack\/.*hot-update/i,
  /\/__nextjs_font\//i,
];

const isNoise = (text) => NOISE_PATTERNS.some((re) => re.test(text));

/**
 * Findings a human has already triaged, annotated in the report so the next reader is not sent
 * chasing them again.
 *
 * These live HERE, in the generator, rather than being hand-edited into sweep.md — the report is
 * regenerated from scratch on every run, so a note added to the file itself survives exactly until
 * the next capture.
 *
 * Note what this is NOT: it is not a whitelist. An annotated screen still counts as a FAIL and the
 * run still exits non-zero, because suppressing the route would weaken the gate for every other
 * screen that might one day 404 the same way. The annotation buys the reader context, not a pass.
 *
 * Currently EMPTY, and that is the healthy state — an entry here is a standing FAIL waiting to be
 * fixed, not a resting place. Its one occupant, `admin-users` (#160, the signature route's one 404
 * per signature-less user), was removed when #160 landed: `listUsers` now carries a `hasSignature`
 * flag, so the preview `<img>` is only requested when there is something to fetch.
 */
const KNOWN_EXPECTED = {};

/** Screens whose empty/near-empty flag a human has already checked in the browser and cleared. The
 *  heuristic is deliberately left alone — it flagged them for human judgement and a human judged
 *  them, which is exactly the intended contract. */
const REVIEWED_EMPTY = {
  "admin-roles": "Reviewed and cleared — renders all five roles as a LIST, not a table, so the " +
    "\"no table rows\" half of the heuristic cannot see them.",
  "admin-surcharges": "Reviewed and cleared — renders all three surcharge rules as a list, same " +
    "reason as Roles above.",
  login: "Legitimately sparse — a username field, a password field and a button is the whole screen.",
  practice: "Legitimately sparse — this is the PRODUCTION database, so the practice-copy screen " +
    "correctly has nothing to show.",
};

// ---------------------------------------------------------------------------------------------
// Route enumeration — from the filesystem, never a hand-list (a hand-list rots the moment someone
// adds a screen). Mirrors Next's App Router conventions: `(group)` segments do not appear in the
// URL, `_private` folders are not routes at all, `@slot` folders are parallel-route slots.
// ---------------------------------------------------------------------------------------------
async function enumerateRoutes() {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "page.tsx" || entry.name === "page.jsx") files.push(full);
    }
  }
  await walk(APP_DIR);

  const routes = [];
  for (const file of files) {
    const rel = path.relative(APP_DIR, path.dirname(file));
    const raw = rel === "" ? [] : rel.split(path.sep);
    if (raw.some((s) => s.startsWith("_") || s.startsWith("@"))) continue;
    const segs = raw.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
    routes.push({
      route: `/${segs.join("/")}`,
      segs,
      dynamic: segs.filter((s) => s.startsWith("[")),
      source: path.relative(ERP_ROOT, file),
      name: screenName(segs),
    });
  }
  routes.sort((a, b) => a.route.localeCompare(b.route));
  return routes;
}

/**
 * Deterministic screenshot basename for a route.
 *   /                          -> home            /parts            -> parts
 *   /parts/[id]                -> parts-detail    /orders/new       -> orders-new
 *   /receivables/batches/[id]  -> receivables-batches-detail
 *   /admin/templates/[id]/edit -> admin-templates-edit
 * A TRAILING dynamic segment becomes `detail`; a dynamic segment in the MIDDLE is dropped, because
 * "which id" adds nothing to a name whose real subject is the segment after it.
 */
function screenName(segs) {
  if (segs.length === 0) return "home";
  return segs
    .map((s, i) => (s.startsWith("[") ? (i === segs.length - 1 ? "detail" : null) : s))
    .filter((s) => s !== null)
    .join("-");
}

// ---------------------------------------------------------------------------------------------
// Per-route readiness plan.
//
// This is an OVERRIDE table, not the source of truth — a newly added screen is captured the moment
// it exists, with or without an entry here, using the generic `waitForContent` rule alone. Entries
// exist only for the two things the generic rule cannot know: which discovered id fills a `[id]`,
// and what "real content has landed" looks like on a screen whose loading and empty states are
// indistinguishable.
//
// Readiness descriptors (all optional, all awaited):
//   { api: "/api/x" }                    a successful GET response on that exact pathname prefix
//   { heading: "Parts" }                 role=heading with that accessible name
//   { headingPattern: "^Order #\\d+" }   role=heading matching that regex
//   { role: "link", name: "…" }          any role + accessible name
//   { text: "…" }                        visible text
//
// The three shapes below come from reading the components (see docs/manual/sweep.md's notes):
//  * "Pattern A" detail pages render a bare `Loading…` with NO heading, so the <h1> IS the proof.
//  * "Pattern B" report pages render the same <h1> in the loading branch, so the heading proves
//    nothing — but `Export to Excel` is an inert <span> until the first successful load and only
//    then becomes a real <a>, so the LINK role is the proof.
//  * "Pattern D" pages have no spinner AND no empty state — page chrome renders synchronously and
//    an empty table is indistinguishable from a loading one. Only the network settles them.
// ---------------------------------------------------------------------------------------------
const EXPORT_LINK = { role: "link", name: "Export to Excel" };

const ROUTE_PLAN = {
  // ---- Pattern D: no rendered distinction between loading and empty — wait on the network ----
  "/": { ready: [{ api: "/api/orders" }, { role: "button", name: "New Order" }] },
  "/parts": { ready: [{ api: "/api/parts" }, { heading: "Parts" }] },
  "/customers": { ready: [{ api: "/api/customers" }, { heading: "Customers" }] },
  "/processes": { ready: [{ api: "/api/process-templates" }, { heading: "Processes" }] },
  "/admin/users": { ready: [{ api: "/api/admin/users" }, { heading: "Users" }] },
  "/admin/roles": { ready: [{ api: "/api/admin/roles" }, { heading: "Roles" }] },
  "/admin/settings": { ready: [{ api: "/api/admin/settings" }] },
  "/admin/step-codes": { ready: [{ api: "/api/admin/step-codes" }, { heading: "Process step codes" }] },
  "/admin/surcharges": { ready: [{ api: "/api/admin/surcharges" }, { heading: "Surcharges" }] },
  "/admin/part-fields": { ready: [{ heading: "Part custom fields" }] },
  "/admin/audit": { ready: [{ role: "button", name: "Search" }] },
  "/admin/reference": { ready: [{ heading: "Reference data" }] },
  "/admin/templates": { ready: [{ api: "/api/templates" }, { heading: "Document templates" }] },

  // ---- Pattern B: reports — the Export LINK is the only honest readiness proof ----------------
  "/reports": { ready: [{ role: "link", name: "Backlog" }] },
  "/reports/backlog": { ready: [EXPORT_LINK] },
  "/reports/shipped": { ready: [EXPORT_LINK] },
  "/reports/turnaround": { ready: [EXPORT_LINK] },
  "/reports/sales": { ready: [EXPORT_LINK] },
  "/reports/payments": { ready: [EXPORT_LINK] },
  "/reports/scoreboard": { ready: [EXPORT_LINK] },
  "/receivables/aging": { ready: [EXPORT_LINK] },

  // ---- List pages whose empty state IS loaded-guarded (safe to settle generically) ------------
  "/certs": { ready: [{ heading: "Certifications" }] },
  "/invoicing": { ready: [{ heading: "Invoicing" }] },
  "/quotes": { ready: [{ heading: "Quotes" }] },
  "/receivables": { ready: [{ heading: "Receivables" }] },
  // NOTE: /shipping's "No shipments" empty state is NOT loaded-guarded (it paints during the
  // fetch, unlike every sibling list) — so the heading alone would let a mid-fetch shot through.
  // Wait on the network too, and the sweep flags the finding.
  "/shipping": { ready: [{ api: "/api/shippers" }, { heading: "Shipping" }] },
  "/shipping/new": { ready: [{ heading: "New shipment" }] },
  "/receivables/close": { ready: [{ heading: "Period" }] },
  "/receivables/statements": { ready: [{ role: "button", name: "Run for everyone with a balance" }] },

  // ---- Pattern A: detail pages — the <h1> only exists in the loaded branch --------------------
  "/orders/[id]": { idKey: "order", ready: [{ headingPattern: "^Order #\\d+" }] },
  "/parts/[id]": { idKey: "part", ready: [{ role: "heading", level: 1 }] },
  // /customers/[id] renders NO h1 — its readiness proof is the code field.
  "/customers/[id]": { idKey: "customer", ready: [{ role: "textbox", name: "Customer code" }] },
  "/invoicing/[id]": { idKey: "invoice", ready: [{ headingPattern: "^(Invoice|Credit) " }] },
  "/quotes/[id]": { idKey: "quote", ready: [{ headingPattern: "^Quote #\\d+" }] },
  "/certs/[id]": { idKey: "cert", ready: [{ headingPattern: "^Certification " }] },
  "/shipping/[id]": { idKey: "shipper", ready: [{ headingPattern: "^Packing List " }] },
  "/receivables/batches/[id]": { idKey: "batch", ready: [{ headingPattern: "^Batch #\\d+" }] },
  // /processes/templates/[id] renders no h1 either.
  "/processes/templates/[id]": { idKey: "processTemplate", ready: [{ role: "button", name: "Delete template" }] },
  "/admin/templates/[id]/edit": { idKey: "documentTemplate" },

  // ---- One-offs ------------------------------------------------------------------------------
  // The only screen that must be photographed while SIGNED OUT — captured in its own fresh
  // context before the session cookie exists (see captureLoggedOut()).
  "/login": { loggedOut: true, ready: [{ heading: "Sign in" }] },
  "/setup": { ready: [{ role: "heading", level: 1 }] },
  "/practice": { ready: [{ role: "heading", level: 1 }] },
  "/orders/new": { ready: [{ heading: "New order" }] },
};

/** Generic empty-state vocabulary. Deliberately conservative — a false "empty" reading is a
 *  reported inaccuracy, so these match phrasings the app actually uses. */
const EMPTY_PATTERNS = [
  /\bno [a-z ]{0,30}(yet|found|to show|match|in range)\b/i,
  /\bnothing (to (show|display)|shipped|printed)\b/i,
  /\bthere are no\b/i,
];

/** Loading vocabulary — while any of this is visible the screen is not ready to photograph. */
const LOADING_PATTERNS = [/^loading/i, /^checking setup/i, /^please wait/i, /^rendering/i, /^updating/i];

// ---------------------------------------------------------------------------------------------
// Dev server lifecycle — the same shape as run.mjs: a detached process group so webpack's workers
// die with the wrapper, and next's own announced port fallback detected rather than waited out.
// ---------------------------------------------------------------------------------------------
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

function startDevServer() {
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: ERP_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  child.getOutput = () => out;
  return child;
}

function killDevServer(child, timeoutMs = 5000) {
  if (!child || child.killed || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
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

async function waitForServer(url, timeoutMs, devServer) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Next 16 refuses to start a second dev server for the SAME project directory, whatever port
    // it is given — so a free port is not sufficient evidence that it can start. It says so and
    // exits, which would otherwise show up only as a flat 90-second timeout with the reason buried
    // in captured output nobody reads. Surface it, with the fix.
    const alreadyRunning = devServer.getOutput().match(/Another next dev server is already running/);
    if (alreadyRunning) {
      const pid = devServer.getOutput().match(/PID:\s*(\d+)/)?.[1];
      const otherPort = devServer.getOutput().match(/Local:\s*(http:\/\/localhost:\d+)/g)?.pop();
      throw new Error(
        `next dev refuses to start: another dev server is already running for this project ` +
        `directory${pid ? ` (PID ${pid})` : ""}${otherPort ? ` on ${otherPort.replace(/Local:\s*/, "")}` : ""}. ` +
        `Next 16 allows only one per directory regardless of port, so a free port ${PORT} is not ` +
        `enough. Either attach to the running one — MANUAL_BASE_URL=http://localhost:3000 npm run ` +
        `manual:capture — or stop it first${pid ? ` (\`kill ${pid}\`)` : ""}.`,
      );
    }
    const mismatch = devServer.getOutput().match(/Port (\d+) is in use, trying (\d+) instead/);
    if (mismatch) {
      throw new Error(
        `next dev could not bind port ${mismatch[1]} and fell back to ${mismatch[2]} — refusing ` +
        `to capture against the wrong port. Free port ${PORT} (\`fuser -k ${PORT}/tcp\`) and ` +
        `re-run, or set MANUAL_BASE_URL to attach to a server you already have running.`,
      );
    }
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // still booting
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** run.mjs's contract, reused: spawn the tsx script, parse the single JSON line off stdout. */
function runDbScript(command) {
  const args = ["tsx", path.join("e2e", "lib", "manual-ids.ts"), command];
  const out = execFileSync("npx", args, { cwd: ERP_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const line = out.trim().split("\n").filter(Boolean).pop();
  return line ? JSON.parse(line) : null;
}

// ---------------------------------------------------------------------------------------------
// The health probe. One per page; `begin()` opens a fresh recording window so each screen's
// findings are attributed to that screen and not to whatever was still settling from the last one.
// ---------------------------------------------------------------------------------------------
function createProbe(page, baseURL) {
  let win = null;
  let inFlight = 0;
  let lastQuietAt = Date.now();

  const sameOrigin = (url) => url.startsWith(baseURL);
  const apiPath = (url) => {
    if (!sameOrigin(url)) return null;
    const p = url.slice(baseURL.length).split("?")[0];
    return p.startsWith("/api/") ? p : null;
  };
  const record = (bucket, text) => {
    if (!win) return;
    if (isNoise(text)) win.filtered.push(text);
    else win[bucket].push(text);
  };

  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    record(type === "error" ? "consoleErrors" : "consoleWarnings", msg.text());
  });

  // An uncaught exception in the page is always a real defect — never filtered as noise.
  page.on("pageerror", (err) => {
    if (win) win.pageErrors.push(String(err?.message ?? err));
  });

  page.on("request", () => { inFlight += 1; });
  const settle = () => {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) lastQuietAt = Date.now();
  };
  page.on("requestfinished", settle);

  page.on("requestfailed", (req) => {
    settle();
    record("failedRequests", `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown"}`);
  });

  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();
    const api = apiPath(url);
    if (api && win) win.apiRequests.push({ method: res.request().method(), path: api, status });
    if (status >= 400 && sameOrigin(url)) {
      record("failedRequests", `${res.request().method()} ${url.slice(baseURL.length)} — HTTP ${status}`);
    }
  });

  return {
    begin() {
      win = {
        consoleErrors: [], consoleWarnings: [], pageErrors: [],
        failedRequests: [], apiRequests: [], filtered: [],
      };
      inFlight = 0;
      lastQuietAt = Date.now();
      return win;
    },
    end() {
      const done = win;
      win = null;
      return done;
    },
    isQuiet() {
      return inFlight === 0 && Date.now() - lastQuietAt >= QUIET_MS;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------------------------
/**
 * "Is this visible within `ms`?" — as a genuine WAIT, returning a boolean.
 *
 * `locator.isVisible({ timeout })` looks like this but is not: it is a SNAPSHOT, and the timeout
 * option does not make it wait (the same trap `e2e/lib/ui.mjs`'s `waitForValue` docblock records
 * for `inputValue()`). Every use of it here was a live bug. The apply panel's candidate grid was
 * reported as "no candidates" because the check ran while the grid was still fetching; and — far
 * worse — the order-entry draft guard would have concluded "no draft is open" if the banner took
 * one render tick to appear, which is exactly the case where it must conclude the opposite and
 * refuse to type. A guard that fails OPEN is not a guard.
 */
async function visibleWithin(locator, ms) {
  try {
    await locator.first().waitFor({ state: "visible", timeout: ms });
    return true;
  } catch {
    return false;
  }
}

/** Turns one declarative readiness descriptor into a Playwright locator. */
function locatorFor(page, desc) {
  if (desc.heading) return page.getByRole("heading", { name: desc.heading, exact: true });
  if (desc.headingPattern) return page.getByRole("heading", { name: new RegExp(desc.headingPattern) });
  if (desc.text) return page.getByText(desc.text, { exact: false });
  if (desc.role) {
    const opts = {};
    if (desc.name) opts.name = desc.name;
    if (desc.level) opts.level = desc.level;
    return page.getByRole(desc.role, opts);
  }
  return null;
}

/**
 * Waits until a screen is genuinely ready to photograph rather than merely navigated: its declared
 * anchors present, no loading text still on screen, the page's own API calls quiet, and `main`
 * carrying real text. Returns a note describing HOW it resolved, which goes into the sweep — a
 * screen that only nearly settled is then visible in the report instead of quietly producing a
 * half-loaded picture.
 */
async function waitForContent(page, probe, ready = []) {
  const notes = [];

  for (const desc of ready) {
    if (desc.api) continue; // handled by the pre-armed response waits in capture()
    const loc = locatorFor(page, desc);
    if (!loc) continue;
    try {
      await loc.first().waitFor({ state: "visible", timeout: CONTENT_TIMEOUT_MS });
    } catch {
      notes.push(`anchor not found: ${JSON.stringify(desc)}`);
    }
  }

  const deadline = Date.now() + CONTENT_TIMEOUT_MS;
  let lastReason = "not evaluated";
  for (;;) {
    const state = await page.evaluate(({ loadingSources }) => {
      const main = document.querySelector("main") ?? document.body;
      const text = main.innerText ?? "";
      // A leaf element (no element children) whose whole text is a loading phrase and which is
      // actually laid out on screen. Restricting to leaves stops a container that merely CONTAINS
      // the word from matching; the length cap stops a paragraph that mentions it in prose.
      const stillLoading = [...main.querySelectorAll("*")].some((el) => {
        if (el.children.length > 0) return false;
        const t = (el.textContent ?? "").trim();
        if (!t || t.length > 40) return false;
        if (!loadingSources.some((re) => new RegExp(re, "i").test(t))) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return { hasText: text.trim().length > 20, stillLoading, chars: text.trim().length };
    }, { loadingSources: LOADING_PATTERNS.map((re) => re.source) }).catch(() => null);

    if (state && state.hasText && !state.stillLoading && probe.isQuiet()) {
      notes.push(`settled (${state.chars} chars of content)`);
      return { ready: true, notes };
    }
    lastReason = !state
      ? "page evaluate failed"
      : state.stillLoading
        ? "a loading indicator was still visible"
        : !state.hasText
          ? "main had no meaningful text"
          : "network still active";

    if (Date.now() > deadline) {
      notes.push(`TIMED OUT after ${CONTENT_TIMEOUT_MS}ms — ${lastReason}`);
      return { ready: false, notes };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * The app's own global banners ride above the shell on EVERY screen, so they land in every single
 * screenshot. They are real application state — unlike Next's dev badge, which this harness hides —
 * so they are deliberately left in the pictures and reported here instead, once, at the top of the
 * sweep: a red "backup folder could not be read" strip across all 45 manual figures is something
 * the owner should get to decide about before publication, not something a capture tool should
 * quietly paint out.
 */
function readGlobalBanners(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    // Match the STRIP, not its text node: these banners centre their text in a flex row, so the
    // <span> carrying the words is only as wide as the words and would fail a full-bleed test that
    // the banner itself passes.
    const candidates = [...document.querySelectorAll("body *")].filter((el) => {
      if (main && main.contains(el)) return false;
      // The sidebar brand and the nav links also live outside <main> and also sit near the top —
      // furniture, not banners, so they are excluded structurally.
      if (el.closest("nav, aside, header, form")) return false;
      const r = el.getBoundingClientRect();
      if (r.top > 220 || r.height === 0 || r.height > 80) return false;
      if (r.width < window.innerWidth * 0.6) return false;
      const t = (el.innerText ?? el.textContent ?? "").trim();
      return t.length > 0 && t.length <= 220;
    });
    // Keep only the innermost qualifying element of each nest, so a wrapper does not report the
    // same banner a second time.
    const strips = candidates.filter((el) => !candidates.some((o) => o !== el && el.contains(o)));
    const seen = new Map();
    for (const el of strips) {
      const text = (el.innerText ?? el.textContent ?? "").trim().replace(/\s+/g, " ");
      if (!seen.has(text)) seen.set(text, getComputedStyle(el).backgroundColor);
    }
    return [...seen.entries()].map(([text, bg]) => ({ text, bg }));
  }).catch(() => []);
}

/** Reads the screen once and decides whether it shows real content or an empty state. */
function classifyContent(page) {
  return page.evaluate(({ emptySources }) => {
    const main = document.querySelector("main") ?? document.body;
    const text = (main.innerText ?? "").trim();
    const dataRows = main.querySelectorAll("table tbody tr").length;
    const hit = emptySources.map((re) => new RegExp(re, "i")).find((re) => re.test(text));
    return { dataRows, chars: text.length, emptyPhrase: hit ? (text.match(hit)?.[0] ?? null) : null };
  }, { emptySources: EMPTY_PATTERNS.map((re) => re.source) })
    .catch(() => ({ dataRows: 0, chars: 0, emptyPhrase: null }));
}

/** Photographs the current page. Full-page by default; clipped (and flagged) past MAX_SHOT_HEIGHT
 *  so one enormous seeded list cannot produce a 40-megapixel PNG. */
/**
 * Next's dev-tools badge — the floating circle it injects bottom-left — is dev-server chrome, not
 * application UI: it does not exist in the production build the shop will run, and it sits on top
 * of the nav in every single capture. Hiding it is therefore a correction, not a retouch. Note the
 * contrast with the app's OWN banners (setup / default password / backup folder), which are real
 * application state and are deliberately left in the pictures and reported in the sweep.
 *
 * Re-applied per shot rather than once: a style tag does not survive a navigation.
 */
const DEV_CHROME_CSS = "nextjs-portal, #__next-build-watcher, [data-nextjs-toast] { display: none !important; }";

async function shoot(page, name) {
  const file = path.join(IMG_DIR, `${name}.png`);
  await page.addStyleTag({ content: DEV_CHROME_CSS }).catch(() => {});
  const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
  const clipped = height > MAX_SHOT_HEIGHT;
  if (clipped) {
    // `fullPage: true` is load-bearing, NOT redundant with the clip. A `clip` on its own is
    // resolved against the VIEWPORT, so this branch used to write a 1440x900 shot of the top of
    // the screen while sweep.md reported "clipped to the top 6000px" — a generated report
    // asserting something untrue. With fullPage the clip is resolved against the whole scrollable
    // page, which is what MAX_SHOT_HEIGHT has always claimed to mean.
    await page.screenshot({
      path: file,
      fullPage: true,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: MAX_SHOT_HEIGHT },
    });
  } else {
    await page.screenshot({ path: file, fullPage: true });
  }
  const bytes = await stat(file).then((s) => s.size).catch(() => 0);
  return { image: path.posix.join("img", `${name}.png`), clipped, height, bytes };
}

// ---------------------------------------------------------------------------------------------
// One screen: navigate, settle, classify, photograph, and record everything observed.
// ---------------------------------------------------------------------------------------------
async function capture(page, probe, { name, url, label, ready = [], kind = "screen" }) {
  const win = probe.begin();
  const started = Date.now();
  const row = { name, url, label, kind };

  // Response waits must be ARMED BEFORE the navigation that triggers them.
  const apiWaits = ready.filter((d) => d.api).map((d) =>
    page.waitForResponse(
      (res) => {
        try {
          return new URL(res.url()).pathname.startsWith(d.api) && res.request().method() === "GET" && res.ok();
        } catch {
          return false;
        }
      },
      { timeout: CONTENT_TIMEOUT_MS },
    ).then(() => null).catch(() => `expected API not seen: GET ${d.api}`),
  );

  try {
    if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: CONTENT_TIMEOUT_MS });
    const apiNotes = (await Promise.all(apiWaits)).filter(Boolean);
    const settled = await waitForContent(page, probe, ready);
    row.loadMs = Date.now() - started;
    row.ready = settled.ready;
    row.notes = [...apiNotes, ...settled.notes];

    const content = await classifyContent(page);
    row.dataRows = content.dataRows;
    row.chars = content.chars;
    // Two distinct un-usable-screenshot conditions, tracked separately because they mean different
    // things: `isEmpty` is the screen SAYING it has nothing ("No shipments yet"), while `isThin` is
    // a screen that rendered no table rows and barely any text without admitting to an empty state.
    // Both are almost always a dataset gap rather than a fault, which is why neither gates the run —
    // but both are a picture the manual cannot use, so both get their own section in the report.
    row.isEmpty = Boolean(content.emptyPhrase && content.dataRows === 0);
    row.isThin = !row.isEmpty && content.dataRows === 0 && content.chars <= 200;
    row.emptyPhrase = content.emptyPhrase ?? null;
    row.content = row.isEmpty
      ? `empty state — "${content.emptyPhrase}"`
      : content.dataRows > 0
        ? `content (${content.dataRows} table row(s))`
        : content.chars > 200 ? "content (no table)" : "sparse";

    Object.assign(row, await shoot(page, name));
  } catch (err) {
    row.loadMs = row.loadMs ?? Date.now() - started;
    row.error = String(err?.message ?? err);
    row.ready = false;
    row.content = "ERRORED";
    row.notes = [...(row.notes ?? []), `capture threw: ${row.error}`];
    // Photograph the failure anyway — a picture of what went wrong is worth more than nothing.
    await shoot(page, name).then((s) => Object.assign(row, s)).catch(() => {});
  } finally {
    const w = probe.end() ?? win;
    row.apiRequests = w.apiRequests;
    row.consoleErrors = w.consoleErrors;
    row.consoleWarnings = w.consoleWarnings;
    row.pageErrors = w.pageErrors;
    row.failedRequests = w.failedRequests;
    row.filtered = w.filtered;
  }

  const bad = row.consoleErrors.length + row.pageErrors.length + row.failedRequests.length;
  const mark = row.error ? "ERROR" : bad > 0 ? "FAIL " : row.ready ? "ok   " : "warn ";
  console.log(`  ${mark} ${name.padEnd(34)} ${String(row.loadMs).padStart(6)}ms  ${row.content ?? ""}`);
  return row;
}

/** Records a screen that could not be captured at all, so the report never silently omits one. */
function skipRow(name, url, label, reason) {
  console.log(`  SKIP  ${name.padEnd(34)}         ${reason}`);
  return {
    name, url, label, kind: "screen", skipped: reason, content: "SKIPPED",
    apiRequests: [], consoleErrors: [], consoleWarnings: [], pageErrors: [],
    failedRequests: [], filtered: [], notes: [reason],
  };
}

// ---------------------------------------------------------------------------------------------
// Interaction captures. Each is bounded, documented, and refuses rather than guesses when the
// dataset cannot support it.
// ---------------------------------------------------------------------------------------------

/**
 * 1. Order entry with lines filled, AND the §5.16 disabled-with-reason control.
 *
 * Both come off `/orders/new`, in that order: §5.16 first because it needs the form BLANK (the
 * Certification checkbox is disabled with `title="Pick a lead part first"` until a lead part
 * resolves), the filled form second.
 *
 * The write this makes and how it is handled: any edit to this form schedules a 2-second draft
 * autosave (PUT /api/order-drafts). An untouched blank form never writes (the service's own
 * isDraftEmpty guard). So the harness checks for a pre-existing draft banner BEFORE typing: if one
 * is already there it belongs to a real person, and the harness refuses to type at all rather than
 * risk discarding their work. Otherwise any draft that exists afterwards is its own, and it
 * discards exactly that one.
 */
async function captureOrderEntry(page, probe, ids, rows) {
  const url = `${BASE_URL}/orders/new`;

  // --- §5.16, on the blank form -------------------------------------------------------------
  rows.push(await capture(page, probe, {
    name: "interaction-disabled-with-reason",
    url,
    kind: "interaction",
    label: "§5.16 — a control disabled with its reason on screen (blank order entry)",
    ready: [{ heading: "New order" }],
  }));

  // A native `title` tooltip is drawn by the browser chrome, OUTSIDE the page, so it can never
  // appear in a screenshot — hovering is still worth doing (it proves the control is reachable and
  // the tooltip is armed), and the tooltip TEXT is recorded as data in the sweep instead. The
  // reason is also rendered as visible on-screen text here, which is why this is the example
  // chosen: the screenshot is legible without the tooltip.
  const tooltips = [];
  for (const [label, locator] of [
    ["Certification required", page.getByLabel("Certification required")],
    ["Line 1 part", page.getByLabel("Line 1 part", { exact: true })],
  ]) {
    try {
      await locator.first().waitFor({ state: "visible", timeout: 5000 });
      const disabled = await locator.first().isDisabled().catch(() => null);
      const title = await locator.first().getAttribute("title").catch(() => null);
      if (disabled) await locator.first().hover({ timeout: 3000 }).catch(() => {});
      tooltips.push(`\`${label}\` — disabled=${disabled}, title=${title ? `"${title}"` : "(none)"}`);
    } catch {
      tooltips.push(`\`${label}\` — not present on this screen`);
    }
  }
  const lastRow = rows[rows.length - 1];
  lastRow.notes.push(
    "native `title` tooltips are browser chrome and cannot be rendered into a screenshot; " +
    "captured as data instead: " + tooltips.join("; "),
  );

  // --- The filled form ----------------------------------------------------------------------
  // Waits, deliberately: see visibleWithin(). This guard must fail CLOSED — if a draft banner is
  // present at all, the harness must see it and refuse to type.
  const bannerAlreadyThere = await visibleWithin(
    page.getByRole("button", { name: "Discard", exact: true }), 5000);
  if (bannerAlreadyThere) {
    rows.push(skipRow(
      "interaction-orders-new-filled", url,
      "Order entry with lines filled",
      "REFUSED: a saved order draft was already open on this screen when the harness arrived. " +
      "That draft belongs to a real person — typing into the form would overwrite it and " +
      "discarding it would destroy their work. Resume or discard it by hand, then re-run.",
    ));
    return;
  }

  // The pair comes from the PART, never from `ids.customer`: order entry filters the part picker to
  // the chosen customer's parts, so the richest-customer + richest-part combination is usually two
  // different customers and the part option can never appear (it didn't — the first full run failed
  // exactly here, waiting for a Titan Tool & Die part under Midstate Fabricators).
  const part = ids.part;
  if (!part?.data?.partNumber || !part.data.customerCode) {
    rows.push(skipRow(
      "interaction-orders-new-filled", url,
      "Order entry with lines filled",
      "no part with an identifiable customer could be discovered to fill the form with",
    ));
    return;
  }
  const { partNumber, customerCode, customerName } = part.data;

  const win = probe.begin();
  const started = Date.now();
  const row = {
    name: "interaction-orders-new-filled", url, kind: "interaction",
    label: "Order entry with a customer and a part line filled in", notes: [],
  };
  let typed = false;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "New order" }).waitFor({ state: "visible" });

    // The part pickers stay disabled ("Pick a customer first") until a customer is chosen, so the
    // customer combobox genuinely has to go first — and it must be THIS part's customer.
    row.notes.push(`filling with ${customerName} (${customerCode}) / part ${partNumber}`);
    const cust = page.getByLabel("Customer", { exact: true });
    typed = true;
    await cust.click();
    await cust.fill(customerCode);
    await page.getByRole("option", { name: new RegExp(`^${escapeRe(customerCode)}`) })
      .first().click({ timeout: 10000 });

    const p1 = page.getByLabel("Line 1 part", { exact: true });
    await p1.click();
    await p1.fill(partNumber);
    await page.getByRole("option", { name: new RegExp(`^${escapeRe(partNumber)}`) })
      .first().click({ timeout: 10000 });
    await page.getByLabel("Line 1 quantity", { exact: true }).fill("50");

    // The lead line's slate panel — "Rev N — locks at save" (EM DASH) plus the numbered process
    // step list — is an async per-part fetch, and is what makes the screenshot look complete.
    await page.getByText(/Rev \d+ — locks at save/).first()
      .waitFor({ state: "visible", timeout: 15000 })
      .catch(() => row.notes.push("the lead line's revision panel did not resolve"));

    await page.getByLabel("PO number").first().fill("PO-DEMO-4471").catch(() => {});

    const settled = await waitForContent(page, probe, []);
    row.notes.push(...settled.notes);
    row.ready = settled.ready;
    row.loadMs = Date.now() - started;
    const content = await classifyContent(page);
    row.dataRows = content.dataRows;
    row.content = "content (order entry form, filled)";
    Object.assign(row, await shoot(page, row.name));
  } catch (err) {
    row.error = String(err?.message ?? err);
    row.ready = false;
    row.content = "ERRORED";
    row.loadMs = row.loadMs ?? Date.now() - started;
    row.notes.push(`capture threw: ${row.error}`);
    await shoot(page, row.name).catch(() => {});
  } finally {
    const w = probe.end() ?? win;
    Object.assign(row, {
      apiRequests: w.apiRequests, consoleErrors: w.consoleErrors,
      consoleWarnings: w.consoleWarnings, pageErrors: w.pageErrors,
      failedRequests: w.failedRequests, filtered: w.filtered,
    });
  }
  rows.push(row);
  console.log(`  ${row.error ? "ERROR" : "ok   "} ${row.name.padEnd(34)} ${String(row.loadMs).padStart(6)}ms  ${row.content}`);

  // Clean up after ourselves: the autosave that our own typing scheduled.
  if (typed) await discardOwnDraft(page, row);
}

/** Waits out the 2s autosave debounce, reloads, and discards the draft this harness's own typing
 *  created — never one that was already there (the caller has already refused in that case). */
async function discardOwnDraft(page, row) {
  await new Promise((r) => setTimeout(r, DRAFT_AUTOSAVE_MS));
  try {
    await page.goto(`${BASE_URL}/orders/new`, { waitUntil: "domcontentloaded" });
    const discard = page.getByRole("button", { name: "Discard", exact: true }).first();
    if (await visibleWithin(discard, 5000)) {
      await discard.click();
      row.notes.push("cleaned up: discarded the order draft this harness's own typing autosaved");
    } else {
      row.notes.push("no order draft was autosaved by this capture — nothing to clean up");
    }
  } catch (err) {
    row.notes.push(`WARNING: could not discard the draft this capture created: ${String(err)}`);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 2. The apply-payment panel, open.
 *
 * Read-only: the toggle in a payment row expands an `ApplyPanel` below it, and typing into the
 * candidate grid's amount input is local React state. The submit control (also labelled `Apply`)
 * is never pressed, so nothing posts.
 */
async function captureApplyPanel(page, probe, ids, rows) {
  const batch = ids.openBatch ?? ids.batch;
  const name = "interaction-receivables-apply-panel";
  if (!batch) {
    rows.push(skipRow(name, null, "Apply-payment panel open",
      "no receipt batch with a payment on it exists in the database"));
    return;
  }
  const url = `${BASE_URL}/receivables/batches/${batch.id}`;
  const win = probe.begin();
  const started = Date.now();
  const row = { name, url, kind: "interaction", label: `Apply-payment panel open — ${batch.label}`, notes: [] };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /^Batch #\d+/ }).waitFor({ state: "visible", timeout: 20000 });

    // The toggle lives in the payments table and its label flips Apply <-> Hide. Take the FIRST
    // one: with the panel closed every payment row shows `Apply`, so first() is unambiguous, and
    // once it is open that same button reads `Hide`.
    const toggle = page.getByRole("button", { name: "Apply", exact: true }).first();
    await toggle.waitFor({ state: "visible", timeout: 15000 });
    await toggle.click();

    // The panel is identified by its unique `Write-off` column header. Scoping through the header's
    // NEAREST ancestor table matters: the panel is nested inside the payments table, so a plain
    // `table` filter matches both and trips strict mode.
    const panel = page.getByRole("columnheader", { name: "Write-off", exact: true })
      .locator("xpath=ancestor::table[1]");
    const hasPanel = await visibleWithin(panel, 15000);
    if (!hasPanel) {
      row.notes.push(
        "the apply panel opened but showed no candidate invoices — this payer's family has no " +
        "open finalized invoice to apply against, so the grid is its empty state",
      );
    } else {
      // Type an amount into the first candidate so the panel photographs as in-use. Local state
      // only — the panel's own submit button is deliberately never pressed.
      //
      // The selector excludes write-off explicitly. Each candidate row carries BOTH an
      // `<doc> amount` and a `<doc> write-off amount` input, so a `/ amount$/` match is ambiguous:
      // it would resolve by DOM order, i.e. by the current column layout, and would start filling
      // the write-off box the day someone reorders the columns. Writing a number into a write-off
      // field in a screenshot for the manual would be actively misleading about what the panel does.
      const amount = panel.locator("tbody tr").first()
        .locator('input[aria-label$=" amount"]:not([aria-label*="write-off"])').first();
      await amount.fill("100.00").catch(() => row.notes.push("could not type into the amount cell"));
    }

    const settled = await waitForContent(page, probe, []);
    row.notes.push(...settled.notes);
    row.ready = settled.ready;
    row.loadMs = Date.now() - started;
    const content = await classifyContent(page);
    row.dataRows = content.dataRows;
    row.content = hasPanel ? `content (${content.dataRows} row(s), panel open)` : "content (panel open, no candidates)";
    Object.assign(row, await shoot(page, name));
  } catch (err) {
    row.error = String(err?.message ?? err);
    row.ready = false;
    row.content = "ERRORED";
    row.loadMs = row.loadMs ?? Date.now() - started;
    row.notes.push(`capture threw: ${row.error}`);
    await shoot(page, name).catch(() => {});
  } finally {
    const w = probe.end() ?? win;
    Object.assign(row, {
      apiRequests: w.apiRequests, consoleErrors: w.consoleErrors,
      consoleWarnings: w.consoleWarnings, pageErrors: w.pageErrors,
      failedRequests: w.failedRequests, filtered: w.filtered,
    });
  }
  rows.push(row);
  console.log(`  ${row.error ? "ERROR" : "ok   "} ${name.padEnd(34)} ${String(row.loadMs).padStart(6)}ms  ${row.content}`);
}

/**
 * 3. The template editor, showing a section's controls in use.
 *
 * Correction to the brief worth stating plainly: the editor's sections are NOT collapsible — there
 * is no `<details>`/`aria-expanded` control anywhere in it. Every contract section renders as a
 * permanently-open card, so "a section expanded" IS the default state. What this captures instead
 * is the meaningful equivalent: a section's visibility toggled and a field label overridden, with
 * the `Unsaved changes` chip showing, alongside the LOCKED (§5.6) sections that cannot be hidden.
 *
 * The editor only exists for a template with an OPEN DRAFT. The seeded `Standard` templates ship
 * with a single PUBLISHED v1 and no draft, so on a pristine dataset this screen renders "This
 * template has no open draft to edit." Opening a draft is a real mutation, so it is opt-in
 * (MANUAL_OPEN_DRAFT=1) and never assumed.
 */
async function captureTemplateEditor(page, probe, ids, rows) {
  const tpl = ids.documentTemplate;
  const name = "interaction-template-editor";
  if (!tpl) {
    rows.push(skipRow(name, null, "Template editor with a section in use",
      "no document template exists in the database"));
    return;
  }
  const url = `${BASE_URL}/admin/templates/${tpl.id}/edit`;
  const hasDraft = /has a live draft/.test(tpl.why);

  if (!hasDraft && !ALLOW_OPEN_DRAFT) {
    rows.push(skipRow(name, url, `Template editor — ${tpl.label}`,
      "the chosen template has no OPEN DRAFT, and opening one is a database mutation this " +
      "harness will not make unasked. Re-run with MANUAL_OPEN_DRAFT=1 to let it open a draft, " +
      "or open one by hand on /admin/templates first. (The editor screen itself is still " +
      "captured by the route sweep, showing its no-draft state.)"));
    return;
  }

  const win = probe.begin();
  const started = Date.now();
  const row = { name, url, kind: "interaction", label: `Template editor — ${tpl.label}`, notes: [] };
  try {
    if (!hasDraft && ALLOW_OPEN_DRAFT) {
      row.notes.push("MANUAL_OPEN_DRAFT=1: opened a new draft on this template (a real mutation)");
      await page.goto(`${BASE_URL}/admin/templates`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
      await page.getByText(tpl.label.replace(/^Document template "(.*)" .*$/, "$1")).first().click();
      await page.getByRole("button", { name: "Open draft", exact: true }).click({ timeout: 10000 });
    }

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Save draft" })
      .waitFor({ state: "visible", timeout: 20000 });

    // A LOCKED section (§5.6) — its checkbox is disabled and carries a padlock badge whose
    // aria-label starts "locked:". This is the second §5.16-shaped control in the run.
    const locked = page.locator('[aria-label^="locked:"]').first();
    if (await visibleWithin(locked, 5000)) {
      const reason = await locked.getAttribute("aria-label").catch(() => null);
      row.notes.push(`locked element visible — ${reason ?? "(reason unreadable)"}`);
    } else {
      row.notes.push("no locked (§5.6) element was visible on this template's contract");
    }

    // Put a section into a visibly-changed state: untick one free section, then override a field
    // label, so the `Unsaved changes` chip is on screen.
    const boxes = page.getByRole("checkbox", { name: /^Show section / });
    const count = await boxes.count().catch(() => 0);
    let toggled = false;
    for (let i = 0; i < count; i += 1) {
      const box = boxes.nth(i);
      if (await box.isDisabled().catch(() => true)) continue;
      await box.uncheck();
      toggled = true;
      row.notes.push(`unticked "${await box.getAttribute("aria-label")}" to show the changed state`);
      break;
    }
    if (!toggled) row.notes.push("every section on this contract is locked — none could be toggled");

    await page.getByText("Unsaved changes").first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => row.notes.push("the `Unsaved changes` chip did not appear"));

    const settled = await waitForContent(page, probe, []);
    row.notes.push(...settled.notes);
    row.ready = settled.ready;
    row.loadMs = Date.now() - started;
    row.content = "content (template editor, unsaved changes)";
    Object.assign(row, await shoot(page, name));

    // Leave the draft as it was found: the toggle above is local editor state until `Save draft`
    // is pressed, and it never is — so simply navigating away discards it.
    row.notes.push("no save was pressed; the toggled state was local editor state and is discarded on leaving");
  } catch (err) {
    row.error = String(err?.message ?? err);
    row.ready = false;
    row.content = "ERRORED";
    row.loadMs = row.loadMs ?? Date.now() - started;
    row.notes.push(`capture threw: ${row.error}`);
    await shoot(page, name).catch(() => {});
  } finally {
    const w = probe.end() ?? win;
    Object.assign(row, {
      apiRequests: w.apiRequests, consoleErrors: w.consoleErrors,
      consoleWarnings: w.consoleWarnings, pageErrors: w.pageErrors,
      failedRequests: w.failedRequests, filtered: w.filtered,
    });
  }
  rows.push(row);
  console.log(`  ${row.error ? "ERROR" : "ok   "} ${name.padEnd(34)} ${String(row.loadMs).padStart(6)}ms  ${row.content}`);
}

/**
 * 4. A report with filters set and results shown.
 *
 * Pure read. The backlog report has no apply/run button — every filter is wired to state and the
 * effect refetches on change — so the response wait has to be ARMED BEFORE the filter is touched.
 */
async function captureFilteredReport(page, probe, rows) {
  const name = "interaction-reports-backlog-filtered";
  const url = `${BASE_URL}/reports/backlog`;
  const win = probe.begin();
  const started = Date.now();
  const row = { name, url, kind: "interaction", label: "Backlog report with filters set", notes: [] };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Export to Excel" })
      .waitFor({ state: "visible", timeout: 20000 });

    const refetch = (label) => page.waitForResponse(
      (res) => {
        try {
          return new URL(res.url()).pathname === "/api/reports/backlog"
            && res.request().method() === "GET" && res.ok();
        } catch {
          return false;
        }
      },
      { timeout: 20000 },
    ).catch(() => row.notes.push(`no refetch observed after setting ${label}`));

    let wait = refetch("Received from");
    await page.getByLabel("Received from", { exact: true }).fill("2000-01-01");
    await wait;

    // A <select> wrapped in a <label> cannot be reached with getByLabel — Playwright folds every
    // <option>'s text into the computed accessible name — so it is located through the label.
    wait = refetch("Group by");
    await page.locator("label", { hasText: "Group by" }).locator("select")
      .selectOption("customer")
      .catch(() => row.notes.push("could not set the Group by filter"));
    await wait;

    const settled = await waitForContent(page, probe, []);
    row.notes.push(...settled.notes);
    row.ready = settled.ready;
    row.loadMs = Date.now() - started;
    const content = await classifyContent(page);
    row.dataRows = content.dataRows;
    row.content = content.dataRows > 0
      ? `content (${content.dataRows} row(s), grouped by customer)`
      : `empty state — the filtered backlog returned no rows`;
    Object.assign(row, await shoot(page, name));
  } catch (err) {
    row.error = String(err?.message ?? err);
    row.ready = false;
    row.content = "ERRORED";
    row.loadMs = row.loadMs ?? Date.now() - started;
    row.notes.push(`capture threw: ${row.error}`);
    await shoot(page, name).catch(() => {});
  } finally {
    const w = probe.end() ?? win;
    Object.assign(row, {
      apiRequests: w.apiRequests, consoleErrors: w.consoleErrors,
      consoleWarnings: w.consoleWarnings, pageErrors: w.pageErrors,
      failedRequests: w.failedRequests, filtered: w.filtered,
    });
  }
  rows.push(row);
  console.log(`  ${row.error ? "ERROR" : "ok   "} ${name.padEnd(34)} ${String(row.loadMs).padStart(6)}ms  ${row.content}`);
}

// ---------------------------------------------------------------------------------------------
// The sweep report
// ---------------------------------------------------------------------------------------------
function statusOf(row) {
  if (row.skipped) return "SKIPPED";
  if (row.error) return "ERROR";
  if (row.pageErrors.length || row.consoleErrors.length || row.failedRequests.length) return "FAIL";
  if (!row.ready) return "WARN";
  return "PASS";
}

function summariseApis(row) {
  if (!row.apiRequests.length) return "_none_";
  const seen = new Map();
  for (const r of row.apiRequests) {
    const key = `${r.method} ${r.path}`;
    const entry = seen.get(key) ?? { key, statuses: new Map() };
    entry.statuses.set(r.status, (entry.statuses.get(r.status) ?? 0) + 1);
    seen.set(key, entry);
  }
  return [...seen.values()]
    .map((e) => `\`${e.key}\` → ${[...e.statuses.entries()].map(([s, n]) => (n > 1 ? `${s}×${n}` : `${s}`)).join(", ")}`)
    .join("<br>");
}

function bullets(items) {
  return items.length ? items.map((i) => `- ${String(i).replace(/\n/g, " ").slice(0, 400)}`).join("\n") : "";
}

/** One markdown table cell: newlines flattened and pipes escaped, so a stray `|` in an empty-state
 *  phrase or an error message cannot silently shear the table apart. */
const cell = (v) => String(v ?? "—").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const tableRow = (cells) => `| ${cells.map(cell).join(" | ")} |`;

async function writeSweep(rows, meta) {
  const counts = rows.reduce((acc, r) => {
    const s = statusOf(r);
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const totalFiltered = rows.reduce((n, r) => n + r.filtered.length, 0);
  const failing = rows.filter((r) => statusOf(r) === "FAIL" || statusOf(r) === "ERROR");

  const lines = [];
  lines.push("# Screen sweep");
  lines.push("");
  if (meta.partial) {
    lines.push(`> **PARTIAL RUN — do not read this as the sweep.** \`MANUAL_ONLY\` restricted it to`);
    lines.push(`> ${meta.capturedCount} of the app's ${meta.routeCount} routes. Re-run without it for a real sweep.`);
    lines.push("");
  }
  lines.push("Generated by `npm run manual:capture` (`erp/e2e/manual-capture.mjs`) — the same run that");
  lines.push("produces every screenshot in `img/`. It visits every screen the app has, waits for real");
  lines.push("content, photographs it, and records what the browser saw while it did.");
  lines.push("");
  lines.push(`- **Run at:** ${meta.startedAt}`);
  lines.push(`- **Against:** ${meta.baseURL} (${meta.attached ? "attached to a running server" : "a dev server this harness started"})`);
  lines.push(`- **Signed in as:** \`${USERNAME}\``);
  // The scale is stated because it is a contract, not an incidental: it decides the intrinsic
  // width of every PNG here, and tests/manual-artifacts.test.ts pins it FROM those PNGs.
  lines.push(`- **Viewport:** ${VIEWPORT.width}×${VIEWPORT.height} at deviceScaleFactor ${DEVICE_SCALE} — a full-page shot is ${VIEWPORT.width * DEVICE_SCALE}px wide`);
  lines.push(`- **Captures:** full page, clipped to the top ${MAX_SHOT_HEIGHT}px of the page when it is taller than that`);
  lines.push(`- **Routes discovered:** ${meta.routeCount} from \`src/app/**/page.tsx\``);
  lines.push(`- **Wall clock:** ${(meta.durationMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push("| Outcome | Screens | Meaning |");
  lines.push("|---|---:|---|");
  lines.push(`| PASS | ${counts.PASS ?? 0} | rendered real content, clean console, no failed requests |`);
  lines.push(`| WARN | ${counts.WARN ?? 0} | captured, but never fully settled within the timeout |`);
  lines.push(`| FAIL | ${counts.FAIL ?? 0} | a console error, an uncaught page error, or a failed request |`);
  lines.push(`| ERROR | ${counts.ERROR ?? 0} | the capture itself threw — the screen could not be driven |`);
  lines.push(`| SKIPPED | ${counts.SKIPPED ?? 0} | no data in the database to show this screen, or a refused mutation |`);
  lines.push("");
  lines.push(`Of the screens that loaded, **${rows.filter((r) => r.isEmpty).length}** rendered an explicit empty state and`);
  lines.push(`**${rows.filter((r) => r.isThin).length}** rendered almost nothing — listed below, and not counted as failures.`);
  lines.push("");
  lines.push(`**Exit code: ${meta.exitCode}.** The run gates on FAIL and ERROR only. A SKIPPED screen is a`);
  lines.push("statement about the *dataset*, not about the app, so it does not fail the run — but it does");
  lines.push("mean the manual has no picture of that screen, so it is worth clearing before publication.");
  lines.push("");

  if (meta.globalBanners?.length) {
    lines.push("### Banners present in every screenshot");
    lines.push("");
    lines.push("These render above the shell, so they appear in **all** the figures in `img/`. They are");
    lines.push("real application state, so the harness leaves them in the pictures rather than painting");
    lines.push("them out — but they are worth resolving before the manual is published:");
    lines.push("");
    for (const b of meta.globalBanners) lines.push(`- ${cell(b.text)}`);
    lines.push("");
    lines.push("(Next's own dev-tools badge IS hidden — it is dev-server chrome that does not exist in");
    lines.push("the production build, not application state.)");
    lines.push("");
  }

  if (failing.length) {
    lines.push("### Screens needing attention");
    lines.push("");
    for (const r of failing) {
      const known = KNOWN_EXPECTED[r.name];
      lines.push(`- **\`${r.url ?? r.name}\`** — ${[
        r.error ? `capture error: ${r.error}` : null,
        r.pageErrors.length ? `${r.pageErrors.length} uncaught page error(s)` : null,
        r.consoleErrors.length ? `${r.consoleErrors.length} console error(s)` : null,
        r.failedRequests.length ? `${r.failedRequests.length} failed request(s)` : null,
      ].filter(Boolean).join("; ")}`);
      if (known) {
        lines.push(`  - **KNOWN-EXPECTED — ${known.issue}. Do not re-investigate.** ${known.why}`);
      }
    }
    lines.push("");
  }

  // Kept deliberately SEPARATE from the error list above: an empty screen is not a fault, it is a
  // picture the manual cannot use, and it almost always means the dataset is missing rows for that
  // area rather than that the app misbehaved. Mixing the two lists would make a dataset gap look
  // like a bug and a bug look like a dataset gap.
  const empties = rows.filter((r) => r.isEmpty);
  const thins = rows.filter((r) => r.isThin);
  if (empties.length || thins.length) {
    lines.push("### Screens that rendered an EMPTY state");
    lines.push("");
    lines.push("These loaded cleanly — they are not errors — but they have nothing in them, so they are");
    lines.push("not screenshots the manual can use. Each one normally means the demonstration dataset has");
    lines.push("no rows for that area yet. They do **not** fail the run.");
    lines.push("");
    if (empties.length) {
      lines.push("**Said so explicitly** (the screen rendered its own empty-state message):");
      lines.push("");
      for (const r of empties) {
        lines.push(`- **\`${r.url ? r.url.replace(meta.baseURL, "") || "/" : r.name}\`** — ${cell(r.emptyPhrase ?? "empty")}`);
        if (REVIEWED_EMPTY[r.name]) lines.push(`  - _${REVIEWED_EMPTY[r.name]}_`);
      }
      lines.push("");
    }
    if (thins.length) {
      lines.push("**Rendered almost nothing** (no table rows and under 200 characters, without an explicit");
      lines.push("empty state — worth an eye, since a screen can be legitimately sparse, like `/login`):");
      lines.push("");
      for (const r of thins) {
        lines.push(`- **\`${r.url ? r.url.replace(meta.baseURL, "") || "/" : r.name}\`** — ${r.chars ?? 0} characters, no table rows`);
        if (REVIEWED_EMPTY[r.name]) lines.push(`  - _${REVIEWED_EMPTY[r.name]}_`);
      }
      lines.push("");
    }
  }

  const skipped = rows.filter((r) => r.skipped);
  if (skipped.length) {
    lines.push("### Screens not captured");
    lines.push("");
    for (const r of skipped) lines.push(`- **\`${r.url ?? r.name}\`** — ${r.skipped}`);
    lines.push("");
  }

  lines.push("## Every screen");
  lines.push("");
  lines.push("| Screen | Route | Load | Content | Own API calls | Console | Status |");
  lines.push("|---|---|---:|---|---|---|---|");
  for (const r of rows) {
    const console_ = [
      r.pageErrors.length ? `${r.pageErrors.length} page err` : null,
      r.consoleErrors.length ? `${r.consoleErrors.length} err` : null,
      r.consoleWarnings.length ? `${r.consoleWarnings.length} warn` : null,
      r.failedRequests.length ? `${r.failedRequests.length} net fail` : null,
    ].filter(Boolean).join(", ") || "clean";
    lines.push(tableRow([
      r.skipped || !r.image ? r.name : `[${r.name}](${r.image})`,
      `\`${r.url ? r.url.replace(meta.baseURL, "") || "/" : "—"}\``,
      r.loadMs != null ? `${r.loadMs}ms` : "—",
      r.content ?? "—",
      summariseApis(r),
      console_,
      statusOf(r),
    ]));
  }
  lines.push("");

  lines.push("## Detail");
  lines.push("");
  for (const r of rows) {
    const detail = [
      r.label ? `_${r.label}_` : null,
      r.skipped ? `**Not captured.** ${r.skipped}` : null,
      r.clipped ? `**Screenshot clipped** to the top ${MAX_SHOT_HEIGHT}px of a ${r.height}px page.` : null,
      r.bytes ? `Image: \`${r.image}\` (${Math.round(r.bytes / 1024)} KB)` : null,
      r.pageErrors?.length ? `**Uncaught page errors**\n${bullets(r.pageErrors)}` : null,
      r.consoleErrors?.length ? `**Console errors**\n${bullets(r.consoleErrors)}` : null,
      r.failedRequests?.length ? `**Failed requests**\n${bullets(r.failedRequests)}` : null,
      r.consoleWarnings?.length ? `**Console warnings**\n${bullets(r.consoleWarnings)}` : null,
      r.notes?.length ? `**Notes**\n${bullets(r.notes)}` : null,
    ].filter(Boolean);
    if (!detail.length) continue;
    lines.push(`### \`${r.url ? r.url.replace(meta.baseURL, "") || "/" : r.name}\` — ${r.name}`);
    lines.push("");
    lines.push(detail.join("\n\n"));
    lines.push("");
  }

  lines.push("## Filtered dev-server noise");
  lines.push("");
  lines.push(`${totalFiltered} console/network message(s) were attributed to the Next dev server rather than`);
  lines.push("to the application, and excluded from the pass/fail decision. They are listed here rather");
  lines.push("than dropped, because a filter that hides things silently is how a real fault gets missed.");
  lines.push("The patterns are the `NOISE_PATTERNS` constant in `erp/e2e/manual-capture.mjs`:");
  lines.push("");
  lines.push("```");
  for (const re of NOISE_PATTERNS) lines.push(String(re));
  lines.push("```");
  lines.push("");
  const filteredSample = [...new Set(rows.flatMap((r) => r.filtered))].slice(0, 25);
  if (filteredSample.length) {
    lines.push("Distinct messages filtered (first 25):");
    lines.push("");
    lines.push(bullets(filteredSample));
    lines.push("");
  }

  lines.push("## How to re-run this");
  lines.push("");
  lines.push("```bash");
  lines.push("cd erp");
  lines.push("npm run manual:capture                     # starts its own next dev on :3200");
  lines.push("MANUAL_BASE_URL=http://localhost:3000 npm run manual:capture   # attach to a running server");
  lines.push("MANUAL_USER=someone MANUAL_PASS=… npm run manual:capture       # non-default credentials");
  lines.push("MANUAL_OPEN_DRAFT=1 npm run manual:capture # permit opening a template draft (a mutation)");
  lines.push("HEADED=1 npm run manual:capture            # watch it drive");
  lines.push("```");
  lines.push("");
  lines.push("It reads the database only — it creates no fixtures and deletes nothing. Do not use");
  lines.push("`npm run test:e2e` to produce manual screenshots: that harness writes and then reaps its own");
  lines.push("dev-DB fixtures, which would rewrite the demonstration dataset these pictures are taken from.");
  lines.push("");

  await writeFile(SWEEP_FILE, lines.join("\n"), "utf8");
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
const state = { devServer: null, browser: null };
let teardownPromise = null;

function teardown() {
  if (!teardownPromise) {
    teardownPromise = (async () => {
      if (state.devServer) await killDevServer(state.devServer);
      if (state.browser) await state.browser.close().catch(() => {});
    })();
  }
  return teardownPromise;
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.error(`\nReceived ${signal} — shutting down...`);
      teardown().catch(() => {}).finally(() => process.exit(1));
    });
  }
}

/** `/login` is the one screen that has to be photographed signed OUT, so it gets its own context
 *  with no session cookie — taken before the main context ever logs in. */
async function captureLoggedOut(browser, route, rows) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
  context.setDefaultNavigationTimeout(60000);
  context.setDefaultTimeout(45000);
  const page = await context.newPage();
  const probe = createProbe(page, BASE_URL);
  try {
    rows.push(await capture(page, probe, {
      name: route.name,
      url: `${BASE_URL}${route.route}`,
      label: "The sign-in screen, as an operator first sees it",
      ready: ROUTE_PLAN[route.route]?.ready ?? [],
    }));
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const startedAt = new Date();
  const t0 = Date.now();
  const rows = [];
  let globalBanners = [];

  await mkdir(IMG_DIR, { recursive: true });

  const allRoutes = await enumerateRoutes();
  console.log(`Discovered ${allRoutes.length} routes from src/app/**/page.tsx:`);
  for (const r of allRoutes) console.log(`  ${r.route}`);

  const routes = ONLY_ROUTES ? allRoutes.filter((r) => ONLY_ROUTES.has(r.route)) : allRoutes;
  if (ONLY_ROUTES) {
    console.log(`\nMANUAL_ONLY is set — capturing ${routes.length} of ${allRoutes.length} route(s). ` +
      `This is a PARTIAL run; its sweep does not describe the whole app.`);
    const unknown = [...ONLY_ROUTES].filter((r) => !allRoutes.some((a) => a.route === r));
    if (unknown.length) throw new Error(`MANUAL_ONLY names route(s) that do not exist: ${unknown.join(", ")}`);
  }

  console.log("\nDiscovering example ids from the dev database (read-only)...");
  const ids = runDbScript("discover");
  for (const [key, value] of Object.entries(ids)) {
    console.log(`  ${key.padEnd(18)} ${value ? `${value.label}  [${value.why}]` : "— none found —"}`);
  }

  try {
    if (!ATTACH_URL) {
      if (!(await isPortFree(PORT))) {
        throw new Error(
          `Port ${PORT} is already in use. Free it (\`fuser -k ${PORT}/tcp\`) or set ` +
          `MANUAL_BASE_URL to attach to the server already running there.`,
        );
      }
      console.log(`\nStarting next dev on port ${PORT}...`);
      state.devServer = startDevServer();
      try {
        await waitForServer(`${BASE_URL}/login`, 90000, state.devServer);
      } catch (err) {
        console.error(`--- next dev output ---\n${state.devServer.getOutput()}\n-----------------------`);
        throw err;
      }
      console.log("  dev server is up");
    } else {
      console.log(`\nAttaching to ${BASE_URL} (MANUAL_BASE_URL) — starting no dev server.`);
      await waitForServer(`${BASE_URL}/login`, 30000, { getOutput: () => "" });
    }

    state.browser = await chromium.launch({ headless: !HEADED, handleSIGINT: false, handleSIGTERM: false });

    // Signed-out screens first, in their own cookie-less context.
    console.log("\n=== Signed-out screens ===");
    for (const route of routes.filter((r) => ROUTE_PLAN[r.route]?.loggedOut)) {
      await captureLoggedOut(state.browser, route, rows);
    }

    const context = await state.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
    context.setDefaultNavigationTimeout(60000);
    context.setDefaultTimeout(45000);
    const page = await context.newPage();
    const probe = createProbe(page, BASE_URL);

    console.log(`\nSigning in as ${USERNAME}...`);
    probe.begin();
    await login(page, BASE_URL, USERNAME, PASSWORD);
    probe.end();
    console.log("  signed in");

    globalBanners = await readGlobalBanners(page);
    if (globalBanners.length) {
      console.log(`\n  ${globalBanners.length} global banner(s) will appear in EVERY screenshot:`);
      for (const b of globalBanners) console.log(`    "${b.text}"`);
    }

    console.log("\n=== Screens ===");
    for (const route of routes) {
      const plan = ROUTE_PLAN[route.route] ?? {};
      if (plan.loggedOut) continue;

      let url = `${BASE_URL}${route.route}`;
      if (route.dynamic.length) {
        const chosen = plan.idKey ? ids[plan.idKey] : null;
        if (!chosen) {
          rows.push(skipRow(
            route.name, null, route.route,
            plan.idKey
              ? `no example row was found in the database for \`${plan.idKey}\`, so this screen has no id to open`
              : `dynamic route \`${route.route}\` has no id source configured in ROUTE_PLAN`,
          ));
          continue;
        }
        url = `${BASE_URL}${route.route.replace(/\[[^\]]+\]/, chosen.id)}`;
        rows.push(await capture(page, probe, {
          name: route.name, url, ready: plan.ready ?? [],
          label: `${route.route} — showing ${chosen.label} (${chosen.why})`,
        }));
        continue;
      }

      rows.push(await capture(page, probe, {
        name: route.name, url, ready: plan.ready ?? [], label: route.route,
      }));
    }

    if (RUN_INTERACTIONS) {
      console.log("\n=== Interaction states ===");
      await captureOrderEntry(page, probe, ids, rows);
      await captureApplyPanel(page, probe, ids, rows);
      await captureTemplateEditor(page, probe, ids, rows);
      await captureFilteredReport(page, probe, rows);
    } else {
      console.log("\n=== Interaction states === (skipped: MANUAL_ONLY is set)");
    }

    await context.close().catch(() => {});
  } finally {
    await teardown();
  }

  const failing = rows.filter((r) => statusOf(r) === "FAIL" || statusOf(r) === "ERROR");
  const exitCode = failing.length ? 1 : 0;

  await writeSweep(rows, {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
    baseURL: BASE_URL,
    attached: Boolean(ATTACH_URL),
    routeCount: allRoutes.length,
    capturedCount: routes.length,
    partial: Boolean(ONLY_ROUTES),
    globalBanners,
    exitCode,
  });

  const tally = rows.reduce((acc, r) => {
    const s = statusOf(r);
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\n=== Sweep ===");
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(8)} ${v}`);

  // Reported at the console too, not only in the file: an empty screen means a figure the manual
  // cannot use, and it is the finding most likely to be acted on immediately (by re-seeding).
  const empties = rows.filter((r) => r.isEmpty || r.isThin);
  if (empties.length) {
    console.log(`\n${empties.length} screen(s) rendered an EMPTY or near-empty state — usable as a`);
    console.log("health result, but not as a manual figure (normally a dataset gap, not a fault):");
    for (const r of empties) {
      console.log(`  ${(r.url ? r.url.replace(BASE_URL, "") || "/" : r.name).padEnd(38)} ${r.content}`);
    }
  }
  console.log(`\nScreenshots: ${IMG_DIR}`);
  console.log(`Report:      ${SWEEP_FILE}`);

  if (failing.length) {
    console.error(`\n${failing.length} screen(s) produced a console error, page error or failed request:`);
    for (const r of failing) console.error(`  ${r.name}  (${r.url ?? "—"})`);
    process.exitCode = 1;
  } else {
    console.log("\nNo console errors, page errors or failed requests. Sweep is clean.");
  }
}

installSignalHandlers();
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
