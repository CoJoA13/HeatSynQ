"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";

// Local row type mirrors src/server/process-templates.ts's TemplateSummary — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md "Constraints that will bite you"). updatedAt crosses the
// wire as an ISO string once run through NextResponse.json, not the `Date` the service type says.
type TemplateRow = { id: string; name: string; active: boolean; stepCount: number; updatedAt: string };

type SortKey = "name" | "active" | "steps" | "updated";

export default function ProcessesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();

  // Unlike parts/page.tsx, GET /api/process-templates has no `search` query param (Task 9's
  // route only reads `includeInactive`) — so, unlike that precedent, search is filtered
  // client-side over the already-loaded rows (below) instead of round-tripping per keystroke.
  // `query` therefore only ever carries includeInactive, and is what both the fetch and the
  // Export link use.
  const query = showInactive ? "includeInactive=1" : "";

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the held-
  // permission checks below, and shadowing that binding with the stale-response gate would break
  // every `gate(perms, ...)` call in this component.
  const latest = useLatest();
  // The catch must be ticket-gated too, not just the success path (parts/page.tsx F7 precedent):
  // without this, a superseded request's rejection can land after a newer request already
  // succeeded and overwrite fresh rows with a stale failure message.
  const load = useCallback(async () => {
    const t = latest.next();
    let data: TemplateRow[];
    try {
      data = await api<TemplateRow[]>(`/api/process-templates${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
    // Clear on success, ticket-gated like the failure path above. Without this a banner from an
    // earlier failed load stayed on screen next to freshly loaded rows, with no way to dismiss it
    // — the page read as broken while working perfectly (Codex, PR #22).
    setError(null);
  }, [query, latest]);
  useEffect(() => { void load(); }, [load]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }
  function sortArrow(key: SortKey): string {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = term ? rows.filter((r) => r.name.toLowerCase().includes(term)) : rows;
    const sign = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "name": return sign * a.name.localeCompare(b.name);
        case "active": return sign * (Number(a.active) - Number(b.active));
        case "steps": return sign * (a.stepCount - b.stepCount);
        case "updated": return sign * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
        default: return 0;
      }
    });
  }, [rows, search, sortKey, sortDir]);

  const canCreate = gate(perms, "processes.create");

  async function add() {
    try {
      await api("/api/process-templates", { method: "POST", body: JSON.stringify({ name: draftName }) });
      setDraftName("");
      setError(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Processes</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      <div className="mb-3 flex items-center gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Search name" className="w-64 rounded border px-2 py-1 text-sm" />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <a href={`/api/process-templates/export${query ? `?${query}` : ""}`} className="text-sm text-blue-700 underline">
          Export to Excel
        </a>
      </div>

      <table className="w-full rounded border bg-white text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="cursor-pointer select-none p-2" onClick={() => toggleSort("name")}>
              Name{sortArrow("name")}
            </th>
            <th className="cursor-pointer select-none p-2" onClick={() => toggleSort("active")}>
              Active{sortArrow("active")}
            </th>
            <th className="cursor-pointer select-none p-2" onClick={() => toggleSort("steps")}>
              Steps{sortArrow("steps")}
            </th>
            <th className="cursor-pointer select-none p-2" onClick={() => toggleSort("updated")}>
              Updated{sortArrow("updated")}
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((t) => (
            <tr key={t.id} className="cursor-pointer border-t hover:bg-slate-50"
                onClick={() => router.push(`/processes/templates/${t.id}`)}>
              <td className="p-2 text-blue-700 underline">{t.name}</td>
              <td className="p-2">{t.active ? "yes" : "no"}</td>
              <td className="p-2">{t.stepCount}</td>
              <td className="p-2 text-slate-500">{new Date(t.updatedAt).toLocaleString()}</td>
            </tr>
          ))}
          <tr className="border-t bg-slate-50">
            <td className="p-2" colSpan={3}>
              <input value={draftName} onChange={(e) => setDraftName(e.target.value)}
                     placeholder="Template name" className="w-full rounded border px-2 py-1" />
            </td>
            <td className="p-2 text-right">
              <button onClick={add} disabled={canCreate.disabled || !draftName.trim()} title={canCreate.title}
                      className="rounded bg-slate-800 px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
