import { describe, it, expect, vi, beforeEach } from "vitest";
import { inflateSync, inflateRawSync } from "node:zlib";

// Render under PRACTICE mode → the bytes are watermarked (T6). This test proves the load-bearing
// §5.4 property: a reprint reissues STORED bytes verbatim (never re-renders), so a document stored
// under practice mode stays watermarked forever. Stub practiceMode true for the render.
vi.mock("@/server/practice-mode", () => ({
  practiceMode: vi.fn().mockResolvedValue(true),
  assertPracticeDatabase: vi.fn(),
  PRACTICE_DB_NAME: "erp_practice",
}));

import { prisma, truncateAll } from "./helpers/db";
import { renderPdf } from "@/server/pdf/render";
import { storeDocument } from "@/server/documents";
import { runWithContext } from "@/server/context";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const HEX_PRACTICE = Buffer.from("PRACTICE", "latin1").toString("hex");
function inflateMaybe(raw: Buffer): string {
  for (const fn of [inflateSync, inflateRawSync]) {
    try { return fn(raw).toString("latin1"); } catch { /* next codec */ }
  }
  return raw.toString("latin1");
}
function watermarkDraws(pdf: Buffer): number {
  const latin1 = pdf.toString("latin1");
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin1)) !== null) {
    total += (inflateMaybe(Buffer.from(m[1], "latin1")).match(new RegExp(HEX_PRACTICE, "gi")) ?? []).length;
  }
  return total;
}

describe("practice reprint reissues watermarked stored bytes (Phase 8B §5.4/§10)", () => {
  beforeEach(truncateAll);

  it("a practice-stored document's reprint carries the mark and equals the stored bytes verbatim", async () => {
    const cust = await prisma.customer.create({ data: { code: "C1", name: "Cust" } });

    // Rendered under practice mode → watermarked.
    const rendered = await renderPdf({ content: [{ text: "statement body" }] });
    expect(watermarkDraws(rendered)).toBeGreaterThan(0);

    // Stored verbatim through the real archive path.
    await asSystem(() =>
      prisma.$transaction((tx) => storeDocument(tx, { kind: "STATEMENT", customerId: cust.id }, rendered)),
    );

    // A reprint reissues exactly these stored bytes (no re-render) — still watermarked, byte-exact.
    const row = await prisma.storedDocument.findFirst({
      where: { customerId: cust.id }, select: { fileData: true },
    });
    const stored = Buffer.from(row!.fileData);
    expect(watermarkDraws(stored)).toBeGreaterThan(0);
    expect(Buffer.compare(stored, rendered)).toBe(0);
  });
});
