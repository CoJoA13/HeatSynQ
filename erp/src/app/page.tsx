"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { swapAt } from "@/lib/reorder";
import { LIGHT_LABELS, LIGHT_DOT_CLASS, type TrafficLight } from "@/lib/traffic-light";
import { ORDER_STATUSES, ORDER_STATUS_LABELS, type OrderStatusValue } from "@/lib/order-constants";
import {
  BOARD_COLUMNS, defaultViewConfig, normalizeViewConfig, buildOrderQuery,
  type ColumnDef, type ColumnKey, type ColumnState, type BoardFilters, type SortState, type ViewConfig,
} from "@/lib/board-columns";

// Local mirror of src/server/orders.ts's BoardRow — not imported from src/server/** (CLAUDE.md
// "Constraints that will bite you": a client component pulling from there drags node:async_hooks
// and Prisma into the browser bundle). Dates arrive pre-formatted as "yyyy-mm-dd" strings
// (`formatDateOnly` runs server-side before `NextResponse.json`), so there is nothing left to
// parse or slice here — they are already display-ready.
type BoardRow = {
  id: string; orderNumber: number; customerCode: string; customerName: string;
  leadPartNumber: string; poNumber: string; vsOrderNumber: string;
  qty: number; weight: number;
  receivedDate: string; requestDate: string; targetDate: string | null;
  status: OrderStatusValue; voided: boolean; light: TrafficLight;
  loadCount: number; linked: boolean;
};

// The parts/page.tsx precedent: only the slice the customer filter picker needs.
type CustomerOption = { id: string; code: string; name: string; active: boolean };

// Local mirror of src/server/saved-views.ts's SavedViewRow. `config` stays `unknown` — this file
// never trusts it directly, only through board-columns.ts's normalizers.
type SavedViewRow = { id: string; name: string; config: unknown; isDefault: boolean; updatedAt: string };

