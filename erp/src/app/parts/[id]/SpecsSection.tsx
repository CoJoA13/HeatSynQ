"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";

type SpecLink = { id: string; specificationId: string; specificationName: string };
type SpecOption = { id: string; name: string; active: boolean };

export function SpecsSection({
  partId, perms, onError,
}: {
  partId: string;
  perms: string[] | undefined;
  onError: (message: string | null) => void;
}) {
  const [links, setLinks] = useState<SpecLink[]>([]);
  const [options, setOptions] = useState<SpecOption[]>([]);
  const [draft, setDraft] = useState("");
  const canEdit = gate(perms, "parts.edit");

  const load = useCallback(async () => {
    const rows = await api<SpecLink[]>(`/api/parts/${partId}/specifications`);
    setLinks(rows);
  }, [partId]);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  // No `.catch(() => {})` — a failed fetch lands in the page's one error banner.
  useEffect(() => {
    api<SpecOption[]>("/api/picklists/specification").then(setOptions)
      .catch((e) => onError((e as Error).message));
  }, [onError]);

  async function add() {
    if (!draft) return;
    try {
      await api(`/api/parts/${partId}/specifications`, {
        method: "POST", body: JSON.stringify({ specificationId: draft }),
      });
      setDraft("");
      onError(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  }
  async function remove(linkId: string) {
    try {
      await api(`/api/parts/${partId}/specifications/${linkId}`, { method: "DELETE" });
      onError(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Specifications</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        {links.map((l) => (
          <span key={l.id} className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-sm">
            {l.specificationName}
            <button onClick={() => remove(l.id)} disabled={canEdit.disabled} title={canEdit.title}
                    aria-label={`Remove ${l.specificationName}`}
                    className="text-slate-500 hover:text-red-600 disabled:cursor-not-allowed disabled:text-slate-300">
              ×
            </button>
          </span>
        ))}
        {links.length === 0 && <span className="text-sm text-slate-500">None.</span>}
      </div>
      <div className="flex gap-2">
        {/* Already-linked specifications are excluded from the picker — a UX nicety on top of
            the service's own "already on this part" 400, not a replacement for it. */}
        <select value={draft} onChange={(e) => setDraft(e.target.value)}
                disabled={!canEdit.allowed} title={canEdit.title}
                className="rounded border px-2 py-1 text-sm disabled:bg-slate-100">
          <option value="">Add a specification…</option>
          {options
            .filter((o) => !links.some((l) => l.specificationId === o.id))
            .map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <button onClick={add} disabled={canEdit.disabled || !draft} title={canEdit.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Add
        </button>
      </div>
    </section>
  );
}
