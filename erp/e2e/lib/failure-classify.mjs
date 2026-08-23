// The E2E harness's decision predicates (#184). Three questions decide whether a red run is
// allowed to become a green one, and all three used to be module-private inside `run.mjs`:
//
//   1. was this failure a transport failure, or an assertion failure?  (`classifyFailure`)
//   2. is retrying this flow safe?                                     (`retryRefusal`)
//   3. can the mutation counters that answer (2) even SEE this write?  (`findRawApiMutations`)
//
// They live here so `tests/e2e-harness.test.ts` can reach them — importing `run.mjs` would start a
// dev server and a browser. Nothing in this file does IO; the caller reads the files and owns the
// refusal.
import assert from "node:assert/strict";

// A `Failed to fetch` with no HTTP status is categorically different from an assertion failure —
// the app returned NOTHING rather than returning something wrong — and printing the two
// identically is what made the honest report ("23 of 24, and I cannot show you a clean run")
// indistinguishable from a careless one.
//
// Classification is driven primarily by what the BROWSER observed, not by the thrown error's text,
// because in all three of #184's recorded signatures the thrown error was an ordinary locator
// timeout: the page rendered, the client fetch behind a panel got no response, the panel showed
// "Failed to fetch", and the flow then timed out waiting for content that was never going to
// arrive. Only a `requestfailed` record distinguishes that from a genuine assertion. The error
// text is a secondary signal for the two shapes that leave no `requestfailed` record: a transport
// error Playwright raises directly (`net::ERR_*`, a dropped socket), and a NAVIGATION timeout —
// `page.goto` waiting out its full 60s is the server failing to answer a page request at all.
// Anchored on `page.goto:` deliberately: a LOCATOR timeout ("Timeout 45000ms exceeded" waiting for
// an element, or a flow's own hand-rolled "Timed out waiting for ...") is an assertion failure and
// must stay one.
export const NETWORK_ERROR_TEXT =
  /net::ERR_|NS_ERROR_|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|page\.goto: Timeout \d+ms exceeded/i;

// `net::ERR_ABORTED` is normal traffic, not a fault: Chromium reports it for an in-flight fetch
// superseded by a navigation, for a cancelled preload, and for a navigation that turns into a
// download (which the print flows do repeatedly). Counting it would classify healthy flows as
// network failures and retry them for no reason.
//
// BOTH SIDES MUST AGREE (fix-round finding 3). The `requestfailed` side dropped it while
// `NETWORK_ERROR_TEXT`'s `net::ERR_` alternation still admitted it, so the one shape that raises
// it as a THROWN error — `page.goto` onto a URL that turns out to be a download, which is
// deterministic and reproducible — classified as network and burned a retry. `looksNetworkFromText`
// strips the token before testing, so a message carrying an aborted navigation AND a real
// transport error still reads as network.
export const IGNORED_REQUEST_FAILURE = /^net::ERR_ABORTED$/;
const ABORTED_TOKEN = /net::ERR_ABORTED/g;

export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
export const NETWORK_CHANGED_HINT =
  "  net::ERR_NETWORK_CHANGED is a HOST-level event, not an app fault: Chromium aborts every\n" +
  "  in-flight request when the machine's network configuration changes, and on Linux each\n" +
  "  container start/stop creates or destroys a veth pair that counts as one. Check whether\n" +
  "  something else on this machine was starting containers (`docker events`) before looking\n" +
  "  for a defect in the flow.";

/** The session endpoints, excluded from the mutation count: `login()` POSTs on every attempt and
 *  re-logging-in is idempotent, and logout only drops the row login just made. */
export function isSessionEndpoint(url) {
  try {
    const { pathname } = new URL(url);
    return pathname === "/api/auth/login" || pathname === "/api/auth/logout";
  } catch {
    return false;
  }
}

function looksNetworkFromText(message) {
  return NETWORK_ERROR_TEXT.test(message.replace(ABORTED_TOKEN, ""));
}

