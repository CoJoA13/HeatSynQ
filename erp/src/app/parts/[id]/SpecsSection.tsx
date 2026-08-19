"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { useLatest } from "@/lib/use-latest";
import { invalidateHistory } from "@/components/HistoryPanel";

type SpecLink = { id: string; specificationId: string; specificationName: string };
type SpecOption = { id: string; name: string; active: boolean };

export function SpecsSection({
  partId, perms, onError, onOptionsError,
}: {
  partId: string;
  perms: string[] | undefined;
  onError: (message: string | null) => void;
  onOptionsError: (message: string) => void;
}) {
  const [links, setLinks] = useState<SpecLink[]>([]);
  const [options, setOptions] = useState<SpecOption[]>([]);
  const [draft, setDraft] = useState("");
  const canEdit = gate(perms, "parts.edit");

  // §5.13 stale-gate, the processes/page.tsx shape, both paths (F7) — the plain ticket, not the
  // sibling PricingSection's saveScope: this section has no optimistic saves, only
  // report-and-reload, so there is no rollback ordering to defer for. `load` never clears the
  // shared error itself — add/remove do that before reloading — so a rollback reload stays §5.13-safe.
  const latest = useLatest();
  const load = useCallback(async () => {
    const t = latest.next();
    let rows: SpecLink[];
    try {
      rows = await api<SpecLink[]>(`/api/parts/${partId}/specifications`);
    } catch (e) {
      if (latest.isCurrent(t)) onError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setLinks(rows);
  }, [partId, latest, onError]);
  useEffect(() => { void load(); }, [load]);

  // F9: a failed specification-options fetch used to report through the shared `onError`, which
  // a later successful save elsewhere on the page resets to null — see IdentitySection's comment
  // on the same fix. `onOptionsError` writes into the page's persistent `loadError` instead, and
  // `optionsReady` disables the picker until the fetch actually succeeds.
  const [optionsReady, setOptionsReady] = useState(false);
  useEffect(() => {
    api<SpecOption[]>("/api/picklists/specification").then((data) => {
      setOptions(data);
      setOptionsReady(true);
    }).catch((e) => onOptionsError((e as Error).message));
  }, [onOptionsError]);

  async function add() {
    if (!draft) return;
    try {
      await api(`/api/parts/${partId}/specifications`, {
        method: "POST", body: JSON.stringify({ specificationId: draft }),
      });
      setDraft("");
      onError(null);
      invalidateHistory(); // #14 item 1 — success path, before the follow-up load
      await load();
    } catch (e) { onError((e as Error).message); }
  }
  async function remove(linkId: string) {
    try {
      await api(`/api/parts/${partId}/specifications/${linkId}`, { method: "DELETE" });
      onError(null);
      invalidateHistory(); // #14 item 1
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
                disabled={!canEdit.allowed || !optionsReady}
                title={!optionsReady ? "Options failed to load — reload the page" : canEdit.title}
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
