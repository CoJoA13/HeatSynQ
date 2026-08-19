import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createQuote, type QuoteDetail } from "@/server/quotes";

import { GET as listRoute, POST as createRoute } from "@/app/api/quotes/route";
import { GET as exportRoute } from "@/app/api/quotes/export/route";
import { GET as getRoute, PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/quotes/[id]/route";
import { POST as closeRoute } from "@/app/api/quotes/[id]/close/route";
import { POST as reopenRoute } from "@/app/api/quotes/[id]/reopen/route";
import { POST as attachRoute } from "@/app/api/quotes/[id]/attach-part/route";
import { GET as blockersExportRoute } from "@/app/api/quotes/[id]/blockers/export/route";
import { GET as eligibleRoute } from "@/app/api/quotes/eligible/route";

const noParams = { params: Promise.resolve({}) };
const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function bodyReq(url: string, method: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// -------------------------------------------------------------------------------------------
// Fixtures — through the SERVICE, never a route under test (the invoice-routes.test.ts rule: a
// bug in some other route must not be able to mask a bug in the one this file exercises).
// -------------------------------------------------------------------------------------------

let seq = 0;
async function fixture() {
  seq += 1;
  const quoter = await prisma.user.create({
    data: { username: `qr-quoter-${seq}`, passwordHash: "x", displayName: `Quoter ${seq}` },
  });
  const customer = await prisma.customer.create({
    data: { code: `QRC${seq}`, name: `Quote Route Customer ${seq}` },
  });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `QRP-${seq}`, eachWeight: "1.0000" },
  });
  const part2 = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `QRP2-${seq}`, eachWeight: "1.0000" },
  });
  const step = await prisma.processStepCode.create({
    data: { code: `QRHT-${seq}`, name: "Harden" },
  });
  return { quoter, customer, part, part2, step };
}

async function savedQuote(f: Awaited<ReturnType<typeof fixture>>): Promise<QuoteDetail> {
  return asSystem(() => createQuote({
    customerId: f.customer.id, quotedById: f.quoter.id,
    lines: [
      { partId: f.part.id, prices: [{ processStepCodeId: f.step.id, unitPrice: "0.1500" }] },
      { partNumberText: "FT-R", prices: [] },
    ],
  }));
}

/** A live order whose first line links the given quote line — the §5.14 blocker fixture. */
async function linkOrder(f: Awaited<ReturnType<typeof fixture>>, orderNumber: number, quoteLineId: string) {
  return prisma.order.create({
    data: {
      orderNumber, customerId: f.customer.id,
      receivedDate: new Date(), requestDate: new Date(),
      lines: { create: [{ position: 1, partId: f.part.id, qty: 5, weight: "10.00", quoteLineId }] },
    },
  });
}

describe("GET /api/quotes — list and worklist", () => {
  beforeEach(truncateAll);

  it("requires a session, then quotes.view", async () => {
    expect((await listRoute(getReq("http://t/api/quotes"), noParams)).status).toBe(401);
    const wrong = await signInWith(["orders.view"], "q-list-wrong");
    expect((await listRoute(getReq("http://t/api/quotes", wrong), noParams)).status).toBe(403);
  });

  it("lists quotes, honors filters, and rejects malformed status/flag params as 400s", async () => {
    const f = await fixture();
    await savedQuote(f);
    const viewer = await signInWith(["quotes.view"], "q-list-viewer");

    const res = await listRoute(getReq("http://t/api/quotes", viewer), noParams);
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].customerCode).toBe(f.customer.code);

    const filtered = await listRoute(
      getReq(`http://t/api/quotes?customerId=${f.customer.id}&status=OPEN&expired=0`, viewer), noParams);
    expect(await filtered.json()).toHaveLength(1);

    expect((await listRoute(getReq("http://t/api/quotes?status=NOPE", viewer), noParams)).status).toBe(400);
    expect((await listRoute(getReq("http://t/api/quotes?expired=yes", viewer), noParams)).status).toBe(400);
  });

  it("worklist=1 returns the two §5.4 sections with counts", async () => {
    const f = await fixture();
    await savedQuote(f);
    const viewer = await signInWith(["quotes.view"], "q-work-viewer");
    const res = await listRoute(getReq("http://t/api/quotes?worklist=1", viewer), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.followUpDue).toEqual({ count: 0, rows: [] });
    expect(body.expired).toEqual({ count: 0, rows: [] });
  });
});

