import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { writeOffInvoice } from "@/server/applications";

// POST /api/receivables/write-offs — write off all or part of a finalized invoice's open balance
// with NO payment behind it (#77; spec §3 ruling 1's bad-debt flavor, the one `applyPayment` could
// never reach because it requires a `paymentId`). Cloned from `credit-applications/route.ts`:
// authorize-parse-delegate only. The claims, the re-validation under them, the over-application
// guard, the reason rule and the period guard all live in `writeOffInvoice` itself.
//
// BOTH gates are unconditional. `applications/route.ts` has to PEEK at its body for a WRITE_OFF
// line, because that route also carries PAYMENT and DISCOUNT lines and `receivables.create` alone
// is enough for those. This route writes nothing but write-offs, so the `write_off` special action
// is required of every caller and there is no body shape to inspect (spec §9).
//
// `catch(() => null)` on the body read for the reason the #8 fix names: a malformed or absent body
// otherwise throws out of the handler as a bare 500. `null` reaches the service's zod schema, which
// answers with the field-anchored 400 every sibling route returns.
export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "receivables", "create");
  mustDo(user, "write_off");
  const body: unknown = await req.json().catch(() => null);
  await writeOffInvoice(body);
  return NextResponse.json({ ok: true });
});
