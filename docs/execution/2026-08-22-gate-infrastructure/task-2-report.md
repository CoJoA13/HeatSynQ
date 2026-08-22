# Task 2 report — Gate infrastructure (#184)

Branch `gate-infrastructure`. All commands from `erp/`.

> **CORRECTED IN THE FIX ROUND — read §10 first.** This section's headline and §5 state the
> diagnosis more firmly than the evidence carries, and §4 advertises a completeness the mutation
> counters did not have. §10 says exactly what was measured and what is inference; the permanent
> docs (`CLAUDE.md`, `docs/HANDOFF.md`) carry the corrected wording, not this one.

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

**`ctx.lockRevision` is counted.** *(Fix round, finding 1: "the one" was FALSE — see §10.1. A `page.request.*` APIRequestContext call emits no `context` event either, and `templates-admin.mjs:164` was already making one. It now goes through the counted `ctx.apiMutate`, and the harness refuses the run on any raw one.)* It is a dev-DB write a flow makes *outside* the browser
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

---

# 10. Fix round — the two Importants and the seven minors

Review round 1 approved the root-cause work and returned two Important findings against the retry
gate's safety claims, plus seven minors. All nine are fixed. The through-line the reviewer named is
the group's own subject: **a check that advertises coverage it does not have** — and two of these
were exactly that, in the code written to stop exactly that.

## 10.1 Important 1 — the mutation counters were blind to `page.request.*`

**The defect.** `context.on("request"/"response")` fires only for requests issued *from a page*.
A Playwright `APIRequestContext` call is issued from the harness process and emits **no context
event at all** — so a flow could write to the dev DB with `committed` and `indeterminate` both
reading zero, and a network failure after it would have been retried from step 1.

`e2e/flows/templates-admin.mjs:164` already made one: `PATCH /api/templates/<id>/draft`, a real
dev-DB write. It was latent only because that flow has mutated through the UI long before it, so
`committed > 0` refused the retry anyway — and **nothing pinned that ordering**.

Worse than the hole was the advertising. Four places asserted the counters were complete: the
`state.outOfBandWrites` comment ("`ctx.lockRevision` is the only out-of-band write"), the runFlow
instrumentation comment ("context-level … so a popup or a second tab is instrumented too"), §4 of
this report, and `CLAUDE.md`. **All four are corrected.**

**The fix, self-enforcing rather than remembered.** Both halves the reviewer asked for:

1. **A startup sweep.** `findRawApiMutations` (`e2e/lib/failure-classify.mjs`, pure) plus
   `assertNoRawApiMutations` (`run.mjs`, the IO) read every `e2e/flows/*.mjs` before flow 1 and
   **refuse the whole run** on a raw mutating `page.request.(post|put|patch|delete|fetch)` — or on
   a second `request.newContext(`, which carries its own cookie jar and is equally invisible.
   Reads (`page.request.get`) are untouched; the flows do those constantly. It deliberately
   over-matches (a commented-out call is reported) so it fails CLOSED — the
   `issuesMutatingRequest` precedent. It costs ~1 second and prints
   `Checked 25 flow file(s) for uncounted APIRequestContext mutations: none`.
2. **`ctx.apiMutate(page, url, { method, data })`**, the `ctx.lockRevision` precedent, for the one
   legitimate call. It increments `indeterminate` **before** the request and only resolves it to
   `committed` on a 2xx — so a call that throws or never answers stays indeterminate, which is the
   direction that must not be guessed at.

`state.outOfBandWrites` (a single number) became `state.outOfBand = { committed, indeterminate }`,
and runFlow diffs both across an attempt.

**Proof it is closed** — a 40-line probe against a static Node server, running the harness's exact
listeners:

```
after page load                    attempted=0 answered=0 committed=0 outOfBand={"committed":0,"indeterminate":0}
after page fetch POST              attempted=1 answered=1 committed=1 outOfBand={"committed":0,"indeterminate":0}
  (raw page.request.patch answered 200)
after raw page.request.patch       attempted=1 answered=1 committed=1 outOfBand={"committed":0,"indeterminate":0}
  (ctx.apiMutate answered 200)
after ctx.apiMutate PATCH          attempted=1 answered=1 committed=1 outOfBand={"committed":1,"indeterminate":0}
```

