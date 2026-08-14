// Small prisma script the E2E harness spawns (via `npx tsx`) to create and clean up the dev-DB
// rows its flows exercise, and to stand in for Phase 3's order save when a flow needs a locked
// revision. Plain `node e2e/run.mjs` cannot import the generated Prisma client directly — it is
// TypeScript source (prisma/generated/prisma/client.ts), not pre-compiled JS — so this file is
// its own small entry point, run under `tsx` the same way `db:seed` already is
// (package.json's `"db:seed": "tsx prisma/seed.ts"`). run.mjs shells out to it with
// `execFileSync("npx", ["tsx", ...])` and reads one line of JSON off stdout; all diagnostic
// output below goes to stderr so stdout stays pure JSON.
//
// CLAUDE.md / HANDOFF §5a: dev-DB fixtures must be cleaned up afterward, against `erp`, never
// `erp_test`. `assertDevDb` below is the guard against ever running this against the wrong
// database.
import "dotenv/config";
import { PrismaClient } from "../../prisma/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../../src/server/password";
import { lockRevision } from "../../src/server/part-process-steps";
import { ALL_PERMISSIONS } from "../../src/server/permissions";

/**
 * Every natural key this harness ever writes to the dev DB, in one place. `reapLeftovers` looks
 * rows up by these EXACT values rather than by an "E2E" prefix scan: the dev database is the
 * developer's own working database, and a `startsWith` sweep that hard-deletes whatever it matches
 * would take real experiment rows down with it if any happened to share the prefix. Nothing here
 * needs discovering at runtime — `liveTemplateName` is the name template-build-and-load.mjs builds
 * through the UI, and it reads that name out of the `Fixtures` payload rather than declaring its
 * own, so the flow and this reaper cannot drift apart.
 */
const FIXTURE = {
  customerCode: "E2ECUST",
  partNumber: "E2E-PART-1",
  stepCodeA: "E2E-QNCH",
  stepCodeB: "E2E-WASH",
  decoyTemplateName: "E2E Decoy Template",
  liveTemplateName: "E2E Austemper",
  adminRoleName: "E2E Admin Role",
  adminUsername: "e2e_admin",
  adminPassword: "e2eAdmin123!",
  restrictedRoleName: "E2E Restricted Role",
  restrictedUsername: "e2e_restricted",
  restrictedPassword: "e2eRestricted123!",
  // Phase 3 (Task 17): a SEPARATE customer/parts from the process-suite's own E2ECUST/E2E-PART-1
  // above, rather than reusing them — the process flows (template-build-and-load/revision-cut)
  // mutate E2E-PART-1's own revision history over the course of a run (cutting Rev 2, locking
  // Rev 1), and coupling the order flows to that same part would make them depend on exactly
  // where in that history the earlier flows left it. `orderCustomer` carries `creditHold: true`
  // so order-entry-full's save deterministically produces a non-empty `warnings[]` (the
  // save-with-warnings panel, spec's "visibly, never silently" ruling) without depending on
  // whether the rider's serials happened to be entered yet.
  orderCustomerCode: "E2EORDCUST",
  orderLeadPartNumber: "E2E-ORD-LEAD",
  orderRiderPartNumber: "E2E-ORD-RIDER",
  // Phase 4 (Task 20): the five shipping/cert flows get their OWN customers, again separate from
  // the two above — the order flows leave E2EORDCUST's one order voided (void-order runs last of
  // them), and E2EORDCUST carries creditHold: true, which would BLOCK createShipper for every
  // shipping flow that isn't specifically about the credit-hold gate. `shipCustomer` is the
  // plain-sailing shipping customer (no hold); `holdCustomer` exists precisely to be refused.
  shipCustomerCode: "E2ESHIPCUST",
  shipPartANumber: "E2E-SHIP-A",
  shipPartBNumber: "E2E-SHIP-B",
  certPartNumber: "E2E-CERT-PART",
  holdCustomerCode: "E2EHOLDCUST",
  holdPartNumber: "E2E-HOLD-PART",
  inspectionScaleName: "E2E HRC",
  inspectionCodeAName: "E2E Hardness",
  inspectionCodeBName: "E2E Case Depth",
  containerTypeName: "E2E Tote",
  // A user who can create shipments but does NOT hold action.override_credit_hold — the
  // credit-hold flow's first half is exactly this person hitting the gate. Holds parts.view too:
  // lib/auth.mjs's login() waits for the "Parts" nav entry as its signed-in checkpoint.
  clerkRoleName: "E2E Shipping Clerk Role",
  clerkUsername: "e2e_clerk",
  clerkPassword: "e2eClerk123!",
  // Fix-wave 1 (Task 5 review, finding 8): closes the one automated gap on the Pricing section —
  // nothing in CI touched it before this (no vitest seam, no E2E flow, only the client-import
  // sweep). A step code of its own, priced on the process suite's own fixture part
  // (E2E-PART-1), rather than reusing stepCodeA/stepCodeB: those two are already load-bearing for
  // blocked-code-delete.mjs's EXACT blocker count ("2 record(s) use it" for stepCodeA), and a
  // PartPrice referencing either would risk changing that count the moment PART_VIA_CHILD's
  // blocker resolution (reference-links.ts) picked up a third live reference. A dedicated code
  // stays fully decoupled from that assertion.
  priceStepCodeCode: "E2E-PRICE",
  priceStepCodeName: "E2E Price Op",
  // Holds parts.view + parts.edit but NOT action.change_prices — the permission split PricingSec-
  // tion.tsx's double gate exists to test: this user CAN edit the part in general but must still
  // be refused on pricing specifically. permission-gating.mjs re-logs-in as this user mid-flow
  // (the credit-hold-block-and-override.mjs precedent) to prove the second gate bites once the
  // first is satisfied — the one thing the plain "restricted" user (which holds neither
  // permission) can never demonstrate on its own.
  priceEditRoleName: "E2E Price Editor Role",
  priceEditUsername: "e2e_price_editor",
  priceEditPassword: "e2ePriceEditor123!",
  // Task 20 (Phase 5A): the invoicing flow's own customer/part — a TWO-PartPrice part (ruling 3's
  // multi-operation case: a single order line whose part carries two priced operations, so the
  // invoice's PART/OPERATION grid shows one PART row with two OPERATION children), each priced
  // operation on its OWN dedicated step code with its OWN GL account. NOT stepCodeA/stepCodeB
  // (blocked-code-delete's exact blocker count) and NOT priceStepCode (permission-gating's own
  // exact gate count) — a fully independent pair, the priceStepCode precedent.
  //
  // Tax is exercised via `Customer.salesTaxRate` (`taxable: true` + a rate), NOT by mutating the
  // global `BillingConfig` singleton row: BillingConfig is ONE row shared by the entire dev
  // database (CLAUDE.md — "a one-row table by construction"), so setting its salesTaxRate here
  // would risk leaving a stranger's dev database silently taxed if a crash ever skipped this
  // harness's own cleanup — exactly the failure mode `db-fixtures.ts`'s exact-key, fully-owned-row
  // discipline exists to rule out. `Customer.salesTaxRate` drives the IDENTICAL downstream
  // computation (`customer.taxable ? (customer.salesTaxRate ?? config.salesTaxRate) : null`,
  // invoices.ts's `buildPricingInput`) while staying entirely inside this one fixture customer's
  // own, cleanly-deletable rows.
  invCustomerCode: "E2EINVCUST",
  invPartNumber: "E2E-INV-PART",
  invPriceStepCodeACode: "E2E-INV-OPA",
  invPriceStepCodeAName: "E2E Invoice Op A",
  invPriceStepCodeBCode: "E2E-INV-OPB",
  invPriceStepCodeBName: "E2E Invoice Op B",
  invGlAccountAName: "E2E-4701",
  invGlAccountBName: "E2E-4702",
  invSurchargeName: "E2E Invoice Surcharge",
  // Task 17 (Phase 5B): the A/R flow's own customer/part/terms/payment-type — independent of
  // every fixture above (including `invCustomerCode`) for the same reason each phase's own set
  // has been kept separate throughout this file: `arCustomer` needs its OWN Terms row (2/10/30 —
  // discountPercent + discountDays, the early-pay-discount fixture the invoicing flow's own
  // customer never carries) and `surchargeOptOut: true` + `taxable: false` so its invoice totals
  // exactly (one priced operation, no surcharge/tax line) — reusing `invCustomer` would either
  // fight its own dedicated surcharge/tax setup or drag Task 20's invoicing-flow assertions into
  // this flow's fixture surface. `arPart` carries a single priced operation (unlike `invPart`'s
  // two, ruling 3's multi-operation case — not needed here) on its own dedicated step code, no GL
  // account (optional column; `invoiceWarnings` only warns, never blocks finalize).
  arCustomerCode: "E2EARCUST",
  arPartNumber: "E2E-AR-PART",
  arPriceStepCodeCode: "E2E-AR-OP",
  arPriceStepCodeName: "E2E AR Op",
  arTermsName: "E2E 2/10/30 Terms",
  arPaymentTypeName: "E2E Check",
  // Task 9 (Phase 5C): backfills the Phase 5B `arPriceStepCode`'s GL account. That step code was
  // deliberately built with none (the AR fixture's own comment: "invoiceWarnings only warns,
  // never blocks finalize") — but the close flow's `resolveReadiness`/`buildCurrentJournal` scan
  // EVERY FINALIZED invoice dated in the target month GLOBALLY, not per-customer (close-periods.ts/
  // gl-export.ts), and `receivables-apply-age-statement.mjs`'s own invoice stays FINALIZED for the
  // rest of a run (unlike `invoice-shipped-order.mjs`'s, which ends Unlocked and so drops out of
  // scope — see that flow's own file header) — so without this, the close flow's own export would
  // be refused by a gap that isn't its to fix. A step code is shared reference vocabulary (the
  // `stepCodeB` precedent), so giving it a GL account here changes nothing the Phase 5B flow itself
  // asserts (it never inspects GL accounts).
  arOpGlAccountName: "E2E-4703",

  // Task 9 (Phase 5C): the month-end-close flow's own customer/part/terms/payment-type/GL-accounts
  // — independent of every fixture above, the same reasoning FIXTURE's own comments give for every
  // earlier phase's set. `closeCustomer` carries its OWN 2/10/30 Terms (so its own payment can earn
  // an early-pay discount, the `arTerms` shape) and opts out of surcharge/tax (`invSurcharge` is
  // scope ALL/active and would otherwise ride along) so its invoice total is exactly its one priced
  // operation. Six dedicated GL accounts: one revenue account for the priced operation, four for the
  // Admin -> Billing plant defaults the close/export needs (A/R, discount, write-off, sales tax —
  // set through the real UI, not written directly, per the task brief), and one cash account for the
  // payment type (the CASH-journal debit side).
  closeCustomerCode: "E2ECLOSECUST",
  closePartNumber: "E2E-CLOSE-PART",
  closePriceStepCodeCode: "E2E-CLOSE-OP",
  closePriceStepCodeName: "E2E Close Op",
  closeTermsName: "E2E Close 2/10/30 Terms",
  closePaymentTypeName: "E2E Close Check",
  closeRevenueGlAccountName: "E2E-4801",
  closeArGlAccountName: "E2E-1205",
  closeDiscountGlAccountName: "E2E-5210",
  closeWriteOffGlAccountName: "E2E-5220",
  closeSalesTaxGlAccountName: "E2E-2305",
  closeCashGlAccountName: "E2E-1010",

  // Task 11 (Phase 6): the quoting flow's own customer/part/step-code — independent of every set
  // above, the same per-phase separation reasoning throughout this file. `quoteCustomer` opts out
  // of surcharge and tax (the `arCustomer` shape) so the flow's DRAFT invoice carries exactly the
  // ONE operation row its quote prices — the "Quote #N" source-label assertion has no surcharge or
  // tax rows to share the grid with. The part deliberately carries NO PartPrice row at all: the
  // invoice's operation row can then ONLY have come from the quote line's own QuotePrice (tier-1
  // wholesale substitution, ruling 4) — if the link failed, the line would read "needs price",
  // which the flow asserts absent. The step code prices the QUOTE row (QuotePrice.
  // processStepCodeId); it needs no GL account because the flow's invoice stays a DRAFT forever
  // (never finalized — see flows/quotes.mjs's header for why that also keeps it out of
  // close-month-end's readiness scan). `quoteEndingStatementName` is the ending statement the flow
  // creates LIVE through the admin reference page (the `liveTemplateName` precedent: name known up
  // front, id only once the flow has run) — create() does NOT insert it, but reapLeftovers/cleanup
  // both remove it by this exact name, and create() snapshots which statement was the live default
  // BEFORE the flow's promote demotes it (`priorDefaultEndingStatementId`, the `priorBillingConfig`
  // precedent for restoring shared state the flow must mutate through the real UI).
  quoteCustomerCode: "E2EQUOTECUST",
  quotePartNumber: "E2E-QUOTE-PART",
  quoteStepCodeCode: "E2E-QUOTE-OP",
  quoteStepCodeName: "E2E Quote Op",
  quoteEndingStatementName: "E2E Quote Ending Statement",
  // Task 16 (Phase 7): the document-template admin flow creates ONE DocumentTemplate LIVE through
  // /admin/templates (the `liveTemplateName` precedent — its name is known up front, its id only
  // once the flow has run), publishes it, and re-drafts it. It owns no customer, so it is reaped by
  // this exact name alone. The seeded "Standard" templates (one per docType, from migration 34)
  // are read-only in the flow and never touched, so they need no cleanup.
  docTemplateName: "E2E Doc Template",
} as const;

