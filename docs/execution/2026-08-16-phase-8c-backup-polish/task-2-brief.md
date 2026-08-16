### Task 2: `manage_backups` action and the `backup_stale_hours` setting

**Files:**
- Modify: `erp/src/lib/permission-constants.ts:9-14`
- Modify: `erp/src/server/settings.ts` (the `SETTINGS` registry, "System" group)
- Modify: `erp/tests/permissions.test.ts` (add the new action's assertions)
- Create: `erp/tests/backup-settings.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_STALE_HOURS` from Task 1.
- Produces: the `"manage_backups"` member of `SpecialAction`; the `backup_stale_hours` `SettingKey`.

- [ ] **Step 1: Write the failing test**

Create `erp/tests/backup-settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { getSetting, setSetting } from "@/server/settings";
import { SPECIAL_ACTIONS } from "@/lib/permission-constants";
import { DEFAULT_STALE_HOURS } from "@/lib/backup-constants";
import { runWithContext } from "@/server/context";

// setSetting audits, so it needs an actor in context. This is the repo's established idiom —
// copied verbatim from tests/order-entry-readiness.test.ts, which declares it the same way.
// There is NO tests/helpers/actor.ts; do not create one.
const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("backup_stale_hours", () => {
  beforeEach(async () => { await truncateAll(); });

  it("defaults to the owner-settled 36 hours", async () => {
    expect(await getSetting("backup_stale_hours")).toBe(DEFAULT_STALE_HOURS);
  });

  it("accepts a sane override", async () => {
    await asSystem(async () => { await setSetting("backup_stale_hours", 24); });
    expect(await getSetting("backup_stale_hours")).toBe(24);
  });

  it("refuses zero, negatives, non-integers and absurd values", async () => {
    await asSystem(async () => {
      await expect(setSetting("backup_stale_hours", 0)).rejects.toThrow();
      await expect(setSetting("backup_stale_hours", -1)).rejects.toThrow();
      await expect(setSetting("backup_stale_hours", 1.5)).rejects.toThrow();
      await expect(setSetting("backup_stale_hours", 8761)).rejects.toThrow();
    });
  });
});

describe("manage_backups", () => {
  it("is a named special action", () => {
    expect(SPECIAL_ACTIONS).toContain("manage_backups");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd erp && npx vitest run tests/backup-settings.test.ts`
Expected: FAIL — `backup_stale_hours` is not a `SettingKey` (a tsc error surfaced by vitest), and
`SPECIAL_ACTIONS` does not contain `manage_backups`.

- [ ] **Step 3: Add the special action**

In `erp/src/lib/permission-constants.ts`, extend the array (the roles page renders from this constant,
so the UI needs no edit):

```ts
export const SPECIAL_ACTIONS = [
  "void_shipper", "unlock_invoice", "void_order", "change_prices",
  "edit_cert_results_after_print", "apply_payments", "run_qbo_export",
  "close_ar_period", "edit_templates", "manage_users", "override_credit_hold",
  "write_off",
  // Phase 8C §6.2/§12 item 6 (owner-approved at design approval — do NOT re-raise): gates the
  // Backups page, "Back up now", and the staleness reads. A dump is a full copy of every
  // customer's record, which is why it is a named dangerous action rather than part of `admin`.
  "manage_backups",
] as const;
```

- [ ] **Step 4: Add the setting**

In `erp/src/server/settings.ts`, inside `SETTINGS`, beside `session_timeout_minutes` in the "System"
group:

```ts
  // Phase 8C §6.4: the ONLY backup setting. The folder, cadence and retention are deploy config —
  // the nightly container cannot honor a live change, and a setting the writer ignores is a
  // half-working feature. This one the app CAN honor, because the app is what evaluates staleness.
  // Default 36 = a full 12h of slack past the 24h cadence: one late run never cries wolf, two
  // consecutive misses always do. Capped at a year, floored at 1 (a zero-hour window is
  // permanently red and therefore meaningless).
  backup_stale_hours: {
    schema: int(1, 8760), default: DEFAULT_STALE_HOURS, label: "Backup staleness threshold (hours)", group: "System",
  },
```

Add the import at the top of `settings.ts`:

```ts
import { DEFAULT_STALE_HOURS } from "@/lib/backup-constants";
```

- [ ] **Step 5: Extend the permission test**

`erp/tests/permissions.test.ts` already has a local, DB-free helper at the top of the file:

```ts
function user(rolePerms: string[], overrides: { permission: string; mode: "GRANT" | "DENY" }[] = []): PermUser
```

Use it — do **not** invent a `userWithPermissions`. Add this case:

```ts
  it("manage_backups is denied by default and granted by an explicit action grant", () => {
    expect(canDo(user([]), "manage_backups")).toBe(false);
    expect(canDo(user(["action.manage_backups"]), "manage_backups")).toBe(true);
    // A DENY override must beat the grant, like every other dangerous action.
    expect(canDo(
      user(["action.manage_backups"], [{ permission: "action.manage_backups", mode: "DENY" }]),
      "manage_backups",
    )).toBe(false);
  });
```

Then scan the rest of the file (and `tests/permissions-sweep.test.ts`) for any case that enumerates
`SPECIAL_ACTIONS` or asserts a **count** of permissions — `ALL_PERMISSIONS` grows by one — and update
it. Run the whole of both files, not just your new case.

- [ ] **Step 6: Run the tests**

Run: `cd erp && npx vitest run tests/backup-settings.test.ts tests/permissions.test.ts tests/permissions-sweep.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the fast gates**

Run: `cd erp && npx tsc --noEmit && npx eslint src tests`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add erp/src erp/tests
git commit -m "feat(backups): add the manage_backups action and backup_stale_hours setting"
```

---

