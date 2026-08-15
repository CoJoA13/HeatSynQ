// Client-safe (no src/server imports; the permission-ui.ts precedent). The ONE rule every /reports
// screen uses to decide whether its "Export to Excel" link is live and whether its table is showing
// stale data (Phase 8A Codex fixes 5 & 6). Kept here as a pure function so the rule is stated once
// and unit-tested, instead of re-derived inline on seven screens.
//
// `appliedQuery` is the query string of the CURRENTLY-DISPLAYED result, or `null` when NO successful
// load has happened yet — the load-bearing distinction (Codex fix 6): a FAILED initial request still
// flips the screens' `loaded` flag true, and an `appliedQuery` initialized to "" would equal the
// default empty `currentQuery`, so a never-succeeded screen would look exportable and hand back a
// file for a result it never loaded. A distinct `null` sentinel can never equal a real query string,
// so Export stays inert until the FIRST successful load, and a failed reload keeps it pinned to the
// last successfully-loaded query.

export type ExportState = {
  /** A successful load has produced a displayable result — the Export link is live and points at
   *  `appliedQuery` (the last successfully-loaded filters), never the live filter state. */
  exportable: boolean;
  /** The displayed result is BEHIND the current filters (a reload is in flight or failed) — the
   *  table dims and shows "Updating…", while Export stays pinned to the shown data. Never true
   *  before the first successful load (there is nothing yet to show as stale). */
  showingStale: boolean;
};

export function exportState(appliedQuery: string | null, currentQuery: string): ExportState {
  const exportable = appliedQuery !== null;
  return { exportable, showingStale: exportable && appliedQuery !== currentQuery };
}
