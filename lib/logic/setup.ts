export type SetupCardKey = "operators" | "plant" | "process-masters" | "equipment" | "pricing" | "cert-defaults";

export type SetupCard = { key: SetupCardKey; title: string; desc: string; href: string | null };

/** Prototype canon: Visual Shop.dc.html lines 1102-1109 (setupCards data) + 370-378 (markup).
 *  Titles and descs are verbatim. Targets are per-card honesty (spec §1): cards whose domain
 *  already has a screen link there; Plant Setup is inert (nothing prints anywhere yet). */
export const SETUP_CARDS: SetupCard[] = [
  { key: "operators", title: "Operators & Security", desc: "Operator IDs, roles, module permissions and signatures.", href: "/setup/operators" },
  { key: "plant", title: "Plant Setup", desc: "Company info that prints on travelers, certs and invoices.", href: null },
  { key: "process-masters", title: "Process Masters", desc: "Recipes: standard steps, table keys and equipment.", href: "/process-masters" },
  { key: "equipment", title: "Equipment & Areas", desc: "Furnaces, ovens, areas and tracking templates.", href: "/shop-floor" },
  { key: "pricing", title: "Pricing & Price Keys", desc: "Step pricing, customer overrides and dimensional pricing.", href: "/setup/pricing" },
  { key: "cert-defaults", title: "Certifications & Forms", desc: "Cert formats, defaults and form / message inserts.", href: "/setup/cert-defaults" },
];