/**
 * "network" or "assertion" for one failed attempt.
 *
 * FINDING 2 (fix round) — the `ERR_ASSERTION` hard override. `netFailures` accumulates for the
 * WHOLE flow, with no time window and no causal link to what actually threw. So one dropped
 * request at step 3 that the app recovered from — on a container-churning host, i.e. exactly the
 * host this instrumentation targets — made a step-40 ASSERTION failure print `FAIL [network]`, and
 * in a flow that had not yet mutated, that was retried into `RETRIED ... exit 0`. That is the
 * precise outcome #184 says the gate must prevent: *"the next person to hit a genuine intermittent
 * will assume the same and push."*
 *
 * 23 of the 25 flows import `node:assert`, and an `AssertionError` carries `code:
 * "ERR_ASSERTION"`. That is a DEFINITIVE "this was never a transport failure": the flow reached
 * the comparison, ran it, and the values disagreed. It therefore overrides the `netFailures`
 * signal outright rather than being weighed against it.
 *
 * NO TIME WINDOW, deliberately. Locator and navigation timeouts stay legitimately ambiguous —
 * #184's own signature is a panel fetch dropped at page load whose only symptom is a locator
 * timeout up to 45s later, so any window narrow enough to exclude a stale netFailure would also
 * exclude the real one, and its width would be an invented constant rather than a measured one.
 * What is left un-caught is bounded by the retry gate itself: a mis-classified assertion failure
 * only reaches green if it ALSO mutated nothing AND passes on the second attempt — a deterministic
 * bug still fails twice and exits 1. The residual (a genuinely flaky assertion in a mutation-free
 * flow) is reported rather than hidden: the harness prints each netFailure with how long before
 * the throw it happened, so a reader can judge the causality the classifier declines to guess at.
 */
export function classifyFailure(error, netFailures = []) {
  if (error?.code === "ERR_ASSERTION" || error instanceof assert.AssertionError) return "assertion";
  if (netFailures.length > 0) return "network";
  return looksNetworkFromText(String(error?.message ?? error ?? "")) ? "network" : "assertion";
}

/**
 * The retry gate. #184 asked for a blind single retry on a network-level failure. A blind retry is
 * NOT safe in this harness: the flows create real orders through the real UI against a real dev
 * database, and `template-build-and-load` leaves behind a template three later flows consume — so
 * re-running a flow that failed at step 40 would repeat everything it did in steps 1–39, and the
 * second attempt's failure would then be the harness's own doing.
 *
 * The retry is safe exactly when the attempt has not yet successfully changed anything, and that
 * is observable rather than assumed: zero mutating requests answered 2xx, zero mutating requests
 * with an unknown outcome, zero out-of-band dev-DB writes. Every signature #184 recorded — a whole
 * page's panels failing at once, a 5 KB blank screenshot — is a first-load failure, which is
 * exactly the case this admits and the case that has nothing to undo.
 *
 * Returns null when a retry is allowed, or the reason it is being refused.
 */
export function retryRefusal(result) {
  if (result.kind !== "network") return `not retried: ${result.kind} failure, not a network-level one`;
  if (result.committed > 0) return `not retried: ${result.committed} mutating request(s) already committed`;
  if (result.indeterminate > 0) {
    return `not retried: ${result.indeterminate} mutating request(s) with an unknown outcome ` +
      `(no response — they may have committed before the connection dropped)`;
  }
  return null;
}

