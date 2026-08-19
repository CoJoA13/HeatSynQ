"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
// The pure diff logic lives in a client-safe leaf so tests/audit-diff.test.ts can pin it —
// including the raw-FK suppression (#14 item 2's render half) — without a DOM test env.
import { changedFields } from "@/lib/audit-diff";

type Entry = {
  id: string; at: string; actorName: string; action: string; reason: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};

// The audit endpoint is gated on admin.view (a permission-model decision recorded in
// docs/HANDOFF.md §6, deliberately not revisited here). A user who can view the record this
// panel is attached to but lacks admin.view gets a 403 from that request, which the old code
// treated identically to "zero entries" — silently misreporting a record that does have history
// as having none. "loading" also matters as its own state, not folded into "ok" with zero
// entries: the panel must not flash "No history" for the instant before the real answer arrives.
type Status = "loading" | "ok" | "error";

export function HistoryPanel({ entity, entityId }: { entity: string; entityId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  useEffect(() => {
    setStatus("loading");
    // Effect-scoped stale flag (the QuoteDetail/templates-list shape — the sanctioned useLatest
    // equivalent where the fetch is keyed entirely by the effect's deps), gating BOTH paths:
    // call sites re-point `entityId` into this unkeyed subtree, so a superseded response must
    // not paint row A's history under row B's heading, flip a fresh "ok" to "error", or mask a
    // real 403 with a stale success.
    let stale = false;
    api<Entry[]>(`/api/admin/audit?entity=${entity}&entityId=${entityId}`)
      .then((rows) => { if (stale) return; setEntries(rows); setStatus("ok"); })
      .catch(() => { if (!stale) setStatus("error"); });
    return () => { stale = true; };
  }, [entity, entityId]);
  if (status === "loading") return <p className="text-sm text-slate-500">Loading history…</p>;
  // Never render "No history" for a request that did not succeed — that's indistinguishable
  // from a record that genuinely has none, and actively misinforms whoever lacks admin.view.
  if (status === "error") {
    return <p className="text-sm text-slate-500">History unavailable (you may not have permission to view it).</p>;
  }
  if (entries.length === 0) return <p className="text-sm text-slate-500">No history.</p>;
  return (
    <ul className="divide-y rounded border bg-white text-sm">
      {entries.map((e) => (
        <li key={e.id} className="p-2">
          <div className="flex justify-between">
            <span><b>{e.actorName}</b> — {e.action}{e.reason ? ` (${e.reason})` : ""}</span>
            <span className="text-slate-500">{new Date(e.at).toLocaleString()}</span>
          </div>
          {changedFields(e.before, e.after).map((k) => (
            <div key={k} className="ml-2 text-xs text-slate-600">
              {k}: <s>{JSON.stringify(e.before?.[k])}</s> → {JSON.stringify(e.after?.[k])}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}
