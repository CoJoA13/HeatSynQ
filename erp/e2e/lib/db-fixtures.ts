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
};

// --- Shared FK-ordered deletion, used by both cleanup() (id-driven, from a known Fixtures
// payload) and reapLeftovers() (lookup-driven, for whatever a prior aborted run left behind).
// Children before parents throughout (CLAUDE.md: deletion is otherwise always soft, but a
// leftover E2E fixture row has no business surviving in the dev DB). Every step is a no-op on an
// empty id list, so callers don't need to special-case "nothing to delete".

async function deletePartProcessData(partIds: string[]): Promise<void> {
  // Sequential, not Promise.all: in practice there is at most one partId (both create()'s single
  // fixture part and reapLeftovers' "E2E"-prefixed partNumber lookup match only one convention),
  // and each part's own four deletes are already strictly ordered (children before parent).
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

async function deleteUsersAndRoles(userIds: string[], roleIds: string[]): Promise<void> {
  // Session has no cascade from User (unlike RolePermission/UserPermissionOverride, which do
  // cascade from Role/User respectively) — it must go first or the User delete below 23503s.
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
  const [templates, parts, stepCodes, customers, users, roles] = await Promise.all([
    prisma.processTemplate.findMany({
      where: { name: { in: [FIXTURE.decoyTemplateName, FIXTURE.liveTemplateName] } }, select: { id: true },
    }),
    prisma.part.findMany({ where: { partNumber: FIXTURE.partNumber }, select: { id: true } }),
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
  ]);
  const templateIds = templates.map((t) => t.id);
  const partIds = parts.map((p) => p.id);
  const stepCodeIds = stepCodes.map((c) => c.id);
  const customerIds = customers.map((c) => c.id);
  const userIds = users.map((u) => u.id);
  const roleIds = roles.map((r) => r.id);

  const total = templateIds.length + partIds.length + stepCodeIds.length
    + customerIds.length + userIds.length + roleIds.length;
  if (total === 0) return;

  console.error(
    `Reaping leftover E2E fixtures from a prior run: ${templateIds.length} template(s), ` +
    `${partIds.length} part(s), ${stepCodeIds.length} step code(s), ${customerIds.length} ` +
    `customer(s), ${userIds.length} user(s), ${roleIds.length} role(s).`,
  );

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
 * processes-list flows. Everything here is prefixed "E2E" so cleanup() below — and a human
 * skimming the dev DB — can tell fixture rows from real data at a glance. Self-healing (see
 * reapLeftovers): a prior run's leftovers are cleared first, so this is idempotent across runs
 * even when the previous one never reached its own cleanup.
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

  const customer = await prisma.customer.create({
    data: { code: FIXTURE.customerCode, name: "E2E Test Customer" },
  });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: FIXTURE.partNumber, name: "E2E Test Part",
      eachWeight: "12.5000",
    },
  });
  const stepCodeA = await prisma.processStepCode.create({
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
  const stepCodeB = await prisma.processStepCode.create({
    data: { code: FIXTURE.stepCodeB, name: "E2E Hot Wash" },
  });
  const decoyTemplate = await prisma.processTemplate.create({
    data: { name: FIXTURE.decoyTemplateName },
  });
  // ALL_PERMISSIONS, the same list prisma/seed.ts grants the seeded Admin role — flows 1-4 reach
  // both the parts/processes screens and the admin step-codes screen, so anything narrower would
  // have to be kept in step with them by hand.
  const adminRole = await prisma.role.create({
    data: {
      name: FIXTURE.adminRoleName,
      permissions: { create: ALL_PERMISSIONS.map((permission) => ({ permission })) },
    },
  });
  const adminUser = await prisma.user.create({
    data: {
      username: FIXTURE.adminUsername, displayName: "E2E Admin User",
      passwordHash: await hashPassword(FIXTURE.adminPassword), roleId: adminRole.id,
    },
  });
  const restrictedRole = await prisma.role.create({
    data: {
      name: FIXTURE.restrictedRoleName,
      permissions: { create: [{ permission: "parts.view" }, { permission: "processes.view" }] },
    },
  });
  const restrictedUser = await prisma.user.create({
    data: {
      username: FIXTURE.restrictedUsername, displayName: "E2E Restricted User",
      passwordHash: await hashPassword(FIXTURE.restrictedPassword), roleId: restrictedRole.id,
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
  };
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
  const { partId, customerId, stepCodeA, stepCodeB } = payload;
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

  await deletePartProcessData([partId]);
  await deleteTemplatesAndSteps(templateIds);
  await deleteStepCodes([stepCodeA.id, stepCodeB.id]);
  await deletePartsAndCustomers([partId], [customerId]);
  // Both users, not just the restricted one: deleteUsersAndRoles clears each user's Session rows
  // first, which is the only thing that clears the sessions the flows' own logins created.
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
