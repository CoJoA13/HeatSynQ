"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import type { OrderLoad } from "./page";

/** Mirrors `DocumentMeta` (src/server/documents.ts, Phase 4 Task 3) — a local type, not an
 *  import, for the usual reason (CLAUDE.md): a client component pulling from src/server/** drags
 *  Prisma and node:async_hooks into the browser bundle. `createdAt` arrives as a JSON date
 *  string. No `orderNumber`: `documents.ts` never joins to learn one, so this route only ever
 *  returns the raw `orderId` — unused below, kept for parity with the server shape. */
type StoredDocument = {
  id: string; orderId: string | null; kind: string;
  loadNumber: number | null; createdAt: string;
};

// Every DocumentKind, so a non-traveler kind renders a friendly label instead of its raw enum
// name (the cosmetic gap HANDOFF §6 recorded; P5A spec §10 completes it). Kept as Record<string>
// with a `?? d.kind` fallback at the call site so a future kind is a plain enum name, never a crash.
const KIND_LABELS: Record<string, string> = {
  TRAVELER: "Traveler",
  SHIPPER: "Shipping ticket",
  BOL: "Bill of lading",
  CERT: "Certification",
  INVOICE: "Invoice",
  CREDIT: "Credit",
};

/**
 * Traveler printing and the archive of every print (design spec §10/§11).
 *
 * Printing is a POST that streams the freshly-rendered PDF back, so it cannot go through
 * `api()` (which always parses JSON). Raw `fetch` here, with the error body read the same way
 * `api()` reads it, so a refusal — a voided order's 400, a permission 403 — still surfaces as
 * its real server message rather than "something went wrong".
 *
 * Opening the result: the bytes are turned into an object URL and opened in a new tab. Browsers
 * may block `window.open` when it happens after an `await` rather than directly inside the click
 * (and always will for the `?print=1` auto-print, which has no click at all). That is detected —
 * `window.open` returns null — and reported with a link the user can click themselves. It is
 * never silently swallowed; the print HAPPENED and is archived either way, and the panel says so.
 *
 * Fix round 1: that detection was broken. The call passed `"noopener"` as the feature string,
 * and `window.open` with noopener ALWAYS returns null — by specification, since the whole point
 * is that the opener gets no handle on the new window. So the "blocked" banner fired on every
 * successful print, `revokeObjectURL` never ran (a leaked blob per print), and a genuine popup
 * block was indistinguishable from success. The feature string is gone and the opener is severed
 * on the returned handle instead; the URL is a same-origin blob, so dropping `noopener` costs
 * nothing, and `null` now means what it is read as.
 *
 * Fix-wave finding 6: the `blocked` (null-return) branch itself never revoked the object URL at
 * all — a real popup block (not just fix round 1's false-positive one) leaked a blob every time.
 * The revocation now runs unconditionally after the open attempt, opened or blocked: the blocked
 * banner's own fallback link re-fetches the archived bytes from `/api/documents/:id`, never this
 * blob, so there is nothing lost by revoking it on the same delay either way.
 */
