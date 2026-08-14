import { describe, it, expect } from "vitest";
import {
  buildPickerRow, stateLabelFor, UNPUBLISHED_OPTION_TITLE,
  type AssignmentDisplay, type TemplateNameRow,
} from "@/lib/template-assignment-picker";

/**
 * Phase 7 Task 20 — the customer-page picker's PURE display logic (client-safe, node-only, no DB).
 *
 * The SERVER computes the per-docType resolution SOURCE (own / inherited / default) via the SAME
 * walk the print resolver uses (`resolveAssignment`, shared — never reimplemented, spec §5.2). This
 * pure layer only FORMATS that pre-computed state into the never-blank state label (§5.15), the
 * `<select>`'s selected value, and the option list with never-published templates disabled + their
 * §5.16 tooltip. UI wiring is covered in E2E.
 */

const names: TemplateNameRow[] = [
  { id: "t-trav-std", name: "Standard", docType: "TRAVELER", published: true },
  { id: "t-trav-fancy", name: "Fancy Traveler", docType: "TRAVELER", published: true },
  { id: "t-trav-wip", name: "Work In Progress", docType: "TRAVELER", published: false },
  { id: "t-ship-std", name: "Standard", docType: "SHIPPER", published: true },
];

describe("stateLabelFor — the never-blank current-state text (§5.15)", () => {
  it("own assignment names the assigned template", () => {
    const d: AssignmentDisplay = {
      docType: "TRAVELER", source: "own", resolvedTemplateName: "Fancy Traveler",
      ownTemplateId: "t-trav-fancy", inheritedFromCode: null, inheritedFromName: null,
    };
    expect(stateLabelFor(d, "Traveler")).toBe("Assigned: Fancy Traveler");
  });

  it("inherited names the ancestor it came from AND the resolved template", () => {
    const d: AssignmentDisplay = {
      docType: "TRAVELER", source: "inherited", resolvedTemplateName: "Fancy Traveler",
      ownTemplateId: null, inheritedFromCode: "PARENT", inheritedFromName: "Parent Co",
    };
    expect(stateLabelFor(d, "Traveler")).toBe("Inherited from PARENT — Parent Co: Fancy Traveler");
  });

  it("default names the type and the default template — never blank", () => {
    const d: AssignmentDisplay = {
      docType: "TRAVELER", source: "default", resolvedTemplateName: "Standard",
      ownTemplateId: null, inheritedFromCode: null, inheritedFromName: null,
    };
    expect(stateLabelFor(d, "Traveler")).toBe("Traveler default (Standard)");
  });
});

describe("buildPickerRow", () => {
  it("own state: the label, the selected id, and hasOwnAssignment all reflect the own row", () => {
    const d: AssignmentDisplay = {
      docType: "TRAVELER", source: "own", resolvedTemplateName: "Fancy Traveler",
      ownTemplateId: "t-trav-fancy", inheritedFromCode: null, inheritedFromName: null,
    };
    const row = buildPickerRow(d, names);
    expect(row.docTypeLabel).toBe("Traveler");
    expect(row.stateLabel).toBe("Assigned: Fancy Traveler");
    expect(row.selectedTemplateId).toBe("t-trav-fancy");
    expect(row.hasOwnAssignment).toBe(true);
  });

  it("inherited/default state: no own row → the select falls to the use-default option", () => {
    const d: AssignmentDisplay = {
      docType: "TRAVELER", source: "inherited", resolvedTemplateName: "Fancy Traveler",
      ownTemplateId: null, inheritedFromCode: "PARENT", inheritedFromName: "Parent Co",
    };
    const row = buildPickerRow(d, names);
    expect(row.selectedTemplateId).toBe("");
    expect(row.hasOwnAssignment).toBe(false);
    expect(row.stateLabel).toBe("Inherited from PARENT — Parent Co: Fancy Traveler");
  });

  it("options are only this docType's live templates", () => {
    const d: AssignmentDisplay = {
      docType: "TRAVELER", source: "default", resolvedTemplateName: "Standard",
      ownTemplateId: null, inheritedFromCode: null, inheritedFromName: null,
    };
    const row = buildPickerRow(d, names);
    expect(row.options.map((o) => o.id).sort()).toEqual(["t-trav-fancy", "t-trav-std", "t-trav-wip"]);
    // The SHIPPER template is not offered under the Traveler picker.
    expect(row.options.some((o) => o.id === "t-ship-std")).toBe(false);
  });

  it("a never-published template is disabled with the §5.16 tooltip; published ones are enabled", () => {
    const d: AssignmentDisplay = {
      docType: "TRAVELER", source: "default", resolvedTemplateName: "Standard",
      ownTemplateId: null, inheritedFromCode: null, inheritedFromName: null,
    };
    const row = buildPickerRow(d, names);
    const wip = row.options.find((o) => o.id === "t-trav-wip")!;
    expect(wip.disabled).toBe(true);
    expect(wip.title).toBe(UNPUBLISHED_OPTION_TITLE);
    const published = row.options.find((o) => o.id === "t-trav-fancy")!;
    expect(published.disabled).toBe(false);
    expect(published.title).toBeUndefined();
  });
});
