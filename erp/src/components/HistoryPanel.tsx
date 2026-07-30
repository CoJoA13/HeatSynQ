"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";

type Entry = {
  id: string; at: string; actorName: string; action: string; reason: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};

function changedFields(e: Entry): string[] {
  if (!e.before || !e.after) return [];
  const keys = new Set([...Object.keys(e.before), ...Object.keys(e.after)]);
  return [...keys].filter((k) => JSON.stringify(e.before?.[k]) !== JSON.stringify(e.after?.[k]))
    .filter((k) => !["updatedAt"].includes(k));
}

export function HistoryPanel({ entity, entityId }: { entity: string; entityId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    api<Entry[]>(`/api/admin/audit?entity=${entity}&entityId=${entityId}`).then(setEntries).catch(() => {});
  }, [entity, entityId]);
  if (entries.length === 0) return <p className="text-sm text-slate-500">No history.</p>;
  return (
    <ul className="divide-y rounded border bg-white text-sm">
      {entries.map((e) => (
        <li key={e.id} className="p-2">
          <div className="flex justify-between">
            <span><b>{e.actorName}</b> — {e.action}{e.reason ? ` (${e.reason})` : ""}</span>
            <span className="text-slate-500">{new Date(e.at).toLocaleString()}</span>
          </div>
          {changedFields(e).map((k) => (
            <div key={k} className="ml-2 text-xs text-slate-600">
              {k}: <s>{JSON.stringify(e.before?.[k])}</s> → {JSON.stringify(e.after?.[k])}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}
