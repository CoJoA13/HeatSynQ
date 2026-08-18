import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "../prisma/generated/prisma/client";
import { prisma, truncateAll } from "./helpers/db";
import { listReference, createReference, updateReference, deleteReference } from "@/server/reference";
import { readAudit } from "@/server/audit";
import { pasteReference } from "@/server/paste";
import { REFERENCE_KINDS } from "@/lib/reference-constants";
import { HttpError } from "@/server/errors";
import { withDbErrors } from "@/server/db-errors";

describe("flat reference tables", () => {
  beforeEach(async () => await truncateAll());

  it("exposes every kind the owner needs to key", () => {
    expect([...REFERENCE_KINDS].sort()).toEqual([
      "carrier", "commentSnippet", "containerType", "endingStatement", "glAccount",
      "inspectionCode", "inspectionScale", "material", "paymentType", "specification", "terms",
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

  // Phase 6 ruling 13: the eleventh kind. `text` is the statement body (the commentSnippet
  // precedent), `isDefault` the at-most-one-live-default flag (its normalization has its own
  // describe below).
  it("ending statement carries a text body and a default flag", async () => {
    const { id } = await createReference("endingStatement", {
      name: "Standard", text: "This quotation is valid for 30 days.", isDefault: true,
    });
    const row = (await listReference("endingStatement")).find((r) => r.id === id);
    expect(row?.text).toMatch(/valid for 30 days/);
    expect(row?.isDefault).toBe(true);
  });

  it("ending statement rejects a text body over 4000 characters, like commentSnippet", async () => {
    await expect(createReference("endingStatement", { name: "Too long", text: "x".repeat(4001) }))
      .rejects.toThrow();
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
    { kind: "endingStatement", setup: async () => ({ text: "old" }), field: "text", fresh: "" },
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

  // Codex review Fix #17 (P2): requireDiscountPair validates only the fields PRESENT in a PATCH,
  // not the row that results from applying it. A PATCH clearing exactly one half of an existing
  // pair used to pass (the omitted key looks the same as "never had a pair" from inside the
  // refine) and persist a broken row — discountDays with no discountPercent, or vice versa.
  // updateReference now validates the MERGED row (stored values overlaid by the patch) whenever
  // the patch touches either discount key. Every case here is non-vacuous: each would have passed
  // (and corrupted the stored row) before assertDiscountPairAfterUpdate existed.
  describe("update: discount pair validated against the merged row, not just the patch", () => {
    async function seed210() {
      const { id } = await createReference("terms", {
        name: "2/10 Net 30", netDays: 30, discountPercent: "2.00", discountDays: 10,
      });
      return id;
    }

    it("rejects clearing only discountPercent, leaving discountDays stored", async () => {
      const id = await seed210();
      await expect(updateReference("terms", id, { discountPercent: null }))
        .rejects.toThrow(/an early-pay discount needs both a percent and a day count/);
      // The rejected write must not have partially landed.
      const row = (await listReference("terms")).find((r) => r.id === id);
      expect(Number(row?.discountPercent)).toBe(2);
      expect(row?.discountDays).toBe(10);
    });

    it("rejects clearing only discountDays, leaving discountPercent stored", async () => {
      const id = await seed210();
      await expect(updateReference("terms", id, { discountDays: null }))
        .rejects.toThrow(/an early-pay discount needs both a percent and a day count/);
      const row = (await listReference("terms")).find((r) => r.id === id);
      expect(Number(row?.discountPercent)).toBe(2);
      expect(row?.discountDays).toBe(10);
    });

    // #82. Everything above is the FRIENDLY error, and it is not enough on its own: it reads the
    // stored row before the row-locking update at the default isolation level, so two concurrent
    // PATCHes can each validate against the same stale view — one clearing both halves, the other
    // changing one half against the old other — and whichever commits second leaves exactly the
    // broken pair these checks exist to prevent. The DB CHECK is the layer both transactions share
    // and neither can talk its way past. Exercised the only way a constraint can be: by going AROUND
    // the service, which is what a losing racer effectively does.
    it("refuses a broken discount pair at the DATABASE, not only in the service (#82)", async () => {
      const id = await seed210();
      await expect(prisma.terms.update({ where: { id }, data: { discountPercent: null } }))
        .rejects.toThrow(/Terms_discount_pair_check/);
      await expect(prisma.terms.update({ where: { id }, data: { discountDays: null } }))
        .rejects.toThrow(/Terms_discount_pair_check/);
      // Refused, not half-applied.
      const row = (await listReference("terms")).find((r) => r.id === id);
      expect(Number(row?.discountPercent)).toBe(2);
      expect(row?.discountDays).toBe(10);

      // Clearing BOTH is legal and stays legal — the constraint guards the pairing, not the feature.
      await prisma.terms.update({ where: { id }, data: { discountPercent: null, discountDays: null } });
      // ...and a row cannot be CREATED broken either, which no service check covered.
      await expect(prisma.terms.create({ data: { name: "Half a discount", netDays: 30, discountDays: 10 } }))
        .rejects.toThrow(/Terms_discount_pair_check/);
    });

    // Review round 2: reaching the CHECK means two writers raced past the service validation — the
    // loser's request was not wrong, it lost. That deserves a 409 "try again", not Postgres' raw
    // constraint text escaping as a 500 (`handle` rethrows anything that is not an HttpError).
    it("surfaces a CHECK violation as an explainable 409, not a raw 500 (#82)", async () => {
      const id = await seed210();
      await expect(withDbErrors({ entity: "Terms" }, () =>
        prisma.terms.update({ where: { id }, data: { discountPercent: null } })))
        .rejects.toMatchObject({
          status: 409,
          message: expect.stringMatching(/needs both a percent and a day count/i),
        });
    });

    it("allows clearing both halves of the pair together", async () => {
      const id = await seed210();
      await updateReference("terms", id, { discountPercent: null, discountDays: null });
      const row = (await listReference("terms")).find((r) => r.id === id);
      expect(row?.discountPercent).toBeNull();
      expect(row?.discountDays).toBeNull();
    });

    it("an unrelated field update (netDays or active) on a paired row is unaffected", async () => {
      const id = await seed210();
      await updateReference("terms", id, { netDays: 45 });
      await updateReference("terms", id, { active: false });
      const row = (await listReference("terms", { includeInactive: true })).find((r) => r.id === id);
      expect(row?.netDays).toBe(45);
      expect(row?.active).toBe(false);
      expect(Number(row?.discountPercent)).toBe(2);
      expect(row?.discountDays).toBe(10);
    });
  });

});

// Phase 6 ruling 13: at most one LIVE ending statement carries isDefault — the customer-address
// default precedent, enforced in the SERVICE (reference.ts's endingStatement hooks) so no future
// caller can bypass it (§5.17 discipline). Unlike addresses there is NO auto-promotion: a kind
// with zero defaults is legal (Quote.endingStatementId is nullable — a quote created then simply
// stores no ending statement).
describe("ending statement: at-most-one-live-default normalization", () => {
  beforeEach(async () => await truncateAll());

  const liveDefaults = () =>
    prisma.endingStatement.findMany({
      where: { deletedAt: null, isDefault: true }, orderBy: { name: "asc" },
    });

  it("a create with isDefault demotes the previous default in the same transaction, audited", async () => {
    const first = await createReference("endingStatement", { name: "A", isDefault: true });
    const second = await createReference("endingStatement", { name: "B", isDefault: true });

    expect((await liveDefaults()).map((r) => r.id)).toEqual([second.id]);

    // The demotion must be a real audited write (the customer-address setDefault lesson): without
    // it, A's history keeps claiming isDefault: true forever after the demotion.
    const entries = await readAudit("endingStatement", first.id);
    expect(entries.map((e) => e.action)).toEqual(["update", "create"]);
    expect((entries[0].before as { isDefault: boolean }).isDefault).toBe(true);
    expect((entries[0].after as { isDefault: boolean }).isDefault).toBe(false);
  });

  it("an update promoting a row demotes the previous default", async () => {
    const a = await createReference("endingStatement", { name: "A", isDefault: true });
    const b = await createReference("endingStatement", { name: "B" });

    await updateReference("endingStatement", b.id, { isDefault: true });

    expect((await liveDefaults()).map((r) => r.id)).toEqual([b.id]);
    const aRow = await prisma.endingStatement.findFirst({ where: { id: a.id } });
    expect(aRow?.isDefault).toBe(false);
  });

  it("explicitly clearing the default leaves the kind defaultless — legal, no auto-promotion", async () => {
    const a = await createReference("endingStatement", { name: "A", isDefault: true });
    await createReference("endingStatement", { name: "B" });

    await updateReference("endingStatement", a.id, { isDefault: false });

    expect(await liveDefaults()).toEqual([]);
  });

  it("deactivating the default strips the flag — defaultless, and a later reactivation does not resurrect it", async () => {
    const a = await createReference("endingStatement", { name: "A", isDefault: true });

    await updateReference("endingStatement", a.id, { active: false });
    expect(await liveDefaults()).toEqual([]);
    const stored = (await listReference("endingStatement", { includeInactive: true }))
      .find((r) => r.id === a.id);
    expect(stored?.active).toBe(false);
    expect(stored?.isDefault).toBe(false); // stripped in the same write, not merely hidden

    // Reactivation must not silently restore default status past a newer default.
    const b = await createReference("endingStatement", { name: "B", isDefault: true });
    await updateReference("endingStatement", a.id, { active: true });
    expect((await liveDefaults()).map((r) => r.id)).toEqual([b.id]);
  });

  it("an inactive row cannot be made the default — 400, on create and on update", async () => {
    await expect(createReference("endingStatement", { name: "A", active: false, isDefault: true }))
      .rejects.toMatchObject({ status: 400 });

    const b = await createReference("endingStatement", { name: "B", active: false });
    await expect(updateReference("endingStatement", b.id, { isDefault: true }))
      .rejects.toMatchObject({ status: 400 });

    const c = await createReference("endingStatement", { name: "C" });
    await expect(updateReference("endingStatement", c.id, { active: false, isDefault: true }))
      .rejects.toMatchObject({ status: 400 });

    expect(await liveDefaults()).toEqual([]);
  });

  // Excel writes a boolean cell as TRUE/FALSE, so that is what a copy-paste hands the importer —
  // paste.ts coerces it (case-insensitively) to a real boolean before z.boolean() sees it, the
  // numberColumns shape. Column order matches REFERENCE_EXTRA_FIELDS.endingStatement:
  // name, text, isDefault.
  it("paste coerces TRUE/FALSE cells for the default column and normalizes through the service", async () => {
    const first = await pasteReference("endingStatement", "Standard\tValid 30 days.\tTRUE");
    expect(first).toEqual({ created: 1, errors: [] });

    const second = await pasteReference("endingStatement", "Rush\tValid 10 days.\ttrue\nPlain\tNo terms.\tFALSE");
    expect(second).toEqual({ created: 2, errors: [] });

    // Pasted rows go through createReference, so the last TRUE row won the default.
    const rows = await listReference("endingStatement");
    expect(rows.find((r) => r.name === "Rush")?.isDefault).toBe(true);
    expect(rows.find((r) => r.name === "Standard")?.isDefault).toBe(false);
    expect(rows.find((r) => r.name === "Plain")?.isDefault).toBe(false);
    expect(await liveDefaults()).toHaveLength(1);
  });

  it("paste reports a non-boolean default cell per-row instead of guessing", async () => {
    const result = await pasteReference("endingStatement", "Standard\tValid 30 days.\tmaybe");
    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/isDefault.*boolean/i);
  });

  it("deleting the default leaves the kind defaultless", async () => {
    const a = await createReference("endingStatement", { name: "A", isDefault: true });
    await createReference("endingStatement", { name: "B" });

    await deleteReference("endingStatement", a.id);

    expect(await liveDefaults()).toEqual([]);
  });

  // The house rule: a passing concurrency test is not evidence unless RED-verified. This one is —
  // remove `lockEndingStatementDefault` from the promote branch of
  // `normalizeEndingStatementDefaultOnUpdate` (reference.ts) and the competitor no longer blocks:
  // its demote-scan runs while the holder's flag write is still uncommitted (invisible at Read
  // Committed), both commit, and TWO live defaults survive — the final assertion fails. Restored,
  // the competitor queues on the advisory lock until the holder commits, its scan then sees the
  // committed flag, and exactly one default remains.
  it("two concurrent make-me-default writes end with exactly ONE live default (advisory-lock claim)", async () => {
    const a = await createReference("endingStatement", { name: "A" });
    const b = await createReference("endingStatement", { name: "B" });

    let holderReady!: () => void;
    const ready = new Promise<void>((r) => { holderReady = r; });
    let releaseHolder!: () => void;
    const release = new Promise<void>((r) => { releaseHolder = r; });

    // HOLDER: hand-scripts the competing "make A the default" caller's critical section — the
    // SAME advisory lock the service takes, the same demote-scan (sees nothing to demote), the
    // same flag write — then holds it all uncommitted. Pinned to READ COMMITTED on purpose (the
    // RED-verification rule): the claim must serialize the two writers at ANY isolation; SSI
    // must never be what saves us.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4300, 0)`;
      const defaults = await tx.endingStatement.findMany({
        where: { deletedAt: null, isDefault: true }, select: { id: true },
      });
      for (const row of defaults) {
        await tx.endingStatement.update({ where: { id: row.id }, data: { isDefault: false } });
      }
      await tx.endingStatement.update({ where: { id: a.id }, data: { isDefault: true } });
      holderReady();
      await release;
    }, { timeout: 20000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

    await ready;

    // COMPETITOR: the REAL service call promoting B, racing the held write.
    const competitor = updateReference("endingStatement", b.id, { isDefault: true })
      .then(() => "resolved" as const, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200)); // let it reach (and block on) the lock
    releaseHolder();
    await holder;

    expect(await competitor).toBe("resolved");
    // Exactly ONE live default, and it is the later writer — the competitor saw the holder's
    // committed flag and demoted it.
    expect((await liveDefaults()).map((r) => r.id)).toEqual([b.id]);
    const aRow = await prisma.endingStatement.findFirst({ where: { id: a.id } });
    expect(aRow?.isDefault).toBe(false);
  });
});
