import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll, prisma } from "./helpers/db";
import {
  listStepCodes, createStepCode, updateStepCode, deleteStepCode, setStepFields, stepFieldBlockers,
} from "@/server/process-step-codes";
import { createReference } from "@/server/reference";
import { findBlockers } from "@/server/reference-blockers";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";
import { GET as listRoute, POST as createRoute } from "@/app/api/admin/step-codes/route";
import { PUT as updateRoute, DELETE as deleteRoute } from "@/app/api/admin/step-codes/[id]/route";
import { GET as stepCodeBlockersRoute } from "@/app/api/admin/step-codes/[id]/blockers/route";
import { GET as stepCodeBlockersExportRoute } from "@/app/api/admin/step-codes/[id]/blockers/export/route";
import { GET as fieldDefBlockersRoute } from "@/app/api/admin/step-codes/field-defs/[id]/blockers/route";
import { GET as fieldDefBlockersExportRoute } from "@/app/api/admin/step-codes/field-defs/[id]/blockers/export/route";
import { signInWith } from "./helpers/auth";

// Shared by the guard-matrix and route-blocker describes below. `part.create` needs
// `eachWeight: 1` (a required non-default column); a "historical" revision is one with
// `lockedAt` set and a higher-numbered revision present (tests/process-step-code-blockers.test.ts
// precedent — Task 2's findBlockers coverage).
async function stepCodeFixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const { id: codeId } = await createStepCode({ code: "HT-01", name: "Austenitize" });
  return { customer, part, codeId };
}
const addPartStep = (revisionId: string, codeId: string, position = 1) =>
  prisma.partProcessStep.create({ data: { revisionId, codeId, position, instruction: "" } });

