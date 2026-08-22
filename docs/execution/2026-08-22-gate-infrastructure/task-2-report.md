# Task 2 report — Gate infrastructure (#184)

Branch `gate-infrastructure`. All commands from `erp/`.

**Headline: the diagnosis in #184 is wrong, and I can show it.** The issue's hypothesis — `next dev`
cold-compiling inside a flow while the machine recovers from a full vitest run — is not what causes
the false failures. The cause is `net::ERR_NETWORK_CHANGED`: **Chromium aborts every in-flight
request when the host's network configuration changes, and on Linux every container start or stop
creates or destroys a `veth` pair, which is exactly such a change.** It has nothing to do with
Next.js, compilation, or load. §5 below reproduces it against a 30-line static Node server.

All three requested fixes are built anyway — (a) is cheap insurance and (b)/(c) are what made the
real cause visible in the first place. But (a) is not the fix for #184, and the report says so.

---

## 1. The baseline — the measurement that expires

Taken as the first action of the task, ~30 seconds after a full `npx vitest run` finished (208
files, 449 s of saturated CPU), the exact condition #184 says produces false failures.

```
2026-08-22T16:20:10-05:00   start   (load average 2.86, 16 cores)
2026-08-22T16:25:08-05:00   end     exit=0
```

**25 of 25 flows passed, 298 s.** The condition #184 names did **not** reproduce. That is a
negative result, not a refutation — 3-of-4 is not 4-of-4 — but it is the first datum anyone has
taken deliberately, and it is consistent with what §5 goes on to show: the trigger is not the
vitest run, it is whatever else the machine happens to be doing.

The full log was captured to a file and read in full — never piped through `tail`. Summary in §6.

---

## 2. (a) Warming the dev server

### The route set, and how it was chosen

**Enumerated from the filesystem, never hand-listed** — `src/app/**/page.tsx` and
`src/app/**/route.ts`, dynamic segments filled with a literal placeholder. This is
`manual-capture.mjs`'s rule, adopted for the same reason, and it was a decision rather than a
default:

- **A "routes the flows hit" list cannot be assembled honestly.** Grepping `page.goto` over
  `e2e/flows/` yields **58** call sites — but there are **59** more navigations done by clicking a
  link (`getByRole("link", …)`), which no URL grep can resolve, and **every client panel fetches
  API routes no flow names at all**. The part designer's six
  panels — the set that failed *together* in #184's second recorded run — appear in no flow source
  as a URL. A curated list would have missed exactly the routes the issue is about.
- **A hand-list goes stale silently.** A new screen would simply stop being warmed, and the failure
  it reintroduces is the intermittent one this exists to remove.

So the set is *all of them*: **45 pages + 198 API routes = 243**.

### Safety — the warm-up cannot mutate the dev database

| Concern | How it is closed |
|---|---|
| A mutating verb | Every request is a **GET**. A GET on a POST-only route (`/api/orders/[id]/traveler`, `/api/practice/reset`) still compiles the module before Next answers 405. |
| An authenticated write | API routes are sent with **no cookie**, so `requireUser()` — the first statement of the fixed handler shape — throws 401 before anything is parsed. I verified every `route.ts` exporting a `GET` references `requireUser`/`mustCan`/`mustDo`; none does not. |
| A page write | Pages are sent a **deliberately invalid** session cookie. `src/proxy.ts` is a cookie-*presence* redirect, so without one every page 307s to `/login` and compiles nothing; the value matches no `Session` row, so no login happens and no session is created. |
| Following a redirect into an unintended route | `redirect: "manual"`. |

Observed status distribution across a full warm-up: **47 × 200** (45 pages + `/login` twice),
**120 × 401**, **77 × 405**. Zero 2xx on any API route, so zero possibility of a write.

### It warms the client bundles too, not only the server modules

This mattered and was not assumed. After a warm-up, a second fetch of `/parts/[id]` returned in
**116 ms** and all **17** client chunks it references returned in **≤ 14 ms** each. Requesting the
page HTML builds the route's client entry as well as its server one, so a flow's first *browser*
visit pays for nothing.

### Wall time

