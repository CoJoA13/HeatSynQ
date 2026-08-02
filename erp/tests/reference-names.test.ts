import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll, prisma } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { listReference, createReference, updateReference, deleteReference } from "@/server/reference";
import { pasteReference } from "@/server/paste";
import { GET as exportRoute } from "@/app/api/admin/reference/[kind]/export/route";

describe("reference FK name resolution", () => {
  beforeEach(async () => await truncateAll());

  it("lists the target's name beside the id, not a bare cuid", async () => {
    const scale = await createReference("inspectionScale", { name: "Rockwell C" });
    await createReference("inspectionCode", { name: "HRC-1", defaultScaleId: scale.id });

    const [row] = await listReference("inspectionCode");
    expect(row.defaultScaleId).toBe(scale.id);
    expect(row.defaultScaleName).toBe("Rockwell C");
  });

  it("resolves an INACTIVE target — inactive hides from pick lists, it does not invalidate data", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    await createReference("paymentType", { name: "Check", glAccountId: gl.id });
    await updateReference("glAccount", gl.id, { active: false });

    const [row] = await listReference("paymentType");
    expect(row.glAccountName).toBe("4010");
  });

  it("leaves the name null when the column is null", async () => {
    await createReference("paymentType", { name: "Cash" });
    const [row] = await listReference("paymentType");
    expect(row.glAccountId).toBeNull();
    expect(row.glAccountName).toBeNull();
  });

  it("leaves the name null when the target was soft-deleted out from under it", async () => {
    // assertRefExists-style guards, and now deleteReference's own reference-delete guard
    // (Task 5), stop this arising going forward — deleteReference would refuse here because a
    // live inspectionCode still points at the scale. Rows predating both guards exist, so the
    // legacy state is simulated directly against Prisma rather than through the (correctly)
    // guarded service call; the list must still degrade to a null name rather than throwing.
    const scale = await createReference("inspectionScale", { name: "Brinell" });
    await createReference("inspectionCode", { name: "HB-1", defaultScaleId: scale.id });
    await prisma.inspectionScale.update({ where: { id: scale.id }, data: { deletedAt: new Date() } });

    const [row] = await listReference("inspectionCode");
    expect(row.defaultScaleName).toBeNull();
  });

  it("exports the resolved name, not the cuid", async () => {
    const scale = await createReference("inspectionScale", { name: "Rockwell C" });
    await createReference("inspectionCode", { name: "HRC-1", defaultScaleId: scale.id });

    const cookie = await signInWith(["admin.view"]);
    const res = await exportRoute(
      new Request("http://x/api/admin/reference/inspectionCode/export", { headers: { cookie } }),
      { params: Promise.resolve({ kind: "inspectionCode" }) });
    const buf = Buffer.from(await res.arrayBuffer());

    // xlsx is a zip; the shared-strings part carries cell text. Asserting on the bytes keeps
    // this a real round-trip rather than a re-assertion of what the route already returned.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const values = wb.getWorksheet(1)!.getRow(2).values as unknown[];
    expect(values).toContain("Rockwell C");
    expect(values.join(" ")).not.toContain(scale.id);
  });

  it("creates by name instead of cuid", async () => {
    await createReference("inspectionScale", { name: "Rockwell C" });
    const { id } = await createReference("inspectionCode", { name: "HRC-1", defaultScaleName: "Rockwell C" });
    const row = (await listReference("inspectionCode")).find((r) => r.id === id)!;
    expect(row.defaultScaleName).toBe("Rockwell C");
  });

  // F2: before BASE trimmed on store, a name typed with surrounding whitespace was saved
  // verbatim while resolveLinkNames() trimmed before its findFirst lookup — so the grid could
  // display the stored name, submit it exactly, and get a false "does not exist". This proves
  // the round trip: the source name is created WITH whitespace, and the FK assignment uses
  // exactly the (now-trimmed) name the grid would display.
  it("resolves a name-based FK assignment using the displayed (trimmed) name", async () => {
    const scale = await createReference("inspectionScale", { name: "  Rockwell C  " });
    const displayed = (await listReference("inspectionScale")).find((r) => r.id === scale.id)!.name;
    expect(displayed).toBe("Rockwell C");

    const { id } = await createReference("inspectionCode", { name: "HRC-1", defaultScaleName: displayed });
    const row = (await listReference("inspectionCode")).find((r) => r.id === id);
    expect(row?.defaultScaleId).toBe(scale.id);
  });

  it("rejects an unknown name with a field-anchored message naming the value", async () => {
    await expect(createReference("inspectionCode", { name: "HRC-1", defaultScaleName: "Nope" }))
      .rejects.toThrow(/Default scale.*Nope/i);
  });

  it("rejects a name that matches only a soft-deleted row", async () => {
    const scale = await createReference("inspectionScale", { name: "Gone" });
    await deleteReference("inspectionScale", scale.id);
    await expect(createReference("inspectionCode", { name: "HRC-2", defaultScaleName: "Gone" }))
      .rejects.toThrow(/Default scale/i);
  });

  it("updates by name", async () => {
    const a = await createReference("inspectionScale", { name: "Rockwell C" });
    await createReference("inspectionScale", { name: "Brinell" });
    const code = await createReference("inspectionCode", { name: "HRC-1", defaultScaleId: a.id });
    await updateReference("inspectionCode", code.id, { defaultScaleName: "Brinell" });
    const row = (await listReference("inspectionCode")).find((r) => r.id === code.id)!;
    expect(row.defaultScaleName).toBe("Brinell");
  });

  it("pastes by name, reporting unknown names per row without discarding good rows", async () => {
    await createReference("inspectionScale", { name: "Rockwell C" });
    const result = await pasteReference("inspectionCode", "HRC-1\tRockwell C\nHRC-2\tNope\nHRC-3\tRockwell C");
    expect(result.created).toBe(2);
    expect(result.errors).toEqual([{ row: 2, message: expect.stringMatching(/Default scale.*Nope/i) }]);
  });
});
