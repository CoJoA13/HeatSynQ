import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder, voidOrder } from "@/server/orders";
import { replaceLoads } from "@/server/order-loads";
import { updateStep } from "@/server/part-process-steps";
import { addPartInspection } from "@/server/part-inspections";
import { setSetting } from "@/server/settings";
import { renderPdf, barcodePng } from "@/server/pdf/render";
import {
  buildTravelerDefinition, collectTravelerData, printTraveler, listDocuments, getDocument,
  type TravelerData,
} from "@/server/traveler";

import { POST as travelerRoute } from "@/app/api/orders/[id]/traveler/route";
import { GET as documentsRoute } from "@/app/api/orders/[id]/documents/route";
import { GET as documentRoute } from "@/app/api/documents/[docId]/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const req = (url: string, method: string, cookie?: string) =>
  new Request(url, { method, headers: cookie ? { cookie } : {} });

/**
 * Every `text` string anywhere in a document definition, flattened. The definition is plain JSON
 * (the template-as-data contract, spec §10), so a recursive walk is all the assertions below need
 * — they check WHAT the traveler says, not where pdfmake decides to draw it.
 */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // `image` holds a multi-kilobyte barcode data URI — never text, and flattening it would
      // make every `toContain` assertion below scan it.
      if (key === "image") continue;
      allText(value, out);
    }
  }
  return out;
}

/**
 * The PDF's own page count, read off its `/Type /Pages /Count N` object — present, uncompressed,
 * near the top of every PDF pdfmake/pdfkit produces (its own page-tree root), and NOT subject to
 * the render-to-render byte noise a full `Buffer.compare` between two SEPARATE `renderPdf` calls
 * would hit: `renderPdf`'s own deflate compression is not byte-stable across repeat calls even
 * against the byte-identical `TDocumentDefinitions` input (verified separately — this suite never
 * asserts exact-byte equality between two independently rendered PDFs, only ever between a stored
 * blob and itself, e.g. "a reprint streams the stored bytes untouched"). One sheet-set is one page
 * (`buildTravelerDefinition`'s own `pageBreak` before every sheet but the first), so this is
 * exactly `TravelerData.sheets.length` once rendered — the one signal a race test can check
 * without re-rendering anything itself.
 */
function pageCount(pdf: Buffer): number {
  const match = pdf.toString("latin1").match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (!match) throw new Error("Could not find a /Type /Pages /Count marker in the rendered PDF");
  return Number(match[1]);
}

/**
 * The mockup-shaped sibling order (docs/samples/2025-aht-orderform-mockup.pdf, spec §12.2), built
 * with raw prisma for the reference/part/step rows the same way orders.test.ts builds its own —
 * the traveler service under test must not depend on the parts or process-steps services to
 * construct its fixtures — and through `createOrder` for the order itself, since locking the
 * lead's revision is exactly the behaviour these tests are about.
 */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "RMG", name: "Renaissance Manufacturing Group" } });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "RECEIVED_FROM", name: "Anniston plant",
      street: "260 Central Castings Dr.", city: "Anniston", state: "AL", zip: "36206", isDefault: true,
    },
  });
  const material = await prisma.material.create({ data: { name: "Ductile Iron" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUS", name: "Austemper" } });
  const tempDef = await prisma.processStepFieldDef.create({
    data: { codeId: code.id, label: "Furnace Temp", type: "NUMBER", unit: "°F", sort: 0 },
  });
  const timeDef = await prisma.processStepFieldDef.create({
    data: { codeId: code.id, label: "Furnace Time", type: "TEXT", unit: null, sort: 1 },
  });

  const lead = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "3541719C3", name: "U Bolt Rear Spr Plate",
      description: "Machined", materialId: material.id, eachWeight: "13.5000", loadQty: 336,
    },
  });
  const rider = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "3541720C3", name: "U Bolt Front Spr Plate",
      description: "Machined", eachWeight: "13.5000",
    },
  });

  const rev = await prisma.partProcessRevision.create({ data: { partId: lead.id, revisionNumber: 1 } });
  const step = await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Pre-heat to 1100F for 1 hour minimum." },
  });
  await prisma.partProcessStepValue.create({
    data: { stepId: step.id, fieldDefId: tempDef.id, value: "1650" },
  });
  await prisma.partProcessStepValue.create({
    data: { stepId: step.id, fieldDefId: timeDef.id, value: "2 hours" },
  });

  const inspectionCode = await prisma.inspectionCode.create({ data: { name: "Hardness" } });
  const scale = await prisma.inspectionScale.create({ data: { name: "HBW" } });
  const magCode = await prisma.inspectionCode.create({ data: { name: "Mag-Particle" } });
  await asSystem(() => addPartInspection(lead.id, {
    inspectionCodeId: inspectionCode.id, scaleId: scale.id, min: "269", max: "341",
    sampleQty: "8", location: "flange OD", sort: 0,
  }));
  await asSystem(() => addPartInspection(lead.id, {
    inspectionCodeId: magCode.id, sampleQty: "100%", sort: 1,
  }));

  const containerType = await prisma.containerType.create({ data: { name: "Drop Pan" } });
  return { customer, material, code, tempDef, timeDef, lead, rider, rev, step, containerType };
}