**25–27 s** for all 243 routes at concurrency 4, reproducible across four measurements
(25.1 s, 26.9 s, 27.3 s, and §6's runs). Concurrency is deliberately small: `next dev` compiles a
few entries in parallel and queues the rest, so more in-flight requests buy nothing and make each
likelier to hit its own timeout — the exact failure being removed.

Reported by the harness on every run:

```
Warming every route so no flow pays for a cold compile...
  warmed 243 routes (45 pages, 198 API) in 27.3s
  slowest: /api/shippers/e2e-warmup/orders/e2e-warmup 1.3s, /api/orders/e2e-warmup/loads/resplit 1.2s, ...
```

**An honest caveat, and the number that undoes #184's hypothesis.** I deleted `.next` (7.3 GB)
and measured the warm-up completely cold: **30.6 s**, against 21–27 s warm. So the warm-up costs
roughly what it front-loads — it is a redistribution, not a saving, and total run wall time barely
moves. What it buys is that no flow pays a first-hit compile *inside its own timeout*.

But the same measurement shows how small that risk ever was. On a **fully cold** `.next` the
slowest single route took **1.14 s** end-to-end (`next.js:` component 1.13 s), and not one of the
243 exceeded 1.2 s. Playwright's timeouts in this harness are **45 s** for a locator and **60 s**
for a navigation. A cold compile is roughly **40× away** from tripping either. #184's hypothesis —
"a first-request compile that would normally take seconds instead exceeds whatever the fetch is
willing to wait for" — is not supported by the measurement. §5 has what is actually happening.

---

## 3. (b) The dev server's output is now an artifact

`e2e-artifacts/dev-server.log`, written on **every** run rather than only when startup times out.

Streamed as the data arrives rather than dumped at teardown, so a run killed harder than SIGTERM,
OOM-killed, or hung still leaves it behind — which is precisely the case #184 left nobody able to
diagnose. Both consumers are kept: the in-memory string still feeds `waitForServer`'s port-fallback
detection and the startup-failure console dump.

It earned its keep immediately. §6's failure was localised to a single request in seconds because
the log shows the server answering **200 in 388 ms** for the very URL the browser recorded as
having received no response at all — which is what proved the fault was between the two, not in
either.

---

## 4. (c) Classification, and a retry only when it is provably safe

### How a failure is classified

**Primarily by what the browser observed, not by the thrown error's text.** In all three of #184's
recorded signatures the thrown error was an ordinary locator timeout: the page rendered, a client
fetch behind a panel got no response, the panel showed "Failed to fetch", and the flow timed out
waiting for content that was never coming. Only a `page.on("requestfailed")` record distinguishes
that from a genuine assertion failure. §6 is exactly this shape.

- `context.on("requestfailed")` — any request that got **no response**. Context-level, not
  page-level, so a popup or second tab is instrumented too.
- `net::ERR_ABORTED` is **excluded**: Chromium reports it for an in-flight fetch superseded by a
  navigation, a cancelled preload, and a navigation that becomes a download (which the print flows
  do repeatedly). Counting it would classify healthy flows as network failures.
- The error text is a secondary signal for the two shapes that leave no `requestfailed` record: a
  transport error Playwright raises directly, and a **navigation** timeout. `page.goto: Timeout
  \d+ms exceeded` is anchored on `page.goto:` deliberately — a *locator* timeout, or a flow's own
  hand-rolled `Timed out waiting for …`, is an assertion failure and must stay one.

### When a retry is allowed

The issue asked for a blind single retry. **A blind retry is not safe here** and is not what
shipped: flows create real orders through the real UI, and `template-build-and-load` leaves a
template three later flows consume, so re-running a flow that failed at step 40 repeats everything
it did in steps 1–39.

Retry once **iff all four** hold:

1. the failure is **network-level**;
2. **`committed == 0`** — no mutating (POST/PUT/PATCH/DELETE) non-session request came back 2xx;
3. **`indeterminate == 0`** — no mutating request is unaccounted for (`attempted − answered`);
4. it is the first attempt.

**Condition 3 is mine, not the brief's, and it is the one a reviewer should look at hardest.** A
mutating request that got *no response* may well have committed server-side before the connection
dropped — and given §5's root cause, a connection dropping mid-POST is the likeliest failure this
harness will ever see. Counting only 2xx responses would have called that case "nothing was
mutated" and retried it. `attempted − answered` also covers a request still in flight at the moment
of failure, whose `response` event may simply not have been delivered yet. Both are the dangerous
direction, and both are closed by the same subtraction.

**`/api/auth/login` and `/api/auth/logout` are excluded** from the count, per the brief: `login()`
POSTs on every attempt and re-logging-in is idempotent; logout only drops the row login just made.

**`ctx.lockRevision` is counted.** It is the one dev-DB write a flow makes *outside* the browser
(revision-cut calls it to stand in for Phase 3's order save) and `page.on("response")` cannot see
it, so it increments `state.outOfBandWrites` and is folded into `committed`. Without this, a
network failure anywhere after that call in `revision-cut` would have looked mutation-free and been
retried.

### How it prints

A retried flow **never** prints as a plain `PASS` — in the per-flow line (`RETRIED-PASS (attempt
2)`) or the summary (`RETRIED  <name>  (attempt 1 failed network-level; attempt 2 passed)`), and a
warning block after the table names every flow that needed one. A refusal states its reason on the
per-flow line and repeats it in the summary. A retry gets its own artifacts directory
(`e2e-artifacts/<flow>__attempt-2/`); attempt 1 keeps the historical path untouched, because the
failed attempt's screenshots and video are the whole reason a retry is reportable at all.

---

## 5. What actually causes #184 — demonstrated, not argued

§6's failure recorded `net::ERR_NETWORK_CHANGED` on a request the **server log shows it answered
200 in 388 ms**. That is not a compile, a timeout, or an app fault: the response was produced and
the browser never got it.

`journalctl -u NetworkManager` for the minutes around it shows a continuous stream of `veth` device
creations on `docker0` — this machine is running another project's Testcontainers-style suite,
which starts and stops throwaway `postgres:16` containers every few seconds. `docker ps` caught two
of them mid-life (`Up Less than a second`).

**Every container start or stop creates or destroys a `veth` pair. That is a network configuration
change. Chromium responds by flushing its socket pools and failing every in-flight request with
`net::ERR_NETWORK_CHANGED` — including requests to `127.0.0.1`, which cannot possibly be affected
by it.**

To make sure this was the mechanism and not a coincidence, I ran a 90-second probe: a **30-line
static Node HTTP server on 127.0.0.1** with a 400 ms delay, hammered by a Playwright Chromium in
batches of 12. No Next.js, no compilation, no database, no load.

```
sent=1380 ok=1344 failed-in-page=36
requestfailed events: 36
by error text: { 'net::ERR_NETWORK_CHANGED': 36 }
2026-08-22T21:45:55.466Z http://127.0.0.1:3399/x6?t=1787435155306 — net::ERR_NETWORK_CHANGED
2026-08-22T21:45:55.466Z http://127.0.0.1:3399/x7?t=1787435155306 — net::ERR_NETWORK_CHANGED
2026-08-22T21:45:55.466Z http://127.0.0.1:3399/x8?t=1787435155306 — net::ERR_NETWORK_CHANGED
2026-08-22T21:45:55.466Z http://127.0.0.1:3399/x9?t=1787435155306 — net::ERR_NETWORK_CHANGED
2026-08-22T21:45:55.466Z http://127.0.0.1:3399/x10?t=1787435155306 — net::ERR_NETWORK_CHANGED
2026-08-22T21:45:55.466Z http://127.0.0.1:3399/x11?t=1787435155306 — net::ERR_NETWORK_CHANGED
```

**2.6 % of requests lost, in simultaneous batches** — six killed in the same millisecond. That is
#184's signature exactly: *"`Failed to fetch` on every panel of the part designer simultaneously"*,
*"`Failed to fetch` and `History could not be loaded` at once"*, and a blank page where the
navigation itself was the casualty.

### What this means for the three fixes

- **(a) warming does not fix #184.** It is worth having — it removes a real (if smaller) source of
  first-hit slowness and it is what CI will need — but it does not touch the cause. Saying otherwise
  would be exactly the papering-over this task exists to stop.
- **(b) and (c) are what found it.** The classification turned an anonymous locator timeout into a
  named transport failure with the URL attached, and the server log proved which side of the wire
  was at fault. That took minutes rather than a re-run.
- **The retry will often, correctly, refuse.** Because a network change lands wherever it lands,
  many of these failures will occur after the flow has already committed something — §6 is one, with
  four mutations behind it. The suite will still go red on those. That is the honest trade the brief
  asked for: a red run that names its cause beats a green one bought by re-running.

The harness now prints a hint naming this cause whenever `ERR_NETWORK_CHANGED` appears, so the next
person does not have to re-derive it.

### Found, not fixed

**A Chromium-level mitigation may exist and I did not ship one.** Since every URL this harness
touches is `localhost`, aborting on a host network change is pure harm, and a launch flag that
suppresses Chromium's network-change notifier would remove the whole class. I did not add one
because I could not confirm a specific switch actually does it, and the prime directive is not to
invent an answer — and because changing browser network behaviour for all 25 flows is a bigger
decision than this task's scope. **Recommended as a follow-up issue**, with the probe in §5 as a
ready-made test harness: it reproduces the fault in 90 seconds and would prove or disprove a candidate
flag immediately.

The operator-side remedy is simpler and worth recording either way: **do not run a
container-churning workload on the same machine as the E2E suite.** This is also a real
consideration for #167's CI job (Task 4) — a CI runner that starts service containers during the
E2E step would hit exactly this.

---

## 6. Every E2E run I did, including the red one

Every run is a **full** `npm run test:e2e`. Nothing was re-run to get a green.

| # | When | Tree | Result | Wall | Note |
|---|---|---|---|---|---|
| 1 | 16:20:10 | **before** (baseline, hot machine) | **25/25 PASS**, exit 0 | 298 s | #184's stated condition did not reproduce |
| 2 | 16:30:34 | after | **24/25, 1 FAIL**, exit 1 | 390 s | `void-shipment`, network-level, correctly not retried |
| 3 | 16:47:55 | after | **25/25 PASS**, exit 0 | 301 s | clean |
| 4 | 16:57 | after + retry injection | **RETRIED**, exit 0 | — | proof, §6.4 |
| 5 | 17:00 | after + post-mutation injection | **FAIL**, exit 1 | — | proof, §6.5 |

Runs 4 and 5 had `FLOWS.length = 1` and a fault injected into `template-build-and-load`; both
edits were reverted and the working tree verified byte-identical to `HEAD` for that flow file
afterwards.

### 6.2 — the red run, diagnosed rather than re-run

```
=== void-shipment (as admin) ===
  FAIL [network]: locator.waitFor: Timeout 45000ms exceeded.
Call log:
  - waiting for getByRole('link', { name: 'Shipping ticket', exact: true }).first() to be visible

    at Module.run (/home/cojoa13/Desktop/HeatSynQ/erp/e2e/flows/void-shipment.mjs:78:82)
  1 request(s) got no response — the network-level evidence for that classification:
    GET http://localhost:3100/api/shippers/cmt4wb3bo00456rijjqorzds4/documents — net::ERR_NETWORK_CHANGED
  not retried: 4 mutating request(s) already committed
```

and the summary line:

```
  FAIL     void-shipment  (network-level; not retried: 4 mutating request(s) already committed)
```

**This is #184 happening, caught by the new instrumentation on its first outing.** Before this
change the same failure would have printed as an unadorned 45 s locator timeout — indistinguishable
from a broken selector, and the reason two implementers each spent a re-run to find out.

The corroborating server-side line from `e2e-artifacts/dev-server.log`:

```
GET /api/shippers/cmt4wb3bo00456rijjqorzds4/documents 200 in 388ms (next.js: 114ms, application-code: 274ms)
```

The server produced the response; the browser never received it. The documents panel therefore
never rendered, the "Shipping ticket" link never appeared, and the flow timed out. The refusal to
retry is correct — the flow had already created and printed a shipment.

**Note the compile timing in that line: 114 ms.** The route was warm, and even cold it would have
been ~1 s. Nothing here is a cold-compile problem.

### 6.4 — the retry proof (verbatim)

Injection, at the top of `template-build-and-load`'s `run()` — after `login()` (a POST that is
excluded by design) and before the flow mutates anything:

```js
  if (!globalThis.__proofRetryOnce) {
    globalThis.__proofRetryOnce = true;
    await page.goto("http://127.0.0.1:3399/dead-port");   // nothing listens
  }
```

```
=== template-build-and-load (as admin) ===
  FAIL [network]: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3399/dead-port
Call log:
  - navigating to "http://127.0.0.1:3399/dead-port", waiting until "load"

    at Module.run (/home/cojoa13/Desktop/HeatSynQ/erp/e2e/flows/template-build-and-load.mjs:18:16)
  1 request(s) got no response — the network-level evidence for that classification:
    GET http://127.0.0.1:3399/dead-port — net::ERR_CONNECTION_REFUSED
  network-level failure with nothing committed — retrying once

=== template-build-and-load (as admin) [attempt 2] ===
  RETRIED-PASS (attempt 2)

=== Results ===
  RETRIED  template-build-and-load  (attempt 1 failed network-level; attempt 2 passed)

1 flow(s) only passed on a retry after a network-level failure: template-build-and-load. The run is
green, but the dev server dropped a request — see .../e2e-artifacts/dev-server.log and the
__attempt-2 artifact directories.

All 1 flows passed.
```

Artifacts, both attempts kept:

```
e2e-artifacts/template-build-and-load/               01-logged-in.png  02-failure.png  video.webm
e2e-artifacts/template-build-and-load__attempt-2/    01-logged-in.png … 05-template-loaded-onto-part.png  video.webm
```

A first pass of this proof used port **9** and produced `net::ERR_UNSAFE_PORT` instead — Chromium
blocks that port outright. It classified as network-level and retried identically, which is
incidental evidence for the design: the decision came from the `requestfailed` record, not from a
hardcoded list of error strings.

### 6.5 — the no-retry proof (verbatim)

Same injection, moved to sit **after** `created.templateIds.push(templateId)` — i.e. after
`POST /api/process-templates` has answered 2xx:

```
=== template-build-and-load (as admin) ===
  FAIL [network]: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3399/dead-port
Call log:
  - navigating to "http://127.0.0.1:3399/dead-port", waiting until "load"

    at Module.run (/home/cojoa13/Desktop/HeatSynQ/erp/e2e/flows/template-build-and-load.mjs:37:16)
  1 request(s) got no response — the network-level evidence for that classification:
    GET http://127.0.0.1:3399/dead-port — net::ERR_CONNECTION_REFUSED
  not retried: 1 mutating request(s) already committed

=== Results ===
  FAIL     template-build-and-load  (network-level; not retried: 1 mutating request(s) already committed)

1 of 1 flow(s) failed.
```

Identical fault, identical classification, opposite decision — and the exit code is 1, not 0.

---

## 7. The other gates

| Gate | Result |
|---|---|
| `node --check e2e/run.mjs` | ok |
| `node --check e2e/lib/warmup.mjs` | ok |
| `npx eslint src tests` | clean |
| `npx eslint e2e` | clean apart from one **pre-existing** warning (`e2e/flows/cert-results-print.mjs:19` unused `order`), untouched by this task |

**`npx eslint src tests` does not lint `e2e/`** — which is the whole of this task's code. That
matters and is easy to miss, so I ran `npx eslint e2e` separately. The eslint config has no
`ignores` for it; it is simply not in the command's path list. Worth considering whether the
documented gate should become `npx eslint src tests e2e`; I did not change it, since the gate
command is stated in `CLAUDE.md` and belongs to the whole repo rather than this task.

`npx vitest run` was **not** run — the controller runs it centrally, per the brief.

---

## 8. Judgement calls a reviewer should look at hardest

1. **The `indeterminate` condition on the retry (`attempted − answered`).** Not asked for. It
   refuses a retry when a mutating request got no response, on the grounds that it may have
   committed before the connection dropped. Given §5's root cause this is not hypothetical — a
   network change killing an in-flight POST is the likeliest failure this harness will see. If a
   reviewer thinks it over-refuses, the alternative is retrying a flow that may have half-written
   an order.
2. **Warming *every* route rather than a subset.** 30.6 s cold, 21–27 s warm, on every run. The
   argument for all-of-them is that any curated set is a hand-list that rots; the argument against
   is that §5 shows the problem it targets is largely imaginary. I kept it because CI (Task 4) is
   the case where a cold compile is genuinely slower, and because a fixed 25 s is cheap next to a
   ~5-minute suite — but it is a defensible thing to challenge.
3. **The page warm-up sends a fake session cookie.** It has to, or the cookie-presence proxy
   compiles nothing. It creates no session and writes nothing, and every API-route request is
   cookie-less so it 401s — but it is the one place this code deliberately walks past an auth gate,
   and it deserves a look.
4. **`net::ERR_ABORTED` is excluded from the network-failure evidence.** Necessary (the print flows
   generate them routinely), but it means a *navigation* killed that way is invisible to the
   `requestfailed` signal — which is why the error-text fallback anchors on `page.goto: Timeout`.
   A reviewer should check I have not left a third shape uncovered.
5. **I did not add a Chromium flag for `ERR_NETWORK_CHANGED`.** See §5 "Found, not fixed". This is
   the one change that would actually close #184, and I deliberately stopped short of guessing at a
   switch. If the owner wants it pursued, the 90-second probe is the test rig.

---

## 9. Found but not fixed

- **The real #184 fix is a Chromium-level mitigation** (§5). Recommended as a follow-up issue.
- **`npx eslint src tests` does not cover `e2e/`** (§7). Every E2E harness change since Phase 1 has
  gone unlinted by the documented gate.
- **`.next` had grown to 7.3 GB** on this machine. Unrelated to this task and harmless, but worth
  knowing before anyone measures disk or wonders why a cold rebuild is rare.
- **`e2e/flows/cert-results-print.mjs:19`** — unused `order` binding, pre-existing lint warning.
