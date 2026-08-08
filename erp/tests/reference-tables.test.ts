import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { listReference, createReference, updateReference, deleteReference } from "@/server/reference";
import { pasteReference } from "@/server/paste";
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

  // F2: BASE's name was stored verbatim while resolveLinkNames() trimmed before its lookup, so a
  // name typed with surrounding whitespace could be displayed, submitted unchanged, and rejected
  // as "does not exist". Trimming on store keeps what's saved consistent with what's resolved.
  it("stores a name trimmed of surrounding whitespace", async () => {
    const { id } = await createReference("terms", { name: "  Net 45  " });
    const row = (await listReference("terms")).find((r) => r.id === id);
    expect(row?.name).toBe("Net 45");
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

// Task 4: Terms carries netDays (required going forward, default 30) and an optional
// discountPercent/discountDays early-pay-discount pair that is all-or-nothing.
describe("terms: netDays + early-pay discount", () => {
  beforeEach(async () => await truncateAll());

  it("defaults netDays to 30 when the create omits it", async () => {
    const { id } = await createReference("terms", { name: "Net 30 (default)" });
    const row = (await listReference("terms")).find((r) => r.id === id);
    expect(row?.netDays).toBe(30);
  });

  it("rejects a negative netDays", async () => {
    await expect(createReference("terms", { name: "Bad days", netDays: -1 })).rejects.toThrow();
  });

  it("rejects a non-integer netDays", async () => {
    await expect(createReference("terms", { name: "Fractional days", netDays: 30.5 })).rejects.toThrow();
  });

  it("requires discountPercent and discountDays together, not one alone", async () => {
    await expect(createReference("terms", { name: "Percent only", discountPercent: "2.00" }))
      .rejects.toThrow(/an early-pay discount needs both a percent and a day count/);
    await expect(createReference("terms", { name: "Days only", discountDays: 10 }))
      .rejects.toThrow(/an early-pay discount needs both a percent and a day count/);
  });

  it("round-trips 2/10 net 30 and persists through the audited path", async () => {
    const { id } = await createReference("terms", {
      name: "2/10 Net 30", netDays: 30, discountPercent: "2.00", discountDays: 10,
    });
    const row = (await listReference("terms")).find((r) => r.id === id);
    expect(row?.netDays).toBe(30);
    expect(Number(row?.discountPercent)).toBe(2);
    expect(row?.discountDays).toBe(10);

    const entry = await prisma.auditLog.findFirst({ where: { entity: "terms", entityId: id } });
    expect(entry).not.toBeNull();
    const after = entry!.after as { netDays: number; discountPercent: string; discountDays: number };
    expect(after.netDays).toBe(30);
    expect(Number(after.discountPercent)).toBe(2);
    expect(after.discountDays).toBe(10);
  });

  // Fix round 1, Important #2: guards the exact behavior EXTRA_SCHEMAS.terms's deliberately
  // no-`.default(30)` netDays relies on (reference.ts's comment on that entry). A `.default(30)`
  // fires whenever the key is undefined, including on a partial PATCH that never meant to touch
  // netDays — so a revert toward `.default(30)` would make THIS test fail: an unrelated update
  // (here, just flipping `active`) must never reset an existing non-default netDays back to 30.
  it("an update omitting netDays leaves an existing non-default value untouched", async () => {
    const { id } = await createReference("terms", { name: "Net 45", netDays: 45 });
    await updateReference("terms", id, { active: false });
    // includeInactive: the update just deactivated this row, and the default listReference()
    // call (like the grid's default view) only returns active rows.
    const row = (await listReference("terms", { includeInactive: true })).find((r) => r.id === id);
    expect(row?.active).toBe(false);
    expect(row?.netDays).toBe(45);
  });

  // Fix round 1, Minor: paste.ts's numberColumns conversion (netDays/discountDays cells arrive as
  // plain sheet strings, same as the ReferenceTable Add row) was untested — this exercises it
  // end-to-end through pasteReference rather than createReference directly. Column order matches
  // REFERENCE_EXTRA_FIELDS.terms: name, netDays, discountPercent, discountDays.
  it("paste converts numeric netDays/discountDays cells for a terms row", async () => {
    const result = await pasteReference("terms", "2/10 Net 45\t45\t2.00\t10");
    expect(result).toEqual({ created: 1, errors: [] });
    const row = (await listReference("terms")).find((r) => r.name === "2/10 Net 45");
    expect(row?.netDays).toBe(45);
    expect(row?.discountDays).toBe(10);
    expect(Number(row?.discountPercent)).toBe(2);
  });

});
