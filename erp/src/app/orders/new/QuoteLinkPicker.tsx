"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { useLatest } from "@/lib/use-latest";
import type { Gate } from "@/lib/permission-ui";

// Mirrors src/server/quote-links.ts's QuoteLinkCandidate (and /api/quotes/eligible's payload) —
// not imported from src/server/**, the usual client/server-boundary reason (CLAUDE.md).
export type QuoteLinkCandidate = {
  quoteLineId: string;
  quoteId: string;
  quoteNumber: number;
  effectiveDate: string;
  expiryDate: string;
};
export type EligiblePayload = { candidates: QuoteLinkCandidate[]; autoLink: QuoteLinkCandidate | null };

/**
 * The three-way pick, exactly LINE's `quoteLineId` wire semantics (spec §5.2, orders.ts):
 * `undefined` = untouched — the save body OMITS the key and the SERVER's auto-resolution stays
 * authoritative; a string = the operator's explicit re-pick; `null` = the explicit "No quote".
 */
export type QuoteLinkPick = string | null | undefined;

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; candidates: QuoteLinkCandidate[]; autoLink: QuoteLinkCandidate | null };

function windowLabel(c: QuoteLinkCandidate): string {
  return `effective ${c.effectiveDate} to ${c.expiryDate}`;
}

/**
 * The quote-link resolution preview + re-pick control for the CREATE paths (spec §5.2, ruling 7)
 * — order entry's per-line card and the hub's add-rider form, both of which feed a save whose
 * `quoteLineId` key follows the three-way semantics above.
 *
 * THE ABSENT DISCIPLINE, structurally: the control's state IS the three-way pick. Untouched, the
 * select sits on the "auto" sentinel (= `undefined`), and the previewed auto-link's id is NEVER
 * copied into the pick — the preview is display, the sentinel is state — so a body builder that
 * writes the key only when the pick is not `undefined` cannot send the displayed id by accident,
 * and the server's resolution at save time stays authoritative (a quote cut between preview and
 * save wins, exactly as §5.2 wants). Only a deliberate selection moves the state to an explicit
 * id or an explicit null.
 *
 * A preview, never a guard (the /api/quotes/eligible route's own contract): the save re-judges
 * every explicit pick inside its own transaction, so a stale answer here costs a named 400 at
 * worst — the not-eligible warning below exists to catch the common case (received date changed
 * under an explicit pick) before the round trip.
 */
