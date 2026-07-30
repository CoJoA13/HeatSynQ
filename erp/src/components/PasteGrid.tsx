"use client";
import { useState } from "react";
import { api } from "@/lib/fetcher";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";

type Result = { created: number; errors: { row: number; message: string }[] };

export function PasteGrid({ kind, onDone }: { kind: ReferenceKind; onDone: () => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const columns = [REFERENCE_LABELS[kind].nameLabel, ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.label)];

  async function submit() {
    setBusy(true);
    try {
      setResult(await api<Result>(`/api/admin/reference/${kind}/paste`, {
        method: "POST", body: JSON.stringify({ text }),
      }));
      onDone();
    } catch (e) {
      setResult({ created: 0, errors: [{ row: 0, message: (e as Error).message }] });
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded border bg-white p-3">
      <p className="mb-2 text-sm">
        Paste from a spreadsheet. Columns, in order: <strong>{columns.join(" · ")}</strong>
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6}
                placeholder={`4010\tHeat Treat Revenue`}
                className="w-full rounded border p-2 font-mono text-xs" />
      <button onClick={submit} disabled={busy || !text.trim()}
              className="mt-2 rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:opacity-50">
        {busy ? "Importing…" : "Import rows"}
      </button>
      {result && (
        <div className="mt-3 text-sm">
          <p className="text-green-700">{result.created} row(s) created.</p>
          {result.errors.length > 0 && (
            <ul className="mt-1 text-red-700">
              {result.errors.map((e) => (
                <li key={e.row}>{e.row ? `Row ${e.row}: ` : ""}{e.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