Line 3 is the defect reproduced: a request that **answered 200** moved no counter. Line 4 is the
fix: the identical call through the wrapper is counted. And the sweep was RED against the live tree
before `templates-admin.mjs` was converted — `tests/e2e-harness.test.ts`'s "every e2e flow is clean
today" case failed with that exact file and line, which is how it was verified rather than argued.

**Also verified, and now stated in the code** (a future reader will ask): `src/` contains no
`navigator.sendBeacon` and registers no service worker, and navigation POSTs and popups genuinely
are covered by the context-level listeners. `page.request.*` was the only escape.

## 10.2 Important 2 — `classifyFailure` could launder an assertion failure into a green `RETRIED`

**The defect.** `netFailures` accumulates for the whole flow, with no time window and no causal link
to what threw, and `classifyFailure` returned `"network"` whenever it was non-empty. So one dropped
request at step 3 that the app recovered from — on a container-churning host, i.e. **exactly the
host this whole fix targets** — made a step-40 *assertion* failure print `FAIL [network]`; and in a
flow that had not yet mutated, the gate then retried it into `RETRIED … exit 0`. That is precisely
what #184 says the gate must prevent.

**The fix.** 23 of the 25 flows import `node:assert`, and an `AssertionError` carries
`code: "ERR_ASSERTION"`. That is a definitive *"this was never a transport failure"* — the flow
reached the comparison, ran it, and the values disagreed — so it **hard-overrides** the
`netFailures` signal rather than being weighed against it. Locator and navigation timeouts keep
their current, legitimately ambiguous treatment.

**Proof it is closed.** Removing that one line reds two cases in `tests/e2e-harness.test.ts`:

```
=== FAULT 1: no ERR_ASSERTION override ===
      Tests  2 failed | 32 passed (34)
```

The two are "is an assertion failure even with a whole flow's worth of dropped requests behind it"
(a real `assert.equal` failure + three netFailures → must be `assertion`) and "stays an assertion
failure when the assertion's own message quotes a network error". A third case in the same block
pins that the override is not a blanket: a genuine `net::ERR_CONNECTION_REFUSED` throw with no
`code` still classifies as network.

**On the time window, which the reviewer asked me to decide rather than default: I did not add one,
and here is why.** #184's own signature is a panel fetch dropped at page load whose only symptom is
a locator timeout up to 45 s later, and a flow that navigates on and *then* waits stretches that
further — so any window narrow enough to exclude a stale netFailure would also exclude the real
one, and its width would be an invented constant rather than a measured one (the prime directive).
What remains un-caught is bounded by the gate itself: a mis-classified assertion failure reaches
green only if it *also* mutated nothing *and* passes on the second attempt, so a deterministic bug
still fails twice and exits 1; the residual is a genuinely flaky assertion in a mutation-free flow.
Rather than guess, the harness now **reports** the causality it declines to infer — every netFailure
prints with how long before the throw it happened, against the attempt's own duration:

```
  3 request(s) got no response during this attempt (47s long) — the network-level evidence, each
  with how long BEFORE the failure it happened:
    -1.2s  GET http://localhost:3100/api/parts/x/prices — net::ERR_NETWORK_CHANGED
```

A reader can then see at a glance whether the evidence is contemporaneous with the failure or a
minute stale.

## 10.3 Minor 3 — `ERR_ABORTED` excluded from the evidence, admitted by the text regex

The `requestfailed` side dropped `net::ERR_ABORTED` (superseded fetches, cancelled preloads,
navigations that become downloads — the print flows generate them routinely) while
`NETWORK_ERROR_TEXT`'s `net::ERR_` alternation still matched it. `page.goto` onto a URL that turns
out to be a download throws exactly that string: deterministic, reproducible, and it burned a retry.
The two sides now agree — the text signal strips the token before testing, so a message carrying an
aborted navigation *and* a real transport error still reads as network. Deleting the strip reds the
regression case (`FAULT 2: … Tests 1 failed | 33 passed`).

## 10.4 Minor 4 — the warm-up's failure signal was computed and thrown away