/**
 * The database name alone does not identify the dev database. `docker-compose.yml`'s prod profile
 * runs the app against `postgresql://erp:…@db:5432/erp` — the same name this checks for — so a
 * guard that only read the pathname would have waved through a production `DATABASE_URL` while
 * calling itself proof the harness could never touch the wrong database (Codex P1, PR #22).
 * Everything below this line hard-deletes rows and then writes fixtures, so the guard has to be
 * the strict one.
 *
 * Host is the discriminator that actually holds: the dev database is reached on localhost from
 * `.env.example`, while every non-dev deployment reaches it by service or hostname. A legitimately
 * non-local dev database is refused rather than given an escape hatch — an override on a
 * destructive guard is the kind of thing that gets set once and never unset.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertDevDb(url: string): void {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  const host = parsed.hostname;
  if (dbName !== "erp" || !LOCAL_HOSTS.has(host)) {
    throw new Error(
      `e2e fixtures must run against the LOCAL dev database — expected database "erp" on ` +
      `localhost, got "${dbName}" on "${host}". Refusing to touch it: this script hard-deletes ` +
      `fixture rows and then writes more, and the production compose profile uses the database ` +
      `name "erp" too, so the name on its own proves nothing. Point DATABASE_URL at your local ` +
      `dev database and re-run.`,
    );
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
assertDevDb(databaseUrl);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

export type Fixtures = {
  customerId: string;
  customerCode: string;
  partId: string;
  partNumber: string;
  stepCodeA: { id: string; code: string; name: string };
  stepCodeB: { id: string; code: string; name: string };
  decoyTemplateId: string;
  decoyTemplateName: string;
  liveTemplateName: string;
  adminRoleId: string;
  adminUserId: string;
  adminUsername: string;
  adminPassword: string;
  restrictedRoleId: string;
  restrictedUserId: string;
  restrictedUsername: string;
  restrictedPassword: string;
  /** Task 17's own customer/parts (see FIXTURE's comment on why these are separate from the
   *  process suite's customer/part above). The lead part already carries a working revision with
   *  one step, so it is orderable (`hasProcessSteps`) from the moment the harness starts — the
   *  order-entry-full flow's own save is what exercises the REAL `lockCurrentRevision` path
   *  against it, through the actual app, not this fixture script. */
  orderCustomerId: string;
  orderCustomerCode: string;
  orderLeadPartId: string;
  orderLeadPartNumber: string;
  orderRiderPartId: string;
  orderRiderPartNumber: string;
  /** Phase 4 (Task 20): the shipping/cert flows' own fixtures — see FIXTURE's comment. */
  shipCustomerId: string;
  shipCustomerCode: string;
  shipPartAId: string;
  shipPartANumber: string;
  shipPartBId: string;
  shipPartBNumber: string;
  certPartId: string;
  certPartNumber: string;
  holdCustomerId: string;
  holdCustomerCode: string;
  holdPartId: string;
  holdPartNumber: string;
  inspectionScaleId: string;
  inspectionScaleName: string;
  inspectionCodeAId: string;
  inspectionCodeAName: string;
  inspectionCodeBId: string;
  inspectionCodeBName: string;
  containerTypeId: string;
  containerTypeName: string;
  clerkRoleId: string;
  clerkUserId: string;
  clerkUsername: string;
  clerkPassword: string;
  /** Fix-wave 1 (Task 5 review, finding 8): the Pricing section's own E2E fixtures — see
   *  FIXTURE's comment. */
  priceStepCodeId: string;
  priceStepCodeCode: string;
  priceStepCodeName: string;
  priceEditRoleId: string;
  priceEditUserId: string;
  priceEditUsername: string;
  priceEditPassword: string;
  /** Task 20 (Phase 5A): the invoicing flow's own fixtures — see FIXTURE's comment. */
  invCustomerId: string;
  invCustomerCode: string;
  invPartId: string;
  invPartNumber: string;
  invPriceStepCodeAId: string;
  invPriceStepCodeBId: string;
  invGlAccountAId: string;
  invGlAccountAName: string;
  invGlAccountBId: string;
  invGlAccountBName: string;
  invSurchargeId: string;
  invSurchargeName: string;
  /** Task 17 (Phase 5B): the A/R flow's own fixtures — see FIXTURE's comment. */
  arCustomerId: string;
  arCustomerCode: string;
  arPartId: string;
  arPartNumber: string;
  arPriceStepCodeId: string;
  arTermsId: string;
  arPaymentTypeId: string;
  arPaymentTypeName: string;
  /** Task 9 (Phase 5C) backfill — see FIXTURE's comment. */
  arOpGlAccountId: string;
  /** Task 9 (Phase 5C): the close flow's own fixtures — see FIXTURE's comment. */
  closeCustomerId: string;
  closeCustomerCode: string;
  closePartId: string;
  closePartNumber: string;
  closePriceStepCodeId: string;
  closeTermsId: string;
  closePaymentTypeId: string;
  closePaymentTypeName: string;
  closeRevenueGlAccountId: string;
  closeArGlAccountId: string;
  closeArGlAccountName: string;
  closeDiscountGlAccountId: string;
  closeDiscountGlAccountName: string;
  closeWriteOffGlAccountId: string;
  closeWriteOffGlAccountName: string;
  closeSalesTaxGlAccountId: string;
  closeSalesTaxGlAccountName: string;
  closeCashGlAccountId: string;
  /** `BillingConfig`'s four GL-default columns as they stood BEFORE this run's browser touched
   *  them, captured in `create()` so `cleanup()` can restore the shared singleton row afterward —
   *  the same singleton-row caution FIXTURE's own comment on `salesTaxRate` explains, but these
   *  four have no per-customer escape hatch (they ARE the plant-wide GL mapping the close needs),
   *  so mutating the one shared row through the real Admin -> Billing UI is unavoidable. */
  priorBillingConfig: {
    arGlAccountId: string | null;
    discountGlAccountId: string | null;
    writeOffGlAccountId: string | null;
    salesTaxGlAccountId: string | null;
  };
  /** Task 11 (Phase 6): the quoting flow's own fixtures — see FIXTURE's comment. */
  quoteCustomerId: string;
  quoteCustomerCode: string;
  quotePartId: string;
  quotePartNumber: string;
  quoteStepCodeId: string;
  quoteStepCodeCode: string;
  quoteStepCodeName: string;
  quoteEndingStatementName: string;
  /** The id of whichever ending statement was the live default BEFORE this run — the quoting
   *  flow's create-with-default demotes it through the real service (audited on that row; that
   *  history is genuine and stays), and `cleanup()` re-promotes it after deleting the fixture
   *  statement. Null when the dev DB had no live default (the demote never fires). The
   *  `priorBillingConfig` precedent: shared state the flow must mutate through the real UI is
   *  snapshot-and-restored, never guessed. */
  priorDefaultEndingStatementId: string | null;
};

// --- Shared FK-ordered deletion, used by both cleanup() (id-driven, from a known Fixtures
// payload) and reapLeftovers() (lookup-driven, for whatever a prior aborted run left behind).
// Children before parents throughout (CLAUDE.md: deletion is otherwise always soft, but a
// leftover E2E fixture row has no business surviving in the dev DB). Every step is a no-op on an
// empty id list, so callers don't need to special-case "nothing to delete".

async function deletePartProcessData(partIds: string[]): Promise<void> {
  // Sequential, not Promise.all: in practice there is at most one partId (both create()'s single
  // fixture part and reapLeftovers' customer-scoped lookup match exactly one row), and each
  // part's own four deletes are already strictly ordered (children before parent).
  for (const partId of partIds) {
    const revisions = await prisma.partProcessRevision.findMany({ where: { partId }, select: { id: true } });
    const revisionIds = revisions.map((r) => r.id);
    await prisma.auditLog.deleteMany({ where: { entity: "partProcessRevision", entityId: { in: revisionIds } } });
    await prisma.partProcessStepValue.deleteMany({ where: { step: { revision: { partId } } } });
    await prisma.partProcessStep.deleteMany({ where: { revision: { partId } } });
    await prisma.partProcessRevision.deleteMany({ where: { partId } });
  }
}

/** Fix-wave 1 (Task 5 review, finding 8): the Pricing section fixture's own child rows. Neither
 *  `PartPrice.partId` nor `PartPrice.processStepCodeId` cascades (plain restrict-on-delete FKs,
 *  prisma/schema.prisma) — both the fixture part and its price step code would otherwise 23503 on
 *  delete once a live price row references them. Must run before both `deletePartsAndCustomers`
 *  and `deleteStepCodes`. `PartPriceBreak` cascades from neither side automatically either, so it
 *  goes first here too, even though this harness never gives its price row a break. */
async function deletePartPrices(partIds: string[]): Promise<void> {
  if (partIds.length === 0) return;
  // Fix-wave 2 (finding 2): sweep AuditLog rows the same way deletePartProcessData and
  // deleteTemplatesAndSteps already do for their own entities — see the finding-12 comment above
  // in deleteOrdersAndChildren for what happens to a fixture file that skips this. Harmless today
  // (this fixture writes its price row directly on `tx`, bypassing auditedCreate), but the first
  // flow that mutates a price through the app would otherwise leak one permanent orphaned
  // AuditLog row per mutation into the dev DB.
  const prices = await prisma.partPrice.findMany({ where: { partId: { in: partIds } }, select: { id: true } });
  const priceIds = prices.map((p) => p.id);
  const breaks = await prisma.partPriceBreak.findMany({
    where: { partPriceId: { in: priceIds } }, select: { id: true },
  });
  const breakIds = breaks.map((b) => b.id);
  await prisma.auditLog.deleteMany({ where: { entity: "partPriceBreak", entityId: { in: breakIds } } });
  await prisma.partPriceBreak.deleteMany({ where: { partPrice: { partId: { in: partIds } } } });
  await prisma.auditLog.deleteMany({ where: { entity: "partPrice", entityId: { in: priceIds } } });
  await prisma.partPrice.deleteMany({ where: { partId: { in: partIds } } });
}

async function deleteTemplatesAndSteps(templateIds: string[]): Promise<void> {
  if (templateIds.length === 0) return;
  await prisma.auditLog.deleteMany({ where: { entity: "processTemplate", entityId: { in: templateIds } } });
  await prisma.processTemplateStep.deleteMany({ where: { templateId: { in: templateIds } } });
  await prisma.processTemplate.deleteMany({ where: { id: { in: templateIds } } });
}

/**
 * Task 16 (Phase 7): the ONE `DocumentTemplate` the templates-admin flow creates live through
 * /admin/templates — name-driven (the `liveTemplateName`/`deleteEndingStatementFixture` precedent:
 * its exact FIXTURE name is known up front, its id only once the flow has run). Children before
 * parent: `DocumentTemplateVersion.templateId` IS `ON DELETE CASCADE`, but the versions are deleted
 * explicitly first so `DocumentTemplate.publishedVersionId` (`ON DELETE SET NULL`) is cleared before
 * the template row goes, matching this file's children-before-parents discipline everywhere else.
 * Both entities are audited by templates.ts (documentTemplate + documentTemplateVersion), so both
 * audit-row sets are swept. `StoredDocument.templateVersionId` is `ON DELETE SET NULL` (the flow
 * prints nothing anyway). Task 20: the flow now assigns this template to a customer through the
 * customer-page picker (and clears it again) — a `CustomerTemplateAssignment`, which is a RESTRICT
 * FK into DocumentTemplate AND into Customer, so it would block BOTH this reap and
 * deletePartsAndCustomers. It is swept FIRST here (children-before-parents), scoped by the fixture
 * template ids and INCLUDING soft-deleted rows (clear only sets `deletedAt`; the row and its FK
 * remain) — so a run that assigned-then-cleared, or crashed mid-assign, both come out clean.
 * Idempotent and independent (no fixture-customer scope), so it is called unconditionally, outside
 * reapLeftovers' `total === 0` gate — and before deletePartsAndCustomers in both callers.
 */
async function deleteDocumentTemplatesByName(): Promise<void> {
  const templates = await prisma.documentTemplate.findMany({
    where: { name: FIXTURE.docTemplateName }, select: { id: true },
  });
  const ids = templates.map((t) => t.id);
  if (ids.length === 0) return;
  const assignments = await prisma.customerTemplateAssignment.findMany({
    where: { templateId: { in: ids } }, select: { id: true },
  });
  const assignmentIds = assignments.map((a) => a.id);
  if (assignmentIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "customerTemplateAssignment", entityId: { in: assignmentIds } } });
    await prisma.customerTemplateAssignment.deleteMany({ where: { id: { in: assignmentIds } } });
  }
  const versions = await prisma.documentTemplateVersion.findMany({
    where: { templateId: { in: ids } }, select: { id: true },
  });
  const versionIds = versions.map((v) => v.id);
  if (versionIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "documentTemplateVersion", entityId: { in: versionIds } } });
    await prisma.documentTemplateVersion.deleteMany({ where: { id: { in: versionIds } } });
  }
  await prisma.auditLog.deleteMany({ where: { entity: "documentTemplate", entityId: { in: ids } } });
  await prisma.documentTemplate.deleteMany({ where: { id: { in: ids } } });
}

async function deleteStepCodes(stepCodeIds: string[]): Promise<void> {
  if (stepCodeIds.length === 0) return;
  // ProcessStepFieldDef cascades from ProcessStepCode (schema onDelete: Cascade) — the values
  // and steps that would otherwise block that cascade (fieldDefId/codeId are both plain
  // restrict-on-delete FKs) must already be gone by the time this runs — see
  // deletePartProcessData/deleteTemplatesAndSteps above, both of which callers run first.
  await prisma.processStepCode.deleteMany({ where: { id: { in: stepCodeIds } } });
}

async function deletePartsAndCustomers(partIds: string[], customerIds: string[]): Promise<void> {
  // Phase 4: the cert fixture part carries PartInspection rows (the cert-seeding source) —
  // restrict-on-delete children of Part, so they go first. No-op for every other part.
  if (partIds.length > 0) await prisma.partInspection.deleteMany({ where: { partId: { in: partIds } } });
  if (partIds.length > 0) await prisma.part.deleteMany({ where: { id: { in: partIds } } });
  if (customerIds.length > 0) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
}

