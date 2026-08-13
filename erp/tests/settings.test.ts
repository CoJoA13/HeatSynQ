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

  // Fix-wave finding 5: request_days_default feeds addBusinessDays' own day-at-a-time loop
  // (src/lib/business-days.ts), which now caps at 3650 days — bounded here too so a bad plant
  // default is refused at the settings page, not surfaced later as a generic order-entry error.
  it("rejects request_days_default above the 3650-day cap, and allows exactly the boundary", async () => {
    await expect(setSetting("request_days_default", 3651)).rejects.toThrow(HttpError);
    await setSetting("request_days_default", 3650);
    expect(await getSetting("request_days_default")).toBe(3650);
  });

  // Fix-wave finding 8: Order.orderNumber (and every other *_number_next consumer) is a Postgres
  // INTEGER (int4) column — a stored value past 2147483647 makes every allocation against it fail
  // at the database rather than being refused where the setting is actually entered.
  it.each([
    "order_number_next", "shipper_number_next", "invoice_number_next", "cert_number_next", "quote_number_next",
    "bol_number_next",
  ] as const)("rejects %s above Int4 max (2147483647), and allows exactly the boundary", async (key) => {
    await expect(setSetting(key, 2_147_483_648)).rejects.toThrow(HttpError);
    await setSetting(key, 2_147_483_647);
    expect(await getSetting(key)).toBe(2_147_483_647);
  });

  // Phase 4: the five new settings this task adds (bol_number_next, cert_required_default,
  // cert_scope_default, cert_statement, shipper_liability_text) — each round-trips through
  // getSetting/setSetting, and the two enum-shaped ones reject values outside their schema.
  it("round-trips bol_number_next", async () => {
    expect(await getSetting("bol_number_next")).toBe(1000);
    await setSetting("bol_number_next", 2000);
    expect(await getSetting("bol_number_next")).toBe(2000);
  });

  it("round-trips cert_required_default and rejects a non-boolean value", async () => {
    expect(await getSetting("cert_required_default")).toBe(false);
    await setSetting("cert_required_default", true);
    expect(await getSetting("cert_required_default")).toBe(true);
    await expect(setSetting("cert_required_default", "yes")).rejects.toThrow(HttpError);
  });

  it("round-trips cert_scope_default and rejects a value outside CERT_SCOPES", async () => {
    expect(await getSetting("cert_scope_default")).toBe("ORDER");
    await setSetting("cert_scope_default", "SHIPMENT");
    expect(await getSetting("cert_scope_default")).toBe("SHIPMENT");
    const err = await setSetting("cert_scope_default", "ORDERS").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  });

  // Phase 7 Task 14: the four standing-text keys (cert_statement / shipper_liability_text /
  // quote_intro_text / quote_liability_text) are RETIRED — every document builder is now a
  // config-consumer and each standing text lives in its template's own text block (spec §8). The
  // keys leave the registry; a read or write of any of them is now an "Unknown setting" refusal.
  it.each([
    "cert_statement", "shipper_liability_text", "quote_intro_text", "quote_liability_text",
  ])("refuses the retired standing-text key %s", async (key) => {
    const err = await setSetting(key, "anything").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toMatch(/Unknown setting/);
  });

  it("round-trips the invoice number prefix", async () => {
    await setSetting("invoice_number_prefix", "7");
    expect(await getSetting("invoice_number_prefix")).toBe("7");
  });

  it("rejects a zero credit number seed", async () => {
    await expect(setSetting("credit_number_next", 0)).rejects.toThrow(/Invalid|Too small/i);
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
