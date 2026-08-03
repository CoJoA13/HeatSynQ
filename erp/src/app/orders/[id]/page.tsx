"use client";
// The order hub (design spec §11) — the one-page home of a work order. Reached from the board
// row click or the Shell's global search (never its own nav entry — Shell.tsx needs no change).
//
// THE BINDING STATE MODEL, same rule the order entry page's own top comment states (the 2C-3
// lesson): every mutating action here either (a) optimistically patches `order` for a plain
// scalar field and rolls back to server truth on failure — the customers/[id]/page.tsx `save()`
// precedent, used below for Overview's fields and Notes — or (b) never touches `order` before the
// request settles at all, applying the server's own fresh response on success and reporting
// failure otherwise (the customers/[id]/page.tsx `call()` precedent), used for void/link/unlink
// and delegated to every section below for its own add/remove/bulk-PUT actions. The bulk grids
// (Containers/Serials/Charges/Loads) additionally keep only EDITED cells/rows locally
// (src/lib/bulk-grid.ts) rather than a full mutable copy of the server array, for the same reason
// ProcessStepsSection's step editor does — see that file's own top comment.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { ORDER_STATUS_LABELS, type OrderStatusValue } from "@/lib/order-constants";
import { LIGHT_DOT_CLASS, LIGHT_LABELS, type TrafficLight } from "@/lib/traffic-light";
import { HistoryPanel } from "@/components/HistoryPanel";
import { AttachmentsSection } from "@/components/AttachmentsSection";
import { LinesSection } from "./LinesSection";
import { ProcessSection } from "./ProcessSection";
import { ContainersSection } from "./ContainersSection";
import { SerialsSection } from "./SerialsSection";
import { ChargesSection } from "./ChargesSection";
import { LoadsSection } from "./LoadsSection";
import { DocumentsSection } from "./DocumentsSection";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/orders.ts's exported row shapes — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md "Constraints that will bite you"; the parts/[id]/page.tsx
// `Part` type precedent). Exported so the colocated section components import the ones they
// need — the orders/new/page.tsx precedent.
// ---------------------------------------------------------------------------------------------

export type OrderLine = {
  id: string; position: number; partId: string; revisionNumber: number | null;
  qty: number; weight: number;
  part: { id: string; partNumber: string; name: string; customer: { code: string } };
};
export type OrderContainer = {
  id: string; position: number; typeId: string; count: number; qty: number | null;
  tareWeight: number | null; grossWeight: number | null; type: { name: string };
};
export type OrderSerial = { id: string; lineId: string; position: number; serial: string; description: string };
export type OrderLoad = { id: string; loadNumber: number; qty: number | null; weight: number | null };
export type OrderCharge = { id: string; position: number; description: string; amount: number | null };

export type OrderDetail = {
  id: string; orderNumber: number; customerId: string;
  poNumber: string; vsOrderNumber: string;
  receivedDate: string; requestDate: string; targetDate: string | null;
  status: OrderStatusValue; notes: string; linkGroupId: string | null;
  voided: boolean;
  light: TrafficLight;
  travelerPrinted: boolean;
  lines: OrderLine[];
  containers: OrderContainer[];
  serials: OrderSerial[];
  loads: OrderLoad[];
  charges: OrderCharge[];
  linkedOrders: { id: string; orderNumber: number }[];
};

/** Every mutation route on this order returns EITHER the bare fresh `OrderDetail` (removeLine,
 *  replaceContainers/Serials/Charges, linkOrder, unlinkOrder) or `{ order, warnings }` (updateOrder,
 *  addLine, updateLine, replaceLoads, resplitLoads) — verified route by route against
 *  src/app/api/orders/**\/route.ts. `unwrapMutation` below is the one place that distinction is
 *  resolved, so nothing downstream needs to know which shape a given endpoint happens to use. */
export type OrderMutationResult = OrderDetail | { order: OrderDetail; warnings: string[] };

/** `GET /api/parts`'s `PartRow` (src/server/parts.ts), narrowed to what this page's rider picker
 *  and per-line serialization warning need. `hasProcessSteps` is irrelevant for riders (spec §11
 *  — only the LEAD locks a revision) but carried anyway since the fetch already returns it and
 *  `computeLineWeight` (imported from the entry page's OrderLineCard by LinesSection) is typed
 *  against a structurally-identical `PartOption` that includes it. */