describe("process step codes", () => {
  beforeEach(async () => await truncateAll());

  it("creates a code without a GL account and flags that it needs one", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    const [row] = await listStepCodes();
    expect(row).toMatchObject({ code: "HT-01", name: "Austenitize", glAccountId: null, needsGlAccount: true });
  });

  it("clears the needsGlAccount flag once an account is attached", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await updateStepCode(id, { glAccountId: gl.id });
    expect((await listStepCodes())[0].needsGlAccount).toBe(false);
  });

  it("rejects a duplicate code", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(createStepCode({ code: "HT-01", name: "Other" })).rejects.toThrow(HttpError);
  });

  it("re-creating a deleted code makes a NEW code with no inherited fields", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const { id: firstId } = await createStepCode({
      code: "HT-01", name: "Austenitize", glAccountId: gl.id, equipmentTag: "F1",
    });
    await setStepFields(firstId, [{ label: "Soak", type: "NUMBER", unit: "min", sort: 0 }]);

    // Confirm the non-default values actually took before the delete — otherwise the
    // "resets to default" assertions below could pass even if they never applied in the first
    // place (Task 7's review caught exactly this: a field seeded with its own default value).
    const firstRow = (await listStepCodes()).find((c) => c.id === firstId)!;
    expect(firstRow).toMatchObject({ glAccountId: gl.id, equipmentTag: "F1" });
    expect(firstRow.fields).toHaveLength(1);

    await deleteStepCode(firstId);

    const { id: secondId } = await createStepCode({ code: "HT-01", name: "Renamed" });
    expect(secondId).not.toBe(firstId);

    const [fresh] = await listStepCodes();
    expect(fresh).toMatchObject({
      id: secondId, code: "HT-01", name: "Renamed",
      glAccountId: null, equipmentTag: "", active: true, needsGlAccount: true,
    });
    expect(fresh.fields).toEqual([]);

    // A real create entry under its own identity — the defect issue #10 was filed for.
    expect((await readAudit("processStepCode", secondId)).map((e) => e.action)).toEqual(["create"]);
  });

  it("still rejects a duplicate code when the existing row is not soft-deleted", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(createStepCode({ code: "HT-01", name: "Other" })).rejects.toMatchObject({ status: 400 });
    expect(await listStepCodes()).toHaveLength(1);
  });

  it("stores ordered field definitions and returns them in sort order", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [
      { label: "Carbon potential", type: "NUMBER", sort: 3 },
      { label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
      { label: "Time", type: "NUMBER", unit: "min", sort: 2 },
    ]);
    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Temperature", "Time", "Carbon potential"]);
    expect(fields[0].unit).toBe("F");
  });

  it("a code with no fields is valid — Hot Wash is text only", async () => {
    const { id } = await createStepCode({ code: "WS-01", name: "Hot Wash" });
    await setStepFields(id, []);
    expect((await listStepCodes()).find((c) => c.id === id)?.fields).toEqual([]);
  });

  it("setStepFields replaces the whole set rather than appending", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    await setStepFields(id, [{ label: "Time", type: "NUMBER", sort: 1 }]);
    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Time"]);
  });

  it("rejects an unknown field type", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    // @ts-expect-error deliberately invalid type
    await expect(setStepFields(id, [{ label: "X", type: "COLOUR", sort: 1 }])).rejects.toThrow();
  });

  it("audits field changes with a diff that names the fields", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    const [entry] = await readAudit("processStepCode", id);
    const after = (entry.after as { fields: { label: string }[] }).fields.map((f) => f.label);
    expect(after).toEqual(["Temperature"]);
  });

  it("soft deletes", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await deleteStepCode(id);
    expect(await listStepCodes()).toHaveLength(0);
  });

  it("rejects duplicate sort values instead of leaving Postgres to tie-break the order", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(setStepFields(id, [
      { label: "Temperature", type: "NUMBER", sort: 1 },
      { label: "Time", type: "NUMBER", sort: 1 },
    ])).rejects.toThrow();
    expect((await listStepCodes())[0].fields).toEqual([]);
  });

  it("404s setStepFields against a nonexistent code instead of silently succeeding", async () => {
    await expect(setStepFields("nope", [])).rejects.toMatchObject({ status: 404 });
    await expect(setStepFields("nope", [{ label: "X", type: "NUMBER", sort: 1 }]))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe("process step code routes", () => {
  beforeEach(async () => await truncateAll());
  const ctx = { params: Promise.resolve({}) };
  const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("401s on every verb without a session", async () => {
    const get = await listRoute(new Request("http://t/api/admin/step-codes"), ctx);
    expect(get.status).toBe(401);

    const post = await createRoute(new Request("http://t/api/admin/step-codes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "HT-01", name: "Austenitize" }),
    }), ctx);
    expect(post.status).toBe(401);

    const put = await updateRoute(new Request("http://t/api/admin/step-codes/placeholder", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
    }), idCtx("placeholder"));
    expect(put.status).toBe(401);

    const del = await deleteRoute(
      new Request("http://t/api/admin/step-codes/placeholder", { method: "DELETE" }), idCtx("placeholder"),
    );
    expect(del.status).toBe(401);
  });

  it("403s for a signed-in user lacking the specific verb each route requires", async () => {
    const cookie = await signInWith(["admin.view"]);

    const ok = await listRoute(new Request("http://t/api/admin/step-codes", { headers: { cookie } }), ctx);
    expect(ok.status).toBe(200);

    const post = await createRoute(new Request("http://t/api/admin/step-codes", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "HT-01", name: "Austenitize" }),
    }), ctx);
    expect(post.status).toBe(403);

    const put = await updateRoute(new Request("http://t/api/admin/step-codes/placeholder", {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
    }), idCtx("placeholder"));
    expect(put.status).toBe(403);

    const del = await deleteRoute(new Request("http://t/api/admin/step-codes/placeholder", {
      method: "DELETE", headers: { cookie },
    }), idCtx("placeholder"));
    expect(del.status).toBe(403);
  });

  it("rejects an empty PUT body with 400 rather than reporting success for a no-op", async () => {
    const cookie = await signInWith(["admin.edit"]);
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });

    const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({}),
    }), idCtx(id));
    expect(res.status).toBe(400);
  });

  // `fields` is destructured out of `scalars` whatever its type, and `hasFields` only asks whether
  // it is an array — so a present-but-malformed `fields` used to vanish while the scalar half of
  // the same PUT applied and returned 200. That is the half-apply the route's atomic contract
  // exists to prevent, and the caller had no way to tell its field changes were dropped (Codex,
  // PR #22). Absent `fields` is still a legal scalars-only PUT; JSON cannot carry an `undefined`
  // value, so "not undefined" is exactly "the key was present".
  it("rejects a malformed fields value instead of dropping it and applying the scalars", async () => {
    const cookie = await signInWith(["admin.edit"]);

    for (const malformed of [null, {}, "nope", 7] as const) {
      const { id } = await createStepCode({ code: `HT-${String(malformed)}`, name: "Austenitize" });
      await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);

      const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
        method: "PUT", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed", fields: malformed }),
      }), idCtx(id));
      expect(res.status).toBe(400);

      // Neither half applied: the name is untouched and the field set is untouched.
      const code = (await listStepCodes()).find((c) => c.id === id);
      expect(code?.name).toBe("Austenitize");
      expect(code?.fields.map((f) => f.label)).toEqual(["Temperature"]);
    }
  });

  // A stale tab keeps a deleted code's editor on screen. Its next PUT used to succeed, because
  // the update matched on `id` alone with no liveness filter — so scalars and field definitions
  // were mutated under a soft-deleted code, and an `update` audit entry was written after the
  // delete entry, describing a change to a row nothing can see (Codex, PR #22). The code has no
  // undelete path, so nothing about that write was ever going to become visible again.
  it("refuses a PUT against a soft-deleted code instead of mutating it invisibly", async () => {
    const cookie = await signInWith(["admin.edit"]);
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    await deleteStepCode(id);
    const auditAfterDelete = (await readAudit("processStepCode", id)).length;

    for (const body of [{ name: "Renamed" }, { fields: [{ label: "Time", type: "NUMBER", sort: 1 }] }]) {
      const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
        method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
      }), idCtx(id));
      expect(res.status).toBe(404);
    }

    const row = await prisma.processStepCode.findUniqueOrThrow({
      where: { id }, include: { fields: true },
    });
    expect(row.name).toBe("Austenitize");
    expect(row.fields.map((f) => f.label)).toEqual(["Temperature"]);
    // No audit entry describing a change to a row that is already deleted.
    expect(await readAudit("processStepCode", id)).toHaveLength(auditAfterDelete);
  });

  it("still accepts a scalars-only PUT that omits fields entirely", async () => {
    const cookie = await signInWith(["admin.edit"]);
    const { id } = await createStepCode({ code: "HT-02", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);

    const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    }), idCtx(id));
    expect(res.status).toBe(200);

    const code = (await listStepCodes()).find((c) => c.id === id);
    expect(code?.name).toBe("Renamed");
    expect(code?.fields.map((f) => f.label)).toEqual(["Temperature"]);
  });

  it("a PUT with valid fields and an invalid glAccountId applies neither and writes no audit row", async () => {
    const cookie = await signInWith(["admin.edit"]);
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    const auditCountBefore = (await readAudit("processStepCode", id)).length;

    const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        glAccountId: "does-not-exist",
        fields: [{ label: "Time", type: "NUMBER", sort: 1 }],
      }),
    }), idCtx(id));
    expect(res.status).toBe(400);

    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Temperature"]);
    expect(await readAudit("processStepCode", id)).toHaveLength(auditCountBefore);
  });
});

