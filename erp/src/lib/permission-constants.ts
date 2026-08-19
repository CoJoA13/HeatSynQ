// Pure constants only — no server-only imports. Safe to import from client components.
// (src/server/permissions.ts re-exports these so existing server-side imports keep working.)
// "ar" was retired by #72: vestigial since Phase 5B's "receivables" superseded it (no route ever
// checked it), and its seeded grant rows are purged by 20260819003000_remove_ar_permission_area.
export const AREAS = [
  "orders", "parts", "processes", "customers", "quotes", "certs",
  "shipping", "invoicing", "reports", "templates", "admin",
  "receivables",
] as const;
export const CRUD_ACTIONS = ["view", "create", "edit", "delete"] as const;
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

export type Area = (typeof AREAS)[number];
export type CrudAction = (typeof CRUD_ACTIONS)[number];
export type SpecialAction = (typeof SPECIAL_ACTIONS)[number];
