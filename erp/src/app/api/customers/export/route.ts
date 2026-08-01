import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listCustomers } from "@/server/customers";
import { toXlsx } from "@/server/excel";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "customers", "view");
  const url = new URL(req.url);
  const rows = await listCustomers({
    includeInactive: url.searchParams.get("includeInactive") === "1",
    search: url.searchParams.get("search") ?? undefined,
  });
  const columns = [
    { key: "code", header: "Code" },
    { key: "name", header: "Name" },
    { key: "defaultPo", header: "Default PO" },
    { key: "orderNotes", header: "Order notes" },
    { key: "active", header: "Active" },
  ];
  const buf = await toXlsx("Customers", columns, rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Customers.xlsx"',
    },
  });
});
