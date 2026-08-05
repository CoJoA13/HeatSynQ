"use client";
// One panel per `ShipperOrderDetail` (design spec §11), headed with its label (`72036-3`) and
// carrying the three grids task-14-brief.md calls out as this phase's largest sibling group:
// lines, containers, serials. All three live in this ONE file, not three — the sibling-split
// rule (CLAUDE.md, task-14-brief.md: "any fix to one lands on all three in the same commit") is
// easiest to honor when a fix to one grid is visually adjacent to the other two, not scattered
// across files a reviewer has to remember to check together.
//
// Each grid is `useBulkGrid` (src/lib/bulk-grid.ts) over the rows already on THIS shipper order
// (`so.lines`/`so.containers`/`so.serials`), with an "Add" picker sourced from the order's OWN
// full catalog (`OrderCatalog`, fetched once per order by ShipmentDetail.tsx) — the
// ContainersSection/SerialsSection precedent (src/app/orders/[id]/), not an auto-seed-everything
// mutation chain: nothing is written to the server until the operator clicks Save, exactly like
// every other bulk grid in this codebase.
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import type { ApplyMutation, OrderCatalog, ShipperOrder, ShipperMutationResult } from "./ShipmentDetail";

// -------------------------------------------------------------------------------------------
// Lines grid — ordered / shipped-to-date / ship-now qty and lbs / ship-line-complete.
// -------------------------------------------------------------------------------------------

type LineFields = { orderLineId: string; qty: string; weight: string; lineComplete: string };

