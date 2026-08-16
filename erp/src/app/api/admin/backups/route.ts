import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { backupsView } from "@/server/backups";

export const GET = handle(async () => {
  mustDo(requireUser(), "manage_backups");
  return NextResponse.json(await backupsView());
});
