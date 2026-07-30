import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listReference } from "@/server/reference";
import { toXlsx } from "@/server/excel";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";

export const GET = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { kind } = await params;
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  const rows = await listReference(kind, { includeInactive });

  // listReference() calls assertKind() internally and throws HttpError(400) for an unknown
  // kind before we get here, so by this point `kind` is a validated ReferenceKind.
  const labels = REFERENCE_LABELS[kind as ReferenceKind];
  const columns = [
    { key: "name", header: labels.nameLabel },
    ...REFERENCE_EXTRA_FIELDS[kind as ReferenceKind].map((f) => ({ key: f.key, header: f.label })),
    { key: "active", header: "Active" },
  ];

  const buf = await toXlsx(labels.plural, columns, rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${kind}.xlsx"`,
    },
  });
});