function LinesGrid({
  shipperId, shipperOrderId, lines, catalog, editGate, applyMutation, onError,
}: {
  shipperId: string; shipperOrderId: string; lines: ShipperOrder["lines"];
  catalog: OrderCatalog | undefined; editGate: Gate; applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<LineFields>();
  const rows = grid.compose(lines, (l) => ({
    orderLineId: l.orderLineId, qty: String(l.qty), weight: String(l.weight),
    lineComplete: l.lineComplete ? "true" : "false",
  }));
  const usedLineIds = new Set(rows.map((r) => r.orderLineId));
  // Prefilled to the remainder (task-14-brief.md): a candidate not yet on this shipment defaults
  // to its own full ordered qty/weight — the true remainder for the common case (this order has
  // no OTHER live shipment against this line yet). If it does, the §5.7 over-ship warning fires
  // on save and the operator corrects the ship-now qty by hand; over-shipping warns and never
  // blocks (spec §5.7), which is exactly the mechanism this default leans on.
  const candidates = (catalog?.lines ?? []).filter((c) => !usedLineIds.has(c.id));
  const [pick, setPick] = useState("");

  // Part identity/ordered-qty for display: an already-saved row carries it on `lines` itself
  // (ShipperLineDetail); a row just added locally has no server row yet, so it's looked up from
  // the order's own catalog instead.
  const infoByLineId = new Map<string, { partNumber: string; partName: string; orderedQty: number; orderedWeight: number }>();
  for (const l of lines) {
    infoByLineId.set(l.orderLineId, {
      partNumber: l.partNumber, partName: l.partName, orderedQty: l.orderedQty, orderedWeight: l.orderedWeight,
    });
  }
  for (const c of catalog?.lines ?? []) {
    if (!infoByLineId.has(c.id)) {
      infoByLineId.set(c.id, { partNumber: c.partNumber, partName: c.partName, orderedQty: c.qty, orderedWeight: c.weight });
    }
  }
  // Shipped-to-date is only known for a line already saved onto SOME shipment (ship-ledger.ts has
  // no client-callable endpoint) — a row added but not yet saved shows "—" rather than a guessed 0.
  const shippedByLineId = new Map(lines.map((l) => [l.orderLineId, { qty: l.shippedToDateQty, weight: l.shippedToDateWeight }]));

  function patch(row: { key: string; isNew: boolean }, field: keyof LineFields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<LineFields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<LineFields>);
  }
  function remove(row: { key: string; isNew: boolean }) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }
  function addPicked() {
    const c = candidates.find((x) => x.id === pick);
    if (!c) return;
    grid.addRow({ orderLineId: c.id, qty: String(c.qty), weight: String(c.weight), lineComplete: "false" });
    setPick("");
  }
  function addAllRemaining() {
    if (candidates.length === 0) return;
    grid.addRows(candidates.map((c) => ({ orderLineId: c.id, qty: String(c.qty), weight: String(c.weight), lineComplete: "false" })));
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
        `/api/shippers/${shipperId}/orders/${shipperOrderId}/lines`, { method: "PUT", body: JSON.stringify(payload) }));
      grid.reset();
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Lines</h4>
      {grid.orphanWarning && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{grid.orphanWarning}</p>}
      {rows.length === 0 ? (
        <p className="mb-2 text-sm text-slate-500">No lines on this shipment yet.</p>
      ) : (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Part</th>
              <th className="font-medium">Ordered</th>
              <th className="font-medium">Shipped to date</th>
              <th className="font-medium">Ship now qty</th>
              <th className="font-medium">Ship now lbs</th>
              <th className="font-medium">Complete</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const info = infoByLineId.get(row.orderLineId);
              const shipped = shippedByLineId.get(row.orderLineId);
              return (
                <tr key={row.key} className="border-t align-top">
                  <td className="py-1">
                    <div className="font-mono">{info?.partNumber ?? row.orderLineId}</div>
                    {info && <div className="text-xs text-slate-500">{info.partName}</div>}
                  </td>
                  <td>{info ? `${info.orderedQty} / ${info.orderedWeight} lbs` : "—"}</td>
                  <td>{shipped ? `${shipped.qty} / ${shipped.weight} lbs` : "—"}</td>
                  <td>
                    <input value={row.qty} inputMode="numeric" disabled={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patch(row, "qty", e.target.value)}
                           aria-label={`Line ${i + 1} ship-now quantity`}
                           className="w-20 rounded border px-1 py-0.5 disabled:bg-slate-50" />
                  </td>
                  <td>
                    <input value={row.weight} inputMode="decimal" disabled={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patch(row, "weight", e.target.value)}
                           aria-label={`Line ${i + 1} ship-now weight`}
                           className="w-20 rounded border px-1 py-0.5 disabled:bg-slate-50" />
                  </td>
                  <td className="text-center">
                    <input type="checkbox" checked={row.lineComplete === "true"} disabled={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patch(row, "lineComplete", e.target.checked ? "true" : "false")}
                           aria-label={`Line ${i + 1} complete`} />
                  </td>
                  <td className="text-right">
                    <button onClick={() => remove(row)} disabled={!editGate.allowed} title={editGate.title}
                            className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!editGate.allowed || candidates.length === 0}
                title={editGate.title} aria-label="Add line" className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
          <option value="">{candidates.length === 0 ? "Every order line is on this shipment" : "Add line…"}</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.partNumber} — ordered {c.qty}</option>)}
        </select>
        <button onClick={addPicked} disabled={!editGate.allowed || !pick} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add
        </button>
        <button onClick={addAllRemaining} disabled={!editGate.allowed || candidates.length === 0} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add all remaining
        </button>
        <button onClick={() => void save()} disabled={!editGate.allowed || !grid.dirty} title={editGate.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Save lines
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Containers grid — which of the order's container rows went, and how many (spec §4.2 "which of
// the order's container rows went and how many").
// -------------------------------------------------------------------------------------------

type ContainerFields = { orderContainerId: string; count: string };

function ContainersGrid({
  shipperId, shipperOrderId, containers, catalog, editGate, applyMutation, onError,
}: {
  shipperId: string; shipperOrderId: string; containers: ShipperOrder["containers"];
  catalog: OrderCatalog | undefined; editGate: Gate; applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<ContainerFields>();
  const rows = grid.compose(containers, (c) => ({ orderContainerId: c.orderContainerId, count: String(c.count) }));
  const usedIds = new Set(rows.map((r) => r.orderContainerId));
  const candidates = (catalog?.containers ?? []).filter((c) => !usedIds.has(c.id));
  const [pick, setPick] = useState("");

  const infoById = new Map<string, { typeName: string; customerContainerId: string }>();
  for (const c of containers) infoById.set(c.orderContainerId, { typeName: c.typeName, customerContainerId: c.customerContainerId });
  for (const c of catalog?.containers ?? []) {
    if (!infoById.has(c.id)) infoById.set(c.id, { typeName: c.typeName, customerContainerId: c.customerContainerId });
  }

  function patch(row: { key: string; isNew: boolean }, field: keyof ContainerFields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<ContainerFields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<ContainerFields>);
  }
  function remove(row: { key: string; isNew: boolean }) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }
  function addPicked() {
    const c = candidates.find((x) => x.id === pick);
    if (!c) return;
    grid.addRow({ orderContainerId: c.id, count: String(c.count) });
    setPick("");
  }
  function addAllRemaining() {
    if (candidates.length === 0) return;
    grid.addRows(candidates.map((c) => ({ orderContainerId: c.id, count: String(c.count) })));
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

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Containers</h4>
      {grid.orphanWarning && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{grid.orphanWarning}</p>}
      {rows.length === 0 ? (
        <p className="mb-2 text-sm text-slate-500">No containers on this shipment yet.</p>
      ) : (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Type</th>
              <th className="font-medium">Cust Cont Id</th>
              <th className="font-medium">Count</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const info = infoById.get(row.orderContainerId);
              return (
                <tr key={row.key} className="border-t">
                  <td className="py-1">{info?.typeName ?? row.orderContainerId}</td>
                  <td className="text-slate-600">{info?.customerContainerId || "—"}</td>
                  <td>
                    <input value={row.count} inputMode="numeric" disabled={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patch(row, "count", e.target.value)}
                           aria-label={`Container ${i + 1} count`}
                           className="w-20 rounded border px-1 py-0.5 disabled:bg-slate-50" />
                  </td>
                  <td className="text-right">
                    <button onClick={() => remove(row)} disabled={!editGate.allowed} title={editGate.title}
                            className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!editGate.allowed || candidates.length === 0}
                title={editGate.title} aria-label="Add container" className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
          <option value="">{candidates.length === 0 ? "Every order container is on this shipment" : "Add container…"}</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.typeName} — {c.count} on the order</option>)}
        </select>
        <button onClick={addPicked} disabled={!editGate.allowed || !pick} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add
        </button>
        <button onClick={addAllRemaining} disabled={!editGate.allowed || candidates.length === 0} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add all remaining
        </button>
        <button onClick={() => void save()} disabled={!editGate.allowed || !grid.dirty} title={editGate.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Save containers
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Serials grid — which of the order's serials went, with a per-row print-on-shipper flag (spec
// §4.2).
// -------------------------------------------------------------------------------------------

type SerialFields = { orderSerialId: string; printOnShipper: string };

function SerialsGrid({
  shipperId, shipperOrderId, serials, catalog, editGate, applyMutation, onError,
}: {
  shipperId: string; shipperOrderId: string; serials: ShipperOrder["serials"];
  catalog: OrderCatalog | undefined; editGate: Gate; applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<SerialFields>();
  const rows = grid.compose(serials, (s) => ({ orderSerialId: s.orderSerialId, printOnShipper: s.printOnShipper ? "true" : "false" }));
  const usedIds = new Set(rows.map((r) => r.orderSerialId));
  const candidates = (catalog?.serials ?? []).filter((s) => !usedIds.has(s.id));
  const [pick, setPick] = useState("");

  const infoById = new Map<string, { serial: string; description: string }>();
  for (const s of serials) infoById.set(s.orderSerialId, { serial: s.serial, description: s.description });
  for (const s of catalog?.serials ?? []) if (!infoById.has(s.id)) infoById.set(s.id, { serial: s.serial, description: s.description });

  function patch(row: { key: string; isNew: boolean }, field: keyof SerialFields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<SerialFields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<SerialFields>);
  }
  function remove(row: { key: string; isNew: boolean }) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }
  function addPicked() {
    const s = candidates.find((x) => x.id === pick);
    if (!s) return;
    grid.addRow({ orderSerialId: s.id, printOnShipper: "true" });
    setPick("");
  }
  function addAllRemaining() {
    if (candidates.length === 0) return;
    grid.addRows(candidates.map((s) => ({ orderSerialId: s.id, printOnShipper: "true" })));
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

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Serials</h4>
      {grid.orphanWarning && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{grid.orphanWarning}</p>}
      {rows.length === 0 ? (
        <p className="mb-2 text-sm text-slate-500">No serials on this shipment yet.</p>
      ) : (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Serial</th>
              <th className="font-medium">Description</th>
              <th className="font-medium">Print on ticket</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const info = infoById.get(row.orderSerialId);
              return (
                <tr key={row.key} className="border-t">
                  <td className="py-1 font-mono">{info?.serial ?? row.orderSerialId}</td>
                  <td className="text-slate-600">{info?.description || "—"}</td>
                  <td className="text-center">
                    <input type="checkbox" checked={row.printOnShipper === "true"} disabled={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patch(row, "printOnShipper", e.target.checked ? "true" : "false")}
                           aria-label={`Serial ${i + 1} print on ticket`} />
                  </td>
                  <td className="text-right">
                    <button onClick={() => remove(row)} disabled={!editGate.allowed} title={editGate.title}
                            className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!editGate.allowed || candidates.length === 0}
                title={editGate.title} aria-label="Add serial" className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
          <option value="">{candidates.length === 0 ? "Every order serial is on this shipment" : "Add serial…"}</option>
          {candidates.map((s) => <option key={s.id} value={s.id}>{s.serial}</option>)}
        </select>
        <button onClick={addPicked} disabled={!editGate.allowed || !pick} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add
        </button>
        <button onClick={addAllRemaining} disabled={!editGate.allowed || candidates.length === 0} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add all remaining
        </button>
        <button onClick={() => void save()} disabled={!editGate.allowed || !grid.dirty} title={editGate.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Save serials
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// The panel itself.
// -------------------------------------------------------------------------------------------

const PRINT_TOOLTIP = "Available once the shipping ticket and certification layouts land (Tasks 18–19)";

export function ShipmentOrderPanel({
  shipperId, order, catalog, editGate, applyMutation, onError, onRemove,
}: {
  shipperId: string; order: ShipperOrder; catalog: OrderCatalog | undefined;
  editGate: Gate; applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
  onRemove: () => void;
}) {
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

      <LinesGrid shipperId={shipperId} shipperOrderId={order.id} lines={order.lines} catalog={catalog}
                 editGate={editGate} applyMutation={applyMutation} onError={onError} />
      <div className="my-4 border-t" />
      <ContainersGrid shipperId={shipperId} shipperOrderId={order.id} containers={order.containers} catalog={catalog}
                       editGate={editGate} applyMutation={applyMutation} onError={onError} />
      <div className="my-4 border-t" />
      <SerialsGrid shipperId={shipperId} shipperOrderId={order.id} serials={order.serials} catalog={catalog}
                    editGate={editGate} applyMutation={applyMutation} onError={onError} />

      {/* Print (spec §11) — the routes don't land until Tasks 18–19 (task-14-brief.md); disabled
          with a tooltip naming why, never wired to a route that would 404. */}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
        <button type="button" disabled title={PRINT_TOOLTIP}
                className="cursor-not-allowed rounded border px-3 py-1.5 text-slate-400">
          Print this order&apos;s ticket
        </button>
        <label className="flex items-center gap-1 text-slate-400" title={PRINT_TOOLTIP}>
          <input type="checkbox" checked readOnly disabled /> Also print certification
        </label>
      </div>
    </section>
  );
}
