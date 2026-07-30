import { createReference, assertKind } from "./reference";
import { readableMessage } from "./error-message";
import { REFERENCE_EXTRA_FIELDS } from "../lib/reference-constants";

export type PasteResult = { created: number; errors: { row: number; message: string }[] };

/** Splits one TSV line into column-keyed cells. Short rows pad with "" for missing columns. */
function parseLine(line: string, columns: string[]): Record<string, string> {
  const cells = line.split("\t");
  return Object.fromEntries(columns.map((c, i) => [c, (cells[i] ?? "").trim()]));
}

/** Split spreadsheet-pasted TSV into column-keyed rows. Short rows pad, long rows truncate. */
export function parseTsv(text: string, columns: string[]): Record<string, string>[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseLine(line, columns));
}

/**
 * Creates every valid row and collects failures per row rather than aborting the batch —
 * a single typo in row 40 must not discard the 39 rows above it.
 *
 * Iterates the raw lines itself (rather than delegating to `parseTsv`, which drops blank lines
 * before indices are assigned) so a reported row number is always the 1-based line the pasted
 * text actually occupies — including blank lines, which the user's spreadsheet still counts even
 * though they create nothing here.
 */
export async function pasteReference(kind: string, text: string): Promise<PasteResult> {
  assertKind(kind);
  const columns = ["name", ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.key)];
  const lines = text.split(/\r?\n/);

  const errors: PasteResult["errors"] = [];
  let created = 0;
  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const rowNumber = i + 1;
    const cells = line.split("\t");
    // A row with more cells than the kind has columns must be reported, not silently truncated —
    // that would be the same kind of silent data loss .strict() exists to catch on single adds.
    if (cells.length > columns.length) {
      errors.push({
        row: rowNumber,
        message: `Too many columns: expected ${columns.length} (${columns.join(", ")}) but got ${cells.length}`,
      });
      continue;
    }
    const row = parseLine(line, columns);
    // Drop empty optional cells so zod's .optional() applies instead of receiving "".
    const input = Object.fromEntries(Object.entries(row).filter(([k, v]) => k === "name" || v !== ""));
    try {
      await createReference(kind, input);
      created++;
    } catch (err) {
      errors.push({ row: rowNumber, message: readableMessage(err) });
    }
  }
  return { created, errors };
}
