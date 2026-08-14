import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import { drawnText, paintedImageCounts } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { getDocument } from "@/server/documents";
import {
  createTemplate, editDraft, publishDraft, uploadLogo,
} from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { printTraveler } from "@/server/traveler";
import { readPreviewContext, renderPreview } from "@/server/template-preview";
import { TRAVELER_DEFAULT_CONFIG, type TemplateConfig } from "@/lib/template-contracts/index";

/**
 * Phase 7 Task 21 — THE RESTYLE-PRINT PROOF (the roadmap's Phase 7 testable outcome, verbatim:
 * "Owner restyles the traveler/logo"). This is the capstone integration test: it drives the WHOLE
 * loop through the REAL services an owner would touch, then decodes the STORED bytes.
 *
 *   create a traveler draft → upload the fixture logo (e2e/fixtures/logo.png) + rename a label to a
 *   distinctive marker → PREVIEW (the side-effect-free render — the marker shows) → PUBLISH → ASSIGN
 *   the published template to the order's customer → PRINT that order's real traveler → decode the
 *   ARCHIVED bytes (via the /Length-hardened tests/helpers/pdf.ts) and assert BOTH the renamed-label
 *   marker AND the placed logo made it onto the paper, and that `StoredDocument.templateVersionId`
 *   carries the published version's id.
 *
 * The unit/integration form is the LOAD-BEARING one (brief item 1): the E2E harness can drive the
 * editor/preview/assignment UI — the existing `templates-admin` flow does — but it cannot decode PDF
 * bytes, and "the paper shows it" is a byte-level fact. So the decode + stamp assertion lives here.
 *
 * RED (the restyle assertion's failing precondition): the SECOND test pins the direction this proof
 * fails in — an UNpublished/unassigned restyle never reaches the paper; `printTraveler` falls to the
 * seeded Standard default (no marker, no logo, the standard-traveler-v1 stamp). Remove the publish +
 * assign from the first test and its `toContain(MARKER)` fails against exactly that state.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** The real fixture logo Task 17's E2E flow uploads (a genuine 160×48 RGB PNG), resolved relative
 *  to this test file so the suite's cwd doesn't matter. */
const FIXTURE_LOGO = readFileSync(new URL("../e2e/fixtures/logo.png", import.meta.url));

/** The distinctive restyle marker — a renamed field label that appears NOWHERE in today's paper,
 *  so its presence in the decoded bytes can only mean the published restyle produced them. */
const MARKER = "RESTYLED-TRAVELER-MARKER";

/** A minimal single-load order (loadQty ≥ qty → exactly one load, one traveler sheet) — the
 *  tests/traveler-templates.test.ts fixture. */
async function miniOrder() {
  const customer = await prisma.customer.create({ data: { code: "RST", name: "Restyle Test Co" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUS", name: "Austemper" } });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "RST-1", name: "Restyle Part",
      eachWeight: "1.0000", loadQty: 100,
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

/** The restyle: rename the header's order-number label to the marker AND place the header logo. */
function restyled(): TemplateConfig {
  const c = structuredClone(TRAVELER_DEFAULT_CONFIG);
  c.sections.find((s) => s.key === "header")!.fields.find((f) => f.key === "order_number")!.label = MARKER;
  c.logo = { placement: "header-center", width: 120 };
  return c;
}

/** Total pictures painted across every page of a stored document (logo + per-sheet barcode). */
const imageCount = (pdf: Buffer): number => paintedImageCounts(pdf).reduce((a, b) => a + b, 0);

async function storedStamp(documentId: string): Promise<string | null> {
  const row = await prisma.storedDocument.findUnique({
    where: { id: documentId }, select: { templateVersionId: true },
  });
  return row!.templateVersionId;
}

describe("Phase 7 roadmap outcome — owner restyles the traveler/logo, publishes, prints, the paper shows it", () => {
  beforeEach(truncateAll);

  it("upload logo + rename a label → preview → publish → assign → print: the STORED pdf carries the restyle and the version stamp", async () => {
    const { customer, order } = await miniOrder();

    // 1. Create a draft from the Standard traveler template (create opens its v1 draft).
    const t = await asSystem(() => createTemplate("TRAVELER", "Restyled Traveler"));

    // 2. In the editor: rename the label to the marker and place a header logo, then upload the
    //    fixture logo bytes onto the draft (the Task-4 sniff/cap path).
    const config = restyled();
    await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
    await asSystem(() => uploadLogo(t.id, FIXTURE_LOGO, "image/png"));

    // 3. PREVIEW the WORKING draft against the real order — the side-effect-free render (spec §5.5):
    //    the marker and the logo both show, and NOTHING is archived.
    const beforePreview = await prisma.storedDocument.count();
    const ctx = await readPreviewContext(t.id);
    const previewPdf = await asSystem(() =>
      renderPreview(ctx, { config, recordId: order.id }, "preview-signer"));
    expect(drawnText(previewPdf)).toContain(MARKER);
    expect(imageCount(previewPdf)).toBe(2); // the placed logo + the barcode
    expect(await prisma.storedDocument.count()).toBe(beforePreview); // no StoredDocument, no side effect

    // 4. PUBLISH the draft (the edit_templates act) — v1 becomes the immutable published version.
    const { versionId } = await asSystem(() => publishDraft(t.id));

    // 5. ASSIGN the published traveler template to the order's customer so the print resolves it.
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", t.id));

    // 6. PRINT that order's real traveler.
    const { documentId } = await asSystem(() => printTraveler(order.id));

    // 7. THE PAPER SHOWS IT — decode the ARCHIVED bytes (read back from StoredDocument, not the
    //    returned buffer) and assert the restyle rode all the way onto the stored paper, plus the
    //    §5.2 version stamp.
    const stored = await getDocument(documentId);
    const paper = drawnText(stored.fileData);
    expect(paper).toContain(MARKER);
    expect(paper).not.toContain("Order Number"); // the contract default label is gone
    expect(imageCount(stored.fileData)).toBe(2); // the logo is now on the shop paper beside the barcode
    expect(await storedStamp(documentId)).toBe(versionId); // the §5.2 stamp names the published version
    expect(versionId).not.toBe(templateVersionId("TRAVELER")); // ...and it is NOT the Standard default's
  });

  it("RED direction — an UNpublished/unassigned restyle never reaches the paper: the print falls to the Standard default (no marker, no logo, the standard stamp)", async () => {
    const { order } = await miniOrder();

    // The same restyle work — but the draft is neither published nor assigned to the customer.
    const t = await asSystem(() => createTemplate("TRAVELER", "Restyled Traveler"));
    const config = restyled();
    await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
    await asSystem(() => uploadLogo(t.id, FIXTURE_LOGO, "image/png"));

    // Printing resolves the seeded Standard default (§5.2) — the restyle is invisible to the paper.
    const { documentId } = await asSystem(() => printTraveler(order.id));
    const stored = await getDocument(documentId);
    const paper = drawnText(stored.fileData);
    expect(paper).not.toContain(MARKER);
    expect(paper).toContain("Order Number"); // the default label, untouched
    expect(imageCount(stored.fileData)).toBe(1); // the barcode alone — no logo
    expect(await storedStamp(documentId)).toBe(templateVersionId("TRAVELER"));
  });
});