describe("step field defs: .strict(), id-preserving edits, value blockers", () => {
  beforeEach(async () => await truncateAll());

  // customer -> part -> partProcessRevision -> partProcessStep -> partProcessStepValue, created
  // directly via prisma per the task-3 brief — the steps service doesn't exist yet (Task 4).
  async function fixtureWithValue() {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
    const { id: codeId } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(codeId, [{ label: "Temp", type: "NUMBER", sort: 1 }]);
    const fieldDef = (await listStepCodes()).find((c) => c.id === codeId)!.fields[0];
    const revision = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const step = await prisma.partProcessStep.create({
      data: { revisionId: revision.id, codeId, position: 1, instruction: "" },
    });
    const value = await prisma.partProcessStepValue.create({
      data: { stepId: step.id, fieldDefId: fieldDef.id, value: "1500" },
    });
    return { customer, part, codeId, fieldDef, value };
  }

  it(".strict() rejects an unknown key on a field item instead of silently dropping it", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(setStepFields(id, [{ label: "Temp", type: "NUMBER", sort: 1, bogus: "x" } as never]))
      .rejects.toMatchObject({ status: 400 });
  });

  it("relabeling a field by id preserves its id, so the value row still points at it", async () => {
    const { codeId, fieldDef, value } = await fixtureWithValue();

    await setStepFields(codeId, [{ id: fieldDef.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 }]);

    const fields = (await listStepCodes()).find((c) => c.id === codeId)!.fields;
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ id: fieldDef.id, label: "Temperature", unit: "F" });

    const row = await prisma.partProcessStepValue.findUniqueOrThrow({ where: { id: value.id } });
    expect(row.fieldDefId).toBe(fieldDef.id);
  });

  it("refuses a type change on a field that still has a value, naming the field in the message", async () => {
    const { codeId, fieldDef } = await fixtureWithValue();

    const err = await setStepFields(codeId, [
      { id: fieldDef.id, label: fieldDef.label, type: "TEXT", sort: 1 },
    ]).catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe(`Cannot change the type of "${fieldDef.label}" — 1 step value(s) use it`);

    // The refusal rolled the whole transaction back — the def's type is untouched, not half-applied.
    const fields = (await listStepCodes()).find((c) => c.id === codeId)!.fields;
    expect(fields).toEqual([fieldDef]);
  });

  it("refuses to delete a field that still has a value, when the payload omits it", async () => {
    const { codeId, fieldDef } = await fixtureWithValue();

    const err = await setStepFields(codeId, []).catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe(`Cannot remove field "${fieldDef.label}" — 1 step value(s) use it`);

    // The refusal rolled the whole transaction back — the def still exists, not half-deleted.
    const fields = (await listStepCodes()).find((c) => c.id === codeId)!.fields;
    expect(fields).toEqual([fieldDef]);
  });

  it("stepFieldBlockers lists the part once even across two revisions' values", async () => {
    const { part, codeId, fieldDef } = await fixtureWithValue();
    const revision2 = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 2 } });
    const step2 = await prisma.partProcessStep.create({
      data: { revisionId: revision2.id, codeId, position: 1, instruction: "" },
    });
    await prisma.partProcessStepValue.create({ data: { stepId: step2.id, fieldDefId: fieldDef.id, value: "1600" } });

    const blockers = await stepFieldBlockers(fieldDef.id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      entityLabel: "Part", name: "AC · P-1", id: part.id, href: `/parts/${part.id}`,
    });
  });

  // Regression (fix-round 2 correction — task-3-report.md has the full trail). syncStepFields's
  // guard is deliberately UNfiltered by the owning part's liveness — spec §6 ("blocked while any
  // PartProcessStepValue references the def... locked revisions included") and §11 testing item 4
  // ("delete/type-change blocked while values exist, including only-historical values") — because
  // `ProcessStepFieldDef` has no `deletedAt`, so its "delete" here is a genuine hard delete
  // against `PartProcessStepValue.fieldDefId`'s `ON DELETE RESTRICT` FK and can never safely
  // ignore a still-existing row. Per the owner's core rule (spec §5.14, "a refusal whose blocker
  // panel shows nothing is an undiscoverable dead end"), `stepFieldBlockers` was widened to match
  // the guard exactly (not narrowed the other way, which would have been physically impossible —
  // see the fix-round-1 note in the report for why a live-filtered guard just trades this
  // function's clean 400 for a raw DB error instead). This locks in the corrected shape: a value
  // under a soft-deleted part is still listed, marked `(deleted)` with no href since there's no
  // reachable detail page, and still produces the guard's normal field-named 400 for both
  // type-change and delete.
  it("a value under a soft-deleted part still shows in stepFieldBlockers as deleted, and still blocks delete/type-change", async () => {
    const { part, codeId, fieldDef } = await fixtureWithValue();
    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });

    const blockers = await stepFieldBlockers(fieldDef.id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      entityLabel: "Part", name: "AC · P-1 (deleted)", id: part.id, href: null,
    });

    const typeErr = await setStepFields(codeId, [
      { id: fieldDef.id, label: fieldDef.label, type: "TEXT", sort: 1 },
    ]).catch((e) => e);
    expect(typeErr).toBeInstanceOf(HttpError);
    expect((typeErr as HttpError).status).toBe(400);
    expect((typeErr as HttpError).message)
      .toBe(`Cannot change the type of "${fieldDef.label}" — 1 step value(s) use it`);

    const deleteErr = await setStepFields(codeId, []).catch((e) => e);
    expect(deleteErr).toBeInstanceOf(HttpError);
    expect((deleteErr as HttpError).status).toBe(400);
    expect((deleteErr as HttpError).message).toBe(`Cannot remove field "${fieldDef.label}" — 1 step value(s) use it`);

    // Neither refusal partially applied — the def is untouched.
    const fields = (await listStepCodes()).find((c) => c.id === codeId)!.fields;
    expect(fields).toEqual([fieldDef]);
  });
});

