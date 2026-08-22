// Dev-server warm-up (#184). `next dev` compiles each route on its FIRST hit, and the harness
// previously entered flow 1 having compiled exactly one route: `waitForServer` polls `/login`
// until anything under 500 comes back, so `/login` (plus the root layout it shares) was the only
// thing built. Every other page and every API route was therefore compiled *inside* a flow,
// against whatever load the machine still carried — which is what #184 measured: three false
// failures in four runs, every failing run started straight after a full `npx vitest run`, every
// signature a first-load one (a whole page's panels failing at once, a blank 5 KB screenshot).
//
// So: issue a real request to every route before flow 1 and throw the answers away. The compile
// still costs what it costs, but it is paid outside any Playwright timeout, and the dev-server log
// the harness now writes shows exactly which routes compiled here versus inside a flow.
//
// HOW THE ROUTE SET IS CHOSEN — deliberately NOT a hand-list. It is enumerated from
// `src/app/**/page.tsx` and `src/app/**/route.ts`, the `manual-capture.mjs` rule ("enumerates
// routes from src/app/**/page.tsx, never a hand-list"), for two reasons:
//
//   1. A curated "routes the flows hit" list cannot be derived honestly. Roughly a third of the
//      flows' navigation is a nav/link CLICK rather than a `page.goto`, and every client panel
//      fetches API routes no flow names at all — the part designer's six panels are exactly the
//      set that failed together in #184's second run. A list assembled by grepping `page.goto`
//      would have missed them.
//   2. A hand-list goes stale silently: a new screen would simply stop being warmed, and the
//      failure mode it reintroduces is the intermittent one this exists to remove.
//
// The whole app is ~44 pages and ~198 API routes; warming all of them is not free, but it is not
// *extra* work either — it is the same compilation the flows used to pay for, moved somewhere it
// cannot fail a flow. The harness reports the wall time so a regression in it is visible.
//
// SAFETY — the warm-up must never mutate the dev database:
//   * Every request is a **GET**. A GET against a POST-only route (`/api/orders/[id]/traveler`,
//     `/api/practice/reset`, …) still compiles the module before Next answers 405, which is the
//     entire point, and 405 cannot mutate anything.
//   * API routes are requested with **no cookie at all**, so `requireUser()` — the first statement
//     of the fixed handler shape — throws 401 before anything is parsed or read.
//   * Page routes are requested with a **deliberately invalid** session cookie, because
//     `src/proxy.ts` is a cookie-*presence* redirect: without one, every page 307s to `/login` and
//     compiles nothing. The value corresponds to no `Session` row, so the page's own `requireUser`
//     still refuses — by which time the route module has been compiled, which is all that is
//     wanted. Nothing is written: no login is performed and no session is created.
//   * Redirects are NOT followed (`redirect: "manual"`), so a warm-up request can never land on a
//     route it did not intend to warm.
import { readdir } from "node:fs/promises";
import path from "node:path";

// Kept in sync with `SESSION_COOKIE` in src/server/http.ts and src/proxy.ts, which read the same
// env var (the practice copy sets SESSION_COOKIE_NAME=erp_practice_session).
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? "erp_session";
// Presence is all the Edge proxy checks; this value matches no Session row on purpose.
const WARMUP_COOKIE = `${SESSION_COOKIE}=e2e-warmup-not-a-real-session`;
// Fills `[id]`, `[kind]`, `[versionNumber]`, … — every dynamic segment in the tree is a single
// segment (there are no route groups, parallel routes or catch-alls in src/app), so one literal
// covers all of them. Handlers 401 before they ever look at it.
const DYNAMIC_PLACEHOLDER = "e2e-warmup";

/** Walks `src/app` and returns every routable URL path, dynamic segments filled in. */
export async function enumerateRoutes(appDir) {
  const pages = [];
  const apis = [];

  const walk = async (dir, segments) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), [...segments, entry.name]);
      } else if (entry.name === "page.tsx" || entry.name === "route.ts") {
        const url = "/" + segments
          .map((s) => (s.startsWith("[") ? DYNAMIC_PLACEHOLDER : s))
          .join("/");
        (entry.name === "route.ts" ? apis : pages).push(url === "/" ? "/" : url.replace(/\/$/, ""));
      }
    }
  };

  await walk(appDir, []);
  pages.sort();
  apis.sort();
  return { pages, apis };
}

async function warmOne(baseURL, route, isPage, timeoutMs) {
  const started = Date.now();
  try {
    const res = await fetch(`${baseURL}${route}`, {
      method: "GET",
      redirect: "manual",
      headers: isPage ? { cookie: WARMUP_COOKIE } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body: an un-consumed response holds its socket open, and we want the server to
    // have genuinely finished with this route before the pool moves on.
    await res.arrayBuffer();
    return { route, ms: Date.now() - started, status: res.status };
  } catch (err) {
    // A warm-up failure is never fatal — the route may simply be slow, and the flow that really
    // needs it has its own (longer) timeout. Recorded so the harness can say so out loud.
    return { route, ms: Date.now() - started, status: null, error: String(err?.message ?? err) };
  }
}

/**
 * Requests every route once, discarding the answers. Returns timing and any warm-up-level
 * failures so the caller can report them.
 *
 * `concurrency` is small on purpose: `next dev` compiles a handful of entries in parallel and
 * queues the rest, so piling on more in-flight requests buys nothing and makes each individual
 * one likelier to hit its own timeout — which is the exact failure this is here to remove.
 */
export async function warmRoutes(baseURL, appDir, { concurrency = 4, timeoutMs = 120000, log = () => {} } = {}) {
  const started = Date.now();
  const { pages, apis } = await enumerateRoutes(appDir);
  // Pages first: they are the expensive entries (each pulls in the root layout, the shell, and
  // its whole client component tree) and they are what a flow hits first.
  const queue = [...pages.map((r) => ({ route: r, isPage: true })), ...apis.map((r) => ({ route: r, isPage: false }))];

  const results = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= queue.length) return;
      results.push(await warmOne(baseURL, queue[i].route, queue[i].isPage, timeoutMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  const ms = Date.now() - started;
  const failures = results.filter((r) => r.error);
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);

  log(`  warmed ${results.length} routes (${pages.length} pages, ${apis.length} API) in ${(ms / 1000).toFixed(1)}s`);
  log(`  slowest: ${slowest.map((r) => `${r.route} ${(r.ms / 1000).toFixed(1)}s`).join(", ")}`);
  if (failures.length > 0) {
    log(`  ${failures.length} route(s) did not answer within ${timeoutMs / 1000}s (not fatal): ` +
      failures.slice(0, 5).map((r) => r.route).join(", "));
  }

  return { ms, count: results.length, pages: pages.length, apis: apis.length, failures, slowest };
}
