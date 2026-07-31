import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { listReference, createReference, deleteReference } from "@/server/reference";
import { REFERENCE_KINDS } from "@/lib/reference-constants";
import { HttpError } from "@/server/errors";

/** Drift-proof revival check shared by the extra-field kinds below: create a fresh row with
 *  minimal input, create-and-delete another with a non-default extra field, re-create it
 *  minimally, and assert the two rows are field-for-field identical apart from id/name. Mirrors
 *  the pattern already approved for customers.ts's REVIVAL_DEFAULTS and glAccount's equivalent
 *  test in reference-gl.test.ts — never assert a literal default value. */
async function expectRevivalResetsExtraFields(
  kind: "inspectionCode" | "paymentType" | "commentSnippet" | "specification",
  nonDefaultExtra: Record<string, unknown>,
) {
  await createReference(kind, { name: "fresh" });
  const [freshRow] = await listReference(kind, { includeInactive: true });

  const { id } = await createReference(kind, { name: "stale", ...nonDefaultExtra });
  await deleteReference(kind, id);

  const revived = await createReference(kind, { name: "stale" });
  expect(revived.id).toBe(id);
  const revivedRow = (await listReference(kind, { includeInactive: true })).find((r) => r.id === id)!;

  // listReference returns every column, including createdAt/updatedAt — genuinely distinct
  // timestamps between the two rows, not part of what revival is being checked against.
  const identityFields = ["id", "name", "createdAt", "updatedAt"] as const;
  const omitIdentity = (row: typeof freshRow) =>
    Object.fromEntries(Object.entries(row).filter(([k]) => !(identityFields as readonly string[]).includes(k)));
  expect(omitIdentity(revivedRow)).toEqual(omitIdentity(freshRow));
}

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

  it("revival resets extra fields for every kind that has one, not just active", async () => {
    // Fix 3 (final review): each of these extra fields is optional on createReference's input,
    // so a revived row used to keep its predecessor's value when the caller didn't supply one.
    const scale = await createReference("inspectionScale", { name: "Brinell" });
    await expectRevivalResetsExtraFields("inspectionCode", { defaultScaleId: scale.id });

    const gl = await createReference("glAccount", { name: "1010" });
    await expectRevivalResetsExtraFields("paymentType", { glAccountId: gl.id });

    await expectRevivalResetsExtraFields("commentSnippet", { text: "Old liability text" });
    await expectRevivalResetsExtraFields("specification", { text: "Old spec text" });
  });

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
