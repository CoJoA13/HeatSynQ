import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { exportCerts } from "@/server/certs";
import { parseCertFilter } from "../query";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "certs", "view");
  const buf = await exportCerts(parseCertFilter(new URL(req.url)));
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Certifications.xlsx"',
    },
  });
});
