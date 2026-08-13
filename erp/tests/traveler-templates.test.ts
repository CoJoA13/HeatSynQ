import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import {
  TINY_JPEG, drawnPages, drawnText, pageCount, paintedImageCounts, parseObjects,
} from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { storeDocument } from "@/server/documents";
import { createTemplate, editDraft, openDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { barcodePng, pngDataUri, renderPdf } from "@/server/pdf/render";
import {
  buildTravelerDefinition, buildTravelerDefinitions, collectTravelerData, printTraveler,
  type TravelerData,
} from "@/server/traveler";
import {
  TRAVELER_DEFAULT_CONFIG, validateConfig, type TemplateConfig,
} from "@/lib/template-contracts/index";

/**
 * Phase 7 Task 7 — the traveler conversion and the stamp plumbing: `storeDocument`'s optional
 * `templateVersionId` (the plumbing Tasks 8–14 reuse), `buildTravelerDefinition(data, config)`
 * consuming the backfilled TemplateConfig, and `printTraveler` resolving its template on its own
 * claimed transaction. The GOLDEN-COMPAT gate lives in tests/traveler.test.ts, which this task
 * leaves untouched — everything here is the config-driven half.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** A minimal single-load order (loadQty ≥ qty → exactly one load, one traveler sheet).
 *  A smaller `loadQty` splits it — `loadQty: 5` against the qty of 10 gives two loads. */
async function miniOrder(partExtra: { processName?: string; loadQty?: number } = {}) {
  const customer = await prisma.customer.create({ data: { code: "TPL", name: "Template Test Co" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUS", name: "Austemper" } });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "TPL-1", name: "Template Part",
      eachWeight: "1.0000", loadQty: 100, ...partExtra,
    },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Pre-heat, then quench." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "10.00" }],
  }));
  return { customer, part, order };
}

// ------------------------------------------------------------------------------------------------
// The stamp plumbing (brief item 1): storeDocument's optional templateVersionId
// ------------------------------------------------------------------------------------------------

describe("storeDocument — the templateVersionId stamp", () => {
  beforeEach(truncateAll);

  it("a stored row carries the template version id it was given", async () => {
    const { order } = await miniOrder();
    const pdf = await renderPdf({ content: [{ text: "stamped" }] });
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf,
        templateVersionId("TRAVELER"))));

    const row = await prisma.storedDocument.findUnique({
      where: { id: meta.id }, select: { templateVersionId: true },
    });
    expect(row!.templateVersionId).toBe("standard-traveler-v1");
  });

  it("omitting the stamp stores null — the pre-Phase-7 call shape is untouched", async () => {
    const { order } = await miniOrder();
    const pdf = await renderPdf({ content: [{ text: "unstamped" }] });
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf)));

    const row = await prisma.storedDocument.findUnique({
      where: { id: meta.id }, select: { templateVersionId: true },
    });
    expect(row!.templateVersionId).toBeNull();
  });

  it("the stamp rides in the audit payload as metadata — never the bytes", async () => {
    const { order } = await miniOrder();
    const pdf = await renderPdf({ content: [{ text: "audited" }] });
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf,
        templateVersionId("TRAVELER"))));

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "storedDocument", entityId: meta.id, action: "create" },
    });
    expect(entry).not.toBeNull();
    const after = entry!.after as Record<string, unknown>;
    expect(after.templateVersionId).toBe("standard-traveler-v1");
    expect(JSON.stringify(after)).not.toContain("%PDF");
  });
});

// ------------------------------------------------------------------------------------------------
// buildTravelerDefinition(data, config) — pure config consumption (brief item 2)
// ------------------------------------------------------------------------------------------------

// Real barcodes (pdfkit parses image data, so even definition-only fixtures carry genuine PNGs);
// the LOGO uri is distinct from the barcode's so placement assertions can tell them apart.
const BARCODE = pngDataUri(await barcodePng("71246"));
const LOGO_URI = pngDataUri(await barcodePng("LOGO"));

