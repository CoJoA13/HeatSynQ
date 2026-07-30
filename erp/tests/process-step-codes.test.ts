import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import {
  listStepCodes, createStepCode, updateStepCode, deleteStepCode, setStepFields,
} from "@/server/process-step-codes";
import { createReference } from "@/server/reference";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";

describe("process step codes", () => {
  beforeEach(async () => await truncateAll());

  it("creates a code without a GL account and flags that it needs one", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    const [row] = await listStepCodes();
    expect(row).toMatchObject({ code: "HT-01", name: "Austenitize", glAccountId: null, needsGlAccount: true });
  });

  it("clears the needsGlAccount flag once an account is attached", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await updateStepCode(id, { glAccountId: gl.id });
    expect((await listStepCodes())[0].needsGlAccount).toBe(false);
  });

  it("rejects a duplicate code", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(createStepCode({ code: "HT-01", name: "Other" })).rejects.toThrow(HttpError);
  });

  it("stores ordered field definitions and returns them in sort order", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [
      { label: "Carbon potential", type: "NUMBER", sort: 3 },
      { label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
      { label: "Time", type: "NUMBER", unit: "min", sort: 2 },
    ]);
    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Temperature", "Time", "Carbon potential"]);
    expect(fields[0].unit).toBe("F");
  });

  it("a code with no fields is valid — Hot Wash is text only", async () => {
    const { id } = await createStepCode({ code: "WS-01", name: "Hot Wash" });
    await setStepFields(id, []);
    expect((await listStepCodes()).find((c) => c.id === id)?.fields).toEqual([]);
  });

  it("setStepFields replaces the whole set rather than appending", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    await setStepFields(id, [{ label: "Time", type: "NUMBER", sort: 1 }]);
    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Time"]);
  });

  it("rejects an unknown field type", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    // @ts-expect-error deliberately invalid type
    await expect(setStepFields(id, [{ label: "X", type: "COLOUR", sort: 1 }])).rejects.toThrow();
  });

  it("audits field changes with a diff that names the fields", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    const [entry] = await readAudit("processStepCode", id);
    const after = (entry.after as { fields: { label: string }[] }).fields.map((f) => f.label);
    expect(after).toEqual(["Temperature"]);
  });

  it("soft deletes", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await deleteStepCode(id);
    expect(await listStepCodes()).toHaveLength(0);
  });
});
