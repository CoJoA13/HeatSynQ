export type ParsedRecord = { startLine: number; fields: string[] };
export type ParseError = { line: number; message: string };
export type ParseOutcome = { records: ParsedRecord[]; error: ParseError | null };

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
export function parseRecords(text: string): ParseOutcome {
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
export function isBlankRecord(fields: string[]): boolean {
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
 * A record carrying content past the declared columns is an error, not something to truncate —
 * silent truncation is the data loss `.strict()` exists to catch on single adds. But Excel
 * routinely emits trailing tabs on an otherwise-normal row (copying a selection with an empty
 * trailing cell, or a range one column wider than the data), so only overflow cells with actual
 * content count. Fields arrive already trimmed.
 */
export function overflowError(fields: string[], columns: string[]): string | null {
  const overflow = fields.slice(columns.length);
  if (!overflow.some((c) => c.trim().length > 0)) return null;
  return `Too many columns: expected ${columns.length} (${columns.join(", ")}) but got ${fields.length}`;
}