/** A hand-built, DB-free TravelerData — `buildTravelerDefinition` is pure, so the config tests
 *  need no database at all. Shapes mirror tests/traveler.test.ts's mockup fixture. */
function travelerData(overrides: Partial<TravelerData> = {}): TravelerData {
  return {
    orderNumber: 71246,
    customerName: "Renaissance Manufacturing Group",
    receivedFrom: ["260 Central Castings Dr.", "Anniston, AL 36206"],
    company: { name: "American Heat Treating", address: "1 Furnace Rd", phone: "256-256-2566" },
    barcodeDataUri: BARCODE,
    lines: [{
      qty: 4500, partNumber: "3541719C3", partName: "U Bolt Rear Spr Plate",
      description: "Machined", eachWeight: 13.5, lineWeight: 60750,
    }],
    orderQty: 4500,
    orderWeight: 60750,
    containers: [{ typeName: "Drop Pan", count: 8, qty: 40, tareWeight: 2936, grossWeight: null }],
    materialName: "Ductile Iron",
    processId: "3541719C3",
    inspections: [{ code: "Hardness", scale: "HBW", min: 269, max: 341, sampleQty: "8", location: "flange OD" }],
    revisionNumber: 1,
    steps: [{
      position: 1, codeName: "Austemper", instruction: "Pre-heat to 1100F.",
      values: [{ label: "Furnace Temp", value: "1650", unit: "°F" }],
    }],
    sheets: [{ loadNumber: 1, loadQty: 336, loadWeight: 4536 }],
    processName: "",
    ...overrides,
  };
}

const cfg = (): TemplateConfig => structuredClone(TRAVELER_DEFAULT_CONFIG);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the
 *  builder (belt tests excepted, deliberately) is one a template could actually store. */
const checked = (c: TemplateConfig): TemplateConfig => validateConfig("TRAVELER", c);
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

/** Every `text` string/number in a definition, flattened — the traveler.test.ts walker. */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "image") continue;
      allText(value, out);
    }
  }
  return out;
}
const textOf = (def: unknown): string => allText(def).join("\n");

/** Every node in a definition matching `pred` — structural assertions (font sizes, widths). */
function findNodes(node: unknown, pred: (n: Record<string, unknown>) => boolean,
  out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) findNodes(n, pred, out); return out; }
  const obj = node as Record<string, unknown>;
  if (pred(obj)) out.push(obj);
  for (const value of Object.values(obj)) findNodes(value, pred, out);
  return out;
}

/** Every table's `widths` array in the definition. */
function allWidths(def: unknown): (number | string)[][] {
  return findNodes(def, (n) => typeof n.table === "object" && n.table !== null)
    .map((n) => (n.table as { widths?: (number | string)[] }).widths)
    .filter((w): w is (number | string)[] => Array.isArray(w));
}

