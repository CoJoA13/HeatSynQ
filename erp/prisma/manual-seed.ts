// DEV-database MANUAL DATASET (the user manual + the pre-acceptance-month walkthrough).
//
// ============================================================================================
// ONE-SHOT, ADDITIVE. NOT re-runnable — a rebuild starts by dropping the database.
// ============================================================================================
// This LAYERS onto whatever is already in the dev database (specifically: onto `seedDemoSlice()`'s
// slice, which it looks up by natural key and builds on top of). It truncates nothing and
// re-seeds nothing.
//
// It is deliberately NOT idempotent. Every customer / part / reference code it creates is unique
// among LIVE rows, so a second run against an already-seeded database fails on the first
// duplicate code rather than quietly doubling the dataset. That is the safe failure: partial
// data is obvious, whereas a half-doubled dataset is not. There is no "reset" mode here — the
// reset IS dropping the database, which is what the documented rebuild does.
//
// THE REBUILD, in full (from `erp/`, and it is destructive to the dev database):
//
//     docker compose exec -T db psql -U erp -d postgres \
//       -c 'DROP DATABASE IF EXISTS erp WITH (FORCE);' -c 'CREATE DATABASE erp OWNER erp;'
//     npx prisma migrate deploy
//     npm run db:seed
//     npx tsx -e "import('./prisma/demo-seed.ts').then(m => m.seedDemoSlice()) \
//       .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })"
//     npx tsx prisma/manual-seed.ts
//
// The fourth step calls `seedDemoSlice` — the UNGUARDED internal orchestration — because
// `npm run db:seed:demo` runs the practice-guarded entry, which refuses on `erp` by design. That
// guard is correct and is deliberately NOT weakened; this reaches past it only for the dev
// database, and only behind this file's own dev-database guard below.
//
// Signing in afterwards: admin / heatsynq-demo (this script changes the password off the seeded
// default so the install-readiness warning clears). See docs/manual/dataset.md.
//
// DISCIPLINE — the demo-seed.ts contract, verbatim: everything is built STRICTLY THROUGH the
// existing service entrypoints. No naive `createMany`, no hand-written `*_number_next` bump, no
// direct write that dodges a claim. Every document number is allocated by `allocateNumber` inside
// the service that consumes it, every mutation is audited, and every soft-delete / partial-unique
// / row-claim / period-lock invariant is exercised exactly as the running app exercises it. That
// is the whole point: a dataset the app itself could have produced, so the manual's screenshots
// can never show a state the app forbids.
//
// The only direct `prisma` use below is READ-ONLY — `need*()` lookups of rows the demo slice
// already created, so this file can layer onto them by natural key. Nothing here writes a row
// except through a service.
//
// `import "dotenv/config"` is FIRST and deliberate — the singleton in `src/server/db.ts` reads
// `DATABASE_URL` at module-evaluation time and throws if it is unset, so it must be loaded before
// any service (which transitively imports `./db`) is imported.
import "dotenv/config";

import { prisma } from "../src/server/db";
import { runWithContext } from "../src/server/context";
import { HttpError } from "../src/server/errors";
import { formatDateOnly, todayDateOnly, addDays } from "../src/lib/business-days";

import { createReference } from "../src/server/reference";
import { createStepCode, setStepFields } from "../src/server/process-step-codes";
import { createSurcharge, setCustomerSurcharge } from "../src/server/surcharges";
import { createCustomer } from "../src/server/customers";
import { addAddress } from "../src/server/customer-addresses";
import { addContact } from "../src/server/customer-contacts";
import { createPart } from "../src/server/parts";
import { addStep } from "../src/server/part-process-steps";
import { addPartPrice, addPriceBreak } from "../src/server/part-prices";
import { addPartSpec } from "../src/server/part-specifications";
import { addPartInspection } from "../src/server/part-inspections";
import { createPartFieldDef } from "../src/server/part-field-defs";
import { setPartFieldValues } from "../src/server/part-field-values";
import { createOrder, voidOrder } from "../src/server/orders";
import { printTraveler } from "../src/server/traveler";
import {
  createShipper, voidShipper, reverseShipper, printBol, printShippingTickets,
} from "../src/server/shippers";
import { createCert, getCert, printCert } from "../src/server/certs";
import { replaceReadings } from "../src/server/cert-results";
import { createQuote, closeQuote, printQuote } from "../src/server/quotes";
import {
  createInvoice, finalizeInvoice, unlockInvoice, createCredit,
  replaceInvoiceLines, recalculateInvoice, getInvoice, printInvoice,
} from "../src/server/invoices";
import { createBatch, addPayment, postBatch } from "../src/server/receipts";
import { applyPayment, applyCredit, writeOffInvoice } from "../src/server/applications";
import { closePeriod, reopenPeriod } from "../src/server/close-periods";
import { exportClose } from "../src/server/gl-export";
import { printStatement } from "../src/server/statements";
import { createRole, setRolePermissions } from "../src/server/roles";
import { createUser, updateUser, setUserOverrides } from "../src/server/users";
import { createTemplate, publishDraft, openDraft } from "../src/server/templates";
import { assignTemplate } from "../src/server/template-assignments";
import { setSetupState } from "../src/server/setup-state";
import { runBackupNow } from "../src/server/backups";
// Aliased: `process-templates.ts` and `templates.ts` BOTH export `createTemplate`, and they are
// unrelated (a reusable step recipe vs. a document layout).
import {
  createTemplate as createProcessTemplate, addTemplateStep,
} from "../src/server/process-templates";

// ---------------------------------------------------------------------------------------------
// The guard — the MIRROR of demo-seed.ts's `assertPracticeDatabase` (§5.3).
//
// `assertPracticeDatabase` refuses unless the connected database IS `erp_practice`. This dataset
// is the opposite case: it belongs on the DEVELOPER's database and nowhere else, so it refuses
// unless the connected database is exactly `erp` AND is reached on localhost.
//
// The host check is NOT decoration and must not be "simplified" away. `docker-compose.yml`'s prod
// profile runs the app against `postgresql://erp:…@db:5432/erp` — the SAME database name this
// checks for — so a guard that read only `current_database()` would wave a production URL straight
// through while calling itself proof the script could never touch the wrong database. That is the
// `e2e/lib/db-fixtures.ts` `assertDevDb` lesson (Codex P1, PR #22), reused rather than re-derived:
// the name alone proves nothing, the HOST is the discriminator that actually holds.
//
// `current_database()` is read from the SERVER rather than parsed out of the URL, for the same
// reason `practice-mode.ts` reads it: db-identity is authoritative and a URL can lie about which
// database it lands on. The URL is consulted ONLY for the host, which the server cannot report.
//
// There is deliberately no override flag: an escape hatch on a data-writing guard is the kind of
// thing that gets set once and never unset.
// ---------------------------------------------------------------------------------------------

const DEV_DB_NAME = "erp";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