/**
 * Task 17: every order the E2E flows create, scoped through the fixture order-customer's id —
 * the same "customer is the gate" reasoning `reapLeftovers`' own comment already gives for parts
 * (an order's natural key is really `(customerId, orderNumber)`; nothing here ever matches on a
 * bare orderNumber, which — unlike a part number — isn't even scoped to a customer at all, so a
 * number-based lookup would risk sweeping up a real shop order that happened to share one).
 * `Order.deletedAt` is NOT filtered here: the void-order flow's whole point is to leave the order
 * voided, and a leftover voided fixture order is exactly as unwelcome in the dev DB as a live one.
 *
 * This intentionally does what the app itself never does — hard-delete an `Order` and its
 * `StoredDocument` rows (§4/§5b: a real traveler print has no delete path and an order's number is
 * never reused) — for the same reason `deleteTemplatesAndSteps`/`deleteStepCodes` above already
 * hard-delete rows the app only ever soft-deletes: a leftover E2E fixture row has no business
 * surviving in the developer's own database, and this script is not a user of the app's UI.
 *
 * FK order matters: every order-child table (StoredDocument/OrderAttachment/OrderSerial/
 * OrderCharge/Load/OrderContainer/OrderLine) references `orderId` with no cascade, so all of them
 * must go before the `Order` row itself; `OrderLine.partId` is a plain restrict-on-delete FK too,
 * which is why `deletePartsAndCustomers` (parts) must run AFTER this, not before.
 */
async function deleteOrdersAndChildren(customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  const orders = await prisma.order.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length === 0) return;

  await prisma.auditLog.deleteMany({ where: { entity: "order", entityId: { in: orderIds } } });
  // Fix-wave finding 12: StoredDocument's own audit rows are keyed by the DOCUMENT's id, not the
  // order's (traveler.ts's `auditedCreate("storedDocument", meta, ...)` — audit.ts's AuditableModel
  // entity is "storedDocument", entityId is the document row's own id). The "order" deleteMany
  // above never reaches them, so every e2e run that prints a traveler (loads-after-print.mjs,
  // order-entry-full.mjs's Save & Print) left one permanent orphaned audit row behind per print,
  // forever, in the developer's own dev database. Collect the document ids before deleting the
  // rows themselves, and delete their audit rows the same way the order's own are deleted above.
  const documents = await prisma.storedDocument.findMany({
    where: { orderId: { in: orderIds } }, select: { id: true },
  });
  const documentIds = documents.map((d) => d.id);
  if (documentIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "storedDocument", entityId: { in: documentIds } } });
  }
  await prisma.storedDocument.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderAttachment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderSerial.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderCharge.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.load.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderContainer.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
}

/**
 * Phase 4 (Task 20): every shipment and certification the flows produced, scoped through the
 * fixture customers exactly like `deleteOrdersAndChildren` — a shipment's own natural scope is
 * `Shipper.customerId`, and a cert's is its order's customer. Must run BEFORE
 * `deleteOrdersAndChildren`: `Cert.orderId`, `ShipperOrder.orderId`, `CertRequirement.orderLineId`,
 * `ShipperLine.orderLineId` and `ShipperContainer.orderContainerId` are all plain
 * restrict-on-delete FKs into the order tables. `deletedAt` is deliberately NOT filtered anywhere
 * here — the void-shipment flow's whole point is to leave one shipment (and multi-order-shipment
 * leaves one cert) voided, and a leftover voided fixture row is exactly as unwelcome as a live one.
 *
 * Audit rows: shipper and cert mutations write entries keyed by THEIR OWN entity/entityId
 * ("shipper"/"cert"), and each print archives a StoredDocument whose audit entry is keyed by the
 * DOCUMENT's id (the fix-wave-12 lesson recorded on deleteOrdersAndChildren) — all three swept
 * here, before the rows themselves go.
 */
async function deleteShippingAndCerts(customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  const orders = await prisma.order.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  const shippers = await prisma.shipper.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
  const shipperIds = shippers.map((s) => s.id);
  const certs = await prisma.cert.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
  const certIds = certs.map((c) => c.id);
  if (shipperIds.length === 0 && certIds.length === 0) return;

  // Shipper/cert-owned documents; order-owned ones (travelers, and SHIPPER docs that also carry
  // an orderId sub-scope — those carry shipperId too, so this match is a superset) are ALSO
  // covered by deleteOrdersAndChildren, but that runs after this and deleteMany is a no-op on
  // already-deleted ids, so there is no double-delete hazard, only belt and braces.
  const documents = await prisma.storedDocument.findMany({
    where: { OR: [{ shipperId: { in: shipperIds } }, { certId: { in: certIds } }] },
    select: { id: true },
  });
  const documentIds = documents.map((d) => d.id);

  await prisma.auditLog.deleteMany({ where: { entity: "shipper", entityId: { in: shipperIds } } });
  await prisma.auditLog.deleteMany({ where: { entity: "cert", entityId: { in: certIds } } });
  if (documentIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "storedDocument", entityId: { in: documentIds } } });
    await prisma.storedDocument.deleteMany({ where: { id: { in: documentIds } } });
  }

  // Children before parents; Cert before Shipper (Cert.shipperId is a plain FK).
  await prisma.certReading.deleteMany({ where: { requirement: { certId: { in: certIds } } } });
  await prisma.certRequirement.deleteMany({ where: { certId: { in: certIds } } });
  await prisma.cert.deleteMany({ where: { id: { in: certIds } } });
  await prisma.shipperLine.deleteMany({ where: { shipperOrder: { shipperId: { in: shipperIds } } } });
  await prisma.shipperContainer.deleteMany({ where: { shipperOrder: { shipperId: { in: shipperIds } } } });
  await prisma.shipperSerial.deleteMany({ where: { shipperOrder: { shipperId: { in: shipperIds } } } });
  await prisma.shipperOrder.deleteMany({ where: { shipperId: { in: shipperIds } } });
  await prisma.shipper.deleteMany({ where: { id: { in: shipperIds } } });
}

/**
 * Task 20 (Phase 5A): every invoice/credit the invoicing flow produced, scoped through the
 * fixture customer exactly like `deleteShippingAndCerts` above. Must run BEFORE
 * `deleteOrdersAndChildren`: `Invoice.orderId` is a plain RESTRICT-on-delete FK
 * (`prisma/migrations/20260806221500_pricing_and_invoicing/migration.sql:287`), so a live invoice
 * blocks deleting its order.
 *
 * `StoredDocument.invoiceId` is declared `ON DELETE SET NULL`, unlike every other owner column on
 * that table — but a SET NULL here would immediately violate `StoredDocument_kind_owner_check`
 * (an INVOICE/CREDIT row's `invoiceId` may never be null), so in practice an invoice with a
 * printed document still cannot be deleted until the document itself is gone first; this deletes
 * those documents (and their own audit rows, the `deleteOrdersAndChildren`/`deleteShippingAndCerts`
 * precedent) explicitly rather than relying on the FK action to do it.
 *
 * `InvoiceLine.invoiceId` is RESTRICT too, so lines go before the invoice row; `deletedAt` is
 * deliberately NOT filtered (a discarded draft is exactly as unwelcome as a live one).
 */
/**
 * Task 17 (Phase 5B): every `Application`/`Payment`/`ReceiptBatch` the A/R flow produced, scoped
 * through the fixture A/R customer's own id — `Payment.customerId` is the natural scope (an
 * `Application`'s own scope is derived from it below, and a `ReceiptBatch` has no customer column
 * of its own — it holds many payers' payments in general, but in this harness only ever the one
 * this flow creates for `arCustomer`, so the batch is reached by walking its payments).
 *
 * Must run BEFORE `deleteInvoicesAndLines`: `Application.invoiceId`/`creditInvoiceId` are plain
 * FKs into `Invoice` (`creditInvoiceId` is `ON DELETE SET NULL`, but `invoiceId` is
 * `ON DELETE RESTRICT` — migrations/20260808230100_accounts_receivable/migration.sql), so a live
 * (or voided — `deletedAt` is deliberately NOT filtered here, the `deleteOrdersAndChildren`
 * precedent) `Application` row still blocks deleting the invoice it targets. Must also run before
 * `deletePartsAndCustomers`: `Payment.customerId` is `ON DELETE RESTRICT` too. `Application.
 * paymentId` is `ON DELETE SET NULL`, so payments could in principle be deleted before their
 * applications without a 23503 — deleted in the RESTRICT-safe order anyway (applications first)
 * for one uniform rule rather than two.
 */
async function deleteReceivables(customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  const invoices = await prisma.invoice.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
  const invoiceIds = invoices.map((i) => i.id);
  const payments = await prisma.payment.findMany({ where: { customerId: { in: customerIds } }, select: { id: true, batchId: true } });
  const paymentIds = payments.map((p) => p.id);
  const batchIds = [...new Set(payments.map((p) => p.batchId))];

  const applications = await prisma.application.findMany({
    where: {
      OR: [
        { invoiceId: { in: invoiceIds } },
        { creditInvoiceId: { in: invoiceIds } },
        { paymentId: { in: paymentIds } },
      ],
    },
    select: { id: true },
  });
  const applicationIds = applications.map((a) => a.id);
  if (applicationIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "application", entityId: { in: applicationIds } } });
    await prisma.application.deleteMany({ where: { id: { in: applicationIds } } });
  }

  if (paymentIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "payment", entityId: { in: paymentIds } } });
    await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
  }
  if (batchIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "receiptBatch", entityId: { in: batchIds } } });
    await prisma.receiptBatch.deleteMany({ where: { id: { in: batchIds } } });
  }
}

/**
 * Task 17 (Phase 5B): every archived STATEMENT `StoredDocument` the A/R flow's statement print
 * produced — owned by `customerId` alone (schema comment: "STATEMENT: owner"), unlike every other
 * document kind cleaned up elsewhere in this file (order/shipper/cert/invoice-owned). Must run
 * BEFORE `deletePartsAndCustomers`: `StoredDocument.customerId` is `ON DELETE SET NULL`
 * (migrations/20260808230100_accounts_receivable/migration.sql), so deleting the customer without
 * deleting this row first would NULL its `customerId` out from under it — and a null `customerId`
 * on a STATEMENT row immediately violates `StoredDocument_kind_owner_check` (STATEMENT requires
 * `customerId` NOT NULL, every other owner column NULL). Caught live: the first run of this flow's
 * cleanup failed on exactly this 23514.
 */
async function deleteStatementDocuments(customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  const documents = await prisma.storedDocument.findMany({
    where: { customerId: { in: customerIds }, kind: "STATEMENT" }, select: { id: true },
  });
  const documentIds = documents.map((d) => d.id);
  if (documentIds.length === 0) return;
  await prisma.auditLog.deleteMany({ where: { entity: "storedDocument", entityId: { in: documentIds } } });
  await prisma.storedDocument.deleteMany({ where: { id: { in: documentIds } } });
}

/**
 * Task 17 (Phase 5B) backstop: hard-deletes ONE specific `ReceiptBatch` by id, if it still exists
 * — the id-driven counterpart to `deleteReceivables` above for the one case that sweep can't see
 * (a batch created but never paid into, so no `Payment` row exists to find it through). Called
 * ONLY with an id this run's own flow created and read back off the URL (`CleanupPayload`'s own
 * comment) — never a guessed or pattern-matched id, so there is no risk of touching a real user's
 * batch. A no-op both when `id` is `null` (the flow never got this far) and when the row is
 * already gone (the normal case — `deleteReceivables` already found and removed it via its
 * payment).
 */
async function deleteKnownEmptyBatch(id: string | null): Promise<void> {
  if (!id) return;
  await prisma.auditLog.deleteMany({ where: { entity: "receiptBatch", entityId: id } });
  await prisma.receiptBatch.deleteMany({ where: { id } });
}

/**
 * Task 9 (Phase 5C): hard-deletes the ONE `ClosePeriod` (+ its `GlExportBatch`/`GlPosting` rows)
 * the close-month-end flow ITSELF closed, scoped by the EXACT `(year, month)` it tested — passed
 * back from `ctx.created`, but (fix round 1, review) recorded by the flow ONLY AFTER its own
 * `closePeriod` POST has actually succeeded, never up front — see `close-month-end.mjs`'s own file-
 * header comment on why. A no-op when `year`/`month` is null: that happens whenever this flow never
 * reached (or never completed) its own close, INCLUDING when the pre-flight guard refused because a
 * REAL `ClosePeriod` already covered the month — the guard alone stops this script from POSTing into
 * that period, but it is the assign-after-close ordering in the flow that stops CLEANUP from later
 * hard-deleting it (a guard failure throws before the flow ever assigns `ctx.created.
 * closePeriodYear`/`Month`, so `run.mjs`'s `finally { teardown() }` calls this with `null, null` —
 * a no-op — even though `ctx.created` itself is torn down on every exit path, pass or fail).
 *
 * `closedById` is the belt-and-suspenders second check: only a `ClosePeriod` row whose `closedById`
 * matches THIS run's own fixture admin (`fixtures.adminUserId`) is ever deleted — a genuine second
 * signal, not just the same fact checked twice, since it also protects against theoretically finding
 * a stray same-`(year,month)` row that isn't this run's if the id-driven ordering above were ever
 * weakened by a future edit. Deliberately NOT a name-based `reapLeftovers` sweep either: a
 * `ClosePeriod` carries no fixture-recognizable name of its own, so a broader "any E2E-looking
 * period" scan would risk touching a real close a developer or the owner made by hand after this
 * feature ships — this only ever touches the exact period THIS run itself closed. `GlExportBatch`/
 * `GlPosting` have no `onDelete` override on their parent FKs (plain RESTRICT), so children go first.
 */