describe("buildTravelerDefinition — config-driven sections, fields, labels, widths", () => {
  it("a hidden section is omitted from the stack", () => {
    const c = cfg();
    sectionOf(c, "footer").visible = false;
    const text = textOf(buildTravelerDefinition(travelerData(), checked(c)));
    expect(text).not.toContain("RESULTS:");
    expect(text).not.toContain("Tested By:");
    // …and the default config still prints the whole sign-off block.
    const dflt = textOf(buildTravelerDefinition(travelerData(), cfg()));
    expect(dflt).toContain("TEMPERED RESULTS:");
    expect(dflt).toContain("Tested By:");
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "process");
    const j = c.sections.findIndex((s) => s.key === "inspections");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildTravelerDefinition(travelerData(), checked(c)));
    expect(text.indexOf("Key Characteristic Inspection(s):"))
      .toBeLessThan(text.indexOf("Process ID:"));
    // …the default order is the other way around.
    const dflt = textOf(buildTravelerDefinition(travelerData(), cfg()));
    expect(dflt.indexOf("Process ID:"))
      .toBeLessThan(dflt.indexOf("Key Characteristic Inspection(s):"));
  });

  it("a hidden field drops its column — header cell and width both", () => {
    const c = cfg();
    fieldOf(c, "lines", "line_each_weight").visible = false;
    const def = buildTravelerDefinition(travelerData(), checked(c));
    expect(textOf(def)).not.toContain("Part Weight");
    expect(allWidths(def)).toContainEqual([78, "*", 88]);
  });

  it("field order follows the config within its section", () => {
    const c = cfg();
    const lines = sectionOf(c, "lines");
    const weight = lines.fields.find((f) => f.key === "line_weight")!;
    lines.fields = [weight, ...lines.fields.filter((f) => f.key !== "line_weight")];
    const text = textOf(buildTravelerDefinition(travelerData(), checked(c)));
    expect(text.indexOf("Line Weight")).toBeLessThan(text.indexOf("Part Quantity"));
  });

  it("a label override prints in place of the contract default", () => {
    const c = cfg();
    fieldOf(c, "lines", "line_qty").label = "Pieces";
    const text = textOf(buildTravelerDefinition(travelerData(), checked(c)));
    expect(text).toContain("Pieces");
    expect(text).not.toContain("Part Quantity");
  });

  it("a width override lands in the table's widths array", () => {
    const c = cfg();
    fieldOf(c, "lines", "line_qty").width = 100;
    const def = buildTravelerDefinition(travelerData(), checked(c));
    expect(allWidths(def)).toContainEqual([100, "*", 78, 88]);
  });

  it("thousandsSeparator: false ungroups every number the sheet prints", () => {
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const text = textOf(buildTravelerDefinition(travelerData(), checked(c)));
    expect(text).toContain("4500");
    expect(text).not.toContain("4,500");
    const dflt = textOf(buildTravelerDefinition(travelerData(), cfg()));
    expect(dflt).toContain("4,500");
  });
});

describe("buildTravelerDefinition — fonts from config", () => {
  const fontConfig = () => {
    const c = cfg();
    c.fonts = { family: "Liberation Sans", baseSize: 10, headingSize: 14, smallSize: 5 };
    return checked(c);
  };

  it("family and role sizes map into the definition", () => {
    const data = travelerData();
    const def = buildTravelerDefinition(data, fontConfig());
    expect(def.defaultStyle).toEqual({ font: "Liberation Sans", fontSize: 10 });
    // headingSize drives the company-name line; smallSize the sub-annotations.
    const company = findNodes(def, (n) => n.text === data.company.name);
    expect(company[0].fontSize).toBe(14);
    const perContainer = findNodes(def,
      (n) => typeof n.text === "string" && n.text.endsWith("per container"));
    expect(perContainer[0].fontSize).toBe(5);
  });

  it("the switch is visible in the rendered bytes — embedded family + Tf size", async () => {
    const pdf = await renderPdf(buildTravelerDefinition(travelerData(), fontConfig()));
    expect(pdf.toString("latin1")).toContain("LiberationSans");
    const streams = [...parseObjects(pdf).values()]
      .map((o) => o.stream?.toString("latin1") ?? "").join("\n");
    expect(streams).toMatch(/\s10 Tf/);
    expect(drawnText(pdf)).toContain("Renaissance Manufacturing Group");

    // …and the default still renders Roboto at 8pt.
    const dflt = await renderPdf(buildTravelerDefinition(travelerData(), cfg()));
    expect(dflt.toString("latin1")).toContain("Roboto");
    const dfltStreams = [...parseObjects(dflt).values()]
      .map((o) => o.stream?.toString("latin1") ?? "").join("\n");
    expect(dfltStreams).toMatch(/\s8 Tf/);
  });
});

