import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { drawnText } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { createCert } from "@/server/certs";
import { replaceReadings } from "@/server/cert-results";
import { buildStatement } from "@/server/statements";
import { createTemplate } from "@/server/templates";
import {
  TRAVELER_DEFAULT_CONFIG, CERT_DEFAULT_CONFIG, STATEMENT_DEFAULT_CONFIG,
  type TemplateConfig, type TemplateDocTypeString,
} from "@/lib/template-contracts/index";
import { POST as previewRoute } from "@/app/api/templates/[id]/preview/route";

/**
 * Phase 7 Task 19 — the PREVIEW: `POST /api/templates/[id]/preview` renders the SUBMITTED
 * (working, possibly-unsaved) config against a real record the user picks, streaming PDF bytes
 * with ZERO side effects (spec §5.5). Gated on `templates.view` PLUS the record's own print-route
 * permission; the statement preview forces finance-charge assessment OFF and takes asOf/combineFamily.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function previewReq(id: string, cookie: string | undefined, body: unknown): Request {
  return new Request(`http://t/api/templates/${id}/preview`, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pdfOf(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

const cfgOf = (docType: TemplateDocTypeString): TemplateConfig => {
  const defaults: Record<string, TemplateConfig> = {
    TRAVELER: TRAVELER_DEFAULT_CONFIG, CERT: CERT_DEFAULT_CONFIG, STATEMENT: STATEMENT_DEFAULT_CONFIG,
  };
  return structuredClone(defaults[docType]);
};
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

// ------------------------------------------------------------------------------------------------
// Fixtures — a real order (traveler), cert, and customer-with-A/R (statement), the shapes the
// print-path suites (traveler-/cert-/statement-templates) already use.
// ------------------------------------------------------------------------------------------------

let seq = 0;
async function miniOrder() {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `PRV${seq}`, name: `Preview Co ${seq}` } });
  const code = await prisma.processStepCode.create({ data: { code: `AUS${seq}`, name: "Austemper" } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `PRV-${seq}`, name: "Preview Part", eachWeight: "1.0000", loadQty: 100 },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Pre-heat, then quench." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "10.00" }],
  }));
  return { customer, order };
}

async function certFixture() {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `CPV${seq}`, name: `Cert Preview Co ${seq}` } });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "BILL_TO", name: "AP", street: "1 St",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  const material = await prisma.material.create({ data: { name: `steel ${seq}` } });
  const scale = await prisma.inspectionScale.create({ data: { name: `HRC${seq}` } });
  const inspCode = await prisma.inspectionCode.create({
    data: { name: `As per P.O. (${seq})`, defaultScaleId: scale.id },
  });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `CPV-${seq}`, name: "Track Shoe", eachWeight: "21.5000", materialId: material.id },
  });
  await prisma.partInspection.create({
    data: { partId: part.id, inspectionCodeId: inspCode.id, scaleId: scale.id, min: "28.0000", max: "32.0000", sampleQty: "9", location: "OD", sort: 1 },
  });
  const stepCode = await prisma.processStepCode.create({ data: { code: `CPC-${seq}`, name: "Austenitize" } });
  const partRev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: partRev.id, position: 1, codeId: stepCode.id, instruction: "Austenitize at 1650F." } });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "PT1", lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
  }));
  let cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
  cert = await asSystem(() => replaceReadings(cert.id, {
    requirements: [{ id: cert.requirements[0].id, readings: [{ value: 30 }, { value: 31 }] }],
  }, { afterPrint: false }));
  return { customer, cert };
}

/** A customer with a past-due, non-exempt, finalized invoice AND a finance-charge rate — enough
 *  that assessing finance charges WOULD produce a nonzero line, so a preview that suppresses it is
 *  a real proof, not a vacuous one. */
async function statementCustomer(): Promise<{ id: string; total: number }> {
  seq += 1;
  const customer = await prisma.customer.create({
    data: { code: `SPV${seq}`, name: `Statement Preview Co ${seq}`, financeChargeRate: "1.5000" },
  });
  await prisma.customerAddress.create({
    data: { customerId: customer.id, kind: "BILL_TO", name: "AP", street: "600 12th St", city: "Columbus", state: "GA", zip: "31902", isDefault: true },
  });
  const order = await prisma.order.create({
    data: { orderNumber: 80000 + seq, customerId: customer.id, status: "SHIPPED", receivedDate: new Date("2026-05-01"), requestDate: new Date("2026-05-05") },
  });
  await prisma.invoice.create({
    data: {
      orderId: order.id, customerId: customer.id, kind: "INVOICE", status: "FINALIZED",
      invoiceDate: new Date("2026-05-10"), dueDate: new Date("2026-05-20"), finalizedAt: new Date("2026-05-10"), total: 400,
    },
  });
  return { id: customer.id, total: 400 };
}

/** A never-published TRAVELER template — create opens its v1 DRAFT; nothing is ever published. */
async function draftTemplate(docType: TemplateDocTypeString) {
  return asSystem(() => createTemplate(docType, `Draft ${docType} ${(seq += 1)}`));
}

// ------------------------------------------------------------------------------------------------

let full: string;          // templates.view + every record area
let templatesOnly: string; // templates.view, no record areas
let ordersOnly: string;    // orders.view, no templates.view

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
  full = await signInWith(
    ["templates.view", "orders.view", "shipping.view", "certs.view", "invoicing.view", "receivables.view", "quotes.view"],
    "pfull");
  templatesOnly = await signInWith(["templates.view"], "ptpl");
  ordersOnly = await signInWith(["orders.view"], "pord");
});