export type PartOption = {
  id: string; customerId: string; partNumber: string; name: string;
  eachWeight: number; serializationRequired: boolean; hasProcessSteps: boolean; active: boolean;
};

export type ContainerTypeOption = { id: string; name: string };

/** Slice of `getCustomer`'s row (src/server/customers.ts) this page actually reads. */
type Customer = { id: string; code: string; name: string; orderNotes: string };

type AuditEntry = { id: string; action: string; reason: string | null };

function unwrapMutation(res: OrderMutationResult): { order: OrderDetail; warnings: string[] } {
  if (res && typeof res === "object" && "order" in res) {
    return res as { order: OrderDetail; warnings: string[] };
  }
  return { order: res as OrderDetail, warnings: [] };
}

/** A voided order is read-only everywhere (spec §5c) regardless of what the permission grid would
 *  otherwise allow — this is the one place that override is applied, so every section downstream
 *  just consumes the resulting `Gate` exactly like any other permission gate. */
function voidLocked(g: Gate, voided: boolean): Gate {
  return voided ? { allowed: false, disabled: true, title: "Order is voided" } : g;
}

/** `useSearchParams` suspends during prerender, and Next refuses to build a page that reads it
 *  outside a Suspense boundary — hence this thin wrapper around the real route component. */
export default function OrderHubPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <OrderHubRoute />
    </Suspense>
  );
}

function OrderHubRoute() {
  const { id } = useParams<{ id: string }>();
  // `?print=1` is how order entry's "Save & Print" asks the hub to print once on arrival — read
  // here, above the keyed body, so it travels with the same id the body remounts on.
  const autoPrint = useSearchParams().get("print") === "1";
  // Next reuses this route's component instance across /orders/A -> /orders/B (only the param
  // changes, no remount). Keying the body by id forces a fresh instance per order, so no state
  // below (bulk-grid overlays included) can carry one order's unsaved edits onto another order's
  // id (handoff §5.12 — cost a Critical in 2B).
  return <OrderHub key={id} id={id} autoPrint={autoPrint} />;
}