async function deleteClosePeriodFixture(
  year: number | null, month: number | null, closedById: string | null,
): Promise<void> {
  if (year === null || month === null) return;
  const period = await prisma.closePeriod.findFirst({ where: { year, month, closedById }, select: { id: true } });
  if (!period) return;
  const batches = await prisma.glExportBatch.findMany({ where: { closePeriodId: period.id }, select: { id: true } });
  const batchIds = batches.map((b) => b.id);
  if (batchIds.length > 0) {
    await prisma.glPosting.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.auditLog.deleteMany({ where: { entity: "glExportBatch", entityId: { in: batchIds } } });
    await prisma.glExportBatch.deleteMany({ where: { id: { in: batchIds } } });
  }
  await prisma.auditLog.deleteMany({ where: { entity: "closePeriod", entityId: period.id } });
  await prisma.closePeriod.deleteMany({ where: { id: period.id } });
}

/**
 * Task 9 (Phase 5C): restores `BillingConfig`'s four GL-default columns to whatever they held
 * BEFORE this run's close-month-end flow edited them through the real Admin -> Billing UI — the
 * mitigation for the one singleton-row mutation this file cannot avoid (see the `Fixtures.
 * priorBillingConfig` doc comment). `prior` is `undefined` only if `create()` never ran this
 * session (a `cleanup`-only invocation against a payload missing the field) — a no-op, not an error.
 * MUST run before `deleteInvoicingReference` deletes the fixture GL accounts these columns may
 * still point at (BillingConfig's four GL FKs are plain RESTRICT, no `onDelete` override).
 */
async function restoreBillingConfig(prior: Fixtures["priorBillingConfig"] | undefined): Promise<void> {
  if (!prior) return;
  await prisma.billingConfig.update({ where: { id: "singleton" }, data: { ...prior } });
}

async function deleteInvoicesAndLines(customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  const orders = await prisma.order.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length === 0) return;
  const invoices = await prisma.invoice.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
  const invoiceIds = invoices.map((i) => i.id);
  if (invoiceIds.length === 0) return;

  const documents = await prisma.storedDocument.findMany({
    where: { invoiceId: { in: invoiceIds } }, select: { id: true },
  });
  const documentIds = documents.map((d) => d.id);
  if (documentIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "storedDocument", entityId: { in: documentIds } } });
    await prisma.storedDocument.deleteMany({ where: { id: { in: documentIds } } });
  }
  await prisma.auditLog.deleteMany({ where: { entity: "invoice", entityId: { in: invoiceIds } } });
  await prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
}

/**
 * Task 11 (Phase 6): every quote (lines, price rows, breaks, stored QUOTE documents) the quoting
 * flow produced, scoped through the fixture quote-customer's id exactly like
 * `deleteOrdersAndChildren` — `Quote.customerId` is the natural scope, and quotes are only ever
 * created live through the app, so the customer is the gate. `deletedAt` is deliberately NOT
 * filtered (a soft-deleted quote is exactly as unwelcome as a live one).
 *
 * FK order (all verified against migrations/20260810120100_quoting/migration.sql):
 *  - `StoredDocument.quoteId` is `ON DELETE SET NULL`, which would immediately violate
 *    `StoredDocument_kind_owner_check` on a QUOTE-kind row (QUOTE requires `quoteId` NOT NULL) —
 *    so QUOTE documents (and their own document-keyed audit rows) go explicitly first, the
 *    `deleteStatementDocuments` precedent.
 *  - `QuotePriceBreak.quotePriceId` / `QuotePrice.quoteLineId` / `QuoteLine.quoteId` are all
 *    RESTRICT — children before parents.
 *  - Callers must run this BEFORE `deleteStepCodes` (`QuotePrice.processStepCodeId` RESTRICT),
 *    BEFORE `deletePartsAndCustomers` (`Quote.customerId` RESTRICT), and BEFORE
 *    `deleteUsersAndRoles` (`Quote.quotedById` RESTRICT). `OrderLine.quoteLineId` is SET NULL, so
 *    ordering against `deleteOrdersAndChildren` is not FK-forced — run after it anyway, matching
 *    the app's own orders→quote resolution direction.
 *
 * Audit rows: every quote mutation is audited at the QUOTE level (quotes.ts — create/update/
 * attach/close/reopen/delete all key entity "quote", entityId the quote's own id; lines/prices/
 * breaks ride the quote-level snapshot diff, never their own entries), so one entity-"quote"
 * sweep covers the tree.
 */
async function deleteQuotesAndChildren(customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  const quotes = await prisma.quote.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
  const quoteIds = quotes.map((q) => q.id);
  if (quoteIds.length === 0) return;

  const documents = await prisma.storedDocument.findMany({
    where: { quoteId: { in: quoteIds } }, select: { id: true },
  });
  const documentIds = documents.map((d) => d.id);
  if (documentIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "storedDocument", entityId: { in: documentIds } } });
    await prisma.storedDocument.deleteMany({ where: { id: { in: documentIds } } });
  }

  await prisma.auditLog.deleteMany({ where: { entity: "quote", entityId: { in: quoteIds } } });
  await prisma.quotePriceBreak.deleteMany({ where: { quotePrice: { quoteLine: { quoteId: { in: quoteIds } } } } });
  await prisma.quotePrice.deleteMany({ where: { quoteLine: { quoteId: { in: quoteIds } } } });
  await prisma.quoteLine.deleteMany({ where: { quoteId: { in: quoteIds } } });
  await prisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
}

/**
 * Task 11 (Phase 6): removes the ending statement the quoting flow created LIVE through the admin
 * reference page — name-driven (the `liveTemplateName` precedent: its id is only known once the
 * flow has run, its exact `FIXTURE` name is known up front), with its own audit rows swept first
 * (the row IS created through the audited reference service, unlike this script's direct-`tx`
 * reference fixtures). Then restores the pre-run default: the flow's create-with-default demoted
 * whichever statement was the live default through the real service, and `priorDefaultId` (from
 * `create()`'s snapshot) is re-promoted with a direct conditional write — the
 * `restoreBillingConfig` precedent for shared dev-DB state a flow must mutate through the real UI.
 * The demote's audit entry on that row is genuine history and stays. No-ops throughout: no fixture
 * row found, no prior default, or the prior row since deleted (`updateMany` guarded on
 * `deletedAt: null`). Run AFTER `deleteQuotesAndChildren` — `Quote.endingStatementId` is SET NULL,
 * so this is convention (quotes reference the statement), not an FK requirement.
 */
async function deleteEndingStatementFixture(priorDefaultId: string | null | undefined): Promise<void> {
  const rows = await prisma.endingStatement.findMany({
    where: { name: FIXTURE.quoteEndingStatementName }, select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entity: "endingStatement", entityId: { in: ids } } });
    await prisma.endingStatement.deleteMany({ where: { id: { in: ids } } });
  }
  if (priorDefaultId) {
    await prisma.endingStatement.updateMany({
      where: { id: priorDefaultId, deletedAt: null }, data: { isDefault: true },
    });
  }
}

/** Phase 4 reference rows (created by this script, never through the app, so no audit rows).
 *  Runs LAST of the data deletes: `CertRequirement.inspectionCodeId`/`scaleId`,
 *  `PartInspection.inspectionCodeId`/`scaleId` and `OrderContainer.typeId` are restrict-on-delete
 *  FKs, so certs, part inspections and orders must all be gone first. Codes before scales —
 *  `InspectionCode.defaultScaleId` points at the scale. */
async function deletePhase4Reference(scaleIds: string[], codeIds: string[], typeIds: string[]): Promise<void> {
  if (codeIds.length > 0) await prisma.inspectionCode.deleteMany({ where: { id: { in: codeIds } } });
  if (scaleIds.length > 0) await prisma.inspectionScale.deleteMany({ where: { id: { in: scaleIds } } });
  if (typeIds.length > 0) await prisma.containerType.deleteMany({ where: { id: { in: typeIds } } });
}

/** Task 20 (Phase 5A) reference rows — created directly on `tx`, never through the app, so no
 *  audit rows of their own. Must run AFTER `deleteStepCodes`: `ProcessStepCode.glAccountId` is a
 *  plain FK into `GlAccount` with no `onDelete` override (RESTRICT), so the two step codes that
 *  reference these GL accounts must already be gone. `Surcharge` has no incoming FK left by this
 *  point (`InvoiceLine.surchargeId` is `SET NULL`, and every invoice line is already gone via
 *  `deleteInvoicesAndLines`), so it carries no ordering requirement of its own. */
async function deleteInvoicingReference(glAccountIds: string[], surchargeIds: string[]): Promise<void> {
  if (surchargeIds.length > 0) await prisma.surcharge.deleteMany({ where: { id: { in: surchargeIds } } });
  if (glAccountIds.length > 0) await prisma.glAccount.deleteMany({ where: { id: { in: glAccountIds } } });
}

/** Task 17 (Phase 5B) reference rows — created directly on `tx`, never through the app, so no
 *  audit rows of their own (the `deleteInvoicingReference` precedent). `Customer.termsId` is
 *  `ON DELETE SET NULL` (migrations/20260731013829_customer/migration.sql), so `Terms` carries no
 *  ordering requirement against `arCustomer`; `PaymentType` IS `ON DELETE RESTRICT` from
 *  `Payment.paymentTypeId`, so this must run AFTER `deleteReceivables` (which removes every
 *  `Payment` row this flow created). */
async function deleteArReference(termsIds: string[], paymentTypeIds: string[]): Promise<void> {
  if (termsIds.length > 0) await prisma.terms.deleteMany({ where: { id: { in: termsIds } } });
  if (paymentTypeIds.length > 0) await prisma.paymentType.deleteMany({ where: { id: { in: paymentTypeIds } } });
}

async function deleteUsersAndRoles(userIds: string[], roleIds: string[]): Promise<void> {
  // Session, OrderDraft, and SavedView all have `ON DELETE RESTRICT` from User (verified against
  // the generated migration SQL, not assumed from schema.prisma's silence on the point) — every
  // one of them must go first or the User delete below 23503s. OrderDraft/SavedView are new here
  // (Task 17): no flow before Phase 3 ever wrote to either table, so this gap was latent, not
  // exercised, until order-entry-full's own autosave started giving e2e_admin a real OrderDraft
  // row. `createOrder`'s save only ever NULLS a draft's payload (spec §5.5's "same transaction as
  // the save" clearing) — the row itself, keyed uniquely by userId, survives a successful save,
  // so a leftover row is the NORMAL case here, not an edge case.
  if (userIds.length > 0) await prisma.orderDraft.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length > 0) await prisma.savedView.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length > 0) await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (roleIds.length > 0) await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
}

/**
 * Self-heal: deletes any E2E fixture rows a prior run left behind — a crash, a killed process, or
 * (before this existed) a Ctrl-C that skipped the finally-block cleanup — by looking them up on
 * their natural keys rather than trusting any id handed in. Those keys are matched EXACTLY, from
 * the single `FIXTURE` list above; an earlier version scanned for the shared "E2E"/"e2e" prefix
 * instead, which meant a run started in the developer's own dev database would hard-delete any
 * template, part, step code, customer, user or role that merely began with those letters (Codex
 * P1, 2026-08-02). Nothing is gained by the looser match: every name this harness produces —
 * `create()`'s own rows and template-build-and-load.mjs's live-built template alike — is a literal
 * declared in `FIXTURE`.
 *
 * Called unconditionally at the top of `create()`, so a run started right after an aborted one
 * heals itself instead of throwing on a unique-constraint conflict and never reaching the point
 * where `fixtures` gets assigned (which is what previously made the *next* run's cleanup silently
 * do nothing too — no self-heal, wedged indefinitely).
 */