export function DocumentsSection({
  orderId, loads, voided, viewGate, autoPrint,
}: {
  orderId: string;
  loads: OrderLoad[];
  voided: boolean;
  viewGate: Gate;
  /** True when the hub was reached from Save & Print (`?print=1`) — prints once, then never again
   *  for this page instance. */
  autoPrint: boolean;
}) {
  const [docs, setDocs] = useState<StoredDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Set when a print succeeded but its window could not be opened — the escape hatch. */
  const [blocked, setBlocked] = useState<{ id: string; label: string } | null>(null);
  const [printing, setPrinting] = useState(false);
  const [loadChoice, setLoadChoice] = useState("");

  const load = useCallback(async () => {
    setDocs(await api<StoredDocument[]>(`/api/orders/${orderId}/documents`));
  }, [orderId]);
  useEffect(() => { load().then(() => setError(null)).catch((e) => setError((e as Error).message)); }, [load]);

  // Printing is disabled on a voided order (spec §5c: new prints refused, stored prints stay
  // readable), and on a caller without orders.view — disabled with a tooltip, never hidden (§5.16).
  const printGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Order is voided — stored prints stay available" }
    : viewGate;

  const print = useCallback(async (loadNumber?: number) => {
    setPrinting(true);
    setBlocked(null);
    try {
      const query = loadNumber === undefined ? "" : `?load=${loadNumber}`;
      const res = await fetch(`/api/orders/${orderId}/traveler${query}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError((body as { error?: string }).error ?? `Print failed (${res.status})`, res.status);
      }
      const documentId = res.headers.get("x-document-id") ?? "";
      const url = URL.createObjectURL(await res.blob());
      const opened = window.open(url, "_blank");
      if (opened) opened.opener = null;
      if (opened === null) {
        setBlocked({
          id: documentId,
          label: loadNumber === undefined ? "the traveler" : `the load ${loadNumber} traveler`,
        });
      }
      // Revoked on the same delay either way (fix-wave finding 6): the blocked banner's own
      // fallback link re-fetches the archived bytes from /api/documents/:id, the ARCHIVE
      // endpoint, not this blob — so this URL is never used once blocked, but it still pins the
      // bytes in memory until revoked. The null-return branch above used to skip this entirely,
      // leaking one blob per blocked print. Revoking immediately (in the opened case) would race
      // the new tab's own load; one minute is far longer than any tab needs and still bounds how
      // long the blob is pinned in memory either way.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }, [orderId, load]);

  // Save & Print (src/app/orders/new/page.tsx) saves, then lands here with `?print=1`. Honored
  // exactly ONCE — and the one-shot lives in the URL, not only in a ref.
  //
  // The ref alone (fix round 1) guarded only THIS component instance: React 19's development
  // double-effect, yes, but not a reload, a Back to this URL, or a bookmark of it. Every one of
  // those remounts with `?print=1` still on the address bar and would print again — silently
  // archiving a duplicate StoredDocument plus its audit row, for a document that is permanent and
  // has no delete path. `router.replace(pathname)` strips the parameter the instant the print
  // fires, so the URL that could re-trigger it no longer exists. `replace`, not `push`, so Back
  // still leaves the hub rather than landing on the print-again URL.
  const router = useRouter();
  const pathname = usePathname();
  const autoPrinted = useRef(false);
  useEffect(() => {
    if (!autoPrint || autoPrinted.current || !printGate.allowed) return;
    autoPrinted.current = true;
    router.replace(pathname);
    void print();
  }, [autoPrint, printGate.allowed, print, router, pathname]);

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Documents</h2>

      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {blocked && (
        <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
          The traveler printed and is saved below, but your browser blocked the window.{" "}
          {blocked.id === "" ? "Open it from the list below." : (
            <a href={`/api/documents/${blocked.id}`} target="_blank" rel="noreferrer"
               className="text-blue-700 underline">Open {blocked.label}</a>
          )}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void print()} disabled={printGate.disabled || printing}
                title={printGate.title}
                className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          {printing ? "Printing…" : "Print traveler"}
        </button>
        <span className="text-sm text-slate-500">
          {loads.length === 0 ? "No loads" : `all ${loads.length} load${loads.length === 1 ? "" : "s"}`}
        </span>

        <span className="ml-4 text-sm text-slate-400">|</span>
        <select value={loadChoice} onChange={(e) => setLoadChoice(e.target.value)}
                disabled={printGate.disabled || loads.length === 0} title={printGate.title}
                aria-label="Load to print"
                className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
          <option value="">Single load…</option>
          {loads.map((l) => (
            <option key={l.id} value={l.loadNumber}>
              Load {l.loadNumber}{l.qty === null ? "" : ` · ${l.qty.toLocaleString()} pcs`}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void print(Number(loadChoice))}
                disabled={printGate.disabled || printing || loadChoice === ""} title={printGate.title}
                className="rounded border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:text-slate-400">
          Print load
        </button>
      </div>

      {docs.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing printed yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Document</th>
              <th className="font-medium">Load</th>
              <th className="font-medium">Printed</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="py-1">
                  {/* A plain link, not a fetch: GET /api/documents/[id] streams the STORED bytes
                      inline, so the browser renders the exact archived file (spec §8). */}
                  <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer"
                     className="text-blue-700 underline">
                    {KIND_LABELS[d.kind] ?? d.kind}
                  </a>
                </td>
                <td>{d.loadNumber === null ? "All loads" : `Load ${d.loadNumber}`}</td>
                <td className="text-slate-600">{new Date(d.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