describe("buildTravelerDefinition — the §5.6 builder-side belt (locked elements render regardless)", () => {
  it("a config hiding the steps section is refused by the validator AND still renders through the builder", () => {
    const c = cfg();
    sectionOf(c, "steps").visible = false;
    expect(() => validateConfig("TRAVELER", c)).toThrow(/cannot be hidden/);
    // Fed RAW past the validator — the belt, not the validator, is what this pins.
    const text = textOf(buildTravelerDefinition(travelerData(), c));
    expect(text).toContain("PROCESS STEPS:");
    expect(text).toContain("Austemper");
    expect(text).toContain("Furnace Temp: 1650 °F");
  });

  it("a config hiding the barcode still renders it", () => {
    const c = cfg();
    fieldOf(c, "header", "barcode").visible = false;
    expect(() => validateConfig("TRAVELER", c)).toThrow(/cannot be hidden/);
    const def = buildTravelerDefinition(travelerData(), c);
    expect(JSON.stringify(def)).toContain(BARCODE);
  });

  it("a config hiding the header section still renders it (the barcode lives there)", () => {
    const c = cfg();
    sectionOf(c, "header").visible = false;
    expect(() => validateConfig("TRAVELER", c)).toThrow(/cannot be hidden/);
    const def = buildTravelerDefinition(travelerData(), c);
    expect(JSON.stringify(def)).toContain(BARCODE);
    expect(textOf(def)).toContain("Order Number");
  });

  // The belt's OMISSION half (Task 8 pre-step, carried from the Task 7 review): the flag belt
  // above only forces entries that are PRESENT — a validator-bypassing config that simply OMITS
  // the entry used to drop the locked element. The builder now resolves its views over
  // `completeSections(TRAVELER_CONTRACT, config.sections)`, so omission cannot drop anything.
  // (The validator's §5.3 backfill re-inserts missing entries in every STORED config — like the
  // flag cases above, these feed the builder RAW, deliberately.)
  it("a raw config OMITTING the steps section entry still renders the steps", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "steps");
    const text = textOf(buildTravelerDefinition(travelerData(), c));
    expect(text).toContain("PROCESS STEPS:");
    expect(text).toContain("Austemper");
    expect(text).toContain("Pre-heat to 1100F.");
    expect(text).toContain("Furnace Temp: 1650 °F");
  });

  it("a raw config OMITTING a locked field entry still renders it", () => {
    const c = cfg();
    const steps = sectionOf(c, "steps");
    steps.fields = steps.fields.filter((f) => f.key !== "step_instruction");
    const def = buildTravelerDefinition(travelerData(), c);
    const text = textOf(def);
    // The instruction column (and the locked typed-value rendering inside it) is back on paper —
    // appended after the config's own run, so presence is the assertion, not position.
    expect(text).toContain("Pre-heat to 1100F.");
    expect(text).toContain("Furnace Temp: 1650 °F");
    const stepsWidths = allWidths(def).find((w) => w.includes(16) && w.includes(62))!;
    expect(stepsWidths).toContain("*");
  });

  it("a raw config OMITTING the header section still renders the barcode and order number", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "header");
    const def = buildTravelerDefinition(travelerData(), c);
    expect(JSON.stringify(def)).toContain(BARCODE);
    expect(textOf(def)).toContain("Order Number");
  });
});

describe("buildTravelerDefinition — the Process: slot (ruling 4, spec §5.7)", () => {
  // The walker flattens each cell as [text, alignment], so the slot's VALUE sits two entries
  // after its label: ["Process:", "center", <value>, "center", "Material:", …].
  it("prints data.processName in the slot when set", () => {
    const arr = allText(buildTravelerDefinition(travelerData({ processName: "Marquench + Temper" })));
    expect(arr[arr.indexOf("Process:") + 2]).toBe("Marquench + Temper");
  });

  it("blank renders exactly today's empty slot", () => {
    const arr = allText(buildTravelerDefinition(travelerData()));
    expect(arr[arr.indexOf("Process:") + 2]).toBe("");
  });
});

