// AREAS/CRUD_ACTIONS/SPECIAL_ACTIONS live in lib/permission-constants.ts (pure constants, no
// server-only imports) so client components can import them without pulling in this module's
// next/server + prisma dependency chain. Re-exported here so existing server-side imports
// (this file's own use below, seed.ts, etc.) don't need to change.
import { AREAS, CRUD_ACTIONS, SPECIAL_ACTIONS, type Area, type CrudAction, type SpecialAction } from "../lib/permission-constants";
export { AREAS, CRUD_ACTIONS, SPECIAL_ACTIONS };
export type { Area, CrudAction, SpecialAction };

export const ALL_PERMISSIONS: string[] = [
  ...AREAS.flatMap((a) => CRUD_ACTIONS.map((c) => `${a}.${c}`)),
  ...SPECIAL_ACTIONS.map((s) => `action.${s}`),
];

export type PermUser = {
  role: { permissions: { permission: string }[] } | null;
  overrides: { permission: string; mode: "GRANT" | "DENY" }[] ;
};

function resolve(user: PermUser, key: string): boolean {
  if (user.overrides.some((o) => o.permission === key && o.mode === "DENY")) return false;
  if (user.overrides.some((o) => o.permission === key && o.mode === "GRANT")) return true;
  return user.role?.permissions.some((p) => p.permission === key) ?? false;
}

export function can(user: PermUser, area: Area, action: CrudAction): boolean {
  return resolve(user, `${area}.${action}`);
}

export function canDo(user: PermUser, special: SpecialAction): boolean {
  return resolve(user, `action.${special}`);
}

/** Throw-on-deny helpers for route handlers. */
import { HttpError } from "./http";
export function mustCan(user: PermUser, area: Area, action: CrudAction): void {
  if (!can(user, area, action)) throw new HttpError(403, "You do not have permission for that");
}
export function mustDo(user: PermUser, special: SpecialAction): void {
  if (!canDo(user, special)) throw new HttpError(403, "You do not have permission for that");
}
