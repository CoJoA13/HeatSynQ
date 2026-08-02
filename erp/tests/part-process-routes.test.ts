import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createTemplate, updateTemplate, addTemplateStep } from "@/server/process-templates";
import { GET as revisionsGET } from "@/app/api/parts/[id]/process/revisions/route";
import { GET as revisionGET } from "@/app/api/parts/[id]/process/revisions/[n]/route";
import { POST as addStepPOST } from "@/app/api/parts/[id]/process/steps/route";
import { PATCH as updateStepPATCH, DELETE as removeStepDELETE } from "@/app/api/parts/[id]/process/steps/[stepId]/route";
import { POST as reorderPOST } from "@/app/api/parts/[id]/process/reorder/route";
import { POST as loadTemplatePOST } from "@/app/api/parts/[id]/process/load-template/route";
import { GET as stepCodeFieldsGET } from "@/app/api/process/step-code-fields/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** customer -> part -> a live step code — the fixture routes exercise below all target this
 *  part's process revisions. `part.create` needs `eachWeight: 1` (a required non-default column). */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  return { customer, part, code };
}

describe("process steps routes", () => {
  beforeEach(async () => await truncateAll());

  describe("GET /api/parts/[id]/process/revisions", () => {
    it("401s without a session", async () => {
      const { part } = await fixture();
      const res = await revisionsGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions`),
        { params: Promise.resolve({ id: part.id }) },
      );
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.view", async () => {
      const { part } = await fixture();
      const cookie = await signInWith(["parts.view"]);
      const res = await revisionsGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id }) },
      );
      expect(res.status).toBe(403);
    });

    it("200s with the revision summary list", async () => {
      const { part, code } = await fixture();
      const editCookie = await signInWith(["processes.edit"], "editor");
      await addStepPOST(new Request(`http://t/api/parts/${part.id}/process/steps`, {
        method: "POST", headers: { cookie: editCookie, "content-type": "application/json" },
        body: JSON.stringify({ codeId: code.id, instruction: "Heat to 1500F" }),
      }), { params: Promise.resolve({ id: part.id }) });

      const viewCookie = await signInWith(["processes.view"], "viewer");
      const res = await revisionsGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions`, { headers: { cookie: viewCookie } }),
        { params: Promise.resolve({ id: part.id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { revisionNumber: number; lockedAt: null; stepCount: number; createdAt: string }[];
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ revisionNumber: 1, lockedAt: null, stepCount: 1 });
      expect(body[0].createdAt).toEqual(expect.any(String));
    });
  });

  describe("GET /api/parts/[id]/process/revisions/[n]", () => {
    it("401s without a session", async () => {
      const { part } = await fixture();
      const res = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/1`),
        { params: Promise.resolve({ id: part.id, n: "1" }) },
      );
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.view", async () => {
      const { part } = await fixture();
      const cookie = await signInWith(["parts.view"]);
      const res = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/1`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id, n: "1" }) },
      );
      expect(res.status).toBe(403);
    });

    it("200s the full revision detail, joined to the live code", async () => {
      const { part, code } = await fixture();
      const cookie = await signInWith(["processes.view", "processes.edit"]);
      await addStepPOST(new Request(`http://t/api/parts/${part.id}/process/steps`, {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ codeId: code.id, instruction: "Heat to 1500F" }),
      }), { params: Promise.resolve({ id: part.id }) });

      const res = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/1`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id, n: "1" }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { revisionNumber: number; steps: { code: string; codeName: string; instruction: string }[] };
      expect(body.revisionNumber).toBe(1);
      expect(body.steps).toHaveLength(1);
      expect(body.steps[0]).toMatchObject({ code: "HT-01", codeName: "Austenitize", instruction: "Heat to 1500F" });
    });

    it("400s a non-numeric revision number instead of 500ing", async () => {
      const { part } = await fixture();
      const cookie = await signInWith(["processes.view"]);
      const res = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/abc`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id, n: "abc" }) },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/parts/[id]/process/steps", () => {
    it("401s without a session", async () => {
      const { part, code } = await fixture();
      const res = await addStepPOST(new Request(`http://t/api/parts/${part.id}/process/steps`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ codeId: code.id }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.edit", async () => {
      const { part, code } = await fixture();
      const cookie = await signInWith(["processes.view"]);
      const res = await addStepPOST(new Request(`http://t/api/parts/${part.id}/process/steps`, {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ codeId: code.id }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(403);
    });

    it("200s with the new step's id and the revision it landed on", async () => {
      const { part, code } = await fixture();
      const cookie = await signInWith(["processes.edit"]);
      const res = await addStepPOST(new Request(`http://t/api/parts/${part.id}/process/steps`, {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ codeId: code.id, instruction: "Heat to 1500F" }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(200);
      const body = await res.json() as { revisionNumber: number; stepId: string };
      expect(body.revisionNumber).toBe(1);
      expect(body.stepId).toEqual(expect.any(String));
    });
  });

  describe("PATCH + DELETE /api/parts/[id]/process/steps/[stepId]", () => {
    async function stepFixture() {
      const { part, code } = await fixture();
      const cookie = await signInWith(["processes.edit"]);
      const res = await addStepPOST(new Request(`http://t/api/parts/${part.id}/process/steps`, {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ codeId: code.id, instruction: "Original" }),
      }), { params: Promise.resolve({ id: part.id }) });
      const { stepId } = await res.json() as { stepId: string };
      return { part, code, cookie, stepId };
    }
    const ctx = (id: string, stepId: string) => ({ params: Promise.resolve({ id, stepId }) });

    it("PATCH 401s without a session", async () => {
      const { part, stepId } = await stepFixture();
      const res = await updateStepPATCH(new Request(`http://t/api/parts/${part.id}/process/steps/${stepId}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "New" }),
      }), ctx(part.id, stepId));
      expect(res.status).toBe(401);
    });

    it("PATCH 403s for a session lacking processes.edit", async () => {
      const { part, stepId } = await stepFixture();
      const viewOnly = await signInWith(["processes.view"], "viewer");
      const res = await updateStepPATCH(new Request(`http://t/api/parts/${part.id}/process/steps/${stepId}`, {
        method: "PATCH", headers: { cookie: viewOnly, "content-type": "application/json" },
        body: JSON.stringify({ instruction: "New" }),
      }), ctx(part.id, stepId));
      expect(res.status).toBe(403);
    });

    it("PATCH 200s and amends in place (same revision number)", async () => {
      const { part, cookie, stepId } = await stepFixture();
      const res = await updateStepPATCH(new Request(`http://t/api/parts/${part.id}/process/steps/${stepId}`, {
        method: "PATCH", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ instruction: "Updated" }),
      }), ctx(part.id, stepId));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revisionNumber: 1 });
    });

    it("PATCH rejects an unknown key with 400 (.strict())", async () => {
      const { part, cookie, stepId } = await stepFixture();
      const res = await updateStepPATCH(new Request(`http://t/api/parts/${part.id}/process/steps/${stepId}`, {
        method: "PATCH", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ instruction: "Updated", bogus: "x" }),
      }), ctx(part.id, stepId));
      expect(res.status).toBe(400);
    });

    it("DELETE 401s without a session", async () => {
      const { part, stepId } = await stepFixture();
      const res = await removeStepDELETE(
        new Request(`http://t/api/parts/${part.id}/process/steps/${stepId}`, { method: "DELETE" }),
        ctx(part.id, stepId),
      );
      expect(res.status).toBe(401);
    });

    it("DELETE 403s for a session lacking processes.edit", async () => {
      const { part, stepId } = await stepFixture();
      const viewOnly = await signInWith(["processes.view"], "viewer2");
      const res = await removeStepDELETE(
        new Request(`http://t/api/parts/${part.id}/process/steps/${stepId}`, { method: "DELETE", headers: { cookie: viewOnly } }),
        ctx(part.id, stepId),
      );
      expect(res.status).toBe(403);
    });

    it("DELETE works with a null body (no content-type, no body sent)", async () => {
      const { part, cookie, stepId } = await stepFixture();
      const res = await removeStepDELETE(
        new Request(`http://t/api/parts/${part.id}/process/steps/${stepId}`, { method: "DELETE", headers: { cookie } }),
        ctx(part.id, stepId),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revisionNumber: 1 });
    });
  });

  describe("POST /api/parts/[id]/process/reorder", () => {
    async function twoStepFixture() {
      const { part, code } = await fixture();
      const cookie = await signInWith(["processes.edit", "processes.view"]);
      const first = await (await addStepPOST(new Request(`http://t/api/parts/${part.id}/process/steps`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ codeId: code.id }),
      }), { params: Promise.resolve({ id: part.id }) })).json() as { stepId: string };
      const second = await (await addStepPOST(new Request(`http://t/api/parts/${part.id}/process/steps`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ codeId: code.id }),
      }), { params: Promise.resolve({ id: part.id }) })).json() as { stepId: string };
      return { part, cookie, firstId: first.stepId, secondId: second.stepId };
    }

    it("401s without a session", async () => {
      const { part, firstId, secondId } = await twoStepFixture();
      const res = await reorderPOST(new Request(`http://t/api/parts/${part.id}/process/reorder`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderedStepIds: [secondId, firstId] }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.edit", async () => {
      const { part, firstId, secondId } = await twoStepFixture();
      const viewOnly = await signInWith(["processes.view"], "viewer3");
      const res = await reorderPOST(new Request(`http://t/api/parts/${part.id}/process/reorder`, {
        method: "POST", headers: { cookie: viewOnly, "content-type": "application/json" },
        body: JSON.stringify({ orderedStepIds: [secondId, firstId] }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(403);
    });

    it("200s and the new order is reflected in the revision detail", async () => {
      const { part, cookie, firstId, secondId } = await twoStepFixture();
      const res = await reorderPOST(new Request(`http://t/api/parts/${part.id}/process/reorder`, {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ orderedStepIds: [secondId, firstId] }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revisionNumber: 1 });

      const detail = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/1`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id, n: "1" }) },
      );
      const body = await detail.json() as { steps: { id: string }[] };
      expect(body.steps.map((s) => s.id)).toEqual([secondId, firstId]);
    });
  });

  describe("POST /api/parts/[id]/process/load-template", () => {
    async function templateFixture() {
      const { part, code } = await fixture();
      const { id: templateId } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await asSystem(() => addTemplateStep(templateId, { codeId: code.id, boilerplate: "Heat" }));
      return { part, code, templateId };
    }

    it("401s without a session", async () => {
      const { part, templateId } = await templateFixture();
      const res = await loadTemplatePOST(new Request(`http://t/api/parts/${part.id}/process/load-template`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateId }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.edit", async () => {
      const { part, templateId } = await templateFixture();
      const viewOnly = await signInWith(["processes.view"], "viewer4");
      const res = await loadTemplatePOST(new Request(`http://t/api/parts/${part.id}/process/load-template`, {
        method: "POST", headers: { cookie: viewOnly, "content-type": "application/json" }, body: JSON.stringify({ templateId }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(403);
    });

    it("200s and replaces the working revision's steps with the template's", async () => {
      const { part, code, templateId } = await templateFixture();
      const cookie = await signInWith(["processes.edit", "processes.view"]);
      const res = await loadTemplatePOST(new Request(`http://t/api/parts/${part.id}/process/load-template`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ templateId }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revisionNumber: 1 });

      const detail = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/1`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id, n: "1" }) },
      );
      const body = await detail.json() as { steps: { code: string; instruction: string }[] };
      expect(body.steps).toEqual([{
        id: expect.any(String), position: 1, codeId: code.id, code: "HT-01", codeName: "Austenitize",
        instruction: "Heat", values: [],
      }]);
    });

    it("a nonexistent template 404s with a clean JSON error, not a 500", async () => {
      const { part } = await templateFixture();
      const cookie = await signInWith(["processes.edit"]);
      const res = await loadTemplatePOST(new Request(`http://t/api/parts/${part.id}/process/load-template`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ templateId: "nonexistent" }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Template not found" });
    });

    it("an inactive template 400s with a clean JSON error, not a 500", async () => {
      const { part, templateId } = await templateFixture();
      await asSystem(() => updateTemplate(templateId, { active: false }));
      const cookie = await signInWith(["processes.edit"]);
      const res = await loadTemplatePOST(new Request(`http://t/api/parts/${part.id}/process/load-template`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ templateId }),
      }), { params: Promise.resolve({ id: part.id }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That template is inactive" });
    });
  });
});

describe("GET /api/process/step-code-fields", () => {
  beforeEach(async () => await truncateAll());

  it("401s without a session", async () => {
    const res = await stepCodeFieldsGET(
      new Request("http://t/api/process/step-code-fields"), { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(401);
  });

  it("200s for any signed-in session, no permission required beyond it", async () => {
    const cookie = await signInWith([]);
    const res = await stepCodeFieldsGET(
      new Request("http://t/api/process/step-code-fields", { headers: { cookie } }), { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
  });

  it("returns only live codes, code-ascending, each with its fields sorted by sort", async () => {
    const codeB = await prisma.processStepCode.create({ data: { code: "HT-02", name: "Second" } });
    const codeA = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
    await prisma.processStepFieldDef.create({ data: { codeId: codeA.id, label: "Time", type: "NUMBER", unit: "min", sort: 2 } });
    await prisma.processStepFieldDef.create({ data: { codeId: codeA.id, label: "Temp", type: "NUMBER", unit: "F", sort: 1 } });
    const inactiveCode = await prisma.processStepCode.create({ data: { code: "HT-03", name: "Inactive", active: false } });
    await prisma.processStepCode.create({ data: { code: "HT-04", name: "Deleted", deletedAt: new Date() } });
    void codeB;

    const cookie = await signInWith([]);
    const res = await stepCodeFieldsGET(
      new Request("http://t/api/process/step-code-fields", { headers: { cookie } }), { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    type Row = { id: string; code: string; name: string; active: boolean; fields: { id: string; label: string; type: string; unit: string | null; sort: number }[] };
    const body = await res.json() as Row[];

    expect(body.map((c) => c.code)).toEqual(["HT-01", "HT-02", "HT-03"]);

    const first = body.find((c) => c.id === codeA.id)!;
    expect(first).toMatchObject({ code: "HT-01", name: "Austenitize", active: true });
    expect(first.fields.map((f) => f.label)).toEqual(["Temp", "Time"]);
    expect(first.fields[0]).toMatchObject({ label: "Temp", type: "NUMBER", unit: "F", sort: 1 });

    const inactive = body.find((c) => c.id === inactiveCode.id)!;
    expect(inactive).toMatchObject({ code: "HT-03", active: false });
    expect(inactive.fields).toEqual([]);
  });
});
