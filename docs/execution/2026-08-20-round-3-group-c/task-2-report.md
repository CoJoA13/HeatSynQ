# Task 2 — #160, one 404 per signature-less user

**Implementer report.** Branch `round-3-group-c`. Nothing committed; edits left in the working tree
for the controller.

## What changed and why

`/admin/users` fired one `GET /api/admin/users/<id>/signature` per user on every load and took the
404 as its "no signature" answer. With the demonstration dataset's five signature-less users that is
five console errors and five failed requests per visit, which made a completely correct screen the
only FAIL in `npm run manual:capture` — and meant no console/failed-request health gate could ever
be green.

**`erp/src/server/users.ts`** — `listUsers` now selects `signatureMimeType` and returns
`hasSignature: u.signatureMimeType !== null`. This is `templates.ts:505`'s `hasLogo:
v.logoMimeType !== null` copied verbatim in shape and rationale: the mime column stands proxy for
bytes that are only ever written and cleared alongside it. **`signatureImage` is not in the select**,
and the comment above the query says why in the imperative, because the narrowing it protects was
previously guarded by nothing but that comment.

The fidelity note the brief asked for is in the comment: `setSignature` and `clearSignature` always
write both columns together and `getSignature` returns null unless both are non-null, so only a
hand-written database row could desync them — and in that direction the flag reads "no signature"
while GET 404s, which is the harmless side, because the `onError` belt still lands right.

**`erp/src/components/UserSignatureControl.tsx`** — takes `hasSignature: boolean` and seeds
`useState(hasSignature)` instead of `useState(true)`. `onError` is kept, now only as the race belt
(a signature cleared in another tab between the list read and the image request). The docblock
paragraph that justified the optimistic design by the *absence* of this flag is replaced by one that
describes the flag, what the old design cost, and — the part that exists to pre-empt a review round —
that the `TitleCell` keyed-remount precedent is **deliberately not followed**. Keying this control
on `hasSignature` would reset a just-uploaded signature to the page's stale `false`, because the
control's own upload/clear are what move the truth, they move it locally first, and `patch()`'s
reloads are not fired by an upload at all. `<tr key={u.id}>` is stable and the control is unkeyed,
so the seed happens once at mount. The same point is restated as a JSX comment at the call site.

**`erp/src/app/admin/users/page.tsx`** — the hand-maintained local `User` mirror gains
`hasSignature: boolean`, and the prop is threaded. As the brief predicted, omitting the mirror is a
`tsc` failure at the call site; I used that as the gate rather than trusting a grep.

**`erp/e2e/manual-capture.mjs`** — deleted the `KNOWN_EXPECTED["admin-users"]` entry, leaving
`const KNOWN_EXPECTED = {}`. The surrounding docblock gains two sentences saying that empty is the
healthy state and naming what was removed and why, so the next reader does not read the empty object
as a stub. `sweep.md` was **not** hand-edited — it is machine-generated, and that entry was the
source of its `:34` annotation.

**`docs/manual/walkthrough.md`** — the screen figures move to **50 PASS / no FAIL**, and the
sentence keeps the historical fact (the walkthrough *did* find that FAIL) rather than erasing it.
The `#160` row in the "Filed from this walkthrough" table is marked fixed with a one-line
description of the fix.

## TDD — the exact failures observed

