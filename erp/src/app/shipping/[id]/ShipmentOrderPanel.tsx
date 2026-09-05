"use client";
// One panel per `ShipperOrderDetail` (design spec §11), headed with its label (`72036-3`) and
// carrying the three grids task-14-brief.md calls out as this phase's largest sibling group:
// lines, containers, serials. The grid MARKUP and candidate-prefill arithmetic live in ONE shared
// copy for the whole group — ../ShipmentGrids.tsx, shared with the create page (`/shipping/new`,
// Task 14b) — so the sibling-split rule (CLAUDE.md: "any fix to one grid lands on all copies in
// the same commit") holds by construction across BOTH pages. What stays here is persistence,
// which is this page's own: each grid is `useBulkGrid` (src/lib/bulk-grid.ts) over the rows
// already on THIS shipper order (`so.lines`/`so.containers`/`so.serials`), with an "Add" picker
// sourced from the order's OWN full catalog (`OrderCatalog`, fetched once per order by
// ShipmentDetail.tsx) — the ContainersSection/SerialsSection precedent (src/app/orders/[id]/),
// not an auto-seed-everything mutation chain: nothing is written to the server until the operator
// clicks Save, exactly like every other bulk grid in this codebase.
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import {
  LinesGridView, ContainersGridView, SerialsGridView,
  type GridRowHandle, type LineFields, type ContainerFields, type SerialFields,
  type LineInfo, type ShippedInfo, type ContainerInfo, type SerialInfo,
} from "../ShipmentGrids";
import type { ApplyMutation, OrderCatalog, ShipperOrder, ShipperMutationResult } from "./ShipmentDetail";
import { SaveButton } from "@/components/SaveButton";

/** Read-only strip for RELEASED rows (snapshot + release, ruling 23): the order-side row was
 *  corrected away, so these render from their snapshots, stay out of the editable grid and its
 *  payload, and survive every replace server-side as frozen history. */