async function reapLeftovers(): Promise<void> {
  // Task 16: name-based and independent of every fixture-customer scope below, so it runs first and
  // unconditionally — a lone leftover document template must be reaped even when the `total === 0`
  // gate further down would otherwise return early.
  await deleteDocumentTemplatesByName();
  const [
    templates, parts, stepCodes, customers, users, roles, orderCustomers, orderParts,
    shipCustomers, holdCustomers, phase4Parts, scales, codes, containerTypes,
    invCustomers, invParts, invGlAccounts, invSurcharges,
    arCustomers, arParts, arTermsRows, arPaymentTypes,
    closeCustomers, closeParts, closeGlAccounts, closeTermsRows, closePaymentTypes,
    quoteCustomers, quoteParts, endingStatements,
  ] = await Promise.all([
    prisma.processTemplate.findMany({
      where: { name: { in: [FIXTURE.decoyTemplateName, FIXTURE.liveTemplateName] } }, select: { id: true },
    }),
    // Deliberately NOT resolved here — a part's natural key is (customerId, partNumber), so
    // matching the number alone would sweep up another customer's legitimately-numbered part and
    // hard-delete it with its process revisions (Codex P1, PR #22). Scoped through the fixture
    // customer below instead. Safe to make the customer the gate: cleanup deletes parts BEFORE
    // customers, so a fixture part can never outlive its fixture customer.
    prisma.part.findMany({
      where: { partNumber: FIXTURE.partNumber, customer: { code: FIXTURE.customerCode } },
      select: { id: true },
    }),
    prisma.processStepCode.findMany({
      where: {
        code: {
          in: [
            FIXTURE.stepCodeA, FIXTURE.stepCodeB, FIXTURE.priceStepCodeCode,
            FIXTURE.invPriceStepCodeACode, FIXTURE.invPriceStepCodeBCode,
            FIXTURE.arPriceStepCodeCode, FIXTURE.closePriceStepCodeCode,
            FIXTURE.quoteStepCodeCode,
          ],
        },
      },
      select: { id: true },
    }),
    prisma.customer.findMany({ where: { code: FIXTURE.customerCode }, select: { id: true } }),
    prisma.user.findMany({
      where: {
        username: {
          in: [FIXTURE.adminUsername, FIXTURE.restrictedUsername, FIXTURE.clerkUsername, FIXTURE.priceEditUsername],
        },
      },
      select: { id: true },
    }),
    prisma.role.findMany({
      where: {
        name: {
          in: [FIXTURE.adminRoleName, FIXTURE.restrictedRoleName, FIXTURE.clerkRoleName, FIXTURE.priceEditRoleName],
        },
      },
      select: { id: true },
    }),
    // Task 17's own customer, looked up the same way as the process suite's above — its id is
    // ALSO the gate for that customer's orders below, since Order.customerId is a real scope
    // (unlike a template, which has no owning customer at all).
    prisma.customer.findMany({ where: { code: FIXTURE.orderCustomerCode }, select: { id: true } }),
    prisma.part.findMany({
      where: {
        partNumber: { in: [FIXTURE.orderLeadPartNumber, FIXTURE.orderRiderPartNumber] },
        customer: { code: FIXTURE.orderCustomerCode },
      },
      select: { id: true },
    }),
    // Phase 4 (Task 20): the shipping/cert fixtures, looked up the same exact-key,
    // customer-scoped way as everything above.
    prisma.customer.findMany({ where: { code: FIXTURE.shipCustomerCode }, select: { id: true } }),
    prisma.customer.findMany({ where: { code: FIXTURE.holdCustomerCode }, select: { id: true } }),
    prisma.part.findMany({
      where: {
        OR: [
          {
            partNumber: { in: [FIXTURE.shipPartANumber, FIXTURE.shipPartBNumber, FIXTURE.certPartNumber] },
            customer: { code: FIXTURE.shipCustomerCode },
          },
          { partNumber: FIXTURE.holdPartNumber, customer: { code: FIXTURE.holdCustomerCode } },
        ],
      },
      select: { id: true },
    }),
    prisma.inspectionScale.findMany({ where: { name: FIXTURE.inspectionScaleName }, select: { id: true } }),
    prisma.inspectionCode.findMany({
      where: { name: { in: [FIXTURE.inspectionCodeAName, FIXTURE.inspectionCodeBName] } }, select: { id: true },
    }),
    prisma.containerType.findMany({ where: { name: FIXTURE.containerTypeName }, select: { id: true } }),
    // Task 20 (Phase 5A): the invoicing flow's own fixtures, looked up the same exact-key,
    // customer-scoped way as everything above.
    prisma.customer.findMany({ where: { code: FIXTURE.invCustomerCode }, select: { id: true } }),
    prisma.part.findMany({
      where: { partNumber: FIXTURE.invPartNumber, customer: { code: FIXTURE.invCustomerCode } },
      select: { id: true },
    }),
    prisma.glAccount.findMany({
      where: { name: { in: [FIXTURE.invGlAccountAName, FIXTURE.invGlAccountBName] } }, select: { id: true },
    }),
    prisma.surcharge.findMany({ where: { name: FIXTURE.invSurchargeName }, select: { id: true } }),
    // Task 17 (Phase 5B): the A/R flow's own fixtures, looked up the same exact-key,
    // customer-scoped way as everything above.
    prisma.customer.findMany({ where: { code: FIXTURE.arCustomerCode }, select: { id: true } }),
    prisma.part.findMany({
      where: { partNumber: FIXTURE.arPartNumber, customer: { code: FIXTURE.arCustomerCode } },
      select: { id: true },
    }),
    prisma.terms.findMany({ where: { name: FIXTURE.arTermsName }, select: { id: true } }),
    prisma.paymentType.findMany({ where: { name: FIXTURE.arPaymentTypeName }, select: { id: true } }),
    // Task 9 (Phase 5C): the close flow's own fixtures, looked up the same exact-key,
    // customer-scoped way as everything above.
    prisma.customer.findMany({ where: { code: FIXTURE.closeCustomerCode }, select: { id: true } }),
    prisma.part.findMany({
      where: { partNumber: FIXTURE.closePartNumber, customer: { code: FIXTURE.closeCustomerCode } },
      select: { id: true },
    }),
    prisma.glAccount.findMany({
      where: {
        name: {
          in: [
            FIXTURE.arOpGlAccountName, FIXTURE.closeRevenueGlAccountName, FIXTURE.closeArGlAccountName,
            FIXTURE.closeDiscountGlAccountName, FIXTURE.closeWriteOffGlAccountName,
            FIXTURE.closeSalesTaxGlAccountName, FIXTURE.closeCashGlAccountName,
          ],
        },
      },
      select: { id: true },
    }),
    prisma.terms.findMany({ where: { name: FIXTURE.closeTermsName }, select: { id: true } }),
    prisma.paymentType.findMany({ where: { name: FIXTURE.closePaymentTypeName }, select: { id: true } }),
    // Task 11 (Phase 6): the quoting flow's own fixtures, looked up the same exact-key,
    // customer-scoped way as everything above. The ending statement is matched by its exact
    // FIXTURE name (the flow creates it live through the reference page).
    prisma.customer.findMany({ where: { code: FIXTURE.quoteCustomerCode }, select: { id: true } }),
    prisma.part.findMany({
      where: { partNumber: FIXTURE.quotePartNumber, customer: { code: FIXTURE.quoteCustomerCode } },
      select: { id: true },
    }),
    prisma.endingStatement.findMany({ where: { name: FIXTURE.quoteEndingStatementName }, select: { id: true } }),
  ]);
  const templateIds = templates.map((t) => t.id);
  const invCustomerIds = invCustomers.map((c) => c.id);
  const arCustomerIds = arCustomers.map((c) => c.id);
  const closeCustomerIds = closeCustomers.map((c) => c.id);
  const quoteCustomerIds = quoteCustomers.map((c) => c.id);
  const partIds = [
    ...parts.map((p) => p.id), ...orderParts.map((p) => p.id), ...phase4Parts.map((p) => p.id),
    ...invParts.map((p) => p.id), ...arParts.map((p) => p.id), ...closeParts.map((p) => p.id),
    ...quoteParts.map((p) => p.id),
  ];
  const stepCodeIds = stepCodes.map((c) => c.id);
  // Task 20/Task 17/Task 9/Task 11: `invCustomerIds`/`arCustomerIds`/`closeCustomerIds`/
  // `quoteCustomerIds` ride along in this same set — the invoicing flow, the A/R flow, the close
  // flow, AND the quoting flow each ship their own order (a real `Shipper`/`ShipperOrder` pair),
  // so `deleteShippingAndCerts` must be scoped through all of them, or a leftover shipment blocks
  // `deleteOrdersAndChildren`'s delete of the order it covers with `ShipperOrder_orderId_fkey`'s
  // RESTRICT (caught live for `invCustomerIds`: the first run of that flow's cleanup failed on
  // exactly this).
  const shipHoldCustomerIds = [
    ...shipCustomers.map((c) => c.id), ...holdCustomers.map((c) => c.id), ...invCustomerIds, ...arCustomerIds,
    ...closeCustomerIds, ...quoteCustomerIds,
  ];
  const customerIds = [
    ...customers.map((c) => c.id), ...orderCustomers.map((c) => c.id), ...shipHoldCustomerIds,
  ];
  const userIds = users.map((u) => u.id);
  const roleIds = roles.map((r) => r.id);
  const orderCustomerIds = [...orderCustomers.map((c) => c.id), ...shipHoldCustomerIds];
  const scaleIds = scales.map((s) => s.id);
  const codeIds = codes.map((c) => c.id);
  const containerTypeIds = containerTypes.map((t) => t.id);
  const invGlAccountIds = invGlAccounts.map((g) => g.id);
  const invSurchargeIds = invSurcharges.map((s) => s.id);
  const arTermsIds = arTermsRows.map((t) => t.id);
  const arPaymentTypeIds = arPaymentTypes.map((p) => p.id);
  // Task 9 (Phase 5C): includes the AR step code's backfilled `arOpGlAccount` alongside the six
  // dedicated close-flow accounts — one combined lookup, the `invGlAccounts` precedent.
  const closeGlAccountIds = closeGlAccounts.map((g) => g.id);
  const closeTermsIds = closeTermsRows.map((t) => t.id);
  const closePaymentTypeIds = closePaymentTypes.map((p) => p.id);
  const endingStatementIds = endingStatements.map((s) => s.id);

  const total = templateIds.length + partIds.length + stepCodeIds.length
    + customerIds.length + userIds.length + roleIds.length
    + scaleIds.length + codeIds.length + containerTypeIds.length
    + invGlAccountIds.length + invSurchargeIds.length
    + arTermsIds.length + arPaymentTypeIds.length
    + closeGlAccountIds.length + closeTermsIds.length + closePaymentTypeIds.length
    + endingStatementIds.length;
  if (total === 0) return;

  console.error(
    `Reaping leftover E2E fixtures from a prior run: ${templateIds.length} template(s), ` +
    `${partIds.length} part(s), ${stepCodeIds.length} step code(s), ${customerIds.length} ` +
    `customer(s), ${userIds.length} user(s), ${roleIds.length} role(s), ` +
    `${scaleIds.length + codeIds.length + containerTypeIds.length} Phase 4 reference row(s), ` +
    `${invGlAccountIds.length} GL account(s), ${invSurchargeIds.length} surcharge(s), ` +
    `${arTermsIds.length} terms row(s), ${arPaymentTypeIds.length} payment type(s), ` +
    `${closeGlAccountIds.length} close-flow GL account(s), ${closeTermsIds.length} close-flow ` +
    `terms row(s), ${closePaymentTypeIds.length} close-flow payment type(s), ` +
    `${endingStatementIds.length} ending statement(s). NOTE: this does NOT ` +
    `self-heal a leftover ClosePeriod/GlExportBatch/GlPosting row or a BillingConfig singleton row ` +
    `left mid-edit by a crashed close-month-end.mjs run — neither the exact (year, month) tested nor ` +
    `the prior BillingConfig values survive a crash outside this script's own memory. If that flow's ` +
    `own cleanup failed, check GET /api/receivables/close and Admin -> Billing by hand. It also ` +
    `cannot RE-PROMOTE an ending-statement default a crashed quotes.mjs run demoted (which row WAS ` +
    `the default doesn't survive the crash either — the fixture statement above is deleted, but if ` +
    `your dev DB had its own default, re-tick it under Admin -> Reference -> Ending statements).`,
  );

  // Receipts/invoices/shipments/certs first (their children FK into the order/invoice tables),
  // then orders. Before parts: OrderLine.partId is a plain restrict-on-delete FK, so any leftover
  // fixture order (voided by a prior run's void-order/void-shipment flow, left INVOICED by a
  // crash mid-flow, or left live by a crash before it) must be gone before
  // deletePartsAndCustomers below can touch the fixture parts. `deleteReceivables` runs first of
  // all: its `Application` rows block deleting the invoices `deleteInvoicesAndLines` removes next.
  await deleteReceivables([...arCustomerIds, ...closeCustomerIds]);
  await deleteInvoicesAndLines([...invCustomerIds, ...arCustomerIds, ...closeCustomerIds, ...quoteCustomerIds]);
  await deleteShippingAndCerts(shipHoldCustomerIds);
  await deleteOrdersAndChildren(orderCustomerIds);
  // Task 11: quotes after orders (convention — OrderLine.quoteLineId is SET NULL either way),
  // before step codes/parts/customers/users (all RESTRICT — see deleteQuotesAndChildren's own
  // comment). The ending statement follows the quotes that reference it; no prior default to
  // restore here (see the NOTE above — that id doesn't survive a crash).
  await deleteQuotesAndChildren(quoteCustomerIds);
  await deleteEndingStatementFixture(null);
  await deletePartProcessData(partIds);
  await deleteTemplatesAndSteps(templateIds);
  // Before both deleteStepCodes (the price step code's own restrict-on-delete FK) and
  // deletePartsAndCustomers (the fixture part's).
  await deletePartPrices(partIds);
  await deleteStepCodes(stepCodeIds);
  // Before deletePartsAndCustomers: StoredDocument.customerId is ON DELETE SET NULL, which would
  // otherwise violate StoredDocument_kind_owner_check on a live STATEMENT document the moment its
  // customer is deleted (deleteStatementDocuments's own comment).
  await deleteStatementDocuments(arCustomerIds);
  await deletePartsAndCustomers(partIds, customerIds);
  await deletePhase4Reference(scaleIds, codeIds, containerTypeIds);
  // Task 9: BEFORE deleteInvoicingReference (payment types' own GL-account FKs — the close flow's
  // payment type, unlike the AR flow's, carries one) and after deleteReceivables (PaymentType is ON
  // DELETE RESTRICT from Payment) — swapped from the pre-Task-9 order, which ran the GL-account
  // delete first only because no payment type referenced one yet.
  await deleteArReference([...arTermsIds, ...closeTermsIds], [...arPaymentTypeIds, ...closePaymentTypeIds]);
  // After deleteStepCodes (the invoicing/close step codes' own GL-account FKs) and after
  // deleteArReference immediately above (the close payment type's own GL-account FK).
  await deleteInvoicingReference([...invGlAccountIds, ...closeGlAccountIds], invSurchargeIds);
  await deleteUsersAndRoles(userIds, roleIds);
}

