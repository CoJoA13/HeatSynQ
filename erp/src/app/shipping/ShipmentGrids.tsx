"use client";
// The three shipment grids — lines, containers, serials — as PRESENTATIONAL views, extracted from
// ShipmentOrderPanel.tsx (Task 14) when Task 14b's create page (`/shipping/new`) became their
// second consumer. This file is the whole sibling group's single copy: the EDIT page
// ([id]/ShipmentOrderPanel.tsx) composes each view with `useBulkGrid` over the shipment's saved
// rows plus a per-grid Save button in the `footer` slot; the CREATE page (new/NewShipment.tsx)
// composes it with parent-owned local rows (everything `isNew`, nothing saved until the one atomic
// POST) and no footer. The sibling-split rule (CLAUDE.md, task-14-brief.md: "any fix to one grid
// lands on all copies in the same commit") is thereby honored by construction for the MARKUP and
// the prefill arithmetic — a fix here IS both pages' fix. What stays per-page is only persistence:
// where the rows live and what Save means.
//
// Each view owns its add-picker's transient `pick` state and the candidate PREFILL (design §5.1
// `ordered − shipped` for lines; see the per-grid notes below for why containers and serials have
// no ledger arithmetic), and reports every user action upward through three callbacks:
// `onPatch(row, field, value)`, `onRemove(row)`, `onAddRows(fields[])` — batch-shaped for the same
// reason `useBulkGrid.addRows` is (fix-wave R4 finding 7: "Add all remaining" appends the whole
// batch in ONE state update).
import { useState, type ReactNode } from "react";
import type { Gate } from "@/lib/permission-ui";
import { shipRemainder } from "@/lib/ship-remainder";

/** How a view names a row back to its owner: the owner's own key (a server row id on the edit
 *  page's existing rows, a client-generated id everywhere else) plus which kind it is — exactly
 *  the discriminator `useBulkGrid`'s `updateExisting`/`updateAdded` split needs. */
export type GridRowHandle = { key: string; isNew: boolean };

// -------------------------------------------------------------------------------------------
// Lines grid — ordered / shipped-to-date / ship-now qty and lbs / ship-line-complete, prefilled
// to the remainder (task-14-brief.md Step 2, design §5.1).
// -------------------------------------------------------------------------------------------

export type LineFields = { orderLineId: string; qty: string; weight: string; lineComplete: string };
export type LineRow = GridRowHandle & LineFields;
export type LineInfo = { partNumber: string; partName: string; orderedQty: number; orderedWeight: number };
export type ShippedInfo = { qty: number; weight: number };
export type LineCandidate = { id: string; partNumber: string; qty: number; weight: number };

/** Prefilled to the remainder (design §5.1 `ordered − shipped`): a candidate partly shipped on an
 *  EARLIER shipment defaults to what is left, not to the full ordered figure — which used to hand
 *  the operator an over-shipping default they only found out about from the §5.7 warning AFTER
 *  saving (efde514). A default, never a cap: the field stays editable and the server still
 *  accepts (and warns about) more, since over-shipping warns and never blocks. */
export function prefillLineRow(
  c: { id: string; qty: number; weight: number }, shipped: ShippedInfo | undefined,
): LineFields {
  const s = shipped ?? { qty: 0, weight: 0 };
  return {
    orderLineId: c.id,
    qty: String(shipRemainder(c.qty, s.qty)),
    weight: String(shipRemainder(c.weight, s.weight)),
    lineComplete: "false",
  };
}