Tests went in `erp/tests/user-signature.test.ts` (the brief's "and/or"): the signature fixtures
(`REAL_PNG`, `makeUser`, `asSystem`, `setSignature`/`clearSignature`) all already live there, so the
alternative was duplicating them into `users.test.ts`.

**Red, run 1** — both new cases, before touching `users.ts`:

```
× listUsers' hasSignature flag (#160) > is false on a fresh user, true after setSignature, false again after clearSignature
  → expected undefined to be false // Object.is equality

× listUsers' hasSignature flag (#160) > derives the flag from the mime column — the bytes never leave Postgres
  → expected { id: true, username: true, …(6) } to have property "signatureMimeType" with value true
```

**Green** after the `users.ts` change: `tests/user-signature.test.ts` 17 passed,
`tests/users.test.ts` 12 passed.

### The guard, verified against the regression it exists to catch

The task asked me to prove the byte guard actually bites. I edited `listUsers` to
`select: { signatureImage: true }` + `hasSignature: u.signatureImage !== null` and re-ran:

```
✓ listUsers' hasSignature flag (#160) > is false on a fresh user, true after setSignature, false again after clearSignature
× listUsers' hasSignature flag (#160) > derives the flag from the mime column — the bytes never leave Postgres
  → expected { id: true, username: true, …(7) } to not have property "signatureImage"
```

Then I reverted `users.ts` to the correct implementation and re-confirmed green.

## Brief defect found — the guard the brief specifies does not catch the regression it names

This is the one thing in the brief I found to be wrong, and it is the load-bearing half of the task.

The brief says (lines 125–129): *"assert the listed row has NO `signatureImage` property … an
implementer who derived the flag from `signatureImage: true` would silently reinstate the regression
with every suite green."*

**A returned-row assertion does not catch that.** `listUsers` maps to an explicit object literal, so
`select: { signatureImage: true }` + `hasSignature: u.signatureImage !== null` pulls up to
`SIGNATURE_MAX_BYTES` per row out of Postgres on every page load **while the returned row still has
no `signatureImage` property** — the map never puts it there. The brief's guard would have been
green on exactly the implementation it was written to stop.

I did not reason this from the source; I proved it. With the wrong implementation in place I
reordered my own assertions so the payload checks ran first:

```
      const row = rows.find((u) => u.id === userId)!;
      expect(row.hasSignature).toBe(true);
      expect(row).not.toHaveProperty("signatureImage");      // ← passed
      expect(row).not.toHaveProperty("signatureMimeType");   // ← passed

      expect(selects).toHaveLength(1);
      expect(selects[0]).not.toHaveProperty("signatureImage"); // ← the only assertion that failed
```

The three payload assertions passed; the failure was reported at the SELECT assertion. I then
restored the original order (query shape first, payload second) and the correct implementation.

**So the test I wrote pins the query, not only the payload.** It wraps `prisma.user.findMany` with
plain bound-method save/restore in a `try/finally` — never `vi.spyOn` on a Prisma model delegate
(CLAUDE.md; `tests/request-context.test.ts:16` carries the descriptor rationale, and
`tests/statements.test.ts:300` is the other precedent) — records the `select` argument, and asserts:

- the select has **no** `signatureImage`
- the select **does** have `signatureMimeType: true`
- the returned row has neither property, and `hasSignature` is `true`

The reason both halves are pinned, and the fact that the payload half alone is insufficient, is
written into the test's docblock so the next reader does not "simplify" it back to a shape check.

## Gates

Run from `/home/cojoa13/Desktop/HeatSynQ/erp`, on the private scratch DB
`erp_test_c2` via `DATABASE_URL_TEST` (never `DATABASE_URL` — `tests/helpers/setup.ts:4`
reassigns from it).

| Gate | Result |
|---|---|
| `npx vitest run tests/user-signature.test.ts tests/users.test.ts` | **17 + 12 passed** |
| `npx vitest run … authz, validation, sessions, audit` (the other suites that touch the users route or the signature column) | **48 passed / 6 files** |
| `npx tsc --noEmit` | **exit 0** |
| `npx eslint src tests` | **exit 0** |
| `node --check e2e/manual-capture.mjs` | **exit 0** |
| `npm run manual:capture` | **PASS 50, WARN 0, FAIL 0, ERROR 0, SKIPPED 0 — exit code 0** |

`tsc` and `eslint` ran over the shared working tree, so they also covered Task 1's in-flight files
and were green on the combined state.

I did **not** run the full `npm test` or `npm run test:e2e` — the controller runs those once for
the group.

## Verification — what actually proves this, and what does not

**`npm run manual:capture` ran, and it is the proof.** No vitest case and no Playwright flow can
observe *"a request is not fired"*, and I re-confirmed the brief's negative: grepping `e2e/` for
`admin/users`, `Signature` and `hasSignature` returns `manual-capture.mjs` and nothing else — no
E2E flow exercises this screen at all. `npm run test:e2e` is therefore regression insurance for this
task, not verification of it.

A dev server was already listening on **3000**, and Next 16 permits only one dev server per
directory regardless of port (the harness says so itself at `manual-capture.mjs:367`), so I attached
with `MANUAL_BASE_URL=http://localhost:3000` rather than letting it spawn its own on 3200. The dev
database carries the demonstration dataset (5 users, 50 orders, 9 customers, 18 stored documents),
and all five users have `signatureMimeType IS NULL` — i.e. exactly the five 404s.

I redirected the output tree with `MANUAL_OUT_DIR` into my scratchpad, so **`docs/manual/` is
untouched**: no regenerated screenshots and no regenerated `sweep.md` in the working tree, which is
the decision the controller was told to make. The full 50-screen sweep still ran.

Result: `PASS 50 / FAIL 0 / ERROR 0`, exit code 0, *"No console errors, page errors or failed
requests. Sweep is clean."* The generated `admin-users` row lists only 200s —

```
GET /api/admin/backups/health → 200 · GET /api/auth/me → 200×3 · GET /api/setup/readiness → 200
GET /api/admin/users → 200×2 · GET /api/admin/roles → 200×2                            … clean · PASS
```

— with **no request to the signature route at all**. I also opened the captured screenshot: all
five rows render the "No signature" placeholder with Clear correctly disabled, so the flag is
driving the render and not merely suppressing a fetch.

Note the sweep ran against the **combined** Group C tree (Task 1's finance-charge edits were already
present) and was clean, which is a stronger result than my task alone needed.

### One thing I could not verify in the browser, stated plainly

The `hasSignature: true` render path was **not** exercised against the dev server. No user in the
demonstration dataset has a signature, and setting one would mutate the demonstration dataset
(including minting audit rows) — the harness itself writes nothing to the database precisely so the
pictures stay pictures of that data, and I was not willing to break that for a screenshot. The path
is covered at the service level by the lifecycle test, and the component's `hasImage ? <img> :
placeholder` branch is unchanged from the shipped behaviour (`hasImage` simply used to start `true`
unconditionally), so the true branch is pre-existing code on a pre-existing path.

## Confirmed rather than assumed

- **`QuoteDetail.tsx:249` needs no change.** It fetches the same list as `UserOption[]` through
  `api<T>`, which is a bare `return body as T` (`src/lib/fetcher.ts:20`) — no runtime validation and
  no excess-property check on a cast, so the added field is structurally inert. The sweep's
  `quotes-detail` screen is PASS with `GET /api/admin/users → 200`, so this is confirmed at runtime
  as well as by inspection.
- **`UserSignatureControl` has exactly one call site** (`src/app/admin/users/page.tsx`), so the new
  required prop breaks nothing else.
- **`listUsers` has one non-test caller** (`src/app/api/admin/users/route.ts:9`).
- **No audit wiring.** Verified: the users page mounts no `HistoryPanel`, `hasSignature` is a derived
  projection of an existing column, and there is no new model or child section. No
  `invalidateHistory()`, no `INVALIDATION_SITES` entry.
- **No migration.** `signatureMimeType` already exists on `User`.

## Deliberately not done

- **`docs/manual/sweep.md` not regenerated or edited.** It is machine-generated and the task reserved
  that decision for the controller. **Handoff item:** the committed `sweep.md` still reads
  49 PASS / 1 FAIL and still carries the `#160` KNOWN-EXPECTED annotation at `:34`, so it now
  disagrees with `walkthrough.md`. Regenerating it (`npm run manual:capture` without
  `MANUAL_OUT_DIR`, which also refreshes `docs/manual/img/`) is what makes the two agree. I have a
  clean generated copy at
  `/tmp/claude-1000/-home-cojoa13-Desktop-HeatSynQ/4cd99109-cc27-4723-9480-601227ea39e7/scratchpad/manual-out/`
  if it is useful.
- **`docs/HANDOFF.md` not touched** — the controller owns it. It names #160 twice.
- **`CLAUDE.md` not touched** — no convention changed, exactly as the brief said.
- **No `financeChargeExempt`-style UI writer, no keyed remount, no re-baselining of the control on
  later loads**, per the brief.
- **No git state changed.** No `add`, `commit`, `checkout`, `stash` or branch operation.