// Task 7: deleteStepCode adopts deleteReference's guarded shape verbatim (reference.ts:210) —
// Serializable transaction, findBlockers scan, refuse-with-count or auditedSoftDelete. Owner
// ruling (design spec §3.2 / §7): ANY live use blocks — current-revision step, locked-historical
// step, or template step — while a soft-deleted part's or template's step never does (liveWhere,
// Task 2).
describe("step-code delete guard", () => {
  beforeEach(async () => await truncateAll());

  it("blocks delete when the code is used by a current-revision step", async () => {
    const { part, codeId } = await stepCodeFixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await addPartStep(rev.id, codeId);

    const err = await deleteStepCode(codeId).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe("That process step code is still in use by 1 record(s)");
    expect(await listStepCodes()).toHaveLength(1);
  });

  it("blocks delete when the code is used ONLY by a locked-historical step (owner ruling §3.2)", async () => {
    const { part, codeId } = await stepCodeFixture();
    const historical = await prisma.partProcessRevision.create({
      data: { partId: part.id, revisionNumber: 1, lockedAt: new Date() },
    });
    await addPartStep(historical.id, codeId);
    // The current revision exists (higher-numbered, unlocked) and does NOT reference the code —
    // the only live reference is the locked, historical one.
    await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 2 } });

    const err = await deleteStepCode(codeId).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe("That process step code is still in use by 1 record(s)");
    expect(await listStepCodes()).toHaveLength(1);
  });

  it("blocks delete when the code is used by a template step", async () => {
    const { codeId } = await stepCodeFixture();
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({ data: { templateId: tpl.id, position: 1, codeId } });

    const err = await deleteStepCode(codeId).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe("That process step code is still in use by 1 record(s)");
    expect(await listStepCodes()).toHaveLength(1);
  });

  it("does NOT block on a step under a soft-deleted part", async () => {
    const { part, codeId } = await stepCodeFixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await addPartStep(rev.id, codeId);
    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });

    await expect(deleteStepCode(codeId)).resolves.toBeUndefined();
    expect(await listStepCodes()).toHaveLength(0);
  });

  it("does NOT block on a step under a soft-deleted template", async () => {
    const { codeId } = await stepCodeFixture();
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({ data: { templateId: tpl.id, position: 1, codeId } });
    await prisma.processTemplate.update({ where: { id: tpl.id }, data: { deletedAt: new Date() } });

    await expect(deleteStepCode(codeId)).resolves.toBeUndefined();
    expect(await listStepCodes()).toHaveLength(0);
  });

  it("an unused code soft-deletes cleanly, recording a delete audit entry", async () => {
    const { codeId } = await stepCodeFixture();

    await expect(deleteStepCode(codeId)).resolves.toBeUndefined();

    expect(await listStepCodes()).toHaveLength(0);
    // readAudit orders newest-first ({ at: "desc" }, { id: "desc" }) — see audit.ts.
    expect((await readAudit("processStepCode", codeId)).map((e) => e.action)).toEqual(["delete", "create"]);
  });

  it("the 400 count matches the deduped blocker list length across two revisions of one part", async () => {
    const { part, codeId } = await stepCodeFixture();
    const historical = await prisma.partProcessRevision.create({
      data: { partId: part.id, revisionNumber: 1, lockedAt: new Date() },
    });
    const current = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 2 } });
    await addPartStep(historical.id, codeId);
    await addPartStep(current.id, codeId);

    // Same part referenced from both revisions — findBlockers dedupes it to one row (Task 2).
    const blockers = await findBlockers("processStepCode", codeId);
    expect(blockers).toHaveLength(1);

    const err = await deleteStepCode(codeId).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toBe(`That process step code is still in use by ${blockers.length} record(s)`);
  });
});

