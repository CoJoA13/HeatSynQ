// Practice-database DEMO SEED (Phase 8B §5.2). A representative slice of a real heat-treat shop,
// built STRICTLY THROUGH the existing service entrypoints — never a naive `createMany`, never a
// hand-written `*_number_next` counter (every document number is bumped by `allocateNumber` inside
// the service that consumes it), so the slice faithfully mimics every invariant the app enforces:
// soft-delete, partial-unique, audited-create, the singletons, the order-entry gate (§5.6).
//
// `import "dotenv/config"` is FIRST and deliberate — the singleton in `src/server/db.ts` reads
// `DATABASE_URL` at module-evaluation time and throws if it is unset, so it must be loaded before
// any service (which transitively imports `./db`) is imported. dotenv never overrides an already-set
// var, so a test process that has already pointed `DATABASE_URL` at `erp_test` is unaffected.
import "dotenv/config";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { prisma } from "../src/server/db";
import { runWithContext } from "../src/server/context";
import { assertPracticeDatabase } from "../src/server/practice-mode";
import { hashPassword } from "../src/server/password";
import { ALL_PERMISSIONS } from "../src/server/permissions";
import { todayDateOnly, formatDateOnly } from "../src/lib/business-days";

import { createReference } from "../src/server/reference";
import { createStepCode } from "../src/server/process-step-codes";
import { createSurcharge } from "../src/server/surcharges";
import { setBillingConfig } from "../src/server/billing-config";
import { setSetting } from "../src/server/settings";
import { createCustomer } from "../src/server/customers";
import { addAddress } from "../src/server/customer-addresses";
import { addContact } from "../src/server/customer-contacts";
import { createPart } from "../src/server/parts";
import { addStep } from "../src/server/part-process-steps";
import { addPartPrice, addPriceBreak } from "../src/server/part-prices";
import { addPartSpec } from "../src/server/part-specifications";
import { addPartInspection } from "../src/server/part-inspections";
import { createOrder } from "../src/server/orders";
import { createShipper } from "../src/server/shippers";
import { createInvoice, finalizeInvoice } from "../src/server/invoices";
import { createBatch, addPayment, postBatch } from "../src/server/receipts";

// -------------------------------------------------------------------------------------------
// Thin id-returning wrappers so the orchestration below reads as a dependency graph, not a wall of
// `.id` unwraps. Each delegates to exactly one service entrypoint.
// -------------------------------------------------------------------------------------------

const gl = async (name: string, description: string): Promise<string> =>
  (await createReference("glAccount", { name, description })).id;

const ref = async (kind: string, input: Record<string, unknown>): Promise<string> =>
  (await createReference(kind, input)).id;

const stepCode = async (
  code: string, name: string, glAccountId: string, equipmentTag: string,
): Promise<string> => (await createStepCode({ code, name, glAccountId, equipmentTag })).id;

const customer = async (input: Record<string, unknown>): Promise<string> =>
  (await createCustomer(input)).id;

const part = async (input: Record<string, unknown>): Promise<string> =>
  (await createPart(input)).id;

/**
 * The orchestration, run inside a system actor context so the audit layer knows who acted (the
 * services write audit rows for every mutation, and `auditedCreate`/`auditedUpdate` read the actor
 * from `AsyncLocalStorage`). `{ id: null, name: "demo-seed" }` is the system-actor shape the test
 * helpers use.
 */
