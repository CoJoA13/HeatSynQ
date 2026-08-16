import { describe, it, expect, vi, beforeEach } from "vitest";
import { inflateSync, inflateRawSync } from "node:zlib";

// Drive both practice branches without a real erp_practice DB. render.ts imports practiceMode from
// "../practice-mode", which resolves to the same module as "@/server/practice-mode".
vi.mock("@/server/practice-mode", () => ({ practiceMode: vi.fn() }));

import { practiceMode } from "@/server/practice-mode";
import { renderPdf, renderSheetGroups } from "@/server/pdf/render";

const mockPracticeMode = vi.mocked(practiceMode);

// The house pattern: page count off the uncompressed /Type /Pages /Count N marker (traveler.test.ts).
function pageCount(pdf: Buffer): number {
  const m = pdf.toString("latin1").match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (!m) throw new Error("no /Count marker in rendered PDF");
  return Number(m[1]);
}

function inflateMaybe(raw: Buffer): string {
  for (const fn of [inflateSync, inflateRawSync]) {
    try {
      return fn(raw).toString("latin1");
    } catch {
      /* try the next codec */
    }
  }
  return raw.toString("latin1");
}

// pdf-lib draws text via font.encodeText(), which emits the string HEX-encoded in the content
// stream (not literal ASCII), so search for the hex of "PRACTICE".
const HEX_PRACTICE = Buffer.from("PRACTICE", "latin1").toString("hex"); // 5052414354494345

// Count the watermark draws by inflating every content stream and counting the hex-encoded mark.
// The stamp draws it once per page, so this equals the number of pages stamped — N for a correct
// single stamp, 2N for a double-stamp. The test defs contain no "PRACTICE" text of their own.
function watermarkDraws(pdf: Buffer): number {
  const latin1 = pdf.toString("latin1");
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin1)) !== null) {
    const inflated = inflateMaybe(Buffer.from(m[1], "latin1"));
    total += (inflated.match(new RegExp(HEX_PRACTICE, "gi")) ?? []).length;
    total += (inflated.match(/PRACTICE/g) ?? []).length; // literal fallback (only one encoding hits)
  }
  return total;
}

const DEF = { content: [{ text: "hello" }] };

describe("practice watermark post-stamp (Phase 8B §5.4)", () => {
  beforeEach(() => mockPracticeMode.mockReset());

  it("production: renderPdf is unstamped and the /Count marker stays readable", async () => {
    mockPracticeMode.mockResolvedValue(false);
    const bytes = await renderPdf(DEF);
    expect(pageCount(bytes)).toBe(1);
    expect(watermarkDraws(bytes)).toBe(0);
  });

  it("practice: renderPdf stamps every page once and preserves page count + /Count", async () => {
    mockPracticeMode.mockResolvedValue(true);
    const bytes = await renderPdf(DEF);
    expect(pageCount(bytes)).toBe(1);
    expect(watermarkDraws(bytes)).toBe(1);
  });

  it("practice: renderSheetGroups stamps the MERGED document once per page (no double-stamp)", async () => {
    mockPracticeMode.mockResolvedValue(true);
    const bytes = await renderSheetGroups([{ content: [{ text: "a" }] }, { content: [{ text: "b" }] }]);
    expect(pageCount(bytes)).toBe(2);
    expect(watermarkDraws(bytes)).toBe(2); // once per page — NOT 4 (would be a per-group + merge double-stamp)
  });

  it("production: renderSheetGroups merges page counts and stays unstamped", async () => {
    mockPracticeMode.mockResolvedValue(false);
    const bytes = await renderSheetGroups([{ content: [{ text: "a" }] }, { content: [{ text: "b" }] }]);
    expect(pageCount(bytes)).toBe(2);
    expect(watermarkDraws(bytes)).toBe(0);
  });
});
