import { createReference, assertKind } from "./reference";
import { readableMessage } from "./error-message";
import { REFERENCE_EXTRA_FIELDS } from "../lib/reference-constants";
import { parseRecords, isBlankRecord, overflowError } from "./tsv";

export type PasteResult = { created: number; errors: { row: number; message: string }[] };

/**
 * Creates every valid row and collects failures per row rather than aborting the batch —
 * a single typo in row 40 must not discard the 39 rows above it.
 *
 * Uses `parseRecords` directly (rather than `parseTsv`, which drops blank lines before row
 * numbers are assigned) so a reported row number is always the 1-based line the pasted text
 * actually occupies — including blank lines, which the user's spreadsheet still counts even
 * though they create nothing here, and including quoted cells that span several physical lines,
 * where the record is reported at the line it *starts* on.
 */
export async function pasteReference(kind: string, text: string): Promise<PasteResult> {
  assertKind(kind);
  const columns = ["name", ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.key)];
  const { records, error } = parseRecords(text);

  const errors: PasteResult["errors"] = [];
  let created = 0;
  for (const record of records) {
    if (isBlankRecord(record.fields)) continue;
    const rowNumber = record.startLine;
    const overflow = overflowError(record.fields, columns);
    if (overflow) {
      errors.push({ row: rowNumber, message: overflow });
      continue;
    }
    const row = Object.fromEntries(columns.map((c, idx) => [c, record.fields[idx] ?? ""]));
    // Drop empty optional cells so zod's .optional() applies instead of receiving "".
    const input = Object.fromEntries(Object.entries(row).filter(([k, v]) => k === "name" || v !== ""));
    try {
      await createReference(kind, input);
      created++;
    } catch (err) {
      errors.push({ row: rowNumber, message: readableMessage(err) });
    }
  }
  // A structural parse failure (unterminated/malformed quoted cell) can only ever be the last
  // thing found — everything after it was consumed while scanning for the missing close quote —
  // so it's reported once, after every record parsed ahead of it has already been tried.
  if (error) errors.push({ row: error.line, message: error.message });
  return { created, errors };
}
