import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll, prisma } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET as listGET, POST as createPOST } from "@/app/api/process-templates/route";
import { GET as detailGET, PATCH as updatePATCH, DELETE as deleteDELETE } from "@/app/api/process-templates/[id]/route";
import { POST as addStepPOST } from "@/app/api/process-templates/[id]/steps/route";
import { PATCH as updateStepPATCH, DELETE as removeStepDELETE } from "@/app/api/process-templates/[id]/steps/[stepId]/route";
import { POST as reorderPOST } from "@/app/api/process-templates/[id]/reorder/route";
import { GET as exportGET } from "@/app/api/process-templates/export/route";

const noParams = { params: Promise.resolve({}) };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const withStepId = (id: string, stepId: string) => ({ params: Promise.resolve({ id, stepId }) });

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function bodyReq(url: string, method: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function noBodyReq(url: string, method: string, cookie?: string): Request {
  return new Request(url, { method, headers: cookie ? { cookie } : {} });
}

/** A live process-step code — templates tests don't need parts, but step fixtures need this. */
async function fixture() {
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  return { code };
}

describe("process template routes", () => {
  beforeEach(async () => await truncateAll());

  describe("GET /api/process-templates + POST /api/process-templates", () => {
    it("401s both without a session", async () => {
      expect((await listGET(getReq("http://t/api/process-templates"), noParams)).status).toBe(401);
      expect((await createPOST(bodyReq("http://t/api/process-templates", "POST", undefined, { name: "Anneal" }), noParams)).status).toBe(401);
    });

    it("403s GET for a session lacking processes.view, and POST for a session lacking processes.create", async () => {
      const createOnly = await signInWith(["processes.create"], "create-only-1");
      expect((await listGET(getReq("http://t/api/process-templates", createOnly), noParams)).status).toBe(403);

      const viewOnly = await signInWith(["processes.view"], "view-only-1");
      expect((await createPOST(bodyReq("http://t/api/process-templates", "POST", viewOnly, { name: "Anneal" }), noParams)).status).toBe(403);
    });

    it("POST 200s with the new id; GET lists it with its step count and active flag", async () => {
      const cookie = await signInWith(["processes.view", "processes.create"], "list-create-1");
      const created = await createPOST(bodyReq("http://t/api/process-templates", "POST", cookie, { name: "Standard Anneal" }), noParams);
      expect(created.status).toBe(200);
      const { id } = await created.json() as { id: string };
      expect(id).toEqual(expect.any(String));

      const listed = await listGET(getReq("http://t/api/process-templates", cookie), noParams);
      expect(listed.status).toBe(200);
      const body = await listed.json() as { id: string; name: string; active: boolean; stepCount: number }[];
      expect(body).toEqual([{ id, name: "Standard Anneal", active: true, stepCount: 0, updatedAt: expect.any(String) }]);
    });
  });

  describe("GET + PATCH + DELETE /api/process-templates/[id]", () => {
    async function templateFixture() {
      const { code } = await fixture();
      const cookie = await signInWith(["processes.view", "processes.create", "processes.edit", "processes.delete"], "detail-full-1");
      const created = await createPOST(bodyReq("http://t/api/process-templates", "POST", cookie, { name: "Standard Anneal" }), noParams);
      const { id } = await created.json() as { id: string };
      await addStepPOST(bodyReq(`http://t/api/process-templates/${id}/steps`, "POST", cookie, { codeId: code.id, boilerplate: "Heat" }), withId(id));
      return { id, code };
    }

    it("401s all three without a session", async () => {
      const { id } = await templateFixture();
      expect((await detailGET(getReq(`http://t/api/process-templates/${id}`), withId(id))).status).toBe(401);
      expect((await updatePATCH(bodyReq(`http://t/api/process-templates/${id}`, "PATCH", undefined, { name: "New" }), withId(id))).status).toBe(401);
      expect((await deleteDELETE(bodyReq(`http://t/api/process-templates/${id}`, "DELETE", undefined, { reason: "cleanup" }), withId(id))).status).toBe(401);
    });

    it("403s GET/PATCH/DELETE each for a session lacking the matching permission", async () => {
      const { id } = await templateFixture();

      const editOnly = await signInWith(["processes.edit"], "detail-edit-only-1");
      expect((await detailGET(getReq(`http://t/api/process-templates/${id}`, editOnly), withId(id))).status).toBe(403);

      const viewOnly = await signInWith(["processes.view"], "detail-view-only-1");
      expect((await updatePATCH(bodyReq(`http://t/api/process-templates/${id}`, "PATCH", viewOnly, { name: "New" }), withId(id))).status).toBe(403);

      const editOnly2 = await signInWith(["processes.edit"], "detail-edit-only-2");
      expect((await deleteDELETE(bodyReq(`http://t/api/process-templates/${id}`, "DELETE", editOnly2, { reason: "cleanup" }), withId(id))).status).toBe(403);
    });

    it("GET 200s the full detail with its ordered steps, joined to the live code", async () => {
      const { id, code } = await templateFixture();
      const cookie = await signInWith(["processes.view"], "detail-get-1");
      const res = await detailGET(getReq(`http://t/api/process-templates/${id}`, cookie), withId(id));
      expect(res.status).toBe(200);
      const body = await res.json() as { id: string; name: string; active: boolean; steps: { codeId: string; code: string; codeName: string; boilerplate: string }[] };
      expect(body).toMatchObject({ id, name: "Standard Anneal", active: true });
      expect(body.steps).toEqual([
        { id: expect.any(String), position: 1, codeId: code.id, code: "HT-01", codeName: "Austenitize", boilerplate: "Heat" },
      ]);
    });

    it("PATCH 200s and renames in place", async () => {
      const { id } = await templateFixture();
      const cookie = await signInWith(["processes.view", "processes.edit"], "detail-patch-1");
      const res = await updatePATCH(bodyReq(`http://t/api/process-templates/${id}`, "PATCH", cookie, { name: "Renamed" }), withId(id));
      expect(res.status).toBe(200);
      const detail = await detailGET(getReq(`http://t/api/process-templates/${id}`, cookie), withId(id));
      expect((await detail.json() as { name: string }).name).toBe("Renamed");
    });

    it("DELETE without a reason 400s", async () => {
      const { id } = await templateFixture();
      const cookie = await signInWith(["processes.delete"], "detail-delete-noreason-1");
      const res = await deleteDELETE(bodyReq(`http://t/api/process-templates/${id}`, "DELETE", cookie, {}), withId(id));
      expect(res.status).toBe(400);
    });

    it("DELETE with a null body (no content-type, no body sent) still 400s instead of 500ing", async () => {
      const { id } = await templateFixture();
      const cookie = await signInWith(["processes.delete"], "detail-delete-nullbody-1");
      const res = await deleteDELETE(noBodyReq(`http://t/api/process-templates/${id}`, "DELETE", cookie), withId(id));
      expect(res.status).toBe(400);
    });

    it("DELETE with a reason 200s and the template no longer lists", async () => {
      const { id } = await templateFixture();
      const cookie = await signInWith(["processes.view", "processes.delete"], "detail-delete-1");
      const res = await deleteDELETE(bodyReq(`http://t/api/process-templates/${id}`, "DELETE", cookie, { reason: "obsolete" }), withId(id));
      expect(res.status).toBe(200);
      const listed = await listGET(getReq("http://t/api/process-templates", cookie), noParams);
      expect(await listed.json()).toEqual([]);
    });
  });

  describe("POST /api/process-templates/[id]/steps", () => {
    async function idFixture() {
      const { code } = await fixture();
      const cookie = await signInWith(["processes.view", "processes.create"], "steps-post-setup-1");
      const created = await createPOST(bodyReq("http://t/api/process-templates", "POST", cookie, { name: "Standard Anneal" }), noParams);
      const { id } = await created.json() as { id: string };
      return { id, code };
    }

    it("401s without a session", async () => {
      const { id, code } = await idFixture();
      const res = await addStepPOST(bodyReq(`http://t/api/process-templates/${id}/steps`, "POST", undefined, { codeId: code.id }), withId(id));
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.edit", async () => {
      const { id, code } = await idFixture();
      const viewOnly = await signInWith(["processes.view"], "steps-post-view-1");
      const res = await addStepPOST(bodyReq(`http://t/api/process-templates/${id}/steps`, "POST", viewOnly, { codeId: code.id }), withId(id));
      expect(res.status).toBe(403);
    });

    it("200s with the new step's id", async () => {
      const { id, code } = await idFixture();
      const cookie = await signInWith(["processes.edit"], "steps-post-edit-1");
      const res = await addStepPOST(bodyReq(`http://t/api/process-templates/${id}/steps`, "POST", cookie, { codeId: code.id, boilerplate: "Heat to 1500F" }), withId(id));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: expect.any(String) });
    });
  });

  describe("PATCH + DELETE /api/process-templates/[id]/steps/[stepId]", () => {
    async function stepFixture() {
      const { code } = await fixture();
      const cookie = await signInWith(["processes.view", "processes.create", "processes.edit"], "steps-edit-setup-1");
      const created = await createPOST(bodyReq("http://t/api/process-templates", "POST", cookie, { name: "Standard Anneal" }), noParams);
      const { id } = await created.json() as { id: string };
      const stepRes = await addStepPOST(bodyReq(`http://t/api/process-templates/${id}/steps`, "POST", cookie, { codeId: code.id, boilerplate: "Original" }), withId(id));
      const { id: stepId } = await stepRes.json() as { id: string };
      return { id, stepId, cookie };
    }

    it("PATCH 401s without a session", async () => {
      const { id, stepId } = await stepFixture();
      const res = await updateStepPATCH(bodyReq(`http://t/api/process-templates/${id}/steps/${stepId}`, "PATCH", undefined, { boilerplate: "New" }), withStepId(id, stepId));
      expect(res.status).toBe(401);
    });

    it("PATCH 403s for a session lacking processes.edit", async () => {
      const { id, stepId } = await stepFixture();
      const viewOnly = await signInWith(["processes.view"], "steps-edit-view-1");
      const res = await updateStepPATCH(bodyReq(`http://t/api/process-templates/${id}/steps/${stepId}`, "PATCH", viewOnly, { boilerplate: "New" }), withStepId(id, stepId));
      expect(res.status).toBe(403);
    });

    it("PATCH 200s and updates the step's boilerplate", async () => {
      const { id, stepId, cookie } = await stepFixture();
      const res = await updateStepPATCH(bodyReq(`http://t/api/process-templates/${id}/steps/${stepId}`, "PATCH", cookie, { boilerplate: "Updated" }), withStepId(id, stepId));
      expect(res.status).toBe(200);
      const detail = await detailGET(getReq(`http://t/api/process-templates/${id}`, cookie), withId(id));
      const body = await detail.json() as { steps: { boilerplate: string }[] };
      expect(body.steps[0].boilerplate).toBe("Updated");
    });

    it("PATCH rejects an unknown key with 400 (.strict())", async () => {
      const { id, stepId, cookie } = await stepFixture();
      const res = await updateStepPATCH(bodyReq(`http://t/api/process-templates/${id}/steps/${stepId}`, "PATCH", cookie, { boilerplate: "Updated", bogus: "x" }), withStepId(id, stepId));
      expect(res.status).toBe(400);
    });

    it("DELETE 401s without a session", async () => {
      const { id, stepId } = await stepFixture();
      const res = await removeStepDELETE(noBodyReq(`http://t/api/process-templates/${id}/steps/${stepId}`, "DELETE"), withStepId(id, stepId));
      expect(res.status).toBe(401);
    });

    it("DELETE 403s for a session lacking processes.edit", async () => {
      const { id, stepId } = await stepFixture();
      const viewOnly = await signInWith(["processes.view"], "steps-delete-view-1");
      const res = await removeStepDELETE(noBodyReq(`http://t/api/process-templates/${id}/steps/${stepId}`, "DELETE", viewOnly), withStepId(id, stepId));
      expect(res.status).toBe(403);
    });

    it("DELETE 200s and the step no longer appears in the detail", async () => {
      const { id, stepId, cookie } = await stepFixture();
      const res = await removeStepDELETE(noBodyReq(`http://t/api/process-templates/${id}/steps/${stepId}`, "DELETE", cookie), withStepId(id, stepId));
      expect(res.status).toBe(200);
      const detail = await detailGET(getReq(`http://t/api/process-templates/${id}`, cookie), withId(id));
      const body = await detail.json() as { steps: unknown[] };
      expect(body.steps).toEqual([]);
    });
  });

  describe("POST /api/process-templates/[id]/reorder", () => {
    async function twoStepFixture() {
      const { code } = await fixture();
      const cookie = await signInWith(["processes.view", "processes.create", "processes.edit"], "reorder-setup-1");
      const created = await createPOST(bodyReq("http://t/api/process-templates", "POST", cookie, { name: "Standard Anneal" }), noParams);
      const { id } = await created.json() as { id: string };
      const first = await (await addStepPOST(bodyReq(`http://t/api/process-templates/${id}/steps`, "POST", cookie, { codeId: code.id }), withId(id))).json() as { id: string };
      const second = await (await addStepPOST(bodyReq(`http://t/api/process-templates/${id}/steps`, "POST", cookie, { codeId: code.id }), withId(id))).json() as { id: string };
      return { id, cookie, firstId: first.id, secondId: second.id };
    }

    it("401s without a session", async () => {
      const { id, firstId, secondId } = await twoStepFixture();
      const res = await reorderPOST(bodyReq(`http://t/api/process-templates/${id}/reorder`, "POST", undefined, { orderedStepIds: [secondId, firstId] }), withId(id));
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.edit", async () => {
      const { id, firstId, secondId } = await twoStepFixture();
      const viewOnly = await signInWith(["processes.view"], "reorder-view-1");
      const res = await reorderPOST(bodyReq(`http://t/api/process-templates/${id}/reorder`, "POST", viewOnly, { orderedStepIds: [secondId, firstId] }), withId(id));
      expect(res.status).toBe(403);
    });

    it("200s and the new order is reflected in the detail", async () => {
      const { id, cookie, firstId, secondId } = await twoStepFixture();
      const res = await reorderPOST(bodyReq(`http://t/api/process-templates/${id}/reorder`, "POST", cookie, { orderedStepIds: [secondId, firstId] }), withId(id));
      expect(res.status).toBe(200);

      const detail = await detailGET(getReq(`http://t/api/process-templates/${id}`, cookie), withId(id));
      const body = await detail.json() as { steps: { id: string }[] };
      expect(body.steps.map((s) => s.id)).toEqual([secondId, firstId]);
    });
  });

  describe("GET /api/process-templates/export", () => {
    it("401s without a session", async () => {
      const res = await exportGET(getReq("http://t/api/process-templates/export"), noParams);
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.view", async () => {
      const editOnly = await signInWith(["processes.edit"], "export-edit-only-1");
      const res = await exportGET(getReq("http://t/api/process-templates/export", editOnly), noParams);
      expect(res.status).toBe(403);
    });

    it("200s an xlsx with Name, Active, Steps columns", async () => {
      const { code } = await fixture();
      const cookie = await signInWith(["processes.view", "processes.create", "processes.edit"], "export-view-1");
      const created = await createPOST(bodyReq("http://t/api/process-templates", "POST", cookie, { name: "Standard Anneal" }), noParams);
      const { id } = await created.json() as { id: string };
      await addStepPOST(bodyReq(`http://t/api/process-templates/${id}/steps`, "POST", cookie, { codeId: code.id }), withId(id));

      const res = await exportGET(getReq("http://t/api/process-templates/export", cookie), noParams);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("content-disposition")).toContain(".xlsx");

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
      const header = wb.getWorksheet(1)!.getRow(1).values as unknown[];
      expect(header).toEqual(expect.arrayContaining(["Name", "Active", "Steps"]));
      const dataRow = wb.getWorksheet(1)!.getRow(2).values as unknown[];
      expect(dataRow).toContain("Standard Anneal");
      expect(dataRow).toContain("yes");
      expect(dataRow).toContain(1);
    });
  });
});
