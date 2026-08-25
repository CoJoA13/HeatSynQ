import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createUser, listUsers } from "@/server/users";
import {
  setSignature, clearSignature, getSignature, SIGNATURE_MAX_BYTES, SIGNATURE_MIME,
} from "@/server/users";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/http";
import { GET as getSignatureRoute, PUT as putSignatureRoute, DELETE as deleteSignatureRoute } from
  "@/app/api/admin/users/[id]/signature/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function noBodyReq(url: string, method: string, cookie?: string): Request {
  return new Request(url, { method, headers: cookie ? { cookie } : {} });
}
/** Mirrors attachments.test.ts's `uploadReq` — a real multipart body via FormData/Blob, so the
 *  route's own `req.formData()` call is exercised end to end. `content-length` is set by hand
 *  for the same reason documented there: undici's `new Request` doesn't compute it. */
function uploadReq(
  url: string, cookie: string | undefined, filename: string, mimeType: string, bytes: Uint8Array<ArrayBuffer>,
  declaredLength?: string | null,
): Request {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mimeType }), filename);
  const length = declaredLength === undefined ? String(bytes.byteLength + 1024) : declaredLength;
  const headers: Record<string, string> = {
    ...(cookie ? { cookie } : {}), ...(length === null ? {} : { "content-length": length }),
  };
  return new Request(url, { method: "PUT", headers, body: form });
}

// A real 1×1 PNG and a minimal JPEG SOI prefix — the sniff (#49) checks magic bytes, so garbage
// declared as an image no longer reaches the database.
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");
const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
/** Bytes that BEGIN as the declared type padded to `size` — for the byte-cap tests. */
function paddedPng(size: number): Buffer {
  return Buffer.concat([REAL_PNG, Buffer.alloc(size - REAL_PNG.length)]);
}

async function makeUser(username = "signer"): Promise<string> {
  const { id } = await asSystem(() => createUser({ username, displayName: "Signer", password: "pw123456" }));
  return id;
}

