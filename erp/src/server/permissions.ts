export const AREAS = [
  "orders", "parts", "processes", "customers", "quotes", "certs",
  "shipping", "invoicing", "ar", "reports", "templates", "admin",
] as const;
export const CRUD_ACTIONS = ["view", "create", "edit", "delete"] as const;
export const SPECIAL_ACTIONS = [
  "void_shipper", "unlock_invoice", "void_order", "change_prices",
  "edit_cert_results_after_print", "apply_payments", "run_qbo_export",
  "close_ar_period", "edit_templates", "manage_users",
] as const;

export type Area = (typeof AREAS)[number];
export type CrudAction = (typeof CRUD_ACTIONS)[number];
export type SpecialAction = (typeof SPECIAL_ACTIONS)[number];

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
