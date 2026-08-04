import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "../prisma/generated/prisma/client";
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
 *  `req.formData()` call is exercised end to end rather than mocked.
 *
 *  `content-length` is set by hand: a browser always declares the serialized body's length on a
 *  multipart POST, but undici's `new Request(url, { body: formData })` does NOT (verified — it
 *  leaves the header null and streams the body instead), so without this every request built here
 *  would look like an undeclared-length upload to `parseUploadFile`'s pre-parse guard
 *  (src/server/http.ts, fix-wave R4 finding 1). `declaredLength` overrides it for the tests that
 *  are specifically about that guard; otherwise it is the payload plus a generous allowance for
 *  the multipart framing around it, standing in for the exact figure a browser computes. */
function uploadReq(
  url: string, cookie: string | undefined, filename: string, mimeType: string, bytes: Uint8Array<ArrayBuffer>,
  declaredLength?: string | null,
): Request {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mimeType }), filename);
  const length = declaredLength === undefined ? String(bytes.byteLength + 1024) : declaredLength;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(length === null ? {} : { "content-length": length }) };
  return new Request(url, { method: "POST", headers, body: form });
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

  // Fix-wave finding 11: deleteAttachment used to run the owner-liveness check (assertOwnerVisible)
  // and the attachment's own existence check on the top-level `prisma` client, as two statements
  // BEFORE the delete's own `prisma.$transaction` even opened — a real gap in which a concurrent
  // void/delete of the owner could commit without deleteAttachment ever seeing it, since nothing
  // about auditedSoftDelete's own atomic updateMany re-checks the OWNER's liveness. The fix moves
  // both checks onto the delete's own `tx` (the addAttachment "house mutator shape" already
  // uses), closing the gap to "however long this one transaction takes" instead of "however long
  // between two independent round trips". A race test is optional once this structural change is
  // in place (the underlying assertOwnerVisible/current-row logic is unchanged, only which client
  // it runs on) — this instead proves the checks really did move, by intercepting the TOP-LEVEL
  // delegates' own methods and asserting neither is reached during a delete.
  //
  // Deliberately NOT `vi.spyOn` here: on this Prisma Client's model delegates, `mockRestore()`
  // does not restore the original method (verified live against this exact client — the property
  // comes back `undefined`, breaking every later test that touches the same model for the rest of
  // the run, since `prisma` is a process-wide singleton, tests/helpers/db.ts). A plain
  // save-reassign-restore of the property sidesteps whatever about that delegate's shape trips up
  // vi's restore logic, without that risk.
  it.each(["part", "order"] as const)(
    "runs the owner-liveness check and attachment resolution on the delete's own tx, not the top-level client (%s)",
    async (owner) => {
      const ownerId = owner === "part" ? await partOwnerFixture() : await orderOwnerFixture();
      const { id: attId } = await asSystem(() => addAttachment(owner, ownerId, {
        filename: "drawing.png", mimeType: "image/png", data: Buffer.from("x"),
      }));

      const ownerModel = (owner === "part" ? prisma.part : prisma.order) as unknown as Record<string, unknown>;
      const attModel = (owner === "part" ? prisma.partAttachment : prisma.orderAttachment) as
        unknown as Record<string, unknown>;
      const realOwnerFindFirst = ownerModel.findFirst as (...a: unknown[]) => unknown;
      const realAttFindFirst = attModel.findFirst as (...a: unknown[]) => unknown;
      let ownerCalls = 0;
      let attCalls = 0;
      ownerModel.findFirst = (...args: unknown[]) => { ownerCalls++; return realOwnerFindFirst(...args); };
      attModel.findFirst = (...args: unknown[]) => { attCalls++; return realAttFindFirst(...args); };

      try {
        await asSystem(() => deleteAttachment(owner, ownerId, attId));
      } finally {
        ownerModel.findFirst = realOwnerFindFirst;
        attModel.findFirst = realAttFindFirst;
      }

      // Neither ran on the top-level client — a call recorded here would only be possible if the
      // check ran on `prisma` rather than the delete's own `tx`.
      expect(ownerCalls).toBe(0);
      expect(attCalls).toBe(0);

      // And the delete still genuinely happened — this isn't just "nothing ran".
      expect(await listAttachments(owner, ownerId)).toHaveLength(0);
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

  it.each(["part", "order"] as const)(
    "audits filename/mimeType/size but never the file bytes ($owner)", async (owner) => {
    const ownerId = owner === "part" ? await partOwnerFixture() : await orderOwnerFixture();
    const marker = "TOTALLY-SECRET-BYTE-MARKER-XYZ";
    const { id: attId } = await asSystem(() => addAttachment(owner, ownerId, {
      filename: "drawing.png", mimeType: "text/plain", data: Buffer.from(marker),
    }));
    await asSystem(() => deleteAttachment(owner, ownerId, attId));

    const entries = await prisma.auditLog.findMany({
      where: { entity: owner === "part" ? "partAttachment" : "orderAttachment", entityId: attId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(entries.map((e) => e.action)).toEqual(["create", "delete"]);

    // Belt: the marker never appears in what's persisted, whatever the mechanism.
    for (const entry of entries) {
      const blob = JSON.stringify([entry.before, entry.after]);
      expect(blob).not.toContain(marker);
    }

    // Suspenders (fix-wave finding 3): the delete's "before" snapshot now comes from a `select`
    // that never asks for `fileData` in the first place — the key itself is absent, not merely
    // redacted to a placeholder string. redact() staying a no-op here (nothing left for it to
    // scrub) is the proof the exclusion happens upstream of it, at the query, exactly as
    // CLAUDE.md requires ("don't hand a secret-bearing payload to the audit layer in the first
    // place"). The delete entry still carries the metadata an operator would want in history.
    const deleteEntry = entries[1];
    expect(deleteEntry.before).not.toHaveProperty("fileData");
    expect(deleteEntry.before).toMatchObject({ filename: "drawing.png", mimeType: "text/plain" });

    const created = entries[0].after as { filename: string; mimeType: string; size: number };
    expect(created.filename).toBe("drawing.png");
    expect(created.mimeType).toBe("text/plain");
    expect(created.size).toBe(Buffer.byteLength(marker));
  });

  it("Content-Disposition: inline for images/PDF, attachment otherwise, filename escaped", () => {
    // Fix-wave finding 7: every case below now also carries a trailing RFC 5987
    // `filename*=UTF-8''...` parameter (RFC 6266 §4.3's own recommendation — sent alongside
    // `filename=` even for a plain-ASCII name, so there is exactly one code path rather than an
    // ASCII/non-ASCII fork). For an all-ASCII name the percent-encoded form is identical to the
    // plain name, since none of its characters need escaping.
    expect(contentDisposition("image/png", "drawing.png"))
      .toBe("inline; filename=\"drawing.png\"; filename*=UTF-8''drawing.png");
    expect(contentDisposition("application/pdf", "cert.pdf"))
      .toBe("inline; filename=\"cert.pdf\"; filename*=UTF-8''cert.pdf");
    expect(contentDisposition("text/csv", "data.csv"))
      .toBe("attachment; filename=\"data.csv\"; filename*=UTF-8''data.csv");

    // Quote/backslash escaped for the quoted-string form — an unescaped quote in the filename
    // would otherwise terminate the parameter early and let the rest of the name (or worse, a
    // crafted suffix) read as new header syntax.
    expect(contentDisposition("text/plain", 'weird"name.txt'))
      .toBe("attachment; filename=\"weird\\\"name.txt\"; filename*=UTF-8''weird%22name.txt");
    expect(contentDisposition("text/plain", "a\\b.txt"))
      .toBe("attachment; filename=\"a\\\\b.txt\"; filename*=UTF-8''a%5Cb.txt");

    // CR/LF stripped — a filename is attacker-controlled input landing in a raw response header,
    // so this is the header-injection defense (a filename of `x\r\nSet-Cookie: evil=1` must not
    // be able to inject a second header). Checked on the whole header, not just the quoted param.
    const injected = contentDisposition("text/plain", "name\r\nX-Injected: 1.txt");
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toBe(
      "attachment; filename=\"nameX-Injected: 1.txt\"; filename*=UTF-8''nameX-Injected%3A%201.txt");
  });

  // Fix-wave finding 7: raw non-ASCII in a `Content-Disposition` value is outside the Latin1/
  // ByteString range `Headers`/`NextResponse` require — before this fix, constructing the
  // response for an attachment named e.g. "測定.pdf" threw, so the file could be UPLOADED but
  // never DOWNLOADED again. The ASCII fallback plus RFC 5987 `filename*=` fixes that; this checks
  // the encoding function directly (an em dash, purely for a name that is non-ASCII but has no
  // header-syntax characters to also worry about escaping).
  it("non-ASCII filenames get an ASCII-sanitized fallback AND a faithful RFC 5987 filename*=, both present", () => {
    const header = contentDisposition("application/pdf", "測定.pdf");
    // One "_" per non-ASCII codepoint (測, 定) in the legacy quoted parameter — an approximation,
    // never the value a modern client actually reads.
    expect(header).toContain('filename="__.pdf"');
    expect(header).toContain("filename*=UTF-8''");
    const match = /filename\*=UTF-8''([^;]+)/.exec(header);
    expect(match).not.toBeNull();
    // Round-trips to the exact original name — this parameter, not the sanitized fallback, is
    // what every current browser actually reads.
    expect(decodeURIComponent(match![1])).toBe("測定.pdf");
  });

  // -------------------------------------------------------------------------------------------
  // Fix-wave R4 finding 2: attachment writes pair with deletePart's Serializable cascade scan.
  //
  // `deletePart` (parts.ts) runs Serializable specifically so a child added mid-delete cannot
  // outlive its parent — F2's own reasoning, already shared by addPartSpec/addPartInspection/
  // addPartBreak, every one of which reads the part live on `tx` under Serializable before adding
  // a child. Attachments joined the cascade in R3 finding 5 but never joined that pairing: their
  // transactions ran at the default isolation, and a disjoint INSERT into PartAttachment does not
  // conflict with anything deletePart does under READ COMMITTED. So the cascade could snapshot
  // "these are the live attachments", soft-delete exactly those, and commit — while a concurrent
  // upload's owner check (part still live, from its own older snapshot) passed and its bytes
  // landed live under a part that is now deleted. Unreachable behind every guard afterwards, and
  // invisible to the parent's own history: precisely the invariant F2 exists to hold.
  // -------------------------------------------------------------------------------------------

  /** Records the options every `prisma.$transaction` call receives while `fn` runs.
   *
   *  Deliberately NOT `vi.spyOn` — the file's own warning above applies to the client just as it
   *  does to its delegates: a plain save-reassign-restore is the technique this suite trusts. */
  async function transactionOptions(fn: () => Promise<unknown>): Promise<unknown[]> {
    const client = prisma as unknown as Record<string, unknown>;
    const real = client.$transaction as (...a: unknown[]) => unknown;
    const seen: unknown[] = [];
    client.$transaction = (...args: unknown[]) => { seen.push(args[1]); return real.apply(prisma, args); };
    try {
      await fn();
    } finally {
      client.$transaction = real;
    }
    return seen;
  }

  it.each(["part", "order"] as const)(
    "addAttachment and deleteAttachment both open Serializable transactions (%s owner)", async (owner) => {
      const ownerId = owner === "part" ? await partOwnerFixture() : await orderOwnerFixture();

      let attId = "";
      const addOpts = await transactionOptions(async () => {
        ({ id: attId } = await asSystem(() => addAttachment(owner, ownerId, {
          filename: "drawing.png", mimeType: "image/png", data: Buffer.from("x"),
        })));
      });
      const delOpts = await transactionOptions(() => asSystem(() => deleteAttachment(owner, ownerId, attId)));

      // One transaction each, and both at Serializable — uniform across owners, so neither the
      // pairing nor the 40001 -> 409 mapping depends on remembering which owner is which.
      expect(addOpts).toEqual([{ isolationLevel: "Serializable" }]);
      expect(delOpts).toEqual([{ isolationLevel: "Serializable" }]);
    });

  // The behavioural half, with the interleaving FORCED rather than left to chance.
  //
  // The holder reproduces deletePart's own read/write set on the part (the live-part check, the
  // live-attachment cascade scan, then the part's own soft delete) inside one Serializable
  // transaction — the real thing minus its audit rows, which play no part in the conflict. It
  // also takes `SELECT … FOR UPDATE` on the Part row FIRST, which is what makes the interleaving
  // deterministic: a concurrent INSERT into PartAttachment must take FOR KEY SHARE on the
  // referenced Part row to check its foreign key, and FOR KEY SHARE conflicts with FOR UPDATE. So
  // the real `addAttachment` below gets its owner check through (the part is genuinely still live
  // at that point) and is then pinned at exactly the moment the finding describes — after the
  // check, before the insert — until the holder's delete has committed.
  //
  // The assertion is the invariant, not one particular loser: whether the upload is aborted
  // (40001 -> the retryable 409) or somehow lands, what must never be true afterwards is a LIVE
  // attachment hanging off a deleted part. Before this fix the upload simply succeeded — its
  // insert conflicted with nothing — and left exactly that.
  it("an upload cannot land live under a part whose delete commits between its check and its insert", async () => {
    const partId = await partOwnerFixture();

    let hasScanned!: () => void;
    const scanned = new Promise<void>((resolve) => { hasScanned = resolve; });
    let mayDelete!: () => void;
    const release = new Promise<void>((resolve) => { mayDelete = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Part" WHERE "id" = ${partId} FOR UPDATE`;
      await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
      await tx.partAttachment.findMany({ where: { partId, deletedAt: null }, select: { id: true } });
      hasScanned();
      await release;
      await tx.part.update({ where: { id: partId }, data: { deletedAt: new Date() } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 });

    await scanned;
    const upload = asSystem(() => addAttachment("part", partId, {
      filename: "drawing.png", mimeType: "image/png", data: Buffer.from("late"),
    }));

    // Confirms the upload really is pinned mid-transaction (owner check done, insert blocked on
    // the holder's row lock) before the delete is allowed to commit — the traveler.test.ts
    // print-race precedent. Not itself the discriminator.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      upload.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayDelete();
    await holder;
    const settled = await Promise.allSettled([upload]);

    // A refusal is fine, and is the expected outcome — but only as a mapped HttpError (the
    // retryable 409, or the 404 an already-dead owner earns). Never an unmapped escape.
    if (settled[0].status === "rejected") {
      expect(settled[0].reason).toMatchObject({ status: expect.any(Number) });
      expect([404, 409]).toContain((settled[0].reason as { status: number }).status);
    }

    // The invariant, whichever way it went.
    const part = await prisma.part.findUniqueOrThrow({ where: { id: partId }, select: { deletedAt: true } });
    expect(part.deletedAt).not.toBeNull();
    expect(await prisma.partAttachment.count({ where: { partId, deletedAt: null } })).toBe(0);
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
    const empty = new Request(base, {
      method: "POST", headers: { cookie: editor, "content-length": "1024" }, body: new FormData(),
    });
    const res = await cfg.add(empty, withParams({ id: ownerId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/file is required/);
  });

  // Fix-wave R4 finding 1: the 20 MB cap used to be enforced only on `file.data.byteLength`
  // (attachments.ts) — i.e. only AFTER `req.formData()` had already buffered the ENTIRE body into
  // memory. A client that posted a multi-gigabyte body still got its whole payload read before
  // anything measured it, so the cap bounded what could be STORED but not what could be
  // ALLOCATED. `parseUploadFile` now reads the declared `Content-Length` and refuses before it
  // parses anything at all.
  //
  // Discriminating shape: the body here is three bytes of a perfectly allowed type — it would
  // upload successfully (200) under the old code and under any check that still runs post-parse.
  // The ONLY thing wrong with it is the size it DECLARES, which nothing but a pre-parse guard can
  // possibly notice.
  it("413s an upload whose declared Content-Length is over the bound, before the body is parsed", async () => {
    const ownerId = await cfg.fixture();
    const base = cfg.path(ownerId);
    const editor = await signInWith([`${cfg.area}.view`, `${cfg.area}.edit`], `declared-${cfg.owner}-1`);

    const res = await cfg.add(
      uploadReq(base, editor, "small.png", "image/png", new Uint8Array([1, 2, 3]), "21000001"),
      withParams({ id: ownerId }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/20 MB/);
    // Nothing was stored — the refusal happened before the body was ever read.
    const after = await cfg.list(getReq(base, editor), withParams({ id: ownerId }));
    expect(await after.json()).toEqual([]);
  });

  // The other half of the same guard: a body whose length is not declared at all (or is declared
  // as garbage) cannot be bounded up front, so it is refused rather than buffered and measured
  // afterwards. Named explicitly in the refusal — a caller has to be able to tell WHY.
  it.each([["missing", null], ["not a number", "lots"], ["negative", "-1"]])(
    "400s an upload whose Content-Length is %s", async (_label, declared) => {
      const ownerId = await cfg.fixture();
      const base = cfg.path(ownerId);
      const editor = await signInWith(
        [`${cfg.area}.view`, `${cfg.area}.edit`], `undeclared-${cfg.owner}-${_label.replace(/\W/g, "")}`);

      const res = await cfg.add(
        uploadReq(base, editor, "small.png", "image/png", new Uint8Array([1, 2, 3]), declared),
        withParams({ id: ownerId }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Content-Length/);
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

  // Fix-wave finding 7: before the RFC 5987 fix, constructing this GET response for a filename
  // outside Latin1/ByteString range threw inside `new NextResponse(...)` — the upload above would
  // still succeed (nothing about the write path touches Content-Disposition), but every download
  // attempt would fail. Exercised at the ROUTE level, not just contentDisposition() directly,
  // because that constructor call is exactly where the old code broke.
  it("uploads and downloads an attachment with a non-ASCII filename (RFC 5987)", async () => {
    const ownerId = await cfg.fixture();
    const base = cfg.path(ownerId);
    const editor = await signInWith([`${cfg.area}.view`, `${cfg.area}.edit`], `unicode-${cfg.owner}`);

    const uploaded = await cfg.add(
      uploadReq(base, editor, "測定.pdf", "application/pdf", new Uint8Array([1, 2, 3])),
      withParams({ id: ownerId }));
    expect(uploaded.status).toBe(200);
    const { id: attId } = await uploaded.json();

    const res = await cfg.get(getReq(`${base}/${attId}`, editor), withParams({ id: ownerId, attId }));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="');
    expect(disposition).toContain("filename*=UTF-8''");
    const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe("測定.pdf");
  });
});