function OrderHub({ id, autoPrint }: { id: string; autoPrint: boolean }) {
  const { permissions: perms, error: permsError } = usePermissions();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Supplementary fetches (customer name/notes, the rider-parts list, container types, the void
  // reason) each get their OWN banner rather than the shared `error` a later mutation clears —
  // the customers/[id]/page.tsx `optionsError`/parts/[id]/page.tsx `loadError` precedent: a save
  // elsewhere on the page must not be able to silently erase the report that one of these failed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const addLoadError = useCallback((message: string) => {
    setLoadError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [parts, setParts] = useState<PartOption[]>([]);
  const [containerTypes, setContainerTypes] = useState<ContainerTypeOption[]>([]);
  // undefined = fetched but no reason could be resolved (missing admin.view, the fetch failed, or
  // the latest entry wasn't a delete) — the brief's fallback copy is used for `undefined`, never
  // for a genuine empty-string reason. null = not applicable (order isn't voided).
  const [voidReason, setVoidReason] = useState<string | null | undefined>(null);

  const load = useCallback(async () => {
    const o = await api<OrderDetail>(`/api/orders/${id}`);
    setOrder(o);
    return o;
  }, [id]);
  useEffect(() => {
    load().then(() => setError(null)).catch((e) => setError((e as Error).message));
  }, [load]);

  /** Applies whichever shape a mutation response actually is — the one place every action on this
   *  page (Overview/Notes/Lines/Containers/Serials/Charges/Loads/Link/Unlink) reports its result.
   *  An endpoint with no `warnings` key (removeLine, the three bulk replaces, link/unlink) clears
   *  the banner rather than leaving a PREVIOUS mutation's warnings displayed against data they no
   *  longer describe — there is no server signal after one of these to say whether the old
   *  warning still applies, and showing a stale claim is worse than showing none. */
  const applyMutation = useCallback((res: OrderMutationResult) => {
    const { order: fresh, warnings: w } = unwrapMutation(res);
    setOrder(fresh);
    setWarnings(w);
  }, []);

  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");
  const processesGate = gate(perms, "processes.view");
  const auditGate = gate(perms, "admin.view");
  const editGate = voidLocked(gate(perms, "orders.edit"), order?.voided ?? false);
  const voidGate = order?.voided
    ? { allowed: false, disabled: true, title: "Already voided" }
    : gateDo(perms, "void_order");
  // AttachmentsSection takes a plain boolean, not a Gate — task-14-brief.md's exact formula.
  const attachmentsCanEdit = gate(perms, "orders.edit").allowed && !(order?.voided ?? false);

  const customerId = order?.customerId;

  // Customer name/standing-notes (Overview + Notes sections). Attempted only once the caller is
  // known to hold customers.view — the entry page's own precedent (`if (!customersGate.allowed)
  // return;`) — rather than firing a call guaranteed to 403; refires once permissions resolve.
  useEffect(() => {
    if (!customerId || !customersGate.allowed) return;
    api<Customer>(`/api/customers/${customerId}`).then(setCustomer)
      .catch((e) => addLoadError(`Could not load the customer: ${(e as Error).message}`));
  }, [customerId, customersGate.allowed, addLoadError]);

  // The customer's full part catalog (active AND inactive — includeInactive=1), filtered
  // client-side the way the entry page's own customerParts is (GET /api/parts has no customerId
  // filter — verified against src/app/api/parts/route.ts). Serves two purposes: the rider-add
  // picker (LinesSection, active parts only — an inactive part cannot be added, per
  // resolveLineParts) and the per-line "serialization required, no serials" warning
  // (SerialsSection, which deliberately also needs an already-inactive part's flag, since an
  // existing line can reference one).
  useEffect(() => {
    if (!customerId || !partsGate.allowed) return;
    api<PartOption[]>("/api/parts?includeInactive=1")
      .then((rows) => setParts(rows.filter((p) => p.customerId === customerId)))
      .catch((e) => addLoadError(`Could not load parts: ${(e as Error).message}`));
  }, [customerId, partsGate.allowed, addLoadError]);

  // Session-only pick-list (no permission beyond signed-in) — the entry page's own precedent.
  useEffect(() => {
    api<ContainerTypeOption[]>("/api/picklists/containerType").then(setContainerTypes)
      .catch((e) => addLoadError(`Could not load container types: ${(e as Error).message}`));
  }, [addLoadError]);

  const voided = order?.voided ?? false;

  // The voided banner's reason (task-14-brief.md: "fetch the void reason from the latest audit
  // entry via the existing audit read API ... if only HistoryPanel surfaces it, the banner says
  // 'Voided — see History for the reason' and that's acceptable"). `/api/admin/audit` is gated
  // admin.view (HistoryPanel.tsx's own comment), so a caller without it — plausible; orders.view
  // does not imply admin.view — gets the fallback copy rather than a guaranteed 403. Safe to key
  // on `voided` alone: once voided, no mutator can touch the order again (every one of them
  // requires deletedAt: null), so the delete entry, if readable at all, is always entries[0].
  useEffect(() => {
    if (!voided) { setVoidReason(null); return; }
    if (!auditGate.allowed) { setVoidReason(undefined); return; }
    api<AuditEntry[]>(`/api/admin/audit?entity=order&entityId=${id}`)
      .then((entries) => {
        const latest = entries[0];
        setVoidReason(latest?.action === "delete" ? (latest.reason ?? undefined) : undefined);
      })
      .catch(() => setVoidReason(undefined));
  }, [voided, auditGate.allowed, id]);

  const partsById = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts]);

  // ---- Overview + Notes: optimistic scalar PATCH (customers/[id]/page.tsx `save()` precedent) ----

  // Per-key request queue: without it, two overlapping PATCHes to the same field (an ordinary
  // double-blur) can commit out of order and leave the database holding the opposite of the last
  // thing the UI showed.
  const queue = useRef<Map<string, Promise<unknown>>>(new Map());
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queue.current.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queue.current.set(key, next.catch(() => {}));
    return next;
  }

  /** Overview's scalar fields + Notes' textarea share one PATCH surface (Task 5's `updateOrder`).
   *  Optimistic: the field shows the typed value immediately; a rejection rolls back to server
   *  truth FIRST and only then reports why (§5.13 — a reload after the error is set would clear
   *  it, since `load()` itself resets `error` to null on success). */
  async function saveOrder(
    patch: Partial<Pick<OrderDetail, "poNumber" | "vsOrderNumber" | "receivedDate" | "requestDate" | "targetDate" | "notes">>,
  ): Promise<boolean> {
    setOrder((cur) => (cur ? { ...cur, ...patch } : cur));
    const key = Object.keys(patch).sort().join(",");
    return serial(key, async () => {
      try {
        const res = await api<OrderMutationResult>(`/api/orders/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
        applyMutation(res);
        setError(null);
        return true;
      } catch (e) {
        await load().catch(() => {});
        setError((e as Error).message);
        return false;
      }
    });
  }

  // Blur-save guard (customers/[id]/page.tsx precedent): a text field that saved unconditionally
  // on blur would PATCH (and audit) every simple tab-through even when nothing changed.
  const focusedValue = useRef("");
  const noteFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    focusedValue.current = e.target.value;
  };
  function onBlurSave(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
    commit: (value: string) => void,
  ) {
    if (e.target.value === focusedValue.current) return;
    commit(e.target.value);
  }

  // ---- Void / Link / Unlink: non-optimistic (customers/[id]/page.tsx `call()` precedent) ----

  async function voidAction() {
    if (!order) return;
    const reason = prompt(
      `Void order #${order.orderNumber}?\n\n` +
      `Every control on this order becomes read-only. The order number is never reused and this ` +
      `cannot be undone through the UI.\n\n` +
      `Reason for voiding (recorded in the audit history):`,
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to void an order."); return; }
    // Two separate try/catches (the customers/[id]/page.tsx `call()` precedent), not one wrapping
    // both calls: DELETE returns { ok: true }, not a fresh OrderDetail, so picking up voided:true
    // needs a follow-up `load()` — and if THAT fails, the void itself still succeeded. Reporting
    // that as a generic failure would misrepresent an order that WAS voided as one that wasn't.
    try {
      await api(`/api/orders/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Order voided, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  const [linkInput, setLinkInput] = useState("");
  const [linking, setLinking] = useState(false);
  /** Link takes an order NUMBER, not an id (the brief's own contract) — resolved via
   *  `GET /api/orders?search=&customerId=` (the board's own query route, already required for
   *  `orders.view`), scoped to THIS order's customer, then matched to the exact number typed. The
   *  alternative considered was the global-search route (`/api/search`, which returns
   *  `exactOrderId` directly) — rejected because it does not accept a customer scope, so a second
   *  round trip (fetch that order, check its customerId) would still be needed; the board query
   *  does both in one call. */
  async function linkAction() {
    if (!order) return;
    const typed = linkInput.trim();
    if (!typed) return;
    setLinking(true);
    try {
      const rows = await api<{ id: string; orderNumber: number }[]>(
        `/api/orders?search=${encodeURIComponent(typed)}&customerId=${order.customerId}`,
      );
      const match = rows.find((r) => String(r.orderNumber) === typed && r.id !== order.id);
      if (!match) {
        setError(`No order #${typed} found for ${customer ? `${customer.code} · ${customer.name}` : "this customer"}.`);
        return;
      }
      const res = await api<OrderMutationResult>(
        `/api/orders/${id}/link`, { method: "POST", body: JSON.stringify({ otherId: match.id }) },
      );
      applyMutation(res);
      setLinkInput("");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinking(false);
    }
  }

  async function unlinkAction() {
    if (!confirm("Unlink this order from its group? Its linked siblings are unaffected.")) return;
    try {
      const res = await api<OrderMutationResult>(`/api/orders/${id}/unlink`, { method: "POST" });
      applyMutation(res);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!order) return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;

  const lead = order.lines[0] as OrderLine | undefined;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Order #{order.orderNumber}
          {customer && (
            <span className="ml-3 text-base font-normal text-slate-500">
              <Link href={`/customers/${order.customerId}`} className="text-blue-700 underline">
                {customer.code} · {customer.name}
              </Link>
            </span>
          )}
        </h1>
        <button onClick={voidAction} disabled={voidGate.disabled} title={voidGate.title}
                className="rounded border border-red-600 px-3 py-1.5 text-sm text-red-600 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
          Void order
        </button>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {voided && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm font-medium text-red-700">
          Voided — {voidReason ?? "see History for the reason"}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="mb-3 list-disc space-y-0.5 rounded bg-amber-50 p-2 pl-7 text-sm text-amber-800">
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {loadError && <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{loadError}</p>}

      {/* ---- Overview ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Overview</h2>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <label className="block">
            PO number
            <input value={order.poNumber} onFocus={noteFocus} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => setOrder({ ...order, poNumber: e.target.value })}
                   onBlur={(e) => onBlurSave(e, (poNumber) => void saveOrder({ poNumber }))}
                   className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="block">
            VS order #
            <input value={order.vsOrderNumber} onFocus={noteFocus} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => setOrder({ ...order, vsOrderNumber: e.target.value })}
                   onBlur={(e) => onBlurSave(e, (vsOrderNumber) => void saveOrder({ vsOrderNumber }))}
                   className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <div className="block">
            Status
            <div className="mt-1 flex items-center gap-1.5 rounded border bg-slate-50 px-2 py-1">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${LIGHT_DOT_CLASS[order.light]}`} />
              <span>{LIGHT_LABELS[order.light]}</span>
              <span className="text-slate-400">· {ORDER_STATUS_LABELS[order.status]}</span>
            </div>
          </div>
          <label className="block">
            Received date
            <input type="date" value={order.receivedDate} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void saveOrder({ receivedDate: e.target.value })}
                   className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <label className="block">
            Request date
            <input type="date" value={order.requestDate} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void saveOrder({ requestDate: e.target.value })}
                   className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <label className="block">
            Target date
            <input type="date" value={order.targetDate ?? ""} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void saveOrder({ targetDate: e.target.value || null })}
                   className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
        </div>

        <div className="mt-4 border-t pt-3">
          <h3 className="mb-1 text-sm font-medium">Linked orders</h3>
          {order.linkedOrders.length === 0 ? (
            <p className="text-sm text-slate-500">Not linked to any other orders.</p>
          ) : (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              {order.linkedOrders.map((o) => (
                <Link key={o.id} href={`/orders/${o.id}`} className="rounded bg-slate-100 px-2 py-0.5 text-blue-700 underline">
                  #{o.orderNumber}
                </Link>
              ))}
              <button onClick={unlinkAction} disabled={editGate.disabled} title={editGate.title}
                      className="text-xs text-red-600 underline disabled:cursor-not-allowed disabled:text-slate-400">
                Unlink
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input value={linkInput} onChange={(e) => setLinkInput(e.target.value)}
                   placeholder="Order #" disabled={editGate.disabled} title={editGate.title}
                   className="w-32 rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100" />
            <button onClick={() => void linkAction()} disabled={editGate.disabled || linking || !linkInput.trim()}
                    title={editGate.title}
                    className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
              {linking ? "Linking…" : "Link"}
            </button>
          </div>
        </div>
      </section>

      <LinesSection
        orderId={id} lines={order.lines} customerParts={parts} editGate={editGate} partsGate={partsGate}
        applyMutation={applyMutation} onError={setError}
      />

      {lead && (
        <ProcessSection leadPartId={lead.partId} revisionNumber={lead.revisionNumber} processesGate={processesGate} />
      )}

      <ContainersSection
        orderId={id} containers={order.containers} containerTypes={containerTypes} editGate={editGate}
        applyMutation={applyMutation} onError={setError}
      />

      <SerialsSection
        orderId={id} lines={order.lines} serials={order.serials} partsById={partsById} editGate={editGate}
        applyMutation={applyMutation} onError={setError}
      />

      <ChargesSection
        orderId={id} charges={order.charges} editGate={editGate} applyMutation={applyMutation} onError={setError}
      />

      <LoadsSection
        orderId={id} loads={order.loads} editGate={editGate} applyMutation={applyMutation} onError={setError}
      />

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Notes</h2>
        <label className="mb-3 block text-sm">
          Order notes
          <textarea value={order.notes} rows={3} onFocus={noteFocus} readOnly={!editGate.allowed} title={editGate.title}
                    onChange={(e) => setOrder({ ...order, notes: e.target.value })}
                    onBlur={(e) => onBlurSave(e, (notes) => void saveOrder({ notes }))}
                    className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
        </label>
        {customer?.orderNotes && (
          <div className="text-sm">
            <span className="font-medium">Customer standing order notes: </span>
            <span className="text-slate-600">{customer.orderNotes}</span>
          </div>
        )}
      </section>

      <AttachmentsSection owner="order" ownerId={id} canEdit={attachmentsCanEdit} />

      <DocumentsSection
        orderId={id} loads={order.loads} voided={voided} viewGate={gate(perms, "orders.view")}
        autoPrint={autoPrint}
      />

      <div className="mb-6">
        <HistoryPanel entity="order" entityId={id} />
      </div>
    </div>
  );
}
