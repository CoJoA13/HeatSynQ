"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { STEP_FIELD_TYPES, type StepFieldType } from "@/lib/step-field-constants";

type Field = { id?: string; label: string; type: StepFieldType; unit: string | null; sort: number };
type Code = {
  id: string; code: string; name: string; glAccountId: string | null;
  active: boolean; needsGlAccount: boolean; fields: Field[];
};
type Gl = { id: string; name: string; description?: string };

export default function StepCodesPage() {
  const [codes, setCodes] = useState<Code[]>([]);
  const [gls, setGls] = useState<Gl[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState({ code: "", name: "" });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, g] = await Promise.all([
      api<Code[]>("/api/admin/step-codes"),
      api<Gl[]>("/api/admin/reference/glAccount"),
    ]);
    setCodes(c); setGls(g);
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  const current = codes.find((c) => c.id === selected) ?? null;

  async function save(id: string, body: object) {
    try {
      await api(`/api/admin/step-codes/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function add() {
    try {
      await api("/api/admin/step-codes", { method: "POST", body: JSON.stringify(draft) });
      setDraft({ code: "", name: "" }); setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  function mutateFields(next: Field[]) {
    if (current) void save(current.id, { fields: next.map((f, i) => ({ ...f, sort: i })) });
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Process step codes</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="flex gap-6">
        <div className="w-72 shrink-0">
          <ul className="mb-3 divide-y rounded border bg-white text-sm">
            {codes.map((c) => (
              <li key={c.id} onClick={() => setSelected(c.id)}
                  className={`cursor-pointer px-3 py-2 ${selected === c.id ? "bg-slate-100" : ""}`}>
                <span className="font-mono">{c.code}</span> {c.name}
                {c.needsGlAccount && (
                  <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-800">needs GL</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex gap-1">
            <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                   placeholder="Code" className="w-24 rounded border px-2 py-1 text-sm" />
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                   placeholder="Name" className="flex-1 rounded border px-2 py-1 text-sm" />
            <button onClick={add} className="rounded bg-slate-800 px-3 py-1 text-sm text-white">Add</button>
          </div>
        </div>

        {current && (
          <div className="flex-1 rounded border bg-white p-4">
            <h2 className="mb-3 font-medium">{current.code} — {current.name}</h2>
            <label className="mb-4 block text-sm">
              GL account
              <select value={current.glAccountId ?? ""} className="ml-2 rounded border px-2 py-1"
                      onChange={(e) => save(current.id, { glAccountId: e.target.value || null })}>
                <option value="">(needs GL account)</option>
                {gls.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>

            <h3 className="mb-2 font-medium">Fields a step of this kind asks for</h3>
            <table className="mb-2 w-full text-sm">
              <thead><tr className="text-left"><th>Label</th><th>Type</th><th>Unit</th><th /></tr></thead>
              <tbody>
                {current.fields.map((f, i) => (
                  <tr key={f.id ?? i} className="border-t">
                    <td className="py-1">{f.label}</td>
                    <td>{f.type}</td>
                    <td>{f.unit ?? ""}</td>
                    <td className="text-right">
                      <button className="text-xs text-red-600"
                              onClick={() => mutateFields(current.fields.filter((_, j) => j !== i))}>
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <AddField onAdd={(f) => mutateFields([...current.fields, f])} />
            <p className="mt-3 text-xs text-slate-500">
              A code with no fields is text-only — that is correct for steps like Hot Wash.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function AddField({ onAdd }: { onAdd: (f: Field) => void }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<StepFieldType>("NUMBER");
  const [unit, setUnit] = useState("");
  return (
    <div className="flex gap-1">
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Field label"
             className="flex-1 rounded border px-2 py-1 text-sm" />
      <select value={type} onChange={(e) => setType(e.target.value as StepFieldType)}
              className="rounded border px-2 py-1 text-sm">
        {STEP_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit"
             className="w-20 rounded border px-2 py-1 text-sm" />
      <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
              onClick={() => { if (label) { onAdd({ label, type, unit: unit || null, sort: 0 }); setLabel(""); setUnit(""); } }}>
        Add field
      </button>
    </div>
  );
}
