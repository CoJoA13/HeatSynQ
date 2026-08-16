### Task 6: The Backups admin page

**Files:**
- Create: `erp/src/app/admin/backups/page.tsx`
- Modify: `erp/src/lib/nav.ts` (the nav model gains action-gating + the Backups entry)
- Modify: `erp/tests/nav.test.ts`
- *(No component test here — the page is a thin render over one endpoint and is covered by the Task 9
  E2E flow. The component test that IS worth writing lands in Task 7, where `tests/practice-banner.test.tsx`
  gives a direct precedent for the banner's conditional-render logic.)*

**Interfaces:**
- Consumes: `GET /api/admin/backups`, `POST /api/admin/backups/run`; types from `@/lib/backup-constants`.
- Produces: the page at `/admin/backups`.

- [ ] **Step 1: Read two existing admin pages first**

Run: `cd erp && sed -n '1,80p' src/app/admin/templates/page.tsx && sed -n '1,60p' src/app/admin/settings/page.tsx`

Match their conventions exactly: `"use client"`, the `api`/`ApiError` helper from `@/lib/fetcher`, the
`gateDo` helper from `@/lib/permission-ui` for disabled-with-reason controls, table classes, and the
error-banner pattern. **§5.13: roll back to server truth FIRST, then report the error — never run a
reload that clears the banner after setting it.**

- [ ] **Step 2: Write the page**

```tsx
"use client";
// The Backups page (Phase 8C §6.2). Gated on `manage_backups`, production-only (the routes refuse
// the practice copy). Everything it shows comes from one guarded endpoint; it holds no business
// logic — the green rule lives in evaluateHealth (backups.ts), which is where it is tested.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import type { ArchiveInfo, BackupsView } from "@/lib/backup-constants";

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
  : `${n} B`;

const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

export default function BackupsPage() {
  const [view, setView] = useState<BackupsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // The SHARED hook, never a hand-rolled /api/auth/me effect. Its own header names "reimplemented
  // rather than shared" as this repo's recurring defect shape, and it gets two things right that a
  // local copy reliably gets wrong: `permissions` stays `undefined` while in flight (so gateDo
  // keeps controls DISABLED rather than flashing them open and then locking), and a failed fetch
  // surfaces as `error` instead of being swallowed into `[]`, which is indistinguishable from a
  // real "no grants" account and would permanently disable every control with no explanation.
  const { permissions, error: permError } = usePermissions();

  const load = useCallback(async () => {
    const v = await api<BackupsView>("/api/admin/backups");
    setView(v);
    return v;
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiError ? e.message : "Could not read the backup folder."));
  }, [load]);

  const gate = gateDo(permissions, "manage_backups");

  async function backUpNow() {
    setRunning(true);
    setError(null);
    try {
      await api<{ archive: ArchiveInfo }>("/api/admin/backups/run", { method: "POST" });
      await load();
    } catch (e) {
      // §5.13: refresh to server truth FIRST, then report — a reload after setError would wipe the
      // banner the operator needs to read.
      await load().catch(() => {});
      setError(e instanceof ApiError ? e.message : "The backup failed.");
    } finally {
      setRunning(false);
    }
  }

  const health = view?.health;
  const green = health?.state === "ok";

  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Backups</h1>

      {/* The permissions failure folds in beside the page's own — a swallowed one would leave every
          control disabled with nothing on screen explaining why (usePermissions' documented rule). */}
      {(error ?? permError) && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error ?? permError}
        </div>
      )}

      {health && (
        <div
          className={`mb-4 rounded border px-4 py-3 ${
            green ? "border-green-300 bg-green-50 text-green-900"
                  : "border-red-300 bg-red-50 text-red-900"}`}
        >
          <div className="font-semibold">
            {green ? "Backups are up to date" : "Backups need attention"}
          </div>
          <div className="text-sm">{health.reason}</div>
          <div className="mt-1 text-xs opacity-80">
            {health.lastSuccessAt
              ? `Last successful backup: ${fmtWhen(health.lastSuccessAt)}`
              : "No successful backup on record."}
            {" · "}Threshold: {health.staleHours} hours
          </div>
        </div>
      )}

      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={backUpNow}
          disabled={gate.disabled || running}
          title={gate.title}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {running ? "Backing up…" : "Back up now"}
        </button>
        <span className="text-sm text-gray-600">
          Backup folder: <code className="rounded bg-gray-100 px-1">{view?.folder ?? "…"}</code>
        </span>
      </div>

      <p className="mb-4 text-sm text-gray-600">
        Restoring is a deliberate terminal command, not a button — see the restore runbook in
        <code className="mx-1 rounded bg-gray-100 px-1">erp/README.md</code>.
      </p>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1">Archive</th><th>Taken</th><th>Source</th><th>Size</th><th>Integrity</th>
          </tr>
        </thead>
        <tbody>
          {(view?.archives ?? []).map((a) => (
            <tr key={a.name} className="border-b">
              <td className="py-1 font-mono text-xs">{a.name}</td>
              <td>{fmtWhen(a.modifiedAt)}</td>
              <td>{a.source === "manual" ? "On demand" : "Nightly"}</td>
              <td>{fmtBytes(a.sizeBytes)}</td>
              <td className={a.integrityOk ? "text-green-700" : "text-red-700"}>
                {a.integrityOk ? "OK" : "CORRUPT"}
              </td>
            </tr>
          ))}
          {view && view.archives.length === 0 && (
            <tr><td colSpan={5} className="py-3 text-gray-600">No backup archives in this folder yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Teach the nav model to gate on a special action, then add the entry**

The nav lives in **`erp/src/lib/nav.ts`** (a pure client-safe module), not in `Shell.tsx` — `Shell`
just renders `visibleAdmin(me.permissions)`. **This step is bigger than adding a line, and here is
why.** Every existing entry is gated by `canViewArea`, which tests for `<area>.view`. But
`manage_backups` is a **special action**, not an area — `backups.view` does not exist and never will.

Gating the entry on `admin.view` instead would be a **§5.15 silent dead end**: a user granted
`manage_backups` but not `admin.view` could use the page but would never see it. That is precisely
the failure the file's own nav-decision note calls out for Templates ("a `templates.view`-only user
still sees an Admin group containing just Templates, and so reaches /admin/templates"). So the nav
model gains action-gating.

Change the type to a discriminated union so an entry declares exactly one gate:

```ts
export type NavEntry =
  | { label: string; href: string; area: string; action?: never }
  | { label: string; href: string; action: string; area?: never };
```

Add the entry to `ADMIN`, beside the other configuration surfaces:

```ts
  // Gated on the `manage_backups` ACTION rather than an area — backups are not one of the 12
  // permission areas, and gating this on `admin.view` would leave a manage_backups-only user able
  // to use the page but unable to find it (the §5.15 silent-dead-end rule the Templates entry
  // above exists to avoid).
  { label: "Backups", href: "/admin/backups", action: "manage_backups" },
```

Add the resolver beside `canViewArea` (keep `canViewArea` exported — `tests/nav.test.ts` uses it):

```ts
/** True iff the permission set grants the ONE gate this entry declares — `<area>.view` for an
 *  area entry, `action.<name>` for an action entry. An absent array (permissions still loading)
 *  is treated as "no grants", so entries stay hidden until /api/auth/me resolves. */
export function canSeeEntry(perms: string[] | undefined, entry: NavEntry): boolean {
  return entry.action !== undefined
    ? (perms ?? []).includes(`action.${entry.action}`)
    : canViewArea(perms, entry.area);
}
```

and route **both** list builders through it:

```ts
export function visibleNav(perms: string[] | undefined): NavEntry[] {
  return NAV.filter((n) => canSeeEntry(perms, n));
}

export function visibleAdmin(perms: string[] | undefined): NavEntry[] {
  return ADMIN.filter((n) => canSeeEntry(perms, n));
}
```

Finally, extend the nav-decision comment at the top of the file to record that admin entries now gate
on an area **or** a special action, and why.

- [ ] **Step 3b: Extend `tests/nav.test.ts`**

Read the existing cases and match their style. Add at least:

```ts
  it("shows Backups to a manage_backups holder who has no admin.view", () => {
    const entries = visibleAdmin(["action.manage_backups"]);
    expect(entries.map((n) => n.href)).toEqual(["/admin/backups"]);
  });

  it("hides Backups from an admin.view user without manage_backups", () => {
    const hrefs = visibleAdmin(["admin.view"]).map((n) => n.href);
    expect(hrefs).not.toContain("/admin/backups");
    expect(hrefs).toContain("/admin/users");   // the rest of the group is unaffected
  });

  it("hides Backups while permissions are still loading", () => {
    expect(visibleAdmin(undefined).map((n) => n.href)).not.toContain("/admin/backups");
  });
```

- [ ] **Step 4: Verify in the browser**

```bash
cd erp && npm run dev
```

Then, with the preview tools: open `/admin/backups`, confirm the red indicator renders (no archives
exist on a dev machine yet), the folder path shows, and the console is clean. Click **Back up now**
and confirm an archive appears and the indicator flips green.

> Set `BACKUP_DIR=./backups` in `erp/.env` for the dev run, and `mkdir -p erp/backups` first — `/backups`
> does not exist on a dev host.

- [ ] **Step 5: Run the fast gates**

Run: `cd erp && npx tsc --noEmit && npx eslint src tests && npx vitest run tests/permissions-sweep.test.ts`
Expected: all clean — the sweep's "no client component imports from src/server" case is the one that
matters here.

- [ ] **Step 6: Commit**

```bash
git add erp/src
git commit -m "feat(backups): add the Backups admin page"
```

---

