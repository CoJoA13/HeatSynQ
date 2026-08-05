# Task 12 Report — Admin UI: per-user signature upload and typed settings widgets

Branch: `phase-4-certs-shipping`
Commits: `7c1e841` (settings widget fix), `74e0880` (signature upload), `893dc5e` (review fix — sibling-split sweep, see addendum below)

## What was implemented

### Step 0a–0c: settings page renders and submits each setting's real type

- **`erp/src/lib/settings-ui.ts`** (new) — pure, client-safe helpers with no `src/server/**`
  imports:
  - `widgetKindFor(key, value)` — `"checkbox"` for a boolean value, `"select"` for
    `cert_scope_default` specifically, `"textarea"` for `cert_statement` /
    `shipper_liability_text` specifically, `"number"` for a numeric value, `"text"` otherwise.
  - `selectOptionsFor(key)` / `selectLabelsFor(key)` — `CERT_SCOPES` / `CERT_SCOPE_LABELS` for
    `cert_scope_default`, `undefined` for everything else.
  - `coerceForSubmit(kind, raw)` — the actual fix: a checkbox's `raw` (already a JS `boolean`
    from `e.target.checked`) passes through unchanged; a number widget's raw string is
    `Number(...)`'d; select/textarea/text pass their string through unchanged. The old page sent
    `String(value)` for every kind, which is exactly why `cert_required_default` (boolean) and
    `cert_scope_default` (enum) were unusable — `z.boolean()` rejects a string outright.
- **`erp/src/app/admin/settings/page.tsx`** (rewritten) — switches on `widgetKindFor` per row:
  a real `<input type="checkbox">` (controlled, saves on change), a real `<select>` populated
  from `selectOptionsFor`/labelled via `selectLabelsFor` (saves on change), a full-width
  `<textarea rows={6}>` for the two long legal-text keys (saves on blur), and the pre-existing
  `<input>` behavior for everything else (now `type="number"` when the kind is numeric). Also
  gated the whole page on `admin.edit` via `usePermissions`/`gate` (§5.16) — every sibling admin
  screen (roles, part-fields, step-codes) already does this; the settings page previously didn't.

### Steps 1–7: per-user signature upload

- **`erp/prisma/schema.prisma`** — `User` gains `signatureMimeType String?` alongside the
  existing `signatureImage Bytes?`. Migration `20260804221411_user_signature_mime_type` (purely
  additive `ADD COLUMN`), applied to both `erp` and `erp_test` via the `create-migration` skill's
  TTY-less recipe, `migrate status` clean on both.
- **`erp/src/server/users.ts`** — `SIGNATURE_MAX_BYTES = 2 * 1024 * 1024`,
  `SIGNATURE_MIME = ["image/png", "image/jpeg", "image/bmp"]`, and
  `setSignature`/`clearSignature`/`getSignature` exactly matching the brief's interface.
  `setSignature` validates type and size (both refusals name the limit), then
  `auditedUpdate("user", ...)` inside a transaction; no upfront existence check — relies on the
  same P2025→404 path `updateUser` already uses. `new Uint8Array(data)` at the write site
  (Prisma's `Bytes` input wants `Uint8Array<ArrayBuffer>`, Buffer is
  `Uint8Array<ArrayBufferLike>` — the `storeDocument`/`documents.ts` precedent).
  `listUsers()` was also converted from a blanket `include` to an explicit `select` — the old
  `include: { role: true, overrides: true }` pulls every scalar on `User`, meaning every
  admin/users page load and every mutation now would have pulled up to 2 MB of signature bytes
  (and `passwordHash`) into a list that never renders bytes. `activeManageUsersHolders()` has the
  identical latent problem but was left alone (see Concerns) and flagged as a follow-up.
- **`erp/src/server/audit.ts`** — added a `SNAPSHOT_SELECT` entry for `user`, mirroring the
  `partAttachment`/`orderAttachment`/`storedDocument` precedent: an explicit `select` listing
  every scalar except `signatureImage`, plus the `overrides` relation. This means
  `auditedUpdate("user", ...)`'s before/after snapshot never fetches the image bytes in the first
  place — `redact()`'s `"signatureimage"` pattern stays defense-in-depth, not the mechanism relied
  on, per CLAUDE.md.
- **`erp/src/app/api/admin/users/[id]/signature/route.ts`** (new) — `GET` streams the bytes with
  their real content-type or throws `HttpError(404, "No signature on file")`; `PUT` uses
  `parseUploadFile`/`assertDeclaredUploadSize` (the `attachments.ts` precedent) then
  `setSignature`; `DELETE` calls `clearSignature`. All three gated
  `mustDo(requireUser(), "manage_users")`.