`warmRoutes` built a `failures` list and `run.mjs` discarded it, so a dev server that died right
after `waitForServer` produced 243 "not fatal" lines and then 25 flow failures with no named cause.
There was also no aggregate deadline: at concurrency 4 the worst case was 243/4 × the 120 s
per-request timeout, where the phase before it had a 60 s budget.

`warmupRefusal` (pure, in `warmup.mjs`, tested) now returns the reason and `run.mjs` raises it.
Three refusals: routes never issued (budget blown), most requests failed, or — see 10.7 — most
*pages* redirected to `/login`. A handful of slow routes stays deliberately not fatal. The budget is
`E2E_WARMUP_BUDGET_MS`, default **240 s** (~8× the 30.6 s measured on a completely cold `.next`,
leaving room for a CI container); once it passes, remaining routes are counted as skipped and each
in-flight request's own timeout is **clamped to what is left of the budget**, so the phase can never
overrun it no matter how many routes there are.

## 10.5 Minor 5 — re-running to see if it clears deleted the evidence

`main()` wiped `ARTIFACTS_DIR` at the start of every run, destroying `dev-server.log` and the
failure screenshots the moment anyone did the thing #184 documents people doing. The previous run is
now **rotated to `e2e-artifacts-prev/`** rather than deleted (added to `.gitignore`) — one
generation, so it cannot grow without bound, and the current run keeps the stable
`e2e-artifacts/<flow>/` paths the docs and the issue both name. It prints
`Previous run's artifacts kept at …` when it rotates.

## 10.6 Minor 6 — the permanent docs stated the diagnosis more firmly than the evidence carries

`docs/HANDOFF.md` and `CLAUDE.md` are rewritten to claim exactly what was measured. What the
evidence supports:

- the mechanism **exists and drops localhost requests on this host** (36 of 1380 in 90 s against a
  static Node server, no Next.js, no compile, no load);
- **one** post-change failure was instrumented as this cause end to end, with the dev-server log
  showing a 200 in 388 ms for the request the browser recorded as unanswered;
- marginal cold compile is **~40× from any timeout** (slowest of 243 routes on a deleted `.next`:
  1.14 s, against 45 s locator / 60 s navigation limits).

What it does **not** support: attributing #184's own four runs to it. **Those runs carry no
`ERR_NETWORK_CHANGED` record, because the instrumentation that would have produced one did not exist
yet** — that attribution is inference, and both documents now say so in those words. The docs also
now rank the arguments honestly: the "simultaneous batches of six" match is the **weakest** of the
three, since six panels first-hitting six cold routes would also fail simultaneously; the
discriminating facts are **rejection-not-slowness** (a slow compile yields a spinner and a locator
timeout, never a rejected fetch promise — and #184's clearest signatures are error *banners*, which
require rejection) and **the 200 that never arrived**. And the residual is recorded: neither
measurement reproduces #184's stated *still-saturated machine* condition — the deliberate baseline
ran at load average 2.86 on 16 cores, already recovered — so the compile hypothesis is refuted on
the numbers available rather than on its own terms.

## 10.7 Minor 7 — the session-cookie literal, and why the third copy was verified rather than deleted

The reviewer's preferred fix was to import the constant from a `src/lib/` leaf. **I did not, and
this is the one place I went against a stated preference, so here is the reasoning.**

Extracting the leaf only removes duplication if `src/server/http.ts` *and* `src/proxy.ts` import it
too — otherwise the leaf is simply a fourth copy. But the SESSION_COOKIE duplication is **load-
bearing precedent**: `template-contracts/types.ts` (CONTENT_WIDTH), `quote.ts`, `cert.ts`,
`shipper.ts` (the standing texts) and `e2e/lib/manual-ids.ts` (the dev-DB guard) each cite it by
name as the reason *they* re-declare a literal rather than import one. Dissolving it would
implicitly re-open five decisions the owner is not in the room for, which the prime directive says
is not mine to do in a fix round.

What the three sites actually share is bigger than the literal: **all three read the same
`SESSION_COOKIE_NAME` env var**, so only the fallback default is duplicated. So the copy is made
**self-verifying** instead of removed, which is strictly better than either option offered — and it
closes a real latent defect found on the way: if the name ever drifts, every page 307s to `/login`,
the warm-up compiles **nothing**, and it still reports "warmed 45 pages". `warmupRefusal` now
refuses the run when most page requests redirect to `/login`, naming the cause. `CLAUDE.md`'s
Edge-runtime constraint is updated from "two literals" to three, with this reasoning.

