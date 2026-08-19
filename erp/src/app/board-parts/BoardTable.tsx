"use client";
import { LIGHT_LABELS, LIGHT_DOT_CLASS, type TrafficLight } from "@/lib/traffic-light";
import { ORDER_STATUS_LABELS, type OrderStatusValue } from "@/lib/order-constants";
import type { ColumnDef, ColumnKey, SortState } from "@/lib/board-columns";

// Presentational only (#33's bounded slice): rows, the visible column defs and the sort state all
// live in the board page (src/app/page.tsx) — this file renders the table, computes each cell's
// display (renderCell/sortArrow are pure functions of props), and reports header/row clicks up.

// Local mirror of src/server/orders.ts's BoardRow — not imported from src/server/** (CLAUDE.md
// "Constraints that will bite you": a client component pulling from there drags node:async_hooks
// and Prisma into the browser bundle). Dates arrive pre-formatted as "yyyy-mm-dd" strings
// (`formatDateOnly` runs server-side before `NextResponse.json`), so there is nothing left to
// parse or slice here — they are already display-ready.
export type BoardRow = {
  id: string; orderNumber: number; customerCode: string; customerName: string;
  leadPartNumber: string; poNumber: string; vsOrderNumber: string;
  qty: number; weight: number;
  receivedDate: string; requestDate: string; targetDate: string | null;
  status: OrderStatusValue; voided: boolean; light: TrafficLight;
  loadCount: number; linked: boolean;
};

type Props = {
  rows: BoardRow[];
  visibleDefs: ColumnDef[];
  sort: SortState;
  onToggleSort: (col: ColumnDef) => void;
  onOpenOrder: (id: string) => void;
};

function renderCell(row: BoardRow, key: ColumnKey) {
  switch (key) {
    case "orderNumber": return <span className="font-mono text-blue-700 underline">{row.orderNumber}</span>;
    case "customer": return `${row.customerCode} · ${row.customerName}`;
    case "leadPart": return row.leadPartNumber;
    case "po": return row.poNumber;
    case "qty": return row.qty;
    case "weight": return row.weight;
    case "received": return row.receivedDate;
    case "request": return row.requestDate;
    case "target": return row.targetDate ?? "";
    case "lightStatus":
      return row.voided ? "Voided" : (
        <span className="inline-flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${LIGHT_DOT_CLASS[row.light]}`} />
          <span>{LIGHT_LABELS[row.light]}</span>
          <span className="text-slate-400">· {ORDER_STATUS_LABELS[row.status]}</span>
        </span>
      );
    case "loads": return row.loadCount;
    case "linked":
      return row.linked
        ? <span className="rounded bg-blue-100 px-1 text-xs text-blue-800">linked</span>
        : null;
    case "vsNumber": return row.vsOrderNumber;
    default: return null;
  }
}

export function BoardTable({ rows, visibleDefs, sort, onToggleSort, onOpenOrder }: Props) {
  function sortArrow(col: ColumnDef): string {
    if (!col.sortKey || sort.sort !== col.sortKey) return "";
    return sort.dir === "asc" ? " ▲" : " ▼";
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full rounded border bg-white text-sm">
        <thead>
          <tr className="border-b text-left">
            {visibleDefs.map((col) => (
              <th key={col.key} className={col.sortKey ? "cursor-pointer select-none p-2" : "p-2"}
                  onClick={col.sortKey ? () => onToggleSort(col) : undefined}>
                {col.label}{sortArrow(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={visibleDefs.length || 1} className="p-4 text-center text-slate-500">
                No orders match these filters.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.id} onClick={() => onOpenOrder(row.id)}
                className={`cursor-pointer border-t hover:bg-slate-50 ${row.voided ? "text-slate-400" : ""}`}>
              {visibleDefs.map((col) => <td key={col.key} className="p-2">{renderCell(row, col.key)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
