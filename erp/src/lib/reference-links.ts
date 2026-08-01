// Pure constants — safe to import from client components (no server imports).
import type { ReferenceKind } from "./reference-constants";

/** Models that hold a foreign key pointing at a reference table. */
export type ReferenceLinkModel = "customer" | "processStepCode" | "paymentType" | "inspectionCode";

export type ReferenceLink = {
  /** Prisma model holding the foreign key. */
  model: ReferenceLinkModel;
  /** The FK column on that model. */
  column: string;
  /** The reference kind it points at. `ReferenceKind`, NOT `PickListKind` — a link may target
   *  `glAccount`, which is deliberately not served by the pick-list route. */
  targetKind: ReferenceKind;
  /** Column header wherever this FK is displayed or exported. */
  label: string;
  /** How a blocker row names its own kind in the blocked-delete list. */
  entityLabel: string;
  /** Detail-page path. Omitted where the entity has no detail page — the admin grids are small
   *  and unpaginated, so the row is already on screen (owner ruling, spec §7.1). */
  detailPath?: (id: string) => string;
  /** How this blocker names itself. Defaults to `row.name`. Put per-model formatting HERE, not
   *  in findBlockers — a Part is identified by (customer, partNumber), never by name alone, so
   *  its 2C-2 registry entry MUST supply this rather than rely on the default. */
  displayName?: (row: Record<string, unknown>) => string;
};

/** The single source of truth for "which column points at which reference kind".
 *  Two consumers read it in opposite directions: name resolution forward (given a column,
 *  show the target's name), the delete guard inverted (given a kind, who points at me).
 *  tests/reference-links-sweep.test.ts fails the build if a schema FK is missing here. */
export const REFERENCE_LINKS: ReferenceLink[] = [
  { model: "customer", column: "termsId", targetKind: "terms",
    label: "Terms", entityLabel: "Customer", detailPath: (id) => `/customers/${id}` },
  { model: "processStepCode", column: "glAccountId", targetKind: "glAccount",
    label: "GL account", entityLabel: "Process step code",
    displayName: (r) => `${r.code} — ${r.name}` },
  { model: "paymentType", column: "glAccountId", targetKind: "glAccount",
    label: "GL account", entityLabel: "Payment type" },
  { model: "inspectionCode", column: "defaultScaleId", targetKind: "inspectionScale",
    label: "Default scale", entityLabel: "Inspection code" },
];

/** Everything pointing AT this kind — the delete guard's direction. */
export function linksTargeting(kind: ReferenceKind): ReferenceLink[] {
  return REFERENCE_LINKS.filter((l) => l.targetKind === kind);
}

/** Everything this model points at — name resolution's direction. */
export function linksFrom(model: string): ReferenceLink[] {
  return REFERENCE_LINKS.filter((l) => l.model === model);
}

/** `defaultScaleId` → `defaultScaleName`. The resolved-name key returned alongside the id. */
export function nameKey(column: string): string {
  return `${column.replace(/Id$/, "")}Name`;
}
