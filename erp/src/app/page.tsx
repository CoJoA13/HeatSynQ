"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { swapAt } from "@/lib/reorder";
import { type OrderStatusValue } from "@/lib/order-constants";
import {
  BOARD_COLUMNS, defaultViewConfig, normalizeViewConfig, buildOrderQuery,
  type ColumnDef, type ColumnKey, type ColumnState, type BoardFilters, type SortState, type ViewConfig,
} from "@/lib/board-columns";
// The presentational split (#33's bounded slice): the four components render what this page's
// state says and report every interaction back up through props — all state, fetching, and the
// use-latest/viewsReady discipline stay HERE. The row/option types each component displays are
// declared beside the component that renders them and imported back for this page's state.
import { SavedViewsBar, type SavedViewRow } from "./board-parts/SavedViewsBar";
import { FilterBar, type CustomerOption } from "./board-parts/FilterBar";
import { ColumnPicker } from "./board-parts/ColumnPicker";
import { BoardTable, type BoardRow } from "./board-parts/BoardTable";

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
  // #145 (the processes/templates togglingActive precedent): the Set-as-default checkbox stays
  // enabled through its PATCH otherwise, and two clicks faster than a round trip issue two
  // unordered updates — if the first lands second, the database keeps the first click's value
  // while the local mirror below shows the second's, and nothing ever reveals the divergence.
  const [settingDefault, setSettingDefault] = useState(false);

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
    if (!selectedViewId || settingDefault) return; // one at a time (#145)
    setSettingDefault(true);
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
    finally { setSettingDefault(false); }
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

      <SavedViewsBar
        savedViews={savedViews}
        selectedViewId={selectedViewId}
        saveOpen={saveOpen}
        saveName={saveName}
        saveDefault={saveDefault}
        settingDefault={settingDefault}
        onApplyView={applyView}
        onSetSelectedDefault={setSelectedDefault}
        onOpenSave={() => setSaveOpen(true)}
        onDeleteView={deleteSelectedView}
        onSaveNameChange={setSaveName}
        onSaveDefaultChange={setSaveDefault}
        onSaveView={saveView}
        onCancelSave={() => { setSaveOpen(false); setSaveName(""); setSaveDefault(false); }}
      />

      <FilterBar
        filters={filters}
        customers={customers}
        customersGate={customersGate}
        queryString={queryString}
        columnsOpen={columnsOpen}
        onUpdateFilters={updateFilters}
        onToggleStatus={toggleStatus}
        onToggleColumnsOpen={() => setColumnsOpen((o) => !o)}
      />

      {columnsOpen && (
        <ColumnPicker columns={columns} onToggleVisible={toggleColumnVisible} onMove={moveColumn} />
      )}

      <BoardTable
        rows={rows}
        visibleDefs={visibleDefs}
        sort={sort}
        onToggleSort={toggleSort}
        onOpenOrder={(id) => router.push(`/orders/${id}`)}
      />
    </div>
  );
}
