import { createReference, assertKind } from "./reference";
import { readableMessage } from "./error-message";
import { REFERENCE_EXTRA_FIELDS } from "../lib/reference-constants";

export type PasteResult = { created: number; errors: { row: number; message: string }[] };

type ParsedRecord = { startLine: number; fields: string[] };
type ParseError = { line: number; message: string };
type ParseOutcome = { records: ParsedRecord[]; error: ParseError | null };

/**
 * Character-scanning TSV parser that understands Excel's cell quoting. When Excel copies a cell
 * containing a double quote, a tab, or a newline, it wraps the cell in `"` and doubles internal
 * quotes — a naive \t/\n split corrupts exactly the cells a heat-treat shop pastes constantly:
 * inch marks (`3/4" round`) and multi-line spec/comment text. A plain split also can't tell a
 * newline that ends a row from one embedded in a quoted cell, so row numbering has to come from
 * this same scan.
 *
 * Returns every record successfully parsed before a structural error (an unterminated or
 * malformed quoted cell), plus that error if one was hit — so a bad cell late in the paste
 * doesn't discard the good rows above it. `startLine` is the 1-based line the record *starts*
 * on, which is what a user can find in their spreadsheet even when a quoted cell spans several
 * physical lines. Field values come out trimmed, matching the historical single-line behavior.
 */
function parseRecords(text: string): ParseOutcome {
  const records: ParsedRecord[] = [];
  const len = text.length;
  let i = 0;
  let line = 1;

  while (i < len) {
    const startLine = line;
    const fields: string[] = [];
    let error: ParseError | null = null;

    while (error === null) {
      let field: string;
      if (text[i] === '"') {
        i++; // consume opening quote
        let buf = "";
        let closed = false;
        while (i < len) {
          const ch = text[i];
          if (ch === '"') {
            if (text[i + 1] === '"') { buf += '"'; i += 2; continue; } // doubled quote -> literal "
            i++;
            closed = true;
            break;
          }
          if (ch === "\r" && text[i + 1] === "\n") { buf += "\n"; line++; i += 2; continue; }
          if (ch === "\n") { buf += "\n"; line++; i++; continue; }
          buf += ch;
          i++;
        }
        if (!closed) {
          error = { line: startLine, message: `Row ${startLine}: unterminated quoted cell` };
          break;
        }
        // A closing quote must be immediately followed by a tab, a line ending, or end-of-input.
        // Anything else (e.g. `"abc"def`) is malformed rather than a well-formed Excel cell, and
        // must be reported rather than guessed at — silently swallowing it risks the exact kind
        // of silent data loss this parser exists to prevent.
        const validAfter =
          i === len || text[i] === "\t" || text[i] === "\n" || (text[i] === "\r" && text[i + 1] === "\n");
        if (!validAfter) {
          error = { line: startLine, message: `Row ${startLine}: malformed quoted cell` };
          break;
        }
        field = buf;
      } else {
        const start = i;
        while (i < len) {
          const ch = text[i];
          if (ch === "\t" || ch === "\n") break;
          if (ch === "\r" && text[i + 1] === "\n") break;
          i++;
        }
        field = text.slice(start, i);
      }
      fields.push(field.trim());
      if (i < len && text[i] === "\t") { i++; continue; } // more fields on this row
      break; // line ending or end-of-input: row is complete
    }

    if (error) return { records, error };

    if (text[i] === "\r" && text[i + 1] === "\n") { i += 2; line++; }
    else if (text[i] === "\n") { i += 1; line++; }
    // else: end-of-input, nothing to consume.
    records.push({ startLine, fields });
  }

  return { records, error: null };
}

/** A record is a "blank line" — skipped, not an empty row — when every field on it is empty. */
function isBlankRecord(fields: string[]): boolean {
  return fields.every((f) => f === "");
}

/** Split spreadsheet-pasted TSV into column-keyed rows. Short rows pad with "" for missing
 *  columns; blank lines are dropped. Throws if a quoted cell is unterminated or malformed. */
export function parseTsv(text: string, columns: string[]): Record<string, string>[] {
  const { records, error } = parseRecords(text);
  if (error) throw new Error(error.message);
  return records
    .filter((r) => !isBlankRecord(r.fields))
    .map((r) => Object.fromEntries(columns.map((c, idx) => [c, r.fields[idx] ?? ""])));
}

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
    // A row with more cells than the kind has columns must be reported, not silently truncated —
    // that would be the same kind of silent data loss .strict() exists to catch on single adds.
    // But Excel routinely emits a trailing tab (or several) on an otherwise-normal row — copying
    // a selection that includes an empty trailing cell, or a range one column wider than the
    // data — so only cells carrying actual content past the declared columns count as an error;
    // empty (already-trimmed) overflow cells are ignored, however many there are.
    const overflow = record.fields.slice(columns.length);
    if (overflow.some((c) => c.length > 0)) {
      errors.push({
        row: rowNumber,
        message: `Too many columns: expected ${columns.length} (${columns.join(", ")}) but got ${record.fields.length}`,
      });
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
