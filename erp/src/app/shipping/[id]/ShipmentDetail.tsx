"use client";
// The shipment page's body (design spec §11 "Shipment page"). A shipment is a DOCUMENT: a header,
// then one panel per order on it (ShipmentOrderPanel.tsx). Remounted per id by page.tsx's
// `key={id}` (HANDOFF §5.12 — a Critical in Phase 2B): every defaultValue-bound field and every
// bulk-grid overlay below is therefore guaranteed fresh per shipment id, never carrying one
// shipment's unsaved text onto another's.
//
// THE BINDING STATE MODEL (the 2C-3 lesson, order hub's own precedent): header PATCHes are
// optimistic with rollback-then-report on failure (§5.13 — reload BEFORE setting the error, never
// after); Add order/Remove order/Void are non-optimistic (apply only the server's own fresh
// response); the three grids per panel keep only what the user actually edited/added/removed,
// composed with server state at render (`useBulkGrid`, src/lib/bulk-grid.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, trackedFetch } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest, useMutationGate } from "@/lib/use-latest";
import { drainOtherKeys } from "@/lib/drain-queue";
import { useEditGuard } from "@/lib/use-edit-guard";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { FREIGHT_TERMS, FREIGHT_TERMS_LABELS, type FreightTermsValue } from "@/lib/cert-constants";
import { ShipmentOrderPanel } from "./ShipmentOrderPanel";
import { confirmDiscard, useUnsavedPresent } from "@/lib/use-unsaved-section";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/shippers.ts's exported row shapes — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md). Exported so ShipmentOrderPanel.tsx imports the ones it
// needs — the orders/[id]/page.tsx `OrderLine`/`ApplyMutation` precedent.
// ---------------------------------------------------------------------------------------------

/** A null orderLineId/orderContainerId/orderSerialId marks a RELEASED row (snapshot + release,
 *  ruling 23): the order-side row was corrected away and the shipment row is frozen history —
 *  rendered read-only from its snapshot fields, never editable, never sent in a replace. */
export type ShipperLine = {
  id: string; orderLineId: string | null; linePosition: number; partNumber: string; partName: string;
  orderedQty: number; orderedWeight: number; shippedToDateQty: number; shippedToDateWeight: number;
  qty: number; weight: number; lineComplete: boolean;
};
export type ShipperContainer = {
  id: string; orderContainerId: string | null; typeName: string; customerContainerId: string; count: number; position: number;
};
export type ShipperSerial = {
  id: string; orderSerialId: string | null; serial: string; description: string; printOnShipper: boolean;
};
/** Shipped-to-date for one line of the ORDER — including lines not on this shipment, which is what
 *  the "Add line" picker needs to prefill ship-now to the remainder rather than the full ordered
 *  figure (Task 14 review, Important #1). Dense: a never-shipped line arrives as a real 0/0. */
export type OrderLineShipped = { orderLineId: string; shippedToDateQty: number; shippedToDateWeight: number };
export type ShipperOrder = {
  id: string; orderId: string; orderNumber: number; sequence: number; position: number;
  poNumber: string; customerJobNo: string; label: string;
  orderLineShippedToDate: OrderLineShipped[];
  lines: ShipperLine[]; containers: ShipperContainer[]; serials: ShipperSerial[];
};

/** `freightAmount`/`packageCount` are `number | string | null`: a number once loaded, but also a
 *  string mid-edit (the input is bound straight to the field) — the customers/[id]/page.tsx
 *  `creditLimit` precedent. `freightAmount` is sent to the server as the typed text as-is
 *  (`decimalField` accepts a decimal string); `packageCount` is parsed to a real integer before
 *  it is ever sent (`commitPackageCount` below) since the server's schema is `z.number().int()`,
 *  not a decimal string. */
export type ShipperDetail = {
  id: string; shipperNumber: number; bolNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  customerCreditHold: boolean;
  shipToAddressId: string | null; shipDate: string;
  carrierId: string | null; carrierName: string | null; route: string; comments: string;
  billFreight: boolean;
  freightAmount: number | string | null;
  freightTerms: FreightTermsValue;
  freightClass: string; freightDescription: string;
  packageCount: number | string | null;
  proNumber: string; scacCode: string;
  /** Set when this shipment IS a reversal (§5.6) — with `reversesShipperNumber`, the #139 freeze
   *  banner/titles name the original it mirrors. */
  reversesShipperId: string | null;
  reversesShipperNumber: number | null;
  /** The LIVE reversal pointing at this shipment, if any (#65): its packing-list number. Void
   *  renders disabled naming it (§5.16); the server's `voidShipper` refusal is the enforcement.
   *  Always null on a reversal document itself, so a reversal's own Void stays enabled — voiding
   *  a reversal is the blessed undo. */
  reversedByShipperNumber: number | null;
  /** The §5.7 invoice freeze, pre-worded server-side with `voidShipper`'s own refusal sentence
   *  (Codex PR #141 review) — shown BEFORE the reversal blocker, the server's own guard order. */
  invoiceVoidBlock: string | null;
  deletedAt: string | null;
  orders: ShipperOrder[];
};

/** Every mutating shipment route — PATCH, add/remove order, the three per-order replaces — is
 *  wrapped through `shipperResponse` (src/app/api/shippers/response.ts) into this ONE shape, GET
 *  included. Unlike the order hub, there is no second "bare detail" shape to unwrap. */
export type ShipperMutationResult = { shipper: ShipperDetail; warnings: string[] };

/** The one prop every panel/grid takes to run a whole-shipment mutation and report its result —
 *  a THUNK, not a resolved response, so the mutation-ordering ticket is taken before the request
 *  goes out (the order hub `ApplyMutation` precedent, fix-wave R4 finding 6). */
export type ApplyMutation = (run: () => Promise<ShipperMutationResult>) => Promise<void>;

/** The order's OWN full line/container/serial catalog (`GET /api/orders/[id]`, fetched once per
 *  order on this shipment) — what each panel's "Add line/container/serial" picker offers, since
 *  `ShipperOrderDetail.lines`/`containers`/`serials` only carry what's already on THIS shipment. */