describe("per-user signature image (Task 12)", () => {
  beforeEach(truncateAll);

  it("round-trips an upload through setSignature/getSignature", async () => {
    const userId = await makeUser();
    expect(await getSignature(userId)).toBeNull();

    const bytes = REAL_PNG;
    await asSystem(() => setSignature(userId, bytes, "image/png"));

    const got = await getSignature(userId);
    expect(got).not.toBeNull();
    expect(got!.mimeType).toBe("image/png");
    expect(Buffer.isBuffer(got!.data)).toBe(true);
    expect(got!.data.equals(bytes)).toBe(true);
  });

  it("clearSignature sets both columns null", async () => {
    const userId = await makeUser();
    await asSystem(() => setSignature(userId, JPEG_PREFIX, "image/jpeg"));
    expect(await getSignature(userId)).not.toBeNull();

    await asSystem(() => clearSignature(userId));
    expect(await getSignature(userId)).toBeNull();

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.signatureImage).toBeNull();
    expect(row.signatureMimeType).toBeNull();
  });

  it("clearing a user with no signature is a harmless no-op", async () => {
    const userId = await makeUser();
    await asSystem(() => clearSignature(userId));
    expect(await getSignature(userId)).toBeNull();
  });

  it("rejects an upload over the 2 MB cap, naming the cap", async () => {
    const userId = await makeUser();
    const tooBig = Buffer.alloc(SIGNATURE_MAX_BYTES + 1);
    await expect(asSystem(() => setSignature(userId, tooBig, "image/png"))).rejects.toThrow("2 MB");
    expect(await getSignature(userId)).toBeNull();
  });

  it("allows exactly the 2 MB cap", async () => {
    const userId = await makeUser();
    const exact = paddedPng(SIGNATURE_MAX_BYTES);
    await asSystem(() => setSignature(userId, exact, "image/png"));
    const got = await getSignature(userId);
    expect(got!.data.byteLength).toBe(SIGNATURE_MAX_BYTES);
  });

  it("rejects bytes that are not the declared PNG (#49)", async () => {
    const userId = await makeUser();
    await expect(asSystem(() => setSignature(userId, Buffer.from("not a png at all"), "image/png")))
      .rejects.toThrow(/not a valid/i);
    expect(await getSignature(userId)).toBeNull(); // nothing poisoned the print path
  });

  it("rejects PNG bytes declared as JPEG (#49)", async () => {
    const userId = await makeUser();
    await expect(asSystem(() => setSignature(userId, REAL_PNG, "image/jpeg")))
      .rejects.toThrow(/not a valid/i);
  });

  it("accepts a real JPEG prefix declared as JPEG (#49)", async () => {
    const userId = await makeUser();
    await asSystem(() => setSignature(userId, JPEG_PREFIX, "image/jpeg"));
    expect((await getSignature(userId))!.mimeType).toBe("image/jpeg");
  });

  it("rejects a MIME type outside the allowlist, naming the allowed types", async () => {
    const userId = await makeUser();
    const err = await asSystem(() => setSignature(userId, Buffer.from("x"), "image/svg+xml")).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    for (const type of SIGNATURE_MIME) expect((err as Error).message).toContain(type);
    expect(await getSignature(userId)).toBeNull();
  });

  it("rejects image/bmp — pdfkit cannot embed it on the cert (§9 amendment 2026-08-05)", async () => {
    const userId = await makeUser();
    const err = await asSystem(() => setSignature(userId, Buffer.from("x"), "image/bmp")).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(await getSignature(userId)).toBeNull();
  });

  it("accepts every allowlisted type", async () => {
    const userId = await makeUser();
    for (const mimeType of SIGNATURE_MIME) {
      await asSystem(() => setSignature(userId,
        mimeType === "image/png" ? REAL_PNG : JPEG_PREFIX, mimeType));
      const got = await getSignature(userId);
      expect(got!.mimeType).toBe(mimeType);
    }
  });

  it("404s setSignature/clearSignature/getSignature for a user that does not exist", async () => {
    await expect(asSystem(() => setSignature("bogus-id", REAL_PNG, "image/png")))
      .rejects.toThrow("User not found");
    await expect(asSystem(() => clearSignature("bogus-id"))).rejects.toThrow("User not found");
    await expect(getSignature("bogus-id")).rejects.toThrow("User not found");
  });

  // Task brief: "signatureImage is already in redact()'s patterns — assert it, don't assume."
  // This goes one step further, mirroring attachments.test.ts's own audit test: the SNAPSHOT_SELECT
  // entry added for `user` (audit.ts) means the bytes never enter the snapshot query in the first
  // place, so the property is ABSENT from the audit row, not merely redacted to a placeholder.
  it("the audit entry for a signature upload/clear contains no image bytes", async () => {
    const userId = await makeUser("audited-signer");
    const marker = "TOTALLY-SECRET-SIGNATURE-BYTE-MARKER-XYZ";
    await asSystem(() => setSignature(userId, Buffer.concat([REAL_PNG, Buffer.from(marker)]), "image/png"));
    await asSystem(() => clearSignature(userId));

    const entries = await readAudit("user", userId);
    // create (from createUser) + two updates (set, clear)
    expect(entries.filter((e) => e.action === "update")).toHaveLength(2);

    for (const entry of entries) {
      // `before` is null on the "create" entry (createUser has nothing to diff against) — only
      // present on the two updates this test actually exercises.
      if (entry.before !== null) expect(entry.before).not.toHaveProperty("signatureImage");
      if (entry.after !== null) expect(entry.after).not.toHaveProperty("signatureImage");
      const blob = JSON.stringify([entry.before, entry.after]);
      expect(blob).not.toContain(marker);
    }

    const setEntry = entries.find((e) => e.action === "update" && (e.after as { signatureMimeType?: string })
      .signatureMimeType === "image/png");
    expect(setEntry).toBeDefined();
    expect((setEntry!.before as { signatureMimeType: string | null }).signatureMimeType).toBeNull();
  });

  describe("signature route", () => {
    beforeEach(truncateAll);

    it("gates GET/PUT/DELETE on manage_users and round-trips a real upload end to end", async () => {
      const userId = await makeUser("route-target");
      const base = `http://t/api/admin/users/${userId}/signature`;
      const bytes = new Uint8Array(REAL_PNG); // must sniff as the declared PNG (#49)

      expect((await getSignatureRoute(getReq(base), withParams({ id: userId }))).status).toBe(401);
      expect((await putSignatureRoute(
        uploadReq(base, undefined, "sig.png", "image/png", bytes), withParams({ id: userId }))).status).toBe(401);
      expect((await deleteSignatureRoute(noBodyReq(base, "DELETE"), withParams({ id: userId }))).status).toBe(401);

      const wrong = await signInWith(["customers.view"], "wrong-signer");
      expect((await getSignatureRoute(getReq(base, wrong), withParams({ id: userId }))).status).toBe(403);
      expect((await putSignatureRoute(
        uploadReq(base, wrong, "sig.png", "image/png", bytes), withParams({ id: userId }))).status).toBe(403);
      expect((await deleteSignatureRoute(
        noBodyReq(base, "DELETE", wrong), withParams({ id: userId }))).status).toBe(403);

      const manager = await signInWith(["action.manage_users"], "signature-manager");

      // No signature yet: 404, discoverably ("No signature on file"), not a bare 500/empty body.
      const beforeUpload = await getSignatureRoute(getReq(base, manager), withParams({ id: userId }));
      expect(beforeUpload.status).toBe(404);
      expect((await beforeUpload.json()).error).toMatch(/No signature on file/);

      const uploaded = await putSignatureRoute(
        uploadReq(base, manager, "sig.png", "image/png", bytes), withParams({ id: userId }));
      expect(uploaded.status).toBe(200);

      const got = await getSignatureRoute(getReq(base, manager), withParams({ id: userId }));
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

      const deleted = await deleteSignatureRoute(noBodyReq(base, "DELETE", manager), withParams({ id: userId }));
      expect(deleted.status).toBe(200);

      const afterDelete = await getSignatureRoute(getReq(base, manager), withParams({ id: userId }));
      expect(afterDelete.status).toBe(404);
    });

    it("400s an oversized upload and a disallowed type, via the route", async () => {
      const userId = await makeUser("route-caps");
      const base = `http://t/api/admin/users/${userId}/signature`;
      const manager = await signInWith(["action.manage_users"], "cap-manager");

      const badType = await putSignatureRoute(
        uploadReq(base, manager, "sig.svg", "image/svg+xml", new Uint8Array([1, 2, 3])),
        withParams({ id: userId }));
      expect(badType.status).toBe(400);
      expect((await badType.json()).error).toMatch(/image\/png/);

      const tooBig = new Uint8Array(SIGNATURE_MAX_BYTES + 1);
      const capped = await putSignatureRoute(
        uploadReq(base, manager, "big.png", "image/png", tooBig), withParams({ id: userId }));
      expect(capped.status).toBe(400);
      expect((await capped.json()).error).toMatch(/2 MB/);
    });
  });

  /**
   * #160 — the users list carries the FLAG, never the bytes.
   *
   * `UserSignatureControl` used to seed `hasImage` optimistically `true` and discover the truth
   * from the `<img>`'s 404, costing one failed request per signature-less user on every
   * /admin/users load. `listUsers` now derives `hasSignature` from `signatureMimeType` — the
   * `templates.ts` `hasLogo` precedent, where the mime column stands proxy for bytes that are only
   * ever written and cleared together with it.
   */
  describe("listUsers' hasSignature flag (#160)", () => {
    it("is false on a fresh user, true after setSignature, false again after clearSignature", async () => {
      const userId = await makeUser("flagged");
      const flag = async () => (await listUsers()).find((u) => u.id === userId)?.hasSignature;

      expect(await flag()).toBe(false);
      await asSystem(() => setSignature(userId, REAL_PNG, "image/png"));
      expect(await flag()).toBe(true);
      await asSystem(() => clearSignature(userId));
      expect(await flag()).toBe(false);
    });

    /**
     * The guard that did not exist before #160, and the reason it is written against the SELECT
     * rather than the returned row: `listUsers`' explicit `select` (see its own comment) was
     * narrowed precisely to keep up to SIGNATURE_MAX_BYTES per row out of a list that renders no
     * bytes, and nothing pinned that. Asserting only that the RETURNED row lacks `signatureImage`
     * is not enough, and this was checked by deliberately writing the regression: `listUsers` maps
     * to an explicit object literal, so `select: { signatureImage: true }` + `hasSignature:
     * u.signatureImage !== null` leaves the payload assertions below GREEN while hauling every
     * signature out of Postgres on every page load. Only the SELECT assertion catches it. So both
     * halves are pinned — the query shape first, then the payload shape.
     *
     * Plain wrap/restore of the bound method, never `vi.spyOn` on a Prisma model delegate
     * (CLAUDE.md; request-context.test.ts carries the descriptor rationale). Restored in `finally`
     * so a failure here cannot corrupt the shared singleton for the rest of the run.
     */
    it("derives the flag from the mime column — the bytes never leave Postgres", async () => {
      const userId = await makeUser("byte-guard");
      await asSystem(() => setSignature(userId, REAL_PNG, "image/png"));

      const originalFindMany = prisma.user.findMany.bind(prisma.user);
      const selects: Record<string, unknown>[] = [];
      prisma.user.findMany = ((args: { select?: Record<string, unknown> }) => {
        if (args?.select) selects.push(args.select);
        return originalFindMany(args as Parameters<typeof originalFindMany>[0]);
      }) as unknown as typeof prisma.user.findMany;
      let rows: Awaited<ReturnType<typeof listUsers>>;
      try {
        rows = await listUsers();
      } finally {
        prisma.user.findMany = originalFindMany;
      }

      expect(selects).toHaveLength(1);
      expect(selects[0]).not.toHaveProperty("signatureImage");
      expect(selects[0]).toHaveProperty("signatureMimeType", true);

      const row = rows.find((u) => u.id === userId)!;
      expect(row.hasSignature).toBe(true);
      expect(row).not.toHaveProperty("signatureImage");
      expect(row).not.toHaveProperty("signatureMimeType");
    });
  });

  /**
   * #171 — the users list carries a REVISION that moves whenever the stored image does, so the
   * preview URL cache-busts on ANY change (this browser's OR another admin's) and a failed preview
   * retries by construction. `signatureRev` is epoch millis of `signatureUpdatedAt`, still bytes-free
   * (#160). The render decision that consumes it is pinned in `user-signature-control.test.tsx`; this
   * pins that the server actually MOVES the token on every write.
   */
  describe("listUsers exposes a signature revision that moves with the image (#171)", () => {
    const revOf = async (userId: string) =>
      (await listUsers()).find((u) => u.id === userId)?.signatureRev;
    const AGED = new Date("2000-01-01T00:00:00.000Z");
    const ageRevision = (userId: string) =>
      prisma.user.update({ where: { id: userId }, data: { signatureUpdatedAt: AGED } });

    it("is null on a fresh user, non-null after setSignature, and equals signatureUpdatedAt", async () => {
      const userId = await makeUser("rev-basic");
      expect(await revOf(userId)).toBeNull();

      await asSystem(() => setSignature(userId, REAL_PNG, "image/png"));
      const stamped = await prisma.user.findUniqueOrThrow({
        where: { id: userId }, select: { signatureUpdatedAt: true },
      });
      expect(stamped.signatureUpdatedAt).not.toBeNull();
      expect(await revOf(userId)).toBe(stamped.signatureUpdatedAt!.getTime());
    });

    it("surfaces exactly the stored timestamp — the cache-bust token IS that value", async () => {
      const userId = await makeUser("rev-exact");
      await asSystem(() => setSignature(userId, REAL_PNG, "image/png"));
      const fixed = new Date("2026-08-20T12:00:00.000Z");
      await prisma.user.update({ where: { id: userId }, data: { signatureUpdatedAt: fixed } });
      expect(await revOf(userId)).toBe(fixed.getTime());
    });

    it("advances on clear AND on a replace — every write moves it (the round-trip #171 case)", async () => {
      const userId = await makeUser("rev-moves");
      await asSystem(() => setSignature(userId, REAL_PNG, "image/png"));

      // Clear stamps the revision even though the flag goes false — the corrupt-preview-then-clear
      // leg of #171. Age the row first so "moved forward" is deterministic, not a same-ms race.
      await ageRevision(userId);
      await asSystem(() => clearSignature(userId));
      expect((await revOf(userId))!).toBeGreaterThan(AGED.getTime());
      expect(await revOf(userId)).not.toBeNull(); // moved, even with hasSignature now false

      // The replace leg: re-age, re-upload, the revision advances — a new URL, so the render-failure
      // key that mirrors it moves too. The old per-session counter never saw this.
      await ageRevision(userId);
      await asSystem(() => setSignature(userId, REAL_PNG, "image/png"));
      expect((await revOf(userId))!).toBeGreaterThan(AGED.getTime());
    });

    it("keeps the listUsers SELECT bytes-free while adding the revision column (#160 holds)", async () => {
      const userId = await makeUser("rev-select");
      await asSystem(() => setSignature(userId, REAL_PNG, "image/png"));

      const originalFindMany = prisma.user.findMany.bind(prisma.user);
      const selects: Record<string, unknown>[] = [];
      prisma.user.findMany = ((args: { select?: Record<string, unknown> }) => {
        if (args?.select) selects.push(args.select);
        return originalFindMany(args as Parameters<typeof originalFindMany>[0]);
      }) as unknown as typeof prisma.user.findMany;
      try {
        await listUsers();
      } finally {
        prisma.user.findMany = originalFindMany;
      }
      expect(selects).toHaveLength(1);
      expect(selects[0]).toHaveProperty("signatureUpdatedAt", true);
      expect(selects[0]).not.toHaveProperty("signatureImage");
    });
  });
});
