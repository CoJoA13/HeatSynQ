import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";

import { GET as listParts, POST as createPartRoute } from "@/app/api/parts/route";
import { GET as getPartRoute, PATCH as patchPart, DELETE as deletePartRoute } from "@/app/api/parts/[id]/route";
import { GET as listSpecs, POST as addSpecRoute } from "@/app/api/parts/[id]/specifications/route";
import { DELETE as removeSpecRoute } from "@/app/api/parts/[id]/specifications/[linkId]/route";
import { GET as listInspections, POST as addInspectionRoute } from "@/app/api/parts/[id]/inspections/route";
import {
  PATCH as patchInspectionRoute, DELETE as deleteInspectionRoute,
} from "@/app/api/parts/[id]/inspections/[inspId]/route";
import { PUT as reorderInspectionsRoute } from "@/app/api/parts/[id]/inspections/order/route";
import { GET as listBreaks, POST as addBreakRoute } from "@/app/api/parts/[id]/breaks/route";
import { PATCH as patchBreakRoute, DELETE as deleteBreakRoute } from "@/app/api/parts/[id]/breaks/[breakId]/route";
import { GET as getFieldsRoute, PUT as putFieldsRoute } from "@/app/api/parts/[id]/fields/route";

import { GET as listFieldDefs, POST as createFieldDefRoute } from "@/app/api/admin/part-fields/route";
import { PUT as updateFieldDefRoute, DELETE as deleteFieldDefRoute } from "@/app/api/admin/part-fields/[id]/route";
import { GET as fieldDefBlockersRoute } from "@/app/api/admin/part-fields/[id]/blockers/route";
import { GET as fieldDefBlockersExportRoute } from "@/app/api/admin/part-fields/[id]/blockers/export/route";

import { createPart } from "@/server/parts";
import { createPartFieldDef } from "@/server/part-field-defs";
import { setPartFieldValues } from "@/server/part-field-values";

const noParams = { params: Promise.resolve({}) };
const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

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

async function partFixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const other = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const { id: partId } = await createPart({ customerId: customer.id, partNumber: "12345", eachWeight: 1 });
  const { id: otherPartId } = await createPart({ customerId: other.id, partNumber: "99999", eachWeight: 1 });
  return { customer, other, partId, otherPartId };
}