async function run(): Promise<void> {
  await bootstrapAuth();

  const today = formatDateOnly(todayDateOnly());

  // --- 1. Company identity (the order-entry gate's first predicate — set BEFORE any order) -----
  await setSetting("company_name", "Summit Heat Treating, Inc.");
  await setSetting("company_address", "1450 Furnace Road\nCleveland, OH 44101");
  await setSetting("company_phone", "(216) 555-0142");

  // --- 2. Chart of accounts (the gate's second predicate) --------------------------------------
  const glAR = await gl("1200", "Accounts Receivable");
  const glCash = await gl("1000", "Cash — Operating");
  const glTax = await gl("2200", "Sales Tax Payable");
  const glRevenue = await gl("4010", "Heat Treat Revenue");
  const glSurcharge = await gl("4020", "Surcharge Revenue");
  const glCert = await gl("4030", "Certification Revenue");
  const glFreight = await gl("4100", "Freight Billed");
  const glOther = await gl("4900", "Other Charges");
  const glDiscount = await gl("4950", "Sales Discounts");
  const glWriteOff = await gl("6100", "Bad Debt Expense");

  // --- 3. Reference tables ---------------------------------------------------------------------
  const matCarb = await ref("material", { name: "8620 Carburizing Steel" });
  const matAlloy = await ref("material", { name: "4140 Alloy Steel" });
  await ref("material", { name: "A2 Tool Steel" });

  const termsNet30 = await ref("terms", { name: "Net 30", netDays: 30 });
  const terms2pct = await ref("terms", {
    name: "2% 10 Net 30", netDays: 30, discountPercent: "2.00", discountDays: 10,
  });

  const carrierFedex = await ref("carrier", { name: "FedEx Freight" });
  await ref("carrier", { name: "Customer Pickup" });

  await ref("containerType", { name: "Steel Basket" });
  await ref("containerType", { name: "Wire Basket" });
  await ref("containerType", { name: "Wooden Crate" });

  const scaleHRC = await ref("inspectionScale", { name: "Rockwell C" });
  await ref("inspectionScale", { name: "Rockwell B" });

  const icSurf = await ref("inspectionCode", { name: "SURF-HRC", defaultScaleId: scaleHRC });
  const icCore = await ref("inspectionCode", { name: "CORE-HRC", defaultScaleId: scaleHRC });

  const ptCheck = await ref("paymentType", { name: "Check", glAccountId: glCash });
  await ref("paymentType", { name: "ACH", glAccountId: glCash });
  await ref("paymentType", { name: "Wire Transfer", glAccountId: glCash });

  const specAMS = await ref("specification", {
    name: "AMS 2759", text: "General heat treatment requirements for steel parts.",
  });
  await ref("specification", { name: "MIL-STD-1684", text: "Thermal processing of ferrous alloys." });

  await ref("endingStatement", {
    name: "Standard Quote Terms",
    text: "Prices firm for 30 days. FOB our dock. Certifications furnished on request.",
    isDefault: true,
  });

  // --- 4. Process step codes (each posts revenue to a GL account) -------------------------------
  const scHarden = await stepCode("HT-100", "Neutral Harden", glRevenue, "FURN-1");
  const scTemper = await stepCode("HT-200", "Temper", glRevenue, "TEMP-1");
  const scCarb = await stepCode("HT-300", "Carburize & Harden", glRevenue, "FURN-2");
  await stepCode("HT-400", "Stress Relieve", glRevenue, "FURN-3");
  const scCert = await stepCode("CERT", "Certification", glCert, "");

  // --- 5. Surcharges ---------------------------------------------------------------------------
  await createSurcharge({
    name: "Energy Surcharge", kind: "PERCENT", rate: "0.035000", glAccountId: glSurcharge, position: 0,
  });
  await createSurcharge({
    name: "Small Lot Charge", kind: "FLAT", amount: "25.00", glAccountId: glSurcharge, position: 1,
  });

  // --- 6. Billing config (sets arGlAccountId — the gate's third predicate — plus the plant-level
  //        cert-billing defaults; per-part Part.billForCert/certCharge have no service writer, so
  //        cert billing rides entirely on these defaults — owner decision 7). ------------------
  await setBillingConfig({
    arGlAccountId: glAR,
    salesTaxRate: "0.070000",
    salesTaxGlAccountId: glTax,
    freightGlAccountId: glFreight,
    otherChargeGlAccountId: glOther,
    certChargeStepCodeId: scCert,
    certChargeDefault: "35.00",
    billForCertDefault: true,
    financeChargeRate: "0.0150",
    discountGlAccountId: glDiscount,
    writeOffGlAccountId: glWriteOff,
  });

  // --- 7. Customers — a parent + a division (parentId), plus one independent shop ---------------
  const aero = await customer({
    code: "AERO", name: "Aerospace Dynamics Corp", termsId: termsNet30,
  });
  const aeroMw = await customer({
    code: "AERO-MW", name: "Aerospace Dynamics — Midwest Division",
    parentId: aero, termsId: termsNet30, taxable: true,
  });
  const prec = await customer({
    code: "PREC", name: "Precision Gear Works", termsId: terms2pct,
  });

  await addAddress(aeroMw, {
    kind: "SHIP_TO", name: "Aerospace Dynamics — Midwest",
    street: "8800 Industrial Pkwy", city: "Toledo", state: "OH", zip: "43604",
  });
  await addContact(aeroMw, {
    name: "Dana Reyes", email: "dreyes@example.com", phone: "419-555-0110",
    getsInvoices: true, getsCerts: true,
  });
  await addAddress(prec, {
    kind: "SHIP_TO", name: "Precision Gear Works",
    street: "27 Millwright Ave", city: "Erie", state: "PA", zip: "16501",
  });
  await addContact(prec, {
    name: "Sam Okafor", email: "sokafor@example.com", phone: "814-555-0177", getsInvoices: true,
  });

  // --- 8. Parts — recipes (addStep), pricing (addPartPrice/addPriceBreak), specs, inspections ---
  const ringGear = await part({
    customerId: aeroMw, partNumber: "3541720C3", name: "Ring Gear",
    description: "Carburized ring gear, 12 in OD", processName: "Carburize / Harden / Temper",
    materialId: matCarb, eachWeight: "13.5000", loadQty: 336, loadWeight: "4800.00",
    // Part.certRequired/certScope ARE writable via createPart (unlike the billForCert/certCharge
    // pair). LOAD scope is the one Phase 4 never creates eagerly, so this exercises plant-level
    // cert BILLING (the invoice cert charge) without seeding an eager Cert row.
    certRequired: true, certScope: "LOAD",
  });
  await addStep(ringGear, {
    codeId: scCarb, instruction: "Carburize at 1700°F to 0.040 in effective case, oil quench.",
  });
  await addStep(ringGear, { codeId: scTemper, instruction: "Temper at 325°F for 2 hours." });
  const rgPrice = (await addPartPrice(ringGear, {
    processStepCodeId: scCarb, position: 0, unitPrice: "6.5000", minimumCharge: "250.00", pricePer: "EACH",
  })).id;
  await addPriceBreak(ringGear, rgPrice, { threshold: "1000.00", price: "5.7500" });
  await addPartSpec(ringGear, specAMS);
  await addPartInspection(ringGear, {
    inspectionCodeId: icSurf, scaleId: scaleHRC, min: "58.0000", max: "62.0000",
    sampleQty: "3", location: "Gear tooth flank", sort: 0,
  });
  await addPartInspection(ringGear, {
    inspectionCodeId: icCore, scaleId: scaleHRC, min: "30.0000", max: "40.0000",
    sampleQty: "1", location: "Core", sort: 1,
  });

  const pinion = await part({
    customerId: prec, partNumber: "PGW-88A", name: "Pinion Shaft",
    description: "Splined pinion shaft", processName: "Harden / Temper",
    materialId: matAlloy, eachWeight: "2.2500", loadQty: 500, loadWeight: "1200.00",
  });
  await addStep(pinion, { codeId: scHarden, instruction: "Austenitize at 1550°F, oil quench." });
  await addStep(pinion, { codeId: scTemper, instruction: "Temper at 400°F for 2 hours." });
  await addPartPrice(pinion, {
    processStepCodeId: scHarden, position: 0, unitPrice: "1.8500", minimumCharge: "150.00", pricePer: "EACH",
  });
  await addPartSpec(pinion, specAMS);
  await addPartInspection(pinion, {
    inspectionCodeId: icCore, scaleId: scaleHRC, min: "40.0000", max: "48.0000",
    sampleQty: "2", location: "Mid-shaft", sort: 0,
  });

  // --- 9. Orders in four states (OPEN / PARTIAL_SHIPPED / SHIPPED / INVOICED) -------------------

  // OPEN — created and left untouched.
  await createOrder({
    customerId: prec, poNumber: "PO-PGW-5501",
    lines: [{ partId: pinion, qty: 500, weight: "1125.00" }],
  });

  // PARTIAL_SHIPPED — one load of two shipped, line not marked complete.
  const partial = (await createOrder({
    customerId: aeroMw, poNumber: "PO-AD-7720",
    lines: [{ partId: ringGear, qty: 672, weight: "9072.00" }],
  })).order;
  await createShipper({
    customerId: aeroMw, shipDate: today,
    orders: [{
      orderId: partial.id,
      lines: [{ orderLineId: partial.lines[0].id, qty: 336, weight: "4536.00", lineComplete: false }],
    }],
  }, { canOverrideCreditHold: true });

  // SHIPPED — the whole line shipped and marked complete.
  const shipped = (await createOrder({
    customerId: prec, poNumber: "PO-PGW-5502",
    lines: [{ partId: pinion, qty: 250, weight: "562.50" }],
  })).order;
  await createShipper({
    customerId: prec, shipDate: today,
    orders: [{
      orderId: shipped.id,
      lines: [{ orderLineId: shipped.lines[0].id, qty: 250, weight: "562.50", lineComplete: true }],
    }],
  }, { canOverrideCreditHold: true });

  // INVOICED — shipped complete (with billed freight), then invoiced and finalized.
  const billable = (await createOrder({
    customerId: aeroMw, poNumber: "PO-AD-7721",
    lines: [{ partId: ringGear, qty: 336, weight: "4536.00" }],
  })).order;
  await createShipper({
    customerId: aeroMw, shipDate: today,
    carrierId: carrierFedex, billFreight: true, freightAmount: "185.00", proNumber: "PRO-77213",
    orders: [{
      orderId: billable.id,
      lines: [{ orderLineId: billable.lines[0].id, qty: 336, weight: "4536.00", lineComplete: true }],
    }],
  }, { canOverrideCreditHold: true });
  const { invoice } = await createInvoice({ orderId: billable.id });
  await finalizeInvoice(invoice.id);

  // --- 10. One POSTED payment batch ------------------------------------------------------------
  const batch = await createBatch({ depositDate: today, controlTotal: "2500.00", notes: "Demo deposit — parallel run" });
  await addPayment(batch.id, {
    customerId: aeroMw, paymentTypeId: ptCheck, amount: "2500.00", reference: "CHK 48201", receivedDate: today,
  });
  await postBatch(batch.id);
}

