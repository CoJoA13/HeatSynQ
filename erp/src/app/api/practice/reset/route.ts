import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { HttpError } from "@/server/errors";
import { practiceMode } from "@/server/practice-mode";
import { resetPracticeData } from "@/server/practice-reset";

// Reset the practice database to the demo baseline (Phase 8B §5.3). DOUBLE-GUARDED: (1) admin
// authority + a practiceMode() gate here, and (2) — the load-bearing guard — resetPracticeData
// re-checks current_database()='erp_practice' inside the request, so a mis-set PRACTICE_MODE on a
// production-pointed app can never truncate real data.
export const POST = handle(async () => {
  mustCan(requireUser(), "admin", "edit");
  if (!(await practiceMode())) {
    throw new HttpError(403, "Reset is only available on the practice copy.");
  }
  await resetPracticeData(); // guard 2: assertPracticeDatabase re-checks db-identity in-request
  return NextResponse.json({ ok: true });
});