/** The mockup order itself: 4,500 pcs over two sibling lines, lead cap 336 -> 14 loads. */
async function orderFixture() {
  const built = await fixture();
  const { order } = await asSystem(() => createOrder({
    customerId: built.customer.id, poNumber: "PO-71246",
    lines: [
      { partId: built.lead.id, qty: 2500, weight: "33750.00" },
      { partId: built.rider.id, qty: 2000, weight: "27000.00" },
    ],
    containers: [{ typeId: built.containerType.id, count: 8, qty: 40, tareWeight: "2936.00" }],
  }));
  return { ...built, order };
}

describe("pdf plumbing", () => {
  it("renderPdf produces a real PDF", async () => {
    const pdf = await renderPdf({ content: [{ text: "hello" }] });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(500);
  });

  it("barcodePng encodes code 128 as a PNG", async () => {
    const png = await barcodePng("71246");
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.byteLength).toBeGreaterThan(100);
  });
});

describe("buildTravelerDefinition", () => {
  beforeEach(truncateAll);

  it("is pure: synchronous, plain JSON, and deterministic", async () => {
    const { order } = await orderFixture();
    const data = await asSystem(() => collectTravelerData(order.id));

    const def = buildTravelerDefinition(data);
    // Not a promise — no I/O can be hiding inside it.
    expect(def).not.toBeInstanceOf(Promise);
    expect(buildTravelerDefinition.constructor.name).toBe("Function");
    // Template-as-data (spec §10): the whole definition survives a JSON round trip, so nothing
    // in it is a function or any other non-serializable value Phase 7's designer could not edit.
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    // Same input, same output — the builder holds no state and reads no clock.
    expect(buildTravelerDefinition(data)).toEqual(def);
  });

  it("mirrors the mockup's sections for the mockup-shaped order", async () => {
    await asSystem(() => setSetting("company_name", "American Heat Treating Alabama"));
    await asSystem(() => setSetting("company_address", "1 Furnace Rd, Anniston, AL"));
    await asSystem(() => setSetting("company_phone", "256-256-2566"));
    const { order } = await orderFixture();
    const def = buildTravelerDefinition(await asSystem(() => collectTravelerData(order.id)));
    const text = allText(def).join("\n");

    // Header: customer + received-from address, company block, order number, load, barcode.
    expect(text).toContain("Renaissance Manufacturing Group");
    expect(text).toContain("260 Central Castings Dr.");
    expect(text).toContain("Anniston, AL 36206");
    expect(text).toContain("American Heat Treating Alabama");
    expect(text).toContain("256-256-2566");
    expect(text).toContain("Order Number");
    expect(text).toContain(String(order.orderNumber));
    expect(text).toContain("Load");
    expect(JSON.stringify(def)).toContain("data:image/png;base64,");

    // Part lines, order/load quantities, containers.
    expect(text).toContain("Part Quantity");
    expect(text).toContain("3541719C3 / U Bolt Rear Spr Plate / Machined");
    expect(text).toContain("3541720C3 / U Bolt Front Spr Plate / Machined");
    expect(text).toContain("Order Quantity");
    expect(text).toContain("4,500");
    expect(text).toContain("Drop Pan");

    // Process / Material / Process ID. The Process label prints; its VALUE is deliberately blank
    // in Phase 3 (owner ruling 2026-08-03, spec §3.9) — Phase 7's template designer owns the slot.
    expect(text).toContain("Process:");
    expect(text).toContain("Material:");
    expect(text).toContain("Ductile Iron");
    expect(text).toContain("Process ID:");
    expect(text).toContain("3541719C3");

    // Key characteristic inspections — including the §3.9 sample-quantity column.
    expect(text).toContain("Key Characteristic Inspection(s):");
    expect(text).toContain("Hardness");
    expect(text).toContain("HBW");
    expect(text).toContain("269");
    expect(text).toContain("341");
    expect(text).toContain("Mag-Particle");
    expect(text).toContain("100%");
    expect(text).toContain("flange OD");

    // Process steps with the typed field values, units included, in def order.
    expect(text).toContain("PROCESS STEPS:");
    expect(text).toContain("Austemper");
    expect(text).toContain("Pre-heat to 1100F for 1 hour minimum.");
    expect(text).toContain("Furnace Temp: 1650 °F");
    expect(text).toContain("Furnace Time: 2 hours");
    expect(text.indexOf("Furnace Temp")).toBeLessThan(text.indexOf("Furnace Time"));
    expect(text).toContain("EQ#");
    expect(text).toContain("OP");

    // Footer capture blocks.
    expect(text).toContain("RESULTS:");
    expect(text).toContain("TEMPERED RESULTS:");
    expect(text).toContain("FINAL INSPECTION:");
    expect(text).toContain("PASS");
    expect(text).toContain("FAIL");
    expect(text).toContain("Tested By:");
    expect(text).toContain("OK to Ship:");
  });

  // Owner ruling 2026-08-03 (spec §3.9): the Process cell renders nothing in Phase 3. The locked
  // revision is still carried on the payload (it governs `steps`) — it is simply not printed, and
  // neither is any other stand-in for the mockup's process name.
  it("leaves the Process cell blank while still knowing the locked revision", async () => {
    const { order } = await orderFixture();
    // ONE load, so each part name can be counted per sheet rather than times fourteen.
    const data = await asSystem(() => collectTravelerData(order.id, 1));
    expect(data.revisionNumber).toBe(1);

    const text = allText(buildTravelerDefinition(data)).join("\n");
    expect(text).toContain("Process:");
    expect(text).not.toContain("Rev ");
    // Nor the lead part's NAME as a stand-in — it belongs to the lines table, not to "Process:",
    // so it appears exactly once on the sheet.
    expect(text.match(/U Bolt Rear Spr Plate/g)).toHaveLength(1);
  });

  // Owner ruling 2026-08-03 (spec §3.9c): the mockup's {Inspection Location.bmp} slot is Phase
  // 4/7's, not Phase 3's — nothing renders there now.
  it("prints no inspection-location image", async () => {
    const { order } = await orderFixture();
    const def = buildTravelerDefinition(await asSystem(() => collectTravelerData(order.id)));
    // The ONLY image in the document is the header barcode — one per sheet, and no more.
    const images = JSON.stringify(def).match(/"image":/g) ?? [];
    expect(images).toHaveLength(14); // one per load
  });

  it("shows the LOCKED revision's steps even after the working revision changes", async () => {
    const { order, lead, step } = await orderFixture();
    const before = allText(buildTravelerDefinition(await asSystem(() => collectTravelerData(order.id)))).join("\n");
    expect(before).toContain("Pre-heat to 1100F for 1 hour minimum.");

    // Cuts revision 2 off the locked revision 1; the order still quotes 1.
    const { revisionNumber } = await asSystem(() =>
      updateStep(lead.id, step.id, { instruction: "Pre-heat to 1400F — CHANGED." }));
    expect(revisionNumber).toBe(2);

    const after = allText(buildTravelerDefinition(await asSystem(() => collectTravelerData(order.id)))).join("\n");
    expect(after).toContain("Pre-heat to 1100F for 1 hour minimum.");
    expect(after).not.toContain("CHANGED");
  });

  it("renders one sheet per load, each carrying that load's own quantity", async () => {
    const { order } = await orderFixture();
    const all = await asSystem(() => collectTravelerData(order.id));
    expect(all.sheets).toHaveLength(14);
    expect(all.sheets[0]).toMatchObject({ loadNumber: 1, loadQty: 336 });
    expect(all.sheets[13]).toMatchObject({ loadNumber: 14, loadQty: 132 });

    const single = await asSystem(() => collectTravelerData(order.id, 14));
    expect(single.sheets).toHaveLength(1);
    expect(single.sheets[0]).toMatchObject({ loadNumber: 14, loadQty: 132 });

    const text = allText(buildTravelerDefinition(single)).join("\n");
    expect(text).toContain("132");
    expect(text).not.toContain("336");
    // The load's own weight rides under its piece count.
    expect(text).toContain(`${single.sheets[0].loadWeight!.toLocaleString("en-US")} lb`);
  });

  it("404s a load number the order does not have", async () => {
    const { order } = await orderFixture();
    await expect(asSystem(() => collectTravelerData(order.id, 99)))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe("printTraveler", () => {
  beforeEach(truncateAll);

  it("stores the rendered PDF and returns the same bytes", async () => {
    const { order } = await orderFixture();
    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const stored = await getDocument(documentId);
    expect(stored).toMatchObject({ orderId: order.id, kind: "TRAVELER", loadNumber: null });
    expect(Buffer.compare(stored.fileData, pdf)).toBe(0);
  });

  it("a reprint streams the stored bytes untouched, never a fresh render", async () => {
    const { order } = await orderFixture();
    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    const first = await getDocument(documentId);
    const second = await getDocument(documentId);
    expect(Buffer.compare(first.fileData, pdf)).toBe(0);
    expect(Buffer.compare(first.fileData, second.fileData)).toBe(0);
  });

  it("prints one load on request and records the load number", async () => {
    const { order } = await orderFixture();
    const { documentId } = await asSystem(() => printTraveler(order.id, 3));
    expect(await getDocument(documentId)).toMatchObject({ loadNumber: 3 });
  });

  it("404s a missing order", async () => {
    await expect(asSystem(() => printTraveler("nope"))).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a NEW print on a voided order but keeps stored prints readable", async () => {
    const { order } = await orderFixture();
    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    await asSystem(() => voidOrder(order.id, "keyed against the wrong PO"));

    await expect(asSystem(() => printTraveler(order.id)))
      .rejects.toThrow("Cannot print a traveler for a voided order");

    // Reads keep working (spec §5c) — the stored print is still listed and still reprintable.
    const docs = await listDocuments(order.id);
    expect(docs.map((d) => d.id)).toEqual([documentId]);
    expect(Buffer.compare((await getDocument(documentId)).fileData, pdf)).toBe(0);
  });

  // Fix-wave R2 finding 4: the in-tx re-check (`live = await tx.order.findFirst(...)`) used to
  // read the order's deletedAt WITHOUT taking any lock on the row, so a void committing in the
  // gap between that read and the storedDocument insert could land unnoticed — a print archiving
  // against an order that is, by the time anyone looks, already voided. The fix claims the Order
  // row with `SELECT … FOR UPDATE` before the re-check, inside the same transaction, so it can
  // never observe deletedAt as `null` while a concurrent void is either committing or about to.
  //
  // The discriminating shape is tests/part-process-steps.test.ts's holder pattern: a holder
  // transaction takes the exact same row lock, signals it has claimed it, and only performs the
  // void (mirroring voidOrder's own update, which blocks on the same row at any isolation) WHILE
  // STILL HOLDING that lock, releasing (committing) only once told to. A genuine `FOR UPDATE`
  // claim inside printTraveler cannot proceed past the holder until the holder's void has
  // committed, so the re-check necessarily runs on the fresh, post-void row and correctly refuses.
  // A plain (unlocked) re-check — the regression — would read the STALE pre-void row instead,
  // since nothing makes it wait for the holder at all, and would archive a document it should not.
  it("a void committing while a print is in flight cannot let the print through (row-lock race)", async () => {
    const { order } = await orderFixture();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
      // Only now, still inside the same held transaction: void the order (the exact write
      // voidOrder's own transaction performs) before committing (and releasing the row lock).
      await tx.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });
    }, { timeout: 20000 });

    await claimed;
    const printCall = asSystem(() => printTraveler(order.id));

    // Not itself the discriminator (see above) — its job is to guarantee printTraveler's own
    // claim has actually been dispatched, and in the correct implementation is genuinely blocked
    // on the holder, before the holder is released — otherwise the stale-vs-fresh read below
    // would be a coincidence of scheduling rather than a real test of the claim.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      printCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: with the FOR UPDATE genuinely in effect, printTraveler cannot decide
    // "not voided" until after the holder's void has committed, so it must see the order voided
    // and refuse — no document is ever archived against it.
    await expect(printCall).rejects.toMatchObject({
      status: 400, message: "Cannot print a traveler for a voided order",
    });
    expect(await prisma.storedDocument.count({ where: { orderId: order.id } })).toBe(0);
  });

  /**
   * Fix-wave R4 finding 8. The claim being asserted: between the print transaction's OPEN and its
   * COMMIT there is no query against the top-level client.
   *
   * `collectTravelerData` used to run all six of its reads — the order graph, the line parts, the
   * customer, its addresses, the lead part's inspections, the locked revision — plus three
   * settings reads, against `prisma` while `printTraveler`'s transaction sat holding a connection
   * of its own. Every concurrent print therefore held one connection idle and competed for a
   * second: with a pool of N, N simultaneous prints can each hold one and wait for one only
   * another holder can release. It also quietly undercut the R3 claim above — the reads that
   * decide what the PDF says were NOT taken in the snapshot the claim was taken in.
   *
   * The fix threads the transaction through every one of those reads (`readTravelerData(tx, …)`,
   * with `listAddresses`/`listPartInspections`/`getRevision` each taking the client) and moves the
   * settings OUT of the transaction entirely, ahead of it — the `createOrder` precedent, and safe
   * because settings are read-only and are not order state.
   *
   * Asserted by intercepting the TOP-LEVEL delegates and recording whether each call happened
   * while a transaction was open — the attachments.test.ts technique ("prove the checks really did
   * move by intercepting the top-level delegates and asserting neither is reached"), not new
   * instrumentation. Plain save-reassign-restore, never `vi.spyOn`: on this Prisma Client's model
   * delegates `mockRestore()` leaves the property `undefined`, and `prisma` is a process-wide
   * singleton.
   */
  it("performs no top-level-client query between the print transaction's open and its commit", async () => {
    const { order } = await orderFixture();

    const MODELS = [
      "order", "part", "customer", "customerAddress", "partInspection", "partProcessRevision",
      "setting", "storedDocument", "auditLog",
    ] as const;
    const METHODS = ["findFirst", "findMany", "findUnique", "findUniqueOrThrow", "count", "create"] as const;

    let depth = 0;
    const calls: { where: string; insideTx: boolean }[] = [];
    const client = prisma as unknown as Record<string, unknown>;
    const realTx = client.$transaction as (...a: unknown[]) => unknown;
    const restore: (() => void)[] = [() => { client.$transaction = realTx; }];

    client.$transaction = async (...args: unknown[]) => {
      depth++;
      try {
        return await realTx.apply(prisma, args);
      } finally {
        depth--;
      }
    };
    for (const model of MODELS) {
      const delegate = client[model] as Record<string, unknown>;
      for (const method of METHODS) {
        const real = delegate[method] as ((...a: unknown[]) => unknown) | undefined;
        if (typeof real !== "function") continue;
        restore.push(() => { delegate[method] = real; });
        delegate[method] = (...args: unknown[]) => {
          calls.push({ where: `${model}.${method}`, insideTx: depth > 0 });
          return real.apply(delegate, args);
        };
      }
    }

    try {
      await asSystem(() => printTraveler(order.id));
    } finally {
      for (const undo of restore.reverse()) undo();
    }

    // The interception itself has to have worked, or this proves nothing: the settings reads
    // happen on the top-level client BY DESIGN, before the transaction opens, and are the proof
    // that a top-level call really would have been recorded.
    expect(calls.some((c) => c.where.startsWith("setting.") && !c.insideTx)).toBe(true);
    // The claim.
    expect(calls.filter((c) => c.insideTx)).toEqual([]);
  });

  // Fix-wave R3 finding 1: `collectTravelerData` (the read that decides what the PDF says) used
  // to run BEFORE printTraveler ever took ANY lock at all — the OLD claim (above) only wrapped
  // the final archive-commit. A child mutation committing during that unlocked window left the
  // archived traveler describing pre-edit state, with no warning possible: nothing about the
  // archive itself was wrong, the document simply didn't exist yet when the stale read happened.
  // The fix moves the claim to the FRONT of printTraveler: it now claims (via the shared
  // `claimOrder`, order-locks.ts — the same helper every order-family mutator opens with) BEFORE it
  // ever calls `collectTravelerData`, and holds it through render and archive. A load that
  // changes while this claim is held cannot be missed by a print that started before the change
  // committed — the print simply cannot read anything until the change (and the claim it needed)
  // is out of the way.
  //
  // Discriminating shape: a holder takes the exact row lock `claimOrder` gives every mutator,
  // then — still holding it — performs the SAME kind of write `replaceLoads` makes (a direct
  // Load rewrite), standing in for "an edit landed while the row was claimed" the same way round
  // 2's holder stands in for voidOrder's own update. printTraveler is only STARTED once the
  // holder confirms its claim, so the fixed implementation cannot read anything until the holder
  // releases; the regression (claim taken only at the very end) would already have captured the
  // pre-edit snapshot long before this point, and the holder's later edit would have no way to
  // change what gets archived.
  it("an edit that lands while the row is claimed is what the archived traveler ends up describing (edit wins the claim race)", async () => {
    const { order } = await orderFixture(); // 14 auto-split loads -> 14 sheets/pages

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
      // Still holding the claim: the edit itself — collapsing every load into one, the same
      // shape replaceLoads' own two-phase `applyLoads` rewrite produces (order-loads.ts) —
      // committed only when this transaction commits, right below.
      const loads = await tx.load.findMany({ where: { orderId: order.id }, orderBy: { loadNumber: "asc" } });
      await tx.load.update({ where: { id: loads[0].id }, data: { qty: 4500, weight: "60750.00" } });
      await tx.load.deleteMany({ where: { id: { in: loads.slice(1).map((l) => l.id) } } });
    }, { timeout: 20000 });

    await claimed;
    const printCall = asSystem(() => printTraveler(order.id));

    // Not itself the discriminator (see above) — its job is to guarantee printTraveler's own
    // claim attempt has actually been dispatched, and in the correct implementation is genuinely
    // blocked on the holder, before the holder is released.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      printCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;
    const { pdf } = await printCall;

    // The discriminator: what got archived must show exactly ONE page (the collapsed load) —
    // proof printTraveler's own content read happened strictly AFTER the holder's edit committed,
    // never against the 14-sheet snapshot that existed when this test started. A regression
    // (claim taken only at the very end, after the stale read+render already happened) would
    // archive 14 pages here instead.
    expect(pageCount(pdf)).toBe(1);
  });

  // The opposite ordering: the (simulated) print's claim wins the race — it reaches the row
  // first — so a concurrent edit must wait for its ENTIRE operation to finish, archive included;
  // once unblocked, the edit lands cleanly and the archived traveler is left showing the
  // snapshot exactly as it stood before the edit ever started.
  it("a print that claims first is undisturbed by a concurrent edit, which lands only afterward", async () => {
    const { order } = await orderFixture();
    const preEditData = await asSystem(() => collectTravelerData(order.id));
    expect(preEditData.sheets).toHaveLength(14);
    const preEditPdf = await renderPdf(buildTravelerDefinition(preEditData));

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // Holder stands in for printTraveler having already won the claim race and rendered — it
    // archives the SAME bytes a real print would have produced off this pre-edit state, then
    // releases only once told to (mirroring round 2's holder standing in for voidOrder's write).
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
      const meta = { orderId: order.id, kind: "TRAVELER" as const, loadNumber: null };
      await tx.storedDocument.create({ data: { ...meta, fileData: new Uint8Array(preEditPdf) } });
    }, { timeout: 20000 });

    await claimed;
    const replaceCall = asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 4500, weight: "60750.00" }]));

    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      replaceCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;
    const { order: afterEdit } = await replaceCall;

    // The edit landed, but only after the print's own archive was already committed.
    expect(afterEdit.loads).toHaveLength(1);
    expect(afterEdit.loads[0]).toMatchObject({ qty: 4500, weight: 60750 });

    // ...and the archived traveler is untouched — still exactly the pre-edit snapshot.
    const docs = await listDocuments(order.id);
    expect(docs).toHaveLength(1);
    const archived = await getDocument(docs[0].id);
    expect(Buffer.compare(archived.fileData, preEditPdf)).toBe(0);
  });

  /**
   * The §5b hazard the service's own comments cite: loads stay EDITABLE after a traveler prints
   * (owner ruling §3.3), so a re-render after such an edit legitimately produces a different
   * document. What must never happen is the earlier print changing under the shop's feet — the
   * paper on the floor and the archived file have to keep saying the same thing. Hence
   * `getDocument` streams stored bytes and never re-renders.
   */
  it("a load edit after printing changes the NEXT print, never the stored one", async () => {
    const { order } = await orderFixture();
    const first = await asSystem(() => printTraveler(order.id));
    const archived = await getDocument(first.documentId);
    expect(Buffer.compare(archived.fileData, first.pdf)).toBe(0);

    // Fourteen auto-split loads collapsed to two by hand — a legal post-print edit.
    await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 2500, weight: "33750.00" },
      { loadNumber: 2, qty: 2000, weight: "27000.00" },
    ]));

    const second = await asSystem(() => printTraveler(order.id));
    expect(second.documentId).not.toBe(first.documentId);
    // A genuinely different document: two sheets now, not fourteen.
    expect(Buffer.compare(second.pdf, first.pdf)).not.toBe(0);
    expect((await asSystem(() => collectTravelerData(order.id))).sheets).toHaveLength(2);

    // …and the FIRST print is byte-for-byte what it always was.
    expect(Buffer.compare((await getDocument(first.documentId)).fileData, archived.fileData)).toBe(0);
    expect((await listDocuments(order.id)).map((d) => d.id))
      .toEqual([second.documentId, first.documentId]);
  });

  it("audits the store as a storedDocument create carrying metadata, never bytes", async () => {
    const { order } = await orderFixture();
    const { documentId } = await asSystem(() => printTraveler(order.id, 2));
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "storedDocument", entityId: documentId, action: "create" } });
    expect(entry).not.toBeNull();
    const after = entry!.after as Record<string, unknown>;
    expect(after).toMatchObject({ orderId: order.id, kind: "TRAVELER", loadNumber: 2 });
    expect(JSON.stringify(after)).not.toContain("%PDF");
    expect(after.fileData).toBeUndefined();
  });
});

