import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { backupsView } from "@/server/backups";
import { assertNotPracticeDatabase } from "@/server/practice-mode";

// §6.3: the Backups page is production-only. `src/lib/nav.ts` deliberately stays ignorant of
// practice mode (a client-safe module — see CLAUDE.md §8), so this route refusal is the actual
// enforcement point; without it, a practice trainer holding manage_backups would see a page whose
// folder legitimately doesn't exist in that container, which is confusing rather than refused.
export const GET = handle(async () => {
  mustDo(requireUser(), "manage_backups");
  await assertNotPracticeDatabase();
  return NextResponse.json(await backupsView());
});