function ReleasedRows({ label, rows }: { label: string; rows: string[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-1 rounded border border-dashed bg-slate-50 px-2 py-1 text-xs text-slate-600">
      {label} kept from earlier selections (the order-side rows were since corrected away):{" "}
      {rows.join("; ")}
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Lines grid — `useBulkGrid` over the shipment's saved lines, saved through the bulk PUT.
// -------------------------------------------------------------------------------------------

function LinesGrid({
  shipperId, shipperOrderId, lines, shippedToDate, catalog, editGate, creditHoldReason, applyMutation, onError,
}: {
  shipperId: string; shipperOrderId: string; lines: ShipperOrder["lines"];
  shippedToDate: ShipperOrder["orderLineShippedToDate"];
  /** Already the extension gate when the customer is held (ShipmentDetail's `extendGate`) —
   *  §5.4 extended to line replacement, owner ruling 2026-08-06. */
  catalog: OrderCatalog | undefined; editGate: Gate;
  /** Non-empty exactly when a held customer's save should carry the override reason. */
  creditHoldReason: string;
  applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<LineFields>();
  const liveLines = lines.filter((l): l is typeof l & { orderLineId: string } => l.orderLineId !== null);
  const releasedLines = lines.filter((l) => l.orderLineId === null);
  const rows = grid.compose(liveLines, (l) => ({
    orderLineId: l.orderLineId, qty: String(l.qty), weight: String(l.weight),
    lineComplete: l.lineComplete ? "true" : "false",
  }));
  const usedLineIds = new Set(rows.map((r) => r.orderLineId));
  const candidates = (catalog?.lines ?? []).filter((c) => !usedLineIds.has(c.id));

  // Part identity/ordered-qty for display: an already-saved row carries it on `lines` itself
  // (ShipperLineDetail); a row just added locally has no server row yet, so it's looked up from
  // the order's own catalog instead.
  const infoByLineId = new Map<string, LineInfo>();
  for (const l of liveLines) {
    infoByLineId.set(l.orderLineId, {
      partNumber: l.partNumber, partName: l.partName, orderedQty: l.orderedQty, orderedWeight: l.orderedWeight,
    });
  }
  for (const c of catalog?.lines ?? []) {
    if (!infoByLineId.has(c.id)) {
      infoByLineId.set(c.id, { partNumber: c.partNumber, partName: c.partName, orderedQty: c.qty, orderedWeight: c.weight });
    }
  }
  // Shipped-to-date for EVERY line of the order, candidates included — `orderLineShippedToDate`
  // rides on the shipment's own GET (shippers.ts `readShipperDetail`), so it is refetched with
  // every mutation on this page and never goes stale the way a separately-fetched catalog could.
  // Seeded from the rows already on the shipment first purely as a belt-and-braces fallback: both
  // sides come from the SAME `shippedTotals` call, so the values agree by construction.
  const shippedByLineId = new Map<string, ShippedInfo>(
    liveLines.map((l) => [l.orderLineId, { qty: l.shippedToDateQty, weight: l.shippedToDateWeight }]));
  for (const s of shippedToDate) shippedByLineId.set(s.orderLineId, { qty: s.shippedToDateQty, weight: s.shippedToDateWeight });

  function patch(row: GridRowHandle, field: keyof LineFields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<LineFields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<LineFields>);
  }
  function remove(row: GridRowHandle) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }

  async function save() {
    const payload: { orderLineId: string; qty: number; weight: string; lineComplete: boolean }[] = [];
    for (const [i, row] of rows.entries()) {
      const label = `Line ${i + 1}`;
      const qty = Number(row.qty);
      if (!Number.isInteger(qty) || qty < 0) { onError(`${label}: ship-now quantity must be a whole number of at least 0.`); return; }
      const weight = row.weight.trim();
      if (weight === "" || !(Number(weight) >= 0)) { onError(`${label}: ship-now weight must be a number of at least 0.`); return; }
      payload.push({ orderLineId: row.orderLineId, qty, weight, lineComplete: row.lineComplete === "true" });
    }
    try {
      await applyMutation(() => api<ShipperMutationResult>(
        `/api/shippers/${shipperId}/orders/${shipperOrderId}/lines`,
        { method: "PUT", body: JSON.stringify(creditHoldReason ? { lines: payload, creditHoldReason } : payload) }));
      grid.reset();
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (<>
    <ReleasedRows label="Lines"
      rows={releasedLines.map((l) => `${l.partNumber} · ${l.qty} pcs / ${l.weight} lbs`)} />
    <LinesGridView rows={rows} candidates={candidates} infoByLineId={infoByLineId} shippedByLineId={shippedByLineId}
                   gate={editGate} orphanWarning={grid.orphanWarning}
                   onPatch={patch} onRemove={remove} onAddRows={(rs) => grid.addRows(rs)}
                   footer={<SaveButton label="Save lines" section="Lines" gate={editGate} dirty={grid.dirty} onSave={() => void save()} />} />
  </>);
}

// -------------------------------------------------------------------------------------------
// Containers grid.
// -------------------------------------------------------------------------------------------

function ContainersGrid({
  shipperId, shipperOrderId, containers, catalog, editGate, applyMutation, onError,
}: {
  shipperId: string; shipperOrderId: string; containers: ShipperOrder["containers"];
  catalog: OrderCatalog | undefined; editGate: Gate; applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<ContainerFields>();
  const liveContainers = containers.filter((c): c is typeof c & { orderContainerId: string } => c.orderContainerId !== null);
  const releasedContainers = containers.filter((c) => c.orderContainerId === null);
  const rows = grid.compose(liveContainers, (c) => ({ orderContainerId: c.orderContainerId, count: String(c.count) }));
  const usedIds = new Set(rows.map((r) => r.orderContainerId));
  const candidates = (catalog?.containers ?? []).filter((c) => !usedIds.has(c.id));

  const infoById = new Map<string, ContainerInfo>();
  for (const c of liveContainers) infoById.set(c.orderContainerId, { typeName: c.typeName, customerContainerId: c.customerContainerId });
  for (const c of catalog?.containers ?? []) {
    if (!infoById.has(c.id)) infoById.set(c.id, { typeName: c.typeName, customerContainerId: c.customerContainerId });
  }

  function patch(row: GridRowHandle, field: keyof ContainerFields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<ContainerFields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<ContainerFields>);
  }
  function remove(row: GridRowHandle) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }

  async function save() {
    const payload: { orderContainerId: string; count: number }[] = [];
    for (const [i, row] of rows.entries()) {
      const count = Number(row.count);
      if (!Number.isInteger(count) || count < 1) { onError(`Container ${i + 1}: count must be a whole number of at least 1.`); return; }
      payload.push({ orderContainerId: row.orderContainerId, count });
    }
    try {
      await applyMutation(() => api<ShipperMutationResult>(
        `/api/shippers/${shipperId}/orders/${shipperOrderId}/containers`, { method: "PUT", body: JSON.stringify(payload) }));
      grid.reset();
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (<>
    <ReleasedRows label="Containers"
      rows={releasedContainers.map((c) => `${c.typeName}${c.customerContainerId ? ` (${c.customerContainerId})` : ""} ×${c.count}`)} />
    <ContainersGridView rows={rows} candidates={candidates} infoById={infoById}
                        gate={editGate} orphanWarning={grid.orphanWarning}
                        onPatch={patch} onRemove={remove} onAddRows={(rs) => grid.addRows(rs)}
                        footer={<SaveButton label="Save containers" section="Containers" gate={editGate} dirty={grid.dirty} onSave={() => void save()} />} />
  </>);
}

// -------------------------------------------------------------------------------------------
// Serials grid.
// -------------------------------------------------------------------------------------------

function SerialsGrid({
  shipperId, shipperOrderId, serials, catalog, editGate, applyMutation, onError,
}: {
  shipperId: string; shipperOrderId: string; serials: ShipperOrder["serials"];
  catalog: OrderCatalog | undefined; editGate: Gate; applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<SerialFields>();
  const liveSerials = serials.filter((sr): sr is typeof sr & { orderSerialId: string } => sr.orderSerialId !== null);
  const releasedSerials = serials.filter((sr) => sr.orderSerialId === null);
  const rows = grid.compose(liveSerials, (s) => ({ orderSerialId: s.orderSerialId, printOnShipper: s.printOnShipper ? "true" : "false" }));
  const usedIds = new Set(rows.map((r) => r.orderSerialId));
  const candidates = (catalog?.serials ?? []).filter((s) => !usedIds.has(s.id));

  const infoById = new Map<string, SerialInfo>();
  for (const s of liveSerials) infoById.set(s.orderSerialId, { serial: s.serial, description: s.description });
  for (const s of catalog?.serials ?? []) if (!infoById.has(s.id)) infoById.set(s.id, { serial: s.serial, description: s.description });

  function patch(row: GridRowHandle, field: keyof SerialFields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<SerialFields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<SerialFields>);
  }
  function remove(row: GridRowHandle) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }

  async function save() {
    const payload = rows.map((row) => ({ orderSerialId: row.orderSerialId, printOnShipper: row.printOnShipper === "true" }));
    try {
      await applyMutation(() => api<ShipperMutationResult>(
        `/api/shippers/${shipperId}/orders/${shipperOrderId}/serials`, { method: "PUT", body: JSON.stringify(payload) }));
      grid.reset();
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (<>
    <ReleasedRows label="Serials"
      rows={releasedSerials.map((sr) => `${sr.serial}${sr.description ? ` — ${sr.description}` : ""}`)} />
    <SerialsGridView rows={rows} candidates={candidates} infoById={infoById}
                     gate={editGate} orphanWarning={grid.orphanWarning}
                     onPatch={patch} onRemove={remove} onAddRows={(rs) => grid.addRows(rs)}
                     footer={<SaveButton label="Save serials" section="Serials" gate={editGate} dirty={grid.dirty} onSave={() => void save()} />} />
  </>
  );
}

// -------------------------------------------------------------------------------------------
// The panel itself.
// -------------------------------------------------------------------------------------------

export function ShipmentOrderPanel({
  shipperId, order, catalog, editGate, linesGate, creditHoldReason, applyMutation, onError, onRemove,
  printGate, printing, certsGate, onPrintTicket,
}: {
  shipperId: string; order: ShipperOrder; catalog: OrderCatalog | undefined;
  editGate: Gate;
  /** The extension gate for the lines grid — editGate tightened when the customer is on credit
   *  hold and the viewer lacks override_credit_hold (§5.4 extension ruling, 2026-08-06). */
  linesGate: Gate;
  /** Trimmed override reason to ride line saves for a held customer ("" otherwise). */
  creditHoldReason: string;
  applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
  onRemove: () => void;
  /** Ticket printing went live with Task 18 — the gate, the shared in-flight flag and the POST
   *  itself all live on ShipmentDetail (one print pipeline for the whole page). Task 19 added
   *  the cert checkbox (§3.14): `onPrintTicket(certWanted)` carries this panel's own box, and
   *  `certsGate` (certs.view) gates it with a truthful §5.16 tooltip. */
  printGate: Gate; printing: boolean; certsGate: Gate; onPrintTicket: (certWanted: boolean) => void;
}) {
  const [withCert, setWithCert] = useState(true);   // pre-ticked (§3.14)
  return (
    <section className="mb-6 rounded border bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">
          <Link href={`/orders/${order.orderId}`} className="text-blue-700 underline">{order.label}</Link>
          {order.poNumber && <span className="ml-2 text-sm font-normal text-slate-500">PO {order.poNumber}</span>}
          {order.customerJobNo && <span className="ml-2 text-sm font-normal text-slate-500">Job {order.customerJobNo}</span>}
        </h3>
        <button onClick={onRemove} disabled={!editGate.allowed} title={editGate.title}
                className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
          Remove order
        </button>
      </div>

      <LinesGrid shipperId={shipperId} shipperOrderId={order.id} lines={order.lines}
                 creditHoldReason={creditHoldReason}
                 shippedToDate={order.orderLineShippedToDate} catalog={catalog}
                 editGate={linesGate} applyMutation={applyMutation} onError={onError} />
      <div className="my-4 border-t" />
      <ContainersGrid shipperId={shipperId} shipperOrderId={order.id} containers={order.containers} catalog={catalog}
                       editGate={editGate} applyMutation={applyMutation} onError={onError} />
      <div className="my-4 border-t" />
      <SerialsGrid shipperId={shipperId} shipperOrderId={order.id} serials={order.serials} catalog={catalog}
                    editGate={editGate} applyMutation={applyMutation} onError={onError} />

      {/* Print (spec §11) — POST ?doc=ticket&order=<id>, with the cert checkbox pre-ticked
          (§3.14): the order's cert prints alongside as its own archived document. */}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
        <button type="button" onClick={() => onPrintTicket(withCert && certsGate.allowed)}
                disabled={!printGate.allowed || printing}
                title={printGate.title}
                className="rounded border px-3 py-1.5 disabled:cursor-not-allowed disabled:text-slate-400">
          {printing ? "Printing…" : "Print this order's ticket"}
        </button>
        {/* §5.16: the checkbox can be disabled for TWO reasons — the missing certs.view names
            itself, and on a voided shipment (certs.view held, so certsGate.title is undefined)
            the title falls through to printGate's voided reason rather than saying nothing
            (fix-wave 2026-08-06). */}
        <label className={`flex items-center gap-1 ${certsGate.allowed ? "" : "text-slate-400"}`}
               title={certsGate.title ?? printGate.title}>
          <input type="checkbox" checked={withCert && certsGate.allowed}
                 disabled={!certsGate.allowed || !printGate.allowed}
                 onChange={(e) => setWithCert(e.target.checked)} />
          Also print certification
        </label>
      </div>
    </section>
  );
}
