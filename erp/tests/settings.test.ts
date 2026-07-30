import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, prisma } from "./helpers/db";
import { getSetting, setSetting, allSettings } from "@/server/settings";
import { readAudit, auditSettingChange } from "@/server/audit";
import { HttpError } from "@/server/http";
import { createSession } from "@/server/sessions";

describe("settings", () => {
  beforeEach(async () => await truncateAll());

  it("returns defaults when unset", async () => {
    expect(await getSetting("request_days_default")).toBe(5);
    expect(await getSetting("company_name")).toBe("");
  });

  it("stores, validates, and audits values", async () => {
    await setSetting("company_name", "Acme Heat Treating");
    expect(await getSetting("company_name")).toBe("Acme Heat Treating");
    await expect(setSetting("session_timeout_minutes", "not a number")).rejects.toThrow(HttpError);
    await expect(setSetting("bogus_key", 1)).rejects.toThrow(HttpError);
    expect((await readAudit("setting", "company_name"))[0].action).toBe("update");
  });

  it("lists every registered setting with group and label", async () => {
    const all = await allSettings();
    expect(all.find((s) => s.key === "order_number_next")).toMatchObject({ group: "Numbering", value: 1000 });
  });

  it("rejects prototype-key attempts like __proto__", async () => {
    const err = await setSetting("__proto__", 1).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toMatch(/Unknown setting/);
    const auditRows = await readAudit("setting", "__proto__");
    expect(auditRows).toHaveLength(0);
  });

  it("rejects prototype-key attempts like toString", async () => {
    const err = await setSetting("toString", 1).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toMatch(/Unknown setting/);
    const auditRows = await readAudit("setting", "toString");
    expect(auditRows).toHaveLength(0);
  });

  it("rejects prototype-key attempts like constructor", async () => {
    const err = await setSetting("constructor", 1).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toMatch(/Unknown setting/);
  });

  it("rejects order_number_next below minimum of 1", async () => {
    await expect(setSetting("order_number_next", 0)).rejects.toThrow(HttpError);
  });

  it("rejects session_timeout_minutes below minimum of 5", async () => {
    await expect(setSetting("session_timeout_minutes", 4)).rejects.toThrow(HttpError);
  });

  it("rejects session_timeout_minutes above maximum of 1440", async () => {
    await expect(setSetting("session_timeout_minutes", 1441)).rejects.toThrow(HttpError);
  });

  it("accepts session_timeout_minutes within valid range", async () => {
    await setSetting("session_timeout_minutes", 5);
    expect(await getSetting("session_timeout_minutes")).toBe(5);
  });

  it("allSettings consistency: invalid stored value falls back to default", async () => {
    await prisma.setting.create({
      data: { key: "request_days_default", value: "garbage" },
    });
    const all = await allSettings();
    expect(all.find((s) => s.key === "request_days_default")?.value).toBe(5);
    expect(await getSetting("request_days_default")).toBe(5);
  });

  it("session wiring: session timeout reads live setting", async () => {
    const user = await prisma.user.create({
      data: { username: "session-test", passwordHash: "x", displayName: "Session Test" },
    });
    await setSetting("session_timeout_minutes", 5);
    const now = Date.now();
    const { expiresAt } = await createSession(user.id);
    const diffMs = expiresAt.getTime() - now;
    const diffMins = diffMs / 60_000;
    expect(diffMins).toBeGreaterThanOrEqual(4);
    expect(diffMins).toBeLessThanOrEqual(6);
  });

  it("routes audit values through redact so secrets never land in the log", async () => {
    const beforeValue = { token: "sk-live-123", host: "qbo" };
    const afterValue = { token: "sk-live-456", host: "qbo-prod" };

    await auditSettingChange("test_sensitive_setting", beforeValue, afterValue);

    const [entry] = await readAudit("setting", "test_sensitive_setting");
    expect(entry.before).toEqual({ value: { token: "[redacted]", host: "qbo" } });
    expect(entry.after).toEqual({ value: { token: "[redacted]", host: "qbo-prod" } });
  });
});
