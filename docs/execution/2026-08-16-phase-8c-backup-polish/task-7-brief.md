### Task 7: The shell warning bar

**Files:**
- Create: `erp/src/components/BackupBanner.tsx`
- Modify: `erp/src/app/layout.tsx`
- Create: `erp/tests/backup-banner.test.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/backups/health`.
- Produces: `<BackupBanner />`.

**Component test:** `erp/tests/practice-banner.test.tsx` is the precedent — read it first and match its
setup (render harness, fetch stubbing, and how it drives `usePathname`). The four cases that matter,
because each is a way the bar could silently fail to warn:

1. a red health payload renders the bar with its `reason` and a link to `/admin/backups`;
2. `state: "ok"` renders **nothing**;
3. a **403** (a caller without `manage_backups`) renders **nothing** and does not throw;
4. on `/login` it renders nothing and does not fetch.

- [ ] **Step 1: Read the precedent**

Run: `cd erp && cat src/components/SetupBanner.tsx`

This component is a deliberate clone of it. Keep its structure: mounted by the root layout **above**
`Shell` so it survives Shell's `/login` and me-null early returns; renders `null` on a 403 (a caller
without `manage_backups` sees nothing); clears and re-arms on `/login`.

- [ ] **Step 2: Write the banner**

```tsx
"use client";
// The backup staleness bar (Phase 8C §6.4). A red light on a page nobody opens is the same silent
// failure this feature exists to kill, so staleness surfaces on EVERY screen — but only for holders
// of `manage_backups`: the health route 403s for everyone else and this renders nothing, so the
// shop floor is never nagged about an admin concern. A direct SetupBanner clone.
//
// Unlike SetupBanner (whose readiness rollup runs an argon2 verify and so is fetched once per
// session), this endpoint is a cheap stat + one gzip -t, so it refetches on navigation — throttled,
// because a backup's state changes nightly, not per click.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/fetcher";
import type { BackupHealth } from "@/lib/backup-constants";

const REFRESH_MS = 5 * 60 * 1000;

export function BackupBanner() {
  const [health, setHealth] = useState<BackupHealth | null>(null);
  const pathname = usePathname();
  const lastFetchedAt = useRef(0);

  useEffect(() => {
    if (pathname === "/login") {
      setHealth(null);
      lastFetchedAt.current = 0;   // re-arm for the next login
      return;
    }
    if (Date.now() - lastFetchedAt.current < REFRESH_MS) return;
    lastFetchedAt.current = Date.now();
    api<BackupHealth>("/api/admin/backups/health")
      .then(setHealth)
      .catch(() => {
        // 403 for a caller without manage_backups, or a transient failure: show nothing and allow
        // a retry on the next navigation.
        setHealth(null);
        lastFetchedAt.current = 0;
      });
  }, [pathname]);

  if (!health || health.state === "ok") return null;

  return (
    <div className="flex items-center justify-center gap-3 bg-red-700 px-4 py-1.5 text-sm text-white">
      <span>⚠ {health.reason}</span>
      <Link href="/admin/backups" className="font-semibold underline">Open Backups</Link>
    </div>
  );
}
```

- [ ] **Step 3: Mount it in the root layout**

In `erp/src/app/layout.tsx`, add the import and render it beside `<SetupBanner />`:

```tsx
import { BackupBanner } from "@/components/BackupBanner";
```

```tsx
        {isPractice && <PracticeBanner />}
        <SetupBanner />
        <BackupBanner />
        <Shell>{children}</Shell>
```

- [ ] **Step 4: Verify in the browser**

With `npm run dev` running and `erp/backups` empty, sign in as admin: the red bar must appear on an
ordinary page (e.g. `/customers`), link to `/admin/backups`, and disappear after a successful
"Back up now". Confirm it does **not** appear on `/login`.

- [ ] **Step 5: Run the fast gates**

Run: `cd erp && npx tsc --noEmit && npx eslint src tests && npx vitest run tests/permissions-sweep.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add erp/src
git commit -m "feat(backups): surface staleness in a manage_backups-only shell bar"
```

---