async function assertDevDatabase(): Promise<void> {
  const [row] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const name = row?.name ?? "";

  const url = process.env.DATABASE_URL;
  if (!url) throw new HttpError(403, "DATABASE_URL is not set.");
  const host = new URL(url).hostname;

  if (name !== DEV_DB_NAME || !LOCAL_HOSTS.has(host)) {
    throw new HttpError(
      403,
      `The manual dataset only builds on the LOCAL dev database — expected "${DEV_DB_NAME}" on ` +
        `localhost, got "${name}" on "${host}". Refusing to write: this script creates dozens of ` +
        `orders, invoices, payments and a CLOSED accounting period, and the production compose ` +
        `profile uses the database name "${DEV_DB_NAME}" too, so the name on its own proves nothing.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Read-only lookups of what the demo slice already built, by natural key. `findFirst` filtered on
// `deletedAt: null` throughout — NEVER `findUnique` on a soft-deletable unique column (CLAUDE.md:
// the generated client still types it unique, so `findUnique` compiles and silently returns the
// deleted row).
// ---------------------------------------------------------------------------------------------

function missing(kind: string, key: string): never {
  throw new Error(
    `Expected ${kind} "${key}" to already exist — this dataset LAYERS onto the demo slice. ` +
      `Seed it first (see docs/manual/dataset.md), then re-run.`,
  );
}

const needGl = async (name: string): Promise<string> =>
  (await prisma.glAccount.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("GL account", name);
const needTerms = async (name: string): Promise<string> =>
  (await prisma.terms.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("terms", name);
const needCarrier = async (name: string): Promise<string> =>
  (await prisma.carrier.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("carrier", name);
const needContainerType = async (name: string): Promise<string> =>
  (await prisma.containerType.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("container type", name);
const needScale = async (name: string): Promise<string> =>
  (await prisma.inspectionScale.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("inspection scale", name);
const needInspectionCode = async (name: string): Promise<string> =>
  (await prisma.inspectionCode.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("inspection code", name);
const needPaymentType = async (name: string): Promise<string> =>
  (await prisma.paymentType.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("payment type", name);
const needMaterial = async (name: string): Promise<string> =>
  (await prisma.material.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("material", name);
const needSpec = async (name: string): Promise<string> =>
  (await prisma.specification.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("specification", name);
const needStepCode = async (code: string): Promise<string> =>
  (await prisma.processStepCode.findFirst({ where: { code, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("process step code", code);
const needCustomer = async (code: string): Promise<string> =>
  (await prisma.customer.findFirst({ where: { code, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("customer", code);
const needSurcharge = async (name: string): Promise<string> =>
  (await prisma.surcharge.findFirst({ where: { name, deletedAt: null }, select: { id: true } }))?.id
  ?? missing("surcharge", name);

// Thin id-returning wrappers, the demo-seed.ts style, so the orchestration reads as a dependency
// graph rather than a wall of `.id` unwraps. Each delegates to exactly one service entrypoint.
const ref = async (kind: string, input: Record<string, unknown>): Promise<string> =>
  (await createReference(kind, input)).id;
const customer = async (input: Record<string, unknown>): Promise<string> =>
  (await createCustomer(input)).id;
const part = async (input: Record<string, unknown>): Promise<string> =>
  (await createPart(input)).id;

// ---------------------------------------------------------------------------------------------
// Dates. Everything is anchored to `todayDateOnly()` so the dataset ages correctly whenever it is
// rebuilt: the aging buckets, the backlog's received-month slices and the closed prior month all
// stay in the same RELATIVE position rather than rotting into fixed calendar dates.
//
// `PRIOR_*` is the month before this one — the month the dataset closes. See the header of the
// receivables section for why it can only carry CASH.
// ---------------------------------------------------------------------------------------------

const TODAY = todayDateOnly();
const d = (daysAgo: number): string => formatDateOnly(addDays(TODAY, -daysAgo));
const TODAY_STR = formatDateOnly(TODAY);

const PRIOR_YEAR = TODAY.getUTCMonth() === 0 ? TODAY.getUTCFullYear() - 1 : TODAY.getUTCFullYear();
const PRIOR_MONTH = TODAY.getUTCMonth() === 0 ? 12 : TODAY.getUTCMonth();
/** A "yyyy-mm-dd" inside the prior month, on its `day`. */
const inPriorMonth = (day: number): string =>
  `${PRIOR_YEAR}-${String(PRIOR_MONTH).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

export async function seedManualDataset(): Promise<void> {
  await assertDevDatabase();
  const admin = await prisma.user.findFirst({
    where: { username: "admin", deletedAt: null }, select: { id: true },
  });
  if (!admin) missing("user", "admin");
  // A REAL user id in the actor, not demo-seed's `{ id: null }`: `createQuote` refuses outright
  // without one (`Quote.quotedById` is NOT NULL), and `publishDraft`/`exportClose`/`closePeriod`
  // all stamp provenance columns from `currentActor().id`. Seeding as the admin makes that
  // provenance real rather than null.
  await runWithContext({ actor: { id: admin.id, name: "manual-seed" }, user: null }, () => run(admin.id));
}

async function run(adminId: string): Promise<void> {
  const env = await referenceData();
  const people = await adminUsersAndRoles();
  const cust = await customers(env);
  const parts = await partsFor(env, cust);
  const quotes = await quoteSet(env, cust, parts);
  const orders = await orderBook(env, cust, parts, quotes);
  const shipping = await shippingAndCerts(env, cust, parts, orders, adminId);
  const invoices = await invoicing(orders);
  // AFTER invoicing — see `reversalAfterInvoice`'s comment on why the order matters.
  await reversalAfterInvoice(shipping.reopenShip.id);
  await receivables(env, cust, invoices);
  // LAST: once the prior month is closed, nothing dated in it can post again.
  await monthEnd();
  await templatesAndAssignments(cust);
  // LAST of all — see `finishFirstRun`'s comment on why the order matters.
  await finishFirstRun(adminId);
  void people;
}

/**
 * The first-run finish, deliberately the VERY LAST thing this script does.
 *
 * Two separate signals, both of which otherwise leave the app permanently showing a first-run
 * state that has nothing to do with the dataset:
 *
 *  1. The ADMIN PASSWORD. `install-readiness.ts` carries a §5.7 live check for the seeded
 *     password still being the literal `admin`, and it is a genuine finding, not decoration —
 *     it keeps the setup checklist red and shows a standing warning. Changed through
 *     `updateUser`, which is the same service the Users screen calls: the plaintext never
 *     reaches the audit payload (it is destructured out before the snapshot is composed), only
 *     `passwordHash: "set"`.
 *
 *  2. The CHECKLIST. `SetupState` is a by-construction singleton holding the only two
 *     non-derivable first-run facts. Dismissing the checklist is meaningful ONLY once every
 *     live signal behind it is genuinely satisfied — company identity, a chart of accounts and
 *     the A/R control account are all in place by now (the demo slice sets them, and the
 *     order-entry gate has been passing for every order above, which is proof) — so it runs
 *     here rather than up front, where it would merely be hiding an incomplete install.
 *
 * `numbersConfirmedAt` is stamped too: every document number in this dataset was allocated by
 * `allocateNumber` from the seeded counters, which IS the deliberate confirmation that starting
 * numbers are correct for a demo copy.
 */
async function finishFirstRun(adminId: string): Promise<void> {
  await realBackup();
  await updateUser(adminId, { password: ADMIN_PASSWORD });
  await setSetupState({ numbersConfirmedAt: new Date(), checklistDismissedAt: new Date() });
}

/**
 * ONE REAL BACKUP, through the real service.
 *
 * The Backups indicator is green only on a recent integrity-passing archive AND a clean last run
 * AND a readable status file — **absence is failure**, so a database that has never been backed up
 * shows red. That is Phase 8C working exactly as designed, but it would ride on every screenshot in
 * the manual and teach the wrong lesson, and chapter 12 needs a populated page regardless.
 *
 * `runBackupNow()` is taken with its DEFAULTS — the real `pg_dump`, spawned via argv (never a shell
 * string), dumped to a temp file and size-checked before it is gzipped into place, so an empty
 * archive is never written. The suite's injectable `dumpBin` exists because CI's pg_dump major can
 * be older than the server and pg_dump refuses a newer server; that is not a concern here (host
 * 18.4, server 18.6 — same major), and using the injectable would defeat the point of proving the
 * real path works.
 *
 * Backups are PRODUCTION-only: `assertNotPracticeDatabase` refuses them on the practice copy. The
 * dev database is not the practice copy, so the guard permits this — and this file's own guard has
 * already established we are on dev.
 *
 * Writes to `BACKUP_DIR` (`./backups` on a dev machine, resolved against the process cwd — so this
 * must be run from `erp/`, which the documented rebuild does).
 */
async function realBackup(): Promise<void> {
  const archive = await runBackupNow();
  console.log(`  backup: ${archive.name} (${archive.sizeBytes} bytes, integrity ${archive.integrityOk ? "ok" : "FAILED"})`);
}

/** The demo credential. Recorded in docs/manual/dataset.md — the manual's screenshots are taken
 *  signed in as this user. Deliberately NOT `admin`, so the install-readiness warning clears. */
const ADMIN_PASSWORD = "heatsynq-demo";

// =============================================================================================
// 1. Reference data — including the 11th kind (`commentSnippet`), which the demo slice leaves
//    empty, so the manual's reference chapter can show every kind populated.
// =============================================================================================

type Env = Awaited<ReturnType<typeof referenceData>>;

async function referenceData() {
  const glRevenue = await needGl("4010");
  const glSurcharge = await needGl("4020");
  const glCash = await needGl("1000");

  // New reference rows across every kind the demo slice under-fills.
  await ref("material", { name: "17-4 PH Stainless" });
  await ref("material", { name: "1018 Cold Rolled" });
  const termsNet45 = await ref("terms", { name: "Net 45", netDays: 45 });
  const termsDue = await ref("terms", { name: "Due on Receipt", netDays: 0 });
  await ref("terms", { name: "1% 15 Net 45", netDays: 45, discountPercent: "1.00", discountDays: 15 });
  await ref("carrier", { name: "Roadway Express" });
  await ref("carrier", { name: "Our Truck" });
  const ctGaylord = await ref("containerType", { name: "Cardboard Gaylord" });
  await ref("containerType", { name: "Steel Rack" });
  const scaleBrinell = await ref("inspectionScale", { name: "Brinell" });
  const icCase = await ref("inspectionCode", { name: "CASE-DEPTH", defaultScaleId: scaleBrinell });
  await ref("inspectionCode", { name: "MICRO", defaultScaleId: scaleBrinell });
  await ref("paymentType", { name: "Credit Card", glAccountId: glCash });
  await ref("specification", {
    name: "AMS 2750 Pyrometry", text: "Pyrometry requirements for thermal processing equipment.",
  });
  await ref("endingStatement", {
    name: "Expedited Quote Terms",
    text: "Expedited pricing firm for 10 days. Overtime rates apply outside normal shift hours.",
  });

  // The 11th kind. Nothing in the demo slice creates one, so /admin/reference showed an empty
  // Comment snippets tab — the one reference screen the manual could not illustrate.
  await ref("commentSnippet", {
    name: "Rush order", text: "RUSH — customer waiting. Call on completion.",
  });
  await ref("commentSnippet", {
    name: "Handle with care", text: "Do not nest or stack. Parts scratch easily.",
  });
  await ref("commentSnippet", {
    name: "Cert with shipment", text: "Certification must ship with the parts. Do not release without it.",
  });

  // Extra step codes, two of them carrying TYPED fields so the traveler's typed-field slots (and
  // the process designer) have real content to show.
  const scAustemper = (await createStepCode({
    code: "HT-500", name: "Austemper", glAccountId: glRevenue, equipmentTag: "SALT-1",
  })).id;
  const scCryo = (await createStepCode({
    code: "HT-600", name: "Cryogenic Treat", glAccountId: glRevenue, equipmentTag: "CRYO-1",
  })).id;
  const scStraighten = (await createStepCode({
    code: "STRAIGHT", name: "Straighten", glAccountId: glRevenue, equipmentTag: "PRESS-2",
  })).id;
  const scBlast = (await createStepCode({
    code: "BLAST", name: "Shot Blast", glAccountId: glRevenue, equipmentTag: "BLAST-1",
  })).id;

  await setStepFields(scAustemper, [
    { label: "Salt temp", type: "NUMBER", unit: "F", sort: 0 },
    { label: "Soak time", type: "NUMBER", unit: "min", sort: 1 },
    { label: "Quench media", type: "TEXT", sort: 2 },
  ]);
  await setStepFields(scCryo, [
    { label: "Soak temp", type: "NUMBER", unit: "F", sort: 0 },
    { label: "Hold hours", type: "NUMBER", unit: "hr", sort: 1 },
    { label: "Double temper", type: "CHECKBOX", sort: 2 },
    { label: "Process date", type: "DATE", sort: 3 },
  ]);

  // A third surcharge, and the plant-level rows the per-customer overrides below point at.
  const scExpedite = (await createSurcharge({
    name: "Expedite Fee", kind: "FLAT", amount: "75.00", glAccountId: glSurcharge, position: 2,
  })).id;

  // PROCESS TEMPLATES — reusable step recipes the process designer loads onto a part. Neither the
  // base seed nor the demo slice creates one, so /admin/process-templates was empty (and the
  // designer's "load a template" path had nothing to offer).
  const tplCarb = (await createProcessTemplate({ name: "Carburize / Harden / Temper" })).id;
  await addTemplateStep(tplCarb, {
    codeId: await needStepCode("HT-300"),
    boilerplate: "Carburize at 1700°F to the drawing's effective case depth, oil quench.",
  });
  await addTemplateStep(tplCarb, {
    codeId: await needStepCode("HT-200"), boilerplate: "Temper at 325°F for 2 hours, air cool.",
  });
  await addTemplateStep(tplCarb, {
    codeId: scBlast, boilerplate: "Shot blast to SAE J444, mask threads.",
  });

  const tplTool = (await createProcessTemplate({ name: "Tool steel — harden, cryo, double temper" })).id;
  await addTemplateStep(tplTool, {
    codeId: await needStepCode("HT-100"), boilerplate: "Preheat 1200°F, austenitize per grade, air quench.",
  });
  await addTemplateStep(tplTool, { codeId: scCryo, boilerplate: "Cryogenic soak immediately after quench." });
  await addTemplateStep(tplTool, { codeId: await needStepCode("HT-200"), boilerplate: "Temper, 2 hours." });
  await addTemplateStep(tplTool, { codeId: await needStepCode("HT-200"), boilerplate: "Second temper, 2 hours." });

  const tplStress = (await createProcessTemplate({ name: "Stress relieve only" })).id;
  await addTemplateStep(tplStress, {
    codeId: await needStepCode("HT-400"), boilerplate: "Stress relieve at 1150°F, 1 hour per inch of section.",
  });

  // Part custom fields — definitions here, per-part values alongside each part below.
  const pfDrawing = (await createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 })).id;
  const pfRev = (await createPartFieldDef({ name: "Drawing rev", type: "TEXT", sort: 1 })).id;
  const pfPpap = (await createPartFieldDef({ name: "Last PPAP", type: "DATE", sort: 2 })).id;
  const pfCavities = (await createPartFieldDef({ name: "Cavity count", type: "NUMBER", sort: 3 })).id;
  const pfRohs = (await createPartFieldDef({ name: "RoHS", type: "CHECKBOX", sort: 4 })).id;

  return {
    glRevenue, glSurcharge, glCash,
    termsNet30: await needTerms("Net 30"),
    terms2pct: await needTerms("2% 10 Net 30"),
    termsNet45, termsDue,
    carrierFedex: await needCarrier("FedEx Freight"),
    carrierPickup: await needCarrier("Customer Pickup"),
    ctSteel: await needContainerType("Steel Basket"),
    ctWire: await needContainerType("Wire Basket"),
    ctGaylord,
    scaleHRC: await needScale("Rockwell C"),
    scaleBrinell,
    icSurf: await needInspectionCode("SURF-HRC"),
    icCore: await needInspectionCode("CORE-HRC"),
    icCase,
    ptCheck: await needPaymentType("Check"),
    ptAch: await needPaymentType("ACH"),
    ptWire: await needPaymentType("Wire Transfer"),
    matCarb: await needMaterial("8620 Carburizing Steel"),
    matAlloy: await needMaterial("4140 Alloy Steel"),
    matTool: await needMaterial("A2 Tool Steel"),
    specAMS: await needSpec("AMS 2759"),
    specMil: await needSpec("MIL-STD-1684"),
    scHarden: await needStepCode("HT-100"),
    scTemper: await needStepCode("HT-200"),
    scCarb: await needStepCode("HT-300"),
    scStress: await needStepCode("HT-400"),
    scAustemper, scCryo, scStraighten, scBlast,
    surEnergy: await needSurcharge("Energy Surcharge"),
    surSmallLot: await needSurcharge("Small Lot Charge"),
    scExpedite,
    pfDrawing, pfRev, pfPpap, pfCavities, pfRohs,
  };
}

// =============================================================================================
// 2. Admin — roles with genuinely different permission sets, users across them, one override.
// =============================================================================================

async function adminUsersAndRoles() {
  // Office Clerk — day-to-day paperwork: orders, customers, parts, invoicing, receivables view.
  // No special actions at all, so every dangerous control is visibly absent for this user.
  const clerk = (await createRole("Office Clerk")).id;
  await setRolePermissions(clerk, [
    "orders.view", "orders.create", "orders.edit",
    "customers.view", "customers.create", "customers.edit",
    "parts.view", "parts.create", "parts.edit",
    "quotes.view", "quotes.create", "quotes.edit",
    "invoicing.view", "receivables.view", "shipping.view", "certs.view", "reports.view",
  ]);

  // Shipping Lead — the shop-side role: shipping + certs with the two named actions that job
  // genuinely needs (void a shipment, override a credit hold), and NOTHING financial.
  const shipping = (await createRole("Shipping Lead")).id;
  await setRolePermissions(shipping, [
    "orders.view", "parts.view", "customers.view",
    "shipping.view", "shipping.create", "shipping.edit", "shipping.delete",
    "certs.view", "certs.create", "certs.edit",
    "reports.view",
    "action.void_shipper", "action.override_credit_hold", "action.edit_cert_results_after_print",
  ]);

  // Read-only — every view bit, no create/edit/delete anywhere. The role the manual uses to show
  // what a locked-down account sees.
  const readonly = (await createRole("Read-only")).id;
  await setRolePermissions(readonly, [
    "orders.view", "parts.view", "processes.view", "customers.view", "quotes.view",
    "certs.view", "shipping.view", "invoicing.view", "reports.view", "receivables.view",
    "templates.view",
  ]);

  // Controller — the finance role, with the money actions.
  const controller = (await createRole("Controller")).id;
  await setRolePermissions(controller, [
    "orders.view", "customers.view", "parts.view", "shipping.view", "reports.view",
    "invoicing.view", "invoicing.create", "invoicing.edit",
    "receivables.view", "receivables.create", "receivables.edit",
    "action.apply_payments", "action.unlock_invoice", "action.close_ar_period",
    "action.write_off", "action.run_qbo_export",
  ]);

  const dana = (await createUser({
    username: "dclark", displayName: "Dana Clark", password: "heatsynq123", roleId: clerk,
  })).id;
  await createUser({
    username: "rmoreno", displayName: "Rosa Moreno", password: "heatsynq123", roleId: shipping,
  });
  await createUser({
    username: "tokafor", displayName: "Tunde Okafor", password: "heatsynq123", roleId: controller,
  });
  await createUser({
    username: "auditor", displayName: "Pat Lindqvist (Auditor)", password: "heatsynq123", roleId: readonly,
  });

  // The per-user override: Dana is an Office Clerk (no special actions) but is trusted to release
  // a credit hold, and is explicitly DENIED order deletion her role never granted anyway — one
  // GRANT and one DENY, so the manual can show both directions and the DENY-beats-GRANT rule.
  await setUserOverrides(dana, [
    { permission: "action.override_credit_hold", mode: "GRANT" },
    { permission: "orders.delete", mode: "DENY" },
  ]);

  return { clerk, shipping, readonly, controller, dana };
}

// =============================================================================================
// 3. Customers — a parent with two divisions, several independents, addresses of every kind
//    (one inactive), contacts (one phone-only), assorted terms, a credit hold, surcharge
//    overrides.
// =============================================================================================

type Cust = Awaited<ReturnType<typeof customers>>;

async function customers(env: Env) {
  const aero = await needCustomer("AERO");
  const aeroMw = await needCustomer("AERO-MW");
  const prec = await needCustomer("PREC");

  // A SECOND division under the existing parent, so the family tree has real depth and the
  // statement run's combine-family option has something to combine.
  const aeroSe = await customer({
    code: "AERO-SE", name: "Aerospace Dynamics — Southeast Division",
    parentId: aero, termsId: env.termsNet30, taxable: false,
  });

  const midst = await customer({
    code: "MIDST", name: "Midstate Fabricators", termsId: env.termsNet45,
    orderNotes: "Always call the front desk before delivery.",
  });
  const titan = await customer({
    code: "TITAN", name: "Titan Tool & Die", termsId: env.terms2pct,
    defaultPo: "BLANKET-2026",
  });
  const harbor = await customer({
    code: "HARB", name: "Harbor Marine Works", termsId: env.termsNet30,
    taxable: true, salesTaxRate: "0.065000",
    invoiceNotes: "Tax exempt certificate expires 31 Dec — recheck before year end.",
  });
  // The credit-hold customer: every shipment for this one hits the gate, which is exactly what
  // the manual's credit-hold walkthrough needs.
  const cascade = await customer({
    code: "CASC", name: "Cascade Spring Co", termsId: env.termsDue,
    creditHold: true, creditLimit: "5000.00",
    orderNotes: "ON CREDIT HOLD — accounting must release before anything ships.",
  });
  const valley = await customer({
    code: "VALLEY", name: "Valley Machine Works", termsId: env.terms2pct,
    surchargeOptOut: true,
    shippingNotes: "Deliveries accepted 7am–1pm only.",
  });

  // Addresses — all three kinds, plus one deliberately INACTIVE row so the manual can show the
  // active/inactive distinction on the customer's Addresses tab.
  await addAddress(midst, {
    kind: "SHIP_TO", name: "Midstate Fabricators — Plant 1", isDefault: true,
    street: "4120 Foundry Row", city: "Akron", state: "OH", zip: "44305",
  });
  await addAddress(midst, {
    kind: "BILL_TO", name: "Midstate Fabricators — A/P",
    street: "PO Box 771", city: "Akron", state: "OH", zip: "44309",
  });
  await addAddress(midst, {
    kind: "SHIP_TO", name: "Midstate Fabricators — Plant 2 (CLOSED)", active: false,
    street: "9 Old Canal St", city: "Barberton", state: "OH", zip: "44203",
  });
  await addAddress(midst, {
    kind: "RECEIVED_FROM", name: "Midstate — Receiving Dock",
    street: "4120 Foundry Row, Door 6", city: "Akron", state: "OH", zip: "44305",
  });
  await addAddress(titan, {
    kind: "SHIP_TO", name: "Titan Tool & Die", isDefault: true,
    street: "88 Anvil Court", city: "Youngstown", state: "OH", zip: "44502",
  });
  await addAddress(harbor, {
    kind: "SHIP_TO", name: "Harbor Marine Works", isDefault: true,
    street: "1 Drydock Way", city: "Lorain", state: "OH", zip: "44052",
  });
  await addAddress(cascade, {
    kind: "SHIP_TO", name: "Cascade Spring Co", isDefault: true,
    street: "300 Coil Drive", city: "Warren", state: "OH", zip: "44483",
  });
  await addAddress(valley, {
    kind: "SHIP_TO", name: "Valley Machine Works", isDefault: true,
    street: "77 Riverbend Pkwy", city: "Canton", state: "OH", zip: "44702",
  });
  await addAddress(aeroSe, {
    kind: "SHIP_TO", name: "Aerospace Dynamics — Southeast", isDefault: true,
    street: "2200 Piedmont Industrial Blvd", city: "Greenville", state: "SC", zip: "29605",
  });

  // Contacts — including a PHONE-ONLY one (no email at all), which is a real shop pattern and
  // the reason `email` is optional on the contact schema.
  await addContact(midst, {
    name: "Ellen Vance", email: "evance@example.com", phone: "330-555-0143",
    getsInvoices: true, getsStatements: true,
  });
  await addContact(midst, {
    name: "Shop Floor (no email)", phone: "330-555-0199", getsShippers: true,
  });
  await addContact(titan, {
    name: "Marcus Bell", email: "mbell@example.com", phone: "234-555-0127",
    getsInvoices: true, getsCerts: true, getsStatements: true,
  });
  await addContact(harbor, {
    name: "Priya Raman", email: "praman@example.com", phone: "440-555-0164",
    getsInvoices: true, getsCerts: true,
  });
  await addContact(cascade, {
    name: "Glenn Ostrowski", email: "gostrowski@example.com", phone: "330-555-0188",
    getsInvoices: true, getsStatements: true,
  });
  await addContact(valley, {
    name: "Aiko Tanaka", email: "atanaka@example.com", phone: "330-555-0111",
    getsInvoices: true, getsShippers: true,
  });
  await addContact(aeroSe, {
    name: "Bo Whitfield", phone: "864-555-0170", getsShippers: true, getsCerts: true,
  });

  // Per-customer surcharge overrides — one reduced rate, one flat override, one explicit opt-out
  // of a single surcharge (distinct from VALLEY's blanket `surchargeOptOut`).
  await setCustomerSurcharge(titan, env.surEnergy, { rate: "0.020000" });
  await setCustomerSurcharge(midst, env.surSmallLot, { amount: "15.00" });
  await setCustomerSurcharge(harbor, env.surEnergy, { optOut: true });

  return { aero, aeroMw, aeroSe, prec, midst, titan, harbor, cascade, valley };
}

// =============================================================================================
// 4. Parts — multi-step recipes with typed field values, price rows with break tiers, specs,
//    inspections, custom field values. Includes ONE part number that recurs across two customers
//    (the model fact: a part number is unique PER CUSTOMER, not globally).
// =============================================================================================

type Parts = Awaited<ReturnType<typeof partsFor>>;

async function partsFor(env: Env, cust: Cust) {
  const mk = async (input: Record<string, unknown>) => part(input);

  // --- Midstate: the RECURRING part number. "3541720C3" already exists under AERO-MW (demo
  // slice). The same drawing number under a different customer is a genuinely different part,
  // with its own recipe, its own prices and its own audit history.
  const mfRing = await mk({
    customerId: cust.midst, partNumber: "3541720C3", name: "Ring Gear (Midstate)",
    description: "Same customer drawing number as AERO-MW — a different part entirely",
    processName: "Harden / Temper / Blast", materialId: env.matAlloy,
    eachWeight: "12.8000", loadQty: 300, loadWeight: "3840.00",
  });
  await addStep(mfRing, { codeId: env.scHarden, instruction: "Austenitize at 1560°F, oil quench." });
  await addStep(mfRing, { codeId: env.scTemper, instruction: "Temper at 450°F for 2 hours." });
  await addStep(mfRing, { codeId: env.scBlast, instruction: "Shot blast to SAE J444 spec." });
  const mfRingPrice = (await addPartPrice(mfRing, {
    processStepCodeId: env.scHarden, position: 0, unitPrice: "4.2500",
    minimumCharge: "200.00", pricePer: "EACH",
  })).id;
  await addPriceBreak(mfRing, mfRingPrice, { threshold: "500.00", price: "3.9000" });
  await addPriceBreak(mfRing, mfRingPrice, { threshold: "2000.00", price: "3.5000" });
  await addPartPrice(mfRing, {
    processStepCodeId: env.scBlast, position: 1, unitPrice: "0.4000", pricePer: "EACH",
  });
  await addPartSpec(mfRing, env.specAMS);
  await addPartInspection(mfRing, {
    inspectionCodeId: env.icSurf, scaleId: env.scaleHRC, min: "48.0000", max: "54.0000",
    sampleQty: "3", location: "Tooth flank", sort: 0,
  });
  await setPartFieldValues(mfRing, [
    { fieldId: env.pfDrawing, value: "3541720" },
    { fieldId: env.pfRev, value: "C3" },
    { fieldId: env.pfRohs, value: "true" },
  ]);

  const mfBracket = await mk({
    customerId: cust.midst, partNumber: "MF-2201", name: "Weld Bracket",
    description: "Stress relieve after weld", processName: "Stress Relieve",
    materialId: env.matAlloy, eachWeight: "3.1000", loadQty: 800, loadWeight: "2480.00",
  });
  await addStep(mfBracket, { codeId: env.scStress, instruction: "Stress relieve at 1150°F, 1 hour per inch." });
  await addPartPrice(mfBracket, {
    processStepCodeId: env.scStress, position: 0, unitPrice: "0.8500",
    minimumCharge: "125.00", pricePer: "EACH",
  });
  await setPartFieldValues(mfBracket, [{ fieldId: env.pfDrawing, value: "MF-2201" }]);

  // --- Titan Tool & Die: the deep recipe (5 steps) with TYPED step field values on two of them.
  const tdPunch = await mk({
    customerId: cust.titan, partNumber: "TD-77", name: "Forming Punch",
    description: "A2 tool steel forming punch, cryo treated",
    processName: "Harden / Cryo / Double Temper", materialId: env.matTool,
    eachWeight: "6.4000", loadQty: 120, loadWeight: "768.00",
    certRequired: true, certScope: "ORDER",
  });
  await addStep(tdPunch, { codeId: env.scHarden, instruction: "Preheat 1200°F, austenitize 1775°F, air quench." });
  await addStep(tdPunch, {
    codeId: env.scCryo, instruction: "Cryogenic soak immediately after quench.",
    values: [
      { fieldDefId: await fieldDefId(env.scCryo, "Soak temp"), value: "-320" },
      { fieldDefId: await fieldDefId(env.scCryo, "Hold hours"), value: "24" },
      { fieldDefId: await fieldDefId(env.scCryo, "Double temper"), value: "true" },
      { fieldDefId: await fieldDefId(env.scCryo, "Process date"), value: d(30) },
    ],
  });
  await addStep(tdPunch, { codeId: env.scTemper, instruction: "Temper at 950°F, 2 hours, air cool." });
  await addStep(tdPunch, { codeId: env.scTemper, instruction: "Second temper at 950°F, 2 hours." });
  await addStep(tdPunch, { codeId: env.scBlast, instruction: "Light blast, mask the shank." });
  const tdPunchPrice = (await addPartPrice(tdPunch, {
    processStepCodeId: env.scHarden, position: 0, setupCharge: "45.00", unitPrice: "8.7500",
    minimumCharge: "350.00", pricePer: "EACH",
  })).id;
  await addPriceBreak(tdPunch, tdPunchPrice, { threshold: "250.00", price: "8.0000" });
  await addPartPrice(tdPunch, {
    processStepCodeId: env.scCryo, position: 1, unitPrice: "2.2500", pricePer: "EACH",
  });
  await addPartSpec(tdPunch, env.specAMS);
  await addPartSpec(tdPunch, env.specMil);
  await addPartInspection(tdPunch, {
    inspectionCodeId: env.icSurf, scaleId: env.scaleHRC, min: "60.0000", max: "62.0000",
    sampleQty: "2", location: "Working face", sort: 0,
  });
  await addPartInspection(tdPunch, {
    inspectionCodeId: env.icCore, scaleId: env.scaleHRC, min: "58.0000", max: "61.0000",
    sampleQty: "1", location: "Shank", sort: 1,
  });
  await setPartFieldValues(tdPunch, [
    { fieldId: env.pfDrawing, value: "TD-77" },
    { fieldId: env.pfRev, value: "B" },
    { fieldId: env.pfPpap, value: d(210) },
    { fieldId: env.pfCavities, value: "4" },
  ]);

  const tdDie = await mk({
    customerId: cust.titan, partNumber: "TD-90", name: "Blanking Die",
    description: "Austempered blanking die", processName: "Austemper",
    materialId: env.matTool, eachWeight: "18.2000", loadQty: 40, loadWeight: "728.00",
  });
  await addStep(tdDie, {
    codeId: env.scAustemper, instruction: "Austemper in salt at target, hold to transformation.",
    values: [
      { fieldDefId: await fieldDefId(env.scAustemper, "Salt temp"), value: "600" },
      { fieldDefId: await fieldDefId(env.scAustemper, "Soak time"), value: "90" },
      { fieldDefId: await fieldDefId(env.scAustemper, "Quench media"), value: "Nitrate salt" },
    ],
  });
  await addStep(tdDie, { codeId: env.scStraighten, instruction: "Straighten to 0.005 in TIR." });
  const tdDiePrice = (await addPartPrice(tdDie, {
    processStepCodeId: env.scAustemper, position: 0, unitPrice: "24.0000",
    minimumCharge: "480.00", pricePer: "EACH",
  })).id;
  await addPriceBreak(tdDie, tdDiePrice, { threshold: "50.00", price: "21.5000" });
  await addPartPrice(tdDie, {
    processStepCodeId: env.scStraighten, position: 1, unitPrice: "6.0000", pricePer: "EACH",
  });
  await addPartInspection(tdDie, {
    inspectionCodeId: env.icCase, scaleId: env.scaleBrinell, min: "352.0000", max: "401.0000",
    sampleQty: "100%", location: "Cutting edge", sort: 0,
  });

  // --- Harbor Marine (taxable — its invoices carry a TAX line).
  const hmShaft = await mk({
    customerId: cust.harbor, partNumber: "HM-500", name: "Propeller Shaft",
    description: "17-4 PH condition H1025", processName: "Age Harden",
    materialId: await needMaterial("17-4 PH Stainless"),
    eachWeight: "44.0000", loadQty: 24, loadWeight: "1056.00",
  });
  await addStep(hmShaft, { codeId: env.scHarden, instruction: "Solution treat 1900°F, age 1025°F 4 hr." });
  await addPartPrice(hmShaft, {
    processStepCodeId: env.scHarden, position: 0, unitPrice: "38.0000",
    minimumCharge: "600.00", pricePer: "EACH",
  });
  await addPartSpec(hmShaft, env.specMil);
  await addPartInspection(hmShaft, {
    inspectionCodeId: env.icSurf, scaleId: env.scaleHRC, min: "35.0000", max: "42.0000",
    sampleQty: "2", location: "Journal", sort: 0,
  });

  // --- Cascade Spring (credit hold).
  const csSpring = await mk({
    customerId: cust.cascade, partNumber: "CS-12", name: "Compression Spring",
    description: "Stress relieve after coiling", processName: "Stress Relieve",
    materialId: await needMaterial("1018 Cold Rolled"),
    eachWeight: "0.2200", loadQty: 5000, loadWeight: "1100.00",
  });
  await addStep(csSpring, { codeId: env.scStress, instruction: "Stress relieve 700°F, 30 minutes." });
  const csPrice = (await addPartPrice(csSpring, {
    processStepCodeId: env.scStress, position: 0, unitPrice: "0.0850",
    minimumCharge: "150.00", pricePer: "EACH",
  })).id;
  await addPriceBreak(csSpring, csPrice, { threshold: "10000.00", price: "0.0700" });

  // --- Valley Machine (surcharge opt-out — its invoices carry NO surcharge line).
  const vmGear = await mk({
    customerId: cust.valley, partNumber: "VM-8080", name: "Idler Gear",
    description: "Carburize and harden", processName: "Carburize / Harden / Temper",
    materialId: env.matCarb, eachWeight: "5.6000", loadQty: 400, loadWeight: "2240.00",
    certRequired: true, certScope: "SHIPMENT",
  });
  await addStep(vmGear, { codeId: env.scCarb, instruction: "Carburize 1700°F to 0.030 in case." });
  await addStep(vmGear, { codeId: env.scTemper, instruction: "Temper 350°F, 2 hours." });
  const vmGearPrice = (await addPartPrice(vmGear, {
    processStepCodeId: env.scCarb, position: 0, unitPrice: "3.1000",
    minimumCharge: "260.00", pricePer: "EACH",
  })).id;
  await addPriceBreak(vmGear, vmGearPrice, { threshold: "1000.00", price: "2.7500" });
  await addPartInspection(vmGear, {
    inspectionCodeId: env.icSurf, scaleId: env.scaleHRC, min: "58.0000", max: "62.0000",
    sampleQty: "3", location: "Tooth flank", sort: 0,
  });
  await addPartInspection(vmGear, {
    inspectionCodeId: env.icCase, scaleId: env.scaleBrinell, min: "0.0250", max: "0.0350",
    sampleQty: "1", location: "Cross section", sort: 1,
  });

  const vmPlate = await mk({
    customerId: cust.valley, partNumber: "VM-8081", name: "Wear Plate",
    description: "Through harden, serialized", processName: "Harden / Temper",
    materialId: env.matAlloy, eachWeight: "9.0000", loadQty: 150, loadWeight: "1350.00",
    serializationRequired: true,
  });
  await addStep(vmPlate, { codeId: env.scHarden, instruction: "Austenitize 1550°F, oil quench." });
  await addStep(vmPlate, { codeId: env.scTemper, instruction: "Temper 500°F, 2 hours." });
  await addPartPrice(vmPlate, {
    processStepCodeId: env.scHarden, position: 0, unitPrice: "5.5000",
    minimumCharge: "220.00", pricePer: "EACH",
  });

  // --- Aerospace Southeast.
  const asFitting = await mk({
    customerId: cust.aeroSe, partNumber: "AS-4410", name: "Hydraulic Fitting",
    description: "Carburize, cert required by load", processName: "Carburize / Harden",
    materialId: env.matCarb, eachWeight: "1.1000", loadQty: 2000, loadWeight: "2200.00",
    certRequired: true, certScope: "LOAD",
  });
  await addStep(asFitting, { codeId: env.scCarb, instruction: "Carburize 1650°F to 0.020 in case." });
  await addStep(asFitting, { codeId: env.scTemper, instruction: "Temper 300°F, 90 minutes." });
  const asPrice = (await addPartPrice(asFitting, {
    processStepCodeId: env.scCarb, position: 0, unitPrice: "1.4500",
    minimumCharge: "300.00", pricePer: "EACH",
  })).id;
  await addPriceBreak(asFitting, asPrice, { threshold: "5000.00", price: "1.2000" });
  await addPartSpec(asFitting, env.specAMS);
  await addPartInspection(asFitting, {
    inspectionCodeId: env.icSurf, scaleId: env.scaleHRC, min: "56.0000", max: "60.0000",
    sampleQty: "5", location: "Hex flat", sort: 0,
  });
  await setPartFieldValues(asFitting, [
    { fieldId: env.pfDrawing, value: "AS-4410" },
    { fieldId: env.pfRohs, value: "false" },
  ]);

  // A second Aerospace-Southeast part, so that customer can carry a genuine MULTI-LINE order.
  // Every line of an order must belong to the ORDER'S customer (`resolveLineParts` refuses
  // "that part belongs to another customer"), so a rider line cannot borrow another customer's
  // part however similar the work is.
  const asRing = await mk({
    customerId: cust.aeroSe, partNumber: "AS-4415", name: "Retaining Ring",
    description: "Stress relieve only", processName: "Stress Relieve",
    materialId: env.matAlloy, eachWeight: "0.4000", loadQty: 4000, loadWeight: "1600.00",
  });
  await addStep(asRing, { codeId: env.scStress, instruction: "Stress relieve 900°F, 45 minutes." });
  await addPartPrice(asRing, {
    processStepCodeId: env.scStress, position: 0, unitPrice: "0.3200",
    minimumCharge: "110.00", pricePer: "EACH",
  });

  return {
    asRing,
    ringGear: await needPart(cust.aeroMw, "3541720C3"),
    pinion: await needPart(cust.prec, "PGW-88A"),
    mfRing, mfBracket, tdPunch, tdDie, hmShaft, csSpring, vmGear, vmPlate, asFitting,
  };
}

const needPart = async (customerId: string, partNumber: string): Promise<string> =>
  (await prisma.part.findFirst({
    where: { customerId, partNumber, deletedAt: null }, select: { id: true },
  }))?.id ?? missing("part", partNumber);

/** A step code's typed field def, by label — the ids only exist once `setStepFields` has run. */
async function fieldDefId(codeId: string, label: string): Promise<string> {
  const row = await prisma.processStepFieldDef.findFirst({
    where: { codeId, label }, select: { id: true },
  });
  return row?.id ?? missing("step field", label);
}

// =============================================================================================
// 5. Quotes — open, won (linked to an order line below), lost, expired, and one whose follow-up
//    is due. "Expired" is DERIVED, never stored (spec ruling 3): an OPEN, live quote whose
//    expiryDate has passed renders as Expired everywhere. So the expired quote below is simply
//    left OPEN with a past expiry — there is no status to set.
// =============================================================================================

type Quotes = Awaited<ReturnType<typeof quoteSet>>;

async function quoteSet(env: Env, cust: Cust, parts: Parts) {
  // WON — priced, still open and in-window, so its line is eligible to link to an order line
  // (§5.2 eligibility is judged AT LINK TIME against the order's received date). Closed as won
  // only AFTER the order links it, further down in `orderBook`.
  const won = await createQuote({
    customerId: cust.titan, rfqNumber: "RFQ-2026-114",
    quoteDate: d(75), effectiveDate: d(75), expiryDate: d(-90),
    notes: "Pricing held for the full blanket quantity.",
    lines: [{
      partId: parts.tdPunch, quotedQty: 250,
      prices: [{
        processStepCodeId: env.scHarden, setupCharge: "45.00", unitPrice: "8.2500",
        minimumCharge: "350.00", pricePer: "EACH", notes: "Blanket pricing, 250 pc release",
        breaks: [{ threshold: "500.00", price: "7.9000" }],
      }],
    }],
  });

  // OPEN — live, in window, nothing linked yet.
  await createQuote({
    customerId: cust.midst, rfqNumber: "RFQ-2026-131",
    quoteDate: d(12), effectiveDate: d(12), expiryDate: d(-48),
    notes: "Subject to material availability.",
    lines: [
      {
        partId: parts.mfBracket, quotedQty: 2000,
        prices: [{
          processStepCodeId: env.scStress, unitPrice: "0.7900", minimumCharge: "125.00",
          pricePer: "EACH", breaks: [{ threshold: "5000.00", price: "0.7200" }],
        }],
      },
      // A free-text line — the part does not exist in the system yet, which is the normal
      // quoting case and the reason the line schema carries `partNumberText`/`partNameText`.
      {
        partNumberText: "MF-3300", partNameText: "Pivot Pin", materialText: "4140",
        eachWeight: "0.9000", quotedQty: 5000,
        prices: [{
          processStepCodeId: env.scHarden, unitPrice: "0.4500", minimumCharge: "150.00",
          pricePer: "EACH",
        }],
      },
    ],
  });

  // FOLLOW-UP DUE — an open quote whose followUpDate has passed (the §5.4 worklist's first
  // section).
  const followUp = await createQuote({
    customerId: cust.harbor, rfqNumber: "RFQ-2026-127",
    quoteDate: d(40), effectiveDate: d(40), expiryDate: d(-20), followUpDate: d(6),
    notes: "Customer asked us to check back after their sea trials.",
    internalNotes: "Second follow-up — Priya said budget clears in Q3.",
    lines: [{
      partId: parts.hmShaft, quotedQty: 12,
      prices: [{
        processStepCodeId: env.scHarden, unitPrice: "36.5000", minimumCharge: "600.00",
        pricePer: "EACH",
      }],
    }],
  });

  // EXPIRED — open and live, expiry in the past. Derived, not stored.
  await createQuote({
    customerId: cust.valley, rfqNumber: "RFQ-2026-098",
    quoteDate: d(120), effectiveDate: d(120), expiryDate: d(15),
    notes: "Expired — re-quote on request.",
    lines: [{
      partId: parts.vmGear, quotedQty: 1500,
      prices: [{
        processStepCodeId: env.scCarb, unitPrice: "2.9500", minimumCharge: "260.00",
        pricePer: "EACH", breaks: [{ threshold: "2500.00", price: "2.6000" }],
      }],
    }],
  });

  // LOST — closed with the outcome in the close reason (status is OPEN/CLOSED only; won/lost is
  // the reason string, not an enum).
  const lost = await createQuote({
    customerId: cust.midst, rfqNumber: "RFQ-2026-105",
    quoteDate: d(95), effectiveDate: d(95), expiryDate: d(35),
    lines: [{
      partId: parts.mfRing, quotedQty: 800,
      prices: [{
        processStepCodeId: env.scHarden, unitPrice: "4.5000", minimumCharge: "200.00",
        pricePer: "EACH",
      }],
    }],
  });
  // `createQuote` returns the QuoteDetail itself (plus `warnings`); `closeQuote` is the one that
  // wraps its result in `{ quote, linkedOpenOrders }`.
  await closeQuote(lost.id, "lost on price — customer went with a captive shop");

  // Printed quote paper — a QUOTE StoredDocument, so the Documents tab and the reprint path both
  // have something to show.
  await printQuote(won.id);
  await printQuote(followUp.id);

  return { won, wonLineId: won.lines[0].id };
}

// =============================================================================================
// 6. Orders — every OrderStatus enum value plus the soft-deleted (voided) case, multi-line
//    orders, auto-split loads, containers, charges, serials, travelers printed, and dates spread
//    over ~4 months so backlog / turnaround / shipped all have real content.
//
// NOTE ON "VOIDED": `OrderStatus` has NO `VOIDED` member (OPEN / PARTIAL_SHIPPED / SHIPPED /
// INVOICED / REOPENED). Voiding an order is a SOFT DELETE — `deletedAt` is set, the order keeps
// its number and stays readable. `REOPENED` is written only by `reverseShipper`, and only when
// the order carries a finalized invoice; that pair is built in `shippingAndCerts` below.
// =============================================================================================

type Orders = Awaited<ReturnType<typeof orderBook>>;

async function orderBook(env: Env, cust: Cust, parts: Parts, quotes: Quotes) {
  const mk = async (input: Record<string, unknown>) => (await createOrder(input)).order;

  // --- The WON quote's order: an explicit `quoteLineId` link on the line. Received inside the
  // quote's window, so the §5.2 eligibility check passes.
  const titanBlanket = await mk({
    customerId: cust.titan, poNumber: "TT-9004", receivedDate: d(60), requestDate: d(46),
    notes: "First release against the 2026 blanket.",
    lines: [{ partId: parts.tdPunch, qty: 250, weight: "1600.00", quoteLineId: quotes.wonLineId }],
    containers: [{ typeId: env.ctSteel, count: 3, qty: 84, tareWeight: "42.50", grossWeight: "580.00" }],
  });
  // Now that the order holds the link, close the quote as WON.
  await closeQuote(quotes.won.id, "won — released as order for 250 pc");

  // --- A multi-line order whose LEAD part drives the auto-split (loadQty 2000 over 9,000 pcs
  // gives 5 loads); the rider line rides along on the same order.
  const aeroSeBig = await mk({
    customerId: cust.aeroSe, poNumber: "ADSE-3312", receivedDate: d(52), requestDate: d(38),
    targetDate: d(30), notes: "Cert by load — one cert per load.",
    lines: [
      { partId: parts.asFitting, qty: 9000, weight: "9900.00" },
      { partId: parts.asRing, qty: 2400, weight: "960.00" },
    ],
    containers: [{ typeId: env.ctGaylord, count: 5, tareWeight: "60.00", grossWeight: "2200.00" }],
    charges: [{ description: "Expedite handling", amount: "75.00" }],
  });

  // --- A serialized order: the part carries `serializationRequired`, so the serials are real.
  const valleySerial = await mk({
    customerId: cust.valley, poNumber: "VMW-771", receivedDate: d(44), requestDate: d(30),
    lines: [{
      partId: parts.vmPlate, qty: 6, weight: "54.00",
      serials: [
        { serial: "WP-2026-001", description: "Heat lot A" },
        { serial: "WP-2026-002", description: "Heat lot A" },
        { serial: "WP-2026-003", description: "Heat lot A" },
        { serial: "WP-2026-004", description: "Heat lot B" },
        { serial: "WP-2026-005", description: "Heat lot B" },
        { serial: "WP-2026-006", description: "Heat lot B" },
      ],
    }],
  });

  // --- The five orders that become the AGED invoices (one per aging bucket). Each is shipped
  // complete and invoiced with a back-dated `invoiceDate`; the bucket comes from
  // `dueDate = invoiceDate + terms.netDays` measured against today.
  const aged90 = await mk({
    customerId: cust.midst, poNumber: "MF-5501", receivedDate: d(165), requestDate: d(150),
    lines: [{ partId: parts.mfRing, qty: 600, weight: "7680.00" }],
  });
  const aged61 = await mk({
    customerId: cust.titan, poNumber: "TT-8810", receivedDate: d(120), requestDate: d(106),
    lines: [{ partId: parts.tdDie, qty: 40, weight: "728.00" }],
  });
  const aged31 = await mk({
    customerId: cust.harbor, poNumber: "HM-220", receivedDate: d(90), requestDate: d(76),
    lines: [{ partId: parts.hmShaft, qty: 18, weight: "792.00" }],
  });
  const aged1 = await mk({
    customerId: cust.valley, poNumber: "VMW-742", receivedDate: d(60), requestDate: d(46),
    lines: [{ partId: parts.vmGear, qty: 1200, weight: "6720.00" }],
  });
  const agedCurrent = await mk({
    customerId: cust.midst, poNumber: "MF-5620", receivedDate: d(28), requestDate: d(14),
    lines: [{ partId: parts.mfBracket, qty: 1500, weight: "4650.00" }],
  });

  // --- The REOPENED pair: invoiced, then its shipment reversed (built in shippingAndCerts).
  const reopenTarget = await mk({
    customerId: cust.titan, poNumber: "TT-8899", receivedDate: d(70), requestDate: d(56),
    notes: "Customer rejected the lot — returned in full.",
    lines: [{ partId: parts.tdDie, qty: 20, weight: "364.00" }],
  });

  // --- The multi-order shipment pair (same customer, one shipment covers both).
  const multiA = await mk({
    customerId: cust.midst, poNumber: "MF-5701", receivedDate: d(22), requestDate: d(8),
    lines: [{ partId: parts.mfRing, qty: 300, weight: "3840.00" }],
  });
  const multiB = await mk({
    customerId: cust.midst, poNumber: "MF-5702", receivedDate: d(21), requestDate: d(7),
    lines: [{ partId: parts.mfBracket, qty: 800, weight: "2480.00" }],
  });

  // --- The voided-shipment pair (shipment voided, order falls back OPEN).
  const voidShipTarget = await mk({
    customerId: cust.valley, poNumber: "VMW-780", receivedDate: d(18), requestDate: d(4),
    lines: [{ partId: parts.vmGear, qty: 400, weight: "2240.00" }],
  });

  // --- The credit-hold order (nothing ships without an override).
  const holdOrder = await mk({
    customerId: cust.cascade, poNumber: "CSC-410", receivedDate: d(16), requestDate: d(2),
    lines: [{ partId: parts.csSpring, qty: 12000, weight: "2640.00" }],
  });

  // --- Cert orders.
  const certOrder = await mk({
    customerId: cust.titan, poNumber: "TT-9020", receivedDate: d(26), requestDate: d(12),
    lines: [{ partId: parts.tdPunch, qty: 120, weight: "768.00" }],
  });
  const certPrinted = await mk({
    customerId: cust.valley, poNumber: "VMW-790", receivedDate: d(34), requestDate: d(20),
    lines: [{ partId: parts.vmGear, qty: 800, weight: "4480.00" }],
  });

  // --- The VOIDED order (soft delete). A plain OPEN order with no invoice — `voidOrder` refuses
  // an order carrying a finalized invoice or live A/R activity.
  const voided = await mk({
    customerId: cust.midst, poNumber: "MF-5555", receivedDate: d(24), requestDate: d(10),
    notes: "Keyed against the wrong customer.",
    lines: [{ partId: parts.mfBracket, qty: 100, weight: "310.00" }],
  });
  await voidOrder(voided.id, "duplicate entry — keyed against the wrong customer");

  // --- Bulk backlog: a spread of plain OPEN orders across ~4 months of received dates, so the
  // Backlog report's received-month slice and the traffic-light request-date colouring both have
  // a realistic distribution rather than a single cohort.
  const backlogSpec: { c: string; p: string; qty: number; w: string; po: string; recv: number }[] = [
    { c: cust.midst, p: parts.mfRing, qty: 450, w: "5760.00", po: "MF-5710", recv: 112 },
    { c: cust.titan, p: parts.tdPunch, qty: 60, w: "384.00", po: "TT-8850", recv: 104 },
    { c: cust.valley, p: parts.vmGear, qty: 900, w: "5040.00", po: "VMW-750", recv: 96 },
    { c: cust.harbor, p: parts.hmShaft, qty: 6, w: "264.00", po: "HM-231", recv: 84 },
    { c: cust.aeroSe, p: parts.asFitting, qty: 4000, w: "4400.00", po: "ADSE-3340", recv: 78 },
    { c: cust.midst, p: parts.mfBracket, qty: 1200, w: "3720.00", po: "MF-5744", recv: 66 },
    { c: cust.titan, p: parts.tdDie, qty: 25, w: "455.00", po: "TT-8871", recv: 55 },
    { c: cust.valley, p: parts.vmPlate, qty: 80, w: "720.00", po: "VMW-762", recv: 47 },
    { c: cust.aeroSe, p: parts.asFitting, qty: 6500, w: "7150.00", po: "ADSE-3361", recv: 39 },
    { c: cust.midst, p: parts.mfRing, qty: 1000, w: "12800.00", po: "MF-5770", recv: 31 },
    { c: cust.harbor, p: parts.hmShaft, qty: 10, w: "440.00", po: "HM-244", recv: 25 },
    { c: cust.titan, p: parts.tdPunch, qty: 200, w: "1280.00", po: "TT-8902", recv: 19 },
    { c: cust.valley, p: parts.vmGear, qty: 2200, w: "12320.00", po: "VMW-801", recv: 13 },
    { c: cust.midst, p: parts.mfBracket, qty: 640, w: "1984.00", po: "MF-5801", recv: 9 },
    { c: cust.aeroSe, p: parts.asFitting, qty: 1800, w: "1980.00", po: "ADSE-3390", recv: 5 },
    { c: cust.titan, p: parts.tdDie, qty: 12, w: "218.40", po: "TT-8930", recv: 2 },
    { c: cust.valley, p: parts.vmPlate, qty: 30, w: "270.00", po: "VMW-812", recv: 0 },
  ];
  const backlog = [];
  for (const s of backlogSpec) {
    backlog.push(await mk({
      customerId: s.c, poNumber: s.po, receivedDate: d(s.recv), requestDate: d(s.recv - 14),
      lines: [{ partId: s.p, qty: s.qty, weight: s.w }],
    }));
  }

  // --- Partially shipped work (the PARTIAL_SHIPPED status) — shipped in `shippingAndCerts`.
  const partialA = await mk({
    customerId: cust.titan, poNumber: "TT-8880", receivedDate: d(50), requestDate: d(36),
    lines: [{ partId: parts.tdPunch, qty: 240, weight: "1536.00" }],
  });
  const partialB = await mk({
    customerId: cust.aeroSe, poNumber: "ADSE-3350", receivedDate: d(42), requestDate: d(28),
    lines: [{ partId: parts.asFitting, qty: 8000, weight: "8800.00" }],
  });

  // --- Plain SHIPPED-complete work that is never invoiced, so the Turnaround report (which only
  // counts orders CURRENTLY `SHIPPED`) has a population.
  // Shipped-complete work. The FIRST SEVEN are invoiced in `invoicing` — they are the invoiced
  // volume that keeps the A/R aging the right shape (see that function's header). The LAST FOUR
  // are deliberately never invoiced, so the Turnaround report — whose population is orders
  // CURRENTLY `SHIPPED` — still has a real spread of completion dates once the first seven have
  // moved on to INVOICED. Keyed, because `invoicing` has to address specific ones by name rather
  // than by a positional index that a later edit would silently shift.
  const shippedSpec: {
    key: string; c: string; p: string; qty: number; w: string; po: string; recv: number; ship: number;
  }[] = [
    { key: "midstA", c: cust.midst, p: parts.mfRing, qty: 300, w: "3840.00", po: "MF-5688", recv: 72, ship: 58 },
    { key: "titanA", c: cust.titan, p: parts.tdPunch, qty: 120, w: "768.00", po: "TT-8840", recv: 64, ship: 52 },
    { key: "valleyA", c: cust.valley, p: parts.vmGear, qty: 1600, w: "8960.00", po: "VMW-733", recv: 58, ship: 41 },
    { key: "aeroSeA", c: cust.aeroSe, p: parts.asFitting, qty: 3000, w: "3300.00", po: "ADSE-3320", recv: 49, ship: 33 },
    { key: "harborA", c: cust.harbor, p: parts.hmShaft, qty: 8, w: "352.00", po: "HM-215", recv: 37, ship: 26 },
    { key: "midstB", c: cust.midst, p: parts.mfBracket, qty: 900, w: "2790.00", po: "MF-5733", recv: 29, ship: 15 },
    { key: "titanB", c: cust.titan, p: parts.tdDie, qty: 30, w: "546.00", po: "TT-8890", recv: 20, ship: 7 },
    { key: "valleyB", c: cust.valley, p: parts.vmPlate, qty: 60, w: "540.00", po: "VMW-755", recv: 66, ship: 50 },
    { key: "aeroSeB", c: cust.aeroSe, p: parts.asRing, qty: 3000, w: "1200.00", po: "ADSE-3335", recv: 44, ship: 29 },
    { key: "midstC", c: cust.midst, p: parts.mfRing, qty: 220, w: "2816.00", po: "MF-5760", recv: 33, ship: 18 },
    { key: "titanC", c: cust.titan, p: parts.tdPunch, qty: 90, w: "576.00", po: "TT-8915", recv: 24, ship: 11 },
  ];
  const shippedOnly: Record<string, { order: Awaited<ReturnType<typeof mk>>; shipDay: number }> = {};
  for (const s of shippedSpec) {
    shippedOnly[s.key] = { order: await mk({
      customerId: s.c, poNumber: s.po, receivedDate: d(s.recv), requestDate: d(s.recv - 14),
      lines: [{ partId: s.p, qty: s.qty, weight: s.w }],
    }), shipDay: s.ship };
  }

  // Travelers — printed on a handful so /orders shows the printed marker and the Documents tab
  // has real archived paper. Each print allocates nothing but archives a StoredDocument.
  for (const o of [titanBlanket, aeroSeBig, valleySerial, partialA, backlog[0], backlog[5]]) {
    await printTraveler(o.id);
  }
  // A per-load traveler for the auto-split order — one sheet group for load 2.
  await printTraveler(aeroSeBig.id, 2);

  return {
    titanBlanket, aeroSeBig, valleySerial,
    aged90, aged61, aged31, aged1, agedCurrent,
    reopenTarget, multiA, multiB, voidShipTarget, holdOrder,
    certOrder, certPrinted, voided, backlog, partialA, partialB, shippedOnly,
  };
}

// =============================================================================================
// 7. Shipping and certification.
// =============================================================================================

/** Ship every line of an order in full, marked complete. */
async function shipComplete(
  customerId: string, order: { id: string; lines: { id: string; qty: number; weight: number }[] },
  shipDate: string, extra: Record<string, unknown> = {},
) {
  return createShipper({
    customerId, shipDate, ...extra,
    orders: [{
      orderId: order.id,
      lines: order.lines.map((l) => ({
        orderLineId: l.id, qty: l.qty, weight: l.weight.toFixed(2), lineComplete: true,
      })),
    }],
  }, { canOverrideCreditHold: true });
}

async function shippingAndCerts(
  env: Env, cust: Cust, parts: Parts, orders: Orders, adminId: string,
) {
  // --- PARTIAL_SHIPPED: half the line, not marked complete.
  await createShipper({
    customerId: cust.titan, shipDate: d(30), carrierId: env.carrierFedex,
    orders: [{
      orderId: orders.partialA.id,
      lines: [{
        orderLineId: orders.partialA.lines[0].id, qty: 120, weight: "768.00", lineComplete: false,
      }],
    }],
  }, { canOverrideCreditHold: true });
  await createShipper({
    customerId: cust.aeroSe, shipDate: d(24), carrierId: env.carrierFedex,
    orders: [{
      orderId: orders.partialB.id,
      lines: [{
        orderLineId: orders.partialB.lines[0].id, qty: 5000, weight: "5500.00", lineComplete: false,
      }],
    }],
  }, { canOverrideCreditHold: true });

  // --- Plain SHIPPED-complete work (drives the Turnaround report).
  for (const s of Object.values(orders.shippedOnly)) {
    const c = await prisma.order.findFirstOrThrow({
      where: { id: s.order.id }, select: { customerId: true },
    });
    await shipComplete(c.customerId, s.order, d(s.shipDay), { carrierId: env.carrierPickup });
  }

  // --- The aged invoice orders: shipped complete, so they can be invoiced.
  await shipComplete(cust.midst, orders.aged90, d(152), { carrierId: env.carrierFedex });
  await shipComplete(cust.titan, orders.aged61, d(108), { carrierId: env.carrierFedex });
  await shipComplete(cust.harbor, orders.aged31, d(78), { carrierId: env.carrierFedex });
  await shipComplete(cust.valley, orders.aged1, d(48), { carrierId: env.carrierFedex });
  await shipComplete(cust.midst, orders.agedCurrent, d(16), { carrierId: env.carrierPickup });

  // --- The blanket order: shipped complete WITH its CONTAINERS, and with a full freight block so
  // the BOL has every field populated. A shipment's containers are picked from the ORDER'S own
  // container rows (`orderContainerId` + a count), never invented at shipment time.
  await createShipper({
    customerId: cust.titan, shipDate: d(44), carrierId: env.carrierFedex,
    billFreight: true, freightAmount: "210.00", freightTerms: "PREPAID", freightClass: "70",
    freightDescription: "Tool steel punches, crated", packageCount: 3,
    proNumber: "PRO-880142", scacCode: "FXFE", route: "CLE → YNG",
    orders: [{
      orderId: orders.titanBlanket.id,
      lines: orders.titanBlanket.lines.map((l) => ({
        orderLineId: l.id, qty: l.qty, weight: l.weight.toFixed(2), lineComplete: true,
      })),
      containers: orders.titanBlanket.containers.map((c) => ({
        orderContainerId: c.id, count: c.count,
      })),
    }],
  }, { canOverrideCreditHold: true });

  // --- The serialized order: shipped complete WITH its SERIALS, each flagged to print on the
  // shipper. The serials are the order's own rows (`orderSerialId`), which is what lets the
  // shipment snapshot them and still survive a later order-side correction.
  await createShipper({
    customerId: cust.valley, shipDate: d(28), carrierId: env.carrierPickup,
    comments: "Serial numbers listed on the packing list.",
    orders: [{
      orderId: orders.valleySerial.id,
      lines: orders.valleySerial.lines.map((l) => ({
        orderLineId: l.id, qty: l.qty, weight: l.weight.toFixed(2), lineComplete: true,
      })),
      serials: orders.valleySerial.serials.map((sr) => ({
        orderSerialId: sr.id, printOnShipper: true,
      })),
    }],
  }, { canOverrideCreditHold: true });

  // --- The order that becomes REOPENED: shipped complete here, invoiced and finalized in
  // `invoicing`, then its shipment reversed in `reversalAfterInvoice` — `reverseShipper` is the
  // ONLY writer of `OrderStatus.REOPENED`, and only when the order carries a finalized invoice
  // (without one it recomputes to the ship-derived status instead).
  const reopenShip = await shipComplete(cust.titan, orders.reopenTarget, d(46), {
    carrierId: env.carrierFedex,
  });

  // --- The MULTI-ORDER shipment: one shipper covering two of Midstate's orders.
  const multi = await createShipper({
    customerId: cust.midst, shipDate: d(12), carrierId: env.carrierFedex,
    billFreight: true, freightAmount: "165.00", freightTerms: "COLLECT",
    freightDescription: "Mixed heat-treated steel", packageCount: 8,
    proNumber: "PRO-991233", scacCode: "FXFE",
    comments: "Two orders on one truck — see both packing lists.",
    orders: [
      {
        orderId: orders.multiA.id,
        lines: [{
          orderLineId: orders.multiA.lines[0].id, qty: orders.multiA.lines[0].qty,
          weight: orders.multiA.lines[0].weight.toFixed(2), lineComplete: true,
        }],
      },
      {
        orderId: orders.multiB.id,
        lines: [{
          orderLineId: orders.multiB.lines[0].id, qty: orders.multiB.lines[0].qty,
          weight: orders.multiB.lines[0].weight.toFixed(2), lineComplete: true,
        }],
      },
    ],
  }, { canOverrideCreditHold: true });
  // A printed BOL — the number is allocated lazily on this first print and is stable on reprint.
  await printBol(multi.shipper.id);
  // …and the shipping tickets (the MOS/shipper paper), so a SHIPPER StoredDocument exists too.
  // One sheet group per order of the shipment: the whole-shipment print covers both orders, the
  // second call is the single-order ticket for just one of them.
  await printShippingTickets(multi.shipper.id);
  await printShippingTickets(multi.shipper.id, orders.multiA.id);

  // --- The VOIDED shipment. Created, then voided with a reason; the order falls back to OPEN
  // and the shipment stays readable as voided paper.
  const doomed = await shipComplete(cust.valley, orders.voidShipTarget, d(10), {
    carrierId: env.carrierPickup,
  });
  await voidShipper(doomed.shipper.id, "loaded onto the wrong trailer — never left the dock");

  // --- The CREDIT-HOLD shipment, released through the override (the same path a user holding
  // `action.override_credit_hold` takes). The reason is audited and prints on nothing.
  await createShipper({
    customerId: cust.cascade, shipDate: d(8), carrierId: env.carrierPickup,
    creditHoldReason: "released by accounting — payment cleared this morning",
    orders: [{
      orderId: orders.holdOrder.id,
      lines: [{
        orderLineId: orders.holdOrder.lines[0].id, qty: 12000, weight: "2640.00", lineComplete: true,
      }],
    }],
  }, { canOverrideCreditHold: true });

  // --- Certs. Three states: pending (requirements seeded, no readings), results entered, and
  // printed. Requirements are auto-seeded from the parts' `PartInspection` rows.
  //
  // Some certs already exist by the time this runs: a part whose EFFECTIVE cert resolution is
  // `required` + ORDER scope gets its cert created EAGERLY at order save (§6.2), and a SHIPMENT-
  // scope part gets one at shipment save. One live cert per scope instance is service-enforced,
  // so a blind `createCert` on such an order is refused with "This order already has a
  // certification for that scope". `orderCert` therefore REUSES the eager cert when there is one
  // — which is also the more faithful demonstration, since that is what the app itself does.
  const certPending = await orderCert(orders.certOrder.id);

  const certWithResults = await orderCert(orders.aged61.id);
  await replaceReadings(certWithResults.id, {
    requirements: certWithResults.requirements.map((r, i) => ({
      id: r.id,
      readings: i === 0
        ? [{ value: "375" }, { value: "382" }, { value: "371" }]
        : [{ value: "58.5" }, { value: "59.2" }],
    })),
  }, { afterPrint: false });

  const certToPrint = await orderCert(orders.certPrinted.id);
  await replaceReadings(certToPrint.id, {
    requirements: certToPrint.requirements.map((r, i) => ({
      id: r.id,
      readings: i === 0
        ? [{ value: "59.5" }, { value: "60.1" }, { value: "58.9" }]
        : [{ value: "0.0295" }],
    })),
  }, { afterPrint: false });
  await printCert(certToPrint.id, adminId);

  // A LOAD-scope cert on the auto-split order, and a SHIPMENT-scope cert on the multi-order
  // shipment — so all three cert scopes appear. LOAD needs `loadNumber` and no `shipperId`;
  // SHIPMENT needs `shipperId` and no `loadNumber` (the shapes are strictly validated).
  await createCert({ orderId: orders.aeroSeBig.id, scope: "LOAD", loadNumber: 1 });
  await createCert({ orderId: orders.aeroSeBig.id, scope: "LOAD", loadNumber: 2 });
  await createCert({ orderId: orders.multiB.id, scope: "SHIPMENT", shipperId: multi.shipper.id });

  void certPending; void parts;
  return { multi, reopenShip: reopenShip.shipper };
}

/**
 * An ORDER-scope cert for this order: the one the eager §6.2 path already created if there is
 * one, otherwise a fresh one. Returns the full `CertDetail` either way, so callers can address
 * its seeded `requirements` without caring which path produced it.
 */
async function orderCert(orderId: string) {
  const existing = await prisma.cert.findFirst({
    where: { orderId, scope: "ORDER", deletedAt: null }, select: { id: true },
  });
  return existing ? getCert(existing.id) : createCert({ orderId, scope: "ORDER" });
}

/**
 * The REOPENED half of the reversal pair, run AFTER `invoicing` has finalized the order's invoice
 * — `reverseShipper` only sets `OrderStatus.REOPENED` when a finalized invoice is present, so the
 * ordering here is load-bearing, not incidental. The reversal is a LIVE negative-qty shipment that
 * never voids the original: both stay readable, which is exactly the pair the manual's Shipping
 * chapter needs.
 */
async function reversalAfterInvoice(shipperId: string) {
  await reverseShipper(shipperId, {
    reason: "customer rejected the lot on incoming inspection — full return",
  });
}

// =============================================================================================
// 8. Invoicing — a draft, several finalized (spread across the aging buckets), one carrying a
//    MANUAL override line, a credit memo, and one unlocked then re-finalized.
//
// `invoiceDate` IS back-datable and drives `dueDate` (= invoiceDate + terms.netDays), which is
// what puts each invoice in its aging bucket. `finalizedAt` is NOT back-datable — see the
// receivables header and docs/manual/dataset.md.
// =============================================================================================

/** Maps a stored invoice line back to a `replaceInvoiceLines` payload item. `key`/`parentKey`
 *  carry the OPERATION → PART grouping across the whole-array replace (positions are reassigned
 *  and row ids are reminted, so an id-based parent link could never survive it).
 *  `sourceQuoteNumber` is deliberately absent: the schema refuses it on any non-QUOTE line, and
 *  none of the invoices edited below is quote-sourced. */
function toLineInput(l: {
  id: string; parentLineId: string | null; kind: string;
  orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null; glAccountId: string | null;
  partNumber: string; partName: string; partDescription: string;
  description: string; glAccountName: string;
  qty: number | null; weight: number | null; eachWeight: number | null;
  pricePer: string | null; unitPrice: number | null;
  setupCharge: number | null; minimumCharge: number | null; breakThreshold: number | null;
  minimumApplied: boolean; rate: number | null; priceSource: string | null;
  needsPrice: boolean; amount: number;
}) {
  return {
    key: l.id, parentKey: l.parentLineId, kind: l.kind,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty, weight: l.weight, eachWeight: l.eachWeight,
    pricePer: l.pricePer, unitPrice: l.unitPrice,
    setupCharge: l.setupCharge, minimumCharge: l.minimumCharge,
    breakThreshold: l.breakThreshold, minimumApplied: l.minimumApplied,
    rate: l.rate, priceSource: l.priceSource, needsPrice: l.needsPrice,
    amount: l.amount.toFixed(2),
  } as Record<string, unknown>;
}

async function invoicing(orders: Orders) {
  const raise = async (orderId: string, invoiceDate: string) => {
    const { invoice } = await createInvoice({ orderId, invoiceDate });
    return invoice;
  };

  // The five aged invoices, one per bucket. Each finalizes NOW (finalizedAt is always the
  // finalize instant) but carries a back-dated invoiceDate, so its dueDate lands in the past.
  const inv90 = await raise(orders.aged90.id, d(150));
  await finalizeInvoice(inv90.id);
  const inv61 = await raise(orders.aged61.id, d(106));
  await finalizeInvoice(inv61.id);
  const inv31 = await raise(orders.aged31.id, d(76));
  await finalizeInvoice(inv31.id);
  const inv1 = await raise(orders.aged1.id, d(45));
  await finalizeInvoice(inv1.id);
  const invCurrent = await raise(orders.agedCurrent.id, d(9));
  await finalizeInvoice(invCurrent.id);

  // --- The MANUAL OVERRIDE invoice. A manual line is an OVERRIDE, not an addition (#61): it is
  // paired to the derived line sharing its order-side identity and substituted into that line's
  // SLOT, so `recalculateInvoice` must NOT regenerate the twin beside it. Editing the amount and
  // stamping `priceSource: "MANUAL"` (clearing `needsPrice`) is exactly what the invoice grid's
  // own edit produces.
  // Dated INSIDE Titan's 2/10 discount window relative to the payment in `receivables` (which is
  // received at d(3)) — the early-pay discount is refused outright once `receivedDate` is past
  // `invoiceDate + discountDays`, and that refusal reads "no early-pay discount applies".
  const invOverride = await raise(orders.titanBlanket.id, d(6));
  const draftLines = (await getInvoice(invOverride.id)).lines;
  await replaceInvoiceLines(invOverride.id, draftLines.map((l) => {
    if (l.kind !== "OPERATION") return toLineInput(l);
    return {
      ...toLineInput(l),
      amount: (l.amount - 125).toFixed(2),
      description: "Blanket price honoured — see quote RFQ-2026-114",
      priceSource: "MANUAL",
      needsPrice: false,
    };
  }));
  // Recalculate AFTER the override, so the manual line demonstrably survives it and tax/surcharge
  // recompute over the FINAL set.
  await recalculateInvoice(invOverride.id);
  await finalizeInvoice(invOverride.id);

  // --- A plain DRAFT invoice, left unfinalized so /invoicing shows a draft.
  const draft = await raise(orders.multiA.id, TODAY_STR);

  // --- UNLOCKED then RE-FINALIZED. Unlock is refused once live A/R activity exists against the
  // invoice, so this one is unlocked before anything is applied to it.
  const invRelock = await raise(orders.multiB.id, d(6));
  await finalizeInvoice(invRelock.id);
  await unlockInvoice(invRelock.id, "wrong PO number on the paper — correcting and re-issuing");
  await finalizeInvoice(invRelock.id);

  // --- The INVOICED order that then gets REOPENED by a shipment reversal.
  const invReopen = await raise(orders.reopenTarget.id, d(52));
  await finalizeInvoice(invReopen.id);

  // --- INVOICED VOLUME. Seven of the shipped-complete orders are billed here, and the reason is
  // the A/R AGING'S SHAPE, not variety for its own sake.
  //
  // Net = bucketed receivables − unapplied cash. A seed that creates more cash than invoiced work
  // shows every customer with a NEGATIVE net — a shop that owes its customers money — which is
  // arithmetically correct and teaches exactly the wrong thing on one of the most-read screens in
  // the manual. The fix is NOT to apply more of the cash: an application reduces the open invoice
  // and the unapplied cash by the same amount, so Net does not move. The only levers are more
  // invoiced work or less cash, and this is the first of the two (the on-account payments in
  // `receivables` are the second).
  //
  // Dates: mostly recent, so most of the balance sits in `current` — the healthy shape — with two
  // deliberately older so the 1–30 bucket stays populated.
  const billed: [key: string, invoiceDate: string][] = [
    ["midstA", d(12)], ["titanA", d(20)], ["valleyA", d(38)], ["aeroSeA", d(15)],
    ["harborA", d(44)], ["midstB", d(8)], ["titanB", d(5)],
  ];
  for (const [key, invoiceDate] of billed) {
    const inv = await raise(orders.shippedOnly[key].order.id, invoiceDate);
    await finalizeInvoice(inv.id);
  }

  // --- The CREDIT MEMO: a full credit against the 31–60 invoice's customer, raised from the
  // invoice itself (a credit copies the source lines with the money sign flipped) and finalized.
  const credit = await createCredit(inv31.id);
  await finalizeInvoice(credit.id);

  // Printed paper for both invoice kinds — an INVOICE and a CREDIT StoredDocument. Printing is a
  // reprint-stable archive: the stored bytes are what a later reprint returns, byte for byte.
  await printInvoice(inv90.id);
  await printInvoice(invOverride.id);
  await printInvoice(credit.id);

  return { inv90, inv61, inv31, inv1, invCurrent, invOverride, draft, invRelock, invReopen, credit };
}

type Invoices = Awaited<ReturnType<typeof invoicing>>;

// =============================================================================================
// 9. Receivables — batches (one open, one posted), payments applied partially and one settling
//    payment that takes the early-pay discount, on-account cash, a residual write-off and a
//    standalone bad-debt write-off (#77), and a printed statement.
//
// ── THE PRIOR-MONTH CASH, AND WHY IT MUST STAY ON ACCOUNT ────────────────────────────────────
// The month-end close refuses any variance between its roll-forward and the aging as of month
// end. `finalizeInvoice` stamps `finalizedAt = now` and cannot be back-dated, so NO invoice can
// ever be recognized in the prior month: the roll-forward's `invoicedTotal` is 0 there, and the
// aging as of month end sees no invoice either (`bucketAging` counts an invoice only when
// `finalizedAt <= asOf`). The two therefore agree at 0 — but ONLY while the prior month's cash
// stays UNAPPLIED. Apply a prior-month payment and its application (whose `appliedDate` is the
// payment's own `receivedDate`) lands in the prior month too: the roll-forward still subtracts
// the cash, while the aging now nets it against an invoice it cannot see, and the close breaks.
//
// So the prior month carries exactly one POSTED batch of ON-ACCOUNT cash. That is also why the
// OPEN batch below is dated in the CURRENT month: the roll-forward counts only POSTED payments,
// while the aging counts ALL of them, so an un-posted payment dated in the prior month would
// break the same reconciliation from the other side.
// =============================================================================================

async function receivables(env: Env, cust: Cust, inv: Invoices) {
  // The payment amounts are derived from live open balances, so they are computed BEFORE the
  // batch is opened: `postBatch` refuses a batch whose entered payments do not equal its control
  // total to the cent, so the control total cannot be a guess.

  // The SETTLING payment that takes the EARLY-PAY DISCOUNT. Titan is on 2% 10 Net 30 and the
  // invoice's terms numbers are FROZEN at finalize (#79), so the discount is read off the paper,
  // never off the customer's current terms. A DISCOUNT is earned only by a payment that SETTLES
  // the invoice to zero (#69), so cash + discount must equal the open balance exactly.
  const overrideOpen = await openBalanceOf(inv.invOverride.id);
  const discount = round2(overrideOpen * 0.02);
  const cash = round2(overrideOpen - discount);

  // The short pay whose residual is written off in the same act.
  const RESIDUAL = 42.17;
  const oneOpen = await openBalanceOf(inv.inv1.id);
  const shortPay = round2(oneOpen - RESIDUAL);

  // Deliberately MODEST. On-account cash is a concept the manual must show (and #159's trap
  // depends on it), but every dollar of it subtracts from Net — see `invoicing`'s header — so it
  // is sized to stay visible without inverting the aging.
  const PARTIAL = 1200, ON_ACCOUNT = 400;
  const controlTotal = round2(PARTIAL + cash + shortPay + ON_ACCOUNT);

  // --- Batch 1: POSTED, current month, the working batch that pays real invoices.
  const main = await createBatch({
    depositDate: d(3), controlTotal: controlTotal.toFixed(2),
    notes: "Lockbox deposit — Thursday run",
  });

  // A PARTIAL payment against the 90+ invoice — leaves a balance and keeps it in the bucket.
  await addPayment(main.id, {
    customerId: cust.midst, paymentTypeId: env.ptCheck, amount: PARTIAL.toFixed(2),
    reference: "CHK 100455", receivedDate: d(3), notes: "Part payment, balance to follow",
  });
  await addPayment(main.id, {
    customerId: cust.titan, paymentTypeId: env.ptAch, amount: cash.toFixed(2),
    reference: "ACH 8891", receivedDate: d(3), notes: "Paid within terms — 2% taken",
  });
  await addPayment(main.id, {
    customerId: cust.valley, paymentTypeId: env.ptCheck, amount: shortPay.toFixed(2),
    reference: "CHK 20331", receivedDate: d(3), notes: "Short pay — freight dispute",
  });
  // ON-ACCOUNT cash in the current month: a payment with no application at all.
  await addPayment(main.id, {
    customerId: cust.harbor, paymentTypeId: env.ptWire, amount: ON_ACCOUNT.toFixed(2),
    reference: "WIRE 55210", receivedDate: d(3), notes: "Prepayment — hold on account",
  });

  await postBatch(main.id);

  // Applications, now that the batch is posted. `appliedDate` follows each payment's
  // `receivedDate`, so all of these land in the CURRENT month.
  const posted = await paymentsOf(main.id);
  const partialId = posted.find((p) => p.reference === "CHK 100455")!.id;
  const settleId = posted.find((p) => p.reference === "ACH 8891")!.id;
  const shortId = posted.find((p) => p.reference === "CHK 20331")!.id;

  await applyPayment({
    paymentId: partialId,
    lines: [{ invoiceId: inv.inv90.id, type: "PAYMENT", amount: "1200.00" }],
  });

  await applyPayment({
    paymentId: settleId,
    lines: [
      { invoiceId: inv.invOverride.id, type: "PAYMENT", amount: cash.toFixed(2) },
      { invoiceId: inv.invOverride.id, type: "DISCOUNT", amount: discount.toFixed(2) },
    ],
  });

  await applyPayment({
    paymentId: shortId,
    lines: [
      { invoiceId: inv.inv1.id, type: "PAYMENT", amount: shortPay.toFixed(2) },
      {
        invoiceId: inv.inv1.id, type: "WRITE_OFF", amount: RESIDUAL.toFixed(2),
        reason: "freight billed in error — writing off the residual rather than re-invoicing",
      },
    ],
  });

  // The CREDIT MEMO applied against its own customer's open invoice.
  const creditOpen = Math.abs(await totalOf(inv.credit.id));
  const target31Open = await openBalanceOf(inv.inv31.id);
  // PARTIAL on purpose, two reasons. A fully-applied credit zeroes its target invoice, and that
  // invoice is the only one sitting in the 31–60 aging bucket — applying the whole credit empties
  // that bucket off the report. Applying part of it leaves a real balance there AND leaves the
  // credit itself partly unapplied, which is the more instructive state anyway: the credit memo
  // shows a remaining balance the operator can still spend. (Net is unmoved either way — an
  // application reduces the open invoice and the unapplied credit equally.)
  const creditApply = round2(Math.min(creditOpen, target31Open, 400));
  if (creditApply > 0) {
    // `applyCredit` takes a plain typed object (a real `number`), not a zod-parsed decimal string
    // like `applyPayment`'s lines — the two argument shapes genuinely differ.
    await applyCredit({
      creditInvoiceId: inv.credit.id, invoiceId: inv.inv31.id, amount: creditApply,
    });
  }

  // --- The STANDALONE BAD-DEBT write-off (#77). No payment behind it — `paymentId` is null,
  // which is exactly what distinguishes it from the residual write-off above. Left LIVE so the
  // manual can show the flagged row and its Void control.
  const currentOpen = await openBalanceOf(inv.invCurrent.id);
  if (currentOpen > 0) {
    await writeOffInvoice({
      invoiceId: inv.invCurrent.id, amount: round2(Math.min(currentOpen, 500)).toFixed(2),
      reason: "customer in Chapter 11 — partial bad debt provision per controller",
    });
  }

  // --- Batch 2: OPEN (never posted), current month. The manual's "unposted deposit" example.
  // Dated in the CURRENT month deliberately — see this section's header.
  const openBatch = await createBatch({
    depositDate: TODAY_STR, controlTotal: "1250.00", notes: "Friday deposit — not yet posted",
  });
  await addPayment(openBatch.id, {
    customerId: cust.midst, paymentTypeId: env.ptCheck, amount: "850.00",
    reference: "CHK 100512", receivedDate: TODAY_STR,
  });
  await addPayment(openBatch.id, {
    customerId: cust.titan, paymentTypeId: env.ptCheck, amount: "400.00",
    reference: "CHK 44120", receivedDate: TODAY_STR,
  });

  // --- Batch 3: the PRIOR MONTH's cash. POSTED, and deliberately left wholly ON ACCOUNT — see
  // the section header for why applying any of it would break the close.
  const priorBatch = await createBatch({
    depositDate: inPriorMonth(26), controlTotal: "6750.00",
    notes: "Prior-month deposits — carried on account",
  });
  await addPayment(priorBatch.id, {
    customerId: cust.midst, paymentTypeId: env.ptCheck, amount: "2750.00",
    reference: "CHK 100301", receivedDate: inPriorMonth(14),
  });
  await addPayment(priorBatch.id, {
    customerId: cust.titan, paymentTypeId: env.ptAch, amount: "2500.00",
    reference: "ACH 8702", receivedDate: inPriorMonth(21),
  });
  await addPayment(priorBatch.id, {
    customerId: cust.valley, paymentTypeId: env.ptWire, amount: "1500.00",
    reference: "WIRE 54880", receivedDate: inPriorMonth(26),
  });
  await postBatch(priorBatch.id);

  // --- A printed statement (a STATEMENT StoredDocument owned by the customer alone).
  await printStatement(cust.midst, { combineFamily: false, assessFinanceCharges: false });
  // And one for the parent, COMBINING the family — the two divisions plus the parent on one
  // piece of paper.
  await printStatement(cust.aero, { combineFamily: true, assessFinanceCharges: false });
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

async function openBalanceOf(invoiceId: string): Promise<number> {
  const row = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    select: {
      total: true,
      applications: { where: { deletedAt: null }, select: { amount: true } },
    },
  });
  const applied = row.applications.reduce((s, a) => s + a.amount.toNumber(), 0);
  return round2(row.total.toNumber() - applied);
}

async function totalOf(invoiceId: string): Promise<number> {
  const row = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId }, select: { total: true },
  });
  return row.total.toNumber();
}

