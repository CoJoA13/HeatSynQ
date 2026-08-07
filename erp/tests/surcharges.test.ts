import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import {
  listSurcharges, createSurcharge, updateSurcharge, deleteSurcharge,
  setSurchargeStepCodes, listCustomerSurcharges, setCustomerSurcharge, deleteCustomerSurcharge,
  customerSurchargeOptions,
} from "@/server/surcharges";
import { deleteStepCode } from "@/server/process-step-codes";
import { findBlockers } from "@/server/reference-blockers";
import { readAudit } from "@/server/audit";

import { GET as listRoute, POST as createRoute } from "@/app/api/admin/surcharges/route";
import { PUT as updateRoute, DELETE as deleteRoute } from "@/app/api/admin/surcharges/[id]/route";
import { PUT as setStepCodesRoute } from "@/app/api/admin/surcharges/[id]/step-codes/route";
import { GET as blockersRoute } from "@/app/api/admin/surcharges/[id]/blockers/route";
import { GET as blockersExportRoute } from "@/app/api/admin/surcharges/[id]/blockers/export/route";
import {
  GET as customerSurchargesRoute, PUT as customerSurchargePutRoute, DELETE as customerSurchargeDeleteRoute,
} from "@/app/api/customers/[id]/surcharges/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const noParams = { params: Promise.resolve({}) };
const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function bodyReq(url: string, method: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
function noBodyReq(url: string, method: string, cookie?: string): Request {
  return new Request(url, { method, headers: cookie ? { cookie } : {} });
}

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
    // Fix wave 2, Fix 2: inserted in descending id order, deliberately the reverse of the
    // ascending order `orderBy: { processStepCodeId: "asc" }` must produce — a plain (unordered)
    // scan tends to hand back rows in insertion order, so if the assertion below passed on
    // insertion order alone (e.g. because cuids happened to already be ascending by creation
    // order), it would prove nothing about the orderBy. Deriving [lo, hi] from the ids themselves,
    // not hardcoding which of a/b sorts first, per the same cuid caveat.
    const [lo, hi] = [a.id, b.id].sort();
    await asSystem(() => setSurchargeStepCodes(id, [hi, lo]));
    // M5: the two-element intermediate state, not just the final single-element one — otherwise
    // the replace's `orderBy` (and the fact that this is a replace, not an append) goes
    // unexercised. Only the expected side is sorted — the actual value is asserted in the real
    // ascending order `listSurcharges`' `orderBy: { processStepCodeId: "asc" }` produces, so a
    // regression that drops that `orderBy` (here or on SNAPSHOT_INCLUDE.surcharge) is caught.
    const afterFirst = await listSurcharges();
    expect(afterFirst[0].stepCodeIds).toEqual([lo, hi]);

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

    // Fix wave 2, Fix 1: `toSurchargeRow` pins minimumAmount/scope/active to their explicit empty
    // value on every write so an omitted key can't leave a stale column behind — but nothing in
    // this file exercised minimumAmount at all, and the one test touching scope/active always
    // sent both explicitly. Create a row carrying non-default values for all three, then update
    // omitting all three, and assert each one actually reset.
    it("resets minimumAmount, scope, and active to their empty defaults when the update omits them", async () => {
      const { id } = await asSystem(() => createSurcharge({
        name: "EnergySur", kind: "FLAT", amount: "5.00", minimumAmount: "50.00",
        scope: "EXCLUDE", active: false, position: 1 }));

      await asSystem(() => updateSurcharge(id, { name: "EnergySur", kind: "FLAT", amount: "5.00", position: 1 }));

      const row = await prisma.surcharge.findUniqueOrThrow({ where: { id } });
      expect(row.minimumAmount).toBeNull();
      expect(row.scope).toBe("ALL");
      expect(row.active).toBe(true);
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

  // Task 8 (P5A): the merged view the customer page's Surcharge overrides section renders —
  // every ACTIVE plant-wide surcharge, with this customer's own override (if any) folded in.
  describe("customerSurchargeOptions", () => {
    it("lists every active surcharge, folding in the customer's own override where one exists", async () => {
      const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
      const { id: overridden } = await asSystem(() => createSurcharge({
        name: "EnergySur", kind: "PERCENT", rate: "0.040000", position: 1 }));
      const { id: plain } = await asSystem(() => createSurcharge({
        name: "FuelSur", kind: "FLAT", amount: "5.00", position: 2 }));
      // Inactive surcharges are excluded — same as listSurcharges' own default.
      const { id: inactive } = await asSystem(() => createSurcharge({
        name: "OldSur", kind: "FLAT", amount: "1.00", position: 3, active: false }));
      await asSystem(() => setCustomerSurcharge(customer.id, overridden, { rate: "0.010000" }));

      const rows = await customerSurchargeOptions(customer.id);
      expect(rows.map((r) => r.surchargeId)).toEqual([overridden, plain]);
      expect(rows.some((r) => r.surchargeId === inactive)).toBe(false);

      const overriddenRow = rows.find((r) => r.surchargeId === overridden)!;
      expect(overriddenRow).toMatchObject({
        surchargeName: "EnergySur", kind: "PERCENT", optOut: false, rate: 0.01, amount: null, hasOverride: true,
      });
      const plainRow = rows.find((r) => r.surchargeId === plain)!;
      expect(plainRow).toMatchObject({
        surchargeName: "FuelSur", kind: "FLAT", optOut: false, rate: null, amount: null, hasOverride: false,
      });
    });

    // The point of `hasOverride`: a row with no CustomerSurcharge at all and a row whose override
    // explicitly holds the same empty values read IDENTICALLY on optOut/rate/amount (both bill at
    // the plant-wide definition) — only `hasOverride` tells a caller whether there is anything for
    // deleteCustomerSurcharge to actually remove.
    it("distinguishes a bare row from an override that holds only empty values", async () => {
      const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
      const { id: surchargeId } = await asSystem(() => createSurcharge({
        name: "S", kind: "FLAT", amount: "5.00", position: 1 }));
      await asSystem(() => setCustomerSurcharge(customer.id, surchargeId, {}));

      const [row] = await customerSurchargeOptions(customer.id);
      expect(row).toMatchObject({ optOut: false, rate: null, amount: null, hasOverride: true });
    });
  });
});

describe("GET/POST /api/admin/surcharges", () => {
  beforeEach(truncateAll);

  it("requires login", async () => {
    expect((await listRoute(getReq("http://t/api/admin/surcharges"), noParams)).status).toBe(401);
    expect((await createRoute(bodyReq("http://t/api/admin/surcharges", "POST", undefined, {}), noParams)).status)
      .toBe(401);
  });

  it("requires admin.view for GET and admin.create for POST", async () => {
    const noPerms = await signInWith(["customers.view"], "no-admin");
    expect((await listRoute(getReq("http://t/api/admin/surcharges", noPerms), noParams)).status).toBe(403);

    const viewer = await signInWith(["admin.view"], "surcharges-viewer");
    expect((await listRoute(getReq("http://t/api/admin/surcharges", viewer), noParams)).status).toBe(200);
    expect((await createRoute(
      bodyReq("http://t/api/admin/surcharges", "POST", viewer, { name: "S", kind: "FLAT", amount: "1.00", position: 1 }),
      noParams,
    )).status).toBe(403);

    // Discriminating case (review Fix 2, fix wave 1): admin.edit alone must not satisfy POST's
    // admin.create gate — an editor with no create grant is still refused, proving POST checks
    // its own permission rather than "holds some admin grant."
    const editorNoCreate = await signInWith(["admin.view", "admin.edit"], "surcharges-editor-no-create");
    expect((await createRoute(
      bodyReq("http://t/api/admin/surcharges", "POST", editorNoCreate, { name: "S2", kind: "FLAT", amount: "1.00", position: 1 }),
      noParams,
    )).status).toBe(403);
  });

  it("GET/POST succeed with admin.view/admin.create, and the created row is listed", async () => {
    const creator = await signInWith(["admin.view", "admin.create"], "surcharges-creator");
    const postRes = await createRoute(bodyReq("http://t/api/admin/surcharges", "POST", creator,
      { name: "EnergySur", kind: "PERCENT", rate: "0.040000", position: 1 }), noParams);
    expect(postRes.status).toBe(200);
    const { id } = await postRes.json();
    expect(typeof id).toBe("string");

    const getRes = await listRoute(getReq("http://t/api/admin/surcharges", creator), noParams);
    expect(getRes.status).toBe(200);
    const rows = await getRes.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, name: "EnergySur", kind: "PERCENT", rate: 0.04 });
  });
});

