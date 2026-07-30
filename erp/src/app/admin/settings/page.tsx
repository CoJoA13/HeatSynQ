"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";

type Row = { key: string; label: string; group: string; value: unknown };

export default function SettingsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = () => api<Row[]>("/api/admin/settings").then(setRows).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function save(row: Row, raw: string) {
    const value = typeof row.value === "number" ? Number(raw) : raw;
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ key: row.key, value }) });
      setSaved(row.key); setError(null); setTimeout(() => setSaved(null), 1500); void load();
    } catch (e) { setError((e as Error).message); }
  }

  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div className="max-w-2xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Settings</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {groups.map((g) => (
        <section key={g} className="mb-6">
          <h2 className="mb-2 font-medium">{g}</h2>
          <div className="rounded border bg-white">
            {rows.filter((r) => r.group === g).map((r) => (
              <label key={r.key} className="flex items-center justify-between border-b p-2 text-sm last:border-0">
                <span>{r.label}{saved === r.key && <em className="ml-2 text-green-700">saved</em>}</span>
                <input defaultValue={String(r.value)}
                       onBlur={(e) => { if (e.target.value !== String(r.value)) void save(r, e.target.value); }}
                       className="w-56 rounded border px-2 py-1" />
              </label>
            ))}
          </div>
        </section>
      ))}
      <p className="text-xs text-slate-500">Values save on blur. Invalid values are rejected with a message and nothing is stored.</p>
    </div>
  );
}
