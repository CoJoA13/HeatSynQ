// Pure constants only — no server-only imports. Safe to import from client components.
// (src/server/permissions.ts re-exports these so existing server-side imports keep working.)
export const AREAS = [
  "orders", "parts", "processes", "customers", "quotes", "certs",
  "shipping", "invoicing", "ar", "reports", "templates", "admin",
] as const;
export const CRUD_ACTIONS = ["view", "create", "edit", "delete"] as const;
export const SPECIAL_ACTIONS = [
  "void_shipper", "unlock_invoice", "void_order", "change_prices",
  "edit_cert_results_after_print", "apply_payments", "run_qbo_export",
  "close_ar_period", "edit_templates", "manage_users", "override_credit_hold",
] as const;

export type Area = (typeof AREAS)[number];
export type CrudAction = (typeof CRUD_ACTIONS)[number];
export type SpecialAction = (typeof SPECIAL_ACTIONS)[number];
