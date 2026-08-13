"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";

// Mirrors src/server/quote-links.ts's QuoteLinkCandidate — local copy, the client/server
// boundary rule (CLAUDE.md), same as every other type on this page.
type QuoteLinkCandidate = {
  quoteLineId: string;
  quoteId: string;
  quoteNumber: number;
  effectiveDate: string;
  expiryDate: string;
};

/**
 * The active-quote indicator (spec §4.2): the part's in-date OPEN quote line(s), latest-effective
 * first, each linked to its quote.
 *
 * Served by `GET /api/quotes/eligible` with NO receivedDate — the route defaults an absent date
 * to TODAY, and "eligible as of today" IS "in-date and OPEN" (§5.2's one rule), already in
 * ruling 7's latest-effective-first order. No new read was needed (the Task 9 brief's own
 * closest-fit call), and the served order is rendered as-is — no client-side re-sort to drift
 * from the server's tie-break. The route is gated orders.view (§5.15 — it serves order entry's
 * pick-list); a viewer without it gets the reason named, never a silently absent section.
 */
export function ActiveQuotesSection({
  partId, customerId, perms,
}: {
  partId: string;
  customerId: string;
  perms: string[] | undefined;
}) {
  const viewGate = gate(perms, "orders.view");
  const [rows, setRows] = useState<QuoteLinkCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewGate.allowed) return;
    let stale = false;
    const qs = new URLSearchParams({ customerId, partId });
    api<{ candidates: QuoteLinkCandidate[] }>(`/api/quotes/eligible?${qs}`).then((p) => {
      if (!stale) setRows(p.candidates);
    }).catch((e) => {
      // Its own error, rendered in place — never the page's shared `error` a later save clears,
      // and never a silent catch (the loadError precedent on this page).
      if (!stale) setError((e as Error).message);
    });
    return () => { stale = true; };
  }, [partId, customerId, viewGate.allowed]);

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Active quotes</h2>
      {!viewGate.allowed ? (
        <p className="text-sm text-slate-500">{viewGate.title} to see which open quotes cover this part.</p>
      ) : error ? (
        <p className="rounded bg-amber-50 p-2 text-sm text-amber-800">Could not load active quotes: {error}</p>
      ) : rows === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No open quote covers this part today.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.quoteLineId}>
              <Link href={`/quotes/${r.quoteId}`} className="text-blue-700 underline">
                Quote #{r.quoteNumber}
              </Link>{" "}
              <span className="text-slate-500">— effective {r.effectiveDate} to {r.expiryDate}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
