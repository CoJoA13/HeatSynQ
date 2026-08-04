"use client";
// Client-safe: no src/server imports (CLAUDE.md).
//
// Fix-wave R4 finding 9. Order entry validates the LEAD line's part for process steps (spec §11)
// with an async fetch fired from that line's own card. The verdict is a single piece of parent
// state, so a report that arrives late can describe a line that is no longer the lead — the
// operator removed it, or removing an earlier line promoted a different card into position 1 —
// and Save is then enabled or blocked on a part they are no longer ordering.
//
// The card's own `useLatest` gate cannot see this: it is per-card, so an unmounted card's
// in-flight ticket is still "current" from its gate's point of view, and a surviving card that
// has simply stopped being the lead never invalidates anything at all. OrderLineCard.tsx's effect
// cleanup closes the first half (bump the gate on unmount, so a post-unmount resolution reports
// nothing); this closes the second, at the parent, by keying the report to the line it came from.

/** One card's report: the line it came from, and its verdict (`null` = unknown — a failed fetch
 *  or a caller without processes.view, which never blocks Save on its own). */
export type LeadValidityReport = { lineId: string; ok: boolean | null };

/**
 * The verdict to act on, given the latest report and the line id that is CURRENTLY the lead.
 * A report from any other line — or any report at all when there is no lead line — is not about
 * the order being saved, and is treated as "not checked" rather than as evidence.
 */
export function resolveLeadValidity(
  report: LeadValidityReport | null, leadLineId: string | null,
): boolean | null {
  if (report === null || leadLineId === null || report.lineId !== leadLineId) return null;
  return report.ok;
}