async function paymentsOf(batchId: string) {
  return prisma.payment.findMany({
    where: { batchId, deletedAt: null }, select: { id: true, reference: true },
  });
}

// =============================================================================================
// 10. Month end — close the prior month, export its GL batch, reopen it, and re-close it.
//
// TWO UNRELATED THINGS ARE BOTH CALLED "REOPENED", and the manual must not conflate them:
//   • `OrderStatus.REOPENED` — an invoiced order whose shipment was reversed (built above, in
//     `shippingAndCerts`, via `reverseShipper`).
//   • `ClosePeriod.status` REOPENED — a closed accounting month deliberately re-opened.
// They share a name and nothing else.
//
// Re-closing UPDATES the row in place and clears `reopenedAt`/`reopenReason`, so the end state is
// CLOSED and the reopen survives only in the audit log — which is where the manual should point.
// =============================================================================================

async function monthEnd() {
  const period = await closePeriod(PRIOR_YEAR, PRIOR_MONTH);
  // The GL export for the closed month — one summary line per (account, side), Σdebit = Σcredit
  // asserted before anything is persisted.
  await exportClose(period.id);
  await reopenPeriod(period.id, "controller found a mis-keyed deposit — reopening to verify");
  await closePeriod(PRIOR_YEAR, PRIOR_MONTH);
}

