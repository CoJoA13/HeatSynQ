// The customer-page template-assignment picker's PURE display logic (spec §5.2, §5.15, §5.16).
// Client-safe: no server imports (importing src/server/** drags Prisma into the browser bundle —
// the permission-ui.ts / nav.ts precedent). The contract registry is pure declarations, so a
// client file may import it for the docType display name.
//
// The SOURCE of a docType's resolution (own / inherited / default) is decided on the SERVER by the
// same walk the print resolver uses (`resolveAssignment` in template-assignments.ts — resolution is
// defined ONCE, never reimplemented per spec §5.2). This layer only FORMATS that pre-computed state
// into a never-blank state label, the `<select>`'s selected value, and the option list. Kept pure
// so the state → label/selected/disabled mapping is unit-testable without a DB or a rendered React
// tree (tests/template-assignment-picker.test.ts).
import { contractFor, type TemplateDocTypeString } from "./template-contracts/index";

/** One docType's resolved display state, produced by `resolveAssignmentsForCustomer` (server). */
export type AssignmentDisplay = {
  docType: TemplateDocTypeString;
  /** Which rung of the §5.2 chain won: this customer's OWN assignment, a nearest-ancestor's
   *  (INHERITED), or the type's DEFAULT template — always exactly one, never blank (§5.15). */
  source: "own" | "inherited" | "default";
  /** The name of whichever template resolved — what the state label shows. */
  resolvedTemplateName: string;
  /** This customer's OWN assignment target, or null when it has none (the select's selected value
   *  and whether a Clear is offered). Null for inherited/default. */
  ownTemplateId: string | null;
  /** The ancestor an INHERITED assignment came from (source === "inherited"); null otherwise. */
  inheritedFromCode: string | null;
  inheritedFromName: string | null;
};

/** The `requireUser`-only names read's row (id/name/docType + the §5.16 published flag). */
export type TemplateNameRow = {
  id: string; name: string; docType: TemplateDocTypeString; published: boolean;
};

export type PickerOption = { id: string; name: string; disabled: boolean; title?: string };

export type PickerRow = {
  docType: TemplateDocTypeString;
  docTypeLabel: string;
  /** The never-blank current-state text (§5.15). */
  stateLabel: string;
  /** "" when there is no OWN assignment — the "use default / inherit" option. */
  selectedTemplateId: string;
  hasOwnAssignment: boolean;
  /** This docType's live templates; a never-published one is disabled with its §5.16 tooltip. */
  options: PickerOption[];
};

/** The §5.16 reason a never-published template is disabled — the assign route's own refusal, shown
 *  before the user can trigger it rather than surfacing the 400 (Task 19's re-affirmed Task-20 note). */
export const UNPUBLISHED_OPTION_TITLE =
  "This template has never been published — publish a version before assigning it";

/** The never-blank state text for one docType (§5.15). */
export function stateLabelFor(d: AssignmentDisplay, docTypeLabel: string): string {
  switch (d.source) {
    case "own":
      return `Assigned: ${d.resolvedTemplateName}`;
    case "inherited":
      return `Inherited from ${d.inheritedFromCode} — ${d.inheritedFromName}: ${d.resolvedTemplateName}`;
    case "default":
      return `${docTypeLabel} default (${d.resolvedTemplateName})`;
  }
}

/** Compose one docType's picker row from its resolved state + the live template names. Pure. */
export function buildPickerRow(d: AssignmentDisplay, names: TemplateNameRow[]): PickerRow {
  const docTypeLabel = contractFor(d.docType).name;
  const options: PickerOption[] = names
    .filter((n) => n.docType === d.docType)
    .map((n) => ({
      id: n.id,
      name: n.name,
      disabled: !n.published,
      title: n.published ? undefined : UNPUBLISHED_OPTION_TITLE,
    }));
  return {
    docType: d.docType,
    docTypeLabel,
    stateLabel: stateLabelFor(d, docTypeLabel),
    selectedTemplateId: d.ownTemplateId ?? "",
    hasOwnAssignment: d.ownTemplateId !== null,
    options,
  };
}
