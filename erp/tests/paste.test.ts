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

  it("reports a readable sentence for a blank name, not a raw ZodError dump", async () => {
    const result = await pasteReference("glAccount", "\tHeat Treat");
    expect(result.created).toBe(0);
    expect(result.errors).toEqual([
      { row: 1, message: "name: Too small: expected string to have >=1 characters" },
    ]);
  });

  it("reports a readable sentence for a duplicate name", async () => {
    await createReference("glAccount", { name: "4010" });
    const result = await pasteReference("glAccount", "4010\tDup");
    expect(result.errors).toEqual([
      { row: 1, message: "A gl account with that name already exists" },
    ]);
  });

  it("reports a row with more cells than the kind has columns, instead of silently truncating", async () => {
    const result = await pasteReference("glAccount", "9999\tDescription here\tEXTRA_COLUMN_VALUE");
    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(1);
    expect(result.errors[0].message).toMatch(/too many columns/i);
    expect(await listReference("glAccount")).toHaveLength(0);
  });

  it("accepts a trailing tab on a 2-column kind — Excel's empty trailing cell carries no data", async () => {
    const result = await pasteReference("glAccount", "4010\tHeat Treat\t");
    expect(result).toEqual({ created: 1, errors: [] });
    expect(await listReference("glAccount")).toHaveLength(1);
  });

  it("accepts a trailing tab on a 1-column kind", async () => {
    const result = await pasteReference("carrier", "UPS\t");
    expect(result).toEqual({ created: 1, errors: [] });
    expect(await listReference("carrier")).toHaveLength(1);
  });

  it("accepts multiple trailing tabs", async () => {
    const result = await pasteReference("glAccount", "4010\tDesc\t\t\t");
    expect(result).toEqual({ created: 1, errors: [] });
    expect(await listReference("glAccount")).toHaveLength(1);
  });

  it("still rejects a genuine extra value past the declared columns", async () => {
    const result = await pasteReference("glAccount", "4010\tDesc\tREAL_EXTRA");
    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/too many columns/i);
    expect(await listReference("glAccount")).toHaveLength(0);
  });

  it("treats a whitespace-only overflow cell as empty, not as genuine content", async () => {
    const result = await pasteReference("glAccount", "4010\tDesc\t   ");
    expect(result).toEqual({ created: 1, errors: [] });
    expect(await listReference("glAccount")).toHaveLength(1);
  });

  it("counts blank lines toward the row number so a failure after one still points at the right line", async () => {
    await createReference("glAccount", { name: "9010" });
    const result = await pasteReference("glAccount", "1111\tFirst\n\n9010\tDup");
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(3);
    expect(result.errors[0].message).toMatch(/already exists/i);
  });
});