- **`erp/src/components/UserSignatureControl.tsx`** (new) — upload/preview/clear widget. A plain
  `<img>` pointed at the GET endpoint (optimistically rendered, `onError` flips to a "No
  signature" fallback on 404 — there is no separate "does a signature exist" flag to check
  first); upload via `fetch(..., { method: "PUT", body: formData })` (not `api()`, which forces a
  JSON content-type); Clear via `fetch(..., { method: "DELETE" })` behind a `confirm()`. Takes a
  `Gate` prop directly (the `DocumentsSection` precedent) so it renders exactly the disabled
  state + tooltip the page's own `gateDo(perms, "manage_users")` computes — never hidden (§5.16).
- **`erp/src/app/admin/users/page.tsx`** — added a "Signature" column mounting
  `UserSignatureControl`, and permission-gated the page via `usePermissions`/`gateDo` (previously
  ungated, unlike its sibling admin pages — though since every verb on this page's own routes
  already requires `manage_users`, a user who can load the page always already holds it; the gate
  is added for consistency/defensive correctness per the brief's explicit instruction, not because
  a reachable disabled state exists today).

## Tests and results — TDD evidence

**`tests/settings-ui.test.ts`** (new, 9 tests) — genuine RED→GREEN:
- RED: `npx vitest run tests/settings-ui.test.ts` failed with `Cannot find module '@/lib/settings-ui'` before the module existed.
- GREEN: same command, 9/9 passing after implementing `src/lib/settings-ui.ts`.

**`tests/user-signature.test.ts`** (new, 11 tests) — genuine RED→GREEN via `git stash`:
- Wrote the full test file (service-level round-trip/cap/allowlist/audit tests, plus route-level
  gating/upload/clear/400 tests) against the already-written implementation.
- `git stash push -u -- src/server/users.ts "src/app/api/admin/users/[id]/signature"` to remove
  just the implementation, keeping the schema/migration/audit.ts changes in place.