/**
 * Everything every flow needs already sitting in the dev DB before the browser opens: a
 * customer + part (flows 1-4 build on this one part), two process step codes (one carrying a
 * NUMBER + CHECKBOX field, for the typed-fields flow; one plain text-only, for template-build's
 * second step), a second template with no matching name (so processes-list's search
 * demonstrably narrows something away), and two role/user pairs: a full-permission one for flows
 * 1-4 and a restricted one (parts.view + processes.view only) for the permission-gating and
 * processes-list flows. Plus (Task 17, Phase 3) a SEPARATE customer + lead/rider part pair for the
 * order flows (order-entry-full/board-search-scan/loads-after-print/void-order), the lead already
 * carrying one process step so it is orderable from the start. Everything here is prefixed "E2E"
 * so cleanup() below — and a human skimming the dev DB — can tell fixture rows from real data at a
 * glance. Self-healing (see reapLeftovers): a prior run's leftovers are cleared first, so this is
 * idempotent across runs even when the previous one never reached its own cleanup.
 *
 * The full-permission user exists rather than the flows just signing in as the seeded `admin`
 * (Codex, 2026-08-02): README §"first run" tells the developer to change that password after
 * first login, and a harness hardcoding `admin`/`admin` breaks for everyone who follows it. It
 * also gives cleanup() a user id to delete sessions for — every login writes a Session row, and
 * `getSessionUser` only rejects expired sessions, it never deletes them, so the four flows that
 * used to sign in as `admin` leaked four session rows into the dev DB on every single run.
 */
