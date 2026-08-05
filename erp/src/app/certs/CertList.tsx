"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { CERT_SCOPES, CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";

// Local mirror of src/server/certs.ts's CertRow — not imported from src/server/** (CLAUDE.md
// "Constraints that will bite you": a client component pulling from there drags node:async_hooks
// and Prisma into the browser bundle). Dates cross the wire as ISO strings once run through
// NextResponse.json, not the `Date` the service type carries. Only the columns this list actually
// renders (the parts/page.tsx PartRow precedent) — `orderId`/`shipperId` are on the server row but
// nothing here needs them, since the detail link is keyed on the cert's own `id`.
type CertRow = {
  id: string; orderNumber: number; sequence: number | null;
  customerCode: string; customerName: string; scope: CertScopeValue;
  loadNumber: number | null; shipperNumber: number | null;
  printedAt: string | null; deletedAt: string | null;
  readingCount: number; failCount: number;
};

// The parts/page.tsx precedent: only the slice the customer filter picker needs.
type CustomerOption = { id: string; code: string; name: string };

/** Spec §3.19: a cert has no number of its own. Its label is the order number plus, for a
 *  SHIPMENT-scope cert, that order's own shipment sequence — `#72036-3` — and just the bare
 *  order number for ORDER/LOAD scope. */
function orderLabel(row: CertRow): string {
  return row.scope === "SHIPMENT" && row.sequence !== null
    ? `#${row.orderNumber}-${row.sequence}`
    : `#${row.orderNumber}`;
}

/** The §11 "load or shipment" column: whichever subject the scope actually carries. ORDER scope
 *  carries neither. */
function loadOrShipment(row: CertRow): string {
  if (row.scope === "LOAD") return row.loadNumber !== null ? `Load ${row.loadNumber}` : "";
  if (row.scope === "SHIPMENT") return row.shipperNumber !== null ? `Shipper #${row.shipperNumber}` : "";
  return "";
}

export function CertList() {
  const [rows, setRows] = useState<CertRow[]>([]);
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [scope, setScope] = useState<CertScopeValue | "">("");
  const [printed, setPrinted] = useState<"" | "1" | "0">("");
  const [includeVoided, setIncludeVoided] = useState(false);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();

  const customersGate = gate(perms, "customers.view");

  const params = new URLSearchParams();
  if (search.trim()) params.set("search", search.trim());
  if (customerId) params.set("customerId", customerId);
  if (scope) params.set("scope", scope);
  if (printed) params.set("printed", printed);
  if (includeVoided) params.set("includeVoided", "1");
  const query = params.toString();

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the
  // held-permission checks above, and shadowing that binding with the stale-response gate would
  // break every `gate(perms, ...)` call in this component.
  const latest = useLatest();
  // The catch is ticket-gated too, not just the success path (the customers/parts precedent,
  // issues #5/#15): a superseded request's rejection landing after a newer request already
  // succeeded must not overwrite fresh rows with a stale failure message.
  const load = useCallback(async () => {
    const t = latest.next();
    let data: CertRow[];
    try {
      data = await api<CertRow[]>(`/api/certs${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setError(null);
    setRows(data);
  }, [query, latest]);
  useEffect(() => { void load(); }, [load]);

  // Customer filter picker: fetched only once the caller is known to hold customers.view (§5.16
  // — a blocked control must say why, not silently sit empty), the parts/page.tsx precedent. A
  // failed fetch surfaces through the same `error` banner as every other fetch on this page — no
  // `.catch(() => {})` silencing.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setError((e as Error).message));
  }, [customersGate.allowed]);

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Certifications</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Search order # or customer" className="w-64 rounded border px-2 py-1 text-sm" />
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}
                disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
          ))}
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value as CertScopeValue | "")}
                className="rounded border px-2 py-1 text-sm">
          <option value="">All scopes</option>
          {CERT_SCOPES.map((s) => (
            <option key={s} value={s}>{CERT_SCOPE_LABELS[s]}</option>
          ))}
        </select>
        <select value={printed} onChange={(e) => setPrinted(e.target.value as "" | "1" | "0")}
                className="rounded border px-2 py-1 text-sm">
          <option value="">Printed or not</option>
          <option value="1">Printed</option>
          <option value="0">Not printed</option>
        </select>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={includeVoided} onChange={(e) => setIncludeVoided(e.target.checked)} />
          Show voided
        </label>
        <a href={`/api/certs/export${query ? `?${query}` : ""}`} className="text-sm text-blue-700 underline">
          Export to Excel
        </a>
      </div>

      <table className="w-full rounded border bg-white text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">Order</th><th className="p-2">Customer</th>
            <th className="p-2">Scope</th><th className="p-2">Load / shipment</th>
            <th className="p-2">Printed</th><th className="p-2">Results</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={`border-t ${row.deletedAt ? "text-slate-400" : ""}`}>
              <td className="p-2 font-mono">
                <Link href={`/certs/${row.id}`} className="text-blue-700 underline">{orderLabel(row)}</Link>
                {row.deletedAt && (
                  <span className="ml-2 rounded bg-slate-200 px-1 text-xs text-slate-700">voided</span>
                )}
              </td>
              <td className="p-2">{row.customerCode} · {row.customerName}</td>
              <td className="p-2">{CERT_SCOPE_LABELS[row.scope]}</td>
              <td className="p-2 text-slate-500">{loadOrShipment(row)}</td>
              <td className="p-2">{row.printedAt ? "yes" : "no"}</td>
              <td className="p-2">
                {row.readingCount === 0 ? (
                  <span className="text-slate-400">—</span>
                ) : row.failCount > 0 ? (
                  <span className="text-red-700">{row.failCount} of {row.readingCount} failed</span>
                ) : (
                  <span className="text-slate-600">{row.readingCount} passed</span>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && !error && (
            <tr><td className="p-2 text-slate-500" colSpan={6}>No certifications match these filters.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
