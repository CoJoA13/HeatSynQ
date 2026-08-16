import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { backupHealth } from "@/server/backups";
import { assertNotPracticeDatabase } from "@/server/practice-mode";

// The cheap read the shell warning bar polls: no directory listing, and at most a couple of
// integrity checks (backupHealth stops at the newest INTACT archive).
//
// §6.3: production-only, same as the view route. This also gives the banner its practice-mode
// off-switch for free — assertNotPracticeDatabase throws a 403, which BackupBanner's
// advanceBannerState already latches off for the session, so a practice trainer never sees a red
// bar over a backup folder that container deliberately doesn't have.
export const GET = handle(async () => {
  mustDo(requireUser(), "manage_backups");
  await assertNotPracticeDatabase();
  return NextResponse.json(await backupHealth());
});
