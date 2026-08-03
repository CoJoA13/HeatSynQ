import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createPart, deletePart } from "@/server/parts";
import { createOrder, voidOrder } from "@/server/orders";
import {
  listAttachments, getAttachment, addAttachment, deleteAttachment, contentDisposition, type AttachmentOwner,
} from "@/server/attachments";

import { GET as listPartAttachmentsRoute, POST as addPartAttachmentRoute } from "@/app/api/parts/[id]/attachments/route";
import {
  GET as getPartAttachmentRoute, DELETE as deletePartAttachmentRoute,
} from "@/app/api/parts/[id]/attachments/[attId]/route";
import { GET as listOrderAttachmentsRoute, POST as addOrderAttachmentRoute } from "@/app/api/orders/[id]/attachments/route";
import {
  GET as getOrderAttachmentRoute, DELETE as deleteOrderAttachmentRoute,
} from "@/app/api/orders/[id]/attachments/[attId]/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function noBodyReq(url: string, method: string, cookie?: string): Request {
  return new Request(url, { method, headers: cookie ? { cookie } : {} });
}
/** Builds a real multipart body via the platform's own FormData/Blob — the same shape a browser's
 *  `<input type=file>` submission or `fetch(url, { body: formData })` produces, so the route's own
 *  `req.formData()` call is exercised end to end rather than mocked. */
function uploadReq(
  url: string, cookie: string | undefined, filename: string, mimeType: string, bytes: Uint8Array<ArrayBuffer>,
): Request {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mimeType }), filename);
  return new Request(url, { method: "POST", headers: cookie ? { cookie } : {}, body: form });
}

/** One live customer + part — the plain "part" owner fixture. `suffix` disambiguates codes/part
 *  numbers so this can be called more than once in the same test (a second, distinct part) —
 *  every code below is on a partial-unique index scoped to live rows, so a repeat within one test
 *  (no truncateAll between them) would otherwise collide. */
async function partOwnerFixture(suffix = ""): Promise<string> {
  const customer = await prisma.customer.create({ data: { code: `ACME${suffix}`, name: "Acme Foundry" } });
  const { id } = await asSystem(() => createPart({
    customerId: customer.id, partNumber: `12345${suffix}`, eachWeight: 1,
  }));
  return id;
}

/** One live customer + a lead part carrying a process revision/step (createOrder's orderability
 *  precondition, spec §5.3 — the order-routes.test.ts `giveSteps` precedent) + a one-line order.
 *  `suffix` disambiguates codes the same way partOwnerFixture's does, for the same reason. */
async function orderOwnerFixture(suffix = ""): Promise<string> {
  const customer = await prisma.customer.create({ data: { code: `BETA${suffix}`, name: "Beta Co" } });
  const code = await prisma.processStepCode.create({ data: { code: `HT-01${suffix}`, name: "Austenitize" } });
  const lead = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `3541720C3${suffix}`, name: "Ring gear", eachWeight: "13.5000" },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: lead.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: lead.id, qty: 10, weight: "135.00" }],
  }));
  return order.id;
}

