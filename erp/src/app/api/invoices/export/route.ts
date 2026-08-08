import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listInvoices } from "@/server/invoices";
import { toXlsx } from "@/server/excel";
import { parseInvoiceFilter } from "../query";

// The `shippers/export/route.ts` / `customers/export/route.ts` precedent exactly: `mustCan`, the
// SAME filter parse the list route uses (`parseInvoiceFilter` — so the list and its export can
// never disagree about what a query string means), `listInvoices` (never `listInvoiceCandidates`
// — the worklist's "Ready to invoice" section has no export of its own, task-17-brief.md), then
// `toXlsx`. No dedicated `exportInvoices` in `src/server/invoices.ts`: task-17-brief.md's file
// list names only this route as new, and every other export route in the app builds its columns
// inline rather than adding a service-layer export function for one xlsx shape.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "invoicing", "view");
  const rows = await listInvoices(parseInvoiceFilter(new URL(req.url)));
  const columns = [
    { key: "documentNumber", header: "Document No" },
    { key: "kind", header: "Kind" },
    { key: "orderNumber", header: "Order No" },
    { key: "customerCode", header: "Customer Code" },
    { key: "customerName", header: "Customer Name" },
    { key: "invoiceDate", header: "Invoice Date" },
    { key: "status", header: "Status" },
    { key: "total", header: "Total" },
    { key: "finalizedAt", header: "Finalized" },
  ];
  const buf = await toXlsx("Invoices", columns, rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Invoices.xlsx"',
    },
  });
});
