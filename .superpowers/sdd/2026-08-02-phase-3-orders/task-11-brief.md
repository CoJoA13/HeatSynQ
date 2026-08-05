### Task 11: Attachments — one story, two owners

**Files:**
- Create: `src/server/attachments.ts`, `src/app/api/parts/[id]/attachments/route.ts` (GET / POST), `src/app/api/parts/[id]/attachments/[attId]/route.ts` (GET bytes / DELETE), `src/app/api/orders/[id]/attachments/route.ts`, `src/app/api/orders/[id]/attachments/[attId]/route.ts`, `src/components/AttachmentsSection.tsx`
- Modify: `src/app/parts/[id]/page.tsx` (mount between pricing and process steps sections — exact slot: implementer picks adjacent to `CustomFieldsSection`, consistent spot on both pages)
- Test: `tests/attachments.test.ts`

**Interfaces (Produces):**
```ts
export type AttachmentOwner = "part" | "order";
export type AttachmentMeta = { id: string; filename: string; mimeType: string; size: number; createdAt: Date };
export async function listAttachments(owner: AttachmentOwner, ownerId: string): Promise<AttachmentMeta[]>;
export async function getAttachment(owner: AttachmentOwner, ownerId: string, attId: string): Promise<AttachmentMeta & { fileData: Buffer }>;
export async function addAttachment(owner: AttachmentOwner, ownerId: string,
  file: { filename: string; mimeType: string; data: Buffer }): Promise<AttachmentMeta>;
export async function deleteAttachment(owner: AttachmentOwner, ownerId: string, attId: string): Promise<void>;
```
One implementation keyed by owner (the `reference.ts` many-kinds pattern): owner row must be live (404 otherwise); 20 MB cap (400 names the limit); MIME allowlist `image/png image/jpeg image/gif image/webp application/pdf text/plain text/csv` + the two `openxmlformats` types (400 "That file type is not allowed"); audited create/soft-delete (snapshots carry metadata only — `fileData` redaction landed in Task 1). POST routes read `req.formData()` (`file` field + its `name`/`type`); GET bytes streams with `Content-Type` + `Content-Disposition: inline` for images/PDF, `attachment` otherwise. Gates: `.view` to list/get, `.edit` to add/delete, per owner area. `AttachmentsSection({ owner, ownerId, canEdit })` renders list + upload + delete with §5.16 disabled-not-hidden.

- [ ] **Step 1: Failing tests**: round-trip both owners through one suite loop; cap and allowlist 400s; owner-liveness 404 (soft-deleted part); cross-owner isolation (`getAttachment("order", orderId, partAttachmentId)` → 404); audit entries carry filename but never bytes; route 401/403 per area; GET disposition per type.
- [ ] **Steps 2–4: FAIL → implement service+routes+component, mount on the PART page (order hub mounts it in Task 14) → PASS + gates** (component behavior verified in Task 17's E2E; unit scope here is service+routes).
- [ ] **Step 5: Commit** — `feat: attachments — one story, part and order owners`

