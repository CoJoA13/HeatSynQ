import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { listReference, createReference, updateReference, deleteReference } from "@/server/reference";
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
    // assertTermsExists-style guards stop this arising going forward, but rows predating the
    // guard exist; the list must degrade to a null name rather than throwing.
    const scale = await createReference("inspectionScale", { name: "Brinell" });
    await createReference("inspectionCode", { name: "HB-1", defaultScaleId: scale.id });
    await deleteReference("inspectionScale", scale.id);

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
});
