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
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useEditGuard } from "@/lib/use-edit-guard";
import { useMutationGate } from "@/lib/use-latest";
import { drainOtherKeys } from "@/lib/drain-queue";
import { ORDER_STATUS_LABELS, type OrderStatusValue } from "@/lib/order-constants";
import { CERT_SCOPES, CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import { LIGHT_DOT_CLASS, LIGHT_LABELS, type TrafficLight } from "@/lib/traffic-light";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { AttachmentsSection } from "@/components/AttachmentsSection";
import { LinesSection } from "./LinesSection";
import { ProcessSection } from "./ProcessSection";
import { ContainersSection } from "./ContainersSection";
import { SerialsSection } from "./SerialsSection";
import { ChargesSection } from "./ChargesSection";
import { LoadsSection } from "./LoadsSection";
import { DocumentsSection } from "./DocumentsSection";
import { CertificationsSection } from "./CertificationsSection";
import { ShipmentsSection } from "./ShipmentsSection";
import { InvoicesSection } from "./InvoicesSection";

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
  /** The stored quote link (Phase 6 Task 5's detail exposure — spec §5.2 Display). Judged at
   *  link time (ruling 6): what's shown is the STORED link, never a re-derivation, and a
   *  received-date edit re-fetches nothing here — only the re-pick control, when the user
   *  opens it, reads eligibility against the CURRENT received date. */
  quoteLineId: string | null; quoteId: string | null; quoteNumber: number | null;
  // serializationRequired (fix-wave R3 finding 6) rides on the line's own part payload so
  // SerialsSection's warning is governed by orders.view, not a separate parts.view fetch.
  part: {
    id: string; partNumber: string; name: string; customer: { code: string }; serializationRequired: boolean;
  };
};
export type OrderContainer = {
  id: string; position: number; typeId: string; count: number; qty: number | null;
  tareWeight: number | null; grossWeight: number | null; customerContainerId: string; type: { name: string };
};
export type OrderSerial = { id: string; lineId: string; position: number; serial: string; description: string };
export type OrderLoad = { id: string; loadNumber: number; qty: number | null; weight: number | null };
export type OrderCharge = { id: string; position: number; description: string; amount: number | null };

