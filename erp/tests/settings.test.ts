import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { getSetting, setSetting, allSettings } from "@/server/settings";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/http";

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
});
