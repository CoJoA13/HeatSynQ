"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";

/** Local mirror of src/server/shippers.ts's `ShipperRow`, narrowed to what this section renders
 *  — not imported from src/server/** (CLAUDE.md). `orders` is Task 17's per-order breakdown:
 *  this order's own sequence, quantities and complete flag, which the shipment-wide totals
 *  cannot answer once a shipment carries several orders. */
type ShipperRowOrder = {
  orderId: string; orderNumber: number; sequence: number;
  qty: number; weight: number; complete: boolean;
};
type ShipperRow = {
  id: string; shipperNumber: number; bolNumber: number | null;
  shipDate: string; orders: ShipperRowOrder[];
  carrierName: string | null; deletedAt: string | null;
};

/**
 * The hub's Shipments section (design spec §11, Task 17): every shipment that has ever carried
 * this order — voided included, dimmed rather than hidden (the shipmentsForOrder contract). Pure
 * read; shipments are created and edited on their own page, so a voided order needs no special
 * lock here beyond what the read already is.
 *
 * Each row links to /shipping/[id]. That page is lane A's Task 14 — on this lane's dev server
 * the link 404s, which is the established cross-lane nav precedent (task-15/16 briefs): the HREF
 * is the contract, the page arrives at merge.
 */
export function ShipmentsSection({
  orderId, orderNumber, viewGate,
}: {
  orderId: string;
  orderNumber: number;
  viewGate: Gate;
}) {
  const [rows, setRows] = useState<ShipperRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const allowed = viewGate.allowed;
  const load = useCallback(async () => {
    if (!allowed) return;
    setRows(await api<ShipperRow[]>(`/api/orders/${orderId}/shipments`));
  }, [orderId, allowed]);
  useEffect(() => { load().then(() => setError(null)).catch((e) => setError((e as Error).message)); }, [load]);

  // §5.16: a caller without shipping.view sees the section saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Shipments</h2>
        <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view shipments."}</p>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Shipments</h2>

      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing shipped yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Shipment</th>
              <th className="font-medium">Packing List No</th>
              <th className="font-medium">Ship date</th>
              <th className="font-medium">Qty</th>
              <th className="font-medium">Weight</th>
              <th className="font-medium">Complete</th>
              <th className="font-medium">Carrier</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              // THIS order's own slice of the shipment — the `72036-3` label and per-order
              // quantities come from it, never from the shipment-wide totals.
              const mine = row.orders.find((o) => o.orderId === orderId);
              return (
                <tr key={row.id} className={`border-t ${row.deletedAt ? "text-slate-400" : ""}`}>
                  <td className="py-1 font-mono">
                    <Link href={`/shipping/${row.id}`} className="text-blue-700 underline">
                      {mine ? `${orderNumber}-${mine.sequence}` : `#${row.shipperNumber}`}
                    </Link>
                    {row.deletedAt && (
                      <span className="ml-2 rounded bg-slate-200 px-1 text-xs text-slate-700">voided</span>
                    )}
                    {row.orders.length > 1 && (
                      <span className="ml-2 text-xs text-slate-500">
                        (+{row.orders.length - 1} other order{row.orders.length === 2 ? "" : "s"})
                      </span>
                    )}
                  </td>
                  <td>{row.shipperNumber}</td>
                  <td>{row.shipDate}</td>
                  <td>{mine ? mine.qty.toLocaleString() : "—"}</td>
                  <td>{mine ? mine.weight.toLocaleString() : "—"}</td>
                  <td>{mine ? (mine.complete ? "Complete" : "Partial") : "—"}</td>
                  <td className="text-slate-600">{row.carrierName ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