// Mirrors tests/reference-blockers.test.ts's route coverage for
// src/app/api/admin/reference/[kind]/[id]/blockers{,/export}/route.ts — same `mustCan("admin",
// "view")` gating, same toXlsx column shape.
describe("step-code blocker routes", () => {
  beforeEach(async () => await truncateAll());
  const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("401s both routes without a session", async () => {
    const blockers = await stepCodeBlockersRoute(new Request("http://t/x"), idCtx("placeholder"));
    expect(blockers.status).toBe(401);

    const exported = await stepCodeBlockersExportRoute(new Request("http://t/x"), idCtx("placeholder"));
    expect(exported.status).toBe(401);
  });

  it("403s both routes for a session lacking admin.view", async () => {
    const cookie = await signInWith([], "nobody");

    const blockers = await stepCodeBlockersRoute(new Request("http://t/x", { headers: { cookie } }), idCtx("placeholder"));
    expect(blockers.status).toBe(403);

    const exported = await stepCodeBlockersExportRoute(
      new Request("http://t/x", { headers: { cookie } }), idCtx("placeholder"),
    );
    expect(exported.status).toBe(403);
  });

  it("200s the blocker list and a matching xlsx export", async () => {
    const { part, codeId } = await stepCodeFixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await addPartStep(rev.id, codeId);

    const cookie = await signInWith(["admin.view"]);

    const res = await stepCodeBlockersRoute(new Request("http://t/x", { headers: { cookie } }), idCtx(codeId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { entityLabel: "Part", name: "AC · P-1", id: part.id, href: `/parts/${part.id}` },
    ]);

    const exported = await stepCodeBlockersExportRoute(new Request("http://t/x", { headers: { cookie } }), idCtx(codeId));
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("spreadsheetml");

    const wb = new ExcelJS.Workbook();
    // See tests/excel.test.ts: exceljs's own type declarations shadow the global `Buffer` with a
    // module-local `interface Buffer extends ArrayBuffer {}` this project's `lib: ["esnext"]` no
    // longer structurally satisfies — the cast is only for the type checker, the bytes are unchanged.
    await wb.xlsx.load(Buffer.from(await exported.arrayBuffer()) as unknown as ArrayBuffer);
    const row = wb.getWorksheet(1)!.getRow(2).values as unknown[];
    expect(row).toContain("Part");
    expect(row).toContain("AC · P-1");
  });
});

