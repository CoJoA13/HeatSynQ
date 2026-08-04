// Pure constants — safe to import from client components (no server imports).
import type { ReferenceKind } from "./reference-constants";

/** Everything `findBlockers`/`assertRefExists` can be asked about: every `ReferenceKind` plus
 *  the non-reference targets that share the same delete-guard machinery (Phase 2C-3 adds
 *  `processStepCode`, which is a pick-list kind, not a reference kind — see PICKLIST_KINDS). */
export type BlockerTarget = ReferenceKind | "processStepCode";

/** Display label for a `BlockerTarget` that is NOT a `ReferenceKind` — those keep using
 *  `REFERENCE_LABELS`. Kept separate rather than folded into `REFERENCE_LABELS` because that
 *  table is typed `Record<ReferenceKind, ...>` and widening it would let a reference kind be
 *  looked up here by mistake. */
export const TARGET_LABELS: Record<"processStepCode", string> = { processStepCode: "process step code" };

/** Models that hold a foreign key pointing at a reference table. */
export type ReferenceLinkModel =
  | "customer" | "processStepCode" | "paymentType" | "inspectionCode"
  | "part" | "partSpecification" | "partInspection"
  | "partProcessStep" | "processTemplateStep" | "orderContainer";

export type ReferenceLink = {
  /** Prisma model holding the foreign key. */
  model: ReferenceLinkModel;
  /** The FK column on that model. */
  column: string;
  /** The target this link points at. `BlockerTarget`, NOT `PickListKind` — a link may target
   *  `glAccount`, which is deliberately not served by the pick-list route. */
  targetKind: BlockerTarget;
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
  /** Filter selecting the LIVE blocker rows. Defaults to `{ deletedAt: null }`; models whose
   *  liveness is inherited from a parent override it. */
  liveWhere?: Record<string, unknown>;
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
  { model: "partProcessStep", column: "codeId", targetKind: "processStepCode",
    label: "Step code", entityLabel: "Part", detailPath: (id) => `/parts/${id}`,
    liveWhere: { revision: { is: { part: { is: { deletedAt: null } } } } },
    include: { revision: { select: { part: { select: { id: true, partNumber: true, customer: { select: { code: true } } } } } } },
    blockerId: (r) => String(((r.revision as { part: { id: string } }).part).id),
    displayName: (r) => partLabel((r.revision as { part: unknown }).part) },
  { model: "processTemplateStep", column: "codeId", targetKind: "processStepCode",
    label: "Step code", entityLabel: "Template", detailPath: (id) => `/processes/templates/${id}`,
    liveWhere: { template: { is: { deletedAt: null } } },
    include: { template: { select: { id: true, name: true } } },
    blockerId: (r) => String((r.template as { id: string }).id),
    displayName: (r) => String((r.template as { name: string }).name) },
  { model: "orderContainer", column: "typeId", targetKind: "containerType",
    label: "Container", entityLabel: "Order", detailPath: (id) => `/orders/${id}`,
    liveWhere: { order: { is: { deletedAt: null } } },
    include: { order: { select: { id: true, orderNumber: true, customer: { select: { code: true } } } } },
    blockerId: (r) => String((r.order as { id: string }).id),
    displayName: (r) => { const o = r.order as { orderNumber: number; customer: { code: string } };
      return `#${o.orderNumber} · ${o.customer.code}`; } },
];

/** Everything pointing AT this target — the delete guard's direction. */
export function linksTargeting(target: BlockerTarget): ReferenceLink[] {
  return REFERENCE_LINKS.filter((l) => l.targetKind === target);
}

/** Everything this model points at — name resolution's direction. */
export function linksFrom(model: string): ReferenceLink[] {
  return REFERENCE_LINKS.filter((l) => l.model === model);
}

/** `defaultScaleId` → `defaultScaleName`. The resolved-name key returned alongside the id. */
export function nameKey(column: string): string {
  return `${column.replace(/Id$/, "")}Name`;
}
