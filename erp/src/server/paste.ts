import { createReference, assertKind } from "./reference";
import { REFERENCE_EXTRA_FIELDS } from "../lib/reference-constants";

export type PasteResult = { created: number; errors: { row: number; message: string }[] };

/** Split spreadsheet-pasted TSV into column-keyed rows. Short rows pad, long rows truncate. */
export function parseTsv(text: string, columns: string[]): Record<string, string>[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cells = line.split("\t");
      return Object.fromEntries(columns.map((c, i) => [c, (cells[i] ?? "").trim()]));
    });
}

/**
 * Creates every valid row and collects failures per row rather than aborting the batch —
 * a single typo in row 40 must not discard the 39 rows above it.
 */
export async function pasteReference(kind: string, text: string): Promise<PasteResult> {
  assertKind(kind);
  const columns = ["name", ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.key)];
  const rows = parseTsv(text, columns);

  const errors: PasteResult["errors"] = [];
  let created = 0;
  for (const [i, row] of rows.entries()) {
    // Drop empty optional cells so zod's .optional() applies instead of receiving "".
    const input = Object.fromEntries(Object.entries(row).filter(([k, v]) => k === "name" || v !== ""));
    try {
      await createReference(kind, input);
      created++;
    } catch (err) {
      errors.push({ row: i + 1, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { created, errors };
}