describe("PUT/DELETE /api/admin/surcharges/[id]", () => {
  beforeEach(truncateAll);

  it("requires login", async () => {
    expect((await updateRoute(bodyReq("http://t/api/admin/surcharges/x", "PUT", undefined, {}), withParams({ id: "x" })))
      .status).toBe(401);
    expect((await deleteRoute(noBodyReq("http://t/api/admin/surcharges/x", "DELETE"), withParams({ id: "x" })))
      .status).toBe(401);
  });

  it("requires admin.edit for PUT and admin.delete for DELETE", async () => {
    const editor = await signInWith(["admin.view", "admin.edit"], "surcharges-editor2");
    const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));

    const viewer = await signInWith(["admin.view"], "surcharges-viewer2");
    expect((await updateRoute(
      bodyReq(`http://t/api/admin/surcharges/${id}`, "PUT", viewer, { name: "S2", kind: "FLAT", amount: "2.00", position: 1 }),
      withParams({ id }),
    )).status).toBe(403);
    expect((await deleteRoute(noBodyReq(`http://t/api/admin/surcharges/${id}`, "DELETE", viewer), withParams({ id })))
      .status).toBe(403);

    // Discriminating case (review Fix 2, fix wave 1): admin.edit alone must not satisfy DELETE's
    // admin.delete gate — an editor with no delete grant is refused by DELETE specifically,
    // proving PUT and DELETE check different permissions rather than sharing one.
    expect((await deleteRoute(noBodyReq(`http://t/api/admin/surcharges/${id}`, "DELETE", editor), withParams({ id })))
      .status).toBe(403);

    const putRes = await updateRoute(
      bodyReq(`http://t/api/admin/surcharges/${id}`, "PUT", editor, { name: "S2", kind: "FLAT", amount: "2.00", position: 1 }),
      withParams({ id }),
    );
    expect(putRes.status).toBe(200);
    const row = await prisma.surcharge.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe("S2");
    expect(row.amount?.toNumber()).toBe(2);

    const deleter = await signInWith(["admin.view", "admin.delete"], "surcharges-deleter");
    const delRes = await deleteRoute(noBodyReq(`http://t/api/admin/surcharges/${id}`, "DELETE", deleter), withParams({ id }));
    expect(delRes.status).toBe(200);
    expect((await prisma.surcharge.findUniqueOrThrow({ where: { id } })).deletedAt).toBeInstanceOf(Date);
  });
});

