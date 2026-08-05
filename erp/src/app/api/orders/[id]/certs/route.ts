import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createCert, certsForOrder } from "@/server/certs";

/** Every cert for this order, voided included — the order hub's own view of "by load · 4 loads ·
 *  0 certs" (design spec §6.2/§11). */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "certs", "view");
  return NextResponse.json(await certsForOrder((await params).id));
});

/**
 * LOAD-scope creation on demand (spec §6.2, owner ruling §3.17) — the only scope this route ever
 * produces: `orderId` comes from the path and `scope` is fixed to `"LOAD"`, so a client supplies
 * nothing but the load number. Neither `shipperId` nor an alternate `scope` is accepted here at
 * all (Task 11 Step 0's "resolved server-side" rule, applied the same way the sibling
 * `POST /api/certs` route applies it).
 */
const CREATE_BODY = z.object({
  loadNumber: z.number().int().positive(),
}).strict();

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "certs", "create");
  const data = CREATE_BODY.parse(await req.json());
  const { id } = await params;
  return NextResponse.json(await createCert({ orderId: id, scope: "LOAD", loadNumber: data.loadNumber }));
});