export type OrderDetail = {
  id: string; orderNumber: number; customerId: string;
  /** #46: carried unconditionally under orders.view (the board precedent) — rendered as plain
   *  text without customers.view, as the customer link with it. */
  customer: { code: string; name: string };
  poNumber: string; vsOrderNumber: string; customerJobNo: string;
  /** The values RESOLVED AND FROZEN at save (spec §6.1) — shown and edited here as stored, never
   *  re-derived from the part/customer chain (that only runs inside createOrder). */
  certRequired: boolean; certScope: CertScopeValue;
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

/** Every mutation route on this order returns EITHER the bare fresh `OrderDetail`
 *  (replaceContainers/Serials/Charges, linkOrder, unlinkOrder) or `{ order, warnings }`
 *  (updateOrder, addLine, updateLine, removeLine, replaceLoads, resplitLoads) — verified route by
 *  route against src/app/api/orders/**\/route.ts. `unwrapMutation` below is the one place that
 *  distinction is resolved, so nothing downstream needs to know which shape a given endpoint
 *  happens to use. Fix-wave R2 finding 6: removeLine moved from the first group to the second — a
 *  removal changes the order's totals against an unchanged loads collection exactly like
 *  addLine/updateLine do, so it needed the same warnings-bearing shape. */
export type OrderMutationResult = OrderDetail | { order: OrderDetail; warnings: string[] };

/** The one prop every section takes to run a whole-order mutation and report its result. A THUNK,
 *  not a resolved response: the page's ordering ticket (R4 finding 6) has to be taken before the
 *  request goes out. Awaiting it is optional — a caller that has follow-up work (clearing its own
 *  bulk-grid overlay, resetting an input) awaits so a rejection reaches its own catch instead. */
export type ApplyMutation = (run: () => Promise<OrderMutationResult>) => Promise<void>;

/** `GET /api/parts`'s `PartRow` (src/server/parts.ts), narrowed to what this page's rider picker
 *  and per-line serialization warning need. `hasProcessSteps` is irrelevant for riders (spec §11
 *  — only the LEAD locks a revision) but carried anyway since the fetch already returns it and
 *  `computeLineWeight` (imported from the entry page's OrderLineCard by LinesSection) is typed
 *  against a structurally-identical `PartOption` that includes it. */
export type PartOption = {
  id: string; customerId: string; partNumber: string; name: string;
  eachWeight: number; serializationRequired: boolean; hasProcessSteps: boolean; active: boolean;
  /** Carried for structural compatibility with the entry page's own `PartOption` (Task 17 added
   *  the cert chain there for its resolved preview) — `computeLineWeight`, imported from
   *  OrderLineCard by LinesSection, is typed against that shape. The fetch already returns them;
   *  nothing on the hub reads them (the hub shows the order's own FROZEN values, never a
   *  re-derivation — spec §6.1). */
  certRequired: boolean | null; certScope: CertScopeValue | null;
  inheritedCertRequired: boolean; inheritedCertScope: CertScopeValue;
};

export type ContainerTypeOption = { id: string; name: string };

/** Slice of `getCustomer`'s row (src/server/customers.ts) this page actually reads. */
type Customer = { id: string; code: string; name: string; orderNotes: string };

// `entity` since #153: the single-record audit read is a UNION over the parent's child sections,
// so a row in it is not necessarily the order's own.
type AuditEntry = { id: string; entity: string; action: string; reason: string | null };

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

  // Fix-wave R4 finding 6: ONE monotonic ticket sequence shared by every write on this page and
  // by `load`'s own full refresh. Each of them replaces the whole `order` state, so overlapping
  // calls race and the winner used to be whichever response happened to arrive last — a slow line
  // edit answering after a fast bulk replace put the page back to a state the server had already
  // moved past, and the sections' bulk-grid overlays then composed against rows that no longer
  // existed. The ticket is taken at DISPATCH; a completion older than the newest one already
  // applied is dropped. `load` participates in the same sequence rather than a private one of its
  // own — otherwise a refresh and a mutation could still each be "newest" on their own counter and
  // clobber each other.
  const mutations = useMutationGate();

  // Every set-of-`order`-from-server (load()'s refresh — the §5.13 rollback path included — and
  // applyMutation's response apply below) routes through `editGuard.applyPayload`/
  // `editGuard.capturePayload`, so a response landing
  // mid-typing never resets the Overview/Notes field the user is actively editing
  // (use-edit-guard.ts — the #149 adoption; the parts/[id]/page.tsx shape). The classic trigger
  // here is an onChange-saving date input's PATCH resolving while the user has already moved on
  // to typing in PO/VS/job # or Notes — the whole-detail swap used to eat those keystrokes.
  const editGuard = useEditGuard();

  const load = useCallback(async () => {
    const ticket = mutations.next();
    const o = await api<OrderDetail>(`/api/orders/${id}`);
    // Captured-session apply inside the accept branch (use-edit-guard.ts, the round-3
    // fixpoint): a dropped stale payload is never applied, so it is never noted either.
    if (mutations.accept(ticket)) setOrder(editGuard.applyPayload(o));
    return o;
  }, [id, mutations, editGuard]);
  useEffect(() => {
    load().then(() => setError(null)).catch((e) => setError((e as Error).message));
  }, [load]);

  /** Runs one whole-order mutation and applies whichever response shape it answers with — the one
   *  place every action on this page (Overview/Notes/Lines/Containers/Serials/Charges/Loads/
   *  Link/Unlink) reports its result. An endpoint with no `warnings` key (the three bulk replaces,
   *  link/unlink) clears the banner rather than leaving a PREVIOUS mutation's warnings displayed
   *  against data they no longer describe — there is no server signal after one of these to say
   *  whether the old warning still applies, and showing a stale claim is worse than showing none.
   *
   *  Takes the request as a THUNK, not its already-resolved result (R4 finding 6): the ordering
   *  ticket has to be taken before the request is dispatched, and a ticket taken after the caller's
   *  own `await` would order responses by arrival — which is the bug, not the fix. Callers still
   *  `await` this and still catch their own failures; the rejection passes straight through. */
  const applyMutation = useCallback(async (run: () => Promise<OrderMutationResult>) => {
    const ticket = mutations.next();
    const res = await run();
    // #158 — success path, the instant the mutation resolves and BEFORE the accept gate: the
    // server state has certainly changed even when this response is superseded and its payload
    // dropped. This one seam covers the header PATCH, Link and Unlink here AND every write the
    // five co-located sections make through the same callback (lines, containers, serials,
    // charges, loads) — all of them the order's own before/after diff, which is exactly what the
    // panel at the bottom of this page renders.
    invalidateHistory();
    if (!mutations.accept(ticket)) return;
    const { order: fresh, warnings: w } = unwrapMutation(res);
    // `travelerPrinted` merges MONOTONICALLY (Codex PR #141 round 5): a mutation dispatched
    // before a traveler print commits can resolve after it, carrying a snapshot computed when the
    // flag was still false — and a whole-detail swap would un-print it until reload. The fact
    // only ever goes false → true (stored documents never delete, spec §5.6), so preserving a
    // local true is exact under EVERY response ordering — the fixpoint the per-callback timing
    // fixes could not reach. The #149 focused-field preserve composes OVER that adjustment:
    // `next` is the incoming server detail (flag-corrected), and the captured session's merge
    // then keeps only the one text field the user is actively editing — a boolean is never
    // under a text cursor, so the two preserves cannot collide.
    // The one composed site: the updater derives `next` FROM prev (the monotonic boolean
    // preserve above), so it cannot be a plain applyPayload — capturePayload takes the same
    // capture+note at dispatch (against the PRE-ternary `fresh`, which is exact: the ternary
    // only ever alters `travelerPrinted`, a boolean never registered with the guard) and the
    // updater merges `next` with that captured session (use-edit-guard.ts, round 3).
    const captured = editGuard.capturePayload(fresh);
    setOrder((prev) => {
      const next = prev?.travelerPrinted && !fresh.travelerPrinted
        ? { ...fresh, travelerPrinted: true }
        : fresh;
      return captured.merge(prev, next);
    });
    setWarnings(w);
  }, [mutations, editGuard]);

  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");
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
  // filter — verified against src/app/api/parts/route.ts). Feeds the rider-add picker only
  // (LinesSection, active parts only — an inactive part cannot be added, per resolveLineParts).
  // SerialsSection's serialization warning no longer needs this fetch at all (fix-wave R3 finding
  // 6): `line.part.serializationRequired` rides on OrderDetail itself, gated by orders.view.
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
  // requires deletedAt: null), so the delete entry is the order's own newest.
  //
  // It is NOT necessarily the newest row in the response, though: since #153 this read is a
  // union over the order's child sections, hence the `entity` filter below rather than `rows[0]`.
  // The union is also CAPPED (AUDIT_PANEL_LIMIT), so a parent holding more child rows than the
  // cap NEWER than its own delete entry would push that entry out of the window and drop this
  // banner to its generic copy. Not reachable today — a voided order takes no further child
  // edits either — but it is the failure mode to remember if the cap or the registry changes.
  useEffect(() => {
    if (!voided) { setVoidReason(null); return; }
    if (!auditGate.allowed) { setVoidReason(undefined); return; }
    api<{ rows: AuditEntry[]; hasMore: boolean }>(`/api/admin/audit?entity=order&entityId=${id}`)
      .then(({ rows }) => {
        // The newest row belonging to the ORDER — `rows[0]` since #153 may be an attachment's
        // entry, and reading the reason off that would quietly drop the banner's copy back to
        // the generic fallback with nothing to show it had happened. See the cap note above.
        const latest = rows.find((e) => e.entity === "order");
        setVoidReason(latest?.action === "delete" ? (latest.reason ?? undefined) : undefined);
      })
      .catch(() => setVoidReason(undefined));
  }, [voided, auditGate.allowed, id]);

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
  // Per-key REQUEST-settled signals for the failure drain below (Task 7 fix round 1): the drain
  // must never await the queue's chain TAILS — a tail settles only after its own catch, drain
  // included, completes, so two keys' saves both failing while overlapping had each catch
  // awaiting the other's tail: a mutual deadlock. A signal settles with its key's dispatched
  // request — which IS the commit/failure the rollback GET must postdate — and never depends on
  // a drain, so no cycle is possible (drain-queue.ts carries the full story).
  const inFlight = useRef<Map<string, Promise<unknown>>>(new Map());

  /** Overview's scalar fields + Notes' textarea share one PATCH surface (Task 5's `updateOrder`).
   *  Optimistic: the field shows the typed value immediately; a rejection rolls back to server
   *  truth FIRST and only then reports why (§5.13 — a reload after the error is set would clear
   *  it, since `load()` itself resets `error` to null on success). */
  async function saveOrder(
    patch: Partial<Pick<OrderDetail,
      "poNumber" | "vsOrderNumber" | "customerJobNo" | "receivedDate" | "requestDate" | "targetDate" | "notes"
      | "certRequired" | "certScope">>,
  ): Promise<boolean> {
    // The optimistic patch needs no editGuard apply (the customers/parts save() shape): it
    // spreads over `cur`, touching only the just-blurred field (or an unfocusable date input's),
    // so the focused sibling's in-flight text is untouched by construction. The merges guard the
    // SERVER-detail applies — applyMutation's response and the rollback load() below.
    setOrder((cur) => (cur ? { ...cur, ...patch } : cur));
    // A multi-field patch's composite key would NOT serialize against its constituent
    // single-field keys — latent only: every caller PATCHes one field per save.
    const key = Object.keys(patch).sort().join(",");
    return serial(key, async () => {
      try {
        const req = applyMutation(() => api<OrderMutationResult>(
          `/api/orders/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
        inFlight.current.set(key, req.then(() => {}, () => {})); // request-settled signal, at dispatch
        await req;
        setError(null);
        return true;
      } catch (e) {
        // §5.13 rollback-drain (Task 7): wait out every OTHER key's in-flight request before
        // the rollback GET — served before a sibling key's PATCH commits, the newest-ticket GET
        // would revert that sibling's committed write on screen (its own response then drops as
        // older-ticketed). Drains the request-settled SIGNALS above, never the queue tails
        // (fix round 1 — mutual deadlock). Same-key corrections need no drain — a same-key
        // response re-applies through the accept gate.
        await drainOtherKeys(inFlight.current, key);
        await load().catch(() => {});
        setError((e as Error).message);
        return false;
      }
    });
  }

  // Blur-save guard and focused-field tracking are both `editGuard`'s (use-edit-guard.ts — the
  // #149 adoption; this page carried the pre-guard `focusedValue` ref the guard itself grew out
  // of). The no-op half is unchanged: only fields the user actually changed reach the network,
  // still diffing the blur value against the at-focus snapshot. What's new is registering WHICH
  // OrderDetail property is under the cursor, which is what lets load()'s and applyMutation's
  // merges above preserve the field mid-typing when a response lands (the parts/[id]/
  // IdentitySection.tsx noteFocus shape). The onChange-saving date inputs register nothing —
  // they are the clobber TRIGGER, not the target; their behavior is unchanged.
  const noteFocus = (key: keyof OrderDetail & string) => editGuard.onFocusField(key);
  function onBlurSave(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
    commit: (value: string) => void,
  ) {
    editGuard.onBlurSave(e, commit);
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
    // #158 — success path, before the follow-up load. The void is an `auditedSoftDelete("order", …)`
    // carrying the typed reason, and this page stays mounted (read-only) to show it.
    invalidateHistory();
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
        // order.customer, not the customers.view-gated fetch (#46) — the refusal names the
        // customer for every caller who can use this control at all.
        setError(`No order #${typed} found for ${order.customer.code} · ${order.customer.name}.`);
        return;
      }
      await applyMutation(() => api<OrderMutationResult>(
        `/api/orders/${id}/link`, { method: "POST", body: JSON.stringify({ otherId: match.id }) },
      ));
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
      await applyMutation(() => api<OrderMutationResult>(`/api/orders/${id}/unlink`, { method: "POST" }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!order) return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Order #{order.orderNumber}
          {/* #46: the identity comes from OrderDetail itself (orders.view — the board precedent),
              never from the customers.view-gated fetch above, so the order is identified for
              every caller who can read it at all. Only the LINK stays behind customers.view —
              the page it leads to is gated on that. */}
          <span className="ml-3 text-base font-normal text-slate-500">
            {customersGate.allowed ? (
              <Link href={`/customers/${order.customerId}`} className="text-blue-700 underline">
                {order.customer.code} · {order.customer.name}
              </Link>
            ) : (
              <>{order.customer.code} · {order.customer.name}</>
            )}
          </span>
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
            <input value={order.poNumber} onFocus={noteFocus("poNumber")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => setOrder({ ...order, poNumber: e.target.value })}
                   onBlur={(e) => onBlurSave(e, (poNumber) => void saveOrder({ poNumber }))}
                   className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="block">
            VS order #
            <input value={order.vsOrderNumber} onFocus={noteFocus("vsOrderNumber")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => setOrder({ ...order, vsOrderNumber: e.target.value })}
                   onBlur={(e) => onBlurSave(e, (vsOrderNumber) => void saveOrder({ vsOrderNumber }))}
                   className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="block">
            Customer job #
            {/* §3.22: the customer's own job number, printed on the shipping ticket beside the
                PO. Same blur-save shape as PO/VS # above; stays editable at every status
                (spec §5.5's "everything else stays editable" list names it). */}
            <input value={order.customerJobNo} onFocus={noteFocus("customerJobNo")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => setOrder({ ...order, customerJobNo: e.target.value })}
                   onBlur={(e) => onBlurSave(e, (customerJobNo) => void saveOrder({ customerJobNo }))}
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
          {/* Spec §6.1: certRequired/certScope were RESOLVED (part → customer → plant) and frozen
              onto the order at save; what's shown and edited here is the stored pair, never a
              re-derivation — an edit is a plain scalar PATCH like every field above (spec §5.5
              keeps both editable at every status). Changing them later never creates or destroys
              a cert by itself; the Certifications section below is where load-scope certs are
              created on demand. */}
          <div className="block">
            <span className="flex items-center gap-2">
              <input type="checkbox" id="cert-required" checked={order.certRequired}
                     disabled={!editGate.allowed} title={editGate.title}
                     onChange={(e) => void saveOrder({ certRequired: e.target.checked })} />
              <label htmlFor="cert-required">Certification required</label>
            </span>
            <label className="mt-1 block">
              <span className="sr-only">Certification scope</span>
              <select value={order.certScope} disabled={!editGate.allowed} title={editGate.title}
                      onChange={(e) => void saveOrder({ certScope: e.target.value as CertScopeValue })}
                      className="w-full rounded border px-2 py-1 disabled:bg-slate-50">
                {CERT_SCOPES.map((s) => <option key={s} value={s}>{CERT_SCOPE_LABELS[s]}</option>)}
              </select>
            </label>
          </div>
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
        customerId={order.customerId} receivedDate={order.receivedDate}
        ordersViewAllowed={gate(perms, "orders.view").allowed}
        applyMutation={applyMutation} onError={setError}
      />

      <ProcessSection orderId={id} />

      <ContainersSection
        orderId={id} containers={order.containers} containerTypes={containerTypes} editGate={editGate}
        applyMutation={applyMutation} onError={setError}
      />

      <SerialsSection
        orderId={id} lines={order.lines} serials={order.serials} editGate={editGate}
        applyMutation={applyMutation} onError={setError}
      />

      <ChargesSection
        orderId={id} charges={order.charges} editGate={editGate} applyMutation={applyMutation} onError={setError}
      />

      <LoadsSection
        orderId={id} loads={order.loads} travelerPrinted={order.travelerPrinted}
        editGate={editGate} applyMutation={applyMutation} onError={setError}
      />

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Notes</h2>
        <label className="mb-3 block text-sm">
          Order notes
          <textarea value={order.notes} rows={3} onFocus={noteFocus("notes")} readOnly={!editGate.allowed} title={editGate.title}
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

      {/* #37: when the block is the order's own state, say so — voidLocked's exact wording —
          instead of the component's default "Requires orders.edit" (§5.16: the title must name
          the REAL reason; a voided order is read-only regardless of the permission grid). */}
      <AttachmentsSection owner="order" ownerId={id} canEdit={attachmentsCanEdit}
                          disabledTitle={voided ? "Order is voided" : undefined} />

      <DocumentsSection
        orderId={id} loads={order.loads} voided={voided} viewGate={gate(perms, "orders.view")}
        autoPrint={autoPrint}
        // Codex PR #141 round 3: a first print must reach the #41 loads-editor warning in the
        // SAME visit. `travelerPrinted` is monotonic (stored documents never delete — spec §5.6),
        // so a local flip is exact; no refetch needed.
        onPrinted={() => setOrder((o) => (o === null ? o : { ...o, travelerPrinted: true }))}
      />


      <CertificationsSection
        orderId={id} loads={order.loads} certRequired={order.certRequired} certScope={order.certScope}
        viewGate={gate(perms, "certs.view")}
        createGate={voidLocked(gate(perms, "certs.create"), voided)}
        // #165: what it takes to LIST this order's shipments, which is the only way the section's
        // scope picker can name a SHIPMENT-scope target. NOT void-locked — it gates a read, and
        // the create it feeds is already void-locked by `createGate` above.
        shipmentsGate={gate(perms, "shipping.view")}
      />

      <ShipmentsSection orderId={id} orderNumber={order.orderNumber} viewGate={gate(perms, "shipping.view")} />

      <InvoicesSection
        orderId={id} orderStatus={order.status}
        viewGate={gate(perms, "invoicing.view")} createGate={gate(perms, "invoicing.create")}
      />

      <div className="mb-6">
        <HistoryPanel entity="order" entityId={id} />
      </div>
    </div>
  );
}
