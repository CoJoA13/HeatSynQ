import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { runBackupNow } from "@/server/backups";

// runBackupNow re-checks the database identity itself (§6.3) — the practice copy is refused there,
// not here, so no caller can reach a dump by finding another route into the service.
//
// Deliberately called with NO arguments: `runBackupNow`'s options object ({ dumpBin, dumpArgs,
// dir, timeoutMs }) exists solely as a test seam. A client-settable dumpBin would be arbitrary
// command execution; a client-settable dir would defeat the folder confinement; a client-settable
// timeoutMs would let a caller wedge the button. This route never parses a request body.
export const POST = handle(async () => {
  mustDo(requireUser(), "manage_backups");
  return NextResponse.json({ archive: await runBackupNow() });
});
