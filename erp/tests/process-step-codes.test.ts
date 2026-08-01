import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import {
  listStepCodes, createStepCode, updateStepCode, deleteStepCode, setStepFields,
} from "@/server/process-step-codes";
import { createReference } from "@/server/reference";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";
import { GET as listRoute, POST as createRoute } from "@/app/api/admin/step-codes/route";
import { PUT as updateRoute, DELETE as deleteRoute } from "@/app/api/admin/step-codes/[id]/route";
import { signInWith } from "./helpers/auth";

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
