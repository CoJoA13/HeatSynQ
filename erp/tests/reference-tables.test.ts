import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { listReference, createReference } from "@/server/reference";
import { REFERENCE_KINDS } from "@/lib/reference-constants";
import { HttpError } from "@/server/errors";

describe("flat reference tables", () => {
  beforeEach(async () => await truncateAll());

  it("exposes every kind the owner needs to key", () => {
    expect([...REFERENCE_KINDS].sort()).toEqual([
      "carrier", "commentSnippet", "containerType", "glAccount", "inspectionCode",
      "inspectionScale", "material", "paymentType", "salesperson", "specification", "terms",
    ]);
  });

  it("round-trips create+list for every kind", async () => {
    for (const kind of REFERENCE_KINDS) {
      await createReference(kind, { name: `${kind}-1` });
      const rows = await listReference(kind);
      expect(rows, kind).toHaveLength(1);
      expect(rows[0].name, kind).toBe(`${kind}-1`);
    }
  });

  it("rejects duplicate names on every kind", async () => {
    for (const kind of REFERENCE_KINDS) {
      await createReference(kind, { name: "dup" });
      await expect(createReference(kind, { name: "dup" }), kind).rejects.toThrow(HttpError);
    }
  });

  it("inspection code carries an optional default scale", async () => {
    const scale = await createReference("inspectionScale", { name: "Brinell" });
    const { id } = await createReference("inspectionCode", { name: "HB", defaultScaleId: scale.id });
    const row = (await listReference("inspectionCode")).find((r) => r.id === id);
    expect(row?.defaultScaleId).toBe(scale.id);
  });

  it("payment type carries an optional GL account", async () => {
    const gl = await createReference("glAccount", { name: "1010" });
    const { id } = await createReference("paymentType", { name: "Check", glAccountId: gl.id });
    const row = (await listReference("paymentType")).find((r) => r.id === id);
    expect(row?.glAccountId).toBe(gl.id);
  });

  it("comment snippet and specification carry a text body", async () => {
    await createReference("commentSnippet", { name: "Liability", text: "Seller's liability is limited to…" });
    await createReference("specification", { name: "AMS 2759/1", text: "Heat treatment of steel parts" });
    expect((await listReference("commentSnippet"))[0].text).toMatch(/liability/i);
    expect((await listReference("specification"))[0].text).toMatch(/steel/i);
  });

  it("rejects an unknown extra field rather than silently dropping it", async () => {
    await expect(createReference("material", { name: "1045", bogus: true })).rejects.toThrow();
  });
});