export type OrderCatalogLine = { id: string; position: number; partNumber: string; partName: string; qty: number; weight: number };
export type OrderCatalogContainer = { id: string; typeName: string; customerContainerId: string; count: number };
export type OrderCatalogSerial = { id: string; lineId: string; serial: string; description: string };
export type OrderCatalog = { lines: OrderCatalogLine[]; containers: OrderCatalogContainer[]; serials: OrderCatalogSerial[] };

/** Slice of `GET /api/orders/[id]`'s `OrderDetail` (src/server/orders.ts) this page actually
 *  reads, to build one order's `OrderCatalog` above. */
type OrderDetailLite = {
  lines: { id: string; position: number; qty: number; weight: number; part: { partNumber: string; name: string } }[];
  containers: { id: string; count: number; customerContainerId: string; type: { name: string } }[];
  serials: { id: string; lineId: string; serial: string; description: string }[];
};
function toOrderCatalog(o: OrderDetailLite): OrderCatalog {
  return {
    lines: o.lines.map((l) => ({ id: l.id, position: l.position, partNumber: l.part.partNumber, partName: l.part.name, qty: l.qty, weight: l.weight })),
    containers: o.containers.map((c) => ({ id: c.id, typeName: c.type.name, customerContainerId: c.customerContainerId, count: c.count })),
    serials: o.serials.map((s) => ({ id: s.id, lineId: s.lineId, serial: s.serial, description: s.description })),
  };
}

/** Slice of `GET /api/customers/[id]`'s `CustomerRow` (src/server/customers.ts). */
type Customer = { id: string; code: string; name: string; shippingNotes: string; creditHold: boolean };
/** Slice of `GET /api/customers/[id]/addresses`'s `AddressRow` (src/server/customer-addresses.ts). */
type Address = { id: string; kind: string; name: string; street: string; city: string; state: string; zip: string };
type CarrierOption = { id: string; name: string };
/** Slice of `GET /api/orders`'s `BoardRow` (src/server/orders.ts) — the "Add order" candidates. */
type OrderOption = { id: string; orderNumber: number; poNumber: string };
// `entity` since #153 — see the order hub's identical note: the single-record audit read is a
// union, so a row in it is not necessarily the shipment's own.
type AuditEntry = { id: string; entity: string; action: string; reason: string | null };
/** Slice of `GET /api/shippers/[id]/documents`'s `DocumentMeta` (src/server/documents.ts). */
type StoredDoc = { id: string; kind: string; orderId: string | null; createdAt: string };

const DOC_KIND_LABELS: Record<string, string> = { SHIPPER: "Shipping ticket", BOL: "Bill of lading", CERT: "Certification" };

/** A voided shipment is read-only everywhere (spec §5.6, the P3 voided-order shape) regardless of
 *  what the permission grid would otherwise allow — the order hub `voidLocked` precedent. */
function voidLocked(g: Gate, voided: boolean): Gate {
  return voided ? { allowed: false, disabled: true, title: "Shipment is voided" } : g;
}

/** #139 freeze-the-pair (owner ruling 2026-08-18): while a reversal pair is live, every edit door
 *  is refused server-side (`claimLiveShipper`'s guard) — the controls say so up front (§5.16),
 *  carrying the server's own sentence as their title. Void and print stay on their own gates:
 *  voiding the reversal is the blessed undo, and a reprint/BOL on a reversed original must keep
 *  working. */
function pairLocked(g: Gate, freeze: string | null): Gate {
  return freeze !== null ? { allowed: false, disabled: true, title: freeze } : g;
}

/**
 * The Reverse gate (#161) — built from what refuses a REVERSAL, and deliberately NOT a clone of
 * `voidGate` below.
 *
 * **`invoiceVoidBlock` is NOT a rung here, and adding it would be a bug.** That block exists
 * because a finalized invoice freezes the shipment against a VOID (`voidShipper`'s
 * `refuseIfInvoiced`); a reversal is the correction for exactly that situation, and
 * `reverseShipper` (shippers.ts) carries no invoice guard at all — its own tests finalize an
 * invoice and then reverse, which is what writes `Order.status = REOPENED`. Cloning the Void
 * ladder would disable this control in the one case it exists for, and would look right in review
 * because it matches the button beside it.
 *
 * The rungs, in `reverseShipperInTx`'s OWN guard order, each carrying that guard's wording so the
 * title and the refusal cannot drift (§5.16 — disabled with the reason, never hidden):
 *   1. voided — step 3's `deletedAt` re-read 404s ("Shipment not found"); a voided shipment already
 *      contributes 0 to the ledger, so there is nothing to net down. This rung is also what keeps
 *      `e2e/flows/void-shipment.mjs`'s lock-every-control sweep green.
 *   2. this document IS a reversal — step 3's `reversesShipperId` refusal.
 *   3. already reversed — step 3b's at-most-one-live-reversal refusal (Codex PR #141 round 2).
 *   4. otherwise the route's own check, `mustDo(user, "void_shipper")` — the SAME special action as
 *      Void, and no `shipping.*` CRUD grant substitutes for it.
 *
 * The two remaining server refusals are data conditions no client can evaluate honestly — a voided
 * ORDER on the shipment, and the below-zero ledger guard — so they stay the server's to report
 * through the error banner rather than becoming a guessed-at disabled title.
 */
export function reverseGate(perms: string[] | undefined, shipper: ShipperDetail): Gate {
  if (shipper.deletedAt !== null) {
    return { allowed: false, disabled: true, title: "Shipment is voided" };
  }
  if (shipper.reversesShipperId !== null) {
    return { allowed: false, disabled: true,
      title: `This shipment is itself a reversal of Packing List ${shipper.reversesShipperNumber ?? "?"} — ` +
        "reverse the original shipment instead" };
  }
  if (shipper.reversedByShipperNumber !== null) {
    return { allowed: false, disabled: true,
      title: `This shipment has already been reversed by Packing List ${shipper.reversedByShipperNumber} — ` +
        "void that reversal first" };
  }
  return gateDo(perms, "void_shipper");
}

/** The Reverse control itself. Split out — the `OpenItemRow` precedent — so `reverseGate`'s ladder
 *  can be pinned all the way to the rendered `disabled` attribute by a `renderToStaticMarkup` test
 *  (tests/shipment-reverse-control.test.tsx) rather than only as a plain object. */
export function ReverseShipmentButton({ gate: g, busy, onClick }: {
  gate: Gate; busy: boolean; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={g.disabled || busy} title={g.title}
            className="rounded border border-amber-600 px-3 py-1.5 text-sm text-amber-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
      {busy ? "Reversing…" : "Reverse shipment"}
    </button>
  );
}

