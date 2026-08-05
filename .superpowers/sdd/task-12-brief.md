### Task 12: Admin UI — per-user signature upload and typed settings widgets

**Files:**
- Modify: `src/server/users.ts`, `src/app/admin/users/*` (the user detail form), `src/app/admin/settings/page.tsx`
- Create: `src/app/api/admin/users/[id]/signature/route.ts`
- Test: `tests/user-signature.test.ts`, `tests/settings.test.ts`

**Amended 2026-08-04 after Task 1's review.** Task 1 added the first **boolean** setting (`cert_required_default`) and the first **enum** setting (`cert_scope_default`) to a settings page that has only ever rendered strings and integers — it submits every value as a string, so both new keys are unusable from the UI as shipped. That is the "a field the model supports but no screen can enter" shape this project treats as breaking, so it is fixed here rather than filed. Add to this task, before the signature work:

- [ ] **Step 0a: Write the failing test** — `setSetting("cert_required_default", "true")` (a string, which is what the page currently sends) is rejected by the zod schema with a 400; assert the page's submit path sends a real boolean and a member of `CERT_SCOPES` instead.
- [ ] **Step 0b: Render by declared type** — the settings page reads each key's `group` and label already; extend it to switch on the registry's schema type: checkbox for booleans, `<select>` over `CERT_SCOPES` (labelled with `CERT_SCOPE_LABELS`) for the scope enum, `<textarea>` for the two long standing-text keys (`cert_statement`, `shipper_liability_text` — single-line inputs make them uneditable in practice), and the existing input for everything else. Submit each with its real JavaScript type.
- [ ] **Step 0c: Verify in the browser** that all five of Task 1's settings can be read, changed and saved, then continue with the signature work below.

**Interfaces:**
- Produces:
```ts
export async function setSignature(userId: string, data: Buffer, mimeType: string): Promise<void>;
export async function clearSignature(userId: string): Promise<void>;
export async function getSignature(userId: string): Promise<{ data: Buffer; mimeType: string } | null>;
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
export const SIGNATURE_MIME = ["image/png", "image/jpeg", "image/bmp"] as const;
```

- [ ] **Step 1: Write the failing tests** — upload round-trips; a 3 MB upload 400s naming the cap; `image/svg+xml` 400s naming the allowed types; **the audit entry for the update contains no image bytes** (`signatureImage` is already in `redact()`'s patterns — assert it, don't assume); clearing sets the column null.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the service using `parseUploadFile`/`assertDeclaredUploadSize` from `src/server/http.ts` (the attachments precedent) and `auditedUpdate("user", …)`.
- [ ] **Step 4: Write the route** gated `mustDo("manage_users")`; `PUT` uploads, `DELETE` clears, `GET` streams the image with its content type.
- [ ] **Step 5: Add the admin UI** — an upload control with a preview and a Clear button on the user detail form, permission-gated per §5.16 (disabled with a tooltip, never hidden).
- [ ] **Step 6: Run the tests** — PASS.
- [ ] **Step 7: Gates + commit** — `feat(admin): per-user signature upload for certifications`

---

