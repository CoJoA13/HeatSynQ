import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateId } from "./helpers/db";
import { signInWith } from "./helpers/auth";

import { GET as listRoute, POST as createRoute } from "@/app/api/templates/route";
import { GET as detailRoute, PATCH as renameRoute, DELETE as deleteRoute } from "@/app/api/templates/[id]/route";
import {
  POST as openDraftRoute, PATCH as editDraftRoute, DELETE as discardDraftRoute,
} from "@/app/api/templates/[id]/draft/route";
import { POST as publishRoute } from "@/app/api/templates/[id]/publish/route";
import { POST as defaultRoute } from "@/app/api/templates/[id]/default/route";
import { POST as uploadLogoRoute, DELETE as clearLogoRoute } from "@/app/api/templates/[id]/logo/route";
import { GET as blockersExportRoute } from "@/app/api/templates/[id]/blockers/export/route";
import { GET as versionRoute } from "@/app/api/templates/[id]/versions/[versionNumber]/route";

/** Phase 7 Task 4 — the template routes: thin handlers, templates-area gates, and the
 *  `edit_templates` special (`mustDo`) on the two acts that change what future paper looks like
 *  (publish, set-default — spec §7; assignment is Task 5's). */

const STANDARD_TRAVELER = templateId("TRAVELER");

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
/** The attachments.test.ts/user-signature.test.ts multipart helper: a real FormData body so the
 *  route's own `req.formData()` runs end to end; content-length set by hand (undici's `new
 *  Request` doesn't compute it, and `parseUploadFile` refuses an undeclared size). */
function uploadReq(
  url: string, method: string, cookie: string | undefined,
  filename: string, mimeType: string, bytes: Uint8Array<ArrayBuffer>,
): Request {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mimeType }), filename);
  const headers: Record<string, string> = {
    ...(cookie ? { cookie } : {}), "content-length": String(bytes.byteLength + 1024),
  };
  return new Request(url, { method, headers, body: form });
}

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");
const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
const asBody = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);

let admin: string;        // full templates CRUD + the edit_templates special
let viewer: string;       // templates.view only
let editorNoSpecial: string; // templates.view + edit, WITHOUT action.edit_templates

beforeEach(async () => {
  await truncateAll();
  admin = await signInWith(
    ["templates.view", "templates.create", "templates.edit", "templates.delete", "action.edit_templates"],
    "tadmin");
  viewer = await signInWith(["templates.view"], "tviewer");
  editorNoSpecial = await signInWith(["templates.view", "templates.edit"], "teditor");
});

describe("GET/POST /api/templates", () => {
  it("lists the 8 seeded Standard templates for templates.view; filters by docType", async () => {
    const res = await listRoute(getReq("http://t/api/templates", viewer), withParams({}));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(8);
    const filtered = await listRoute(getReq("http://t/api/templates?docType=TRAVELER", viewer), withParams({}));
    expect(await filtered.json()).toHaveLength(1);
    const bad = await listRoute(getReq("http://t/api/templates?docType=NOPE", viewer), withParams({}));
    expect(bad.status).toBe(400);
  });

  it("gates: 401 signed out, 403 without templates.view / templates.create", async () => {
    expect((await listRoute(getReq("http://t/api/templates"), withParams({}))).status).toBe(401);
    const none = await signInWith([], "tnone");
    expect((await listRoute(getReq("http://t/api/templates", none), withParams({}))).status).toBe(403);
    const create = await createRoute(
      bodyReq("http://t/api/templates", "POST", viewer, { docType: "TRAVELER", name: "Nope" }), withParams({}));
    expect(create.status).toBe(403);
  });

  it("creates a template with its v1 draft; refuses unknown keys and bad docTypes (.strict())", async () => {
    const res = await createRoute(
      bodyReq("http://t/api/templates", "POST", admin, { docType: "TRAVELER", name: "Skinny" }), withParams({}));
    expect(res.status).toBe(200);
    const { id, draft } = await res.json();
    expect(draft.versionNumber).toBe(1);
    const row = await prisma.documentTemplate.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe("Skinny");
    expect((await createRoute(
      bodyReq("http://t/api/templates", "POST", admin, { docType: "POSTER", name: "X" }),
      withParams({}))).status).toBe(400);
    expect((await createRoute(
      bodyReq("http://t/api/templates", "POST", admin, { docType: "TRAVELER", name: "X", extra: 1 }),
      withParams({}))).status).toBe(400);
  });
});