## 10.8 Minor 8 — nothing guarded the predicates this task turns on

`isSessionEndpoint`, `classifyFailure` and `retryRefusal` were module-private in `run.mjs` and
untestable; the round-1 fault-injection proofs were genuine but were reverted, so nothing guarded
the next edit. They now live in **`e2e/lib/failure-classify.mjs`** — pure, no IO, importable without
starting a dev server — beside `findRawApiMutations`, with **`tests/e2e-harness.test.ts` (34 cases)**
covering all four plus `warmup.mjs`'s `enumerateRoutes` and `warmupRefusal`. It includes the
regression cases for 10.1, 10.2 and 10.3, and one case that is a live guard rather than a unit test:
*"every e2e flow is clean today"* re-runs the raw-mutation sweep over the real `e2e/flows/`
directory, so the check runs centrally in vitest as well as at harness startup.

## 10.9 Minor 9 — the eslint gate now covers `e2e/`

**`npx eslint src tests e2e` is the documented gate**, adopted in the three live places that state
it: `CLAUDE.md`'s Commands block, `.github/workflows/ci.yml`'s Lint step, and
`.claude/skills/gates/SKILL.md`'s chain. The one pre-existing warning it surfaced
(`e2e/flows/cert-results-print.mjs:19`, an unused `order` binding) is fixed in the same change, so
the documented gate is clean from day one. **Not changed, and needing the owner's own hand:**
`.claude/settings.json`'s permission allowlist still holds `Bash(npx eslint src tests)` — a
permission entry is not mine to edit.

## 10.10 Found while verifying: a refused run trampled a RUNNING one

Not a review finding — this fix round's own E2E runs surfaced it, because two harness processes
overlapped on this machine for real.

`main()` did its disk work **before** the port check: `rm -rf` the artifacts (now: rotate them),
then `mkdir`, then check whether port 3100 was free. So a second harness that was about to be
refused had *already* moved the first, still-running, harness's artifacts directory aside — the live
run's open `dev-server.log` file descriptor followed the inode into `e2e-artifacts-prev/`, and its
screenshots kept landing in the renamed directory. Before this round's rotation it was worse: the
refused run `rm -rf`'d a live run's screenshots outright.

**The port check now runs first, before anything on disk is touched**, and its message no longer
suggests `fuser -k` as the first move — it says to check for a live `node e2e/run.mjs` first,
because killing the port out from under a running suite reds every remaining flow with
`ERR_CONNECTION_REFUSED` and is **indistinguishable from a product failure**. That is precisely what
happened here (see §11), and it is exactly the confusion #184 exists to end.

# 11. Every E2E run in the fix round — including the red one

| # | When | Result | Wall | Note |
|---|---|---|---|---|
| F1 | 17:36:33 | **18 of 25 FAILED**, exit 1 | 124 s | **Contaminated by a concurrent harness on the same machine — evidence below.** |
| S | 17:39:33 | 24/25, exit 1 | ~5 min | A sibling agent thread's full run of **this same tree**. Its one failure was an ASSERTION, correctly refused a retry. |
| F2 | 17:44:36 | **25 of 25 PASSED, exit 0** | **317 s** | Clean. Warm-up 21.9 s, zero netFailures, zero retries, sweep clean. |

Plus three fault-injection runs: the startup sweep (§11.3) and the two classifier regressions (§10.2,
§10.3), each reverted and verified byte-identical afterwards.

## 11.1 The red run, and why it is environmental — from the log, not from assumption

F1's failure is **not** `ERR_NETWORK_CHANGED`, not the product, and not this change. It is the
harness being shot in the head by a second harness process, and every step of that is on disk:

1. At 17:36:5x a sibling run was **refused by the port check** while mine held port 3100 — its own
   log says so verbatim: `Error: Port 3100 is already in use — … Free it (`fuser -k 3100/tcp` …)`.
2. The port was then freed at ~17:37:44 — mid-flow, mid-`board-search-scan`. That flow recorded
   **10 requests with `net::ERR_CONNECTION_RESET`, all within the same second**, which is the exact
   signature of a listener disappearing under in-flight connections.
