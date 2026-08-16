# Task 2 review: `manage_backups` action and `backup_stale_hours` setting

## Spec Compliance
✅ Spec compliant.

- `backup_stale_hours` (`erp/src/server/settings.ts:74-76`): `int(1, 8760)`, default sourced from
  `DEFAULT_STALE_HOURS` (`erp/src/lib/backup-constants.ts:8`, value `36`) via import at
  `erp/src/server/settings.ts:7`, group `"System"`. No second hardcoded `36` — confirmed by reading
  the setting literal and the constant side by side.
- `manage_backups` added to `SPECIAL_ACTIONS` (`erp/src/lib/permission-constants.ts:9-18`), the
  owner-approved §12 item 6 action, comment cites the rationale and "do NOT re-raise."
- `erp/src/app/admin/roles/page.tsx:110` maps over `SPECIAL_ACTIONS` dynamically — confirmed by
  reading the render loop; no hand-edit was made or needed. Checkbox appears automatically.
- Only one backup-related setting added — grepped `settings.ts` for "backup" (case-insensitive):
  the only hits are the import and the `backup_stale_hours` block itself. No `backup_dir`/
  `backup_retention`/`backup_schedule` key present.
- `getSetting` remains `<K extends SettingKey>` (`erp/src/server/settings.ts:90-91`), unchanged and
  unwidened by this diff.
- `Object.hasOwn` guards in `getSetting`/`setSetting`/the third call site (`settings.ts:93,102,125`)
  untouched by the diff.
- No attribution trailer on the commit; conventional-commit subject
  (`feat(backups): add the manage_backups action and backup_stale_hours setting`).

## Independent verification of the count-assertion claim
Ran my own greps across `erp/src`, `erp/tests`, `erp/prisma` for `ALL_PERMISSIONS`/`SPECIAL_ACTIONS`
and for bare numeric-literal counts (`13*4+NN`, `6x` near "permission"/"special", and a manual
enumeration of every `SPECIAL_ACTIONS` value such as `void_shipper` outside
`permission-constants.ts`). Findings:

- The only hardcoded count in the tree was `tests/permissions.test.ts:46` — now `13 * 4 + 13`,
  correctly fixed (was `13 * 4 + 12`).
- Every other consumer (`prisma/seed.ts:30`, `prisma/demo-seed.ts:300`,
  `src/app/api/auth/me/route.ts:7`, `tests/demo-seed.test.ts:28`, `src/server/roles.ts:45`,
  `src/server/users.ts:129`) reads `ALL_PERMISSIONS`/`SPECIAL_ACTIONS` dynamically — no literal
  count, no hand-maintained enumeration of the special-action names. This independently confirms
  the report's grep claim; I did not just trust it.
- Arithmetic verified directly: `AREAS` in `permission-constants.ts:3-7` has 13 entries,
  `SPECIAL_ACTIONS` (`:9-18`) has 13 entries after this change (12 pre-existing + `manage_backups`).
  13×4+13 = 65, matching the corrected assertion. Confirmed by scripted count, not eyeballing.

## Strengths
- `backup-settings.test.ts` covers default, override, and the full rejection set (0, -1, 1.5, 8761)
  — boundary-complete for `int(1, 8760)`.
- The `manage_backups` permission-resolution test follows the existing GRANT/DENY-override pattern
  used by every other named action (`tests/permissions.test.ts:49-56`).
- Comments on both new blocks correctly cite the owner ruling and the "why a setting vs. deploy
  config" reasoning, matching the brief's rationale rather than inventing a shorter one.
- Report's search command and file-by-file disposition (Step 5's sweep) are reproducible and match
  what I found independently.

## Issues
### Critical (Must Fix)
None.

### Important (Should Fix)
None.

### Minor (Nice to Have)
None — diff is a faithful, minimal implementation of the brief with no unrequested scope.

## Assessment
**Task quality:** Approved
**Reasoning:** All four brief requirements are met exactly as specified (single setting, sourced
default, owner-approved action, dynamic roles-page rendering), and the implementer's claim about the
count-assertion sweep — the one risk flagged for this task — is independently verified correct: no
other hardcoded permission count or duplicated `SPECIAL_ACTIONS` enumeration exists in the tree, and
the corrected `13 * 4 + 13` arithmetic checks out against the actual array lengths.
