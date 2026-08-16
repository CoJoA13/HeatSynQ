import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { setSetupState } from "@/server/setup-state";

// The only NEW mutation the setup checklist introduces (Phase 8B §5.5): the two non-derivable facts
// SetupState persists. Every other checklist step drives an EXISTING admin endpoint. Admin.edit —
// GL/settings entry is admin-only (§8). The route stamps the current time server-side so the client
// only says WHICH fact to record.
const BODY = z.object({ confirmNumbers: z.boolean().optional(), dismiss: z.boolean().optional() }).strict();

export const PUT = handle(async (req) => {
  mustCan(requireUser(), "admin", "edit");
  const { confirmNumbers, dismiss } = BODY.parse(await req.json());
  const now = new Date();
  const patch: { numbersConfirmedAt?: Date; checklistDismissedAt?: Date } = {};
  if (confirmNumbers) patch.numbersConfirmedAt = now;
  if (dismiss) patch.checklistDismissedAt = now;
  return NextResponse.json(await setSetupState(patch));
});
