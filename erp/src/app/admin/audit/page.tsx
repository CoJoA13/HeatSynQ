"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";

type Entry = { id: string; at: string; actorName: string; entity: string; entityId: string; action: string; reason: string | null };

export default function AuditPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entity, setEntity] = useState("");
  const [actor, setActor] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      const params = new URLSearchParams();
      if (entity) params.set("entity", entity);
      if (actor) params.set("actor", actor);
      setEntries(await api<Entry[]>(`/api/admin/audit?${params}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Audit log</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="mb-3 flex gap-2 text-sm">
        <input placeholder="Entity (e.g. user)" value={entity} onChange={(e) => setEntity(e.target.value)}
               className="rounded border px-2 py-1" />
        <input placeholder="Actor name" value={actor} onChange={(e) => setActor(e.target.value)}
               className="rounded border px-2 py-1" />
        <button onClick={load} className="rounded bg-slate-800 px-3 py-1 text-white">Search</button>
      </div>
      <table className="w-full rounded border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">When</th><th className="p-2">Who</th><th className="p-2">Entity</th>
          <th className="p-2">Action</th><th className="p-2">Reason</th>
        </tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-b">
              <td className="p-2">{new Date(e.at).toLocaleString()}</td>
              <td className="p-2">{e.actorName}</td>
              <td className="p-2">{e.entity} <span className="text-xs text-slate-400">{e.entityId.slice(0, 8)}</span></td>
              <td className="p-2">{e.action}</td>
              <td className="p-2">{e.reason ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