describe("GET/PATCH/DELETE /api/templates/[id]", () => {
  it("detail carries the draft config but a config-free history; 404 for unknown ids", async () => {
    await openDraftRoute(noBodyReq("http://t/x/draft", "POST", editorNoSpecial),
      withParams({ id: STANDARD_TRAVELER }));
    const res = await detailRoute(getReq("http://t/x", viewer), withParams({ id: STANDARD_TRAVELER }));
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.publishedVersionNumber).toBe(1);
    expect(detail.draft.versionNumber).toBe(2);
    expect(detail.draft.config).toBeTruthy();
    expect(detail.versions).toHaveLength(2);
    for (const v of detail.versions) expect(v).not.toHaveProperty("config");
    expect((await detailRoute(getReq("http://t/x", viewer), withParams({ id: "nope" }))).status).toBe(404);
  });

  it("renames with templates.edit (403 for a viewer); deletes with templates.delete only", async () => {
    expect((await renameRoute(
      bodyReq("http://t/x", "PATCH", viewer, { name: "New Name" }),
      withParams({ id: STANDARD_TRAVELER }))).status).toBe(403);
    const renamed = await renameRoute(
      bodyReq("http://t/x", "PATCH", editorNoSpecial, { name: "House Style" }),
      withParams({ id: STANDARD_TRAVELER }));
    expect(renamed.status).toBe(200);

    // Delete: a non-default template, admin only, reason required.
    const created = await (await createRoute(
      bodyReq("http://t/api/templates", "POST", admin, { docType: "TRAVELER", name: "Doomed" }),
      withParams({}))).json();
    await publishRoute(noBodyReq("http://t/x/publish", "POST", admin), withParams({ id: created.id }));
    expect((await deleteRoute(
      bodyReq("http://t/x", "DELETE", editorNoSpecial, { reason: "cleanup" }),
      withParams({ id: created.id }))).status).toBe(403);
    expect((await deleteRoute(
      bodyReq("http://t/x", "DELETE", admin, {}), withParams({ id: created.id }))).status).toBe(400);
    const deleted = await deleteRoute(
      bodyReq("http://t/x", "DELETE", admin, { reason: "cleanup" }), withParams({ id: created.id }));
    expect(deleted.status).toBe(200);
  });
});

