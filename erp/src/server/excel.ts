import ExcelJS from "exceljs";

export async function toXlsx(
  sheetName: string,
  columns: { key: string; header: string }[],
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName);
  sheet.columns = columns.map((c) => ({ key: c.key, header: c.header, width: Math.max(14, c.header.length + 2) }));
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
