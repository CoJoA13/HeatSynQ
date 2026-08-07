import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  listSurcharges, createSurcharge, updateSurcharge, deleteSurcharge,
  setSurchargeStepCodes, listCustomerSurcharges, setCustomerSurcharge, deleteCustomerSurcharge,
} from "@/server/surcharges";
import { deleteStepCode } from "@/server/process-step-codes";
import { findBlockers } from "@/server/reference-blockers";
import { readAudit } from "@/server/audit";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("surcharges", () => {
  beforeEach(truncateAll);

  it("creates a percent surcharge and lists it with its GL account name", async () => {
    const gl = await prisma.glAccount.create({ data: { name: "4200", description: "Energy surcharge" } });
    await asSystem(() => createSurcharge({
      name: "EnergySur", kind: "PERCENT", rate: "0.040000", glAccountId: gl.id, scope: "ALL", position: 1 }));
    const rows = await listSurcharges();
    expect(rows[0].name).toBe("EnergySur");
    expect(rows[0].rate).toBe(0.04);
    expect(rows[0].glAccountName).toBe("4200");
    expect(rows[0].needsGlAccount).toBe(false);
  });

  it("requires a rate for PERCENT and an amount for FLAT, and rejects both", async () => {
    await expect(asSystem(() => createSurcharge({ name: "A", kind: "PERCENT", position: 1 })))
      .rejects.toThrow("A percent surcharge needs a rate");
    await expect(asSystem(() => createSurcharge({ name: "B", kind: "FLAT", position: 1 })))
      .rejects.toThrow("A flat surcharge needs an amount");
    await expect(asSystem(() => createSurcharge({
      name: "C", kind: "PERCENT", rate: "0.04", amount: "5.00", position: 1 })))
      .rejects.toThrow("A percent surcharge cannot also carry a flat amount");
    // M3: the fourth superRefine branch (the mirror of the PERCENT/amount case above) was never
    // asserted — and it's the branch Fix 1's test exercises via updateSurcharge, so it's worth
    // pinning directly here too.
    await expect(asSystem(() => createSurcharge({
      name: "D", kind: "FLAT", amount: "5.00", rate: "0.04", position: 1 })))
      .rejects.toThrow("A flat surcharge cannot also carry a rate");
  });

  it("re-uses a soft-deleted name as a genuinely new row", async () => {
    const { id: first } = await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "5.00", position: 1 }));
    await asSystem(() => deleteSurcharge(first));
    const { id: second } = await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "6.00", position: 1 }));
    expect(second).not.toBe(first);
  });

  it("replaces the step-code list wholesale, recording the real before/after diff in one audit row", async () => {
    const a = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper" } });
    const b = await prisma.processStepCode.create({ data: { code: "WASH", name: "Hot wash" } });
    const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));
    await asSystem(() => setSurchargeStepCodes(id, [a.id, b.id]));
    // M5: the two-element intermediate state, not just the final single-element one — otherwise
    // the replace's `orderBy` (and the fact that this is a replace, not an append) goes unexercised.
    const afterFirst = await listSurcharges();
    expect(afterFirst[0].stepCodeIds.slice().sort()).toEqual([a.id, b.id].sort());

    await asSystem(() => setSurchargeStepCodes(id, [b.id]));
    const rows = await listSurcharges();
    expect(rows[0].stepCodeIds).toEqual([b.id]);

    // Fix 3: `setSurchargeStepCodes` wraps its replace in one `auditedUpdate` specifically so one
    // history row describes it — assert the actual before/after `stepCodes` content, not just
    // that an entry exists (house rule: assert audit content).
    const [entry] = await readAudit("surcharge", id);
    const before = entry.before as { stepCodes: { processStepCodeId: string }[] };
    const after = entry.after as { stepCodes: { processStepCodeId: string }[] };
    expect(before.stepCodes.map((s) => s.processStepCodeId).sort()).toEqual([a.id, b.id].sort());
    expect(after.stepCodes.map((s) => s.processStepCodeId)).toEqual([b.id]);
  });

  // M2: SurchargeStepCode carries a real (non-partial) @@unique([surchargeId, processStepCodeId]);
  // without this guard, a duplicate id in one call hits a raw P2002 through the generic
  // `entity: "Surcharge"` withDbErrors call, producing a misleading "already exists" message.
  it("rejects a duplicate step code id in the same setSurchargeStepCodes call", async () => {
    const a = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper" } });
    const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));
    await expect(asSystem(() => setSurchargeStepCodes(id, [a.id, a.id])))
      .rejects.toThrow("Duplicate step code in the list");
  });

  it("refuses to delete a surcharge a customer rule points at, and names the blocker", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
    await asSystem(() => setCustomerSurcharge(customer.id, id, { optOut: true }));
    await expect(asSystem(() => deleteSurcharge(id))).rejects.toThrow(/still in use by 1 record/);
    const blockers = await findBlockers("surcharge", id);
    expect(blockers[0].entityLabel).toBe("Customer");
    expect(blockers[0].name).toContain("ACME");
    // M1: detailPath ignores its argument (`() => "/admin/surcharges"`), so nothing else here
    // would catch a regressed blockerId — it only changes b.id, which a bare href check can't see.
    expect(blockers[0].id).toBe(customer.id);
  });

  // Fix 1 (review, fix wave 1): `updateSurcharge` used to validate the whole row via SAVE's
  // superRefine but persist only the keys the caller sent — zod drops an absent `.optional()`
  // key from its parsed output entirely, so `tx.surcharge.update({ data })` left that column
  // untouched. A caller flipping PERCENT -> FLAT cannot resend `rate` (superRefine rejects a
  // FLAT surcharge that carries one), so the natural save left the row as
  // `kind: FLAT, rate: 0.040000` — a state the service itself declares impossible. Must fail
  // against the pre-fix code; see task-6-report.md's Fix wave 1 for the captured RED output.
  it("updateSurcharge clears rate when a surcharge flips PERCENT to FLAT, and clears amount on the mirror flip", async () => {
    const { id: percentId } = await asSystem(() => createSurcharge({
      name: "EnergySur", kind: "PERCENT", rate: "0.040000", position: 1 }));
    await asSystem(() => updateSurcharge(percentId, {
      name: "EnergySur", kind: "FLAT", amount: "5.00", position: 1 }));
    const flipped = await prisma.surcharge.findUniqueOrThrow({ where: { id: percentId } });
    expect(flipped.kind).toBe("FLAT");
    expect(flipped.rate).toBeNull();
    expect(flipped.amount?.toNumber()).toBe(5);

    const { id: flatId } = await asSystem(() => createSurcharge({
      name: "FlatSur", kind: "FLAT", amount: "5.00", position: 2 }));
    await asSystem(() => updateSurcharge(flatId, {
      name: "FlatSur", kind: "PERCENT", rate: "0.040000", position: 2 }));
    const mirrored = await prisma.surcharge.findUniqueOrThrow({ where: { id: flatId } });
    expect(mirrored.kind).toBe("PERCENT");
    expect(mirrored.amount).toBeNull();
    expect(mirrored.rate?.toNumber()).toBe(0.04);
  });

  // Task 2 hand-wrote SURCHARGE_VIA_STEP_CODE to repair a defect in this plan's own registry
  // snippet; its displayName/blockerId have never run. SurchargeStepCode is a join row with no
  // name of its own, so without them a blocker panel would show a bare cuid at a person.
  it("refuses to delete a step code a surcharge scopes on, naming the surcharge", async () => {
    const code = await prisma.processStepCode.create({ data: { code: "WASH", name: "Hot wash" } });
    const { id } = await asSystem(() => createSurcharge({
      name: "EnergySur", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));
    await asSystem(() => setSurchargeStepCodes(id, [code.id]));
    await expect(asSystem(() => deleteStepCode(code.id))).rejects.toThrow(/still in use by 1 record/);
    const blockers = await findBlockers("processStepCode", code.id);
    expect(blockers.some((b) => b.name.includes("EnergySur"))).toBe(true);
    // M1: same regression the sibling test above guards against — a regressed blockerId here
    // would silently produce a 404 link (detailPath ignores its argument).
    expect(blockers[0].id).toBe(id);
  });

  describe("updateSurcharge", () => {
    // Fix 3: this export had zero coverage before the fix wave beyond the Fix 1 regression test.
    it("updates scalar fields and clears glAccountId by omission", async () => {
      const gl = await prisma.glAccount.create({ data: { name: "4200", description: "Energy" } });
      const { id } = await asSystem(() => createSurcharge({
        name: "EnergySur", kind: "PERCENT", rate: "0.040000", glAccountId: gl.id, scope: "ALL", position: 1 }));
      await asSystem(() => updateSurcharge(id, {
        name: "EnergySur2", kind: "PERCENT", rate: "0.050000", scope: "INCLUDE", position: 3, active: false }));
      const row = await prisma.surcharge.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe("EnergySur2");
      expect(row.rate?.toNumber()).toBe(0.05);
      expect(row.scope).toBe("INCLUDE");
      expect(row.position).toBe(3);
      expect(row.active).toBe(false);
      // glAccountId omitted from the payload above (Fix 1's normalize-on-write): a caller cannot
      // clear an FK by resending it, and the field must not be left stuck at the old value.
      expect(row.glAccountId).toBeNull();
    });

    it("404s on a nonexistent id and rejects an unknown glAccountId", async () => {
      await expect(asSystem(() => updateSurcharge("nonexistent", {
        name: "X", kind: "FLAT", amount: "1.00", position: 1 })))
        .rejects.toMatchObject({ status: 404 });

      const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
      await expect(asSystem(() => updateSurcharge(id, {
        name: "S", kind: "FLAT", amount: "1.00", position: 1, glAccountId: "nonexistent" })))
        .rejects.toThrow("That gl account does not exist");
    });

    // Fix 4: the newer precedent (process-step-codes.ts:309), not the older one this function was
    // first modeled on — a bare `where: { id }` would mutate a row under a soft-deleted surcharge
    // and audit it as an update after its own delete entry.
    it("404s against a soft-deleted surcharge instead of mutating it invisibly", async () => {
      const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
      await asSystem(() => deleteSurcharge(id));
      const auditCountAfterDelete = (await readAudit("surcharge", id)).length;

      await expect(asSystem(() => updateSurcharge(id, {
        name: "Renamed", kind: "FLAT", amount: "9.00", position: 1 })))
        .rejects.toMatchObject({ status: 404 });

      const row = await prisma.surcharge.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe("S");
      expect(await readAudit("surcharge", id)).toHaveLength(auditCountAfterDelete);
    });
  });

  describe("listCustomerSurcharges", () => {
    // Fix 3: this export had zero coverage. M4: mirrors listSurcharges' [{position:"asc"},
    // {id:"asc"}] tiebreak — Surcharge.position is not unique, so two overrides on same-position
    // surcharges must still resolve deterministically.
    it("lists a customer's overrides ordered by the surcharge's own display position, tie-broken by id", async () => {
      const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
      const { id: s1 } = await asSystem(() => createSurcharge({ name: "Zeta", kind: "FLAT", amount: "1.00", position: 1 }));
      const { id: s2 } = await asSystem(() => createSurcharge({ name: "Alpha", kind: "FLAT", amount: "2.00", position: 1 }));
      await asSystem(() => setCustomerSurcharge(customer.id, s2, { rate: "0.010000" }));
      await asSystem(() => setCustomerSurcharge(customer.id, s1, { optOut: true }));

      const rows = await listCustomerSurcharges(customer.id);
      expect(rows.map((r) => r.surchargeId)).toEqual([s1, s2].sort());
      const bySurcharge = new Map(rows.map((r) => [r.surchargeId, r]));
      expect(bySurcharge.get(s1)).toMatchObject({ surchargeName: "Zeta", optOut: true, rate: null, amount: null });
      expect(bySurcharge.get(s2)).toMatchObject({ surchargeName: "Alpha", optOut: false, rate: 0.01, amount: null });
    });
  });

  describe("setCustomerSurcharge", () => {
    // Fix 2: the create branch spread `data` over schema defaults, but the update branch handed
    // the same sparse payload straight to Prisma's `update`, which leaves an omitted key
    // untouched — so the identical two-call sequence produced a DIFFERENT final row depending on
    // which field arrived first. Test both orderings.
    it("fully replaces the override row on every call, regardless of which field arrives first", async () => {
      const customer1 = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
      const customer2 = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
      const { id: surchargeId } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));

      // Ordering A: rate first, then optOut. The update branch must not retain the old rate.
      await asSystem(() => setCustomerSurcharge(customer1.id, surchargeId, { rate: "0.050000" }));
      await asSystem(() => setCustomerSurcharge(customer1.id, surchargeId, { optOut: true }));
      const rowA = await prisma.customerSurcharge.findFirstOrThrow({
        where: { customerId: customer1.id, surchargeId, deletedAt: null } });
      expect(rowA.optOut).toBe(true);
      expect(rowA.rate).toBeNull();

      // Ordering B: optOut first, then rate — identical final call, fresh customer, same result
      // as ordering A produced for the FIELD BEING SET, proving the two orderings converge.
      await asSystem(() => setCustomerSurcharge(customer2.id, surchargeId, { optOut: true }));
      await asSystem(() => setCustomerSurcharge(customer2.id, surchargeId, { rate: "0.050000" }));
      const rowB = await prisma.customerSurcharge.findFirstOrThrow({
        where: { customerId: customer2.id, surchargeId, deletedAt: null } });
      expect(rowB.optOut).toBe(false);
      expect(rowB.rate?.toNumber()).toBe(0.05);
    });

    // Fix 3: setCustomerSurcharge had only ever been called once across the whole suite, so its
    // update branch (auditedUpdate("customerSurcharge", ...)) — and Task 2's
    // SNAPSHOT_INCLUDE.customerSurcharge — had never actually executed. Assert real audit content.
    it("records the real before/after diff on the update branch", async () => {
      const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
      const { id: surchargeId } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
      await asSystem(() => setCustomerSurcharge(customer.id, surchargeId, { rate: "0.050000" }));
      await asSystem(() => setCustomerSurcharge(customer.id, surchargeId, { optOut: true }));

      const row = await prisma.customerSurcharge.findFirstOrThrow({
        where: { customerId: customer.id, surchargeId, deletedAt: null } });
      const entries = await readAudit("customerSurcharge", row.id);
      expect(entries.map((e) => e.action)).toEqual(["update", "create"]);
      const [updateEntry] = entries;
      const before = updateEntry.before as { optOut: boolean; rate: string | null };
      const after = updateEntry.after as { optOut: boolean; rate: string | null };
      expect(before.optOut).toBe(false);
      expect(Number(before.rate)).toBe(0.05);
      expect(after.optOut).toBe(true);
      expect(after.rate).toBeNull();
    });
  });

  describe("deleteCustomerSurcharge", () => {
    // Fix 5: a plan hole, not a defect introduced by this task — the brief's interface had no
    // delete, so an override once created could never be removed, which permanently blocked its
    // surcharge's deletion. This soft-deletes the override through auditedSoftDelete.
    it("soft-deletes the override, recording a delete audit entry", async () => {
      const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
      const { id: surchargeId } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
      await asSystem(() => setCustomerSurcharge(customer.id, surchargeId, { optOut: true }));
      const row = await prisma.customerSurcharge.findFirstOrThrow({
        where: { customerId: customer.id, surchargeId, deletedAt: null } });

      await asSystem(() => deleteCustomerSurcharge(customer.id, surchargeId));

      const after = await prisma.customerSurcharge.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.deletedAt).toBeInstanceOf(Date);
      expect((await readAudit("customerSurcharge", row.id))[0].action).toBe("delete");
    });

    // The point of Fix 5: confirm — not assume — that a soft-deleted override actually falls out
    // of the blocker scan (customerSurcharge's REFERENCE_LINKS entry has no explicit `liveWhere`,
    // so findBlockers' default `{ deletedAt: null }` applies).
    it("frees the surcharge to be deleted once the blocking override is removed", async () => {
      const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
      const { id: surchargeId } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
      await asSystem(() => setCustomerSurcharge(customer.id, surchargeId, { optOut: true }));
      await expect(asSystem(() => deleteSurcharge(surchargeId))).rejects.toThrow(/still in use/);

      await asSystem(() => deleteCustomerSurcharge(customer.id, surchargeId));

      await expect(asSystem(() => deleteSurcharge(surchargeId))).resolves.toBeUndefined();
    });

    it("404s when there is no live override for that customer/surcharge pair", async () => {
      const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
      const { id: surchargeId } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));

      await expect(asSystem(() => deleteCustomerSurcharge(customer.id, surchargeId)))
        .rejects.toMatchObject({ status: 404 });

      await asSystem(() => setCustomerSurcharge(customer.id, surchargeId, { optOut: true }));
      await asSystem(() => deleteCustomerSurcharge(customer.id, surchargeId));
      // Already gone — a second delete of the same pair also 404s, not a silent no-op.
      await expect(asSystem(() => deleteCustomerSurcharge(customer.id, surchargeId)))
        .rejects.toMatchObject({ status: 404 });
    });
  });
});