describe("listDocuments / getDocument", () => {
  beforeEach(truncateAll);

  it("lists newest first, without the bytes", async () => {
    const { order } = await orderFixture();
    const first = await asSystem(() => printTraveler(order.id, 1));
    const second = await asSystem(() => printTraveler(order.id, 2));
    const third = await asSystem(() => printTraveler(order.id));

    const docs = await listDocuments(order.id);
    expect(docs.map((d) => d.id)).toEqual([third.documentId, second.documentId, first.documentId]);
    expect(docs.map((d) => d.loadNumber)).toEqual([null, 2, 1]);
    expect(docs.every((d) => d.kind === "TRAVELER")).toBe(true);
    expect(docs.every((d) => !("fileData" in d))).toBe(true);
  });

  it("404s a missing order and a missing document", async () => {
    await expect(listDocuments("nope")).rejects.toMatchObject({ status: 404 });
    await expect(getDocument("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("traveler routes", () => {
  beforeEach(truncateAll);

  it("POST /api/orders/[id]/traveler streams a PDF for orders.view", async () => {
    const { order } = await orderFixture();
    const cookie = await signInWith(["orders.view"]);
    const res = await travelerRoute(
      req(`http://t/api/orders/${order.id}/traveler`, "POST", cookie), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const docs = await listDocuments(order.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].loadNumber).toBeNull();
  });

  it("POST ?load=N stores that load only; a non-numeric load is a 400", async () => {
    const { order } = await orderFixture();
    const cookie = await signInWith(["orders.view"]);
    const res = await travelerRoute(
      req(`http://t/api/orders/${order.id}/traveler?load=5`, "POST", cookie), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    expect((await listDocuments(order.id))[0].loadNumber).toBe(5);

    const bad = await travelerRoute(
      req(`http://t/api/orders/${order.id}/traveler?load=abc`, "POST", cookie), withParams({ id: order.id }));
    expect(bad.status).toBe(400);
  });

  it("GET /api/orders/[id]/documents lists, GET /api/documents/[docId] streams the bytes", async () => {
    const { order } = await orderFixture();
    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    const cookie = await signInWith(["orders.view"]);

    const list = await documentsRoute(
      req(`http://t/api/orders/${order.id}/documents`, "GET", cookie), withParams({ id: order.id }));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject([{ id: documentId, kind: "TRAVELER", loadNumber: null }]);

    const one = await documentRoute(
      req(`http://t/api/documents/${documentId}`, "GET", cookie), withParams({ docId: documentId }));
    expect(one.status).toBe(200);
    expect(one.headers.get("content-type")).toBe("application/pdf");
    expect(one.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.compare(Buffer.from(await one.arrayBuffer()), pdf)).toBe(0);
  });

  it("every traveler route 401s signed out and 403s without orders.view", async () => {
    const { order } = await orderFixture();
    const { documentId } = await asSystem(() => printTraveler(order.id));
    const wrong = await signInWith(["parts.view"], "nobody");

    const calls: [() => Promise<Response>, string][] = [
      [() => travelerRoute(req(`http://t/x`, "POST"), withParams({ id: order.id })), "traveler"],
      [() => documentsRoute(req(`http://t/x`, "GET"), withParams({ id: order.id })), "documents"],
      [() => documentRoute(req(`http://t/x`, "GET"), withParams({ docId: documentId })), "document"],
    ];
    for (const [call, name] of calls) expect((await call()).status, name).toBe(401);

    const forbidden: [() => Promise<Response>, string][] = [
      [() => travelerRoute(req(`http://t/x`, "POST", wrong), withParams({ id: order.id })), "traveler"],
      [() => documentsRoute(req(`http://t/x`, "GET", wrong), withParams({ id: order.id })), "documents"],
      [() => documentRoute(req(`http://t/x`, "GET", wrong), withParams({ docId: documentId })), "document"],
    ];
    for (const [call, name] of forbidden) expect((await call()).status, name).toBe(403);
  });

  it("POST refuses a voided order with a 400 while its documents stay readable", async () => {
    const { order } = await orderFixture();
    const { documentId } = await asSystem(() => printTraveler(order.id));
    await asSystem(() => voidOrder(order.id, "duplicate entry"));
    const cookie = await signInWith(["orders.view"]);

    const res = await travelerRoute(
      req(`http://t/api/orders/${order.id}/traveler`, "POST", cookie), withParams({ id: order.id }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot print a traveler for a voided order");

    const list = await documentsRoute(
      req(`http://t/api/orders/${order.id}/documents`, "GET", cookie), withParams({ id: order.id }));
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveLength(1);
    const one = await documentRoute(
      req(`http://t/api/documents/${documentId}`, "GET", cookie), withParams({ docId: documentId }));
    expect(one.status).toBe(200);
  });
});

describe("traveler edge shapes", () => {
  beforeEach(truncateAll);

  it("survives blank company settings, no addresses, no inspections and no containers", async () => {
    const customer = await prisma.customer.create({ data: { code: "BARE", name: "Bare Co" } });
    const code = await prisma.processStepCode.create({ data: { code: "HT", name: "Heat" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-1", eachWeight: "1.0000" } });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id } });

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 5, weight: "5.00" }] }));

    const data: TravelerData = await asSystem(() => collectTravelerData(order.id));
    expect(data.receivedFrom).toEqual([]);
    expect(data.inspections).toEqual([]);
    expect(data.containers).toEqual([]);

    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