describe("POST /api/templates/[id]/preview — permission pairing (templates.view + the record area)", () => {
  it("401 signed out", async () => {
    const tpl = await draftTemplate("TRAVELER");
    const res = await previewRoute(previewReq(tpl.id, undefined, { recordId: "x", config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(401);
  });

  it("403 with templates.view but NOT the record area (orders.view for a traveler)", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const res = await previewRoute(
      previewReq(tpl.id, templatesOnly, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(403);
  });

  it("403 with the record area but NOT templates.view", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const res = await previewRoute(
      previewReq(tpl.id, ordersOnly, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(403);
  });

  it("200 with BOTH — streams application/pdf", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const res = await previewRoute(
      previewReq(tpl.id, full, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect((await pdfOf(res)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("404 for a missing/deleted template", async () => {
    const res = await previewRoute(previewReq("nope", full, { recordId: "x", config: cfgOf("TRAVELER") }), withParams({ id: "nope" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/templates/[id]/preview — the submitted config renders", () => {
  it("a label override in the SUBMITTED config appears in the preview bytes", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const c = cfgOf("TRAVELER");
    fieldOf(c, "header", "order_number").label = "WO-PREVIEW-MARKER";
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: c }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    const text = drawnText(await pdfOf(res));
    expect(text).toContain("WO-PREVIEW-MARKER");
    expect(text).not.toContain("Order Number");
  });

  it("an invalid / over-budget config 400s BEFORE any render", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const c = cfgOf("TRAVELER");
    fieldOf(c, "lines", "line_qty").width = 900; // 900 alone blows the 564pt content-width budget
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: c }), withParams({ id: tpl.id }));
    expect(res.status).toBe(400);
  });

  it("a NEVER-PUBLISHED draft still previews — it renders the submitted config directly (no resolve)", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER"); // created, v1 DRAFT open, never published
    const publishedCount = await prisma.documentTemplateVersion.count({
      where: { templateId: tpl.id, status: "PUBLISHED" },
    });
    expect(publishedCount).toBe(0);
    const c = cfgOf("TRAVELER");
    fieldOf(c, "header", "order_number").label = "NEVER-PUBLISHED-MARKER";
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: c }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(drawnText(await pdfOf(res))).toContain("NEVER-PUBLISHED-MARKER");
  });
});

describe("POST /api/templates/[id]/preview — the load-bearing side-effect-free invariant", () => {
  it("writes NO StoredDocument row", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const before = await prisma.storedDocument.count();
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(await prisma.storedDocument.count()).toBe(before);
  });

  it("does NOT set the cert's printedAt", async () => {
    const { cert } = await certFixture();
    const tpl = await draftTemplate("CERT");
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toBeNull();
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: cert.id, config: cfgOf("CERT") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toBeNull();
  });

  it("does NOT bump the draft's updatedAt", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const before = (await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } })).updatedAt;
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    const after = (await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } })).updatedAt;
    expect(after.getTime()).toBe(before.getTime());
  });
});

describe("POST /api/templates/[id]/preview — the statement preview (finance off, asOf/combineFamily)", () => {
  const ASOF = "2026-07-29";

  it("forces finance-charge assessment OFF — the line the same data WOULD produce is absent", async () => {
    const { id } = await statementCustomer();
    // Control: with assessment ON the setup produces a real finance charge, so the absence below is not vacuous.
    const assessed = await asSystem(() => buildStatement(id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: true }));
    expect(assessed.financeCharge).not.toBeNull();

    const tpl = await draftTemplate("STATEMENT");
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: id, asOf: ASOF, config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(drawnText(await pdfOf(res))).not.toContain("Finance Charge:");
  });

  it("honors asOf — an invoice not yet finalized as of the date does not appear", async () => {
    const { id } = await statementCustomer(); // finalizedAt 2026-05-10
    const tpl = await draftTemplate("STATEMENT");
    const early = await previewRoute(previewReq(tpl.id, full, { recordId: id, asOf: "2026-04-01", config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(early.status).toBe(200);
    expect(drawnText(await pdfOf(early))).not.toContain("$400.00");

    const late = await previewRoute(previewReq(tpl.id, full, { recordId: id, asOf: ASOF, config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(drawnText(await pdfOf(late))).toContain("$400.00");
  });

  it("honors combineFamily — a child's open item appears only when the family is combined", async () => {
    const parent = await prisma.customer.create({ data: { code: `PAR${(seq += 1)}`, name: `Parent ${seq}` } });
    await prisma.customerAddress.create({
      data: { customerId: parent.id, kind: "BILL_TO", name: "AP", street: "1 St", city: "Columbus", state: "GA", zip: "31902", isDefault: true },
    });
    const child = await statementCustomer();
    await prisma.customer.update({ where: { id: child.id }, data: { parentId: parent.id } });

    const tpl = await draftTemplate("STATEMENT");
    const alone = await previewRoute(previewReq(tpl.id, full, { recordId: parent.id, asOf: ASOF, combineFamily: false, config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(alone.status).toBe(200);
    expect(drawnText(await pdfOf(alone))).not.toContain("$400.00");

    const combined = await previewRoute(previewReq(tpl.id, full, { recordId: parent.id, asOf: ASOF, combineFamily: true, config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(drawnText(await pdfOf(combined))).toContain("$400.00");
  });
});
