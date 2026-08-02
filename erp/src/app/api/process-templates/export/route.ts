import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listTemplates } from "@/server/process-templates";
import { toXlsx } from "@/server/excel";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "processes", "view");
  const url = new URL(req.url);
  const rows = await listTemplates({
    includeInactive: url.searchParams.get("includeInactive") === "1",
  });
  const columns = [
    { key: "name", header: "Name" },
    { key: "active", header: "Active" },
    { key: "stepCount", header: "Steps" },
  ];
  const xlsxRows = rows.map((r) => ({ ...r, active: r.active ? "yes" : "no" }));
  const buf = await toXlsx("Process templates", columns, xlsxRows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Process templates.xlsx"',
    },
  });
});