describe("PUT /api/admin/surcharges/[id]/step-codes", () => {
  beforeEach(truncateAll);

  it("requires login, then admin.edit, then replaces the step-code list wholesale", async () => {
    const code = await prisma.processStepCode.create({ data: { code: "WASH", name: "Hot wash" } });
    const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));

    expect((await setStepCodesRoute(
      bodyReq(`http://t/api/admin/surcharges/${id}/step-codes`, "PUT", undefined, { stepCodeIds: [code.id] }),
      withParams({ id }),
    )).status).toBe(401);

    const viewer = await signInWith(["admin.view"], "surcharges-viewer3");
    expect((await setStepCodesRoute(
      bodyReq(`http://t/api/admin/surcharges/${id}/step-codes`, "PUT", viewer, { stepCodeIds: [code.id] }),
      withParams({ id }),
    )).status).toBe(403);

    const editor = await signInWith(["admin.view", "admin.edit"], "surcharges-editor3");
    const res = await setStepCodesRoute(
      bodyReq(`http://t/api/admin/surcharges/${id}/step-codes`, "PUT", editor, { stepCodeIds: [code.id] }),
      withParams({ id }),
    );
    expect(res.status).toBe(200);
    const rows = await listSurcharges();
    expect(rows[0].stepCodeIds).toEqual([code.id]);
  });
});