async function create(): Promise<Fixtures> {
  await reapLeftovers();

  // Hashed before the transaction opens: argon2 is deliberately slow, and holding a transaction
  // open across it for no reason is exactly the wrong place to spend that time.
  const [adminHash, restrictedHash, clerkHash, priceEditHash] = await Promise.all([
    hashPassword(FIXTURE.adminPassword), hashPassword(FIXTURE.restrictedPassword),
    hashPassword(FIXTURE.clerkPassword), hashPassword(FIXTURE.priceEditPassword),
  ]);

  // Task 9 (Phase 5C): snapshot `BillingConfig`'s four GL-default columns BEFORE the close flow's
  // browser ever touches them, so `cleanup()` can restore the shared singleton row afterward — see
  // the `Fixtures.priorBillingConfig` doc comment. Read outside the fixture transaction below: it
  // is a plain read of a row this script does not itself write (the close flow's own real Admin ->
  // Billing UI is what mutates it), so it has no ordering dependency on anything in that transaction.
  const priorBillingConfigRow = await prisma.billingConfig.findFirst({ where: { id: "singleton" } });
  const priorBillingConfig = {
    arGlAccountId: priorBillingConfigRow?.arGlAccountId ?? null,
    discountGlAccountId: priorBillingConfigRow?.discountGlAccountId ?? null,
    writeOffGlAccountId: priorBillingConfigRow?.writeOffGlAccountId ?? null,
    salesTaxGlAccountId: priorBillingConfigRow?.salesTaxGlAccountId ?? null,
  };

  // Task 11 (Phase 6): snapshot which ending statement is the live default BEFORE the quoting
  // flow's create-with-default demotes it through the real reference service — see the
  // `Fixtures.priorDefaultEndingStatementId` doc comment. Read AFTER reapLeftovers above (a
  // leftover fixture statement from a crashed run must not be mistaken for the developer's own
  // default) and outside the fixture transaction below, the `priorBillingConfigRow` precedent.
  const priorDefaultEndingStatementRow = await prisma.endingStatement.findFirst({
    where: { isDefault: true, deletedAt: null }, select: { id: true },
  });
  const priorDefaultEndingStatementId = priorDefaultEndingStatementRow?.id ?? null;

  // One transaction, so a failure part-way through leaves NOTHING behind (Codex, PR #22).
  // Sequential creates committed as they went, and a failure after the first one exited with rows
  // already written — while run.mjs, whose `runDbScript("create")` had thrown, never assigned
  // `state.fixtures` and so skipped cleanup entirely. The partial set then sat in the developer's
  // database until some later run's reapLeftovers happened along. All-or-nothing removes the
  // partial state rather than adding another compensating path to get it wrong.
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: { code: FIXTURE.customerCode, name: "E2E Test Customer" },
    });
    const part = await tx.part.create({
      data: {
        customerId: customer.id, partNumber: FIXTURE.partNumber, name: "E2E Test Part",
        eachWeight: "12.5000",
      },
    });
    const stepCodeA = await tx.processStepCode.create({
      data: {
        code: FIXTURE.stepCodeA, name: "E2E Quench",
        fields: {
          create: [
            { label: "Temperature", type: "NUMBER", unit: "°F", sort: 0 },
            { label: "Passed", type: "CHECKBOX", sort: 1 },
          ],
        },
      },
    });
    const stepCodeB = await tx.processStepCode.create({
      data: { code: FIXTURE.stepCodeB, name: "E2E Hot Wash" },
    });
    // Fix-wave 1 (Task 5 review, finding 8): the Pricing section's own fixture — a single priced
    // operation on the fixture part, on its own dedicated step code (see FIXTURE's comment on why
    // it is not stepCodeA/stepCodeB). No break: the gating flow this feeds (permission-gating.mjs)
    // only needs one card to render, not a break table.
    const priceStepCode = await tx.processStepCode.create({
      data: { code: FIXTURE.priceStepCodeCode, name: FIXTURE.priceStepCodeName },
    });
    await tx.partPrice.create({
      data: {
        partId: part.id, processStepCodeId: priceStepCode.id, position: 0,
        setupCharge: "25.00", unitPrice: "2.5000", minimumCharge: "50.00", pricePer: "EACH",
      },
    });
    const decoyTemplate = await tx.processTemplate.create({
      data: { name: FIXTURE.decoyTemplateName },
    });

    // Task 17 (Phase 3): a customer + two parts for the order flows, independent of the process
    // suite's own customer/part above — see FIXTURE's comment. `creditHold: true` is what makes
    // order-entry-full's save deterministically return a non-empty `warnings[]` (the "visibly,
    // never silently" save-with-warnings panel), and the lead part's revision/step below are
    // written directly (not through `lockCurrentRevision`/`workingRevision`) because this is
    // fixture SETUP, exactly like every other row in this transaction — the order-entry-full flow
    // itself is what exercises the real, audited lock at order save, through the actual app.
    const orderCustomer = await tx.customer.create({
      data: { code: FIXTURE.orderCustomerCode, name: "E2E Order Flow Customer", creditHold: true },
    });
    const orderLeadPart = await tx.part.create({
      data: {
        customerId: orderCustomer.id, partNumber: FIXTURE.orderLeadPartNumber, name: "E2E Order Lead Part",
        eachWeight: "10.0000",
      },
    });
    const orderRiderPart = await tx.part.create({
      data: {
        customerId: orderCustomer.id, partNumber: FIXTURE.orderRiderPartNumber, name: "E2E Order Rider Part",
        eachWeight: "2.5000", serializationRequired: true,
      },
    });
    const orderLeadRevision = await tx.partProcessRevision.create({
      data: { partId: orderLeadPart.id, revisionNumber: 1 },
    });
    // Reuses stepCodeB (E2E-WASH) rather than declaring a third fixture step code — a step code is
    // shared reference vocabulary, not owned by any one part, so two unrelated parts' revisions
    // referencing the same code is normal, not a fixture-scoping risk. Deliberately NOT stepCodeA:
    // blocked-code-delete.mjs asserts an EXACT blocker count ("2 record(s) use it") for stepCodeA
    // — E2E-PART-1's step and the E2E Austemper template's step — and a third live reference would
    // silently break that flow's own assertion.
    await tx.partProcessStep.create({
      data: {
        revisionId: orderLeadRevision.id, position: 1, codeId: stepCodeB.id,
        instruction: "E2E order flow: heat to target temperature and hold.",
      },
    });

    // ----- Phase 4 (Task 20): shipping/cert fixtures (see FIXTURE's comment). Every part below
    // is orderable from the start (one revision + one step, the orderLeadPart shape above), and
    // every part pins its cert chain EXPLICITLY (certRequired true/false, never null) so the
    // flows never depend on whatever cert_required_default the developer's own dev-DB settings
    // happen to hold — the resolution chain is part ?? customer ?? plant, and a non-null part
    // value always wins. Reuses stepCodeB, NOT stepCodeA, for the same blocked-code-delete
    // exact-blocker-count reason recorded above. -----
    const hrcScale = await tx.inspectionScale.create({ data: { name: FIXTURE.inspectionScaleName } });
    const hardnessCode = await tx.inspectionCode.create({
      data: { name: FIXTURE.inspectionCodeAName, defaultScaleId: hrcScale.id },
    });
    const caseDepthCode = await tx.inspectionCode.create({ data: { name: FIXTURE.inspectionCodeBName } });
    const toteType = await tx.containerType.create({ data: { name: FIXTURE.containerTypeName } });

    const shipCustomer = await tx.customer.create({
      data: { code: FIXTURE.shipCustomerCode, name: "E2E Shipping Customer" },
    });
    const holdCustomer = await tx.customer.create({
      data: { code: FIXTURE.holdCustomerCode, name: "E2E Held Customer", creditHold: true },
    });

    async function orderablePart(data: {
      customerId: string; partNumber: string; name: string; eachWeight: string;
      certRequired: boolean; certScope?: "ORDER";
    }) {
      const part = await tx.part.create({
        data: {
          customerId: data.customerId, partNumber: data.partNumber, name: data.name,
          eachWeight: data.eachWeight, certRequired: data.certRequired,
          ...(data.certScope ? { certScope: data.certScope } : {}),
        },
      });
      const revision = await tx.partProcessRevision.create({
        data: { partId: part.id, revisionNumber: 1 },
      });
      await tx.partProcessStep.create({
        data: {
          revisionId: revision.id, position: 1, codeId: stepCodeB.id,
          instruction: "E2E shipping flow: wash and pack.",
        },
      });
      return part;
    }

    const shipPartA = await orderablePart({
      customerId: shipCustomer.id, partNumber: FIXTURE.shipPartANumber,
      name: "E2E Ship Part A", eachWeight: "10.0000", certRequired: false,
    });
    const shipPartB = await orderablePart({
      customerId: shipCustomer.id, partNumber: FIXTURE.shipPartBNumber,
      name: "E2E Ship Part B", eachWeight: "5.0000", certRequired: false,
    });
    // The cert flow's part: cert required at ORDER scope, so the order save itself creates the
    // order-scope cert (§6.2), seeded from these two inspections (frozen min/max/scale/location).
    const certPart = await orderablePart({
      customerId: shipCustomer.id, partNumber: FIXTURE.certPartNumber,
      name: "E2E Certified Part", eachWeight: "10.0000", certRequired: true, certScope: "ORDER",
    });
    await tx.partInspection.create({
      data: {
        partId: certPart.id, inspectionCodeId: hardnessCode.id, scaleId: hrcScale.id,
        min: "40", max: "50", sampleQty: "3", location: "E2E flange OD", sort: 1,
      },
    });
    await tx.partInspection.create({
      data: {
        partId: certPart.id, inspectionCodeId: caseDepthCode.id,
        min: "0.02", max: "0.045", sampleQty: "100%", location: "E2E case at pitch line", sort: 2,
      },
    });
    const holdPart = await orderablePart({
      customerId: holdCustomer.id, partNumber: FIXTURE.holdPartNumber,
      name: "E2E Held Customer Part", eachWeight: "8.0000", certRequired: false,
    });

    // ----- Task 20 (Phase 5A): the invoicing flow's own customer/part (see FIXTURE's comment).
    // A two-PartPrice part — ruling 3's multi-operation case — each priced operation on its own
    // dedicated step code with its own GL account. -----
    const invCustomer = await tx.customer.create({
      data: {
        code: FIXTURE.invCustomerCode, name: "E2E Invoicing Customer",
        taxable: true, salesTaxRate: "0.070000",
      },
    });
    const invGlAccountA = await tx.glAccount.create({
      data: { name: FIXTURE.invGlAccountAName, description: "E2E Invoice Op A Revenue" },
    });
    const invGlAccountB = await tx.glAccount.create({
      data: { name: FIXTURE.invGlAccountBName, description: "E2E Invoice Op B Revenue" },
    });
    const invPriceStepCodeA = await tx.processStepCode.create({
      data: {
        code: FIXTURE.invPriceStepCodeACode, name: FIXTURE.invPriceStepCodeAName,
        glAccountId: invGlAccountA.id,
      },
    });
    const invPriceStepCodeB = await tx.processStepCode.create({
      data: {
        code: FIXTURE.invPriceStepCodeBCode, name: FIXTURE.invPriceStepCodeBName,
        glAccountId: invGlAccountB.id,
      },
    });
    // Orderable via the SAME reused recipe step (stepCodeB) as every other orderablePart() part
    // above — PartPrice has no FK to PartProcessStep (part-prices.ts), so a part's actual recipe
    // is irrelevant to what it prices. The two PRICED operations below are deliberately on their
    // own dedicated step codes, decoupled from both the recipe step and from priceStepCode (which
    // permission-gating.mjs already pins an exact gate count against).
    const invPart = await orderablePart({
      customerId: invCustomer.id, partNumber: FIXTURE.invPartNumber,
      name: "E2E Invoice Part", eachWeight: "5.0000", certRequired: false,
    });
    await tx.partPrice.create({
      data: {
        partId: invPart.id, processStepCodeId: invPriceStepCodeA.id, position: 0,
        unitPrice: "10.0000", minimumCharge: "25.00", pricePer: "EACH",
      },
    });
    await tx.partPrice.create({
      data: {
        partId: invPart.id, processStepCodeId: invPriceStepCodeB.id, position: 1,
        unitPrice: "4.0000", minimumCharge: "10.00", pricePer: "EACH",
      },
    });
    // One active, plant-wide surcharge (scope ALL) — no INCLUDE/EXCLUDE list and no per-customer
    // override row needed for a single always-on flow.
    const invSurcharge = await tx.surcharge.create({
      data: {
        name: FIXTURE.invSurchargeName, kind: "PERCENT", rate: "0.050000",
        scope: "ALL", position: 0, active: true,
      },
    });

    // ----- Task 17 (Phase 5B): the A/R flow's own customer/part/terms/payment-type (see
    // FIXTURE's comment). `arTerms` is 2/10/30 — netDays 30, a 2% discount inside 10 days,
    // decimalField(5,2)'s "2 = 2%" convention (`discountPercent: "2.00"`, the
    // tests/applications.test.ts/reference-tables.test.ts precedent for how this Decimal(5,2)
    // column is written). `arCustomer` opts out of both surcharge (`invSurcharge` above is
    // scope ALL/active — it would otherwise apply to EVERY customer's invoice for the rest of
    // this run, `arCustomer` included) and tax, so its invoice total is exactly its one priced
    // operation with no other line to account for. -----
    const arTerms = await tx.terms.create({
      data: { name: FIXTURE.arTermsName, netDays: 30, discountPercent: "2.00", discountDays: 10 },
    });
    const arCustomer = await tx.customer.create({
      data: {
        code: FIXTURE.arCustomerCode, name: "E2E AR Customer", termsId: arTerms.id,
        taxable: false, surchargeOptOut: true,
      },
    });
    const arPriceStepCode = await tx.processStepCode.create({
      data: { code: FIXTURE.arPriceStepCodeCode, name: FIXTURE.arPriceStepCodeName },
    });
    const arPart = await orderablePart({
      customerId: arCustomer.id, partNumber: FIXTURE.arPartNumber,
      name: "E2E AR Part", eachWeight: "5.0000", certRequired: false,
    });
    await tx.partPrice.create({
      data: {
        partId: arPart.id, processStepCodeId: arPriceStepCode.id, position: 0,
        unitPrice: "100.0000", minimumCharge: "25.00", pricePer: "EACH",
      },
    });
    // A single payment type — reference vocabulary, not owned by any one customer/batch
    // (the `stepCodeB` precedent above), so one row serves the whole flow's one check payment.
    const arPaymentType = await tx.paymentType.create({ data: { name: FIXTURE.arPaymentTypeName } });

    // ----- Task 9 (Phase 5C): backfill the AR step code's + payment type's GL accounts (see
    // FIXTURE's comment) — MUST happen before receivables-apply-age-statement.mjs (Phase 5B) ever
    // creates an invoice/payment against them, which is why this runs here, inside the SAME
    // fixture-creation transaction that runs once before any flow starts. -----
    const arOpGlAccount = await tx.glAccount.create({
      data: { name: FIXTURE.arOpGlAccountName, description: "E2E AR Op Revenue (Task 9 GL-export readiness backfill)" },
    });
    await tx.processStepCode.update({ where: { id: arPriceStepCode.id }, data: { glAccountId: arOpGlAccount.id } });

    // ----- Task 9 (Phase 5C): the month-end-close flow's own customer/part/terms/payment-type/
    // GL-accounts (see FIXTURE's comment). -----
    const closeTerms = await tx.terms.create({
      data: { name: FIXTURE.closeTermsName, netDays: 30, discountPercent: "2.00", discountDays: 10 },
    });
    const closeCustomer = await tx.customer.create({
      data: {
        code: FIXTURE.closeCustomerCode, name: "E2E Close Customer", termsId: closeTerms.id,
        taxable: false, surchargeOptOut: true,
      },
    });
    const closeRevenueGlAccount = await tx.glAccount.create({
      data: { name: FIXTURE.closeRevenueGlAccountName, description: "E2E Close Op Revenue" },
    });
    const closeArGlAccount = await tx.glAccount.create({
      data: { name: FIXTURE.closeArGlAccountName, description: "E2E Close A/R Control" },
    });
    const closeDiscountGlAccount = await tx.glAccount.create({
      data: { name: FIXTURE.closeDiscountGlAccountName, description: "E2E Close Discounts Given" },
    });
    const closeWriteOffGlAccount = await tx.glAccount.create({
      data: { name: FIXTURE.closeWriteOffGlAccountName, description: "E2E Close Write-offs" },
    });
    const closeSalesTaxGlAccount = await tx.glAccount.create({
      data: { name: FIXTURE.closeSalesTaxGlAccountName, description: "E2E Close Sales Tax Payable" },
    });
    const closeCashGlAccount = await tx.glAccount.create({
      data: { name: FIXTURE.closeCashGlAccountName, description: "E2E Close Cash" },
    });
    const closePriceStepCode = await tx.processStepCode.create({
      data: {
        code: FIXTURE.closePriceStepCodeCode, name: FIXTURE.closePriceStepCodeName,
        glAccountId: closeRevenueGlAccount.id,
      },
    });
    const closePart = await orderablePart({
      customerId: closeCustomer.id, partNumber: FIXTURE.closePartNumber,
      name: "E2E Close Part", eachWeight: "5.0000", certRequired: false,
    });
    await tx.partPrice.create({
      data: {
        partId: closePart.id, processStepCodeId: closePriceStepCode.id, position: 0,
        unitPrice: "100.0000", minimumCharge: "25.00", pricePer: "EACH",
      },
    });
    // The close/export CASH journal needs a GL account on every in-scope postable payment type
    // (`resolveReadiness`'s `paymentTypesMissingGl`).
    const closePaymentType = await tx.paymentType.create({
      data: { name: FIXTURE.closePaymentTypeName, glAccountId: closeCashGlAccount.id },
    });

    // ----- Task 11 (Phase 6): the quoting flow's own customer/part/step-code (see FIXTURE's
    // comment — surcharge/tax opted out; the part carries NO PartPrice so the flow's invoice can
    // only price from the quote; the step code prices the QuotePrice row and needs no GL because
    // the invoice stays a DRAFT). The ending statement is NOT created here — the flow builds it
    // live through the admin reference page. -----
    const quoteCustomer = await tx.customer.create({
      data: {
        code: FIXTURE.quoteCustomerCode, name: "E2E Quoting Customer",
        taxable: false, surchargeOptOut: true,
      },
    });
    const quoteStepCode = await tx.processStepCode.create({
      data: { code: FIXTURE.quoteStepCodeCode, name: FIXTURE.quoteStepCodeName },
    });
    const quotePart = await orderablePart({
      customerId: quoteCustomer.id, partNumber: FIXTURE.quotePartNumber,
      name: "E2E Quoted Part", eachWeight: "5.0000", certRequired: false,
    });
    // Task 9 backfill (see `arOpGlAccountName`'s comment on `arPriceStepCode` for the same
    // reasoning, applied here to `arPaymentType`): `receivables-apply-age-statement.mjs`'s own
    // payment ALSO stays posted/in-scope for the rest of a run, so its payment type needs a GL
    // account too, or the close flow's own export is refused by a gap that isn't its fixture's to
    // fix. Reuses `closeCashGlAccount` (the SAME cash account two different payment types debiting
    // is normal — the `stepCodeB` shared-reference-vocabulary precedent) — must run here, AFTER
    // `closeCashGlAccount` exists, not up with the `arOpGlAccount`/`arPriceStepCode` backfill above.
    await tx.paymentType.update({ where: { id: arPaymentType.id }, data: { glAccountId: closeCashGlAccount.id } });

    // ALL_PERMISSIONS, the same list prisma/seed.ts grants the seeded Admin role — flows 1-4 reach
    // both the parts/processes screens and the admin step-codes screen, so anything narrower would
    // have to be kept in step with them by hand.
    const adminRole = await tx.role.create({
      data: {
        name: FIXTURE.adminRoleName,
        permissions: { create: ALL_PERMISSIONS.map((permission) => ({ permission })) },
      },
    });
    const adminUser = await tx.user.create({
      data: {
        username: FIXTURE.adminUsername, displayName: "E2E Admin User",
        passwordHash: adminHash, roleId: adminRole.id,
      },
    });
    // Task 16 (Phase 7): `templates.view` rides along so the templates-admin flow can prove the
    // nav decision + §5.16 as this deliberately view-only user — a user holding templates.view but
    // NOT admin.view still reaches /admin/templates via the Admin > Templates nav entry (the
    // silent-dead-end rule), where every mutating control is disabled-with-reason. Orthogonal to
    // the parts/processes designer this user also exercises (permission-gating/processes-list).
    const restrictedRole = await tx.role.create({
      data: {
        name: FIXTURE.restrictedRoleName,
        permissions: { create: [
          { permission: "parts.view" }, { permission: "processes.view" }, { permission: "templates.view" },
        ] },
      },
    });
    const restrictedUser = await tx.user.create({
      data: {
        username: FIXTURE.restrictedUsername, displayName: "E2E Restricted User",
        passwordHash: restrictedHash, roleId: restrictedRole.id,
      },
    });
    // Phase 4: can key orders and shipments but does NOT hold action.override_credit_hold —
    // the credit-hold flow's blocked half is this user hitting the gate. parts.view rides along
    // because login() (lib/auth.mjs) waits for the "Parts" nav entry as its signed-in checkpoint.
    const clerkRole = await tx.role.create({
      data: {
        name: FIXTURE.clerkRoleName,
        permissions: {
          create: [
            // processes.view rides along with orders.create: the entry page's lead-part preview
            // ("Rev 1 — locks at save") reads /api/parts/[id]/process/revisions, which is gated
            // on processes.view — without it the preview shows "Could not verify process steps"
            // and the shared createOrderViaUi helper's settled-state checkpoint never renders.
            "parts.view", "customers.view", "processes.view",
            "orders.view", "orders.create", "orders.edit",
            "shipping.view", "shipping.create", "shipping.edit",
            "certs.view",
          ].map((permission) => ({ permission })),
        },
      },
    });
    const clerkUser = await tx.user.create({
      data: {
        username: FIXTURE.clerkUsername, displayName: "E2E Shipping Clerk",
        passwordHash: clerkHash, roleId: clerkRole.id,
      },
    });
    // Fix-wave 1 (Task 5 review, finding 8): parts.view + parts.edit, deliberately WITHOUT
    // action.change_prices — see FIXTURE's comment. permission-gating.mjs re-logs-in as this user
    // to prove PricingSection's second gate (change_prices) bites even once parts.edit is held,
    // which the plain restricted user (holding neither) can't demonstrate on its own.
    const priceEditRole = await tx.role.create({
      data: {
        name: FIXTURE.priceEditRoleName,
        permissions: { create: [{ permission: "parts.view" }, { permission: "parts.edit" }] },
      },
    });
    const priceEditUser = await tx.user.create({
      data: {
        username: FIXTURE.priceEditUsername, displayName: "E2E Price Editor",
        passwordHash: priceEditHash, roleId: priceEditRole.id,
      },
    });
    return {
      customerId: customer.id, customerCode: customer.code,
      partId: part.id, partNumber: part.partNumber,
      stepCodeA: { id: stepCodeA.id, code: stepCodeA.code, name: stepCodeA.name },
      stepCodeB: { id: stepCodeB.id, code: stepCodeB.code, name: stepCodeB.name },
      decoyTemplateId: decoyTemplate.id, decoyTemplateName: decoyTemplate.name,
      liveTemplateName: FIXTURE.liveTemplateName,
      adminRoleId: adminRole.id, adminUserId: adminUser.id,
      adminUsername: adminUser.username, adminPassword: FIXTURE.adminPassword,
      restrictedRoleId: restrictedRole.id, restrictedUserId: restrictedUser.id,
      restrictedUsername: restrictedUser.username, restrictedPassword: FIXTURE.restrictedPassword,
      orderCustomerId: orderCustomer.id, orderCustomerCode: orderCustomer.code,
      orderLeadPartId: orderLeadPart.id, orderLeadPartNumber: orderLeadPart.partNumber,
      orderRiderPartId: orderRiderPart.id, orderRiderPartNumber: orderRiderPart.partNumber,
      shipCustomerId: shipCustomer.id, shipCustomerCode: shipCustomer.code,
      shipPartAId: shipPartA.id, shipPartANumber: shipPartA.partNumber,
      shipPartBId: shipPartB.id, shipPartBNumber: shipPartB.partNumber,
      certPartId: certPart.id, certPartNumber: certPart.partNumber,
      holdCustomerId: holdCustomer.id, holdCustomerCode: holdCustomer.code,
      holdPartId: holdPart.id, holdPartNumber: holdPart.partNumber,
      inspectionScaleId: hrcScale.id, inspectionScaleName: hrcScale.name,
      inspectionCodeAId: hardnessCode.id, inspectionCodeAName: hardnessCode.name,
      inspectionCodeBId: caseDepthCode.id, inspectionCodeBName: caseDepthCode.name,
      containerTypeId: toteType.id, containerTypeName: toteType.name,
      clerkRoleId: clerkRole.id, clerkUserId: clerkUser.id,
      clerkUsername: clerkUser.username, clerkPassword: FIXTURE.clerkPassword,
      priceStepCodeId: priceStepCode.id, priceStepCodeCode: priceStepCode.code,
      priceStepCodeName: priceStepCode.name,
      priceEditRoleId: priceEditRole.id, priceEditUserId: priceEditUser.id,
      priceEditUsername: priceEditUser.username, priceEditPassword: FIXTURE.priceEditPassword,
      invCustomerId: invCustomer.id, invCustomerCode: invCustomer.code,
      invPartId: invPart.id, invPartNumber: invPart.partNumber,
      invPriceStepCodeAId: invPriceStepCodeA.id, invPriceStepCodeBId: invPriceStepCodeB.id,
      invGlAccountAId: invGlAccountA.id, invGlAccountAName: invGlAccountA.name,
      invGlAccountBId: invGlAccountB.id, invGlAccountBName: invGlAccountB.name,
      invSurchargeId: invSurcharge.id, invSurchargeName: invSurcharge.name,
      arCustomerId: arCustomer.id, arCustomerCode: arCustomer.code,
      arPartId: arPart.id, arPartNumber: arPart.partNumber,
      arPriceStepCodeId: arPriceStepCode.id, arTermsId: arTerms.id,
      arPaymentTypeId: arPaymentType.id, arPaymentTypeName: arPaymentType.name,
      arOpGlAccountId: arOpGlAccount.id,
      closeCustomerId: closeCustomer.id, closeCustomerCode: closeCustomer.code,
      closePartId: closePart.id, closePartNumber: closePart.partNumber,
      closePriceStepCodeId: closePriceStepCode.id, closeTermsId: closeTerms.id,
      closePaymentTypeId: closePaymentType.id, closePaymentTypeName: closePaymentType.name,
      closeRevenueGlAccountId: closeRevenueGlAccount.id,
      closeArGlAccountId: closeArGlAccount.id, closeArGlAccountName: closeArGlAccount.name,
      closeDiscountGlAccountId: closeDiscountGlAccount.id, closeDiscountGlAccountName: closeDiscountGlAccount.name,
      closeWriteOffGlAccountId: closeWriteOffGlAccount.id, closeWriteOffGlAccountName: closeWriteOffGlAccount.name,
      closeSalesTaxGlAccountId: closeSalesTaxGlAccount.id, closeSalesTaxGlAccountName: closeSalesTaxGlAccount.name,
      closeCashGlAccountId: closeCashGlAccount.id,
      priorBillingConfig,
      quoteCustomerId: quoteCustomer.id, quoteCustomerCode: quoteCustomer.code,
      quotePartId: quotePart.id, quotePartNumber: quotePart.partNumber,
      quoteStepCodeId: quoteStepCode.id, quoteStepCodeCode: quoteStepCode.code,
      quoteStepCodeName: quoteStepCode.name,
      quoteEndingStatementName: FIXTURE.quoteEndingStatementName,
      priorDefaultEndingStatementId,
    };
    // Generous: the admin role alone writes one row per permission, and this runs against a
    // developer machine that may also be compiling a dev server at the time.
  }, { timeout: 30000 });
}