describe("attachments service — one implementation, two owners", () => {
  beforeEach(truncateAll);

  it("round-trips add/list/get/delete for both owners through one loop", async () => {
    for (const owner of ["part", "order"] as const) {
      const ownerId = owner === "part" ? await partOwnerFixture() : await orderOwnerFixture();
      const bytes = Buffer.from(`hello ${owner} attachment`);

      const added = await asSystem(() => addAttachment(owner, ownerId, {
        filename: "drawing.png", mimeType: "image/png", data: bytes,
      }));
      expect(added.filename).toBe("drawing.png");
      expect(added.mimeType).toBe("image/png");
      expect(added.size).toBe(bytes.byteLength);
      expect(added).not.toHaveProperty("fileData");

      const listed = await listAttachments(owner, ownerId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: added.id, filename: "drawing.png", size: bytes.byteLength });
      expect(listed[0]).not.toHaveProperty("fileData");

      const got = await getAttachment(owner, ownerId, added.id);
      expect(Buffer.isBuffer(got.fileData)).toBe(true);
      expect(got.fileData.equals(bytes)).toBe(true);

      // Lands in the right table — never the other owner's.
      const rawOwn = owner === "part"
        ? await prisma.partAttachment.findUnique({ where: { id: added.id } })
        : await prisma.orderAttachment.findUnique({ where: { id: added.id } });
      expect(rawOwn).not.toBeNull();
      const rawOther = owner === "part"
        ? await prisma.orderAttachment.findUnique({ where: { id: added.id } })
        : await prisma.partAttachment.findUnique({ where: { id: added.id } });
      expect(rawOther).toBeNull();

      await asSystem(() => deleteAttachment(owner, ownerId, added.id));
      expect(await listAttachments(owner, ownerId)).toHaveLength(0);
      await expect(getAttachment(owner, ownerId, added.id)).rejects.toThrow("Attachment not found");
    }
  });

  it("rejects a file over the 20 MB cap, naming the limit", async () => {
    const partId = await partOwnerFixture();
    const tooBig = Buffer.alloc(20 * 1024 * 1024 + 1);
    await expect(asSystem(() => addAttachment("part", partId, {
      filename: "huge.png", mimeType: "image/png", data: tooBig,
    }))).rejects.toThrow("20 MB");
  });

  it("allows exactly the 20 MB cap", async () => {
    const partId = await partOwnerFixture();
    const exact = Buffer.alloc(20 * 1024 * 1024);
    const added = await asSystem(() => addAttachment("part", partId, {
      filename: "exact.png", mimeType: "image/png", data: exact,
    }));
    expect(added.size).toBe(exact.byteLength);
  });

  it("rejects a MIME type outside the allowlist", async () => {
    const partId = await partOwnerFixture();
    await expect(asSystem(() => addAttachment("part", partId, {
      filename: "archive.zip", mimeType: "application/zip", data: Buffer.from("x"),
    }))).rejects.toThrow("That file type is not allowed");
  });

  it("accepts every allowlisted type", async () => {
    const partId = await partOwnerFixture();
    const types = [
      "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
      "text/plain", "text/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    for (const mimeType of types) {
      const added = await asSystem(() => addAttachment("part", partId, {
        filename: "f", mimeType, data: Buffer.from("ok"),
      }));
      expect(added.mimeType).toBe(mimeType);
    }
  });

  it("404s every operation once the owning part is soft-deleted", async () => {
    const partId = await partOwnerFixture();
    const { id: attId } = await asSystem(() => addAttachment("part", partId, {
      filename: "drawing.png", mimeType: "image/png", data: Buffer.from("x"),
    }));
    await asSystem(() => deletePart(partId, "test cleanup"));

    await expect(listAttachments("part", partId)).rejects.toThrow("Part not found");
    await expect(getAttachment("part", partId, attId)).rejects.toThrow("Part not found");
    await expect(asSystem(() => addAttachment("part", partId, {
      filename: "b.png", mimeType: "image/png", data: Buffer.from("y"),
    }))).rejects.toThrow("Part not found");
    await expect(asSystem(() => deleteAttachment("part", partId, attId))).rejects.toThrow("Part not found");
  });

  // Fix round 1: a voided order (deletedAt set, spec §5c) is NOT the same as a genuinely deleted
  // owner — orders.ts's `readDetail` deliberately keeps a voided order readable, and every
  // order-child mutator (addLine/replaceContainers/etc.) deliberately still blocks on it. This
  // pins the same split for attachments: reads survive a void, writes don't.
  it("a voided order keeps its attachments readable, but blocks new writes", async () => {
    const orderId = await orderOwnerFixture();
    const { id: attId } = await asSystem(() => addAttachment("order", orderId, {
      filename: "packing-slip.pdf", mimeType: "application/pdf", data: Buffer.from("pdf-bytes"),
    }));
    await asSystem(() => voidOrder(orderId, "wrong customer PO"));

    // Reads: unaffected by the void.
    const listed = await listAttachments("order", orderId);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(attId);
    const got = await getAttachment("order", orderId, attId);
    expect(got.fileData.equals(Buffer.from("pdf-bytes"))).toBe(true);

    // Writes: still live-only, exactly like every other order-child mutator.
    await expect(asSystem(() => addAttachment("order", orderId, {
      filename: "b.pdf", mimeType: "application/pdf", data: Buffer.from("y"),
    }))).rejects.toThrow("Order not found");
    await expect(asSystem(() => deleteAttachment("order", orderId, attId))).rejects.toThrow("Order not found");
  });

  it("cross-owner isolation: an order id can't reach a part's attachment", async () => {
    const partId = await partOwnerFixture();
    const orderId = await orderOwnerFixture();
    const { id: partAttId } = await asSystem(() => addAttachment("part", partId, {
      filename: "drawing.png", mimeType: "image/png", data: Buffer.from("x"),
    }));
    await expect(getAttachment("order", orderId, partAttId)).rejects.toThrow("Attachment not found");
  });

  // Same-KIND cross-owner isolation — two parts (or two orders), not two different kinds. This is
  // the scoping ownerFilter()'s `where` clause actually exists to enforce: the cross-kind test
  // above 404s purely because the two owner kinds are different Prisma tables (an id from one
  // never matches a row in the other), so it would still pass even if getAttachment/
  // deleteAttachment forgot to scope by ownerId at all. Mirrors parts-routes.test.ts's "child
  // routes 404 a child of a different part".
  it("same-kind cross-owner isolation: one part/order's id can't reach a sibling's attachment", async () => {
    for (const owner of ["part", "order"] as const) {
      const mine = owner === "part" ? await partOwnerFixture("-mine") : await orderOwnerFixture("-mine");
      const theirs = owner === "part" ? await partOwnerFixture("-theirs") : await orderOwnerFixture("-theirs");
      const { id: attId } = await asSystem(() => addAttachment(owner, mine, {
        filename: "drawing.png", mimeType: "image/png", data: Buffer.from("x"),
      }));

      await expect(getAttachment(owner, theirs, attId)).rejects.toThrow("Attachment not found");
      await expect(asSystem(() => deleteAttachment(owner, theirs, attId))).rejects.toThrow("Attachment not found");

      // Untouched under its real owner.
      expect(await listAttachments(owner, mine)).toHaveLength(1);
    }
  });

  it("audits filename/mimeType/size but never the file bytes", async () => {
    const partId = await partOwnerFixture();
    const marker = "TOTALLY-SECRET-BYTE-MARKER-XYZ";
    const { id: attId } = await asSystem(() => addAttachment("part", partId, {
      filename: "drawing.png", mimeType: "text/plain", data: Buffer.from(marker),
    }));
    await asSystem(() => deleteAttachment("part", partId, attId));

    const entries = await prisma.auditLog.findMany({
      where: { entity: "partAttachment", entityId: attId }, orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(entries.map((e) => e.action)).toEqual(["create", "delete"]);

    // The delete's "before" snapshot is a bare findUnique (audit.ts) that DOES pull the fileData
    // column — redact()'s "filedata" pattern (Task 1) is what keeps the marker out of what's
    // actually persisted, and this is the end-to-end proof it works for this new resource.
    for (const entry of entries) {
      const blob = JSON.stringify([entry.before, entry.after]);
      expect(blob).not.toContain(marker);
    }
    const created = entries[0].after as { filename: string; mimeType: string; size: number };
    expect(created.filename).toBe("drawing.png");
    expect(created.mimeType).toBe("text/plain");
    expect(created.size).toBe(Buffer.byteLength(marker));
  });

  it("Content-Disposition: inline for images/PDF, attachment otherwise, filename escaped", () => {
    expect(contentDisposition("image/png", "drawing.png")).toBe('inline; filename="drawing.png"');
    expect(contentDisposition("application/pdf", "cert.pdf")).toBe('inline; filename="cert.pdf"');
    expect(contentDisposition("text/csv", "data.csv")).toBe('attachment; filename="data.csv"');

    // Quote/backslash escaped for the quoted-string form — an unescaped quote in the filename
    // would otherwise terminate the parameter early and let the rest of the name (or worse, a
    // crafted suffix) read as new header syntax.
    expect(contentDisposition("text/plain", 'weird"name.txt')).toBe('attachment; filename="weird\\"name.txt"');
    expect(contentDisposition("text/plain", "a\\b.txt")).toBe('attachment; filename="a\\\\b.txt"');

    // CR/LF stripped — a filename is attacker-controlled input landing in a raw response header,
    // so this is the header-injection defense (a filename of `x\r\nSet-Cookie: evil=1` must not
    // be able to inject a second header).
    const injected = contentDisposition("text/plain", "name\r\nX-Injected: 1.txt");
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toBe('attachment; filename="nameX-Injected: 1.txt"');
  });
});

type RouteCfg = {
  owner: AttachmentOwner;
  area: "parts" | "orders";
  fixture: () => Promise<string>;
  path: (ownerId: string) => string;
  list: typeof listPartAttachmentsRoute;
  add: typeof addPartAttachmentRoute;
  get: typeof getPartAttachmentRoute;
  del: typeof deletePartAttachmentRoute;
};
const CONFIGS: RouteCfg[] = [
  {
    owner: "part", area: "parts", fixture: partOwnerFixture,
    path: (ownerId) => `http://t/api/parts/${ownerId}/attachments`,
    list: listPartAttachmentsRoute, add: addPartAttachmentRoute,
    get: getPartAttachmentRoute, del: deletePartAttachmentRoute,
  },
  {
    owner: "order", area: "orders", fixture: orderOwnerFixture,
    path: (ownerId) => `http://t/api/orders/${ownerId}/attachments`,
    list: listOrderAttachmentsRoute, add: addOrderAttachmentRoute,
    get: getOrderAttachmentRoute, del: deleteOrderAttachmentRoute,
  },
];

describe.each(CONFIGS)("$owner attachment routes", (cfg) => {
  beforeEach(truncateAll);

  it("gate on view/edit and round-trip one file end to end", async () => {
    const ownerId = await cfg.fixture();
    const base = cfg.path(ownerId);
    const bytes = new TextEncoder().encode("hello world");

    expect((await cfg.list(getReq(base), withParams({ id: ownerId }))).status).toBe(401);
    expect((await cfg.add(
      uploadReq(base, undefined, "a.png", "image/png", bytes), withParams({ id: ownerId }))).status).toBe(401);

    const wrong = await signInWith(["customers.view"], `wrong-${cfg.owner}-1`);
    expect((await cfg.list(getReq(base, wrong), withParams({ id: ownerId }))).status).toBe(403);
    expect((await cfg.add(
      uploadReq(base, wrong, "a.png", "image/png", bytes), withParams({ id: ownerId }))).status).toBe(403);

    const viewer = await signInWith([`${cfg.area}.view`], `viewer-${cfg.owner}-1`);
    expect((await cfg.list(getReq(base, viewer), withParams({ id: ownerId }))).status).toBe(200);
    expect((await cfg.add(
      uploadReq(base, viewer, "a.png", "image/png", bytes), withParams({ id: ownerId }))).status).toBe(403);

    const editor = await signInWith([`${cfg.area}.view`, `${cfg.area}.edit`], `editor-${cfg.owner}-1`);
    const uploaded = await cfg.add(uploadReq(base, editor, "a.png", "image/png", bytes), withParams({ id: ownerId }));
    expect(uploaded.status).toBe(200);
    const { id: attId } = await uploaded.json();

    expect((await cfg.get(getReq(`${base}/${attId}`), withParams({ id: ownerId, attId }))).status).toBe(401);
    expect((await cfg.del(
      noBodyReq(`${base}/${attId}`, "DELETE"), withParams({ id: ownerId, attId }))).status).toBe(401);
    expect((await cfg.get(getReq(`${base}/${attId}`, wrong), withParams({ id: ownerId, attId }))).status).toBe(403);
    expect((await cfg.del(
      noBodyReq(`${base}/${attId}`, "DELETE", wrong), withParams({ id: ownerId, attId }))).status).toBe(403);
    expect((await cfg.del(
      noBodyReq(`${base}/${attId}`, "DELETE", viewer), withParams({ id: ownerId, attId }))).status).toBe(403);

    const got = await cfg.get(getReq(`${base}/${attId}`, viewer), withParams({ id: ownerId, attId }));
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    const deleted = await cfg.del(noBodyReq(`${base}/${attId}`, "DELETE", editor), withParams({ id: ownerId, attId }));
    expect(deleted.status).toBe(200);

    const afterDelete = await cfg.list(getReq(base, viewer), withParams({ id: ownerId }));
    expect(await afterDelete.json()).toEqual([]);
  });

  it("400s a file over the cap and a disallowed type, via the route", async () => {
    const ownerId = await cfg.fixture();
    const base = cfg.path(ownerId);
    const editor = await signInWith([`${cfg.area}.view`, `${cfg.area}.edit`], `cap-${cfg.owner}-1`);

    const badType = await cfg.add(
      uploadReq(base, editor, "a.zip", "application/zip", new Uint8Array([1, 2, 3])), withParams({ id: ownerId }));
    expect(badType.status).toBe(400);
    expect((await badType.json()).error).toMatch(/not allowed/);

    const tooBig = new Uint8Array(20 * 1024 * 1024 + 1);
    const capped = await cfg.add(
      uploadReq(base, editor, "big.png", "image/png", tooBig), withParams({ id: ownerId }));
    expect(capped.status).toBe(400);
    expect((await capped.json()).error).toMatch(/20 MB/);
  });

  it("POST with no file field is 400, not 500", async () => {
    const ownerId = await cfg.fixture();
    const base = cfg.path(ownerId);
    const editor = await signInWith([`${cfg.area}.view`, `${cfg.area}.edit`], `nofile-${cfg.owner}-1`);
    const empty = new Request(base, { method: "POST", headers: { cookie: editor }, body: new FormData() });
    const res = await cfg.add(empty, withParams({ id: ownerId }));
    expect(res.status).toBe(400);
  });

  it.each([
    ["image/png", "inline"], ["application/pdf", "inline"], ["text/csv", "attachment"],
  ])("Content-Disposition for %s is %s", async (mimeType, expectedKind) => {
    const ownerId = await cfg.fixture();
    const base = cfg.path(ownerId);
    const editor = await signInWith(
      [`${cfg.area}.view`, `${cfg.area}.edit`], `disp-${cfg.owner}-${mimeType.replace(/\W/g, "")}`);
    const uploaded = await cfg.add(
      uploadReq(base, editor, "f.bin", mimeType, new Uint8Array([9, 9, 9])), withParams({ id: ownerId }));
    expect(uploaded.status).toBe(200);
    const { id: attId } = await uploaded.json();

    const res = await cfg.get(getReq(`${base}/${attId}`, editor), withParams({ id: ownerId, attId }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(mimeType);
    expect(res.headers.get("content-disposition")).toContain(expectedKind);
    expect(res.headers.get("content-disposition")).toContain('filename="f.bin"');
  });
});