/**
 * Reproduces `seed.ts`'s auth bootstrap so the practice database is loginable — including after the
 * §5.3 reset, which re-runs `seedDemoSlice` on a truncated DB. Role BEFORE User (User.roleId
 * requires it). Find-then-create for the role (NOT upsert): `Role.name` is unique only among live
 * rows but the client still types it unique, so an upsert keyed on `name` alone could silently
 * reattach the admin to a soft-deleted role (the `seed.ts` reasoning, verbatim).
 */
async function bootstrapAuth(): Promise<void> {
  const admin =
    (await prisma.role.findFirst({ where: { name: "Admin", deletedAt: null } })) ??
    (await prisma.role.create({ data: { name: "Admin" } }));
  for (const permission of ALL_PERMISSIONS) {
    await prisma.rolePermission.upsert({
      where: { roleId_permission: { roleId: admin.id, permission } },
      update: {},
      create: { roleId: admin.id, permission },
    });
  }
  await prisma.user.upsert({
    where: { username: "admin" },
    update: { roleId: admin.id },
    create: {
      username: "admin",
      displayName: "Administrator",
      passwordHash: await hashPassword("admin"),
      roleId: admin.id,
    },
  });
}

/**
 * The internal orchestration — exercised directly against `erp_test` in CI (the db-identity
 * guard-split: the happy path can only run where vitest connects, i.e. NOT `erp_practice`). Takes no
 * `db`/`tx`: 15/17 of the services it calls have no `tx` parameter and write through the module-level
 * `src/server/db.ts` singleton, so the whole slice runs against the ambient `DATABASE_URL`-pointed
 * connection, and the practice guard is a process-level `current_database()` pre-check
 * (`seedPracticeDemo`), NOT a transaction wrapping the seed.
 */
export function seedDemoSlice(): Promise<void> {
  return runWithContext({ actor: { id: null, name: "demo-seed" }, user: null }, run);
}

/**
 * The db-identity-GUARDED entry (§5.3). Refuses outright unless the connected database is
 * `erp_practice`, so running `db:seed:demo` (or the reset) against production or the test DB throws
 * before a single row is written. This refusal is the RED safety test in `erp_test`.
 */
export async function seedPracticeDemo(): Promise<void> {
  await assertPracticeDatabase();
  await seedDemoSlice();
}

// The runnable entry `tsx prisma/demo-seed.ts` (npm run db:seed:demo) calls the GUARDED entry, so it
// refuses unless connected to erp_practice. IT READS `DATABASE_URL`: inside the app-practice
// container that already points at erp_practice, so it just works there; run it LOCALLY with the
// practice URL, e.g. `DATABASE_URL="$DATABASE_URL_PRACTICE" npm run db:seed:demo`. (Running it with
// the default DATABASE_URL is harmless — the guard refuses before writing a row.) Guarded by a
// main-module check so importing this file (the vitest suite does) never triggers a run.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  seedPracticeDemo()
    .then(() => console.log("Seeded the practice demo slice (admin/admin — change the password after first login)."))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
