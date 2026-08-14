import ExcelJS from "exceljs";

/** Build a single-sheet workbook. `columns` sets the header row and the row keys; `rows` are keyed
 *  by those column keys. `caption`, when given, is written as a bold cell A1 ABOVE the header (the
 *  header then sits on row 2) — a report uses it to stamp its measure basis into the file itself
 *  (the Payments report's "Posted payments only", spec §4.2). Callers that omit it are unchanged:
 *  the header stays on row 1. */
export async function toXlsx(
  sheetName: string,
  columns: { key: string; header: string }[],
  rows: Record<string, unknown>[],
  caption?: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName);
  sheet.columns = columns.map((c) => ({ key: c.key, header: c.header, width: Math.max(14, c.header.length + 2) }));
  if (caption) {
    // Insert the caption above the header row (setting `sheet.columns` wrote the header to row 1);
    // the header moves to row 2, data rows follow. Row keys are a worksheet property independent of
    // row positions, so the keyed `addRow` below still maps correctly.
    sheet.spliceRows(1, 0, [caption]);
    sheet.getRow(1).font = { italic: true };
    sheet.getRow(2).font = { bold: true };
  } else {
    sheet.getRow(1).font = { bold: true };
  }
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
