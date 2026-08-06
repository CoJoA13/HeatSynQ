"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import type { OrderLoad } from "./page";

/** Local mirror of src/server/certs.ts's `CertRow`, narrowed to what this section renders — not
 *  imported from src/server/** (CLAUDE.md; the CertList.tsx precedent). Dates cross the wire as
 *  ISO strings. */
type CertRow = {
  id: string; scope: CertScopeValue; loadNumber: number | null;
  shipperNumber: number | null; sequence: number | null;
  printedAt: string | null; deletedAt: string | null;
  readingCount: number; passedCount: number; failCount: number;
};

/** The §11 "load or shipment" subject column — the CertList.tsx shape, minus the order number
 *  (every cert here belongs to THIS order). */
function subject(row: CertRow): string {
  if (row.scope === "LOAD") return row.loadNumber !== null ? `Load ${row.loadNumber}` : "";
  if (row.scope === "SHIPMENT") return row.shipperNumber !== null ? `Shipper #${row.shipperNumber}` : "";
  return "";
}

/** Three states, never two (the CertList.tsx lesson): a reading with no value is pending, not
 *  passed — `readingCount - failCount` would overstate completeness for every mid-entry cert. */
function results(row: CertRow): string {
  if (row.readingCount === 0) return "—";
  const pending = row.readingCount - row.passedCount - row.failCount;
  const parts: string[] = [];
  if (row.failCount > 0) parts.push(`${row.failCount} of ${row.readingCount} failed`);
  else if (row.passedCount > 0) parts.push(`${row.passedCount} passed`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.join(", ") || "—";
}

/**
 * The hub's Certifications section (design spec §4.1/§6.2/§11, Task 17). Lists every cert for
 * this order — voided included, dimmed rather than hidden (the certsForOrder contract). Creation
 * here is LOAD scope ONLY (§6.2's on-demand rule): order-scope certs are created by order save
 * and shipment-scope by shipment save, so both are listed but never created from this section.
 *
 * Two §4.1 obligations render here and nowhere else:
 * - the explicit gap — "by load · 4 loads · 0 certs" with a create action per uncovered load —
 *   shown when the ORDER's frozen resolution is (required, LOAD), so lazy creation is never
 *   silent forgetting;
 * - the orphan warning — a LIVE load-scope cert whose loadNumber no longer exists after a
 *   re-split is flagged, never hidden: "a person voids or re-creates it, never the system
 *   silently." A VOIDED orphan is not re-flagged — voiding is exactly the human resolution the
 *   flag asks for.
 *
 * State model: `call()`-shaped, never optimistic (the page's binding model, case (b)) — a create
 * POSTs, then the list refetches; nothing here touches `order`.
 */
export function CertificationsSection({
  orderId, loads, certRequired, certScope, viewGate, createGate,
}: {
  orderId: string;
  loads: OrderLoad[];
  certRequired: boolean;
  certScope: CertScopeValue;
  viewGate: Gate;
  /** Already void-locked by the page (voidLocked), like every other mutating gate here. */
  createGate: Gate;
}) {
  const [rows, setRows] = useState<CertRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<number | null>(null);

  const allowed = viewGate.allowed;
  const load = useCallback(async () => {
    if (!allowed) return;
    setRows(await api<CertRow[]>(`/api/orders/${orderId}/certs`));
  }, [orderId, allowed]);
  useEffect(() => { load().then(() => setError(null)).catch((e) => setError((e as Error).message)); }, [load]);

  async function createForLoad(loadNumber: number) {
    setCreating(loadNumber);
    try {
      await api(`/api/orders/${orderId}/certs`, { method: "POST", body: JSON.stringify({ loadNumber }) });
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(null);
    }
  }

  // §5.16: a caller without certs.view sees the section saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Certifications</h2>
        <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view certifications."}</p>
      </section>
    );
  }

  const liveLoadCerts = rows.filter((r) => r.scope === "LOAD" && r.deletedAt === null);
  const currentLoadNumbers = new Set(loads.map((l) => l.loadNumber));
  const coveredLoadNumbers = new Set(liveLoadCerts.map((r) => r.loadNumber));
  // §4.1: a LIVE load-scope cert pinned to a number no current load carries — the re-split
  // orphan. Flagged by name; the voided case is deliberately excluded (see the header comment).
  const orphans = liveLoadCerts.filter((r) => r.loadNumber !== null && !currentLoadNumbers.has(r.loadNumber));
  const uncovered = loads.filter((l) => !coveredLoadNumbers.has(l.loadNumber));
  const showLoadGap = certRequired && certScope === "LOAD";

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Certifications</h2>

      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      {orphans.map((r) => (
        <p key={r.id} className="mb-2 rounded bg-amber-50 p-2 text-sm text-amber-800">
          <Link href={`/certs/${r.id}`} className="text-blue-700 underline">Certification for Load {r.loadNumber}</Link>
          {" "}points at a load that no longer exists after a re-split — void it or re-create it for a current load.
        </p>
      ))}

      {showLoadGap && (
        <div className="mb-3 text-sm">
          <p className="mb-1 text-slate-600">
            by load · {loads.length} load{loads.length === 1 ? "" : "s"} · {liveLoadCerts.length} cert{liveLoadCerts.length === 1 ? "" : "s"}
          </p>
          {uncovered.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {uncovered.map((l) => (
                <button key={l.id} type="button" onClick={() => void createForLoad(l.loadNumber)}
                        disabled={createGate.disabled || creating !== null} title={createGate.title}
                        className="rounded border border-slate-800 px-2 py-0.5 text-slate-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
                  {creating === l.loadNumber ? "Creating…" : `Create cert for Load ${l.loadNumber}`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          {certRequired ? "No certifications yet." : "None — this order does not require a certification."}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Scope</th>
              <th className="font-medium">Subject</th>
              <th className="font-medium">Printed</th>
              <th className="font-medium">Results</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-t ${r.deletedAt ? "text-slate-400" : ""}`}>
                <td className="py-1">
                  {/* /certs/[id] is this branch's own Task 16 page — the one hub link that works
                      on this lane's dev server today. */}
                  <Link href={`/certs/${r.id}`} className="text-blue-700 underline">
                    {CERT_SCOPE_LABELS[r.scope]}
                  </Link>
                  {r.deletedAt && (
                    <span className="ml-2 rounded bg-slate-200 px-1 text-xs text-slate-700">voided</span>
                  )}
                </td>
                <td className="text-slate-500">{subject(r)}</td>
                <td>{r.printedAt ? "yes" : "no"}</td>
                <td>{results(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