// FINDING 1 (fix round) — what the mutation counters CANNOT see.
//
// `context.on("request")` / `context.on("response")` fire only for requests issued FROM A PAGE.
// A Playwright `APIRequestContext` call — `page.request.patch(...)` — is issued from the
// Playwright process itself and emits NO context event at all (verified empirically: the counters
// are unchanged across one). So a flow can write to the dev DB with `committed` and
// `indeterminate` both reading zero, and be retried from step 1 having already mutated.
//
// `templates-admin.mjs` already had exactly one such call (a competing draft PATCH, deliberate and
// correct in itself). It was latent only because that flow has mutated through the UI long before
// it — and nothing pinned that ordering. The fix is self-enforcing rather than a comment: the
// harness sweeps every flow source at startup and refuses the run on a raw mutating
// APIRequestContext call, so the next one is a decision. `ctx.apiMutate(page, url, opts)` — the
// `ctx.lockRevision` precedent — is the sanctioned way to make one, and IS counted.
//
// Deliberately over-matching, so it fails CLOSED (the `issuesMutatingRequest` precedent in
// tests/audit-children.test.ts): a commented-out call is reported too, because a sweep a comment
// can talk its way past is a sweep a real call can talk its way past.
//
// A raw, uncounted APIRequestContext MUTATION reached by DOT or BRACKET access on `request` —
// `page.request.post(`, `page["request"].delete(`, `context.request.newContext(`. The trailing `\.`
// requires the PROPERTY form, so a response's `res.request()` METHOD call (which ~20 flows use to
// read `res.request().method()`) never matches: `request` there is followed by `(`, not `.`. A
// second APIRequestContext (`newContext`) is folded into the same alternation — it carries its own
// cookie jar and is equally invisible to the counters.
const RAW_API_MUTATION =
  /(?:\brequest\s*\.|\[\s*["']request["']\s*\]\s*\.)\s*(post|put|patch|delete|fetch|newContext)\s*\(/gi;

// #192: the receiver-ALIASING that used to smuggle the same call past the literal-`request` pattern
// above. `const req = page.request; req.post(u)`, `const {post} = page.request; post(u)`, the
// parenthesized `const req = (page.request)`, `return page.request`, `helper(page.request)` — all
// CAPTURE the context under a name (or hand it off) so the mutation later rides that name, invisible
// both to the pattern above and to the browser's request/response counters: the exact state the
// refusal exists to prevent. Rather than enumerate every capture syntax — an assignment-anchored
// pattern missed parens and returns (Codex P1) — this flags the CAPTURE ITSELF: a bare `.request`
// (or `["request"]`) property access NOT continued by `.`, `(`, or `[`. A trailing `.` is an inline
// access (`page.request.get(...)`, a read left alone; `page.request.post(...)`, already caught above);
// a trailing `(` is a `res.request()` method call on a response, not the context. Fail-closed like
// the rest — it flags a captured read-alias, and a comment that writes the bare token, too — so the
// escape is to inline `page.request.get(...)` for a read and `ctx.apiMutate` for a write, and to name
// the API in prose ("the page's request context") rather than write the bare literal in a swept file.
const RAW_API_ALIAS =
  /(?:\.\s*request\b|\[\s*["']request["']\s*\])\s*(?![.([])/g;

/** Every raw, uncounted APIRequestContext mutation in one flow's source, with 1-based line
 *  numbers. Pure: the caller reads the file and raises the refusal. */
export function findRawApiMutations(source) {
  const found = [];
  const scan = (pattern, methodOf) => {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      found.push({
        line,
        method: methodOf(match),
        snippet: source.split("\n")[line - 1].trim().slice(0, 120),
      });
    }
  };
  scan(RAW_API_MUTATION, (m) => m[1].toLowerCase());
  scan(RAW_API_ALIAS, () => "alias");
  return found.sort((a, b) => a.line - b.line);
}

// #190. The two harness OUTPUT surfaces the CI retry gate reads, extracted here so
// tests/e2e-harness.test.ts can pin them against the literal shapes `.github/workflows/ci.yml`
// greps and globs — a rename of either then reds a test rather than silently narrowing that gate to
// the case it happens still to match. `run.mjs` cannot be imported by the test (it starts a dev
// server and a browser at module scope), which is the same reason the decision predicates above live
// here; these two are its printing counterparts.

/** The artifact directory one attempt writes to. Attempt 1 keeps the historical bare `<flow>/` path
 *  so nothing that reads it moves; a granted retry gets its own `<flow>__attempt-N/` sibling — the
 *  surface CI's retry gate globs as `e2e-artifacts/*__attempt-*` (retry detector 1, which fires for
 *  EVERY granted retry, passed or failed). */
export function attemptDir(flowName, attempt) {
  return attempt === 1 ? flowName : `${flowName}__attempt-${attempt}`;
}

/** One results-table row. The verdict token is `RETRIED` (never `PASS`) for a green-on-retry flow —
 *  the exact surface CI greps as `^  RETRIED ` (retry detector 2, the green-on-retry case) — `FAIL   `
 *  for a failure, `PASS   ` otherwise. The two leading spaces and the token width are part of that
 *  contract, so this is the whole printed line, not just the token. */
export function resultsLine(result) {
  const verdict = result.ok ? (result.retried ? "RETRIED" : "PASS   ") : "FAIL   ";
  const note = result.ok
    ? (result.retried ? "  (attempt 1 failed network-level; attempt 2 passed)" : "")
    : `  (${result.kind}-level${result.retried ? ", failed twice" : `; ${retryRefusal(result)}`})`;
  return `  ${verdict}  ${result.name}${note}`;
}