// =============================================================================================
// 11. Document templates — one extra template per a couple of doc types, one of them left with a
//     PUBLISHED version PLUS an open DRAFT, and a per-customer assignment.
// =============================================================================================

async function templatesAndAssignments(cust: Cust) {
  // Published, then a fresh draft opened on top — the "published + draft" state.
  const invoiceTpl = await createTemplate("INVOICE", "Invoice — Aerospace layout");
  await publishDraft(invoiceTpl.id);
  await openDraft(invoiceTpl.id); // leaves v2 as an open DRAFT beside the published v1

  // Published PLUS an open draft. A traveler specifically, because §5.6's locked-element padlock
  // ("this cannot be hidden, and here is why") exists only on the TRAVELER contract — its typed
  // step fields and barcode are non-removable — so this is the only doc type whose editor can
  // demonstrate that behaviour at all.
  const travelerTpl = await createTemplate("TRAVELER", "Traveler — Tool room");
  await publishDraft(travelerTpl.id);
  await openDraft(travelerTpl.id);

  const certTpl = await createTemplate("CERT", "Certification — Marine");
  await publishDraft(certTpl.id);

  // A template that has NEVER been published — its v1 draft is live and it cannot be assigned or
  // made default. The manual's "draft only" example.
  await createTemplate("QUOTE", "Quote — Expedited");

  // Per-customer assignments: nearest-live-ancestor → type default is the resolution walk, so
  // assigning on the PARENT is what the divisions inherit.
  await assignTemplate(cust.aero, "INVOICE", invoiceTpl.id);
  await assignTemplate(cust.titan, "TRAVELER", travelerTpl.id);
  await assignTemplate(cust.harbor, "CERT", certTpl.id);
}

// ---------------------------------------------------------------------------------------------

seedManualDataset()
  .then(() => console.log("Manual dataset built."))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

