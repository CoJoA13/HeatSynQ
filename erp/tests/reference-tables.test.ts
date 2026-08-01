import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { listReference, createReference, deleteReference } from "@/server/reference";
import { REFERENCE_KINDS } from "@/lib/reference-constants";
import { HttpError } from "@/server/errors";

describe("flat reference tables", () => {
  beforeEach(async () => await truncateAll());

  it("exposes every kind the owner needs to key", () => {
    expect([...REFERENCE_KINDS].sort()).toEqual([
      "carrier", "commentSnippet", "containerType", "glAccount", "inspectionCode",
      "inspectionScale", "material", "paymentType", "specification", "terms",
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

  // `setup` returns the non-default extra value to seed the first row with. The two FK fields
  // (inspectionCode.defaultScaleId, paymentType.glAccountId) can't be a static literal — a real
  // row has to exist first to reference — so every entry gets a callback, run inside the test
  // body, rather than mixing static objects with FK lookups.
  const KINDS_WITH_EXTRAS = [
    { kind: "glAccount", setup: async () => ({ description: "old" }), field: "description", fresh: "" },
    {
      kind: "inspectionCode",
      setup: async () => ({ defaultScaleId: (await createReference("inspectionScale", { name: "Brinell" })).id }),
      field: "defaultScaleId", fresh: null,
    },
    {
      kind: "paymentType",
      setup: async () => ({ glAccountId: (await createReference("glAccount", { name: "1010" })).id }),
      field: "glAccountId", fresh: null,
    },
    { kind: "commentSnippet", setup: async () => ({ text: "old" }), field: "text", fresh: "" },
    { kind: "specification", setup: async () => ({ text: "old" }), field: "text", fresh: "" },
  ] as const;

  it.each(KINDS_WITH_EXTRAS)(
    "$kind: a re-created name is a new row with default extras",
    async ({ kind, setup, field, fresh }) => {
      const extra = await setup();
      const first = await createReference(kind, { name: "X1", ...extra });

      // The predecessor must genuinely hold the non-default value — otherwise the reset check
      // below would pass even if createReference never applied `extra` in the first place.
      const firstRow = (await listReference(kind)).find((r) => r.id === first.id);
      expect(firstRow?.[field]).not.toBe(fresh);

      await deleteReference(kind, first.id);
      const second = await createReference(kind, { name: "X1" });
      expect(second.id).not.toBe(first.id);
      const rows = await listReference(kind);
      expect(rows.find((r) => r.id === second.id)?.[field]).toBe(fresh);
    },
  );

  it("rejects an unknown extra field rather than silently dropping it", async () => {
    await expect(createReference("material", { name: "1045", bogus: true })).rejects.toThrow();
  });

  it("rejects a bad defaultScaleId with a clean 400, not a raw Prisma FK error", async () => {
    expect.assertions(3);
    try {
      await createReference("inspectionCode", { name: "HB", defaultScaleId: "nope" });
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
      const message = (err as { message: string }).message;
      expect(message.toLowerCase()).not.toContain("fkey");
      expect(message.toLowerCase()).toContain("does not exist");
    }
  });

  it("rejects a bad glAccountId with a clean 400, not a raw Prisma FK error", async () => {
    expect.assertions(3);
    try {
      await createReference("paymentType", { name: "Check", glAccountId: "nope" });
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
      const message = (err as { message: string }).message;
      expect(message.toLowerCase()).not.toContain("fkey");
      expect(message.toLowerCase()).toContain("does not exist");
    }
  });
});
