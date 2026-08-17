import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { printStatementsPerDivision } from "@/server/statements";

const BODY = z.object({
  customerId: z.string().min(1),
  asOf: z.string().optional(),
  assessFinanceCharges: z.boolean().optional(),
}).strict();

// POST /api/receivables/statements/divisions — the PER-DIVISION half of "combined or per-division"
// (spec §3 ruling 10): one archived statement for the parent and one for each live division (#85).
//
// Returns the LIST it produced rather than streaming a PDF — the `statements/run` precedent, and the
// only honest shape for N documents. `receivables.create` because each call archives new documents,
// exactly like the single print and the run. No `combineFamily` in the body: this endpoint IS the
// not-combined choice, and accepting a flag that could only ever be false would invite a caller to
// set it true and silently get something else.
export const POST = handle(async (req) => {
  // BOTH grants. `create` because each call archives new documents (the `statements/run` gate), and
  // `view` because the response body carries every family member's code, name and TOTAL DUE —
  // financial data every other statement read and document download requires `view` for. Permissions
  // resolve independently (DENY override → GRANT override → role grant), so `create` without `view`
  // is a reachable combination, and `create` alone would have made this a disclosure path.
  const user = requireUser();
  mustCan(user, "receivables", "view");
  mustCan(user, "receivables", "create");
  const body = BODY.parse(await req.json());
  return NextResponse.json(await printStatementsPerDivision(body.customerId, {
    asOf: body.asOf,
    combineFamily: false,
    assessFinanceCharges: body.assessFinanceCharges ?? false,
  }));
});
