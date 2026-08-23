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

// Derived the SAME way as `SESSION_COOKIE` in src/server/http.ts and src/proxy.ts — all three read
// this one env var (the practice copy sets SESSION_COOKIE_NAME=erp_practice_session), so the only
// thing actually duplicated is the fallback default. That makes THREE hand-synced literals, not the
// two CLAUDE.md's Edge-runtime constraint used to name, and the fix is not to delete this one: a
// shared `src/lib/` leaf would dissolve the very duplication four other modules cite as the
// precedent for their own re-declared literals (`template-contracts/types.ts`'s CONTENT_WIDTH,
// quote.ts/cert.ts/shipper.ts's standing texts, manual-ids.ts's dev-DB guard). So this copy is
// VERIFIED instead of removed: `warmupRefusal` below refuses the run if the cookie fails to defeat
// the proxy redirect, which is what a drift here would look like. Without that check a renamed
// cookie would leave every page 307ing to /login, the warm-up compiling nothing, and fix (a)
// silently doing no work at all.
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
    return {
      route,
      ms: Date.now() - started,
      status: res.status,
      // The cookie self-check's evidence: a page that 3xx'd to /login compiled nothing.
      redirectedToLogin: res.status >= 300 && res.status < 400 &&
        (res.headers.get("location") ?? "").includes("/login"),
    };
  } catch (err) {
    // A warm-up failure is never fatal — the route may simply be slow, and the flow that really
    // needs it has its own (longer) timeout. Recorded so the harness can say so out loud.
    return { route, ms: Date.now() - started, status: null, error: String(err?.message ?? err) };
  }
}

/**
 * The warm-up's own refusal (fix-round finding 4). `warmRoutes` used to compute a `failures` list
 * and return it, and the caller threw it away — so a dev server that died the instant after
 * `waitForServer` produced 243 "not fatal" lines and then 25 flow failures with no named cause.
 * There was also no AGGREGATE deadline: at concurrency 4 the worst case was 243/4 × the 120s
 * per-request timeout, unbounded in practice, where the phase before it had a 60s budget.
 *
 * Pure, and returns the reason rather than throwing, so `tests/e2e-harness.test.ts` can pin the
 * policy and `run.mjs` owns the refusal. FOUR refusals, in the order a run hits them:
 *
 *  - the budget blew, so routes were never issued at all;
 *  - NO route was issued and none was skipped either — the enumeration came back empty, so the
 *    warm-up did nothing whatsoever and said `warmed 0 routes` while the run carried on. That was
 *    the one silent hole left in this policy (whole-branch review, 2026-08-22): every other shape
 *    here refuses, and a phase whose entire job is "compile every route before flow 1" compiling
 *    NOTHING is the most complete failure of it there is. It is not a server fault and must not be
 *    reported as one — `enumerateRoutes` walks a directory, so an empty answer means `appDir` no
 *    longer points at `src/app`;
 *  - most requests failed, so the server is not answering;
 *  - most PAGES 3xx'd to /login, which is what a drift in this file's session-cookie literal looks
 *    like from the outside — the warm-up would otherwise report 45 warmed pages having compiled
 *    none of them.
 *
 * A handful of failures stays NOT fatal, deliberately: one slow route is a slow route, and the
 * flow that really needs it has its own, longer timeout.
 */
