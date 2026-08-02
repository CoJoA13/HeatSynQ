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

function assertDevDb(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (dbName !== "erp") {
    throw new Error(
      `e2e fixtures must run against the dev database "erp", not "${dbName}" — refusing to touch it.`,
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
  restrictedRoleId: string;
  restrictedUserId: string;
  restrictedUsername: string;
  restrictedPassword: string;
};

/**
 * Everything every flow needs already sitting in the dev DB before the browser opens: a
 * customer + part (flows 1-4 build on this one part), two process step codes (one carrying a
 * NUMBER + CHECKBOX field, for the typed-fields flow; one plain text-only, for template-build's
 * second step), a second template with no matching name (so processes-list's search
 * demonstrably narrows something away), and a restricted role/user (parts.view + processes.view
 * only) for the permission-gating and processes-list flows. Everything here is prefixed "E2E" so
 * cleanup() below — and a human skimming the dev DB — can tell fixture rows from real data at a
 * glance.
 */
async function create(): Promise<Fixtures> {
  const customer = await prisma.customer.create({
    data: { code: "E2ECUST", name: "E2E Test Customer" },
  });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "E2E-PART-1", name: "E2E Test Part",
      eachWeight: "12.5000",
    },
  });
  const stepCodeA = await prisma.processStepCode.create({
    data: {
      code: "E2E-QNCH", name: "E2E Quench",
      fields: {
        create: [
          { label: "Temperature", type: "NUMBER", unit: "°F", sort: 0 },
          { label: "Passed", type: "CHECKBOX", sort: 1 },
        ],
      },
    },
  });
  const stepCodeB = await prisma.processStepCode.create({
    data: { code: "E2E-WASH", name: "E2E Hot Wash" },
  });
  const decoyTemplate = await prisma.processTemplate.create({
    data: { name: "E2E Decoy Template" },
  });
  const restrictedPassword = "e2eRestricted123!";
  const restrictedRole = await prisma.role.create({
    data: {
      name: "E2E Restricted Role",
      permissions: { create: [{ permission: "parts.view" }, { permission: "processes.view" }] },
    },
  });
  const restrictedUser = await prisma.user.create({
    data: {
      username: "e2e_restricted", displayName: "E2E Restricted User",
      passwordHash: await hashPassword(restrictedPassword), roleId: restrictedRole.id,
    },
  });
  return {
    customerId: customer.id, customerCode: customer.code,
    partId: part.id, partNumber: part.partNumber,
    stepCodeA: { id: stepCodeA.id, code: stepCodeA.code, name: stepCodeA.name },
    stepCodeB: { id: stepCodeB.id, code: stepCodeB.code, name: stepCodeB.name },
    decoyTemplateId: decoyTemplate.id, decoyTemplateName: decoyTemplate.name,
    restrictedRoleId: restrictedRole.id, restrictedUserId: restrictedUser.id,
    restrictedUsername: restrictedUser.username, restrictedPassword,
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
 * Deletes every row `create()` and the flows themselves produced, in FK order (children before
 * parents — CLAUDE.md: deletion is otherwise always soft, but a leftover E2E fixture row has no
 * business surviving in the dev DB). `templateIds` carries the id(s) of any template a flow
 * created live through the UI (template-build-and-load's "E2E Austemper") — unknown until that
 * flow runs, unlike everything else `create()` already knows about.
 *
 * Audit rows are removed too, ahead of the data rows they reference (AuditLog carries no real
 * FK — entityId is a bare String column — so this is tidiness, not a constraint requirement).
 */
async function cleanup(payload: CleanupPayload): Promise<{ ok: true }> {
  const { partId, customerId, stepCodeA, stepCodeB, restrictedRoleId, restrictedUserId } = payload;
  const templateIds = [...new Set([payload.decoyTemplateId, ...payload.templateIds])];

  const revisions = await prisma.partProcessRevision.findMany({ where: { partId }, select: { id: true } });
  const revisionIds = revisions.map((r) => r.id);

  await prisma.auditLog.deleteMany({ where: { entity: "partProcessRevision", entityId: { in: revisionIds } } });
  await prisma.partProcessStepValue.deleteMany({ where: { step: { revision: { partId } } } });
  await prisma.partProcessStep.deleteMany({ where: { revision: { partId } } });
  await prisma.partProcessRevision.deleteMany({ where: { partId } });

  await prisma.auditLog.deleteMany({ where: { entity: "processTemplate", entityId: { in: templateIds } } });
  await prisma.processTemplateStep.deleteMany({ where: { templateId: { in: templateIds } } });
  await prisma.processTemplate.deleteMany({ where: { id: { in: templateIds } } });

  // ProcessStepFieldDef cascades from ProcessStepCode (schema onDelete: Cascade) — the values
  // and steps that would otherwise block that cascade (fieldDefId/codeId are both plain
  // restrict-on-delete FKs) are already gone above.
  await prisma.processStepCode.deleteMany({ where: { id: { in: [stepCodeA.id, stepCodeB.id] } } });

  await prisma.part.deleteMany({ where: { id: partId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });

  // Session has no cascade from User (unlike RolePermission/UserPermissionOverride, which do
  // cascade from Role/User respectively) — it must go first or the User delete below 23503s.
  await prisma.session.deleteMany({ where: { userId: restrictedUserId } });
  await prisma.user.deleteMany({ where: { id: restrictedUserId } });
  await prisma.role.deleteMany({ where: { id: restrictedRoleId } });

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
