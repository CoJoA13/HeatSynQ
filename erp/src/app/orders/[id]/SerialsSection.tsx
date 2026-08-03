"use client";
import { useState } from "react";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import { expandSerialRange } from "@/lib/serial-range";
import { findDuplicateSerials } from "../new/OrderLineCard";
import type { OrderLine, OrderMutationResult, OrderSerial, PartOption } from "./page";

type Fields = { serial: string; description: string };

function lineLabel(line: OrderLine): string {
  return line.position === 1 ? "Lead" : `Line ${line.position}`;
}

/**
 * One line's serial grid — bulk-PUTs `replaceSerials`' whole per-line array (Task 5, spec §5a).
 * A separate component (not a loop of plain JSX inside SerialsSection) because each line needs
 * its OWN `useBulkGrid` instance — one per mounted instance, the standard "list of components"
 * shape, not a hook called conditionally inside a `.map()`.
 *
 * The serialization-required-but-empty warning is the live, LOCAL row count (`rows.length`), not
 * the server's last-saved `serials` prop — so typing a range in and seeing the warning clear
 * happens before the user even clicks Save, matching the entry page's identical live warning
 * (OrderLineCard.tsx) and the "the serialization warning heritage" carried onto this page
 * (task-14-brief.md).
 */
function LineSerialsEditor({
  orderId, line, serials, requiresSerials, editGate, applyMutation, onError,
}: {
  orderId: string;
  line: OrderLine;
  serials: OrderSerial[];
  requiresSerials: boolean;
  editGate: Gate;
  applyMutation: (res: OrderMutationResult) => void;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<Fields>();
  const rows = grid.compose(serials, (s) => ({ serial: s.serial, description: s.description }));
  const [rangeInput, setRangeInput] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);

  const dupes = findDuplicateSerials(rows.map((r) => ({ id: r.key, serial: r.serial, description: r.description })));

  function patch(row: { key: string; isNew: boolean }, field: keyof Fields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<Fields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<Fields>);
  }
  function remove(row: { key: string; isNew: boolean }) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }
  function addRange() {
    if (!rangeInput.trim()) return;
    try {
      const expanded = expandSerialRange(rangeInput);
      for (const serial of expanded) grid.addRow({ serial, description: "" });
      setRangeInput("");
      setRangeError(null);
    } catch (e) {
      // expandSerialRange throws a plain Error with a message already fit to show the user.
      setRangeError((e as Error).message);
    }
  }

  async function save() {
    if (dupes.size > 0) { onError(`${lineLabel(line)}: duplicate serial "${[...dupes][0]}".`); return; }
    const payload: { serial: string; description: string }[] = [];
    for (const [i, row] of rows.entries()) {
      const serial = row.serial.trim();
      if (!serial) { onError(`${lineLabel(line)}: serial ${i + 1} cannot be blank.`); return; }
      payload.push({ serial, description: row.description });
    }
    try {
      const res = await api<OrderMutationResult>(`/api/orders/${orderId}/lines/${line.id}/serials`, {
        method: "PUT", body: JSON.stringify(payload),
      });
      applyMutation(res);
      grid.reset();
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="mb-4 rounded border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">
          {lineLabel(line)} — <span className="font-mono">{line.part.customer.code} · {line.part.partNumber}</span>
        </span>
        {requiresSerials && rows.length === 0 && (
          <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
            Serialization required — no serials entered yet
          </span>
        )}
      </div>
      <label className="mb-2 block text-sm">
        Add serial(s)
        <input value={rangeInput} disabled={!editGate.allowed} title={editGate.title}
               onChange={(e) => setRangeInput(e.target.value)} onBlur={addRange}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRange(); } }}
               placeholder="EC001 or EC{001-025}" aria-label={`${lineLabel(line)} add serial`}
               className="mt-1 w-full rounded border px-2 py-1 font-mono text-sm disabled:bg-slate-50" />
      </label>
      {rangeError && <p className="mb-2 text-xs text-red-700">{rangeError}</p>}
      {rows.length === 0 ? (
        <p className="mb-2 text-sm text-slate-500">No serials on this line.</p>
      ) : (
        <div className="mb-2 space-y-1">
          {rows.map((row, i) => (
            <div key={row.key}
                 className={`flex items-center gap-2 rounded border p-1 text-sm ${dupes.has(row.serial) ? "border-red-400 bg-red-50" : ""}`}>
              <input value={row.serial} disabled={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patch(row, "serial", e.target.value)}
                     aria-label={`${lineLabel(line)} serial ${i + 1}`}
                     className="w-32 rounded border px-1 py-0.5 font-mono text-xs disabled:bg-slate-50" />
              <input value={row.description} placeholder="Description" disabled={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patch(row, "description", e.target.value)}
                     aria-label={`${lineLabel(line)} serial ${i + 1} description`}
                     className="flex-1 rounded border px-1 py-0.5 text-xs disabled:bg-slate-50" />
              <button onClick={() => remove(row)} disabled={!editGate.allowed} title={editGate.title}
                      aria-label={`Remove serial ${row.serial}`}
                      className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {dupes.size > 0 && (
        <p className="mb-2 rounded bg-red-50 p-1.5 text-xs text-red-700">
          Duplicate serial{dupes.size > 1 ? "s" : ""}: {[...dupes].join(", ")}
        </p>
      )}
      <button onClick={() => void save()} disabled={!editGate.allowed || !grid.dirty} title={editGate.title}
              className="rounded bg-slate-800 px-3 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-slate-400">
        Save serials
      </button>
    </div>
  );
}

/** One sub-grid per order line (lead and every rider alike — serialization is a per-part-number
 *  concern, spec §3.1: "billing and certs stay per part number"). `partsById` supplies the
 *  serialization-required flag `OrderLineDetail.part` itself doesn't carry (task-14-brief.md). */
export function SerialsSection({
  orderId, lines, serials, partsById, editGate, applyMutation, onError,
}: {
  orderId: string;
  lines: OrderLine[];
  serials: OrderSerial[];
  partsById: Map<string, PartOption>;
  editGate: Gate;
  applyMutation: (res: OrderMutationResult) => void;
  onError: (message: string | null) => void;
}) {
  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Serials</h2>
      {lines.map((line) => (
        <LineSerialsEditor
          key={line.id} orderId={orderId} line={line}
          serials={serials.filter((s) => s.lineId === line.id)}
          requiresSerials={partsById.get(line.partId)?.serializationRequired ?? false}
          editGate={editGate} applyMutation={applyMutation} onError={onError}
        />
      ))}
    </section>
  );
}
