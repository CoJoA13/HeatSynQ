import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { backupHealth } from "@/server/backups";

// The cheap read the shell warning bar polls: no directory listing, and at most a couple of
// integrity checks (backupHealth stops at the newest INTACT archive).
export const GET = handle(async () => {
  mustDo(requireUser(), "manage_backups");
  return NextResponse.json(await backupHealth());
});
