export type NavItem = { label: string; href: string; key: string };
export type NavGroup = { label: string | null; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  { label: null, items: [{ label: "Today", href: "/today", key: "today" }] },
  { label: "SALES", items: [
    { label: "Quotes", href: "/quotes", key: "quotes" },
    { label: "Customers", href: "/customers", key: "customers" },
    { label: "Part Maintenance", href: "/parts", key: "parts" },
  ]},
  { label: "PRODUCTION", items: [
    { label: "Orders", href: "/orders", key: "orders" },
    { label: "Process Master", href: "/process-masters", key: "process-masters" },
    { label: "Schedule", href: "/schedule", key: "schedule" },
    { label: "Tracking", href: "/tracking", key: "tracking" },
    { label: "Shop Floor", href: "/shop-floor", key: "shop-floor" },
  ]},
  { label: "QUALITY", items: [
    { label: "Certifications", href: "/certifications", key: "certifications" },
    { label: "Specifications", href: "/specifications", key: "specifications" },
    { label: "Standards", href: "/standards", key: "standards" },
  ]},
  { label: "FINANCE", items: [
    { label: "Invoicing", href: "/invoicing", key: "invoicing" },
    { label: "A/R", href: "/ar", key: "ar" },
    { label: "Reports", href: "/reports", key: "reports" },
  ]},
  { label: null, items: [
    { label: "Patterns", href: "/patterns", key: "patterns" },
    { label: "Setup", href: "/setup", key: "setup" },
  ]},
];

export function isItemActive(itemHref: string, pathname: string): boolean {
  if (itemHref === "/today") return pathname === "/today";
  return pathname === itemHref || pathname.startsWith(itemHref + "/");
}