describe("parts routes", () => {
  beforeEach(async () => await truncateAll());

  it("GET /api/parts requires parts.view; POST requires parts.create", async () => {
    const { customer } = await partFixture();

    expect((await listParts(getReq("http://t/api/parts"), noParams)).status).toBe(401);
    expect((await createPartRoute(bodyReq("http://t/api/parts", "POST", undefined, {}), noParams)).status).toBe(401);

    const wrong = await signInWith(["customers.view"], "wrong-1");
    expect((await listParts(getReq("http://t/api/parts", wrong), noParams)).status).toBe(403);
    expect((await createPartRoute(bodyReq("http://t/api/parts", "POST", wrong, {}), noParams)).status).toBe(403);

    const viewer = await signInWith(["parts.view"], "viewer-1");
    expect((await listParts(getReq("http://t/api/parts", viewer), noParams)).status).toBe(200);

    const creator = await signInWith(["parts.create"], "creator-1");
    const res = await createPartRoute(bodyReq("http://t/api/parts", "POST", creator, {
      customerId: customer.id, partNumber: "NEW1", eachWeight: 1,
    }), noParams);
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).id).toBe("string");
  });

  // F8: `PRICING_FIELDS.some((f) => f in body)` threw a raw TypeError for a null (or number)
  // body before it ever reached zod, escaping handle()'s error mapping as an unhandled 500.
  it("POST /api/parts with a non-object JSON body is 400, not 500", async () => {
    const creator = await signInWith(["parts.create"], "non-object-create-1");
    const res = await createPartRoute(bodyReq("http://t/api/parts", "POST", creator, null), noParams);
    expect(res.status).toBe(400);
  });

  it("POST with any pricing field present requires change_prices — even pricePer or a null", async () => {
    const { customer } = await partFixture();
    const createOnly = await signInWith(["parts.create"], "create-only-1");
    const body = { customerId: customer.id, partNumber: "PX1", eachWeight: 1, unitPrice: null };

    const denied = await createPartRoute(bodyReq("http://t/api/parts", "POST", createOnly, body), noParams);
    expect(denied.status).toBe(403);

    const priced = await signInWith(["parts.create", "action.change_prices"], "create-price-1");
    const allowed = await createPartRoute(bodyReq("http://t/api/parts", "POST", priced, {
      ...body, partNumber: "PX2",
    }), noParams);
    expect(allowed.status).toBe(200);

    // pricePer alone (no dollar value) still counts as a pricing field.
    const pricePerOnly = await createPartRoute(bodyReq("http://t/api/parts", "POST", createOnly, {
      customerId: customer.id, partNumber: "PX3", eachWeight: 1, pricePer: "EACH",
    }), noParams);
    expect(pricePerOnly.status).toBe(403);
  });

  it("PATCH /api/parts/[id] pricing fields likewise; plain edits pass with parts.edit alone", async () => {
    const { partId } = await partFixture();
    expect((await patchPart(
      bodyReq(`http://t/api/parts/${partId}`, "PATCH", undefined, { name: "x" }), withParams({ id: partId }))).status).toBe(401);

    const editOnly = await signInWith(["parts.edit"], "edit-only-1");

    const plain = await patchPart(
      bodyReq(`http://t/api/parts/${partId}`, "PATCH", editOnly, { name: "Renamed" }), withParams({ id: partId }));
    expect(plain.status).toBe(200);

    const denied = await patchPart(
      bodyReq(`http://t/api/parts/${partId}`, "PATCH", editOnly, { unitPrice: null }), withParams({ id: partId }));
    expect(denied.status).toBe(403);

    const editPrice = await signInWith(["parts.edit", "action.change_prices"], "edit-price-1");
    const allowed = await patchPart(
      bodyReq(`http://t/api/parts/${partId}`, "PATCH", editPrice, { unitPrice: null }), withParams({ id: partId }));
    expect(allowed.status).toBe(200);
  });

  it("PATCH /api/parts/[id] rejects an empty body with 400 rather than a no-op 200", async () => {
    const { partId } = await partFixture();
    const editor = await signInWith(["parts.edit"], "empty-patch-1");
    const res = await patchPart(
      bodyReq(`http://t/api/parts/${partId}`, "PATCH", editor, {}), withParams({ id: partId }));
    expect(res.status).toBe(400);
  });

  // F8: a JSON body that parses to something other than a plain record (null, a bare string, a
  // bare number, an array) used to reach Object.keys/`in` before any shape check, throwing a raw
  // TypeError that escaped handle()'s ZodError/HttpError mapping and surfaced as an unhandled 500
  // rather than a clean 400.
  it("PATCH /api/parts/[id] with a non-object JSON body is 400, not 500", async () => {
    const { partId } = await partFixture();
    const editor = await signInWith(["parts.edit"], "non-object-patch-1");
    const res = await patchPart(
      bodyReq(`http://t/api/parts/${partId}`, "PATCH", editor, null), withParams({ id: partId }));
    expect(res.status).toBe(400);
  });

  it("DELETE /api/parts/[id] requires parts.delete and passes reason from the body", async () => {
    const { partId } = await partFixture();
    expect((await deletePartRoute(
      noBodyReq(`http://t/api/parts/${partId}`, "DELETE"), withParams({ id: partId }))).status).toBe(401);

    const noPerm = await signInWith(["parts.view"], "no-delete-1");
    expect((await deletePartRoute(
      noBodyReq(`http://t/api/parts/${partId}`, "DELETE", noPerm), withParams({ id: partId }))).status).toBe(403);

    const deleter = await signInWith(["parts.delete"], "deleter-1");
    const noReason = await deletePartRoute(
      noBodyReq(`http://t/api/parts/${partId}`, "DELETE", deleter), withParams({ id: partId }));
    expect(noReason.status).toBe(400);

    const ok = await deletePartRoute(
      bodyReq(`http://t/api/parts/${partId}`, "DELETE", deleter, { reason: "keyed wrong" }), withParams({ id: partId }));
    expect(ok.status).toBe(200);

    const row = await prisma.part.findFirst({ where: { id: partId } });
    expect(row!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({ where: { entity: "part", entityId: partId, action: "delete" } });
    expect(entry?.reason).toBe("keyed wrong");
  });

  // G2: `(await req.json().catch(() => ({}))) as { reason?: unknown }` threw a raw TypeError
  // reading `.reason` off a JSON body of `null` (a body of `{}` or a string/number doesn't crash,
  // but `null.reason` does), escaping handle()'s error mapping as an unhandled 500 instead of the
  // service's own missing-reason 400.
  it("DELETE /api/parts/[id] with a JSON null body is 400, not 500", async () => {
    const { partId } = await partFixture();
    const deleter = await signInWith(["parts.delete"], "deleter-null-1");
    const res = await deletePartRoute(
      bodyReq(`http://t/api/parts/${partId}`, "DELETE", deleter, null), withParams({ id: partId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason/i);
  });

  it("GET /api/parts/[id] requires parts.view", async () => {
    const { partId } = await partFixture();
    expect((await getPartRoute(getReq(`http://t/api/parts/${partId}`), withParams({ id: partId }))).status).toBe(401);
    const wrong = await signInWith(["customers.view"], "wrong-2");
    expect((await getPartRoute(getReq(`http://t/api/parts/${partId}`, wrong), withParams({ id: partId }))).status).toBe(403);
    const viewer = await signInWith(["parts.view"], "viewer-2");
    expect((await getPartRoute(getReq(`http://t/api/parts/${partId}`, viewer), withParams({ id: partId }))).status).toBe(200);
  });

  it("specifications routes gate on parts.view / parts.edit and scope to the part", async () => {
    const { partId } = await partFixture();
    const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
    const editor = await signInWith(["parts.view", "parts.edit"], "spec-editor-1");

    expect((await listSpecs(getReq(`http://t/api/parts/${partId}/specifications`), withParams({ id: partId }))).status).toBe(401);
    expect((await addSpecRoute(
      bodyReq(`http://t/api/parts/${partId}/specifications`, "POST", undefined, { specificationId: spec.id }),
      withParams({ id: partId }))).status).toBe(401);
    expect((await removeSpecRoute(
      noBodyReq(`http://t/api/parts/${partId}/specifications/x`, "DELETE"),
      withParams({ id: partId, linkId: "x" }))).status).toBe(401);

    const wrong = await signInWith(["customers.view"], "wrong-3");
    expect((await addSpecRoute(
      bodyReq(`http://t/api/parts/${partId}/specifications`, "POST", wrong, { specificationId: spec.id }),
      withParams({ id: partId }))).status).toBe(403);

    const added = await addSpecRoute(
      bodyReq(`http://t/api/parts/${partId}/specifications`, "POST", editor, { specificationId: spec.id }),
      withParams({ id: partId }));
    expect(added.status).toBe(200);
    const { id: linkId } = await added.json();

    const listed = await listSpecs(getReq(`http://t/api/parts/${partId}/specifications`, editor), withParams({ id: partId }));
    expect((await listed.json())).toHaveLength(1);

    const removed = await removeSpecRoute(
      noBodyReq(`http://t/api/parts/${partId}/specifications/${linkId}`, "DELETE", editor),
      withParams({ id: partId, linkId }));
    expect(removed.status).toBe(200);
  });

  it("inspections routes gate on parts.view / parts.edit", async () => {
    const { partId } = await partFixture();
    const code = await prisma.inspectionCode.create({ data: { name: "Brinell" } });
    const editor = await signInWith(["parts.view", "parts.edit"], "insp-editor-1");

    expect((await listInspections(getReq(`http://t/api/parts/${partId}/inspections`), withParams({ id: partId }))).status).toBe(401);
    expect((await addInspectionRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections`, "POST", undefined, { inspectionCodeId: code.id, sort: 0 }),
      withParams({ id: partId }))).status).toBe(401);
    expect((await patchInspectionRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections/x`, "PATCH", undefined, { location: "x" }),
      withParams({ id: partId, inspId: "x" }))).status).toBe(401);
    expect((await deleteInspectionRoute(
      noBodyReq(`http://t/api/parts/${partId}/inspections/x`, "DELETE"),
      withParams({ id: partId, inspId: "x" }))).status).toBe(401);

    const wrong = await signInWith(["customers.view"], "wrong-4");
    expect((await addInspectionRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections`, "POST", wrong, { inspectionCodeId: code.id, sort: 0 }),
      withParams({ id: partId }))).status).toBe(403);

    const added = await addInspectionRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections`, "POST", editor, { inspectionCodeId: code.id, sort: 0 }),
      withParams({ id: partId }));
    expect(added.status).toBe(200);
    const { id: inspId } = await added.json();

    const patched = await patchInspectionRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections/${inspId}`, "PATCH", editor, { location: "hub" }),
      withParams({ id: partId, inspId }));
    expect(patched.status).toBe(200);

    const deleted = await deleteInspectionRoute(
      noBodyReq(`http://t/api/parts/${partId}/inspections/${inspId}`, "DELETE", editor),
      withParams({ id: partId, inspId }));
    expect(deleted.status).toBe(200);
  });

  // G1: the UI used to reorder by two sequential PATCHes swapping a pair of `sort` values — if
  // the second failed, both rows kept the SAME sort and listPartInspections (sort-only ordering)
  // rendered nondeterministically, with no way to "swap back" out of a tie. PUT .../order applies
  // the whole new order in one Serializable transaction instead.
  it("PUT /api/parts/[id]/inspections/order gates on parts.edit and reorders atomically", async () => {
    const { partId } = await partFixture();
    const code = await prisma.inspectionCode.create({ data: { name: "Brinell" } });
    const editor = await signInWith(["parts.view", "parts.edit"], "reorder-editor-1");

    const addRow = (loc: string) => addInspectionRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections`, "POST", editor,
        { inspectionCodeId: code.id, sort: 0, location: loc }),
      withParams({ id: partId }));
    const a = await (await addRow("a")).json();
    const b = await (await addRow("b")).json();
    const c = await (await addRow("c")).json();

    expect((await reorderInspectionsRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections/order`, "PUT", undefined, { orderedIds: [c.id, a.id, b.id] }),
      withParams({ id: partId }))).status).toBe(401);

    const wrong = await signInWith(["customers.view"], "reorder-wrong-1");
    expect((await reorderInspectionsRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections/order`, "PUT", wrong, { orderedIds: [c.id, a.id, b.id] }),
      withParams({ id: partId }))).status).toBe(403);

    const ok = await reorderInspectionsRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections/order`, "PUT", editor, { orderedIds: [c.id, a.id, b.id] }),
      withParams({ id: partId }));
    expect(ok.status).toBe(200);

    const rows = await listInspections(getReq(`http://t/api/parts/${partId}/inspections`, editor), withParams({ id: partId }));
    expect((await rows.json()).map((r: { id: string }) => r.id)).toEqual([c.id, a.id, b.id]);

    // Missing/duplicate/extra id all 400 with the field-anchored message.
    const missing = await reorderInspectionsRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections/order`, "PUT", editor, { orderedIds: [a.id, b.id] }),
      withParams({ id: partId }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/exactly once/);

    const duplicate = await reorderInspectionsRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections/order`, "PUT", editor, { orderedIds: [a.id, a.id, b.id] }),
      withParams({ id: partId }));
    expect(duplicate.status).toBe(400);

    const extra = await reorderInspectionsRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections/order`, "PUT", editor,
        { orderedIds: [a.id, b.id, c.id, "not-a-real-id"] }),
      withParams({ id: partId }));
    expect(extra.status).toBe(400);

    // An empty orderedIds array fails the route's own zod .min(1) — a 400 before the service
    // ever runs.
    const empty = await reorderInspectionsRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections/order`, "PUT", editor, { orderedIds: [] }),
      withParams({ id: partId }));
    expect(empty.status).toBe(400);
  });

  it("PUT .../inspections/order: part B's URL with part A's row ids is the set check's 400, not a 404", async () => {
    const { partId, otherPartId } = await partFixture();
    const code = await prisma.inspectionCode.create({ data: { name: "Brinell" } });
    const editor = await signInWith(["parts.view", "parts.edit"], "reorder-cross-1");
    const added = await addInspectionRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections`, "POST", editor, { inspectionCodeId: code.id, sort: 0 }),
      withParams({ id: partId }));
    const { id: inspId } = await added.json();

    const res = await reorderInspectionsRoute(
      bodyReq(`http://t/api/parts/${otherPartId}/inspections/order`, "PUT", editor, { orderedIds: [inspId] }),
      withParams({ id: otherPartId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exactly once/);
  });

  it("break routes demand change_prices unconditionally", async () => {
    const { partId } = await partFixture();
    expect((await listBreaks(getReq(`http://t/api/parts/${partId}/breaks`), withParams({ id: partId }))).status).toBe(401);
    expect((await addBreakRoute(
      bodyReq(`http://t/api/parts/${partId}/breaks`, "POST", undefined, { threshold: 500, price: "0.95" }),
      withParams({ id: partId }))).status).toBe(401);
    expect((await patchBreakRoute(
      bodyReq(`http://t/api/parts/${partId}/breaks/x`, "PATCH", undefined, { price: "1.00" }),
      withParams({ id: partId, breakId: "x" }))).status).toBe(401);
    expect((await deleteBreakRoute(
      noBodyReq(`http://t/api/parts/${partId}/breaks/x`, "DELETE"),
      withParams({ id: partId, breakId: "x" }))).status).toBe(401);

    const editOnly = await signInWith(["parts.view", "parts.edit"], "break-editor-1");
    const editPrice = await signInWith(["parts.view", "parts.edit", "action.change_prices"], "break-editor-price-1");

    expect((await listBreaks(getReq(`http://t/api/parts/${partId}/breaks`, editOnly), withParams({ id: partId }))).status).toBe(200);

    const deniedAdd = await addBreakRoute(
      bodyReq(`http://t/api/parts/${partId}/breaks`, "POST", editOnly, { threshold: 500, price: "0.95" }),
      withParams({ id: partId }));
    expect(deniedAdd.status).toBe(403);

    const added = await addBreakRoute(
      bodyReq(`http://t/api/parts/${partId}/breaks`, "POST", editPrice, { threshold: 500, price: "0.95" }),
      withParams({ id: partId }));
    expect(added.status).toBe(200);
    const { id: breakId } = await added.json();

    const deniedPatch = await patchBreakRoute(
      bodyReq(`http://t/api/parts/${partId}/breaks/${breakId}`, "PATCH", editOnly, { price: "1.00" }),
      withParams({ id: partId, breakId }));
    expect(deniedPatch.status).toBe(403);

    const patched = await patchBreakRoute(
      bodyReq(`http://t/api/parts/${partId}/breaks/${breakId}`, "PATCH", editPrice, { price: "1.00" }),
      withParams({ id: partId, breakId }));
    expect(patched.status).toBe(200);

    const deniedDelete = await deleteBreakRoute(
      noBodyReq(`http://t/api/parts/${partId}/breaks/${breakId}`, "DELETE", editOnly),
      withParams({ id: partId, breakId }));
    expect(deniedDelete.status).toBe(403);

    const deleted = await deleteBreakRoute(
      noBodyReq(`http://t/api/parts/${partId}/breaks/${breakId}`, "DELETE", editPrice),
      withParams({ id: partId, breakId }));
    expect(deleted.status).toBe(200);
  });

  it("child routes 404 a child of a different part", async () => {
    const { partId, otherPartId } = await partFixture();
    const code = await prisma.inspectionCode.create({ data: { name: "Brinell" } });
    const editor = await signInWith(["parts.view", "parts.edit"], "cross-editor-1");

    const added = await addInspectionRoute(
      bodyReq(`http://t/api/parts/${partId}/inspections`, "POST", editor, { inspectionCodeId: code.id, sort: 0 }),
      withParams({ id: partId }));
    const { id: inspId } = await added.json();

    // PATCH via the OTHER part's URL must 404, not succeed.
    const crossPatch = await patchInspectionRoute(
      bodyReq(`http://t/api/parts/${otherPartId}/inspections/${inspId}`, "PATCH", editor, { location: "x" }),
      withParams({ id: otherPartId, inspId }));
    expect(crossPatch.status).toBe(404);

    const crossDelete = await deleteInspectionRoute(
      noBodyReq(`http://t/api/parts/${otherPartId}/inspections/${inspId}`, "DELETE", editor),
      withParams({ id: otherPartId, inspId }));
    expect(crossDelete.status).toBe(404);

    // Still there under the real part.
    const rows = await listInspections(getReq(`http://t/api/parts/${partId}/inspections`, editor), withParams({ id: partId }));
    expect(await rows.json()).toHaveLength(1);
  });

  it("/api/parts/[id]/fields: GET lists values, PUT (parts.edit) sets them", async () => {
    const { partId } = await partFixture();
    const { id: fieldId } = await createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 });
    const viewer = await signInWith(["parts.view"], "fields-viewer-1");
    const editor = await signInWith(["parts.view", "parts.edit"], "fields-editor-1");

    expect((await getFieldsRoute(getReq(`http://t/api/parts/${partId}/fields`), withParams({ id: partId }))).status).toBe(401);
    expect((await putFieldsRoute(
      bodyReq(`http://t/api/parts/${partId}/fields`, "PUT", undefined, { values: [] }),
      withParams({ id: partId }))).status).toBe(401);
    const listed = await getFieldsRoute(getReq(`http://t/api/parts/${partId}/fields`, viewer), withParams({ id: partId }));
    expect(listed.status).toBe(200);

    const deniedPut = await putFieldsRoute(
      bodyReq(`http://t/api/parts/${partId}/fields`, "PUT", viewer, { values: [{ fieldId, value: "DWG-1" }] }),
      withParams({ id: partId }));
    expect(deniedPut.status).toBe(403);

    const put = await putFieldsRoute(
      bodyReq(`http://t/api/parts/${partId}/fields`, "PUT", editor, { values: [{ fieldId, value: "DWG-1" }] }),
      withParams({ id: partId }));
    expect(put.status).toBe(200);

    const rows = await listPartFieldValuesThroughRoute(partId, editor);
    expect(rows.find((r) => r.fieldId === fieldId)!.value).toBe("DWG-1");

    // Body shape is strict at the top level — an unknown top-level key is a 400.
    const badShape = await putFieldsRoute(
      bodyReq(`http://t/api/parts/${partId}/fields`, "PUT", editor, {
        values: [{ fieldId, value: "x" }], extra: true,
      }),
      withParams({ id: partId }));
    expect(badShape.status).toBe(400);
  });

  async function listPartFieldValuesThroughRoute(partId: string, cookie: string) {
    const res = await getFieldsRoute(getReq(`http://t/api/parts/${partId}/fields`, cookie), withParams({ id: partId }));
    return res.json() as Promise<{ fieldId: string; value: string }[]>;
  }

  it("/api/admin/part-fields CRUD gates on admin area actions (create/edit/delete per method)", async () => {
    expect((await listFieldDefs(getReq("http://t/api/admin/part-fields"), noParams)).status).toBe(401);
    expect((await createFieldDefRoute(
      bodyReq("http://t/api/admin/part-fields", "POST", undefined, { name: "x", type: "TEXT", sort: 0 }),
      noParams)).status).toBe(401);
    expect((await updateFieldDefRoute(
      bodyReq("http://t/api/admin/part-fields/x", "PUT", undefined, { sort: 1 }),
      withParams({ id: "x" }))).status).toBe(401);
    expect((await deleteFieldDefRoute(
      noBodyReq("http://t/api/admin/part-fields/x", "DELETE"),
      withParams({ id: "x" }))).status).toBe(401);

    const viewer = await signInWith(["admin.view"], "af-viewer-1");
    const wrong = await signInWith(["customers.view"], "wrong-5");
    expect((await listFieldDefs(getReq("http://t/api/admin/part-fields", wrong), noParams)).status).toBe(403);
    expect((await listFieldDefs(getReq("http://t/api/admin/part-fields", viewer), noParams)).status).toBe(200);

    const denyCreate = await createFieldDefRoute(
      bodyReq("http://t/api/admin/part-fields", "POST", viewer, { name: "Drawing #", type: "TEXT", sort: 0 }), noParams);
    expect(denyCreate.status).toBe(403);

    const creator = await signInWith(["admin.view", "admin.create"], "af-creator-1");
    const created = await createFieldDefRoute(
      bodyReq("http://t/api/admin/part-fields", "POST", creator, { name: "Drawing #", type: "TEXT", sort: 0 }), noParams);
    expect(created.status).toBe(200);
    const { id: fieldId } = await created.json();

    const denyEdit = await updateFieldDefRoute(
      bodyReq(`http://t/api/admin/part-fields/${fieldId}`, "PUT", viewer, { sort: 5 }), withParams({ id: fieldId }));
    expect(denyEdit.status).toBe(403);

    const editor = await signInWith(["admin.view", "admin.edit"], "af-editor-1");
    const edited = await updateFieldDefRoute(
      bodyReq(`http://t/api/admin/part-fields/${fieldId}`, "PUT", editor, { sort: 5 }), withParams({ id: fieldId }));
    expect(edited.status).toBe(200);

    const denyDelete = await deleteFieldDefRoute(
      noBodyReq(`http://t/api/admin/part-fields/${fieldId}`, "DELETE", viewer), withParams({ id: fieldId }));
    expect(denyDelete.status).toBe(403);

    const deleter = await signInWith(["admin.view", "admin.delete"], "af-deleter-1");
    const deleted = await deleteFieldDefRoute(
      noBodyReq(`http://t/api/admin/part-fields/${fieldId}`, "DELETE", deleter), withParams({ id: fieldId }));
    expect(deleted.status).toBe(200);
  });

  it("PUT /api/admin/part-fields/[id] rejects an empty body with 400 rather than a no-op 200", async () => {
    const { id: fieldId } = await createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 });
    const editor = await signInWith(["admin.view", "admin.edit"], "empty-patch-2");
    const res = await updateFieldDefRoute(
      bodyReq(`http://t/api/admin/part-fields/${fieldId}`, "PUT", editor, {}), withParams({ id: fieldId }));
    expect(res.status).toBe(400);
  });

  // F8: unlike the parts routes above, this route already guards `Object.keys(body ?? {})` (not
  // a bare `Object.keys(body)`), so `null` collapses to `{}` before the empty-body check runs,
  // and an empty array's Object.keys is also length 0 — both already 400 via the same
  // "must include at least one change" path rather than crashing. This test pins that existing,
  // already-correct behavior; it was NOT changed by the F8 pass (see report).
  it("PUT /api/admin/part-fields/[id] with a non-object JSON body is 400, not 500", async () => {
    const { id: fieldId } = await createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 });
    const editor = await signInWith(["admin.view", "admin.edit"], "non-object-patch-1");
    const nullRes = await updateFieldDefRoute(
      bodyReq(`http://t/api/admin/part-fields/${fieldId}`, "PUT", editor, null), withParams({ id: fieldId }));
    expect(nullRes.status).toBe(400);
    const arrRes = await updateFieldDefRoute(
      bodyReq(`http://t/api/admin/part-fields/${fieldId}`, "PUT", editor, []), withParams({ id: fieldId }));
    expect(arrRes.status).toBe(400);
  });

  it("blockers export returns an xlsx content-type and disposition", async () => {
    const { partId } = await partFixture();
    const { id: fieldId } = await createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 });
    await setPartFieldValues(partId, [{ fieldId, value: "DWG-100" }]);

    expect((await fieldDefBlockersRoute(getReq(`http://t/api/admin/part-fields/${fieldId}/blockers`), withParams({ id: fieldId }))).status).toBe(401);
    expect((await fieldDefBlockersExportRoute(
      getReq(`http://t/api/admin/part-fields/${fieldId}/blockers/export`), withParams({ id: fieldId }))).status).toBe(401);

    const viewer = await signInWith(["admin.view"], "af-blockers-viewer-1");
    const blockers = await fieldDefBlockersRoute(
      getReq(`http://t/api/admin/part-fields/${fieldId}/blockers`, viewer), withParams({ id: fieldId }));
    expect(blockers.status).toBe(200);
    const blockerBody = await blockers.json();
    expect(blockerBody).toEqual([{ entityLabel: "Part", name: "ACME · 12345", id: partId, href: `/parts/${partId}` }]);

    const wrong = await signInWith(["customers.view"], "wrong-6");
    expect((await fieldDefBlockersRoute(
      getReq(`http://t/api/admin/part-fields/${fieldId}/blockers`, wrong), withParams({ id: fieldId }))).status).toBe(403);
    expect((await fieldDefBlockersExportRoute(
      getReq(`http://t/api/admin/part-fields/${fieldId}/blockers/export`, wrong), withParams({ id: fieldId }))).status).toBe(403);

    const exportRes = await fieldDefBlockersExportRoute(
      getReq(`http://t/api/admin/part-fields/${fieldId}/blockers/export`, viewer), withParams({ id: fieldId }));
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(exportRes.headers.get("content-disposition")).toContain("attachment");
    expect(exportRes.headers.get("content-disposition")).toContain(".xlsx");
  });
});