describe("GET /api/admin/surcharges/[id]/blockers(/export)", () => {
  beforeEach(truncateAll);

  it("requires login, then admin.view, then names the blocking customer", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
    await asSystem(() => setCustomerSurcharge(customer.id, id, { optOut: true }));

    expect((await blockersRoute(getReq(`http://t/api/admin/surcharges/${id}/blockers`), withParams({ id }))).status)
      .toBe(401);
    expect((await blockersExportRoute(getReq(`http://t/api/admin/surcharges/${id}/blockers/export`), withParams({ id })))
      .status).toBe(401);

    const noPerms = await signInWith(["customers.view"], "no-admin2");
    expect((await blockersRoute(getReq(`http://t/api/admin/surcharges/${id}/blockers`, noPerms), withParams({ id })))
      .status).toBe(403);
    // Fix 6 (review, fix wave 1): the export route carries the same mustCan as the plain
    // blockers route, but only the plain route's 403 was ever asserted.
    expect((await blockersExportRoute(getReq(`http://t/api/admin/surcharges/${id}/blockers/export`, noPerms), withParams({ id })))
      .status).toBe(403);

    const viewer = await signInWith(["admin.view"], "surcharges-viewer4");
    const res = await blockersRoute(getReq(`http://t/api/admin/surcharges/${id}/blockers`, viewer), withParams({ id }));
    expect(res.status).toBe(200);
    const blockers = await res.json();
    expect(blockers[0].entityLabel).toBe("Customer");
    expect(blockers[0].name).toContain("ACME");
    // Fix 3, fix wave 1 review: this route opts `findBlockers` into `includeLabel`, which
    // admin/surcharges/page.tsx pairs with `entityLabel` for a sturdier "is this a customer
    // override" check than `entityLabel === "Customer"` alone.
    expect(blockers[0].label).toBe("Surcharge");

    const exportRes = await blockersExportRoute(
      getReq(`http://t/api/admin/surcharges/${id}/blockers/export`, viewer), withParams({ id }));
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toContain("spreadsheetml");
  });
});

