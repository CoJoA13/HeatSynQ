import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { exportShippers } from "@/server/shippers";
import { parseShipperFilter } from "../query";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "shipping", "view");
  const buf = await exportShippers(parseShipperFilter(new URL(req.url)));
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Shipments.xlsx"',
    },
  });
});