describe("POST /api/quotes", () => {
  beforeEach(truncateAll);

  it("requires quotes.create; the session user is the default quoter", async () => {
    const f = await fixture();
    const viewer = await signInWith(["quotes.view"], "q-create-wrong");
    const input = {
      customerId: f.customer.id,
      lines: [{ partId: f.part.id, prices: [] }],
    };
    expect((await createRoute(bodyReq("http://t/api/quotes", "POST", viewer, input), noParams)).status)
      .toBe(403);

    const creator = await signInWith(["quotes.create"], "q-create-ok");
    const res = await createRoute(bodyReq("http://t/api/quotes", "POST", creator, input), noParams);
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.quoteNumber).toBe(1000);
    expect(detail.quotedByName).toBe("q-create-ok"); // the actor flowed through the route context

    // Ruling 7's warnings ride the route response (Task 12): quiet with no sibling, and a second
    // create for the same part over the same default window warns — a 200 both times.
    expect(detail.warnings).toEqual([]);
    const res2 = await createRoute(bodyReq("http://t/api/quotes", "POST", creator, input), noParams);
    expect(res2.status).toBe(200);
    const detail2 = await res2.json();
    expect(detail2.warnings).toHaveLength(1);
    expect(detail2.warnings[0]).toContain(f.part.partNumber);
    expect(detail2.warnings[0]).toContain(`#${detail.quoteNumber}`);
  });
});