describe("POST/PATCH/DELETE /api/templates/[id]/draft", () => {
  it("opens, edits (updatedAt precondition over the wire), and discards a draft with templates.edit", async () => {
    expect((await openDraftRoute(noBodyReq("http://t/x/draft", "POST", viewer),
      withParams({ id: STANDARD_TRAVELER }))).status).toBe(403);

    const opened = await openDraftRoute(noBodyReq("http://t/x/draft", "POST", editorNoSpecial),
      withParams({ id: STANDARD_TRAVELER }));
    expect(opened.status).toBe(200);
    const draft = await opened.json();
    expect(draft.versionNumber).toBe(2);

    const config = { ...draft.config, fonts: { ...draft.config.fonts, baseSize: 10 } };
    const edited = await editDraftRoute(
      bodyReq("http://t/x/draft", "PATCH", editorNoSpecial, { config, updatedAt: draft.updatedAt }),
      withParams({ id: STANDARD_TRAVELER }));
    expect(edited.status).toBe(200);
    const { updatedAt } = await edited.json();
    expect(updatedAt).not.toBe(draft.updatedAt);

    // The stale editor: the ORIGINAL updatedAt now earns the named 409.
    const stale = await editDraftRoute(
      bodyReq("http://t/x/draft", "PATCH", editorNoSpecial, { config, updatedAt: draft.updatedAt }),
      withParams({ id: STANDARD_TRAVELER }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatch(/changed since you loaded it/);

    const discarded = await discardDraftRoute(noBodyReq("http://t/x/draft", "DELETE", editorNoSpecial),
      withParams({ id: STANDARD_TRAVELER }));
    expect(discarded.status).toBe(200);
  });

  it("accepts the §5.1 revert flow's fromVersion and refuses unknown body keys", async () => {
    const opened = await openDraftRoute(
      bodyReq("http://t/x/draft", "POST", editorNoSpecial, { fromVersion: 1 }),
      withParams({ id: STANDARD_TRAVELER }));
    expect(opened.status).toBe(200);
    expect((await opened.json()).versionNumber).toBe(2);
    expect((await openDraftRoute(
      bodyReq("http://t/x/draft", "POST", editorNoSpecial, { fromVersion: 1, extra: true }),
      withParams({ id: STANDARD_TRAVELER }))).status).toBe(400);
  });
});

describe("POST /api/templates/[id]/publish and /default — the edit_templates special (mustDo)", () => {
  it("publish: 403 with templates.edit alone; 200 with the special; the pointer moves", async () => {
    await openDraftRoute(noBodyReq("http://t/x/draft", "POST", editorNoSpecial),
      withParams({ id: STANDARD_TRAVELER }));
    expect((await publishRoute(noBodyReq("http://t/x/publish", "POST", editorNoSpecial),
      withParams({ id: STANDARD_TRAVELER }))).status).toBe(403);
    const res = await publishRoute(noBodyReq("http://t/x/publish", "POST", admin),
      withParams({ id: STANDARD_TRAVELER }));
    expect(res.status).toBe(200);
    expect((await res.json()).versionNumber).toBe(2);
    const detail = await (await detailRoute(getReq("http://t/x", viewer),
      withParams({ id: STANDARD_TRAVELER }))).json();
    expect(detail.publishedVersionNumber).toBe(2);
    expect(detail.draft).toBeNull();
  });

  it("default: same gating; refuses a never-published template with the named 400", async () => {
    const created = await (await createRoute(
      bodyReq("http://t/api/templates", "POST", admin, { docType: "TRAVELER", name: "Second" }),
      withParams({}))).json();
    expect((await defaultRoute(noBodyReq("http://t/x/default", "POST", editorNoSpecial),
      withParams({ id: created.id }))).status).toBe(403);
    const refused = await defaultRoute(noBodyReq("http://t/x/default", "POST", admin),
      withParams({ id: created.id }));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/never been published/);
    await publishRoute(noBodyReq("http://t/x/publish", "POST", admin), withParams({ id: created.id }));
    expect((await defaultRoute(noBodyReq("http://t/x/default", "POST", admin),
      withParams({ id: created.id }))).status).toBe(200);
    const rows = await prisma.documentTemplate.findMany({
      where: { docType: "TRAVELER", deletedAt: null, isDefault: true }, select: { id: true },
    });
    expect(rows.map((r) => r.id)).toEqual([created.id]);
  });
});

describe("POST/DELETE /api/templates/[id]/logo", () => {
  it("uploads a sniffed logo onto the draft and clears it; 403 for a viewer; #49 lies refused", async () => {
    await openDraftRoute(noBodyReq("http://t/x/draft", "POST", editorNoSpecial),
      withParams({ id: STANDARD_TRAVELER }));
    expect((await uploadLogoRoute(
      uploadReq("http://t/x/logo", "POST", viewer, "logo.png", "image/png", asBody(REAL_PNG)),
      withParams({ id: STANDARD_TRAVELER }))).status).toBe(403);
    const ok = await uploadLogoRoute(
      uploadReq("http://t/x/logo", "POST", editorNoSpecial, "logo.png", "image/png", asBody(REAL_PNG)),
      withParams({ id: STANDARD_TRAVELER }));
    expect(ok.status).toBe(200);
    const lied = await uploadLogoRoute(
      uploadReq("http://t/x/logo", "POST", editorNoSpecial, "logo.png", "image/png", asBody(JPEG_PREFIX)),
      withParams({ id: STANDARD_TRAVELER }));
    expect(lied.status).toBe(400);
    expect((await lied.json()).error).toMatch(/not a valid image\/png/);
    expect((await clearLogoRoute(noBodyReq("http://t/x/logo", "DELETE", editorNoSpecial),
      withParams({ id: STANDARD_TRAVELER }))).status).toBe(200);
    const draft = await prisma.documentTemplateVersion.findFirstOrThrow({
      where: { templateId: STANDARD_TRAVELER, status: "DRAFT" },
      select: { logoImage: true, logoMimeType: true },
    });
    expect(draft.logoImage).toBeNull();
    expect(draft.logoMimeType).toBeNull();
  });
});

describe("GET /api/templates/[id]/blockers/export and /versions/[versionNumber]", () => {
  it("streams the §5.14 blocker workbook for templates.view", async () => {
    const acme = await prisma.customer.create({ data: { code: "AC1", name: "Acme" } });
    await prisma.customerTemplateAssignment.create({
      data: { customerId: acme.id, docType: "TRAVELER", templateId: STANDARD_TRAVELER },
    });
    const res = await blockersExportRoute(getReq("http://t/x/blockers/export", viewer),
      withParams({ id: STANDARD_TRAVELER }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toContain("Blockers.xlsx");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const none = await signInWith([], "tnone2");
    expect((await blockersExportRoute(getReq("http://t/x/blockers/export", none),
      withParams({ id: STANDARD_TRAVELER }))).status).toBe(403);
  });

  it("a version-detail read returns that one version's config", async () => {
    const res = await versionRoute(getReq("http://t/x/versions/1", viewer),
      withParams({ id: STANDARD_TRAVELER, versionNumber: "1" }));
    expect(res.status).toBe(200);
    const version = await res.json();
    expect(version.status).toBe("PUBLISHED");
    expect(version.config.sections.length).toBeGreaterThan(0);
    expect((await versionRoute(getReq("http://t/x/versions/9", viewer),
      withParams({ id: STANDARD_TRAVELER, versionNumber: "9" }))).status).toBe(404);
    expect((await versionRoute(getReq("http://t/x/versions/x", viewer),
      withParams({ id: STANDARD_TRAVELER, versionNumber: "x" }))).status).toBe(400);
  });
});
