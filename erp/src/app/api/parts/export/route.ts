import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listParts } from "@/server/parts";
import { toXlsx } from "@/server/excel";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "parts", "view");
  const url = new URL(req.url);
  const rows = await listParts({
    includeInactive: url.searchParams.get("includeInactive") === "1",
    search: url.searchParams.get("search") ?? undefined,
  });
  const columns = [
    { key: "customerCode", header: "Customer code" },
    { key: "customerName", header: "Customer name" },
    { key: "partNumber", header: "Part number" },
    { key: "name", header: "Name" },
    { key: "description", header: "Description" },
    // Phase 7 Task 15: mirrors PART_PASTE_COLUMNS' position (after description) so paste stays a
    // positional subsequence of export — a part survives export → edit → paste back.
    { key: "processName", header: "Process name" },
    { key: "materialName", header: "Material" },
    { key: "eachWeight", header: "Each wt" },
    { key: "loadQty", header: "Load qty" },
    { key: "loadWeight", header: "Load wt" },
    { key: "requestDaysOverride", header: "Request days override" },
    { key: "serializationRequired", header: "Serialization" },
    { key: "active", header: "Active" },
  ];
  // materialName/customerCode/customerName already resolved to names (never cuids) by listParts.
  const xlsxRows = rows.map((r) => ({
    ...r,
    serializationRequired: r.serializationRequired ? "yes" : "no",
    active: r.active ? "yes" : "no",
  }));
  const buf = await toXlsx("Parts", columns, xlsxRows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Parts.xlsx"',
    },
  });
});