// Fix-wave Finding 1 (2026-08-02 final review): stepFieldBlockers existed and was tested but
// nothing consumed it — the admin page's field-save failure path showed only a count, no
// discoverable blockers (spec §5.14 violation). These routes are the transplanted
// src/app/api/admin/step-codes/[id]/blockers{,/export} route pair, same gating and toXlsx shape,
// against stepFieldBlockers(fieldDefId) instead of findBlockers("processStepCode", id).
describe("step field-def blocker routes", () => {
  beforeEach(async () => await truncateAll());
  const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

  // Mirrors fixtureWithValue from the "step field defs" describe above (that helper is local to
  // its own describe block) — customer -> part -> step code with one NUMBER field def -> a value
  // on it, so there's a real blocker to list.
  async function fieldDefFixture() {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
    const { id: codeId } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(codeId, [{ label: "Temp", type: "NUMBER", sort: 1 }]);
    const fieldDef = (await listStepCodes()).find((c) => c.id === codeId)!.fields[0];
    const revision = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const step = await prisma.partProcessStep.create({
      data: { revisionId: revision.id, codeId, position: 1, instruction: "" },
    });
    const value = await prisma.partProcessStepValue.create({
      data: { stepId: step.id, fieldDefId: fieldDef.id, value: "1500" },
    });
    return { part, codeId, fieldDef, value };
  }

  it("401s both routes without a session", async () => {
    const blockers = await fieldDefBlockersRoute(new Request("http://t/x"), idCtx("placeholder"));
    expect(blockers.status).toBe(401);

    const exported = await fieldDefBlockersExportRoute(new Request("http://t/x"), idCtx("placeholder"));
    expect(exported.status).toBe(401);
  });

  it("403s both routes for a session lacking admin.view", async () => {
    const cookie = await signInWith([], "nobody");

    const blockers = await fieldDefBlockersRoute(new Request("http://t/x", { headers: { cookie } }), idCtx("placeholder"));
    expect(blockers.status).toBe(403);

    const exported = await fieldDefBlockersExportRoute(
      new Request("http://t/x", { headers: { cookie } }), idCtx("placeholder"),
    );
    expect(exported.status).toBe(403);
  });

  it("200s the blocker list and a matching xlsx export", async () => {
    const { part, fieldDef } = await fieldDefFixture();
    const cookie = await signInWith(["admin.view"]);

    const res = await fieldDefBlockersRoute(new Request("http://t/x", { headers: { cookie } }), idCtx(fieldDef.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { entityLabel: "Part", name: "AC · P-1", id: part.id, href: `/parts/${part.id}` },
    ]);

    const exported = await fieldDefBlockersExportRoute(new Request("http://t/x", { headers: { cookie } }), idCtx(fieldDef.id));
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("spreadsheetml");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await exported.arrayBuffer()) as unknown as ArrayBuffer);
    const row = wb.getWorksheet(1)!.getRow(2).values as unknown[];
    expect(row).toContain("Part");
    expect(row).toContain("AC · P-1");
  });

  it("a def with values under a soft-deleted part lists the \"(deleted)\"-suffixed blocker, with no href", async () => {
    const { part, fieldDef } = await fieldDefFixture();
    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    const cookie = await signInWith(["admin.view"]);

    const res = await fieldDefBlockersRoute(new Request("http://t/x", { headers: { cookie } }), idCtx(fieldDef.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { entityLabel: "Part", name: "AC · P-1 (deleted)", id: part.id, href: null },
    ]);

    const exported = await fieldDefBlockersExportRoute(new Request("http://t/x", { headers: { cookie } }), idCtx(fieldDef.id));
    expect(exported.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await exported.arrayBuffer()) as unknown as ArrayBuffer);
    const row = wb.getWorksheet(1)!.getRow(2).values as unknown[];
    expect(row).toContain("AC · P-1 (deleted)");
  });
});