/** The stored-documents list (spec §11) — `GET /api/shippers/[id]/documents` (Task 14; no other
 *  caller existed for `listDocumentsForShipper` before this page needed one). Not printing itself
 *  (Tasks 18–19 own that); a plain link to the existing, already-gated `GET /api/documents/[id]`
 *  download route, the DocumentsSection.tsx precedent minus the print/blob plumbing this page has
 *  nothing to trigger yet. */
function ShipmentDocumentsList({ shipperId, viewGate, refresh }: {
  shipperId: string; viewGate: Gate;
  /** Bumped by every successful print above, so a just-archived ticket appears without a page
   *  reload (Task 18 — printing became live on this page). */
  refresh: number;
}) {
  const [docs, setDocs] = useState<StoredDoc[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // §5.13 stale-gate, both paths (F7): the mount fetch races the print-bumped `refresh` refetch.
  const latest = useLatest();
  useEffect(() => {
    if (!viewGate.allowed) return;
    const t = latest.next();
    api<StoredDoc[]>(`/api/shippers/${shipperId}/documents`)
      .then((rows) => { if (latest.isCurrent(t)) setDocs(rows); })
      .catch((e) => { if (latest.isCurrent(t)) setErr((e as Error).message); });
  }, [shipperId, viewGate.allowed, refresh, latest]);

  if (!viewGate.allowed) return <p className="text-sm text-slate-500">{viewGate.title}</p>;
  if (err) return <p className="text-sm text-red-700">{err}</p>;
  if (docs.length === 0) return <p className="text-sm text-slate-500">Nothing printed yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="py-1 font-medium">Document</th><th className="font-medium">Scope</th><th className="font-medium">Printed</th>
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id} className="border-t">
            <td className="py-1">
              <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer" className="text-blue-700 underline">
                {DOC_KIND_LABELS[d.kind] ?? d.kind}
              </a>
            </td>
            <td>{d.orderId === null ? "Whole shipment" : "One order"}</td>
            <td className="text-slate-600">{new Date(d.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ShipmentDetail({ id }: { id: string }) {
  const { permissions: perms, error: permsError } = usePermissions();
  const router = useRouter();

  const [shipper, setShipper] = useState<ShipperDetail | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Supplementary fetches (customer, addresses, carriers, add-order candidates, per-order
  // catalogs, void reason) each get their OWN banner rather than the shared `error` a later
  // mutation clears — the order hub `loadError` precedent: a save elsewhere on the page must not
  // silently erase the report that one of these failed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const addLoadError = useCallback((message: string) => {
    setLoadError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [carriers, setCarriers] = useState<CarrierOption[]>([]);
  const [addableOrders, setAddableOrders] = useState<OrderOption[]>([]);
  const [catalogs, setCatalogs] = useState<Map<string, OrderCatalog>>(new Map());
  const [addOrderChoice, setAddOrderChoice] = useState("");
  const [addingOrder, setAddingOrder] = useState(false);
  const [creditHoldReason, setCreditHoldReason] = useState("");
  // undefined = fetched but no reason could be resolved (missing admin.view, the fetch failed, or
  // the latest entry wasn't a delete) — the order hub `voidReason` precedent. null = not
  // applicable (shipment isn't voided).
  const [voidReason, setVoidReason] = useState<string | null | undefined>(null);

  // ONE monotonic ticket sequence shared by every write on this page and by `load`'s own full
  // refresh — the order hub `mutations` precedent (fix-wave R4 finding 6): every action here
  // replaces the whole `shipper` state, so overlapping calls race and the ticket ensures the
  // winner is whichever call is genuinely newest, not whichever happens to answer last.
  const mutations = useMutationGate();
  // Every set-from-server-detail below routes through `editGuard.applyPayload` so an arriving detail —
  // another header field's PATCH response, a grid save, or §5.13's rollback `load()` — never
  // resets the header text field the user is actively typing in (use-edit-guard.ts; the fix-wave
  // notes-clobber trio, of which CertDetail.tsx and customers/[id]/page.tsx carry the same shape).
  const editGuard = useEditGuard();

  const load = useCallback(async () => {
    const ticket = mutations.next();
    const res = await api<ShipperMutationResult>(`/api/shippers/${id}`);
    // Captured-session apply inside the accept branch (use-edit-guard.ts, the round-3 fixpoint).
    if (mutations.accept(ticket)) {
      setShipper(editGuard.applyPayload(res.shipper));
      setWarnings(res.warnings);
    }
    return res.shipper;
  }, [id, mutations, editGuard]);
  useEffect(() => {
    load().then(() => setError(null)).catch((e) => setError((e as Error).message));
  }, [load]);

  const applyMutation = useCallback(async (run: () => Promise<ShipperMutationResult>) => {
    const ticket = mutations.next();
    const res = await run();
    // #158 — success path, the instant the mutation resolves and BEFORE the accept gate: the
    // server state has certainly changed even when this response is superseded and its payload
    // dropped. This one seam covers the header PATCH, Add order and Remove order here AND every
    // write `ShipmentOrderPanel` makes through the same callback — all of them the shipper's own
    // before/after diff, which is what the panel at the bottom of this page renders.
    invalidateHistory();
    if (!mutations.accept(ticket)) return;
    setShipper(editGuard.applyPayload(res.shipper));
    setWarnings(res.warnings);
  }, [mutations, editGuard]);

  const customersGate = gate(perms, "customers.view");
  const ordersGate = gate(perms, "orders.view");
  const auditGate = gate(perms, "admin.view");
  const docsGate = gate(perms, "shipping.view");
  const voided = (shipper?.deletedAt ?? null) !== null;
  // #182 / Codex PR #141: on an original carrying a live reversal, the §5.7 invoice freeze OUTRANKS
  // the #65 reversal blocker — `voidShipper` runs `refuseIfInvoiced` before the reversal guard, so on
  // an invoiced pair "void the reversal first" names a step the server ALSO refuses. The first
  // obstacle is therefore the invoice sentence (unlock / raise a credit) when the pair is invoiced,
  // and the reversal step otherwise. Encoded ONCE here and consumed by BOTH the edit-freeze banner
  // and the Void button below, so the two surfaces cannot drift (which is exactly #182); each passes
  // the reversal-step phrasing it wants.
  const reversedOriginalObstacle = (reversalStep: string): string =>
    shipper?.invoiceVoidBlock ?? reversalStep;
  // #139: the pair freeze, worded exactly as `claimLiveShipper`'s refusals so title and server
  // sentence cannot drift. The reversal side freezes whenever `reversesShipperId` is set (the server
  // refuses ALWAYS — mirror paper); the original's side follows `reversedByShipperNumber`, which is
  // live-filtered, so a void + reload clears the freeze for free — and (since #182) it leads with the
  // invoice sentence on an invoiced pair, deferring to `reversedOriginalObstacle` above.
  const pairFreeze = shipper === null ? null
    : shipper.reversesShipperId !== null
      ? `This is a reversal of Packing List ${shipper.reversesShipperNumber ?? "?"} — a reversal is machine-generated mirror paper; void it and re-reverse instead of editing it`
      : shipper.reversedByShipperNumber !== null
        ? reversedOriginalObstacle(`This shipment has been reversed by Packing List ${shipper.reversedByShipperNumber} — void the reversal first, then edit, then re-reverse`)
        : null;
  const editGate = voidLocked(pairLocked(gate(perms, "shipping.edit"), pairFreeze), voided);
  // §5.4 extended to shipment extension (owner ruling 2026-08-06): adding orders and replacing
  // lines on a HELD customer's shipment needs override_credit_hold + a reason. NewShipment's own
  // shape — a disabled control says why, an allowed override renders the reason field.
  const overrideGate = gateDo(perms, "override_credit_hold");
  const held = shipper?.customerCreditHold ?? false;
  const extendGate: Gate = held && editGate.allowed && !overrideGate.allowed
    ? { allowed: false, disabled: true,
        title: `${shipper?.customerCode} · ${shipper?.customerName} is on credit hold — adding orders or changing lines requires the override_credit_hold action` }
    : editGate;
  // #65: an original with a live reversal cannot void (the server refuses, naming the reversal) —
  // the button says so up front (§5.16, disabled with the blocker as its title, never hidden). A
  // reversal document's own `reversedByShipperNumber` is always null, so its Void stays enabled:
  // voiding a reversal is the blessed undo. PRECEDENCE (Codex PR #141 review): on a reversed original
  // the §5.7 invoice freeze wins — `reversedOriginalObstacle` above returns the invoice sentence
  // (unlock / raise a credit) when the pair is invoiced, mirroring `voidShipper`'s own guard order
  // (`refuseIfInvoiced` before the reversal blocker). That one helper is shared with the edit-freeze
  // banner (#182), so the two can never disagree. A non-reversed invoiced shipment still gets the
  // bare invoice sentence from the arm below.
  const voidGate = voided
    ? { allowed: false, disabled: true, title: "Already voided" }
    : shipper != null && shipper.reversedByShipperNumber !== null
      ? { allowed: false, disabled: true,
          title: reversedOriginalObstacle(`This shipment has been reversed by Packing List ${shipper.reversedByShipperNumber} — void the reversal first`) }
      : shipper != null && shipper.invoiceVoidBlock !== null
        ? { allowed: false, disabled: true, title: shipper.invoiceVoidBlock }
        : gateDo(perms, "void_shipper");
  // #161: the Reverse control's own ladder — see `reverseGate` above for why it is NOT `voidGate`
  // with a different label (the §5.7 invoice block is deliberately absent).
  //
  // The null arm is unreachable — the component early-returns below before anything renders this —
  // and is kept only to satisfy `reverseGate`'s non-null parameter at a point where the compiler
  // cannot see that. `voidGate` handles the same condition with inline `shipper != null` guards
  // instead; two shapes for one condition, noted rather than unified because collapsing them means
  // touching the Void ladder, which is not this task's to move (review Minor 2).
  const reverseControlGate = shipper === null
    ? { allowed: false, disabled: true, title: undefined }
    : reverseGate(perms, shipper);
  const [reversing, setReversing] = useState(false);

  // Ticket printing (Task 18; spec §9's POST /api/shippers/[id]/print). Gated shipping.view like
  // the route; a voided shipment refuses NEW prints while stored ones stay downloadable (§5.6), so
  // the button says exactly that (§5.16 — disabled with a truthful title, never hidden). The
  // DocumentsSection.tsx print shape, minus the auto-print machinery this page has no entry for.
  // Unsaved line/container/serial grids block the ticket and BOL prints (Codex P1, round 6). Those
  // callbacks generate and ARCHIVE paperwork from server state and send no local overlay, so an
  // operator could permanently file a packing list or bill of lading carrying the pre-edit
  // quantities, containers or serials while the screen shows the edited ones. Same refusal as the
  // invoice and the certification: a discarded edit can be retyped, filed paper cannot be unfiled.
  const unsavedGrids = useUnsavedPresent();
  const printGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Shipment is voided — stored prints stay available" }
    : unsavedGrids
      ? { allowed: false, disabled: true, title: "Save the grid changes first — a print archives what the server holds" }
      : docsGate;
  // The cert checkbox (§3.14) needs certs.view on top: the archived paper is certs-area paper
  // (the route enforces the same pair), so the §5.16 tooltip names the missing permission and the
  // box unchecks itself rather than sending a request that can only 403.
  const certsGate = gate(perms, "certs.view");
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  // The bundled certs' archived document ids (x-cert-document-ids) — surfaced as DIRECT links:
  // the Documents list below filters on shipperId and a CERT document carries only certId, so
  // "open them from Documents below" would point at a list that can never show them.
  const [certDocIds, setCertDocIds] = useState<string[]>([]);
  // §9 amendment 2026-08-05: a cert-requiring covered order with no cert prints its tickets and
  // WARNS — the route carries the named warnings in x-print-warnings (URI-encoded JSON, since the
  // body is PDF bytes) and this page surfaces them beside the print bar.
  const [printWarnings, setPrintWarnings] = useState<string[]>([]);
  const [docsRefresh, setDocsRefresh] = useState(0);
  const [withCerts, setWithCerts] = useState(true);   // pre-ticked (§3.14)

  /** Shared print pipeline for every document this page can produce. `query` names the doc. */
  const printDoc = useCallback(async (query: string, label: string) => {
    setPrinting(true);
    setPrintError(null);
    setCertDocIds([]);
    setPrintWarnings([]);
    try {
      const res = await trackedFetch(`/api/shippers/${id}/print?${query}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Print failed (${res.status})`);
      }
      // #158 — success path, the instant the print resolves. The FIRST BOL print allocates
      // `bolNumber` through `auditedUpdate("shipper", …)` (shippers.ts `printBol`); a reprint
      // writes no shipper row, and an invalidation that finds nothing new is one gated GET.
      invalidateHistory();
      const url = URL.createObjectURL(await res.blob());
      const opened = window.open(url, "_blank");
      if (opened) opened.opener = null;
      if (opened === null) {
        // Never silent (the DocumentsSection rule): the print HAPPENED and is archived — the
        // refreshed Documents list below is the escape hatch, and this message says so.
        setPrintError(`The browser blocked the print window — the ${label} was archived and is in Documents below.`);
      }
      // The certs print as their own archived documents (§3.14); a browser allows one popup per
      // click, so they are surfaced as direct links beside the print bar rather than a volley of
      // blocked tabs.
      const certDocs = res.headers.get("x-cert-document-ids");
      setCertDocIds(certDocs === null ? [] : certDocs.split(","));
      const warned = res.headers.get("x-print-warnings");
      if (warned !== null) {
        try {
          setPrintWarnings(JSON.parse(decodeURIComponent(warned)) as string[]);
        } catch {
          // A malformed header must not hide that something warned (never a silent drop).
          setPrintWarnings(["The print reported a warning that could not be read — check the shipment's certifications."]);
        }
      }
      // Revoked on a delay either way — revoking immediately would race the new tab's own load
      // (the DocumentsSection precedent, fix-wave finding 6).
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDocsRefresh((n) => n + 1);
    } catch (e) {
      setPrintError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }, [id]);

  const printTicket = useCallback((orderId: string | undefined, certWanted: boolean) => {
    const query = `doc=ticket${orderId === undefined ? "" : `&order=${orderId}`}${certWanted ? "&cert=1" : ""}`;
    return printDoc(query, "ticket");
  }, [printDoc]);
  const printBol = useCallback(() => printDoc("doc=bol", "bill of lading"), [printDoc]);

  const customerId = shipper?.customerId;

  // Customer (shippingNotes banner, credit-hold banner, the customer link).
  useEffect(() => {
    if (!customerId || !customersGate.allowed) return;
    api<Customer>(`/api/customers/${customerId}`).then(setCustomer)
      .catch((e) => addLoadError(`Could not load the customer: ${(e as Error).message}`));
  }, [customerId, customersGate.allowed, addLoadError]);

  // Ship-to selector — that customer's live SHIP_TO addresses (task-14-brief.md). `listAddresses`
  // already filters to active-only when includeInactive is omitted (customer-addresses.ts), so
  // the kind filter here is the only narrowing this page needs to do itself.
  useEffect(() => {
    if (!customerId || !customersGate.allowed) return;
    api<Address[]>(`/api/customers/${customerId}/addresses`)
      .then((rows) => setAddresses(rows.filter((a) => a.kind === "SHIP_TO")))
      .catch((e) => addLoadError(`Could not load ship-to addresses: ${(e as Error).message}`));
  }, [customerId, customersGate.allowed, addLoadError]);

  // Carrier picker — session-only pick-list (no permission beyond signed-in), the order hub
  // `containerTypes` precedent.
  useEffect(() => {
    api<CarrierOption[]>("/api/picklists/carrier").then(setCarriers)
      .catch((e) => addLoadError(`Could not load carriers: ${(e as Error).message}`));
  }, [addLoadError]);

  // Add-order candidates: this customer's own orders not yet fully shipped (OPEN/PARTIAL_SHIPPED
  // — voided and SHIPPED orders are excluded by construction), minus whatever is already on this
  // shipment. `GET /api/orders` excludes voided orders unless includeVoided=1 is passed (orders.ts
  // `boardWhere`), so nothing extra is needed here for that half.
  const onShipmentOrderIds = shipper ? shipper.orders.map((o) => o.orderId).join(",") : "";
  // §5.13 stale-gate, the NewShipment #51 `candidatesLatest` shape, both paths (F7): re-runs on
  // every add/remove order, so a slow earlier response must not clobber a newer order-set's list.
  const addableLatest = useLatest();
  useEffect(() => {
    const t = addableLatest.next();
    if (!customerId || !ordersGate.allowed) return;
    api<OrderOption[]>(`/api/orders?customerId=${customerId}&status=OPEN,PARTIAL_SHIPPED`)
      .then((rows) => {
        if (!addableLatest.isCurrent(t)) return;
        const already = new Set(onShipmentOrderIds ? onShipmentOrderIds.split(",") : []);
        setAddableOrders(rows.filter((r) => !already.has(r.id)));
      })
      .catch((e) => { if (addableLatest.isCurrent(t)) addLoadError(`Could not load orders available to add: ${(e as Error).message}`); });
  }, [customerId, ordersGate.allowed, onShipmentOrderIds, addableLatest, addLoadError]);

  // Per-order catalogs — refetched wholesale whenever the order-id SET on this shipment changes
  // (add/remove order), never incrementally patched: a rare, deliberate action, so the simplicity
  // of "refetch everything" beats bookkeeping a partial map. `useLatest` guards a slow response
  // from an earlier order-set against clobbering a newer one.
  const catalogsLatest = useLatest();
  useEffect(() => {
    if (!shipper || shipper.orders.length === 0 || !ordersGate.allowed) { setCatalogs(new Map()); return; }
    const ticket = catalogsLatest.next();
    Promise.all(shipper.orders.map((o) =>
      api<OrderDetailLite>(`/api/orders/${o.orderId}`).then((od) => [o.orderId, toOrderCatalog(od)] as const)))
      .then((entries) => { if (catalogsLatest.isCurrent(ticket)) setCatalogs(new Map(entries)); })
      .catch((e) => {
        if (catalogsLatest.isCurrent(ticket)) {
          addLoadError(`Could not load order line/container/serial catalogs for the add pickers: ${(e as Error).message}`);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onShipmentOrderIds` (derived above) is the real key; `shipper` itself changes on every unrelated header edit too.
  }, [onShipmentOrderIds, ordersGate.allowed, catalogsLatest, addLoadError]);

  // Voided banner's reason (order hub `voidReason` precedent) — safe to key on `voided` alone:
  // once voided, no mutator can touch the shipment again, so the delete entry is the shipment's
  // own newest. Since #153 this read is a capped union over the parent's child sections, so it is
  // found by `entity`, not by position — see the order hub's fuller note on both points.
  useEffect(() => {
    if (!voided) { setVoidReason(null); return; }
    if (!auditGate.allowed) { setVoidReason(undefined); return; }
    api<{ rows: AuditEntry[]; hasMore: boolean }>(`/api/admin/audit?entity=shipper&entityId=${id}`)
      .then(({ rows }) => {
        const latest = rows.find((e) => e.entity === "shipper");
        setVoidReason(latest?.action === "delete" ? (latest.reason ?? undefined) : undefined);
      })
      .catch(() => setVoidReason(undefined));
  }, [voided, auditGate.allowed, id]);

  // ---- Header: optimistic scalar PATCH (customers/[id]/page.tsx `save()` / order hub `saveOrder()` precedent) ----

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

  type HeaderPatch = {
    shipToAddressId?: string | null; shipDate?: string; carrierId?: string | null;
    route?: string; comments?: string; billFreight?: boolean;
    freightAmount?: number | string | null; freightTerms?: FreightTermsValue;
    freightClass?: string; freightDescription?: string; packageCount?: number | null;
    proNumber?: string; scacCode?: string;
  };

  /** Optimistic: the field shows the typed/chosen value immediately; a rejection rolls back to
   *  server truth FIRST and only then reports why (§5.13 — a reload after the error is set would
   *  clear it, since `load()` resets `error` to null on success). */
  async function patchHeader(patch: HeaderPatch): Promise<boolean> {
    setShipper((cur) => (cur ? { ...cur, ...patch } : cur));
    // A multi-field patch's composite key would NOT serialize against its constituent
    // single-field keys — latent only: every caller PATCHes one field per save.
    const key = Object.keys(patch).sort().join(",");
    return serial(key, async () => {
      try {
        const req = applyMutation(() => api<ShipperMutationResult>(
          `/api/shippers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
        inFlight.current.set(key, req.then(() => {}, () => {})); // request-settled signal, at dispatch
        await req;
        setError(null);
        return true;
      } catch (e) {
        // §5.13 rollback-drain (Task 7): wait out every OTHER key's in-flight request before
        // the rollback GET — served before a sibling key's PATCH commits, the newest-ticket GET
        // would revert that sibling's committed write on screen (its own response then drops as
        // older-ticketed). Drains the request-settled SIGNALS above, never the queue tails
        // (fix round 1 — mutual deadlock; drain-queue.ts carries the full story).
        await drainOtherKeys(inFlight.current, key);
        await load().catch(() => {});
        setError((e as Error).message);
        return false;
      }
    });
  }

  // Blur-save guard and focused-field tracking are both `editGuard`'s (use-edit-guard.ts): the
  // no-op guard is unchanged, and the focus handler now also names which header field is under
  // the cursor so `merge` above can preserve it.
  function commitFreightAmount(value: string) {
    const trimmed = value.trim();
    void patchHeader({ freightAmount: trimmed === "" ? null : trimmed });
  }
  function commitPackageCount(value: string) {
    const trimmed = value.trim();
    if (trimmed === "") { void patchHeader({ packageCount: null }); return; }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) { setError("Package count must be a whole number of at least 0."); return; }
    void patchHeader({ packageCount: n });
  }

  // ---- Add order / Remove order / Void: non-optimistic (order hub `linkAction`/`voidAction` precedent) ----

  async function addOrder() {
    if (!addOrderChoice) return;
    setAddingOrder(true);
    try {
      await applyMutation(() => api<ShipperMutationResult>(
        `/api/shippers/${id}/orders`, { method: "POST", body: JSON.stringify({
          orderId: addOrderChoice,
          ...(held && overrideGate.allowed && creditHoldReason.trim() ? { creditHoldReason: creditHoldReason.trim() } : {}),
        }) }));
      setAddOrderChoice("");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAddingOrder(false);
    }
  }

  async function removeOrder(shipperOrderId: string, label: string) {
    if (!confirm(`Remove order ${label} from this shipment? Its lines, containers and serials on this shipment are dropped.`)) return;
    try {
      await applyMutation(() => api<ShipperMutationResult>(
        `/api/shippers/${id}/orders/${shipperOrderId}`, { method: "DELETE" }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function voidAction() {
    if (!shipper) return;
    const reason = prompt(
      `Void shipment (Packing List ${shipper.shipperNumber})?\n\n` +
      "Every control on this shipment becomes read-only; its stored documents stay reprintable " +
      "forever. The shipment's own number and every order's shipment sequence are never reused, " +
      "and this cannot be undone through the UI.\n\n" +
      "Reason for voiding (recorded in the audit history):",
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to void a shipment."); return; }
    // Two separate try/catches (the order hub `voidAction` precedent): DELETE returns
    // `{ ok: true }`, not a fresh ShipperDetail, so picking up deletedAt needs a follow-up
    // `load()` — and if THAT fails, the void itself still succeeded.
    try {
      await api(`/api/shippers/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    // #158 — success path, before the follow-up load. The void is an `auditedSoftDelete("shipper", …)`
    // carrying the typed reason, and this page stays mounted (read-only) to show it.
    invalidateHistory();
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Shipment voided, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  /**
   * Reverse (#161; spec §5.2/§5.6). Non-optimistic and NOT `applyMutation`'s shape: the response is
   * a DIFFERENT document — the newly created reversal — so folding it into this page's `shipper`
   * state would leave the reversal's detail rendered under the original's URL. Navigate to it
   * instead, exactly as NewShipment does after a save; `page.tsx`'s `key={id}` remounts, and the
   * reversal's own GET recomputes the same §5.7 warning array through `shipperResponse` (the GET is
   * wrapped too), so nothing is raced past by the navigate.
   */
  async function reverseAction() {
    if (!shipper) return;
    // BEFORE the reason prompt and the request: this navigates to the reversal on success, and
    // this page's own line/container/serial grids may be holding unsaved edits. Asking after the
    // reversal exists would cancel nothing.
    if (!confirmDiscard()) return;
    const reason = prompt(
      `Reverse shipment (Packing List ${shipper.shipperNumber})?\n\n` +
      "A reversal is a NEW shipment carrying the negative of every line on this one: it un-ships " +
      "the goods, un-marks the completions this shipment made, and reopens the order — it is the " +
      "correction to use once an invoice has been raised and a void is refused. Both documents " +
      "then freeze as a pair until the reversal is voided, and each keeps its own packing-list " +
      "number forever.\n\n" +
      "Reason for reversing (recorded in the audit history):",
    );
    if (reason === null) return; // cancelled
    // The server's own sentence (`reverseShipper`), so the two cannot drift.
    if (!reason.trim()) { setError("A reason is required to reverse a shipment."); return; }
    setReversing(true);
    try {
      const res = await api<ShipperMutationResult>(
        `/api/shippers/${id}/reverse`, { method: "POST", body: JSON.stringify({ reason }) });
      setError(null);
      router.push(`/shipping/${res.shipper.id}`);
    } catch (e) {
      setError((e as Error).message);
      setReversing(false);
    }
  }

  if (!shipper) return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;

  const containerSum = shipper.orders.reduce((sum, o) => sum + o.containers.reduce((s, c) => s + c.count, 0), 0);
  const packageCountDisplay = shipper.packageCount === null ? String(containerSum) : String(shipper.packageCount);
  const shipToAddress = addresses.find((a) => a.id === shipper.shipToAddressId);

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          Packing List {shipper.shipperNumber}
          {shipper.bolNumber !== null && (
            <span className="ml-2 text-base font-normal text-slate-500">· BOL {shipper.bolNumber}</span>
          )}
          <span className="ml-3 text-base font-normal text-slate-500">
            <Link href={`/customers/${shipper.customerId}`} className="text-blue-700 underline">
              {shipper.customerCode} · {shipper.customerName}
            </Link>
          </span>
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* #161: beside Void, on the SAME `void_shipper` special action the reverse route
              enforces — but on its own ladder, which is not Void's (see `reverseGate`). */}
          <ReverseShipmentButton gate={reverseControlGate} busy={reversing} onClick={() => void reverseAction()} />
          <button onClick={() => void voidAction()} disabled={voidGate.disabled} title={voidGate.title}
                  className="rounded border border-red-600 px-3 py-1.5 text-sm text-red-600 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
            Void shipment
          </button>
        </div>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {voided && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm font-medium text-red-700">
          Voided — {voidReason ?? "see History for the reason"}
        </p>
      )}
      {/* #139: the pair freeze named once at the top, on top of every disabled control's title —
          hidden on a voided document, whose own banner already says why everything is locked. */}
      {!voided && pairFreeze !== null && (
        <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{pairFreeze}</p>
      )}
      {/* The credit-hold refusal (spec §5.4) only actually gates a NEW shipment's own creation
          (createShipper) — nothing on this existing-shipment edit page triggers that check today.
          Shown here anyway, informationally, so an editor of a shipment for a customer who is
          NOW on hold still sees it named and linked (the §5.14 discoverability habit), even
          though no button on this specific page is blocked by it. */}
      {customer?.creditHold && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">
          {customer.code} · {customer.name} is on credit hold —{" "}
          <Link href={`/customers/${customer.id}`} className="underline">see their record</Link>.
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="mb-3 list-disc space-y-0.5 rounded bg-amber-50 p-2 pl-7 text-sm text-amber-800">
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {loadError && <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{loadError}</p>}
      {customer?.shippingNotes && (
        <div className="mb-3 rounded bg-blue-50 p-2 text-sm text-blue-900">
          <span className="font-medium">Customer standing shipping notes: </span>{customer.shippingNotes}
        </div>
      )}

      {/* ---- Header ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Header</h2>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <label className="block">
            Ship-to address
            <select value={shipper.shipToAddressId ?? ""} disabled={!editGate.allowed} title={editGate.title}
                    onChange={(e) => void patchHeader({ shipToAddressId: e.target.value || null })}
                    className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50">
              <option value="">— none —</option>
              {addresses.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.street}, {a.city} {a.state}</option>)}
            </select>
          </label>
          <label className="block">
            Ship date
            <input type="date" value={shipper.shipDate} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void patchHeader({ shipDate: e.target.value })}
                   className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <label className="block">
            Carrier
            <select value={shipper.carrierId ?? ""} disabled={!editGate.allowed} title={editGate.title}
                    onChange={(e) => void patchHeader({ carrierId: e.target.value || null })}
                    className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50">
              <option value="">— none —</option>
              {shipper.carrierId && !carriers.some((c) => c.id === shipper.carrierId) && (
                <option value={shipper.carrierId}>{shipper.carrierName ?? "(inactive carrier)"}</option>
              )}
              {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="block">
            Route
            <input value={shipper.route} onFocus={editGuard.onFocusField("route")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => setShipper({ ...shipper, route: e.target.value })}
                   onBlur={(e) => editGuard.onBlurSave(e, (route) => void patchHeader({ route }))}
                   className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="col-span-2 block md:col-span-3">
            Comments
            <textarea value={shipper.comments} rows={2} onFocus={editGuard.onFocusField("comments")} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => setShipper({ ...shipper, comments: e.target.value })}
                      onBlur={(e) => editGuard.onBlurSave(e, (comments) => void patchHeader({ comments }))}
                      className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
          </label>
        </div>

        <div className="mt-4 border-t pt-3">
          <h3 className="mb-2 text-sm font-medium">Freight</h3>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={shipper.billFreight} disabled={!editGate.allowed} title={editGate.title}
                     onChange={(e) => void patchHeader({ billFreight: e.target.checked })} />
              Bill freight
            </label>
            <label className="block">
              Freight amount
              <input value={String(shipper.freightAmount ?? "")} inputMode="decimal" onFocus={editGuard.onFocusField("freightAmount")}
                     readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => setShipper({ ...shipper, freightAmount: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, commitFreightAmount)}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            <label className="block">
              Freight terms
              <select value={shipper.freightTerms} disabled={!editGate.allowed} title={editGate.title}
                      onChange={(e) => void patchHeader({ freightTerms: e.target.value as FreightTermsValue })}
                      className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50">
                {FREIGHT_TERMS.map((t) => <option key={t} value={t}>{FREIGHT_TERMS_LABELS[t]}</option>)}
              </select>
            </label>
            <label className="block">
              Freight class
              <input value={shipper.freightClass} onFocus={editGuard.onFocusField("freightClass")} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => setShipper({ ...shipper, freightClass: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, (freightClass) => void patchHeader({ freightClass }))}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            <label className="col-span-2 block">
              Freight description
              <input value={shipper.freightDescription} onFocus={editGuard.onFocusField("freightDescription")} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => setShipper({ ...shipper, freightDescription: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, (freightDescription) => void patchHeader({ freightDescription }))}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            <label className="block">
              Package count
              <input value={packageCountDisplay} inputMode="numeric" onFocus={editGuard.onFocusField("packageCount")}
                     readOnly={!editGate.allowed} title={editGate.allowed ? "Blank uses the current container count" : editGate.title}
                     onChange={(e) => setShipper({ ...shipper, packageCount: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, commitPackageCount)}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            <label className="block">
              Pro no
              <input value={shipper.proNumber} onFocus={editGuard.onFocusField("proNumber")} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => setShipper({ ...shipper, proNumber: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, (proNumber) => void patchHeader({ proNumber }))}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            <label className="block">
              SCAC
              <input value={shipper.scacCode} onFocus={editGuard.onFocusField("scacCode")} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => setShipper({ ...shipper, scacCode: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, (scacCode) => void patchHeader({ scacCode }))}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
          </div>
          {shipToAddress && (
            <p className="mt-2 text-xs text-slate-500">
              Ships to: {shipToAddress.name} — {shipToAddress.street}, {shipToAddress.city} {shipToAddress.state} {shipToAddress.zip}
            </p>
          )}
        </div>
      </section>

      {/* ---- Print (spec §11: all tickets, the BOL, and the cert checkbox pre-ticked) ---- */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded border bg-slate-50 p-3 text-sm">
        <button type="button" onClick={() => void printTicket(undefined, withCerts && certsGate.allowed)}
                disabled={!printGate.allowed || printing}
                title={printGate.title}
                className="rounded border bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
          {printing ? "Printing…" : "Print all tickets"}
        </button>
        {/* §5.16: the checkbox can be disabled for TWO reasons — the missing certs.view names
            itself, and on a voided shipment (certs.view held, so certsGate.title is undefined)
            the title falls through to printGate's voided reason rather than saying nothing
            (fix-wave 2026-08-06; the ShipmentOrderPanel checkbox carries the same pair). */}
        <label className={`flex items-center gap-1 ${certsGate.allowed ? "" : "text-slate-400"}`}
               title={certsGate.title ?? printGate.title}>
          <input type="checkbox" checked={withCerts && certsGate.allowed}
                 disabled={!certsGate.allowed || !printGate.allowed}
                 onChange={(e) => setWithCerts(e.target.checked)} />
          Also print certifications
        </label>
        <button type="button" onClick={() => void printBol()} disabled={!printGate.allowed || printing}
                title={printGate.title}
                className="rounded border bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
          {printing ? "Printing…" : "Print BOL"}
        </button>
        {printError && <span className="text-xs text-red-700">{printError}</span>}
        {certDocIds.length > 0 && (
          <span className="text-xs text-slate-600">
            {certDocIds.length} certification{certDocIds.length === 1 ? "" : "s"} archived:{" "}
            {certDocIds.map((docId, i) => (
              <a key={docId} href={`/api/documents/${docId}`} target="_blank" rel="noreferrer"
                 className="text-blue-700 underline">
                certification PDF{certDocIds.length === 1 ? "" : ` ${i + 1}`}{i < certDocIds.length - 1 ? ", " : ""}
              </a>
            ))}
          </span>
        )}
        {printWarnings.map((w) => (
          <span key={w} className="w-full text-xs text-amber-700">{w}</span>
        ))}
      </div>

      {/* ---- Add order ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Add order</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select value={addOrderChoice} onChange={(e) => setAddOrderChoice(e.target.value)}
                  disabled={extendGate.disabled || addableOrders.length === 0}
                  title={extendGate.allowed ? undefined : extendGate.title}
                  className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
            <option value="">{addableOrders.length === 0 ? "No unshipped orders for this customer" : "Choose an order…"}</option>
            {addableOrders.map((o) => (
              <option key={o.id} value={o.id}>#{o.orderNumber}{o.poNumber ? ` · PO ${o.poNumber}` : ""}</option>
            ))}
          </select>
          <button onClick={() => void addOrder()}
                  disabled={extendGate.disabled || !addOrderChoice || addingOrder
                    || (held && overrideGate.allowed && !creditHoldReason.trim())}
                  title={extendGate.allowed
                    ? (held && overrideGate.allowed && !creditHoldReason.trim()
                        ? "A reason is required to override the credit hold" : undefined)
                    : extendGate.title}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {addingOrder ? "Adding…" : "Add order"}
          </button>
          {held && overrideGate.allowed && !voided && (
            <input value={creditHoldReason} onChange={(e) => setCreditHoldReason(e.target.value)}
                   placeholder={`${shipper?.customerCode} is on credit hold — override reason (required)`}
                   className="min-w-72 rounded border px-2 py-1 text-sm" />
          )}
        </div>
      </section>

      {/* ---- One panel per order on the shipment ---- */}
      {shipper.orders.length === 0 && (
        <p className="mb-6 text-sm text-slate-500">No orders on this shipment.</p>
      )}
      {shipper.orders.map((so) => (
        <ShipmentOrderPanel
          key={so.id} shipperId={id} order={so} catalog={catalogs.get(so.orderId)}
          editGate={editGate} linesGate={extendGate}
          creditHoldReason={held && overrideGate.allowed ? creditHoldReason.trim() : ""}
          applyMutation={applyMutation} onError={setError}
          onRemove={() => void removeOrder(so.id, so.label)}
          printGate={printGate} printing={printing} certsGate={certsGate}
          onPrintTicket={(certWanted) => void printTicket(so.orderId, certWanted)}
        />
      ))}

      {/* ---- Documents + History ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Documents</h2>
        <ShipmentDocumentsList shipperId={id} viewGate={docsGate} refresh={docsRefresh} />
      </section>

      <div className="mb-6">
        <HistoryPanel entity="shipper" entityId={id} />
      </div>
    </div>
  );
}
