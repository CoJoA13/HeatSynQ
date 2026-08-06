import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, canDo } from "@/server/permissions";
import { replaceReadings } from "@/server/cert-results";

export const PUT = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "certs", "edit");
  const detail = await replaceReadings((await params).id, await req.json(), {
    afterPrint: canDo(user, "edit_cert_results_after_print"),
  });
  return NextResponse.json(detail);
});