export function QuoteLinkPicker({
  customerId, partId, receivedDate, value, onChange, pickGate, viewAllowed, ariaLabel,
}: {
  customerId: string | null;
  /** Pass null to hide the control entirely (no part chosen yet, or the chosen part is stale —
   *  not in the current customer's catalog — in which case its own warning already shows). */
  partId: string | null;
  /** "yyyy-mm-dd", or undefined = untouched — the query param is then OMITTED and the server
   *  previews against ITS OWN today, identically to what an unbackdated save would do (the
   *  entry-defaults precedent). A change re-runs the preview fetch: on the entry form every line
   *  is unsaved, so this IS ruling 6's "refresh the preview for unsaved lines" — saved lines
   *  (the hub's Lines table) never mount this component at all. */
  receivedDate: string | undefined;
  value: QuoteLinkPick;
  onChange: (pick: QuoteLinkPick) => void;
  /** §5.16: the save permission of the surface this feeds — orders.create on entry, orders.edit
   *  on the hub's add-rider. The select disables with the reason as its title. */
  pickGate: Gate;
  /** /api/quotes/eligible is gated orders.view; without it the fetch is skipped and the reason
   *  is NAMED (never a silently blank preview — the save still auto-links server-side). */
  viewAllowed: boolean;
  ariaLabel: string;
}) {
  const [state, setState] = useState<FetchState | null>(null);
  const latest = useLatest();

  useEffect(() => {
    if (!customerId || !partId || !viewAllowed) { setState(null); return; }
    const t = latest.next();
    setState({ status: "loading" });
    const qs = new URLSearchParams({
      customerId, partId,
      ...(receivedDate ? { receivedDate } : {}),
    });
    api<EligiblePayload>(`/api/quotes/eligible?${qs}`).then((p) => {
      if (latest.isCurrent(t)) setState({ status: "ok", ...p });
    }).catch((e) => {
      // §5.13 / no `.catch(() => {})`: a failed preview is reported in place, and the control
      // degrades to "server will resolve" rather than pretending there is no quote.
      if (latest.isCurrent(t)) setState({ status: "error", message: (e as Error).message });
    });
    // Bump the gate on unmount so a resolution landing after this card is removed is dropped
    // (the OrderLineCard lead-check precedent).
    return () => { latest.next(); };
  }, [customerId, partId, receivedDate, viewAllowed, latest]);

  if (!customerId || !partId) return null;

  if (!viewAllowed) {
    return (
      <p className="mt-2 text-xs text-slate-500">
        Quote link: preview requires orders.view — saving still applies the server&apos;s auto-link.
      </p>
    );
  }
  if (!state || state.status === "loading") {
    return <p className="mt-2 text-xs text-slate-500">Checking quotes…</p>;
  }
  if (state.status === "error") {
    return (
      <div className="mt-2 text-xs">
        <p className="rounded bg-amber-50 p-1.5 text-amber-800">
          Could not check quotes: {state.message} — saving still applies the server&apos;s auto-link.
        </p>
        {value !== undefined && (
          <button type="button" onClick={() => onChange(undefined)} className="mt-1 text-blue-700 underline">
            reset to auto
          </button>
        )}
      </div>
    );
  }

  const { candidates, autoLink } = state;
  const picked = typeof value === "string" ? candidates.find((c) => c.quoteLineId === value) : undefined;
  const pickedGone = typeof value === "string" && !picked;
  // The select's value is the SENTINEL encoding of the three-way pick — "auto"/"none" can never
  // collide with a real cuid.
  const selectValue = value === undefined ? "auto" : value === null ? "none" : value;

  return (
    <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
      <div className="mb-1">
        {value === undefined && (autoLink ? (
          <span>
            Quote link (auto):{" "}
            <Link href={`/quotes/${autoLink.quoteId}`} className="text-blue-700 underline">
              Quote #{autoLink.quoteNumber}
            </Link>{" "}
            <span className="text-slate-500">({windowLabel(autoLink)})</span>
          </span>
        ) : (
          <span className="text-slate-500">No eligible quote — part prices apply.</span>
        ))}
        {value === null && <span>No quote (explicit) — part prices apply.</span>}
        {picked && (
          <span>
            Quote link (picked):{" "}
            <Link href={`/quotes/${picked.quoteId}`} className="text-blue-700 underline">
              Quote #{picked.quoteNumber}
            </Link>{" "}
            <span className="text-slate-500">({windowLabel(picked)})</span>
          </span>
        )}
        {pickedGone && (
          <span className="rounded bg-amber-50 p-1 text-amber-800">
            The picked quote line is not eligible as of this received date — Save will refuse it.
            Re-pick or reset to auto.
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <select value={selectValue} aria-label={ariaLabel}
                disabled={pickGate.disabled} title={pickGate.title}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange(v === "auto" ? undefined : v === "none" ? null : v);
                }}
                className="rounded border px-1.5 py-0.5 disabled:bg-slate-100">
          <option value="auto">
            {autoLink ? `Auto — Quote #${autoLink.quoteNumber}` : "Auto — no eligible quote"}
          </option>
          {candidates.map((c) => (
            <option key={c.quoteLineId} value={c.quoteLineId}>
              Quote #{c.quoteNumber} ({windowLabel(c)})
            </option>
          ))}
          {/* A controlled select whose value matches no option renders blank — the
              misrepresenting-stored-state shape this codebase keeps flagging — so a pick that
              dropped out of the candidate list keeps a synthetic option naming its condition. */}
          {pickedGone && <option value={value as string}>Picked quote (no longer eligible)</option>}
          <option value="none">No quote</option>
        </select>
        {value !== undefined && (
          <button type="button" onClick={() => onChange(undefined)} className="text-blue-700 underline">
            reset to auto
          </button>
        )}
      </div>
    </div>
  );
}
