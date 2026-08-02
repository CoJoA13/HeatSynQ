// Pure constants — safe to import from client components (no server imports).
import type { ReferenceKind } from "./reference-constants";

/** Models that hold a foreign key pointing at a reference table. */
export type ReferenceLinkModel =
  | "customer" | "processStepCode" | "paymentType" | "inspectionCode"
  | "part" | "partSpecification" | "partInspection";

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
  /** Relations the blocker query loads (pure data, client-safe) — a child row that presents
   *  its parent needs the parent (and its customer) on the row displayName reads. */
  include?: Record<string, unknown>;
  /** Which entity this blocker IS. Defaults to the row itself. A child row that presents its
   *  parent (partInspection → part) returns the parent's id; href, detailPath and dedupe all
   *  use it. */
  blockerId?: (row: Record<string, unknown>) => string;
};

/** A Part is (customer, partNumber) — never a bare name (2C-1 spec §9). */
function partLabel(p: unknown): string {
  const part = p as { partNumber?: unknown; customer?: { code?: unknown } };
  return `${String(part.customer?.code ?? "?")} · ${String(part.partNumber ?? "?")}`;
}
const PART_VIA_CHILD = {
  entityLabel: "Part",
  detailPath: (id: string) => `/parts/${id}`,
  include: { part: { select: { id: true, partNumber: true, customer: { select: { code: true } } } } },
  blockerId: (r: Record<string, unknown>) => String((r.part as { id: string }).id),
  displayName: (r: Record<string, unknown>) => partLabel(r.part),
} as const;

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
  { model: "part", column: "materialId", targetKind: "material",
    label: "Material", entityLabel: "Part", detailPath: (id) => `/parts/${id}`,
    include: { customer: { select: { code: true } } }, displayName: (r) => partLabel(r) },
  { model: "partSpecification", column: "specificationId", targetKind: "specification",
    label: "Specification", ...PART_VIA_CHILD },
  { model: "partInspection", column: "inspectionCodeId", targetKind: "inspectionCode",
    label: "Inspection code", ...PART_VIA_CHILD },
  { model: "partInspection", column: "scaleId", targetKind: "inspectionScale",
    label: "Scale", ...PART_VIA_CHILD },
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
