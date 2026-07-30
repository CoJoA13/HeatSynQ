import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { parseTsv, pasteReference } from "@/server/paste";
import { listReference, createReference } from "@/server/reference";

describe("paste entry", () => {
  beforeEach(async () => await truncateAll());

  it("parses tab-separated rows into column-keyed objects", () => {
    const rows = parseTsv("4010\tHeat Treat\n4020\tStraightening", ["name", "description"]);
    expect(rows).toEqual([
      { name: "4010", description: "Heat Treat" },
      { name: "4020", description: "Straightening" },
    ]);
  });

  it("ignores blank lines and trims cells", () => {
    expect(parseTsv("  4010 \t Heat Treat \n\n\n", ["name", "description"]))
      .toEqual([{ name: "4010", description: "Heat Treat" }]);
  });

  it("tolerates short rows by filling missing columns with empty strings", () => {
    expect(parseTsv("4010", ["name", "description"])).toEqual([{ name: "4010", description: "" }]);
  });

  it("bulk-creates and reports the count", async () => {
    const result = await pasteReference("glAccount", "4010\tHeat Treat\n4020\tStraightening");
    expect(result).toEqual({ created: 2, errors: [] });
    expect(await listReference("glAccount")).toHaveLength(2);
  });

  it("reports per-row errors by 1-based row number and still commits the good rows", async () => {
    await createReference("glAccount", { name: "4010" });
    const result = await pasteReference("glAccount", "4010\tDup\n4030\tFine\n\t\tBlank name");
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].row).toBe(1);
    expect(result.errors[0].message).toMatch(/already exists/i);
    expect(result.errors[1].row).toBe(3);
    const names = (await listReference("glAccount")).map((r) => r.name).sort();
    expect(names).toEqual(["4010", "4030"]);
  });

  it("rejects an unknown kind", async () => {
    await expect(pasteReference("nope", "x")).rejects.toMatchObject({ status: 400 });
  });
});
