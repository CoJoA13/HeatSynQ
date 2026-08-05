### Task 7: Drafts + saved views services

**Files:**
- Create: `src/server/order-drafts.ts`, `src/server/saved-views.ts`
- Test: `tests/order-drafts.test.ts`, `tests/saved-views.test.ts`

**Interfaces (Produces):**
```ts
// order-drafts.ts — THE documented unaudited exception (spec §4). Direct prisma writes, own row only.
export async function getDraft(userId: string): Promise<{ payload: unknown; updatedAt: Date } | null>;
export async function putDraft(userId: string, payload: unknown): Promise<void>;   // upsert; payload ≤ 256 KB serialized (400 above)
export async function clearDraft(userId: string): Promise<void>;                   // payload → DbNull (an update, not a delete)

// saved-views.ts — audited normally.
export async function listViews(userId: string): Promise<SavedViewRow[]>;
export async function createView(userId: string, input: unknown): Promise<SavedViewRow>;  // { name, config, isDefault? }
export async function updateView(userId: string, id: string, input: unknown): Promise<SavedViewRow>;
export async function deleteView(userId: string, id: string): Promise<void>;   // soft; no reason (frees only a per-user name)
```
`config` is opaque `Json` to the server (client owns the shape: `{ columns: string[], filters: …, sort: … }`). `isDefault: true` clears the user's other defaults in the same tx (normalizer). Name: `.trim().min(1).max(80)`; `findFirst({ userId, name, deletedAt: null })` duplicate check (never `findUnique` — partial unique).

- [ ] **Step 1: Failing tests**: draft round-trip; clear nulls payload but keeps the row; oversize payload 400; **no audit rows from any draft call** (the §12.7 assertion); other users' drafts untouched. Views: CRUD own-rows-only (service takes userId — cross-user access is structurally impossible; test two users same view name OK); default normalizer (setting B default clears A); soft-deleted name reusable; audit entries exist for view create/update/delete.
- [ ] **Steps 2–4: FAIL → implement → PASS + gates.**  **Step 5: Commit** — `feat: order drafts (unaudited scratch) and saved board views`