describe("GET/PATCH/DELETE /api/quotes/[id]", () => {
  beforeEach(truncateAll);

  it("GET requires quotes.view; unknown ids 404", async () => {
    const f = await fixture();
    const q = await savedQuote(f);
    const wrong = await signInWith(["orders.view"], "q-get-wrong");
    expect((await getRoute(getReq(`http://t/api/quotes/${q.id}`, wrong), withParams({ id: q.id }))).status)
      .toBe(403);
    const viewer = await signInWith(["quotes.view"], "q-get-viewer");
    const res = await getRoute(getReq(`http://t/api/quotes/${q.id}`, viewer), withParams({ id: q.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(q.id);
    expect((await getRoute(getReq("http://t/api/quotes/nope", viewer), withParams({ id: "nope" }))).status)
      .toBe(404);
  });

  it("PATCH requires quotes.edit, refuses an empty body, and delegates — customerId immutability included", async () => {
    const f = await fixture();
    const q = await savedQuote(f);
    const viewer = await signInWith(["quotes.view"], "q-patch-wrong");
    expect((await patchRoute(
      bodyReq(`http://t/api/quotes/${q.id}`, "PATCH", viewer, { notes: "x" }), withParams({ id: q.id }),
    )).status).toBe(403);

    const editor = await signInWith(["quotes.edit"], "q-patch-editor");
    expect((await patchRoute(
      bodyReq(`http://t/api/quotes/${q.id}`, "PATCH", editor, {}), withParams({ id: q.id }),
    )).status).toBe(400);

    const res = await patchRoute(
      bodyReq(`http://t/api/quotes/${q.id}`, "PATCH", editor, { notes: "edited via route" }),
      withParams({ id: q.id }));
    expect(res.status).toBe(200);
    const patched = await res.json();
    expect(patched.notes).toBe("edited via route");
    expect(patched.warnings).toEqual([]); // the ruling-7 rider is on every update response

    const other = await prisma.customer.create({ data: { code: "QR-X", name: "Other" } });
    const immutable = await patchRoute(
      bodyReq(`http://t/api/quotes/${q.id}`, "PATCH", editor, { customerId: other.id }),
      withParams({ id: q.id }));
    expect(immutable.status).toBe(400);
  });

  it("DELETE requires quotes.delete and a reason; a linked quote is refused with its orders named", async () => {
    const f = await fixture();
    const q = await savedQuote(f);
    const editor = await signInWith(["quotes.edit"], "q-del-wrong");
    expect((await deleteRoute(
      bodyReq(`http://t/api/quotes/${q.id}`, "DELETE", editor, { reason: "x" }), withParams({ id: q.id }),
    )).status).toBe(403);

    const deleter = await signInWith(["quotes.delete"], "q-del-ok");
    // No reason — the service's own §5.17 400, not a parse error.
    expect((await deleteRoute(
      new Request(`http://t/api/quotes/${q.id}`, { method: "DELETE", headers: { cookie: deleter } }),
      withParams({ id: q.id }),
    )).status).toBe(400);

    await linkOrder(f, 7101, q.lines[0].id);
    const blocked = await deleteRoute(
      bodyReq(`http://t/api/quotes/${q.id}`, "DELETE", deleter, { reason: "try" }), withParams({ id: q.id }));
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toContain("#7101");

    await prisma.order.updateMany({ where: { orderNumber: 7101 }, data: { deletedAt: new Date() } });
    const res = await deleteRoute(
      bodyReq(`http://t/api/quotes/${q.id}`, "DELETE", deleter, { reason: "typo" }), withParams({ id: q.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await prisma.quote.findFirst({ where: { id: q.id } }))?.deletedAt).not.toBeNull();
  });
});

describe("POST /api/quotes/[id]/close and /reopen", () => {
  beforeEach(truncateAll);

  it("both gate on quotes.edit; close returns the warn-list; reopen restores OPEN", async () => {
    const f = await fixture();
    const q = await savedQuote(f);
    await linkOrder(f, 7102, q.lines[0].id);

    const viewer = await signInWith(["quotes.view"], "q-close-wrong");
    expect((await closeRoute(
      bodyReq(`http://t/api/quotes/${q.id}/close`, "POST", viewer, { reason: "x" }), withParams({ id: q.id }),
    )).status).toBe(403);

    const editor = await signInWith(["quotes.edit"], "q-close-editor");
    // Blank reason -> the service's §5.17 400.
    expect((await closeRoute(
      bodyReq(`http://t/api/quotes/${q.id}/close`, "POST", editor, { reason: "  " }), withParams({ id: q.id }),
    )).status).toBe(400);

    const res = await closeRoute(
      bodyReq(`http://t/api/quotes/${q.id}/close`, "POST", editor, { reason: "won elsewhere" }),
      withParams({ id: q.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.status).toBe("CLOSED");
    expect(body.linkedOpenOrders.map((o: { orderNumber: number }) => o.orderNumber)).toEqual([7102]);

    expect((await reopenRoute(
      bodyReq(`http://t/api/quotes/${q.id}/reopen`, "POST", viewer, { reason: "x" }), withParams({ id: q.id }),
    )).status).toBe(403);
    const reopened = await reopenRoute(
      bodyReq(`http://t/api/quotes/${q.id}/reopen`, "POST", editor, { reason: "came back" }),
      withParams({ id: q.id }));
    expect(reopened.status).toBe(200);
    expect((await reopened.json()).status).toBe("OPEN");
  });
});

describe("POST /api/quotes/[id]/attach-part", () => {
  beforeEach(truncateAll);

  it("gates on quotes.edit and attaches the part to the free-text line", async () => {
    const f = await fixture();
    const q = await savedQuote(f);
    const freeText = q.lines[1];

    const viewer = await signInWith(["quotes.view"], "q-attach-wrong");
    expect((await attachRoute(
      bodyReq(`http://t/api/quotes/${q.id}/attach-part`, "POST", viewer,
        { lineId: freeText.id, partId: f.part2.id }),
      withParams({ id: q.id }),
    )).status).toBe(403);

    const editor = await signInWith(["quotes.edit"], "q-attach-editor");
    // .strict() — an unknown key is a clean 400, not silently dropped.
    expect((await attachRoute(
      bodyReq(`http://t/api/quotes/${q.id}/attach-part`, "POST", editor,
        { lineId: freeText.id, partId: f.part2.id, extra: true }),
      withParams({ id: q.id }),
    )).status).toBe(400);

    const res = await attachRoute(
      bodyReq(`http://t/api/quotes/${q.id}/attach-part`, "POST", editor,
        { lineId: freeText.id, partId: f.part2.id }),
      withParams({ id: q.id }));
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.lines[1].partId).toBe(f.part2.id);
    expect(detail.lines[1].partNumber).toBe(f.part2.partNumber);
    expect(detail.warnings).toEqual([]); // the ruling-7 rider — no overlapping sibling here
  });
});

describe("the two Excel exports", () => {
  beforeEach(truncateAll);

  it("GET /api/quotes/export streams the filtered list as a workbook, gated on quotes.view", async () => {
    const f = await fixture();
    await savedQuote(f);
    const wrong = await signInWith(["orders.view"], "q-export-wrong");
    expect((await exportRoute(getReq("http://t/api/quotes/export", wrong), noParams)).status).toBe(403);

    const viewer = await signInWith(["quotes.view"], "q-export-viewer");
    const res = await exportRoute(getReq("http://t/api/quotes/export", viewer), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type"))
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toContain("Quotes.xlsx");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Quotes")!;
    expect(sheet.rowCount).toBe(2);
    expect((sheet.getRow(2).values as unknown[])[1]).toBe(1000);
  });

  it("GET /api/quotes/[id]/blockers/export names the linked orders — the §5.14 discoverability ride-along", async () => {
    const f = await fixture();
    const q = await savedQuote(f);
    await linkOrder(f, 7103, q.lines[0].id);

    const wrong = await signInWith(["orders.view"], "q-blockers-wrong");
    expect((await blockersExportRoute(
      getReq(`http://t/api/quotes/${q.id}/blockers/export`, wrong), withParams({ id: q.id }),
    )).status).toBe(403);

    const viewer = await signInWith(["quotes.view"], "q-blockers-viewer");
    const res = await blockersExportRoute(
      getReq(`http://t/api/quotes/${q.id}/blockers/export`, viewer), withParams({ id: q.id }));
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Blockers")!;
    expect(sheet.rowCount).toBe(2);
    const row = (sheet.getRow(2).values as unknown[]).slice(1);
    expect(row[0]).toBe("Order");
    expect(row[1]).toBe(`#7103 · ${f.customer.code}`);
  });
});

describe("GET /api/quotes/eligible — the entry UI's link-resolution preview (Task 5)", () => {
  beforeEach(truncateAll);

  /** Two OPEN quotes over the same part, different effective dates — 1001 is the ruling-7
   *  winner as of 2026-08-15. Built through the service (the file's fixture rule). */
  async function twoQuotes(f: Awaited<ReturnType<typeof fixture>>) {
    const older = await asSystem(() => createQuote({
      customerId: f.customer.id, quotedById: f.quoter.id,
      quoteDate: "2026-07-01", effectiveDate: "2026-07-01", expiryDate: "2026-12-31",
      lines: [{ partId: f.part.id, prices: [] }],
    }));
    const winner = await asSystem(() => createQuote({
      customerId: f.customer.id, quotedById: f.quoter.id,
      quoteDate: "2026-08-01", effectiveDate: "2026-08-01", expiryDate: "2026-12-31",
      lines: [{ partId: f.part.id, prices: [] }],
    }));
    return { older, winner };
  }

  it("gates on orders.view OR quotes.view — it serves order entry AND the part page's indicator (#101)", async () => {
    const f = await fixture();
    const url = `http://t/api/quotes/eligible?customerId=${f.customer.id}&partId=${f.part.id}`;
    expect((await eligibleRoute(getReq(url), noParams)).status).toBe(401);

    // quotes.view alone now suffices (#101, owner ruling 5 of the Phase 6 demo): the part
    // page's Active-quotes indicator reads this route too.
    const quotesOnly = await signInWith(["quotes.view"], "q-elig-quotes");
    expect((await eligibleRoute(getReq(url, quotesOnly), noParams)).status).toBe(200);

    const entry = await signInWith(["orders.view"], "q-elig-entry");
    expect((await eligibleRoute(getReq(url, entry), noParams)).status).toBe(200);

    // Neither permission: the 403 names BOTH gates (§5.16 — never a silent denial).
    const neither = await signInWith(["parts.view"], "q-elig-neither");
    const res = await eligibleRoute(getReq(url, neither), noParams);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("Requires orders.view or quotes.view");
  });

  it("returns the ruling-7 ordering plus which candidate auto-resolves", async () => {
    const f = await fixture();
    const { older, winner } = await twoQuotes(f);
    const viewer = await signInWith(["orders.view"], "q-elig-viewer");

    const res = await eligibleRoute(getReq(
      `http://t/api/quotes/eligible?customerId=${f.customer.id}&partId=${f.part.id}&receivedDate=2026-08-15`,
      viewer), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toEqual([
      {
        quoteLineId: winner.lines[0].id, quoteId: winner.id, quoteNumber: winner.quoteNumber,
        effectiveDate: "2026-08-01", expiryDate: "2026-12-31",
      },
      {
        quoteLineId: older.lines[0].id, quoteId: older.id, quoteNumber: older.quoteNumber,
        effectiveDate: "2026-07-01", expiryDate: "2026-12-31",
      },
    ]);
    expect(body.autoLink).toEqual(body.candidates[0]);
  });

  it("an out-of-window received date previews no candidates and a null auto-link", async () => {
    const f = await fixture();
    await twoQuotes(f);
    const viewer = await signInWith(["orders.view"], "q-elig-none");
    const res = await eligibleRoute(getReq(
      `http://t/api/quotes/eligible?customerId=${f.customer.id}&partId=${f.part.id}&receivedDate=2026-06-15`,
      viewer), noParams);
    expect(await res.json()).toEqual({ candidates: [], autoLink: null });
  });

  it("400s a missing customerId or partId (blank = absent) and a malformed receivedDate", async () => {
    const f = await fixture();
    const viewer = await signInWith(["orders.view"], "q-elig-400");
    expect((await eligibleRoute(getReq(
      `http://t/api/quotes/eligible?customerId=&partId=${f.part.id}`, viewer), noParams)).status).toBe(400);
    expect((await eligibleRoute(getReq(
      `http://t/api/quotes/eligible?customerId=${f.customer.id}`, viewer), noParams)).status).toBe(400);
    expect((await eligibleRoute(getReq(
      `http://t/api/quotes/eligible?customerId=${f.customer.id}&partId=${f.part.id}&receivedDate=nope`,
      viewer), noParams)).status).toBe(400);
  });
});