export function LinesGridView({
  rows, candidates, infoByLineId, shippedByLineId, gate, orphanWarning, onPatch, onRemove, onAddRows, footer,
}: {
  rows: LineRow[];
  /** The order's catalog lines NOT already in `rows` — what the add picker offers. */
  candidates: LineCandidate[];
  infoByLineId: Map<string, LineInfo>;
  shippedByLineId: Map<string, ShippedInfo>;
  gate: Gate;
  orphanWarning?: string | null;
  onPatch: (row: GridRowHandle, field: keyof LineFields, value: string) => void;
  onRemove: (row: GridRowHandle) => void;
  onAddRows: (rows: LineFields[]) => void;
  footer?: ReactNode;
}) {
  const [pick, setPick] = useState("");

  function addPicked() {
    const c = candidates.find((x) => x.id === pick);
    if (!c) return;
    onAddRows([prefillLineRow(c, shippedByLineId.get(c.id))]);
    setPick("");
  }
  function addAllRemaining() {
    if (candidates.length === 0) return;
    onAddRows(candidates.map((c) => prefillLineRow(c, shippedByLineId.get(c.id))));
  }

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Lines</h4>
      {orphanWarning && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{orphanWarning}</p>}
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
                  {/* A real number for a not-yet-saved row too, so the operator can see what the
                      prefilled ship-now figure was derived from and correct it against. */}
                  <td>{shipped ? `${shipped.qty} / ${shipped.weight} lbs` : "—"}</td>
                  <td>
                    <input value={row.qty} inputMode="numeric" disabled={!gate.allowed} title={gate.title}
                           onChange={(e) => onPatch(row, "qty", e.target.value)}
                           aria-label={`Line ${i + 1} ship-now quantity`}
                           className="w-20 rounded border px-1 py-0.5 disabled:bg-slate-50" />
                  </td>
                  <td>
                    <input value={row.weight} inputMode="decimal" disabled={!gate.allowed} title={gate.title}
                           onChange={(e) => onPatch(row, "weight", e.target.value)}
                           aria-label={`Line ${i + 1} ship-now weight`}
                           className="w-20 rounded border px-1 py-0.5 disabled:bg-slate-50" />
                  </td>
                  <td className="text-center">
                    <input type="checkbox" checked={row.lineComplete === "true"} disabled={!gate.allowed} title={gate.title}
                           onChange={(e) => onPatch(row, "lineComplete", e.target.checked ? "true" : "false")}
                           aria-label={`Line ${i + 1} complete`} />
                  </td>
                  <td className="text-right">
                    <button onClick={() => onRemove(row)} disabled={!gate.allowed} title={gate.title}
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
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!gate.allowed || candidates.length === 0}
                title={gate.title} aria-label="Add line" className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
          <option value="">{candidates.length === 0 ? "Every order line is on this shipment" : "Add line…"}</option>
          {/* "remaining" names the figure the row will actually be prefilled with, so the choice
              is made against it rather than discovered after the row lands in the grid. */}
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.partNumber} — ordered {c.qty}, remaining {shipRemainder(c.qty, shippedByLineId.get(c.id)?.qty ?? 0)}
            </option>
          ))}
        </select>
        <button onClick={addPicked} disabled={!gate.allowed || !pick} title={gate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add
        </button>
        <button onClick={addAllRemaining} disabled={!gate.allowed || candidates.length === 0} title={gate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add all remaining
        </button>
        {footer}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Containers grid — which of the order's container rows went, and how many (spec §4.2 "which of
// the order's container rows went and how many").
//
// SIBLING-SPLIT NOTE (task-14-brief.md, Task 14 review Important #1): the lines grid's "prefill to
// the remainder" fix does NOT land here, and the reason is structural rather than an oversight.
// The ship ledger is defined per ORDER LINE and nothing else (design §5.1, ship-ledger.ts:
// `shippedTotals(db, orderLineIds)`); `ShipperContainer` carries a `count` of bins that travelled
// on this shipment with no ledger, no aggregate, and no "containers shipped to date" anywhere in
// the schema or the spec, so `ordered − shipped` has no second operand to compute. The candidate
// prefill here stays the order container's own `count` — which IS its whole remainder, since a
// container row is not consumed across shipments the way a line's quantity is.
// -------------------------------------------------------------------------------------------

export type ContainerFields = { orderContainerId: string; count: string };
export type ContainerRow = GridRowHandle & ContainerFields;
export type ContainerInfo = { typeName: string; customerContainerId: string };
export type ContainerCandidate = { id: string; typeName: string; customerContainerId: string; count: number };

export function prefillContainerRow(c: { id: string; count: number }): ContainerFields {
  return { orderContainerId: c.id, count: String(c.count) };
}

export function ContainersGridView({
  rows, candidates, infoById, gate, orphanWarning, onPatch, onRemove, onAddRows, footer,
}: {
  rows: ContainerRow[];
  candidates: ContainerCandidate[];
  infoById: Map<string, ContainerInfo>;
  gate: Gate;
  orphanWarning?: string | null;
  onPatch: (row: GridRowHandle, field: keyof ContainerFields, value: string) => void;
  onRemove: (row: GridRowHandle) => void;
  onAddRows: (rows: ContainerFields[]) => void;
  footer?: ReactNode;
}) {
  const [pick, setPick] = useState("");

  function addPicked() {
    const c = candidates.find((x) => x.id === pick);
    if (!c) return;
    onAddRows([prefillContainerRow(c)]);
    setPick("");
  }
  function addAllRemaining() {
    if (candidates.length === 0) return;
    onAddRows(candidates.map(prefillContainerRow));
  }

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Containers</h4>
      {orphanWarning && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{orphanWarning}</p>}
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
                    <input value={row.count} inputMode="numeric" disabled={!gate.allowed} title={gate.title}
                           onChange={(e) => onPatch(row, "count", e.target.value)}
                           aria-label={`Container ${i + 1} count`}
                           className="w-20 rounded border px-1 py-0.5 disabled:bg-slate-50" />
                  </td>
                  <td className="text-right">
                    <button onClick={() => onRemove(row)} disabled={!gate.allowed} title={gate.title}
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
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!gate.allowed || candidates.length === 0}
                title={gate.title} aria-label="Add container" className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
          <option value="">{candidates.length === 0 ? "Every order container is on this shipment" : "Add container…"}</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.typeName} — {c.count} on the order</option>)}
        </select>
        <button onClick={addPicked} disabled={!gate.allowed || !pick} title={gate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add
        </button>
        <button onClick={addAllRemaining} disabled={!gate.allowed || candidates.length === 0} title={gate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add all remaining
        </button>
        {footer}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Serials grid — which of the order's serials went, with a per-row print-on-shipper flag (spec
// §4.2).
//
// SIBLING-SPLIT NOTE: the "prefill to the remainder" fix does not land here either, and even less
// ambiguously than for containers — a serial has no quantity at all. Its only prefilled field is
// the boolean `printOnShipper` (defaulted true), so there is no arithmetic to make remainder-aware.
// A serial already in `rows` is excluded from the picker by the caller's own candidates filter,
// which is the whole of "remainder" for a set-membership row.
// -------------------------------------------------------------------------------------------

export type SerialFields = { orderSerialId: string; printOnShipper: string };
export type SerialRow = GridRowHandle & SerialFields;
export type SerialInfo = { serial: string; description: string };
export type SerialCandidate = { id: string; serial: string };

export function prefillSerialRow(s: { id: string }): SerialFields {
  return { orderSerialId: s.id, printOnShipper: "true" };
}

export function SerialsGridView({
  rows, candidates, infoById, gate, orphanWarning, onPatch, onRemove, onAddRows, footer,
}: {
  rows: SerialRow[];
  candidates: SerialCandidate[];
  infoById: Map<string, SerialInfo>;
  gate: Gate;
  orphanWarning?: string | null;
  onPatch: (row: GridRowHandle, field: keyof SerialFields, value: string) => void;
  onRemove: (row: GridRowHandle) => void;
  onAddRows: (rows: SerialFields[]) => void;
  footer?: ReactNode;
}) {
  const [pick, setPick] = useState("");

  function addPicked() {
    const s = candidates.find((x) => x.id === pick);
    if (!s) return;
    onAddRows([prefillSerialRow(s)]);
    setPick("");
  }
  function addAllRemaining() {
    if (candidates.length === 0) return;
    onAddRows(candidates.map(prefillSerialRow));
  }

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Serials</h4>
      {orphanWarning && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{orphanWarning}</p>}
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
                    <input type="checkbox" checked={row.printOnShipper === "true"} disabled={!gate.allowed} title={gate.title}
                           onChange={(e) => onPatch(row, "printOnShipper", e.target.checked ? "true" : "false")}
                           aria-label={`Serial ${i + 1} print on ticket`} />
                  </td>
                  <td className="text-right">
                    <button onClick={() => onRemove(row)} disabled={!gate.allowed} title={gate.title}
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
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!gate.allowed || candidates.length === 0}
                title={gate.title} aria-label="Add serial" className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
          <option value="">{candidates.length === 0 ? "Every order serial is on this shipment" : "Add serial…"}</option>
          {candidates.map((s) => <option key={s.id} value={s.id}>{s.serial}</option>)}
        </select>
        <button onClick={addPicked} disabled={!gate.allowed || !pick} title={gate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add
        </button>
        <button onClick={addAllRemaining} disabled={!gate.allowed || candidates.length === 0} title={gate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add all remaining
        </button>
        {footer}
      </div>
    </div>
  );
}
