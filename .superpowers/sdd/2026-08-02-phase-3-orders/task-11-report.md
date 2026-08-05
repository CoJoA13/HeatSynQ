# Task 11 Report — Attachments: one story, two owners

## Status: Complete. All quality gates green.

## Commit

`1b8384b` — `feat: attachments — one story, part and order owners` (branch `phase-3-orders`, on top of `7646f44`). Single commit, no attribution trailer (per CLAUDE.md/global-constraints).

9 files, 749 insertions:
- New: `erp/src/server/attachments.ts` (service)
- New: `erp/src/app/api/parts/[id]/attachments/route.ts`, `erp/src/app/api/parts/[id]/attachments/[attId]/route.ts`
- New: `erp/src/app/api/orders/[id]/attachments/route.ts`, `erp/src/app/api/orders/[id]/attachments/[attId]/route.ts`
- New: `erp/src/components/AttachmentsSection.tsx`
- New: `erp/tests/attachments.test.ts`
- Modified: `erp/src/app/parts/[id]/page.tsx` (mount)
- Modified: `erp/src/server/http.ts` (added `parseUploadFile` — see "Beyond the file list" below)

## What was built

One service (`src/server/attachments.ts`), parameterized by `owner: "part" | "order"`, following the `reference.ts` kind-registry pattern (`OWNER_LABEL`/`OWNER_COLUMN`/`AUDIT_MODEL` records + a `delegate(owner, db)` helper returning a loosely-typed `AttachmentDelegate`, same shape as `reference.ts`'s `RefDelegate`/`assertKind`). Four exported functions matching the brief's Interfaces block exactly: `listAttachments`, `getAttachment`, `addAttachment`, `deleteAttachment`, plus `contentDisposition` (exported, shared by both GET-bytes routes) and `AttachmentOwner`/`AttachmentMeta` types.

Four thin route files (parts + orders × list/upload + get-bytes/delete), each just `mustCan` + delegate to the service. One component (`AttachmentsSection.tsx`), mounted once on the part page directly adjacent to `CustomFieldsSection` (between it and `ProcessStepsSection`); the order hub is untouched, per scope (Task 14).

## Design decisions worth flagging

**Owner-liveness applied uniformly to all four functions, not just mutators.** The brief states plainly, twice (in its own prose and in the outer task context): "owner row must be live (404 otherwise)" / "findFirst({ id, deletedAt: null }) on the owner model → 404" — unqualified by read vs. write. I implemented it that way: `assertOwnerLive` runs in `listAttachments`, `getAttachment`, `addAttachment`, and `deleteAttachment` alike, for both owner kinds.

I want to flag the tension this creates with existing code, in case it's not what's wanted: `orders.ts`'s `readDetail` *deliberately* skips the `deletedAt` filter ("a voided order is still readable (spec §5c)"), and every order-child mutator (`addLine`, `updateLine`, `replaceContainers`, etc.) *does* filter on it. Under the brief's literal, uniform rule, a voided order's attachments become invisible via `listAttachments`/`getAttachment` too — which arguably conflicts with global-constraints.md's "voided orders block nothing." I chose to follow the brief's explicit, unqualified wording rather than infer the `readDetail`-style read/write asymmetry myself, since that asymmetry isn't in the brief or the test list and inventing it felt like the bigger assumption. This is easy to change in one place (`assertOwnerLive`'s single call site per function) if the owner wants order reads exempted to match `readDetail`.

**Beyond the file list: `parseUploadFile` added to `src/server/http.ts`.** Not in the brief's file list, but both POST routes need identical `req.formData()` → `{filename, mimeType, data: Buffer}` extraction, and `http.ts` is the existing home for exactly this kind of shared request-parsing helper (`assertRecord`, `reasonFromBody` precedent). Kept `src/server/attachments.ts` itself free of any `Request`/`FormData` code, mirroring how `orders.ts`/`parts.ts` don't parse JSON bodies either — that's the route handler's job.

## Test coverage (`tests/attachments.test.ts`, 22 tests)

Covers the brief's full list: round-trip both owners in one loop (service level) and again via `describe.each` at the route level; 20 MB cap and MIME allowlist 400s (service + route); owner-liveness 404 across all four functions on a soft-deleted part; cross-owner isolation (`getAttachment("order", orderId, partAttachmentId)`); audit entries carry filename but never bytes (marker-string assertion against the persisted JSON); route 401/403 per area; GET disposition per type; `Content-Disposition` filename escaping (quotes/backslashes/CRLF).

**One gap I found and fixed via mutation testing, beyond the binding test list:** the brief's cross-owner test (`getAttachment("order", orderId, partAttachmentId)`) 404s purely because the two owner kinds are different Prisma tables — it would still pass even if `getAttachment`/`deleteAttachment` forgot to scope by `ownerId` at all. I added a same-kind test (`getAttachment("part", partB, partA's attachment)`) mirroring `parts-routes.test.ts`'s "child routes 404 a child of a different part," then verified by temporarily removing the `ownerId` scoping from `getAttachment`'s `where` clause — the existing suite stayed green (20/20) but the new test caught it immediately. I also mutation-tested the cap/allowlist checks and the owner-liveness guard the same way (disable → confirm failure → revert); all reverted cleanly and the suite is back to 22/22.

## Quality gates

- `npm test`: 870/870 passing (848 baseline + 22 new), `tests/attachments.test.ts` included.
- `npx tsc --noEmit`: clean.
- `npx eslint src tests`: clean.
- `npm run build`: succeeds; all four attachment routes listed in the route table, no bundling warnings for the new client component (confirms no `src/server/**` leakage into the browser bundle — `AttachmentsSection.tsx` re-declares `AttachmentOwner` locally rather than importing it, matching the `parts/[id]/page.tsx` `Part`-type precedent).

## Self-review

- One implementation, zero copy-paste between owners: yes — `attachments.ts` is one parameterized service, `AttachmentsSection.tsx` is one parameterized component; the 4 route files are unavoidable per-URL wiring only.
- Bytes never in audit: yes — create's audit payload is hand-built metadata-only (never includes `fileData`); delete's snapshot relies on the pre-existing (Task 1) `redact()` "filedata" pattern, verified end-to-end with a marker-byte test.
- Disposition correct: yes — inline for image/png,jpeg,gif,webp + pdf; attachment for csv/plain/docx/xlsx; verified against real route responses, not just the mapping table.
- §5.16 gating in the component: yes — `canEdit=false` disables (never hides) the file input and each row's Delete button, tooltip names `parts.edit`/`orders.edit` per owner.
- Part-page mount seam clean: yes — one two-line diff, adjacent to `CustomFieldsSection`, no server imports in the client component.
- No scope creep: confirmed via `git diff --stat` — only the 9 intended files touched; no order-hub file touched.

## Concerns for the reviewer

1. The owner-liveness uniformity decision above (voided-order read visibility) — flagging for explicit sign-off since it's a judgment call, not a copy of existing precedent.
2. `parseUploadFile` landed in `http.ts` rather than a new file — flagging since it's outside the brief's literal file list, though it avoids real duplication between the two POST routes.

## Fix round 1

Review finding (Important, exactly flagged concern #1 above): order-owner reads must accept a voided order (mirrors `orders.ts`'s `readDetail` — "a voided order is still readable", spec §5c); order writes and every part-side check stay live-only.

**Change in `src/server/attachments.ts`:** replaced the single `assertOwnerLive(owner, ownerId, db)` with `assertOwnerVisible(owner, ownerId, mode, db)`, where `mode: "read" | "write"`. A new `REQUIRES_LIVE: Record<AttachmentOwner, Record<OwnerAccessMode, boolean>>` table drives the one asymmetry explicitly:

```ts
const REQUIRES_LIVE: Record<AttachmentOwner, Record<OwnerAccessMode, boolean>> = {
  part: { read: true, write: true },
  order: { read: false, write: true },
};
```

`listAttachments`/`getAttachment` now call `assertOwnerVisible(owner, ownerId, "read", prisma)`; `addAttachment` (inside its transaction, on `tx`) and `deleteAttachment` call it with `"write"`. Parts are unaffected in practice (`REQUIRES_LIVE.part` is `true` for both modes, matching the original uniform-strict behavior — a deleted part still 404s on every path, since `getPart` itself 404s a deleted part outright and no voided-part-readable contract exists). Took the Record-driven pattern per the reviewer's Minor 1, folded into the existing owner-dispatch function rather than adding a second parallel function.

Reviewer's Minor 2 (streaming cap check) skipped per the coordinator's instruction — out of scope, noted for the backlog ledger, not this task.

**Test added** (`tests/attachments.test.ts`, "a voided order keeps its attachments readable, but blocks new writes"): adds an attachment to a live order, voids it via `voidOrder(orderId, reason)`, then asserts `listAttachments`/`getAttachment` still succeed (list returns the row; get streams the real bytes) while `addAttachment`/`deleteAttachment` both still 404 "Order not found." Verified the test actually exercises the fix by temporarily setting `REQUIRES_LIVE.order.read` back to `true` — the new test failed immediately (`Order not found` from `listAttachments`) — then reverted.

Part-side soft-deleted coverage (`"404s every operation once the owning part is soft-deleted"`) is unchanged, per instruction.

**Quality gates, fix round 1:**
- `npx vitest run tests/attachments.test.ts`: 23/23 passing (22 + 1 new).
- `npm test`: 871/871 passing (baseline 870 + 1 new).
- `npx tsc --noEmit`: clean.
- `npx eslint src tests`: clean.

**Commit:** `fix: voided orders keep their attachments readable; mutations stay live-only` (no attribution trailer).
