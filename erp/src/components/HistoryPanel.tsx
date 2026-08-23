"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
// The pure diff logic lives in a client-safe leaf so tests/audit-diff.test.ts can pin it —
// including the raw-FK suppression (#14 item 2's render half) — without a DOM test env.
import { changedFields } from "@/lib/audit-diff";
// The parent → child-section registry the server walked to build this union (#153) — imported
// here so a foreign row is LABELLED by the same source of truth that decided to include it, and
// the panel can never render a row it cannot name.
import { auditChildLabel } from "@/lib/audit-children";

type Entry = {
  // `entity` matters now that the read is a union: it is what distinguishes the parent's own
  // rows from a child section's, and it is what `auditChildLabel` names the latter by.
  id: string; entity: string; at: string; actorName: string; action: string; reason: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};

/** What the audit route's single-record branch answers since #153 — capped rows plus whether the
 *  cap actually bit, so the panel can state the truncation instead of quietly shortening history. */
type HistoryResponse = { rows: Entry[]; hasMore: boolean };

// The audit endpoint is gated on admin.view (a permission-model decision recorded in
// docs/HANDOFF.md §6, deliberately not revisited here). A user who can view the record this
// panel is attached to but lacks admin.view gets a 403 from that request, which the old code
// treated identically to "zero entries" — silently misreporting a record that does have history
// as having none. "loading" also matters as its own state, not folded into "ok" with zero
// entries: the panel must not flash "No history" for the instant before the real answer arrives.
type Status = "loading" | "ok" | "error";

/**
 * Mounted panels ↔ mutating pages, the invalidateSetupBanner/invalidateBackupBanner mechanism
 * (#124/#110) cloned for #14 item 1. A module-level Set rather than context: the panel lives at
 * the bottom of a detail page and the mutations that move its history live in that page's
 * sections, with no common provider worth wrapping the app for; a Set also means a remount
 * cannot leave a stale subscriber behind. Per-tab, like both precedents.
 */
const invalidationListeners = new Set<() => void>();

/** Subscribe a listener; returns the unsubscribe. Exported so tests/history-invalidation.test.ts
 *  can pin the register/invalidate/unsubscribe contract without a DOM test env (the
 *  subscribeSetupInvalidations precedent); the component's own effect subscribes through this
 *  too, so the tested path IS the wired path. */
export function subscribeHistoryInvalidations(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

/**
 * Tell every mounted HistoryPanel that the history it shows is certainly out of date, and to
 * refetch NOW (#14 item 1). The panel otherwise fetches once per mount per entity, so without
 * this an edit made while staying on the page — set the material, then a price — never appeared
 * until a full reload, teaching an operator the panel lies. Call sites fire it on the SUCCESS
 * path, the instant the mutation resolves and BEFORE any follow-up load (the #124/#131
 * ordering: the server state has certainly changed by then, and a transiently failing follow-up
 * read must not skip the signal). Every mounted panel refetches — cheap (one gated GET each),
 * and a cross-entity signal is at worst a refresh that finds nothing new.
 */
export function invalidateHistory(): void {
  for (const listen of invalidationListeners) listen();
}

export function HistoryPanel({ entity, entityId }: { entity: string; entityId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  // Set from the SAME response as `entries`, in the same gated branch, so the two can never
  // disagree about which read they describe.
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  // Bumped by an invalidation to re-run the fetch effect below (the SetupBanner refreshNonce
  // shape, minus the one-shot latch — this fetch is cheap enough to simply re-run).
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => subscribeHistoryInvalidations(() => setRefreshNonce((n) => n + 1)), []);
  // Which entity/entityId the currently rendered entries belong to — so an invalidation refetch
  // (same key) keeps the list on screen instead of flashing "Loading history…" after every
  // section save, while a re-pointed panel (call sites re-point `entityId` into this unkeyed
  // subtree) still blanks to loading rather than showing row A's history under row B's heading.
  const loadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${entity}:${entityId}`;
    if (loadedKeyRef.current !== key) setStatus("loading");
    // Effect-scoped stale flag (the QuoteDetail/templates-list shape — the sanctioned useLatest
    // equivalent where the fetch is keyed entirely by the effect's deps, refreshNonce included),
    // gating BOTH paths: a superseded response must not paint stale rows, flip a fresh "ok" to
    // "error", or mask a real 403 with a stale success.
    let stale = false;
    api<HistoryResponse>(`/api/admin/audit?entity=${entity}&entityId=${entityId}`)
      .then((res) => {
        if (stale) return;
        loadedKeyRef.current = key;
        setEntries(res.rows);
        setHasMore(res.hasMore);
        setStatus("ok");
      })
      .catch(() => { if (!stale) { loadedKeyRef.current = null; setStatus("error"); } });
    return () => { stale = true; };
  }, [entity, entityId, refreshNonce]);
  if (status === "loading") return <p className="text-sm text-slate-500">Loading history…</p>;
  // Never render "No history" for a request that did not succeed — that's indistinguishable
  // from a record that genuinely has none, and actively misinforms whoever lacks admin.view.
  if (status === "error") {
    return <p className="text-sm text-slate-500">History could not be loaded.</p>;
  }
  if (entries.length === 0) return <p className="text-sm text-slate-500">No history.</p>;
  return (
    <>
      <ul className="divide-y rounded border bg-white text-sm">
        {entries.map((e) => {
          // null for the parent's own rows, which need no label — and for any entity that is not
          // a registered child of this parent, which renders plainly rather than under a guess.
          const section = auditChildLabel(entity, e.entity);
          return (
            <li key={e.id} className="p-2">
              <div className="flex justify-between">
                <span>
                  {section && (
                    <span className="mr-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {section}
                    </span>
                  )}
                  <b>{e.actorName}</b> — {e.action}{e.reason ? ` (${e.reason})` : ""}
                </span>
                <span className="text-slate-500">{new Date(e.at).toLocaleString()}</span>
              </div>
              {changedFields(e.before, e.after).map((k) => (
                // #170: a changed field is stringified inline, and for a relation array pulled in by
                // SNAPSHOT_INCLUDE (e.g. `lines`) that is kilobytes of single-line JSON with almost
                // no break opportunities. With no wrapping rule it cannot wrap, so it pushed the
                // whole page wider than the viewport (a CREATE entry, where every key counts as
                // changed, is the worst case). `break-all` lets it wrap at any character so it can
                // never resize the page again; `max-h-40 overflow-y-auto` keeps a multi-KB payload
                // scrolling inside its own box rather than turning one row into a wall. Every byte
                // stays reachable — this constrains the rendering, it does not truncate. Load-bearing
                // classes: do not drop them in a "cleanup" (the defect was the ABSENCE of exactly this).
                <div key={k} className="ml-2 max-h-40 overflow-y-auto break-all text-xs text-slate-600">
                  {k}: <s>{JSON.stringify(e.before?.[k])}</s> → {JSON.stringify(e.after?.[k])}
                </div>
              ))}
            </li>
          );
        })}
      </ul>
      {/* The read is capped (AUDIT_PANEL_LIMIT), and a silently shortened history is the same
          class of lie as the "No history" on a 403 this panel already refuses to show. Stated
          from the response's own `hasMore` and the rows actually rendered, so the sentence stays
          true whatever the cap is set to. */}
      {hasMore && (
        <p className="mt-1 text-xs text-slate-500">
          Showing the most recent {entries.length} changes — older history is not listed.
        </p>
      )}
    </>
  );
}