export function warmupRefusal({ count, failures, skipped, budgetMs, pages = 0, pagesRedirected = 0 }) {
  const budgetLabel = `${Math.round(budgetMs / 1000)}s`;
  if (skipped > 0) {
    return `the dev-server warm-up blew its ${budgetLabel} budget: ${skipped} of ` +
      `${count + skipped} route(s) were never issued. A server that cannot answer a plain GET per ` +
      `route inside that budget will not survive the flows` +
      (failures.length > 0 ? ` (first failure: ${failures[0].route} — ${failures[0].error})` : "");
  }
  // `skipped > 0` has already returned above, so reaching here with a zero count means nothing was
  // enumerated rather than nothing being reached in time.
  if (count === 0) {
    return `the warm-up issued no requests at all — \`enumerateRoutes\` found no page or API route ` +
      `to warm. That is a harness fault, not a server one: it walks the app directory, so an empty ` +
      `answer means APP_DIR no longer points at src/app (a move, a rename, or a run from the wrong ` +
      `working directory). Every flow would then pay for its own cold compile, which is the whole ` +
      `thing this phase exists to prevent`;
  }
  if (count > 0 && failures.length * 2 > count) {
    return `${failures.length} of ${count} warm-up requests failed — the dev server is up on the ` +
      `port but is not answering. First failure: ${failures[0].route} — ${failures[0].error}`;
  }
  if (pages > 0 && pagesRedirected * 2 > pages) {
    return `${pagesRedirected} of ${pages} warm-up page requests were redirected to /login, so the ` +
      `warm-up compiled almost no pages. The session-cookie name this file sends no longer matches ` +
      `the one src/proxy.ts checks — re-sync SESSION_COOKIE in e2e/lib/warmup.mjs`;
  }
  return null;
}

/**
 * Requests every route once, discarding the answers. Returns timing, the routes that failed and
 * the routes never reached, so the caller can refuse the run (see `warmupRefusal`).
 *
 * `concurrency` is small on purpose: `next dev` compiles a handful of entries in parallel and
 * queues the rest, so piling on more in-flight requests buys nothing and makes each individual
 * one likelier to hit its own timeout — which is the exact failure this is here to remove.
 *
 * `budgetMs` bounds the WHOLE phase, not each request: once it passes, the remaining routes are
 * counted as skipped rather than issued, and each in-flight request's own timeout is clamped to
 * whatever is left of it — so the phase can never overrun its budget, however many routes there
 * are. 240s is ~8x the slowest measurement taken on a completely cold `.next` (30.6s), which
 * leaves real headroom for a CI container without leaving the worst case unbounded.
 */
export async function warmRoutes(baseURL, appDir, {
  concurrency = 4,
  timeoutMs = 120000,
  budgetMs = Number(process.env.E2E_WARMUP_BUDGET_MS ?? 240000),
  log = () => {},
} = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const { pages, apis } = await enumerateRoutes(appDir);
  // Pages first: they are the expensive entries (each pulls in the root layout, the shell, and
  // its whole client component tree) and they are what a flow hits first.
  const queue = [...pages.map((r) => ({ route: r, isPage: true })), ...apis.map((r) => ({ route: r, isPage: false }))];

  const results = [];
  let next = 0;
  let skipped = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= queue.length) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { skipped += 1; continue; }
      results.push(await warmOne(baseURL, queue[i].route, queue[i].isPage, Math.min(timeoutMs, remaining)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  const ms = Date.now() - started;
  const failures = results.filter((r) => r.error);
  const pagesRedirected = results.filter((r) => r.redirectedToLogin).length;
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);

  log(`  warmed ${results.length} routes (${pages.length} pages, ${apis.length} API) in ${(ms / 1000).toFixed(1)}s`);
  if (slowest.length > 0) {
    log(`  slowest: ${slowest.map((r) => `${r.route} ${(r.ms / 1000).toFixed(1)}s`).join(", ")}`);
  }
  if (failures.length > 0) {
    log(`  ${failures.length} route(s) did not answer (not fatal on their own): ` +
      failures.slice(0, 5).map((r) => `${r.route} — ${r.error}`).join(", "));
  }
  if (skipped > 0) log(`  ${skipped} route(s) never issued — the ${Math.round(budgetMs / 1000)}s warm-up budget ran out`);

  return {
    ms,
    count: results.length,
    pages: pages.length,
    apis: apis.length,
    pagesRedirected,
    failures,
    skipped,
    budgetMs,
    slowest,
  };
}