// Task 8 (P5A): the customer-side route. GET is gated on customers.view alone (Fix: it must NOT
// require admin.view — customerSurchargeOptions' own doc comment); PUT/DELETE are gated on
// customers.edit PLUS change_prices, since a per-customer surcharge override — setting one or
// removing one — is a price change (task-8 brief's opening blockquote).
describe("GET/PUT/DELETE /api/customers/[id]/surcharges", () => {
  beforeEach(truncateAll);

  it("requires login on all three verbs", async () => {
    expect((await customerSurchargesRoute(getReq("http://t/api/customers/x/surcharges"), withParams({ id: "x" })))
      .status).toBe(401);
    expect((await customerSurchargePutRoute(
      bodyReq("http://t/api/customers/x/surcharges", "PUT", undefined, {}), withParams({ id: "x" }))).status)
      .toBe(401);
    expect((await customerSurchargeDeleteRoute(
      bodyReq("http://t/api/customers/x/surcharges", "DELETE", undefined, {}), withParams({ id: "x" }))).status)
      .toBe(401);
  });

  it("GET needs customers.view only — not admin.view", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));

    const noPerms = await signInWith(["admin.view"], "admin-only");
    expect((await customerSurchargesRoute(
      getReq(`http://t/api/customers/${customer.id}/surcharges`, noPerms), withParams({ id: customer.id })))
      .status).toBe(403);

    const viewer = await signInWith(["customers.view"], "customers-viewer");
    const res = await customerSurchargesRoute(
      getReq(`http://t/api/customers/${customer.id}/surcharges`, viewer), withParams({ id: customer.id }));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toMatchObject([{ surchargeName: "S", kind: "FLAT", optOut: false, hasOverride: false }]);
  });

  it("PUT/DELETE need customers.edit AND change_prices — either alone is refused", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    const { id: surchargeId } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));

    const editOnly = await signInWith(["customers.edit"], "edit-only");
    expect((await customerSurchargePutRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "PUT", editOnly, { surchargeId, optOut: true }),
      withParams({ id: customer.id }))).status).toBe(403);
    expect((await customerSurchargeDeleteRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "DELETE", editOnly, { surchargeId }),
      withParams({ id: customer.id }))).status).toBe(403);

    const priceOnly = await signInWith(["action.change_prices"], "price-only");
    expect((await customerSurchargePutRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "PUT", priceOnly, { surchargeId, optOut: true }),
      withParams({ id: customer.id }))).status).toBe(403);

    const both = await signInWith(["customers.edit", "action.change_prices"], "both-perms");
    expect((await customerSurchargePutRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "PUT", both, { surchargeId, optOut: true }),
      withParams({ id: customer.id }))).status).toBe(200);
  });

  it("PUT requires surchargeId, and posts the WHOLE row through setCustomerSurcharge — a caller cannot resend only the changed field", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    const { id: surchargeId } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
    const editor = await signInWith(["customers.edit", "action.change_prices"], "editor");

    expect((await customerSurchargePutRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "PUT", editor, { optOut: true }),
      withParams({ id: customer.id }))).status).toBe(400);

    // First save sets amount. Second save omits amount entirely (only optOut) — the whole-row
    // contract means amount must come back null, not survive from the first call (Fix 1 from
    // Task 6's fix wave, applied to this route: an omitted field clears it).
    await customerSurchargePutRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "PUT", editor,
        { surchargeId, optOut: false, amount: "2.50" }),
      withParams({ id: customer.id }));
    await customerSurchargePutRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "PUT", editor,
        { surchargeId, optOut: true, amount: null }),
      withParams({ id: customer.id }));

    const row = await prisma.customerSurcharge.findFirstOrThrow({
      where: { customerId: customer.id, surchargeId, deletedAt: null } });
    expect(row.optOut).toBe(true);
    expect(row.amount).toBeNull();
  });

  it("DELETE requires surchargeId, 404s with no live override, and frees the surcharge to delete once cleared", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    const { id: surchargeId } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
    const editor = await signInWith(["customers.edit", "action.change_prices"], "editor");

    expect((await customerSurchargeDeleteRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "DELETE", editor, {}),
      withParams({ id: customer.id }))).status).toBe(400);

    expect((await customerSurchargeDeleteRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "DELETE", editor, { surchargeId }),
      withParams({ id: customer.id }))).status).toBe(404);

    await customerSurchargePutRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "PUT", editor, { surchargeId, optOut: true }),
      withParams({ id: customer.id }));
    await expect(asSystem(() => deleteSurcharge(surchargeId))).rejects.toThrow(/still in use/);

    const delRes = await customerSurchargeDeleteRoute(
      bodyReq(`http://t/api/customers/${customer.id}/surcharges`, "DELETE", editor, { surchargeId }),
      withParams({ id: customer.id }));
    expect(delRes.status).toBe(200);

    await expect(asSystem(() => deleteSurcharge(surchargeId))).resolves.toBeUndefined();
  });

  // Fix 2, fix wave 1 review: a body-less DELETE (`api(path, { method: "DELETE" })`, the
  // ordinary shape a caller with nothing to say would use — parts/[id]/PricingSection.tsx:158's
  // own shape) used to throw a raw SyntaxError out of `await req.json()`, which `handle` does not
  // map to a clean response (only ZodError/HttpError are), surfacing as an unhandled 500 instead
  // of the field-anchored 400 every other missing-required-field case on this route already gets.
  it("DELETE with no body at all returns 400 for the missing surchargeId, not 500", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    const editor = await signInWith(["customers.edit", "action.change_prices"], "editor");

    const res = await customerSurchargeDeleteRoute(
      noBodyReq(`http://t/api/customers/${customer.id}/surcharges`, "DELETE", editor),
      withParams({ id: customer.id }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("surchargeId is required");
  });
});
