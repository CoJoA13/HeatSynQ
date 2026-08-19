"use client";
import type { Gate } from "@/lib/permission-ui";
import { ORDER_STATUSES, ORDER_STATUS_LABELS, type OrderStatusValue } from "@/lib/order-constants";
import type { BoardFilters } from "@/lib/board-columns";

// Presentational only (#33's bounded slice): filter state and its update handlers stay in the
// board page (src/app/page.tsx) — this file renders the filter row, the Export link (built from
// the SAME queryString the board's own fetch uses, so the file can never disagree with the table),
// and the Columns toggle button.

// The parts/page.tsx precedent: only the slice the customer filter picker needs.
export type CustomerOption = { id: string; code: string; name: string; active: boolean };

type Props = {
  filters: BoardFilters;
  customers: CustomerOption[];
  customersGate: Gate;
  queryString: string;
  columnsOpen: boolean;
  onUpdateFilters: (patch: Partial<BoardFilters>) => void;
  onToggleStatus: (s: OrderStatusValue) => void;
  onToggleColumnsOpen: () => void;
};

export function FilterBar({
  filters, customers, customersGate, queryString, columnsOpen,
  onUpdateFilters, onToggleStatus, onToggleColumnsOpen,
}: Props) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-4 rounded border bg-white p-2 text-sm">
      <div>
        <label className="block text-xs text-slate-500">Search</label>
        <input value={filters.search} onChange={(e) => onUpdateFilters({ search: e.target.value })}
               placeholder="Order #, PO, VS #, lead part, customer"
               className="w-64 rounded border px-2 py-1" />
      </div>

      <fieldset>
        <legend className="block text-xs text-slate-500">Status</legend>
        <div className="flex flex-wrap gap-2">
          {ORDER_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input type="checkbox" checked={filters.status.includes(s)} onChange={() => onToggleStatus(s)} />
              {ORDER_STATUS_LABELS[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label className="block text-xs text-slate-500">Customer</label>
        <select value={filters.customerId} onChange={(e) => onUpdateFilters({ customerId: e.target.value })}
                disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.code} · {c.name}{!c.active && " (inactive)"}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-slate-500">Received</label>
        <div className="flex items-center gap-1">
          <input type="date" value={filters.receivedFrom} onChange={(e) => onUpdateFilters({ receivedFrom: e.target.value })}
                 className="rounded border px-2 py-1" />
          <span>&ndash;</span>
          <input type="date" value={filters.receivedTo} onChange={(e) => onUpdateFilters({ receivedTo: e.target.value })}
                 className="rounded border px-2 py-1" />
        </div>
      </div>

      <div>
        <label className="block text-xs text-slate-500">Request</label>
        <div className="flex items-center gap-1">
          <input type="date" value={filters.requestFrom} onChange={(e) => onUpdateFilters({ requestFrom: e.target.value })}
                 className="rounded border px-2 py-1" />
          <span>&ndash;</span>
          <input type="date" value={filters.requestTo} onChange={(e) => onUpdateFilters({ requestTo: e.target.value })}
                 className="rounded border px-2 py-1" />
        </div>
      </div>

      <label className="flex items-center gap-1">
        <input type="checkbox" checked={filters.includeVoided}
               onChange={(e) => onUpdateFilters({ includeVoided: e.target.checked })} />
        Include voided
      </label>

      <a href={`/api/orders/export${queryString ? `?${queryString}` : ""}`} className="text-blue-700 underline">
        Export to Excel
      </a>

      <button onClick={onToggleColumnsOpen} className="text-blue-700 underline">
        {columnsOpen ? "Hide columns" : "Columns"}
      </button>
    </div>
  );
}
