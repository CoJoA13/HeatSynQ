import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createUser } from "@/server/users";
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

async function makeUser(username = "signer"): Promise<string> {
  const { id } = await asSystem(() => createUser({ username, displayName: "Signer", password: "pw123456" }));
  return id;
}

describe("per-user signature image (Task 12)", () => {
  beforeEach(truncateAll);

  it("round-trips an upload through setSignature/getSignature", async () => {
    const userId = await makeUser();
    expect(await getSignature(userId)).toBeNull();

    const bytes = Buffer.from("fake-png-bytes");
    await asSystem(() => setSignature(userId, bytes, "image/png"));

    const got = await getSignature(userId);
    expect(got).not.toBeNull();
    expect(got!.mimeType).toBe("image/png");
    expect(Buffer.isBuffer(got!.data)).toBe(true);
    expect(got!.data.equals(bytes)).toBe(true);
  });

  it("clearSignature sets both columns null", async () => {
    const userId = await makeUser();
    await asSystem(() => setSignature(userId, Buffer.from("x"), "image/jpeg"));
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
    const exact = Buffer.alloc(SIGNATURE_MAX_BYTES);
    await asSystem(() => setSignature(userId, exact, "image/png"));
    const got = await getSignature(userId);
    expect(got!.data.byteLength).toBe(SIGNATURE_MAX_BYTES);
  });

  it("rejects a MIME type outside the allowlist, naming the allowed types", async () => {
    const userId = await makeUser();
    const err = await asSystem(() => setSignature(userId, Buffer.from("x"), "image/svg+xml")).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    for (const type of SIGNATURE_MIME) expect((err as Error).message).toContain(type);
    expect(await getSignature(userId)).toBeNull();
  });

  it("accepts every allowlisted type", async () => {
    const userId = await makeUser();
    for (const mimeType of SIGNATURE_MIME) {
      await asSystem(() => setSignature(userId, Buffer.from(`bytes-${mimeType}`), mimeType));
      const got = await getSignature(userId);
      expect(got!.mimeType).toBe(mimeType);
    }
  });

  it("404s setSignature/clearSignature/getSignature for a user that does not exist", async () => {
    await expect(asSystem(() => setSignature("bogus-id", Buffer.from("x"), "image/png")))
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
    await asSystem(() => setSignature(userId, Buffer.from(marker), "image/png"));
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
      const bytes = new TextEncoder().encode("hello signature bytes");

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
});
