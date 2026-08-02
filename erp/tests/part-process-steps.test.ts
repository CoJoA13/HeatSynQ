import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  getRevisions, getRevision, addStep, updateStep, removeStep, reorderSteps, lockRevision,
} from "@/server/part-process-steps";
import { readAudit } from "@/server/audit";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** customer -> part -> step code HT-01 with a NUMBER def "Temperature", all via raw prisma —
 *  the steps service under test doesn't (and shouldn't) depend on process-step-codes.ts's own
 *  service layer to set up its own fixtures. */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  const fieldDef = await prisma.processStepFieldDef.create({
    data: { codeId: code.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
  });
  return { customer, part, code, fieldDef };
}

describe("part process steps: the revision-cut rule", () => {
  beforeEach(truncateAll);

  it("first mutation lazily creates revision 1", async () => {
    const { part, code } = await fixture();
    expect(await getRevisions(part.id)).toEqual([]);

    const { revisionNumber, stepId } = await asSystem(() => addStep(part.id, { codeId: code.id }));
    expect(revisionNumber).toBe(1);
    expect(stepId).toBeTruthy();

    const revs = await getRevisions(part.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ revisionNumber: 1, lockedAt: null, stepCount: 1 });
    expect(revs[0].createdAt).toBeInstanceOf(Date);
  });

  it("amend-in-place: edits before a lock keep the revision id and number", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "A" }));
    const revId1 = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;

    const r2 = await asSystem(() => updateStep(part.id, stepId, { instruction: "B" }));
    const r3 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "C" }));
    expect(r2.revisionNumber).toBe(1);
    expect(r3.revisionNumber).toBe(1);

    const revId2 = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;
    expect(revId2).toBe(revId1);

    expect(await getRevisions(part.id)).toHaveLength(1);
    const detail = await getRevision(part.id, 1);
    expect(detail.steps).toHaveLength(2);
    expect(detail.steps[0]).toMatchObject({ id: stepId, instruction: "B" });
  });

  it("post-lock edit cuts N+1 copying steps and values, then applies the change", async () => {
    const { part, code, fieldDef } = await fixture();
    const { stepId } = await asSystem(() => addStep(part.id, {
      codeId: code.id, instruction: "A", values: [{ fieldDefId: fieldDef.id, value: "1650" }],
    }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));

    const { revisionNumber } = await asSystem(() => updateStep(part.id, stepId, { instruction: "B" }));
    expect(revisionNumber).toBe(2);

    const rev2 = await getRevision(part.id, 2);
    expect(rev2.steps).toHaveLength(1);
    expect(rev2.steps[0].instruction).toBe("B");
    expect(rev2.steps[0].values.find((v) => v.fieldDefId === fieldDef.id)?.value).toBe("1650");

    // rev 1 re-read: instruction still "A", value still "1650", same step id as before.
    const rev1 = await getRevision(part.id, 1);
    expect(rev1.steps).toHaveLength(1);
    expect(rev1.steps[0].id).toBe(stepId);
    expect(rev1.steps[0].instruction).toBe("A");
    expect(rev1.steps[0].values.find((v) => v.fieldDefId === fieldDef.id)?.value).toBe("1650");
  });

  it("a locked revision's content is byte-identical after post-lock edits", async () => {
    const { part, code, fieldDef } = await fixture();
    await asSystem(() => addStep(part.id, {
      codeId: code.id, instruction: "A", values: [{ fieldDefId: fieldDef.id, value: "1650" }],
    }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const before = await getRevision(part.id, 1);

    // Cuts to rev 2 and adds a step there — rev 1 must be untouched.
    await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "in rev 2 now" }));
    expect(await getRevisions(part.id)).toHaveLength(2);

    const after = await getRevision(part.id, 1);
    expect(after).toEqual(before);
  });

  // The single-step cut tests above can't distinguish a correct position-keyed copy from a bug
  // that maps every superseded step id to (say) the last copy — with only one step, any mapping
  // looks identical. Three steps, editing the MIDDLE one by its rev-1 id, forces the map to be
  // right per-step: a wrong mapping would either 404 (id not found) or land the edit on the
  // wrong step.
  it("cut preserves every step's position and values across the copy; the edit lands on only the targeted step", async () => {
    const { part, code, fieldDef } = await fixture();
    const s1 = await asSystem(() => addStep(part.id, {
      codeId: code.id, instruction: "one", values: [{ fieldDefId: fieldDef.id, value: "100" }],
    }));
    const s2 = await asSystem(() => addStep(part.id, {
      codeId: code.id, instruction: "two", values: [{ fieldDefId: fieldDef.id, value: "200" }],
    }));
    const s3 = await asSystem(() => addStep(part.id, {
      codeId: code.id, instruction: "three", values: [{ fieldDefId: fieldDef.id, value: "300" }],
    }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));

    // Named by its rev-1 id — the only id the caller could have, since rev 2 doesn't exist yet.
    const { revisionNumber } = await asSystem(() => updateStep(part.id, s2.stepId, { instruction: "TWO-edited" }));
    expect(revisionNumber).toBe(2);

    const rev2 = await getRevision(part.id, 2);
    expect(rev2.steps).toHaveLength(3);
    expect(rev2.steps.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(rev2.steps.map((s) => s.instruction)).toEqual(["one", "TWO-edited", "three"]);
    expect(rev2.steps.map((s) => s.values.find((v) => v.fieldDefId === fieldDef.id)?.value))
      .toEqual(["100", "200", "300"]); // every value copied, including the untouched neighbors'

    // rev 1 remains fully intact, not just the one step someone might have thought to check.
    const rev1 = await getRevision(part.id, 1);
    expect(rev1.steps.map((s) => s.instruction)).toEqual(["one", "two", "three"]);
    expect(rev1.steps.map((s) => s.id)).toEqual([s1.stepId, s2.stepId, s3.stepId]);
  });

  it("reorderSteps resolves rev-1 step ids through the cut immediately after a lock", async () => {
    const { part, code } = await fixture();
    const s1 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "one" }));
    const s2 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "two" }));
    const s3 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "three" }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));

    // The working revision (rev 2) doesn't exist until this call — the rev-1 ids are the only
    // ones the caller could possibly send.
    const { revisionNumber } = await asSystem(() => reorderSteps(part.id, [s3.stepId, s1.stepId, s2.stepId]));
    expect(revisionNumber).toBe(2);

    const rev2 = await getRevision(part.id, 2);
    expect(rev2.steps.map((s) => s.instruction)).toEqual(["three", "one", "two"]);
    expect(rev2.steps.map((s) => s.position)).toEqual([1, 2, 3]);

    const rev1 = await getRevision(part.id, 1);
    expect(rev1.steps.map((s) => s.instruction)).toEqual(["one", "two", "three"]);
  });

  it("lockRevision is idempotent and 404s on a missing revision", async () => {
    const { part, code } = await fixture();
    await asSystem(() => addStep(part.id, { codeId: code.id }));
    const revId = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;
    // addStep already wrote its own create+update pair against this same entityId, so the
    // baseline count (not just entries[0]) is what proves the lock itself wrote something.
    const auditBeforeLock = await readAudit("partProcessRevision", revId);

    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const auditAfterFirstLock = await readAudit("partProcessRevision", revId);
    expect(auditAfterFirstLock).toHaveLength(auditBeforeLock.length + 1);
    const lockEntry = auditAfterFirstLock[0];
    expect(lockEntry.action).toBe("update");
    expect((lockEntry.after as { lockedAt: string | null }).lockedAt).not.toBeNull();
    const lockedAtAfterFirst =
      (await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: revId } })).lockedAt;
    expect(lockedAtAfterFirst).not.toBeNull();

    // A second lock is a silent no-op — no error, no new audit entry, and the timestamp itself
    // is untouched (not just "still non-null" — a re-stamped lockedAt would also pass a weaker
    // check).
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const auditAfterSecondLock = await readAudit("partProcessRevision", revId);
    expect(auditAfterSecondLock).toHaveLength(auditAfterFirstLock.length);
    const lockedAtAfterSecond =
      (await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: revId } })).lockedAt;
    expect(lockedAtAfterSecond).toEqual(lockedAtAfterFirst);

    await expect(asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 99, tx))))
      .rejects.toMatchObject({ status: 404 });
  });

  it("a stepId from a superseded revision 404s", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => addStep(part.id, { codeId: code.id }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    // Cuts to rev 2 (a different mutation than the one under test, on purpose — proves the
    // superseded id is rejected regardless of who caused the cut).
    await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "cuts to rev 2" }));

    await expect(asSystem(() => updateStep(part.id, stepId, { instruction: "x" })))
      .rejects.toMatchObject({ status: 404, message: "That step belongs to a superseded revision" });
    await expect(asSystem(() => removeStep(part.id, stepId)))
      .rejects.toMatchObject({ status: 404, message: "That step belongs to a superseded revision" });
  });

  it("values are typed per StepFieldType with field-anchored messages; empty string deletes the value row", async () => {
    const { part, code, fieldDef } = await fixture(); // fieldDef: NUMBER "Temperature"
    const dateDef = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Heat date", type: "DATE", sort: 2 },
    });
    const checkboxDef = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Certified", type: "CHECKBOX", sort: 3 },
    });
    const textDef = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Notes", type: "TEXT", sort: 4 },
    });

    await expect(asSystem(() => addStep(part.id, {
      codeId: code.id, values: [{ fieldDefId: fieldDef.id, value: "hot" }],
    }))).rejects.toThrow('"hot" is not a valid number for Temperature');

    await expect(asSystem(() => addStep(part.id, {
      codeId: code.id, values: [{ fieldDefId: dateDef.id, value: "2025-02-29" }],
    }))).rejects.toThrow('"2025-02-29" is not a valid date (yyyy-mm-dd) for Heat date');

    await expect(asSystem(() => addStep(part.id, {
      codeId: code.id, values: [{ fieldDefId: checkboxDef.id, value: "yes" }],
    }))).rejects.toThrow("Certified must be true or false");

    // TEXT accepts free-form text up to the value schema's own 500-char cap (VALUE_ITEM), which
    // makes validateStepValue's own TEXT-length guard defensively unreachable through the
    // public API — the mirrored part-field-values.ts shape keeps it anyway as a second line of
    // defense (its VALUES schema has no such cap, so the equivalent branch there IS reachable).
    await expect(asSystem(() => addStep(part.id, {
      codeId: code.id, values: [{ fieldDefId: textDef.id, value: "x".repeat(501) }],
    }))).rejects.toThrow();

    // A def from a different code 400s distinctly.
    const otherCode = await prisma.processStepCode.create({ data: { code: "WS-01", name: "Wash" } });
    await expect(asSystem(() => addStep(part.id, {
      codeId: otherCode.id, values: [{ fieldDefId: fieldDef.id, value: "1650" }],
    }))).rejects.toThrow("That field does not belong to this step's code");

    // Valid values of every type are accepted together, including a real leap day.
    const { stepId } = await asSystem(() => addStep(part.id, {
      codeId: code.id,
      values: [
        { fieldDefId: fieldDef.id, value: "1650" },
        { fieldDefId: dateDef.id, value: "2024-02-29" },
        { fieldDefId: checkboxDef.id, value: "true" },
        { fieldDefId: textDef.id, value: "ok" },
      ],
    }));
    let values = (await getRevision(part.id, 1)).steps[0].values;
    expect(values.find((v) => v.fieldDefId === fieldDef.id)?.value).toBe("1650");
    expect(values.find((v) => v.fieldDefId === dateDef.id)?.value).toBe("2024-02-29");
    expect(values.find((v) => v.fieldDefId === checkboxDef.id)?.value).toBe("true");
    expect(values.find((v) => v.fieldDefId === textDef.id)?.value).toBe("ok");

    // Empty string clears the row entirely (spec §4 — only non-empty values are stored).
    await asSystem(() => updateStep(part.id, stepId, { values: [{ fieldDefId: fieldDef.id, value: "" }] }));
    values = (await getRevision(part.id, 1)).steps[0].values;
    expect(values.find((v) => v.fieldDefId === fieldDef.id)).toBeUndefined();
    expect(values).toHaveLength(3);
  });

  it("addStep 400s on a soft-deleted code and accepts an inactive one", async () => {
    const { part } = await fixture();
    const deletedCode = await prisma.processStepCode.create({
      data: { code: "DEL-01", name: "Deleted", deletedAt: new Date() },
    });
    await expect(asSystem(() => addStep(part.id, { codeId: deletedCode.id })))
      .rejects.toMatchObject({ status: 400 });

    const inactiveCode = await prisma.processStepCode.create({
      data: { code: "INA-01", name: "Inactive", active: false },
    });
    const { stepId } = await asSystem(() => addStep(part.id, { codeId: inactiveCode.id }));
    expect(stepId).toBeTruthy();
  });

  it("reorder is atomic and keeps positions 1..n", async () => {
    const { part, code } = await fixture();
    const s1 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "one" }));
    const s2 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "two" }));
    const s3 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "three" }));

    const { revisionNumber } = await asSystem(() => reorderSteps(part.id, [s3.stepId, s1.stepId, s2.stepId]));
    expect(revisionNumber).toBe(1);

    const detail = await getRevision(part.id, 1);
    expect(detail.steps.map((s) => s.id)).toEqual([s3.stepId, s1.stepId, s2.stepId]);
    expect(detail.steps.map((s) => s.position)).toEqual([1, 2, 3]);

    // Atomic: a set that doesn't name every live step exactly once is rejected wholesale, and
    // the previous successful order is left untouched.
    await expect(asSystem(() => reorderSteps(part.id, [s3.stepId, s1.stepId])))
      .rejects.toMatchObject({ status: 400 });
    await expect(asSystem(() => reorderSteps(part.id, [s3.stepId, s1.stepId, s2.stepId, "nonexistent"])))
      .rejects.toMatchObject({ status: 400 });

    const unchanged = await getRevision(part.id, 1);
    expect(unchanged.steps.map((s) => s.id)).toEqual([s3.stepId, s1.stepId, s2.stepId]);
    expect(unchanged.steps.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it("removeStep closes the position gap", async () => {
    const { part, code } = await fixture();
    const s1 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "one" }));
    const s2 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "two" }));
    const s3 = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "three" }));

    const { revisionNumber } = await asSystem(() => removeStep(part.id, s2.stepId));
    expect(revisionNumber).toBe(1);

    const detail = await getRevision(part.id, 1);
    expect(detail.steps.map((s) => s.id)).toEqual([s1.stepId, s3.stepId]);
    expect(detail.steps.map((s) => s.position)).toEqual([1, 2]);

    // The removed step's value rows are gone too, not orphaned.
    const orphanedValues = await prisma.partProcessStepValue.findMany({ where: { stepId: s2.stepId } });
    expect(orphanedValues).toEqual([]);
  });

  it("audit: a step edit writes a revision-level update whose after-snapshot shows the change", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => addStep(part.id, { codeId: code.id, instruction: "A" }));
    const revId = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;

    await asSystem(() => updateStep(part.id, stepId, { instruction: "B" }));

    const entries = await readAudit("partProcessRevision", revId);
    expect(entries[0].action).toBe("update");
    const after = entries[0].after as { steps: { instruction: string }[] };
    expect(after.steps.some((s) => s.instruction === "B")).toBe(true);
    const before = entries[0].before as { steps: { instruction: string }[] };
    expect(before.steps.some((s) => s.instruction === "B")).toBe(false);
  });

  it("getRevisions/getRevision 404 on a missing part, a deleted part, or a missing revision number", async () => {
    await expect(getRevisions("nonexistent")).rejects.toMatchObject({ status: 404 });
    await expect(getRevision("nonexistent", 1)).rejects.toMatchObject({ status: 404 });

    const { part, code } = await fixture();
    await asSystem(() => addStep(part.id, { codeId: code.id }));
    await expect(getRevision(part.id, 2)).rejects.toMatchObject({ status: 404 });

    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    await expect(getRevisions(part.id)).rejects.toMatchObject({ status: 404 });
    await expect(getRevision(part.id, 1)).rejects.toMatchObject({ status: 404 });
  });
});