/**
 * Stands in for Phase 3's order save, which is the real future caller of `lockRevision`
 * (part-process-steps.ts) — nothing in Phase 2C-3 itself locks a revision. Documented here
 * rather than faked with a raw `lockedAt` flip so the revision-cut flow exercises the actual
 * idempotent, audited service function it is testing the fallout of.
 */
async function doLockRevision(payload: { partId: string; revisionNumber: number }): Promise<{ ok: true }> {
  await prisma.$transaction((tx) => lockRevision(payload.partId, payload.revisionNumber, tx));
  return { ok: true };
}

/** `receivablesBatchId` (Task 17, Phase 5B) — see run.mjs's `state.created` comment: a
 *  `ReceiptBatch` has no customer column, so `deleteReceivables` below can only find one via a
 *  live `Payment`; this is the id-driven backstop for a batch the flow created but never got as
 *  far as paying into, the `templateIds` precedent for "a live-built row's id is only known once
 *  the flow that created it has run." `null` when the flow never got as far as creating a batch.
 *  `closeBatchId` (Task 9, Phase 5C) is the SAME backstop for the close flow's own batch — a
 *  separate field, not a reuse of `receivablesBatchId`, so the two flows' backstops never clobber
 *  each other if both happen to be live in the same run (run.mjs's `state.created` comment).
 *  `closePeriodYear`/`closePeriodMonth` (Task 9) are the close flow's own id-driven backstop for
 *  `deleteClosePeriodFixture` — a `ClosePeriod` carries no id known up front (created live). Unlike
 *  every OTHER field here, the flow deliberately does NOT record these the moment the target
 *  `(year, month)` is computed: `ctx.created` is torn down by `run.mjs`'s `finally { teardown() }`
 *  on every exit path, pass or fail, so recording them before the pre-flight existence guard would
 *  hand cleanup a target it might not have created — if a REAL ClosePeriod already covers that month,
 *  the guard correctly refuses to POST, but cleanup would still hard-delete that real row (`@@unique(
 *  [year,month])`) if these fields were set. The flow assigns them ONLY after its OWN `closePeriod`
 *  POST has actually succeeded (fix round 1, review finding), so a guard failure — or anything that
 *  throws before this flow closes the month itself — leaves both `null` and this function a no-op.
 *  `deleteClosePeriodFixture`'s own `closedById` check is the second, independent belt against the
 *  same failure mode. */
type CleanupPayload = Fixtures & {
  templateIds: string[]; receivablesBatchId: string | null;
  closeBatchId: string | null; closePeriodYear: number | null; closePeriodMonth: number | null;
};

/**
 * Deletes every row `create()` and the flows themselves produced. `templateIds` carries the
 * id(s) of any template a flow created live through the UI (template-build-and-load's
 * `FIXTURE.liveTemplateName`) — its NAME is known up front, but its id only once that flow has
 * run. Id-driven (unlike reapLeftovers' name-driven lookup) because the caller already has the
 * exact ids from this run's own `create()` result.
 */
async function cleanup(payload: CleanupPayload): Promise<{ ok: true }> {
  const { partId, customerId, stepCodeA, stepCodeB, orderCustomerId, orderLeadPartId, orderRiderPartId } = payload;
  // Name-resolved as well as id-driven (Codex, PR #22). `templateIds` only ever holds a live-built
  // template's id if its flow got far enough to read it back off the URL — a failure between the
  // POST and that line leaves the template created but unregistered, and an id-only cleanup walks
  // straight past it. Its NAME is known up front either way, so resolving it here means the run
  // that created the row is the run that removes it, instead of leaving it for whenever a later
  // run's reapLeftovers happens to come along.
  const byName = await prisma.processTemplate.findMany({
    where: { name: { in: [FIXTURE.decoyTemplateName, FIXTURE.liveTemplateName] } }, select: { id: true },
  });
  const templateIds = [...new Set([
    payload.decoyTemplateId, ...payload.templateIds, ...byName.map((t) => t.id),
  ])];

  // Task 17: unlike templates, an order's own id is never known up front by this script — it's
  // created live, through the entry page, by order-entry-full.mjs — so there is nothing to thread
  // through `CleanupPayload` the way `templateIds` is threaded. Scoping through `orderCustomerId`
  // (known from `create()`'s own result, exactly like every other id-driven delete below) finds
  // every order the flows produced regardless of whether the run that created one ever recorded
  // its id anywhere, and regardless of whether void-order got to it — `deleteOrdersAndChildren`
  // doesn't filter on `deletedAt`. Before parts, same FK reason as `reapLeftovers`' own comment.
  // Task 20: invoices, then shipments/certs (their children FK into the order tables), same
  // scoping logic — an invoice/shipment/cert is only ever created live through the app, so the
  // customer is the gate. Task 17 (Phase 5B): `deleteReceivables` runs FIRST of all — its
  // `Application` rows block deleting the invoice `deleteInvoicesAndLines` removes next
  // (`Application_invoiceId_fkey` is `ON DELETE RESTRICT` — see `deleteReceivables`'s own
  // comment) — and `arCustomerId` rides along in every subsequent step the same way
  // `invCustomerId` already does (this flow ships its own order too). Task 9 (Phase 5C):
  // `closeCustomerId` rides along the same way, and `deleteClosePeriodFixture`/
  // `restoreBillingConfig` run here too — the former has no FK dependency on anything else in this
  // function (GlPosting's `sourceId` is a raw string, not an FK), and the latter MUST run before
  // `deleteInvoicingReference` far below (BillingConfig's four GL FKs are plain RESTRICT).
  await deleteReceivables([payload.arCustomerId, payload.closeCustomerId]);
  await deleteKnownEmptyBatch(payload.receivablesBatchId);
  await deleteKnownEmptyBatch(payload.closeBatchId);
  await deleteClosePeriodFixture(payload.closePeriodYear, payload.closePeriodMonth, payload.adminUserId);
  await restoreBillingConfig(payload.priorBillingConfig);
  await deleteInvoicesAndLines([
    payload.invCustomerId, payload.arCustomerId, payload.closeCustomerId, payload.quoteCustomerId,
  ]);
  // The invoicing/A-R/close/quoting flows each ship their own order (a real Shipper/ShipperOrder
  // pair) — invCustomerId/arCustomerId/closeCustomerId/quoteCustomerId MUST ride along here too,
  // or `ShipperOrder_orderId_fkey`'s RESTRICT blocks the order delete below (caught live for
  // invCustomerId: the first run of that flow's cleanup failed on exactly this).
  await deleteShippingAndCerts([
    payload.shipCustomerId, payload.holdCustomerId, payload.invCustomerId, payload.arCustomerId,
    payload.closeCustomerId, payload.quoteCustomerId,
  ]);
  await deleteOrdersAndChildren([
    orderCustomerId, payload.shipCustomerId, payload.holdCustomerId, payload.invCustomerId, payload.arCustomerId,
    payload.closeCustomerId, payload.quoteCustomerId,
  ]);
  // Task 11: quotes after orders, before the step-code/part/customer/user deletes below (all
  // RESTRICT — deleteQuotesAndChildren's own comment); then the fixture ending statement, with
  // the pre-run default re-promoted from create()'s snapshot.
  await deleteQuotesAndChildren([payload.quoteCustomerId]);
  await deleteEndingStatementFixture(payload.priorDefaultEndingStatementId);
  await deletePartProcessData([
    partId, orderLeadPartId, payload.shipPartAId, payload.shipPartBId, payload.certPartId, payload.holdPartId,
    payload.invPartId, payload.arPartId, payload.closePartId, payload.quotePartId,
  ]);
  await deleteTemplatesAndSteps(templateIds);
  await deleteDocumentTemplatesByName(); // Task 16: the templates-admin flow's own live-built document template
  // Fix-wave 1 (Task 5 review, finding 8): before both deleteStepCodes (priceStepCodeId's own
  // restrict-on-delete FK) and deletePartsAndCustomers (partId's). Fix-wave 2 (finding 1): sweep
  // the same full part-id list deletePartProcessData receives above, not just partId — otherwise
  // the day a second fixture part (e.g. shipPartA) gets priced, this leaves its PartPrice row
  // behind to 23503 deletePartsAndCustomers below, exactly as reapLeftovers() already does two
  // screens up.
  await deletePartPrices([
    partId, orderLeadPartId, payload.shipPartAId, payload.shipPartBId, payload.certPartId, payload.holdPartId,
    payload.invPartId, payload.arPartId, payload.closePartId, payload.quotePartId,
  ]);
  await deleteStepCodes([
    stepCodeA.id, stepCodeB.id, payload.priceStepCodeId,
    payload.invPriceStepCodeAId, payload.invPriceStepCodeBId, payload.arPriceStepCodeId,
    payload.closePriceStepCodeId, payload.quoteStepCodeId,
  ]);
  // Before deletePartsAndCustomers: StoredDocument.customerId is ON DELETE SET NULL, which would
  // otherwise violate StoredDocument_kind_owner_check on a live STATEMENT document the moment its
  // customer is deleted (deleteStatementDocuments's own comment).
  await deleteStatementDocuments([payload.arCustomerId]);
  await deletePartsAndCustomers(
    [
      partId, orderLeadPartId, orderRiderPartId,
      payload.shipPartAId, payload.shipPartBId, payload.certPartId, payload.holdPartId, payload.invPartId,
      payload.arPartId, payload.closePartId, payload.quotePartId,
    ],
    [
      customerId, orderCustomerId, payload.shipCustomerId, payload.holdCustomerId, payload.invCustomerId,
      payload.arCustomerId, payload.closeCustomerId, payload.quoteCustomerId,
    ],
  );
  await deletePhase4Reference(
    [payload.inspectionScaleId],
    [payload.inspectionCodeAId, payload.inspectionCodeBId],
    [payload.containerTypeId],
  );
  // Task 9: BEFORE deleteInvoicingReference (the close payment type's own GL-account FK) and AFTER
  // deleteReceivables (PaymentType is ON DELETE RESTRICT from Payment) — swapped from the
  // pre-Task-9 order (see reapLeftovers' matching comment for why).
  await deleteArReference(
    [payload.arTermsId, payload.closeTermsId], [payload.arPaymentTypeId, payload.closePaymentTypeId],
  );
  // After deleteStepCodes (the invoicing/AR/close step codes' own GL-account FKs) and after
  // deleteArReference immediately above (the close payment type's own GL-account FK) and after
  // restoreBillingConfig far above (the four plant-default GL FKs).
  await deleteInvoicingReference(
    [
      payload.invGlAccountAId, payload.invGlAccountBId, payload.arOpGlAccountId,
      payload.closeRevenueGlAccountId, payload.closeArGlAccountId, payload.closeDiscountGlAccountId,
      payload.closeWriteOffGlAccountId, payload.closeSalesTaxGlAccountId, payload.closeCashGlAccountId,
    ],
    [payload.invSurchargeId],
  );
  // All four users, not just the restricted one: deleteUsersAndRoles clears each user's Session
  // (and, as of Task 17, OrderDraft/SavedView) rows first, which is the only thing that clears
  // the per-user rows the flows' own logins and the order-entry autosaves created.
  await deleteUsersAndRoles(
    [payload.adminUserId, payload.restrictedUserId, payload.clerkUserId, payload.priceEditUserId],
    [payload.adminRoleId, payload.restrictedRoleId, payload.clerkRoleId, payload.priceEditRoleId],
  );

  return { ok: true };
}

async function main(): Promise<void> {
  const [, , command, payloadArg] = process.argv;
  const payload: unknown = payloadArg ? JSON.parse(payloadArg) : {};
  let result: unknown;
  switch (command) {
    case "create":
      result = await create();
      break;
    case "lock-revision":
      result = await doLockRevision(payload as { partId: string; revisionNumber: number });
      break;
    case "cleanup":
      result = await cleanup(payload as CleanupPayload);
      break;
    default:
      throw new Error(`Unknown db-fixtures command: ${String(command)}`);
  }
  // The one line of stdout run.mjs parses as JSON — everything else in this file logs to stderr.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
