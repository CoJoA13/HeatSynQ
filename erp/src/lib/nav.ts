// The Shell's nav model + gating, as a pure client-safe module (no server imports — the
// permission-ui.ts precedent; a "use client" file pulling from src/server/** drags Prisma into
// the browser bundle). Lifting the arrays and the permission → visible-entries decision out of
// Shell.tsx is what makes the gating unit-testable (tests/nav.test.ts) rather than only
// reachable through a rendered component.
//
// THE NAV DECISION (Task 16, spec §5.5 "One admin surface … under the existing admin area UI,
// gated on the `templates` area"): Templates is an ADMIN-GROUP entry, not a top-level nav entry,
// but — unlike every other admin entry — it is gated on `templates.view` SPECIFICALLY, not on
// `admin.view`. The Admin group header shows whenever ANY admin-group entry is visible
// (`visibleAdmin(...).length > 0`), so:
//   - a `templates.view`-only user (no `admin.view`) still sees an Admin group containing just
//     Templates, and so reaches /admin/templates — the §5.15 silent-dead-end rule;
//   - an `admin.view`-only user without `templates` sees the other admin entries but NOT Templates
//     (it is a different area).
// The page itself still enforces the gate: /api/templates does `mustCan(requireUser(), "templates",
// "view")` — the nav is never the authorization.
//
// PHASE 8C ADDENDUM — gating on a special ACTION, not just an area: Backups (Task 6) has no
// `backups.view` and never will — `manage_backups` is one of the 10 named special actions
// (permission-constants.ts), not one of the 12 permission areas. Gating the Backups entry on
// `admin.view` instead would repeat the exact §5.15 silent-dead-end mistake the Templates entry
// above exists to avoid: a user granted `manage_backups` but not `admin.view` could use the page
// but never see a link to it. So `NavEntry` is a discriminated union — an entry declares EXACTLY
// ONE gate, either an `area` (checked as `<area>.view`, the Templates shape) or an `action`
// (checked as `action.<name>`, the Backups shape) — and both `visibleNav`/`visibleAdmin` resolve
// through the single `canSeeEntry` below rather than each re-implementing the check.

export type NavEntry =
  | { label: string; href: string; area: string; action?: never }
  | { label: string; href: string; action: string; area?: never };

export const NAV: NavEntry[] = [
  { label: "Orders", href: "/", area: "orders" },
  { label: "Quotes", href: "/quotes", area: "quotes" },
  { label: "Certifications", href: "/certs", area: "certs" },
  { label: "Shipping", href: "/shipping", area: "shipping" },
  { label: "Invoicing", href: "/invoicing", area: "invoicing" },
  { label: "Receivables", href: "/receivables", area: "receivables" },
  { label: "Customers", href: "/customers", area: "customers" },
  { label: "Parts", href: "/parts", area: "parts" },
  { label: "Processes", href: "/processes", area: "processes" },
  { label: "Reports", href: "/reports", area: "reports" },
];

// Every entry gated on `admin.view` EXCEPT Templates, which gates on its own `templates` area —
// see the nav-decision note above. Order is cosmetic; Templates sits with the other configuration
// surfaces.
export const ADMIN: NavEntry[] = [
  { label: "Users", href: "/admin/users", area: "admin" },
  { label: "Roles", href: "/admin/roles", area: "admin" },
  { label: "Reference data", href: "/admin/reference", area: "admin" },
  { label: "Process step codes", href: "/admin/step-codes", area: "admin" },
  { label: "Part fields", href: "/admin/part-fields", area: "admin" },
  { label: "Settings", href: "/admin/settings", area: "admin" },
  { label: "Billing", href: "/admin/billing", area: "admin" },
  { label: "Surcharges", href: "/admin/surcharges", area: "admin" },
  { label: "Templates", href: "/admin/templates", area: "templates" },
  { label: "Audit log", href: "/admin/audit", area: "admin" },
  // Gated on the `manage_backups` ACTION rather than an area — backups are not one of the 12
  // permission areas, and gating this on `admin.view` would leave a manage_backups-only user able
  // to use the page but unable to find it (the §5.15 silent-dead-end rule the Templates entry
  // above exists to avoid).
  { label: "Backups", href: "/admin/backups", action: "manage_backups" },
];

/** True iff the permission set grants `<area>.view`. An absent array (permissions still loading)
 *  is treated as "no grants", so entries stay hidden until /api/auth/me resolves. */
export function canViewArea(perms: string[] | undefined, area: string): boolean {
  return (perms ?? []).includes(`${area}.view`);
}

/** True iff the permission set grants the ONE gate this entry declares — `<area>.view` for an
 *  area entry, `action.<name>` for an action entry. An absent array (permissions still loading)
 *  is treated as "no grants", so entries stay hidden until /api/auth/me resolves. */
export function canSeeEntry(perms: string[] | undefined, entry: NavEntry): boolean {
  return entry.action !== undefined
    ? (perms ?? []).includes(`action.${entry.action}`)
    : canViewArea(perms, entry.area);
}

export function visibleNav(perms: string[] | undefined): NavEntry[] {
  return NAV.filter((n) => canSeeEntry(perms, n));
}

export function visibleAdmin(perms: string[] | undefined): NavEntry[] {
  return ADMIN.filter((n) => canSeeEntry(perms, n));
}