describe("buildTravelerDefinition — logo placement (spec §6.3)", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 120 };
    return checked(c);
  };
  /** The header's three column stacks, structurally. */
  const headerStacks = (def: unknown): { image?: string; width?: number }[][] => {
    const sheet = (def as { content: { stack: { columns: { stack: never[] }[] }[] }[] }).content[0];
    return sheet.stack[0].columns.map((col) => col.stack);
  };

  it.each([["header-left", 0], ["header-center", 1], ["header-right", 2]] as const)(
    "a placed logo joins the %s slot at its configured width", (placement, colIdx) => {
      const def = buildTravelerDefinition(travelerData(), placedConfig(placement), LOGO_URI);
      const stacks = headerStacks(def);
      expect(stacks[colIdx][0]).toEqual({ image: LOGO_URI, width: 120 });
      // The barcode is untouched by the logo.
      expect(JSON.stringify(def)).toContain(BARCODE);
    });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    // Placed in config, but the resolved version carries no bytes → no logo node.
    const placed = buildTravelerDefinition(travelerData(), placedConfig("header-center"));
    expect(JSON.stringify(placed)).not.toContain(LOGO_URI);
    // Bytes supplied, but the config places no logo → no logo node.
    const unplaced = buildTravelerDefinition(travelerData(), cfg(), LOGO_URI);
    expect(JSON.stringify(unplaced)).not.toContain(LOGO_URI);
  });
});

describe("buildTravelerDefinition — purity, config included", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg();
    c.logo = { placement: "header-center", width: 120 };
    fieldOf(c, "lines", "line_qty").label = "Pieces";
    const config = checked(c);
    const def = buildTravelerDefinition(travelerData(), config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildTravelerDefinition(travelerData(), config, LOGO_URI)).toEqual(def);
  });
});

// ------------------------------------------------------------------------------------------------
// readTravelerData — processName binds LIVE from the lead part (ruling 4, spec §5.7)
// ------------------------------------------------------------------------------------------------

describe("readTravelerData — processName", () => {
  beforeEach(truncateAll);

  it("reads the lead part's processName and prints it", async () => {
    const { order } = await miniOrder({ processName: "Marquench + Temper" });
    const data = await asSystem(() => collectTravelerData(order.id));
    expect(data.processName).toBe("Marquench + Temper");
    expect(textOf(buildTravelerDefinition(data))).toContain("Marquench + Temper");
  });

  it("a part without one keeps today's blank slot", async () => {
    const { order } = await miniOrder();
    const data = await asSystem(() => collectTravelerData(order.id));
    expect(data.processName).toBe("");
  });

  it("binds LIVE at render — a later part edit changes the NEXT print's slot", async () => {
    const { order, part } = await miniOrder();
    await prisma.part.update({ where: { id: part.id }, data: { processName: "Austemper" } });
    const data = await asSystem(() => collectTravelerData(order.id));
    expect(data.processName).toBe("Austemper");
  });
});

// ------------------------------------------------------------------------------------------------
// printTraveler — resolution on the claimed tx + the stamp (brief item 3)
// ------------------------------------------------------------------------------------------------

/** Image XObjects in the stored bytes — dict headers are plain text even when the pixel data is
 *  compressed, so a logo shows up as a second image beside the per-sheet barcode. A PNG with an
 *  alpha channel embeds as TWO objects (the image + its /SMask), so SMask children are excluded:
 *  this counts PICTURES on the paper, not XObjects in the file. */
const countImages = (pdf: Buffer): number => {
  const objs = parseObjects(pdf);
  const smasks = new Set<number>();
  for (const o of objs.values()) {
    for (const m of o.body.matchAll(/\/SMask\s+(\d+)\s+0\s+R/g)) smasks.add(Number(m[1]));
  }
  return [...objs.entries()]
    .filter(([num, o]) => /\/Subtype\s*\/Image/.test(o.body) && !smasks.has(num)).length;
};