- RED confirmed: `Cannot find module '@/app/api/admin/users/[id]/signature/route'`.
- `git stash pop` to restore the implementation.
- GREEN: 11/11 passing (one iteration needed — the audit test's `entry.before` is `null` on the
  `create` audit row, which `toHaveProperty` can't be called on; fixed with a null guard).

**Existing test updated**: `tests/audit.test.ts`'s pre-existing `"redacts signatureImage in
update"` test asserted the OLD behavior (`signatureImage` present but `"[redacted]"`). The new
`SNAPSHOT_SELECT` entry for `user` makes the property genuinely absent instead — the same
improvement the attachment tables already have, and literally what the brief asks for ("the way
the attachment tests do"). Updated the test's assertions and renamed it to describe the new
behavior; this predates Task 12 and wasn't testing anything Task 12-specific, just a shared
mechanism this task legitimately upgrades.

**Existing test fixture updated**: `tests/search.test.ts`'s `sessionUser()` helper builds a
`SessionUser`-shaped object literal directly against the Prisma type; added the new
`signatureMimeType: null` field to keep it type-complete.

### Full suite

```
npm test        → 91 test files, 1269 tests, all passing
npx tsc --noEmit → clean
npx eslint src tests → clean (one ESLint false-start: my first `no-img-element` disable comment
                        was mis-placed on the wrong line — fixed, verified clean after)
npm run build    → succeeds; /api/admin/users/[id]/signature registered as a dynamic route
```

## What was verified in the browser, and what was seen

Ran `npm run dev` via the `erp-dev` preview config, signed in as `admin`/`admin`.

**Environment note**: this session's Browser pane does not composite/render frames
(`computer{action:"screenshot"}` fails with "the Browser pane is not displayed") and
`document.hasFocus()` reports `false`/`visibilityState: "hidden"`. Pixel-coordinate clicks and
raw `form_input` property-sets on the DOM did not reliably trigger React's synthetic event
handlers (a checkbox toggled via `form_input` updated `.checked` but no `onChange` fired; the
same for a directly-set `<select>.value`). Real keyboard-driven interaction (`computer` tool's
`left_click` on a ref + `type` + `key Tab`) **did** work reliably and is what most of the
verification below uses; where it didn't apply (checkbox activation, `<select>` value commits),
I used the DOM's own `.click()` / native property setter + `dispatchEvent`, which exercises the
real component code (not a hand-rolled workaround) the same way Testing Library's `fireEvent`
does. A `window.fetch` wrapper installed in the page captured the exact JSON body the app's own
`save()`/`onFileChosen` functions sent, so every assertion below is against the real production
code path, not a manual `fetch()` call standing in for it.

**Settings page** (`/admin/settings`) — all five of Task 1's settings read, changed, and saved
through the real page code:
- Rendered correctly on load: `cert_required_default` as an unchecked checkbox,
  `cert_scope_default` as a `<select>` with `By order`/`By load`/`By shipment` options (matching
  `CERT_SCOPES`/`CERT_SCOPE_LABELS`), `cert_statement` and `shipper_liability_text` as full
  multi-paragraph `<textarea>`s with the transcribed legal text, `bol_number_next` (and every
  other numbering key) as a real `type="number"` input.
- Checkbox: clicking it dispatched `PUT /api/admin/settings` with body
  `{"key":"cert_required_default","value":false}` — a real JSON boolean, not the string `"false"`
  the old page would have sent. Confirmed persisted via a follow-up `GET`.
- Select: setting it to `SHIPMENT` dispatched `{"key":"cert_scope_default","value":"SHIPMENT"}` —
  a real member of `CERT_SCOPES`. Confirmed persisted.
- Textarea (`cert_statement`): typing into it and tabbing away dispatched a PUT with the full
  edited string; confirmed persisted, full legal text intact.
- Number (`bol_number_next`): typing `3000` and tabbing away dispatched
  `{"key":"bol_number_next","value":3000}` — a real JSON number. Confirmed persisted.
- Textarea (`shipper_liability_text`): typed an appended sentence, tabbed away, confirmed the
  full multi-paragraph text (including the embedded `\n\n`) round-tripped and persisted correctly.
- Reset all six touched dev-DB values back to their original defaults afterward (direct `PUT`
  calls, cleanup only — not part of the verification itself).

**Signature upload** (`/admin/users`):
- "Signature" column renders with "No signature" text and a disabled-looking Clear button, plus
  an enabled file input (the signed-in admin holds `manage_users`).
- Simulated a real file selection (`DataTransfer`/`File` with real PNG magic bytes,
  `input.files = ...; input.dispatchEvent(new Event("change"))` — the standard technique for
  driving a file input without an OS picker dialog) through the actual `onFileChosen` handler.
  Observed network sequence: `GET .../signature?v=0 → 404` (the optimistic `<img>`'s initial
  load, which is what flips the fallback text on mount), `PUT .../signature → 200`,
  `GET .../signature?v=1 → 200` (the cache-busted preview reload). The `<img>` then rendered with
  `naturalWidth: 1` (matching the 1×1 test PNG) and the "No signature" fallback text disappeared.
- Fetched the bytes back directly: `content-type: image/png`, 68 bytes, first 8 bytes
  `[137,80,78,71,13,10,26,10]` — real PNG magic bytes, exact round-trip.
- Clicked the real Clear button (with `window.confirm` stubbed to auto-accept, since this
  browser toolset has no native dialog handler) — dispatched `DELETE .../signature → 200`. UI
  reverted to "No signature" / disabled Clear; a follow-up `GET` 404'd.
- Queried the dev database directly (`docker compose exec db psql`) for this user's `AuditLog`
  rows: both the upload and the clear `update` entries carry `signatureMimeType` (`"image/png"`
  then `null`) but **no `signatureImage` key at all** in either `before` or `after` — confirming
  the `SNAPSHOT_SELECT` fix works against the real database, not just the test suite.

## Files changed

- `erp/prisma/schema.prisma` — `User.signatureMimeType`
- `erp/prisma/migrations/20260804221411_user_signature_mime_type/migration.sql` (new)
- `erp/src/server/users.ts` — `listUsers()` now explicit `select`;
  `setSignature`/`clearSignature`/`getSignature`/`SIGNATURE_MAX_BYTES`/`SIGNATURE_MIME`
- `erp/src/server/audit.ts` — `SNAPSHOT_SELECT.user`
- `erp/src/app/api/admin/users/[id]/signature/route.ts` (new)
- `erp/src/components/UserSignatureControl.tsx` (new)
- `erp/src/app/admin/users/page.tsx` — Signature column, permission gate
- `erp/src/lib/settings-ui.ts` (new)
- `erp/src/app/admin/settings/page.tsx` — rewritten to render/submit by type, permission gate
- `erp/tests/settings-ui.test.ts` (new)
- `erp/tests/user-signature.test.ts` (new)
- `erp/tests/audit.test.ts` — updated pre-existing signature-redaction test to match the new,
  stronger (exclude-from-query) behavior
- `erp/tests/search.test.ts` — added `signatureMimeType: null` to a type-complete fixture

## Self-review findings

- **Caught and fixed during implementation**: an initial draft of a code comment in
  `users.ts` invented an unsupported claim about the owner's scanner hardware to explain why
  `image/bmp` is in the allowlist. Caught before committing and replaced with a comment citing
  the actual source (the brief's own interface) rather than a fabricated rationale — the project's
  "do not make assumptions" rule applies to comments, not just behavior.
- **`activeManageUsersHolders()`** in `users.ts` still does a blanket `include` that now also
  pulls signature bytes on every `updateUser` call that changes `active`/`roleId`. I fixed the
  identical shape in `listUsers()` (which I was already touching to add the signature UI) but left
  this one alone rather than expand the diff into an unrelated function — flagged as a follow-up
  task (`task_032536ce`) rather than silently left. See Concerns.
- Naming, YAGNI: no unused exports; `UserSignatureControl` takes a `Gate` directly rather than a
  looser `canEdit: boolean` + separately-threaded tooltip string, matching the `DocumentsSection`
  precedent rather than inventing a new shape.
- Test quality: both new test files assert real behavior (network status codes, exact byte
  round-trips, audit content) rather than just "doesn't throw"; the audit test explicitly checks
  the key is *absent*, not just redacted, matching the attachments precedent the brief points at.

## Concerns

- **`activeManageUsersHolders()`** (see above) has a real, pre-existing-shape perf issue that
  Task 12 makes concretely worse (real bytes now flow through it) but didn't introduce. Flagged
  as a spawned follow-up task rather than fixed inline, to keep this task's diff scoped to what it
  was asked to do.
- The dev-DB browser verification required working around this session's non-compositing Browser
  pane (documented above) with DOM-level techniques (`.click()`, native setters +
  `dispatchEvent`, `DataTransfer`) instead of pixel/coordinate-based interaction. Every technique
  used exercises the real component code path (verified via the `fetch` interception and the
  resulting network log), not a substitute for it, but this is worth a reviewer knowing about
  rather than assuming a normal screenshot-driven click session happened.

---

## Addendum — review round: sibling-split sweep (commit `893dc5e`)

Review verdict: **Needs fixes**. Everything explicitly asked for by the brief was upheld as
correct (type-correct submission, upload discipline, the audit-content assertion, §5.16 gating,
the browser-verification technique). The finding was a **sibling-split**: I fixed `listUsers()`'s
blanket `include` in the same commit that gave `signatureImage` a real writer, but missed that
the identical defect shape exists at every other place a `User` row is loaded — and one of those
(`getSessionUser`) runs on every single authenticated request, making it worse than the one I
did fix. I had also filed `activeManageUsersHolders()` (the twin of `listUsers()`, same file,
same commit) as a deferred follow-up task instead of fixing it inline, which the review correctly
called an inconsistent half-measure.

### How the group was enumerated

Per HANDOFF §4a's rule ("when a fix lands on one member of a group, check every other member in
the same commit"), the group here is "queries that load a `User` row." Enumerated with:

```
grep -rn "\.user\.\(findUnique\|findFirst\|findMany\)" src --include=*.ts
grep -rn "user: {" src --include=*.ts       # relation-include of user from another model
grep -n "\.user\." prisma/seed.ts            # one-time seed script, checked for completeness
```

Full census, five raw `prisma.user.find*` call sites plus one relation-include:

| Site | Status before this round | Fix |
|---|---|---|
| `sessions.ts` `getSessionUser`'s `user` relation-include | full row via `include` | **fixed** — narrowed `select` |
| `users.ts` `activeManageUsersHolders()` | full row via `include` | **fixed** — narrowed `select` (was deferred as `task_032536ce`; withdrawn, fixed inline instead) |
| `users.ts` `listUsers()` | already fixed (this task's first commit) | unchanged |
| `users.ts` `createUser`'s dupe check | full row via bare `findUnique`, only used for `if (dupe)` | **fixed** — `select: { id: true }` |
| `users.ts` `getSignature()` | already narrow by design (it exists to read the bytes) | unchanged |
| `auth.ts` `authenticateUser` | full row via bare `findUnique` | **fixed** — narrowed `select` |
| `audit.ts` `SNAPSHOT_SELECT.user` / `SNAPSHOT_INCLUDE.user` | already correct (prior commit) | unchanged |
| `prisma/seed.ts`'s `user.upsert` | one-time bootstrap write, not a repeated read path | out of scope, not part of the group |

Every consumer of the resulting narrower types was grepped before narrowing the `select`, not
assumed: `SessionUser` field usage (`grep -rn "SessionUser" src`, then traced every place a field
was read off `requireUser()`/`currentUser()`/a `session.user`) turned up exactly
`id`/`username`/`displayName` (http.ts's actor, `/api/auth/me`), `active`/`deletedAt` (the
eligibility check in `sessions.ts` itself), and `role.permissions`/`overrides`
(`can()`/`canDo()`, permissions.ts) — nothing else, anywhere. `activeManageUsersHolders()`'s
consumer (`updateUser`'s `holders`/`target` logic) was read directly to confirm its field usage
(`id`, `active`, `roleId`, `role`, `overrides`) before narrowing.

### Changes

- **`erp/src/server/sessions.ts`** — `getSessionUser`'s `include: { user: { include: {...} } }`
  is now `select: { id, expiresAt, user: { select: { id, username, displayName, active,
  deletedAt, role: { select: { permissions: { select: { permission } } } }, overrides: {
  select: { permission, mode } } } } }`. `passwordHash` no longer travels on every request.
- **`erp/src/server/users.ts`** — `activeManageUsersHolders()` converted to the identical
  `select` shape now used by `listUsers()` (`id`, `active`, `roleId`, `role.permissions`,
  `overrides`). `createUser`'s dupe-existence check narrowed to `select: { id: true }`.
- **`erp/src/server/auth.ts`** — `authenticateUser`'s `findUnique` narrowed to
  `select: { id, displayName, passwordHash, active, deletedAt }` — exactly what it reads.
- **`erp/tests/sessions.test.ts`** — new test: creates a user, sets a real `signatureImage` +
  `signatureMimeType` on it directly via Prisma, resolves a session for that user, and asserts
  the resolved object `not.toHaveProperty("signatureImage")` and that
  `JSON.stringify(found)` never contains the marker bytes — the property is tested as absent on
  the actual resolved value, not inferred from the query shape.
- **`erp/tests/search.test.ts`** — its `SessionUser` fixture (`sessionUser()`) built a full
  `SessionUser` object literal by hand, including fields (`passwordHash`, `roleId`,
  `signatureImage`, `signatureMimeType`, `createdAt`, `updatedAt`, and `role.id`/`role.name`/
  `role.deletedAt`/`overrides[].id`/`overrides[].userId`) the narrower type no longer has —
  `tsc` caught this immediately (`'id' does not exist in type '{ permissions: ... }'`) and the
  fixture was trimmed to match exactly what `SessionUser` is now.

### Tests re-run

```
npx vitest run tests/sessions.test.ts tests/users.test.ts tests/user-signature.test.ts tests/auth-routes.test.ts
  → 4 test files, 37 tests, all passing (sessions.test.ts: 8, users.test.ts: 11,
    user-signature.test.ts: 11, auth-routes.test.ts: 7)

npm test          → 91 test files, 1270 tests, all passing (+1 from the new sessions.test.ts case)
npx tsc --noEmit  → clean (after fixing tests/search.test.ts's now-stale fixture)
npx eslint src tests → clean
npm run build     → succeeds
```

### Browser re-verification

Restarted the dev server, logged in as `admin`/`admin`, and confirmed:
- `GET /api/auth/me` still resolves correctly post-narrowing:
  `{"id":"...","username":"admin","displayName":"Administrator","permCount":58}` — the full
  permission set (58 keys) still resolves through the narrowed `role.permissions`/`overrides`
  select, proving `can()`/`canDo()` still work end to end with the leaner session-user shape.
- `/admin/users` still renders correctly (username, role select, active checkbox, the Signature
  column with its upload/preview/clear control) with the narrowed `listUsers()`/
  `activeManageUsersHolders()` queries.

### Follow-up task status

`task_032536ce` ("Trim activeManageUsersHolders' User query in users.ts") withdrawn via
`dismiss_task` — fixed inline in this commit instead of staying deferred, per the review's
explicit instruction not to fix one twin and file the other.

### Concerns carried forward

- The `activeManageUsersHolders()` deferral from the first round is resolved; no new deferrals
  were made this round. The `prisma/seed.ts` bootstrap upsert was checked and correctly excluded
  from the group (one-time script, not a repeated query path) rather than silently skipped.
- The browser-pane non-compositing limitation noted in the original verification section applies
  here too; the re-verification above used the same `fetch`/`javascript_tool` inspection
  technique (reading real network responses from actual page code), not pixel-based interaction,
  since nothing about this round changed the UI surface — only the queries backing it.
