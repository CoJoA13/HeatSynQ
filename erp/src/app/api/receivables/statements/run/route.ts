import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { runStatements } from "@/server/statements";

const RUN = z.object({
  asOf: z.string().optional(),
  assessFinanceCharges: z.boolean().optional(),
}).strict();

// POST /api/receivables/statements/run — print a statement for every customer carrying a nonzero
// A/R balance (Task 12, P5B §8). Gated receivables.create, separately from the single build/print
// above: a run archives many documents at once — the batch-mutation gate, not the single-document
// read/print gate.
export const POST = handle(async (req) => {
  mustCan(requireUser(), "receivables", "create");
  const body = RUN.parse(await req.json());
  return NextResponse.json(await runStatements({
    asOf: body.asOf, assessFinanceCharges: body.assessFinanceCharges ?? false,
  }));
});
