"use client";
// Client-safe UI shared by every /reports screen (Phase 8A Codex fixes 2 & 5). No src/server/**
// imports — a client component pulling from there drags node:async_hooks and Prisma into the
// browser bundle (CLAUDE.md "Constraints that will bite you"; the permission-ui.ts precedent).
import type { ReactNode } from "react";

/**
 * The gate/loading/error notice a /reports screen shows in place of its body when the caller cannot
 * (yet) see the report. THREE distinct states the screens previously collapsed into one always-
 * "denied" branch (Codex fix 2), which misreported a transient permissions-fetch failure as an
 * authorization denial AND left the retryable error banner unreachable:
 *   • `permsError` — the `/api/auth/me` fetch FAILED → a retryable red banner, NEVER "Requires
 *     reports.view";
 *   • `loading` — the permissions are still in flight → a neutral "Loading…" line;
 *   • otherwise — the caller is genuinely loaded-but-denied → the permission "why" message.
 * `header` carries the screen's own chrome (its back-link + heading) so the notice sits under it.
 */
export function GateNotice({ header, permsError, loading, deniedMessage }: {
  header: ReactNode;
  permsError: string | null;
  loading: boolean;
  deniedMessage: string;
}): ReactNode {
  return (
    <div className="p-6">
      {header}
      {permsError ? (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{permsError}</p>
      ) : loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <p className="text-sm text-slate-500">{deniedMessage}</p>
      )}
    </div>
  );
}

/**
 * The "Export to Excel" link, built from `query` — which every screen passes as the query of the
 * CURRENTLY-DISPLAYED result (`appliedQuery`), never the live filter state (Codex fix 5). It is a
 * live link only when `ready` AND `query` is non-null: `query === null` is the "no successful load
 * yet" sentinel (Codex fix 6), and `ready` is false is unreachable-but-defended. Inert otherwise —
 * exporting a never-loaded or filter-mismatched view would hand back a file the on-screen table does
 * not show, breaking the screen==export guarantee.
 */
export function ExportLink({ base, query, ready }: {
  base: string;
  query: string | null;
  ready: boolean;
}): ReactNode {
  if (!ready || query === null) {
    return (
      <span aria-disabled="true" title="Loading the current view…"
            className="cursor-not-allowed text-slate-400 underline">
        Export to Excel
      </span>
    );
  }
  return (
    <a href={`${base}${query ? `?${query}` : ""}`} className="text-blue-700 underline">
      Export to Excel
    </a>
  );
}
