import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { PUT } from "@/app/api/setup/state/route";
import { getSetupState } from "@/server/setup-state";
import { signInWith } from "./helpers/auth";

const noParams = { params: Promise.resolve({}) };
const putReq = (cookie: string, body: unknown) =>
  new Request("http://t/api/setup/state", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PUT /api/setup/state (Phase 8B §5.5)", () => {
  beforeEach(truncateAll);

  it("403 for a caller without admin.edit", async () => {
    const cookie = await signInWith(["admin.view"], "view-only");
    expect((await PUT(putReq(cookie, { dismiss: true }), noParams)).status).toBe(403);
  });

  it("confirmNumbers stamps numbersConfirmedAt", async () => {
    const cookie = await signInWith(["admin.view", "admin.edit"], "admin-a");
    const res = await PUT(putReq(cookie, { confirmNumbers: true }), noParams);
    expect(res.status).toBe(200);
    const s = await getSetupState();
    expect(s.numbersConfirmedAt).not.toBeNull();
    expect(s.checklistDismissedAt).toBeNull();
  });

  it("dismiss stamps checklistDismissedAt", async () => {
    const cookie = await signInWith(["admin.view", "admin.edit"], "admin-b");
    await PUT(putReq(cookie, { dismiss: true }), noParams);
    const s = await getSetupState();
    expect(s.checklistDismissedAt).not.toBeNull();
    expect(s.numbersConfirmedAt).toBeNull();
  });
});