async function stampOf(documentId: string): Promise<string | null> {
  const row = await prisma.storedDocument.findUnique({
    where: { id: documentId }, select: { templateVersionId: true },
  });
  return row!.templateVersionId;
}

describe("printTraveler — template resolution and the version stamp", () => {
  beforeEach(truncateAll);

  /** Create → tweak the v1 draft → (optionally logo) → publish. Returns the published version. */
  async function publishCustom(
    tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string },
  ) {
    const t = await asSystem(() => createTemplate("TRAVELER", "Custom"));
    const c = cfg();
    tweak(c);
    await asSystem(() => editDraft(t.id, { config: c, updatedAt: t.draft.updatedAt }));
    if (logo) await asSystem(() => uploadLogo(t.id, logo.data, logo.mime));
    const { versionId } = await asSystem(() => publishDraft(t.id));
    return { templateId: t.id, versionId };
  }

  it("no assignment resolves the seeded Standard default and stamps ITS version id", async () => {
    const { order } = await miniOrder();
    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    expect(pageCount(pdf)).toBe(1); // the single-load fixture
    expect(drawnText(pdf)).toContain("Order Number");
    expect(await stampOf(documentId)).toBe(templateVersionId("TRAVELER"));
  });

  it("a customer-assigned template's PUBLISHED config prints — not the default — and its version id lands on the row", async () => {
    const { customer, order } = await miniOrder();
    const { templateId, versionId } = await publishCustom((c) => {
      fieldOf(c, "header", "order_number").label = "WO#";
    });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));

    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    const text = drawnText(pdf);
    expect(text).toContain("WO#");
    expect(text).not.toContain("Order Number");
    expect(await stampOf(documentId)).toBe(versionId);
  });

  it("a draft on the assigned template does NOT affect the print — §5.1 immutability through the real path", async () => {
    const { customer, order } = await miniOrder();
    const { templateId, versionId } = await publishCustom((c) => {
      fieldOf(c, "header", "order_number").label = "WO#";
    });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));

    // Open the next draft and change it — unpublished work must never reach paper.
    const draft = await asSystem(() => openDraft(templateId));
    const c = cfg();
    fieldOf(c, "header", "order_number").label = "DRAFT-ONLY-MARKER";
    await asSystem(() => editDraft(templateId, { config: c, updatedAt: draft.updatedAt }));

    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    const text = drawnText(pdf);
    expect(text).toContain("WO#");
    expect(text).not.toContain("DRAFT-ONLY-MARKER");
    expect(await stampOf(documentId)).toBe(versionId);
  });

  it("a placed PNG logo prints; the no-logo print carries the barcode alone", async () => {
    const { customer, order } = await miniOrder();
    const bare = await asSystem(() => printTraveler(order.id));
    expect(countImages(bare.pdf)).toBe(1); // the barcode

    const { templateId } = await publishCustom(
      (c) => { c.logo = { placement: "header-center", width: 120 }; },
      { data: await barcodePng("LOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));
    const withLogo = await asSystem(() => printTraveler(order.id));
    expect(countImages(withLogo.pdf)).toBe(2);
  });

  it("a placed JPEG logo prints through the JPEG data-uri path", async () => {
    const { customer, order } = await miniOrder();
    const { templateId } = await publishCustom(
      (c) => { c.logo = { placement: "header-right", width: 40 }; },
      { data: TINY_JPEG, mime: "image/jpeg" });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));
    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(countImages(pdf)).toBe(2);
    expect(pdf.toString("latin1")).toContain("DCTDecode"); // a JPEG embeds as DCT, never Flate
  });

  it("uploaded logo bytes with no config placement stay off the paper", async () => {
    const { customer, order } = await miniOrder();
    const { templateId } = await publishCustom(() => undefined,
      { data: await barcodePng("LOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));
    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(countImages(pdf)).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
// #36 — per-load sheet groups (Task 8): buildTravelerDefinitions + the identity band
// ------------------------------------------------------------------------------------------------

describe("buildTravelerDefinitions — one definition per load (pure)", () => {
  const twoSheetData = () => travelerData({
    sheets: [
      { loadNumber: 1, loadQty: 336, loadWeight: 4536 },
      { loadNumber: 2, loadQty: 164, loadWeight: 2214 },
    ],
  });

  it("returns one definition per sheet, each content-identical to the singular's per-sheet stack", () => {
    const defs = buildTravelerDefinitions(twoSheetData());
    expect(defs).toHaveLength(2);
    const singular = buildTravelerDefinition(twoSheetData());
    const singularStacks = (singular.content as { stack: unknown }[]).map((c) => c.stack);
    const groupStacks = defs.map((d) => (d.content as { stack: unknown }[])[0].stack);
    expect(groupStacks).toEqual(singularStacks);
  });

  it("each definition carries ITS load's identity band — order number, that load, the barcode — with the margin reserve", () => {
    const defs = buildTravelerDefinitions(twoSheetData());
    for (const [i, def] of defs.entries()) {
      const spec = def.continuationHeaderSpec!;
      expect(spec.overflowTopMargin).toBeGreaterThanOrEqual(54); // the 44pt barcode + its offset must fit
      const bandText = allText(spec.content).join("\n");
      expect(bandText).toContain("Order Number 71246");
      expect(bandText).toContain(`Load ${i + 1}`);
      expect(bandText).toContain("(continued)");
      expect(JSON.stringify(spec.content)).toContain(BARCODE);
    }
    // Never a following load's number on the wrong band.
    expect(allText(defs[0].continuationHeaderSpec!.content).join("\n")).not.toContain("Load 2");
  });

  it("a null-load sheet's band omits the load line and label overrides carry through", () => {
    const c = cfg();
    fieldOf(c, "header", "order_number").label = "WO#";
    const defs = buildTravelerDefinitions(
      travelerData({ sheets: [{ loadNumber: null, loadQty: null, loadWeight: null }] }), checked(c));
    const bandText = allText(defs[0].continuationHeaderSpec!.content).join("\n");
    expect(bandText).toContain("WO# 71246");
    expect(bandText).not.toContain("Load");
  });

  it("the identity band ignores the visibility flags — a page torn loose still names its work", () => {
    // `order_number`/`load_number` are removable ON THE SHEET (the contract marks them so), but
    // the continuation band is the barcode treatment: identity on shop paper is locked, not
    // configurable. Hiding them must empty the sheet's header block, never the band.
    const c = cfg();
    fieldOf(c, "header", "order_number").visible = false;
    fieldOf(c, "header", "load_number").visible = false;
    const defs = buildTravelerDefinitions(twoSheetData(), checked(c));
    const bandText = allText(defs[1].continuationHeaderSpec!.content).join("\n");
    expect(bandText).toContain("Order Number 71246");
    expect(bandText).toContain("Load 2");
    expect(JSON.stringify(defs[1].continuationHeaderSpec!.content)).toContain(BARCODE);
    // …and the sheet body itself did honour the flags.
    expect(textOf(defs[1].content)).not.toContain("Order Number");
  });

  it("the pageFooter knob turns on the per-group footer spec and widens the bottom margin; default stays off", () => {
    const on = cfg();
    on.pageFooter = true;
    const withFooter = buildTravelerDefinitions(travelerData(), checked(on));
    expect(withFooter[0].pageFooterSpec).toEqual({ kind: "pageNofM" });
    expect(withFooter[0].pageMargins).toEqual([24, 24, 24, 44]);

    const dflt = buildTravelerDefinitions(travelerData());
    expect(dflt[0].pageFooterSpec).toBeUndefined();
    expect(dflt[0].pageMargins).toEqual([24, 24, 24, 24]); // golden — today's margins exactly
  });

  it("is pure: plain JSON, deterministic, spec keys included", () => {
    const defs = buildTravelerDefinitions(twoSheetData());
    expect(JSON.parse(JSON.stringify(defs))).toEqual(defs);
    expect(buildTravelerDefinitions(twoSheetData())).toEqual(defs);
  });
});

describe("printTraveler — sheet groups through the real path (#36)", () => {
  beforeEach(truncateAll);

  /** A single-load order whose recipe overflows LETTER: 25 steps with wrapping instructions. */
  async function overflowOrder() {
    const customer = await prisma.customer.create({ data: { code: "OVF", name: "Overflow Co" } });
    const code = await prisma.processStepCode.create({ data: { code: "AUS", name: "Austemper" } });
    const part = await prisma.part.create({
      data: {
        customerId: customer.id, partNumber: "OVF-1", name: "Overflow Part",
        eachWeight: "1.0000", loadQty: 100,
      },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const instruction =
      "Ramp the furnace to soak temperature, hold until the whole load equalizes, verify with " +
      "the pyrometer log, then transfer to the quench within the allowed window and record the " +
      "elapsed transfer time on this line before the next step begins.";
    await prisma.partProcessStep.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        revisionId: rev.id, position: i + 1, codeId: code.id, instruction,
      })),
    });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "10.00" }],
    }));
    return { order };
  }

  it("a 20+-step recipe overflows one load's sheet and the continuation page carries order number, load number and barcode", async () => {
    const { order } = await overflowOrder();
    const { pdf } = await asSystem(() => printTraveler(order.id, 1));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);

    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("(continued)");
    expect(pages[1]).toContain(`Order Number ${order.orderNumber}`);
    expect(pages[1]).toContain("Load 1");
    expect(pages[1]).toContain("(continued)");
    // The band's barcode is painted on the continuation page (page one's is the sheet's own).
    expect(paintedImageCounts(pdf)[1]).toBeGreaterThanOrEqual(1);
  });

  it("the pageFooter knob restarts numbering per load group through the traveler path", async () => {
    const { customer, order } = await miniOrder({ loadQty: 5 }); // two loads
    const t = await asSystem(() => createTemplate("TRAVELER", "Footered"));
    const c = cfg();
    c.pageFooter = true;
    await asSystem(() => editDraft(t.id, { config: c, updatedAt: t.draft.updatedAt }));
    await asSystem(() => publishDraft(t.id));
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", t.id));

    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(pageCount(pdf)).toBe(2);
    const pages = drawnPages(pdf);
    // Each one-page load group numbers ITSELF: "Page 1 of 1" twice, never "of 2".
    expect(pages[0]).toContain("Page 1 of 1");
    expect(pages[1]).toContain("Page 1 of 1");
    expect(drawnText(pdf)).not.toContain("of 2");
  });

  it("the default multi-load print is a merge with today's content — no footer, no band, one barcode per page", async () => {
    const { order } = await miniOrder({ loadQty: 5 }); // two loads
    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(pageCount(pdf)).toBe(2);
    const text = drawnText(pdf);
    expect(text).not.toContain("(continued)");
    expect(text).not.toMatch(/Page \d+ of \d+/);
    expect(paintedImageCounts(pdf)).toEqual([1, 1]);
    // Each page still carries its own load's sheet (the header prints label and value as
    // separate nodes, so they are asserted separately).
    const pages = drawnPages(pdf);
    for (const page of pages) {
      expect(page).toContain("Order Number");
      expect(page).toContain(String(order.orderNumber));
    }
  });

  it("a non-overflowing single-load print stays content-identical to the pre-Task-8 render", async () => {
    const { order } = await miniOrder();
    const data = await asSystem(() => collectTravelerData(order.id, 1));
    const legacy = await renderPdf(buildTravelerDefinition(data));
    const { pdf } = await asSystem(() => printTraveler(order.id, 1));
    expect(pageCount(pdf)).toBe(1);
    expect(drawnText(pdf)).toBe(drawnText(legacy));
  });
});
