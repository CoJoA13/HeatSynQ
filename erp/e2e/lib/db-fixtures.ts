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

async function deleteTemplatesAndSteps(templateIds: string[]): Promise<void> {
  if (templateIds.length === 0) return;
  await prisma.auditLog.deleteMany({ where: { entity: "processTemplate", entityId: { in: templateIds } } });
  await prisma.processTemplateStep.deleteMany({ where: { templateId: { in: templateIds } } });
  await prisma.processTemplate.deleteMany({ where: { id: { in: templateIds } } });
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
  await prisma.storedDocument.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderAttachment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderSerial.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderCharge.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.load.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderContainer.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
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
  const [templates, parts, stepCodes, customers, users, roles, orderCustomers, orderParts] = await Promise.all([
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
      where: { code: { in: [FIXTURE.stepCodeA, FIXTURE.stepCodeB] } }, select: { id: true },
    }),
    prisma.customer.findMany({ where: { code: FIXTURE.customerCode }, select: { id: true } }),
    prisma.user.findMany({
      where: { username: { in: [FIXTURE.adminUsername, FIXTURE.restrictedUsername] } }, select: { id: true },
    }),
    prisma.role.findMany({
      where: { name: { in: [FIXTURE.adminRoleName, FIXTURE.restrictedRoleName] } }, select: { id: true },
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
  ]);
  const templateIds = templates.map((t) => t.id);
  const partIds = [...parts.map((p) => p.id), ...orderParts.map((p) => p.id)];
  const stepCodeIds = stepCodes.map((c) => c.id);
  const customerIds = [...customers.map((c) => c.id), ...orderCustomers.map((c) => c.id)];
  const userIds = users.map((u) => u.id);
  const roleIds = roles.map((r) => r.id);
  const orderCustomerIds = orderCustomers.map((c) => c.id);

  const total = templateIds.length + partIds.length + stepCodeIds.length
    + customerIds.length + userIds.length + roleIds.length;
  if (total === 0) return;

  console.error(
    `Reaping leftover E2E fixtures from a prior run: ${templateIds.length} template(s), ` +
    `${partIds.length} part(s), ${stepCodeIds.length} step code(s), ${customerIds.length} ` +
    `customer(s), ${userIds.length} user(s), ${roleIds.length} role(s).`,
  );

  // Before parts: OrderLine.partId is a plain restrict-on-delete FK, so any leftover fixture order
  // (voided by a prior run's void-order flow, or left live by a crash before it) must be gone
  // before deletePartsAndCustomers below can touch E2E-ORD-LEAD/E2E-ORD-RIDER.
  await deleteOrdersAndChildren(orderCustomerIds);
  await deletePartProcessData(partIds);
  await deleteTemplatesAndSteps(templateIds);
  await deleteStepCodes(stepCodeIds);
  await deletePartsAndCustomers(partIds, customerIds);
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
  const [adminHash, restrictedHash] = await Promise.all([
    hashPassword(FIXTURE.adminPassword), hashPassword(FIXTURE.restrictedPassword),
  ]);

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
    const restrictedRole = await tx.role.create({
      data: {
        name: FIXTURE.restrictedRoleName,
        permissions: { create: [{ permission: "parts.view" }, { permission: "processes.view" }] },
      },
    });
    const restrictedUser = await tx.user.create({
      data: {
        username: FIXTURE.restrictedUsername, displayName: "E2E Restricted User",
        passwordHash: restrictedHash, roleId: restrictedRole.id,
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

type CleanupPayload = Fixtures & { templateIds: string[] };

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
  await deleteOrdersAndChildren([orderCustomerId]);
  await deletePartProcessData([partId, orderLeadPartId]);
  await deleteTemplatesAndSteps(templateIds);
  await deleteStepCodes([stepCodeA.id, stepCodeB.id]);
  await deletePartsAndCustomers([partId, orderLeadPartId, orderRiderPartId], [customerId, orderCustomerId]);
  // Both users, not just the restricted one: deleteUsersAndRoles clears each user's Session (and,
  // as of Task 17, OrderDraft/SavedView) rows first, which is the only thing that clears the
  // per-user rows the flows' own logins and the order-entry-full autosave created.
  await deleteUsersAndRoles(
    [payload.adminUserId, payload.restrictedUserId], [payload.adminRoleId, payload.restrictedRoleId],
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