3. **Every one of the 17 flows after it failed identically**, at `login()`'s first `page.goto`, with
   `net::ERR_CONNECTION_REFUSED` — nothing was listening any more. Nine of them were correctly
   retried (nothing committed) and correctly failed twice.
4. A live `node e2e/run.mjs` was still running afterwards whose parent process is this session's own
   CLI — i.e. another agent thread on the same machine, driving the same suite.

The classification behaved exactly as designed throughout: every one of those was named
`FAIL [network]`, `board-search-scan` was **refused a retry** because one mutating request had an
unknown outcome, and the run exited 1. **A red run that names its own cause in one read beats a
green one bought by re-running** — which is the whole of #184.

**The one thing F1 lost was its own dev-server.log**, because the sibling's rotation moved it —
and finding that out is what produced §10.10's port-check fix.

## 11.2 What run S independently corroborates

Run S is a sibling thread's full run of this tree, so it is an independent trial of this fix round's
code:

- `templates-admin` **PASSED** — the flow whose competing draft PATCH now goes through
  `ctx.apiMutate`. The wrapper works against the real route, not only in the probe.
- Its one failure printed `FAIL [assertion]` … `not retried: assertion failure, not a network-level
  one` — the classifier declining to retry a genuine assertion failure, in the wild. See §12.

## 11.3 The startup sweep, RED-verified end to end

A raw `page.request.post` injected into `reports.mjs`, then reverted (byte-identical, `git diff`
empty):

```
Error: 1 raw APIRequestContext call(s) in the flows. Playwright emits NO context request/response
event for these, so the retry gate's mutation counters cannot see them and would happily re-run a
flow that had already written to the dev DB:
  e2e/flows/reports.mjs:29  await page.request.post(`${ctx.baseURL}/api/orders`, { data: {} });
Route a mutating one through ctx.apiMutate(page, url, { method, data }) — which IS counted — or use
page.request.get for a read.
```

Exit 1, in about a second, **before the dev server or the DB fixtures** — a named refusal up front
rather than a wrong retry decision at flow 20.

## 11.4 The other gates

| Gate | Result |
|---|---|
| `npx eslint src tests e2e` (the newly documented form) | **clean** |
| `npx tsc --noEmit` | clean |
| `npx vitest run tests/e2e-harness.test.ts` | **34 passed** |
| `node --check` on all five touched `.mjs` files | ok |
| `npm run test:e2e` | **25/25, exit 0** (F2) |

`npx vitest run` in full was **not** run — the controller runs it centrally, per the brief.

# 12. Found in the fix round, not fixed

- **`invoice-shipped-order:35`'s board-row locator is another ambient-state assertion** — the same
  family as Task 3's `:106`, and it went red for real during this round (in a parallel run of this
  tree, not caused by this change):

  ```
  strict mode violation: locator('tr').filter({ has: getByText('1200', { exact: true }) })
  resolved to 2 elements:  1) row '1200 E2EINVCUST · E2E'   2) row '1193 E2ESHIPCUST · E2E'
  ```

  `assertBoardStatus` filters board rows by the order number's exact text, so it matches any OTHER
  row that happens to carry a cell with the same digits. Order numbers advance every run, so this
  fires whenever one collides — an assertion about ambient state, not about the code under test. It
  belongs with Task 3 (#167a), which is already scoping exactly this kind of assertion. **It also
  classified and behaved correctly**: `FAIL [assertion]` … `not retried: assertion failure, not a
  network-level one`.

- **`.claude/settings.json` still allowlists `Bash(npx eslint src tests)`**, not the newly documented
  `npx eslint src tests e2e`. A permission entry is the owner's to edit, so it is flagged rather
  than changed.

- **The Chromium-level mitigation for `ERR_NETWORK_CHANGED` is still unshipped** (§5 "Found, not
  fixed"), and is still the only change that would actually remove the class. The 90-second probe
  in §5 remains the ready-made rig for proving or disproving a candidate flag.

- **`main()`'s sweep and artifact rotation still run before the DB fixtures**, which is fine, but
  note the rotation happens even on a refused run. Harmless — one generation is still kept — and
  the destructive interaction (a refused run trampling a LIVE one) is closed by the port-check
  reorder in §10.10.