export default function OrdersPage() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();

  const [rows, setRows] = useState<BoardRow[]>([]);
  // Lazy initializers (the use-latest.ts precedent): `defaultViewConfig()` only ever needs to run
  // once, on mount. A plain `defaultViewConfig()` call in the render body would recompute it on
  // every render just to throw the result away — `useState` only reads its argument on the FIRST
  // render, so passing a function defers the call to exactly that render instead.
  const [columns, setColumns] = useState<ColumnState[]>(() => defaultViewConfig().columns);
  const [filters, setFilters] = useState<BoardFilters>(() => defaultViewConfig().filters);
  const [sort, setSort] = useState<SortState>(() => {
    const d = defaultViewConfig();
    return { sort: d.sort, dir: d.dir };
  });
  const [error, setError] = useState<string | null>(null);

  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  const [savedViews, setSavedViews] = useState<SavedViewRow[]>([]);
  const [selectedViewId, setSelectedViewId] = useState<string>("");
  // Gates the board's own fetch until the mount-time saved-views lookup has decided whether a
  // default view's config should replace the built-in default — without this, the board would
  // fetch once with the built-in default filters and then immediately refetch again the instant
  // that lookup resolves, for every user who has a default view configured at all.
  const [viewsReady, setViewsReady] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDefault, setSaveDefault] = useState(false);

  const canCreateOrder = gate(perms, "orders.create");
  const customersGate = gate(perms, "customers.view");

  // Loads the caller's saved views once on mount and applies whichever one (if any) is marked
  // default — "applied on load", spec §11. Runs regardless of outcome (success or failure) so a
  // saved-views hiccup can never permanently block the board itself from loading with the
  // built-in default.
  useEffect(() => {
    api<SavedViewRow[]>("/api/saved-views")
      .then((views) => {
        setSavedViews(views);
        const def = views.find((v) => v.isDefault);
        if (def) {
          const cfg = normalizeViewConfig(def.config);
          setColumns(cfg.columns);
          setFilters(cfg.filters);
          setSort({ sort: cfg.sort, dir: cfg.dir });
          setSelectedViewId(def.id);
        }
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setViewsReady(true));
  }, []);

  // Customer filter picker: fetched only once the caller is known to hold customers.view, never
  // left silently empty for someone who lacks it (§5.16 — a blocked control must say why). The
  // parts/page.tsx precedent, applied to a filter picker rather than an add-row.
  // includeInactive=1 (#45, the rider-part picker precedent at orders/[id]/page.tsx): a saved
  // view can filter on a customer made inactive SINCE it was saved — the orders query still
  // applies that customerId, so without the inactive rows the select showed no matching option
  // and the board (and its Excel export) stayed silently scoped to one customer. An inactive
  // customer must remain a visible, NAMED filter choice.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers?includeInactive=1")
      .then(setCustomers).catch((e) => setError((e as Error).message));
  }, [customersGate.allowed]);

  const queryString = buildOrderQuery(filters, sort);
  const query = viewsReady ? queryString : null;

  const latest = useLatest();
  // F7 (parts/page.tsx precedent): the catch must be ticket-gated too, not just the success path
  // — otherwise a superseded request's rejection can land after a newer request already
  // succeeded and overwrite fresh rows with a stale failure message.
  const load = useCallback(async () => {
    if (query === null) return; // viewsReady not yet settled — nothing to fetch yet
    const t = latest.next();
    let data: BoardRow[];
    try {
      data = await api<BoardRow[]>(`/api/orders${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
    // Clear on success, ticket-gated like the failure path above (processes/page.tsx precedent —
    // Codex, PR #22): without this, a banner from an earlier failed load stays on screen next to
    // freshly loaded rows, with no way to dismiss it.
    setError(null);
  }, [query, latest]);
  useEffect(() => { void load(); }, [load]);

  function updateFilters(patch: Partial<BoardFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  function toggleStatus(s: OrderStatusValue) {
    updateFilters({
      status: filters.status.includes(s) ? filters.status.filter((x) => x !== s) : [...filters.status, s],
    });
  }

  function toggleSort(col: ColumnDef) {
    if (!col.sortKey) return;
    const key = col.sortKey;
    setSort((prev) => (prev.sort === key ? { sort: key, dir: prev.dir === "asc" ? "desc" : "asc" } : { sort: key, dir: "asc" }));
  }
  function sortArrow(col: ColumnDef): string {
    if (!col.sortKey || sort.sort !== col.sortKey) return "";
    return sort.dir === "asc" ? " ▲" : " ▼";
  }

  function toggleColumnVisible(key: ColumnKey) {
    setColumns((prev) => prev.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)));
  }
  function moveColumn(index: number, direction: -1 | 1) {
    setColumns((prev) => swapAt(prev, index, direction) ?? prev);
  }

  function applyView(id: string) {
    setSelectedViewId(id);
    const cfg = id === "" ? defaultViewConfig() : normalizeViewConfig(savedViews.find((v) => v.id === id)?.config);
    setColumns(cfg.columns);
    setFilters(cfg.filters);
    setSort({ sort: cfg.sort, dir: cfg.dir });
  }

  async function saveView() {
    const name = saveName.trim();
    if (!name) { setError("A name is required to save a view"); return; }
    try {
      const config: ViewConfig = { columns, filters, sort: sort.sort, dir: sort.dir };
      const created = await api<SavedViewRow>("/api/saved-views", {
        method: "POST", body: JSON.stringify({ name, config, isDefault: saveDefault }),
      });
      setSavedViews((prev) => [...(saveDefault ? prev.map((v) => ({ ...v, isDefault: false })) : prev), created]);
      setSelectedViewId(created.id);
      setSaveOpen(false);
      setSaveName("");
      setSaveDefault(false);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }

  // Toggles isDefault on the CURRENTLY SELECTED view without touching its stored columns/filters
  // (the PATCH body carries only `isDefault` — updateView's `config` is `.optional()`, so omitting
  // it leaves the saved arrangement untouched even if the board's on-screen state has since
  // drifted from it). Mirrors the server's own demote-other-defaults behaviour locally so the
  // dropdown/checkbox stay correct without a full refetch.
  async function setSelectedDefault(isDefault: boolean) {
    if (!selectedViewId) return;
    try {
      const updated = await api<SavedViewRow>(`/api/saved-views/${selectedViewId}`, {
        method: "PATCH", body: JSON.stringify({ isDefault }),
      });
      setSavedViews((prev) => prev.map((v) => {
        if (v.id === updated.id) return updated;
        return isDefault ? { ...v, isDefault: false } : v;
      }));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function deleteSelectedView() {
    const view = savedViews.find((v) => v.id === selectedViewId);
    if (!view) return;
    if (!confirm(`Delete saved view "${view.name}"?`)) return;
    try {
      await api(`/api/saved-views/${selectedViewId}`, { method: "DELETE" });
      setSavedViews((prev) => prev.filter((v) => v.id !== selectedViewId));
      applyView("");
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }

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

  const visibleDefs: ColumnDef[] = columns
    .filter((c) => c.visible)
    .map((c) => BOARD_COLUMNS.find((d) => d.key === c.key))
    .filter((d): d is ColumnDef => d !== undefined);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Orders</h1>
        <button onClick={() => router.push("/orders/new")} disabled={canCreateOrder.disabled} title={canCreateOrder.title}
                className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          New Order
        </button>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3 rounded border bg-white p-2 text-sm">
        <label className="flex items-center gap-1">
          View:
          <select value={selectedViewId} onChange={(e) => applyView(e.target.value)}
                  className="rounded border px-2 py-1">
            <option value="">Default board</option>
            {savedViews.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        {selectedViewId && (
          <label className="flex items-center gap-1">
            <input type="checkbox"
                   checked={savedViews.find((v) => v.id === selectedViewId)?.isDefault ?? false}
                   onChange={(e) => setSelectedDefault(e.target.checked)} />
            Set as default
          </label>
        )}
        <button onClick={() => setSaveOpen(true)} className="text-blue-700 underline">Save view</button>
        <button onClick={deleteSelectedView} disabled={!selectedViewId}
                className="text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
          Delete view
        </button>
      </div>

      {saveOpen && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm">
          <input value={saveName} onChange={(e) => setSaveName(e.target.value)}
                 placeholder="View name" className="rounded border px-2 py-1" />
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} />
            Set as default
          </label>
          <button onClick={saveView} className="rounded bg-slate-800 px-3 py-1 text-white">Save</button>
          <button onClick={() => { setSaveOpen(false); setSaveName(""); setSaveDefault(false); }}
                  className="text-slate-600">
            Cancel
          </button>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-4 rounded border bg-white p-2 text-sm">
        <div>
          <label className="block text-xs text-slate-500">Search</label>
          <input value={filters.search} onChange={(e) => updateFilters({ search: e.target.value })}
                 placeholder="Order #, PO, VS #, lead part, customer"
                 className="w-64 rounded border px-2 py-1" />
        </div>

        <fieldset>
          <legend className="block text-xs text-slate-500">Status</legend>
          <div className="flex flex-wrap gap-2">
            {ORDER_STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input type="checkbox" checked={filters.status.includes(s)} onChange={() => toggleStatus(s)} />
                {ORDER_STATUS_LABELS[s]}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label className="block text-xs text-slate-500">Customer</label>
          <select value={filters.customerId} onChange={(e) => updateFilters({ customerId: e.target.value })}
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
            <input type="date" value={filters.receivedFrom} onChange={(e) => updateFilters({ receivedFrom: e.target.value })}
                   className="rounded border px-2 py-1" />
            <span>&ndash;</span>
            <input type="date" value={filters.receivedTo} onChange={(e) => updateFilters({ receivedTo: e.target.value })}
                   className="rounded border px-2 py-1" />
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-500">Request</label>
          <div className="flex items-center gap-1">
            <input type="date" value={filters.requestFrom} onChange={(e) => updateFilters({ requestFrom: e.target.value })}
                   className="rounded border px-2 py-1" />
            <span>&ndash;</span>
            <input type="date" value={filters.requestTo} onChange={(e) => updateFilters({ requestTo: e.target.value })}
                   className="rounded border px-2 py-1" />
          </div>
        </div>

        <label className="flex items-center gap-1">
          <input type="checkbox" checked={filters.includeVoided}
                 onChange={(e) => updateFilters({ includeVoided: e.target.checked })} />
          Include voided
        </label>

        <a href={`/api/orders/export${queryString ? `?${queryString}` : ""}`} className="text-blue-700 underline">
          Export to Excel
        </a>

        <button onClick={() => setColumnsOpen((o) => !o)} className="text-blue-700 underline">
          {columnsOpen ? "Hide columns" : "Columns"}
        </button>
      </div>

      {columnsOpen && (
        <div className="mb-3 max-w-sm rounded border border-slate-300 bg-slate-50 p-3 text-sm">
          <div className="mb-2 font-medium">Show / reorder columns</div>
          {columns.map((c, i) => {
            const def = BOARD_COLUMNS.find((d) => d.key === c.key);
            if (!def) return null;
            return (
              <div key={c.key} className="flex items-center gap-2 border-b py-1 last:border-b-0">
                <input type="checkbox" checked={c.visible} onChange={() => toggleColumnVisible(c.key)} />
                <span className="flex-1">{def.label}</span>
                <button type="button" disabled={i === 0} onClick={() => moveColumn(i, -1)}
                        className="text-xs text-slate-600 disabled:text-slate-300">
                  ↑
                </button>
                <button type="button" disabled={i === columns.length - 1} onClick={() => moveColumn(i, 1)}
                        className="text-xs text-slate-600 disabled:text-slate-300">
                  ↓
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full rounded border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              {visibleDefs.map((col) => (
                <th key={col.key} className={col.sortKey ? "cursor-pointer select-none p-2" : "p-2"}
                    onClick={col.sortKey ? () => toggleSort(col) : undefined}>
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
              <tr key={row.id} onClick={() => router.push(`/orders/${row.id}`)}
                  className={`cursor-pointer border-t hover:bg-slate-50 ${row.voided ? "text-slate-400" : ""}`}>
                {visibleDefs.map((col) => <td key={col.key} className="p-2">{renderCell(row, col.key)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
