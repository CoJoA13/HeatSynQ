"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { usePermissions } from "@/lib/use-permissions";
import { gate } from "@/lib/permission-ui";
import { widgetKindFor, selectOptionsFor, selectLabelsFor, coerceForSubmit } from "@/lib/settings-ui";

type Row = { key: string; label: string; group: string; value: unknown };

export default function SettingsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();
  // Every write here hits PUT /api/admin/settings, which requires admin.edit
  // (src/app/api/admin/settings/route.ts) — disabled with a tooltip, never hidden (§5.16).
  const canEdit = gate(perms, "admin.edit");

  const load = () => api<Row[]>("/api/admin/settings").then(setRows).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function save(row: Row, raw: string | boolean) {
    const kind = widgetKindFor(row.key, row.value);
    if (kind === "number" && typeof raw === "string" && raw.trim() === "") {
      setError("Enter a value");
      void load();
      return;
    }
    const value = coerceForSubmit(kind, raw);
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ key: row.key, value }) });
      setSaved(row.key); setError(null); setTimeout(() => setSaved(null), 1500); void load();
    } catch (e) { setError((e as Error).message); }
  }

  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div className="max-w-2xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Settings</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {groups.map((g) => (
        <section key={g} className="mb-6">
          <h2 className="mb-2 font-medium">{g}</h2>
          <div className="rounded border bg-white">
            {rows.filter((r) => r.group === g).map((r) => {
              const kind = widgetKindFor(r.key, r.value);
              const labelText = (
                <span>{r.label}{saved === r.key && <em className="ml-2 text-green-700">saved</em>}</span>
              );

              // Long, multi-paragraph legal text (cert_statement / shipper_liability_text) —
              // stacked layout, full-width textarea; a single-line input makes these uneditable.
              if (kind === "textarea") {
                return (
                  <div key={r.key} className="border-b p-2 text-sm last:border-0">
                    <label className="mb-1 block">{labelText}</label>
                    <textarea
                      defaultValue={String(r.value)}
                      rows={6}
                      disabled={canEdit.disabled}
                      title={canEdit.title}
                      onBlur={(e) => { if (e.target.value !== String(r.value)) void save(r, e.target.value); }}
                      className="w-full rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
                    />
                  </div>
                );
              }

              if (kind === "checkbox") {
                return (
                  <label key={r.key} className="flex items-center justify-between border-b p-2 text-sm last:border-0">
                    {labelText}
                    <input
                      type="checkbox"
                      checked={Boolean(r.value)}
                      disabled={canEdit.disabled}
                      title={canEdit.title}
                      onChange={(e) => void save(r, e.target.checked)}
                    />
                  </label>
                );
              }

              if (kind === "select") {
                const options = selectOptionsFor(r.key) ?? [];
                const labels = selectLabelsFor(r.key);
                return (
                  <label key={r.key} className="flex items-center justify-between border-b p-2 text-sm last:border-0">
                    {labelText}
                    <select
                      value={String(r.value)}
                      disabled={canEdit.disabled}
                      title={canEdit.title}
                      onChange={(e) => void save(r, e.target.value)}
                      className="w-56 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
                    >
                      {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
                    </select>
                  </label>
                );
              }

              return (
                <label key={r.key} className="flex items-center justify-between border-b p-2 text-sm last:border-0">
                  {labelText}
                  <input
                    type={kind === "number" ? "number" : "text"}
                    defaultValue={String(r.value)}
                    disabled={canEdit.disabled}
                    title={canEdit.title}
                    onBlur={(e) => { if (e.target.value !== String(r.value)) void save(r, e.target.value); }}
                    className="w-56 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
                  />
                </label>
              );
            })}
          </div>
        </section>
      ))}
      <p className="text-xs text-slate-500">Values save when changed. Invalid values are rejected with a message and nothing is stored.</p>
    </div>
  );
}
