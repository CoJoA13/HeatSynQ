import { describe, it, expect } from "vitest";
import { parseRecords, isBlankRecord, parseTsv, overflowError } from "@/server/tsv";

describe("tsv parser", () => {
  it("parses plain rows with 1-based start lines", () => {
    const { records, error } = parseRecords("a\tb\nc\td");
    expect(error).toBeNull();
    expect(records).toEqual([
      { startLine: 1, fields: ["a", "b"] },
      { startLine: 2, fields: ["c", "d"] },
    ]);
  });

  it("decodes an escaped inner quote", () => {
    expect(parseRecords('"3/4"" round"').records[0].fields).toEqual(['3/4" round']);
  });

  it("keeps a multi-line quoted cell as ONE record and numbers what follows correctly", () => {
    const { records } = parseRecords('"line one\nline two"\nnext');
    expect(records[0].fields).toEqual(["line one\nline two"]);
    expect(records[1]).toEqual({ startLine: 3, fields: ["next"] });
  });

  it("reports an unterminated quote and keeps records parsed before it", () => {
    const { records, error } = parseRecords('good\n"unterminated');
    expect(records).toHaveLength(1);
    expect(error?.message).toMatch(/unterminated quoted cell/);
  });

  it("counts blank lines for numbering but flags them as blank", () => {
    const { records } = parseRecords("a\n\nb");
    expect(records.map((r) => r.startLine)).toEqual([1, 2, 3]);
    expect(records.map((r) => isBlankRecord(r.fields))).toEqual([false, true, false]);
  });

  it("parseTsv pads short rows and drops blank lines", () => {
    expect(parseTsv("x\n\n", ["a", "b"])).toEqual([{ a: "x", b: "" }]);
  });

  it("overflowError tolerates trailing empties but rejects real extra content", () => {
    expect(overflowError(["a", "b", ""], ["one", "two"])).toBeNull();
    expect(overflowError(["a", "b", "   "], ["one", "two"])).toBeNull();
    expect(overflowError(["a", "b", "c"], ["one", "two"])).toMatch(/Too many columns/);
    expect(overflowError(["a"], ["one", "two"])).toBeNull();
  });
});
