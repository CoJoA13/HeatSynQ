"use client";
// Shipment creation (`/shipping/new`, Task 14b — the screen the plan itself was missing). Unlike
// the edit page, this is ONE atomic nested POST: `createShipper` (src/server/shippers.ts) takes
// the whole graph — customer, ship-to, dates, carrier/freight, and per-order lines/containers/
// serials — in one call, because the packing-list number, every order's shipment sequence and the
// SHIPMENT-scope certs are all allocated inside one transaction. Deliberately NOT "create empty,
// then edit": that would burn a number on every abandoned draft and defeat the idempotency nonce
// (task-14b-brief.md). Order entry (src/app/orders/new/) is the build-then-submit-once precedent
// this page follows — with two deliberate differences:
//
// - **No draft autosave.** Order drafts are a spec-authorized audit exception scoped to ORDERS
//   (CLAUDE.md); no shipment-draft service exists and this phase adds no new audit exceptions.
//   Abandoning this form loses only typed text — it allocates nothing.
// - **State lives in the PARENT, as plain rows** — the orders/new `OrderDraftState` model — rather
//   than in per-grid `useBulkGrid` instances. The hook's overlay model composes user edits over
//   SERVER rows; here there are no server rows (nothing exists until the one POST), and the single
//   atomic submit needs every grid's rows in one place at save time, which per-child hook state
//   cannot give without ref plumbing. The grid MARKUP and the candidate prefill (`ordered −
//   shipped`, design §5.1) are the shared sibling-group copy either way: ../ShipmentGrids.tsx,
//   the same components the edit page renders.
//
// This is also the first screen from which the credit-hold gate (spec §5.4, owner ruling §3.7) is
// reachable by a human: the refusal names the customer and links to their record; an actor holding
// `override_credit_hold` gets the override with a REQUIRED reason; an actor without it sees the
// refusal with no dead-end controls (§5.16 — the disabled Save says why).
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate, gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { submitWithConflictRetry } from "@/lib/idempotent-save";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { FREIGHT_TERMS, FREIGHT_TERMS_LABELS, type FreightTermsValue } from "@/lib/cert-constants";
import { useUnsavedSection, confirmDiscard } from "@/lib/use-unsaved-section";
import {
  LinesGridView, ContainersGridView, SerialsGridView,
  prefillLineRow, prefillContainerRow, prefillSerialRow,
  type GridRowHandle, type LineFields, type ContainerFields, type SerialFields,
  type LineRow, type ContainerRow, type SerialRow,
  type LineCandidate, type ContainerCandidate, type SerialCandidate,
  type LineInfo, type ShippedInfo, type ContainerInfo, type SerialInfo,
} from "../ShipmentGrids";

// ---------------------------------------------------------------------------------------------
// Types — local mirrors of server row shapes, never imports from src/server/** (CLAUDE.md).
// ---------------------------------------------------------------------------------------------

/** Slice of `GET /api/customers`'s `CustomerRow` (src/server/customers.ts). */
type CustomerOption = { id: string; code: string; name: string; creditHold: boolean; shippingNotes: string };
/** Slice of `GET /api/customers/[id]/addresses`'s `AddressRow` (src/server/customer-addresses.ts). */
type Address = { id: string; kind: string; name: string; street: string; city: string; state: string; zip: string };
type CarrierOption = { id: string; name: string };
/** Slice of `GET /api/orders`'s `BoardRow` (src/server/orders.ts) — the order-picker candidates. */
type OrderOption = { id: string; orderNumber: number; poNumber: string };

/** Slice of `GET /api/orders/[id]`'s `OrderDetail` (src/server/orders.ts) this page reads —
 *  including `orderLineShippedToDate`, the per-line ledger widened onto the order detail for
 *  exactly this page's prefill (Task 14b; there is no shipper yet to read it from). */
type OrderDetailLite = {
  id: string; customerId: string; orderNumber: number; poNumber: string; customerJobNo: string;
  orderLineShippedToDate: { orderLineId: string; shippedToDateQty: number; shippedToDateWeight: number }[];
  lines: { id: string; position: number; qty: number; weight: number; part: { partNumber: string; name: string } }[];
  containers: { id: string; count: number; customerContainerId: string; type: { name: string } }[];
  serials: { id: string; lineId: string; serial: string; description: string }[];
};

/** One selected order: its display identity, its full catalog (for the add pickers and the info
 *  columns), the shipped-to-date ledger the prefill was derived from, and the three editable row
 *  arrays — every row `isNew` by construction, since nothing exists server-side yet. */
type SelectedOrder = {
  orderId: string; orderNumber: number; poNumber: string; customerJobNo: string;
  lineCandidates: LineCandidate[];
  containerCandidates: ContainerCandidate[];
  serialCandidates: SerialCandidate[];
  infoByLineId: Map<string, LineInfo>;
  shippedByLineId: Map<string, ShippedInfo>;
  containerInfoById: Map<string, ContainerInfo>;
  serialInfoById: Map<string, SerialInfo>;
  lines: LineRow[];
  containers: ContainerRow[];
  serials: SerialRow[];
};

/** `POST /api/shippers`' response — `createShipper`'s `{ shipper, warnings, deduped }`. `deduped`
 *  marks the replay path: this same `clientRequestId` already created a shipment, and this
 *  response IS it (Task 8) — treated exactly like any other success: navigate to it. */
type CreateResult = {
  shipper: { id: string; shipperNumber: number };
  warnings: string[];
  deduped?: boolean;
};

function newRows<F extends Record<string, string>>(fields: F[]): (GridRowHandle & F)[] {
  return fields.map((f) => ({ key: crypto.randomUUID(), isNew: true, ...f }));
}

/** Renders the server's own credit-hold refusal with its `/customers/<id>` path as a real link
 *  (spec §5.4: named AND linked) rather than inert text. Any other message passes through. */
function ErrorText({ message }: { message: string }) {
  const m = message.match(/^(.*) — see (\/customers\/\S+) to lift it$/);
  if (!m) return <>{message}</>;
  return <>{m[1]} — <Link href={m[2]} className="underline">see their record</Link> to lift it.</>;
}

export function NewShipment() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();

  // The idempotency nonce (Task 8, spec §5.3): minted once when the form MOUNTS and sent with
  // every save attempt, so a retry — the automatic 409 retry below, or the operator clicking Save
  // again after a network hiccup — returns the shipment the first attempt already created
  // (`deduped`) instead of burning a second packing-list number.
  const [clientRequestId] = useState(() => crypto.randomUUID());

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [carriers, setCarriers] = useState<CarrierOption[]>([]);
  const [candidates, setCandidates] = useState<OrderOption[]>([]);
  const [selected, setSelected] = useState<SelectedOrder[]>([]);
  const [addChoice, setAddChoice] = useState("");
  const [addingOrder, setAddingOrder] = useState(false);

  // Header fields — the edit page's field set (task-14b-brief.md Step 1), as plain typed state
  // submitted once. Numeric-ish fields stay strings until the body is built (the wire-shape
  // convention every form in this codebase uses).
  const [shipToAddressId, setShipToAddressId] = useState("");

  // Captured once so the dirty predicate below can tell "the operator chose this date" from
  // "this is the default the form opened with".
  const [defaultShipDate] = useState(() => formatDateOnly(todayDateOnly()));
  const [shipDate, setShipDate] = useState(defaultShipDate);
  const [carrierId, setCarrierId] = useState("");
  const [route, setRoute] = useState("");
  const [comments, setComments] = useState("");
  const [billFreight, setBillFreight] = useState(false);
  const [freightAmount, setFreightAmount] = useState("");
  // Captured for the same reason as `defaultShipDate`: this control opens on a value, so only a
  // CHANGE from it is work.
  const [defaultFreightTerms] = useState<FreightTermsValue>("PREPAID");
  const [freightTerms, setFreightTerms] = useState<FreightTermsValue>(defaultFreightTerms);
  const [freightClass, setFreightClass] = useState("");
  const [freightDescription, setFreightDescription] = useState("");
  const [packageCount, setPackageCount] = useState("");
  const [proNumber, setProNumber] = useState("");
  const [scacCode, setScacCode] = useState("");
  const [creditHoldReason, setCreditHoldReason] = useState("");

  const [error, setError] = useState<string | null>(null);
  // Background list/picker fetch failures get their OWN banner, never the shared `error` a later
  // action clears (the orders/new `loadError` precedent).
  const [loadError, setLoadError] = useState<string | null>(null);
  const addLoadError = useCallback((message: string) => {
    setLoadError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);
  const [saving, setSaving] = useState(false);
  // Set only when a save SUCCEEDS with non-empty warnings (§5.7) — the orders/new `savedOrder`
  // precedent: a warning returned alongside a successful save must be SEEN, not raced past by an
  // immediate navigate. Zero warnings navigates immediately.
  const [savedShipment, setSavedShipment] =
    useState<{ id: string; shipperNumber: number; warnings: string[] } | null>(null);

  // A whole shipment is drafted here in LOCAL state — the orders picked, their line/container/
  // serial grids, the header and the freight block — and none of it is persisted anywhere until
  // "Save shipment". This page has no `dirty` flag, which is why the registration census missed it
  // (Codex P1 on #272): the draft IS the accumulated state, so "has the operator started one" is
  // the honest question.
  //
  // EVERY editable field counts, not just the picked orders. The header and freight controls are
  // live before any order is added, so `selected.length > 0` alone discarded a typed carrier,
  // route, comments, ship-to or freight block without a word — the same silent loss one layer up
  // (Codex P1, round 5). The customer selector is deliberately NOT in this list: choosing a
  // customer is how you populate the order picker, so it reads as a filter rather than as work,
  // and `pickCustomer` guards the reset it performs separately.
  //
  // `savedShipment` ends it. Once the shipment exists on the server, `selected` is still populated
  // but there is nothing left to lose, and prompting there asks the operator to discard work that
  // is already saved — a false alarm on the screen that just told them it succeeded.
  const draftStarted =
    savedShipment === null && (
      selected.length > 0
      || shipToAddressId !== "" || carrierId !== "" || route.trim() !== "" || comments.trim() !== ""
      || shipDate !== defaultShipDate
      // EVERY field `buildBody` submits, not a sample of them. The first pass listed the ones that
      // came to mind and left freight terms/description, package count, pro no, SCAC and the
      // credit-hold reason out — each of them typed work, each of them sent to the server, each of
      // them silently discarded (Codex P1, round 6). If a field reaches the payload it belongs here.
      || billFreight || freightAmount.trim() !== "" || freightClass.trim() !== ""
      || freightTerms !== defaultFreightTerms || freightDescription.trim() !== ""
      || packageCount.trim() !== "" || proNumber.trim() !== "" || scacCode.trim() !== ""
      || creditHoldReason.trim() !== ""
    );
  useUnsavedSection(draftStarted, "New shipment");

  /**
   * Whether this form is still on screen, read after the create POST settles.
   *
   * KNOWN LIMITATION, stated because it is not fully fixed: leaving while a save is in flight
   * still creates the shipment, even though the prompt the operator accepted said "discard".
   * Nothing on the client can un-send a request the server has already taken, and aborting the
   * fetch would not help — `submitWithConflictRetry` sends a `clientRequestId` precisely so a
   * retry lands as the same write, not a second one. The complete fix is for the guard to REFUSE
   * rather than ask while a save is pending, which needs a blocking mode `unsaved-guard.ts` does
   * not have. What this ref does fix is the part that is ours: a settled save no longer navigates
   * a page the operator has already left.
   */
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const customersGate = gate(perms, "customers.view");
  const ordersGate = gate(perms, "orders.view");
  const createGate = gate(perms, "shipping.create");
  const overrideGate = gateDo(perms, "override_credit_hold");

  // ---- mount-time fetches ----

  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers)
      .catch((e) => addLoadError(`Could not load customers: ${(e as Error).message}`));
  }, [customersGate.allowed, addLoadError]);

  useEffect(() => {
    api<CarrierOption[]>("/api/picklists/carrier").then(setCarriers)
      .catch((e) => addLoadError(`Could not load carriers: ${(e as Error).message}`));
  }, [addLoadError]);

  // ---- per-customer fetches, both `useLatest`-gated against a fast customer switch ----

  // Ship-to selector — the customer's live SHIP_TO addresses (the shipment edit page precedent:
  // `listAddresses` is active-only by default, so the kind filter is the only narrowing needed).
  const addressesLatest = useLatest();
  useEffect(() => {
    setAddresses([]);
    if (!customerId || !customersGate.allowed) return;
    const t = addressesLatest.next();
    api<Address[]>(`/api/customers/${customerId}/addresses`)
      .then((rows) => { if (addressesLatest.isCurrent(t)) setAddresses(rows.filter((a) => a.kind === "SHIP_TO")); })
      .catch((e) => { if (addressesLatest.isCurrent(t)) addLoadError(`Could not load ship-to addresses: ${(e as Error).message}`); });
  }, [customerId, customersGate.allowed, addressesLatest, addLoadError]);

  // Order candidates: the customer's own orders with unshipped lines (OPEN/PARTIAL_SHIPPED —
  // voided and SHIPPED are excluded by construction), minus whatever is already selected — the
  // shipment edit page's add-order picker precedent.
  const selectedOrderIds = selected.map((o) => o.orderId).join(",");
  const candidatesLatest = useLatest();
  useEffect(() => {
    setCandidates([]);
    if (!customerId || !ordersGate.allowed) return;
    const t = candidatesLatest.next();
    api<OrderOption[]>(`/api/orders?customerId=${customerId}&status=OPEN,PARTIAL_SHIPPED`)
      .then((rows) => {
        if (!candidatesLatest.isCurrent(t)) return;
        const already = new Set(selectedOrderIds ? selectedOrderIds.split(",") : []);
        setCandidates(rows.filter((r) => !already.has(r.id)));
      })
      .catch((e) => { if (candidatesLatest.isCurrent(t)) addLoadError(`Could not load this customer's orders: ${(e as Error).message}`); });
  }, [customerId, ordersGate.allowed, selectedOrderIds, candidatesLatest, addLoadError]);

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  const held = selectedCustomer?.creditHold ?? false;
  // §5.16: the disabled state says why. Without the override action a held customer's shipment
  // cannot be saved at all — the Save button is disabled with the reason, and no reason field is
  // rendered (a control that could never lead anywhere is a dead end, not an affordance).
  const holdBlocked = held && !overrideGate.allowed;
  const saveDisabledTitle = createGate.disabled
    ? createGate.title
    : holdBlocked && selectedCustomer
      ? `${selectedCustomer.code} · ${selectedCustomer.name} is on credit hold — saving requires the override_credit_hold action`
      : undefined;

  // #51: the same latest-token gate the candidates fetch uses (`candidatesLatest`), on its own
  // sequence — bumped by `addOrder`'s dispatch AND by `pickCustomer`, so an add-order response
  // that lands after a customer switch is dropped instead of trusted by a stale-against-stale
  // equality check. The server would still refuse the cross-customer save at the end; this keeps
  // the panel from ever showing it.
  const addOrderLatest = useLatest();

  function pickCustomer(id: string) {
    if (id === customerId) return;
    // Switching customer resets `selected` — every picked order and its line/container/serial
    // draft — and that is a destruction with no click on a link and no unload, so no Shell guard
    // sees it (Codex P1, round 5; the same shape as the receivables apply-panel collapse). Ask
    // first. The select is CONTROLLED by `customerId`, so returning here leaves it showing the
    // customer the operator actually still has.
    // Everything this reset DESTROYS, not just the orders: it also clears the ship-to and the
    // credit-hold override reason, so typing either with no order added yet was wiped without
    // a word (Codex P2, round 6). The condition has to name the same state the reset does.
    const customerOwnedWork =
      selected.length > 0 || shipToAddressId !== "" || creditHoldReason.trim() !== "";
    if (customerOwnedWork && !confirmDiscard()) return;
    setCustomerId(id);
    // Everything downstream of the customer is that customer's own data — a switch resets it all
    // (orders selected, ship-to, the override reason). Header text fields are customer-neutral
    // and survive.
    setSelected([]);
    setShipToAddressId("");
    setAddChoice("");
    setCreditHoldReason("");
    setError(null);
    // #51: invalidate any add-order response still in flight — its closure captured the OLD
    // customerId, so its own `od.customerId !== customerId` guard compares old against old and
    // would append the previous customer's order into the panel this reset just cleared.
    addOrderLatest.next();
  }

  // ---- add / remove orders ----

  async function addOrder() {
    if (!addChoice || addingOrder) return;
    setAddingOrder(true);
    const t = addOrderLatest.next();
    try {
      const od = await api<OrderDetailLite>(`/api/orders/${addChoice}`);
      if (!addOrderLatest.isCurrent(t)) return; // the customer changed while this was in flight
      if (od.customerId !== customerId) {
        setError(`Order #${od.orderNumber} belongs to another customer.`);
        return;
      }
      const shippedByLineId = new Map<string, ShippedInfo>(
        od.orderLineShippedToDate.map((e) => [e.orderLineId, { qty: e.shippedToDateQty, weight: e.shippedToDateWeight }]));
      const entry: SelectedOrder = {
        orderId: od.id, orderNumber: od.orderNumber, poNumber: od.poNumber, customerJobNo: od.customerJobNo,
        lineCandidates: od.lines.map((l) => ({ id: l.id, partNumber: l.part.partNumber, qty: l.qty, weight: l.weight })),
        containerCandidates: od.containers.map((c) => ({
          id: c.id, typeName: c.type.name, customerContainerId: c.customerContainerId, count: c.count,
        })),
        serialCandidates: od.serials.map((s) => ({ id: s.id, serial: s.serial })),
        infoByLineId: new Map(od.lines.map((l) => [l.id, {
          partNumber: l.part.partNumber, partName: l.part.name, orderedQty: l.qty, orderedWeight: l.weight,
        }])),
        shippedByLineId,
        containerInfoById: new Map(od.containers.map((c) => [c.id, {
          typeName: c.type.name, customerContainerId: c.customerContainerId,
        }])),
        serialInfoById: new Map(od.serials.map((s) => [s.id, { serial: s.serial, description: s.description }])),
        // Prefilled to the remainder (task-14b-brief.md Step 2, design §5.1): every line at
        // `ordered − shipped`, every container at its order count, every serial in with
        // print-on-shipper on — a DEFAULT the operator edits down, never a cap.
        lines: newRows(od.lines.map((l) => prefillLineRow({ id: l.id, qty: l.qty, weight: l.weight }, shippedByLineId.get(l.id)))),
        containers: newRows(od.containers.map(prefillContainerRow)),
        serials: newRows(od.serials.map(prefillSerialRow)),
      };
      setSelected((cur) => (cur.some((o) => o.orderId === od.id) ? cur : [...cur, entry]));
      setAddChoice("");
      setError(null);
    } catch (e) {
      // Ticket-gated like the success path (#51) — a superseded request's failure must not
      // surface an error about a customer the operator has already left.
      if (addOrderLatest.isCurrent(t)) setError((e as Error).message);
    } finally {
      setAddingOrder(false);
    }
  }

  function removeOrder(orderId: string) {
    setSelected((cur) => cur.filter((o) => o.orderId !== orderId));
  }

  // ---- per-grid row mutators (parent-owned rows; see the header comment for why not useBulkGrid) ----

  function patchOrder(orderId: string, patch: (o: SelectedOrder) => SelectedOrder) {
    setSelected((cur) => cur.map((o) => (o.orderId === orderId ? patch(o) : o)));
  }
  function gridPatch<F extends Record<string, string>>(rows: (GridRowHandle & F)[], row: GridRowHandle, field: keyof F & string, value: string) {
    return rows.map((r) => (r.key === row.key ? { ...r, [field]: value } : r));
  }
  function gridRemove<F extends Record<string, string>>(rows: (GridRowHandle & F)[], row: GridRowHandle) {
    return rows.filter((r) => r.key !== row.key);
  }

  // ---- validation + save ----

  /** Client-side pre-check for the common mistakes — a UX nicety, not a substitute for the
   *  server's authoritative validation, which still runs (and still wins) on every save. */
  function validate(): string | null {
    if (!customerId) return "Pick a customer.";
    if (selected.length === 0) return "Add at least one order.";
    if (!shipDate) return "Enter a ship date.";
    for (const o of selected) {
      for (const [i, row] of o.lines.entries()) {
        const label = `Order #${o.orderNumber} line ${i + 1}`;
        const qty = Number(row.qty);
        if (!Number.isInteger(qty) || qty < 0) return `${label}: ship-now quantity must be a whole number of at least 0.`;
        const weight = row.weight.trim();
        if (weight === "" || !(Number(weight) >= 0)) return `${label}: ship-now weight must be a number of at least 0.`;
      }
      for (const [i, row] of o.containers.entries()) {
        const count = Number(row.count);
        if (!Number.isInteger(count) || count < 1) return `Order #${o.orderNumber} container ${i + 1}: count must be a whole number of at least 1.`;
      }
    }
    if (!selected.some((o) => o.lines.some((r) => Number(r.qty) > 0))) {
      return "A shipment needs at least one line with a positive quantity.";
    }
    if (packageCount.trim() !== "" && (!Number.isInteger(Number(packageCount)) || Number(packageCount) < 0)) {
      return "Package count must be a whole number of at least 0.";
    }
    if (freightAmount.trim() !== "" && !(Number(freightAmount) >= 0)) {
      return "Freight amount must be a number of at least 0.";
    }
    if (held && overrideGate.allowed && !creditHoldReason.trim()) {
      return "A reason is required to override the credit hold.";
    }
    return null;
  }

  function buildBody() {
    return {
      clientRequestId,
      customerId,
      shipToAddressId: shipToAddressId || null,
      shipDate,
      carrierId: carrierId || null,
      route,
      comments,
      billFreight,
      // Blank optional numerics are OMITTED (undefined vanishes under JSON.stringify), the exact
      // "not provided" the server's optional fields mean — never an empty string it would reject.
      freightAmount: freightAmount.trim() === "" ? undefined : freightAmount.trim(),
      freightTerms,
      freightClass,
      freightDescription,
      packageCount: packageCount.trim() === "" ? undefined : Number(packageCount),
      proNumber,
      scacCode,
      // Sent only when an override is actually in play — the field is legal-but-ignored server-side
      // otherwise, and never sending it keeps the intent unambiguous in the request too.
      ...(held && overrideGate.allowed && creditHoldReason.trim()
        ? { creditHoldReason: creditHoldReason.trim() } : {}),
      orders: selected.map((o) => ({
        orderId: o.orderId,
        lines: o.lines.map((r) => ({
          orderLineId: r.orderLineId, qty: Number(r.qty), weight: r.weight.trim(),
          lineComplete: r.lineComplete === "true",
        })),
        containers: o.containers.map((r) => ({ orderContainerId: r.orderContainerId, count: Number(r.count) })),
        serials: o.serials.map((r) => ({ orderSerialId: r.orderSerialId, printOnShipper: r.printOnShipper === "true" })),
      })),
    };
  }

  async function handleSave() {
    const problem = validate();
    if (problem) { setError(problem); return; }
    setError(null);
    setSaving(true);
    // Built ONCE and handed to the retry by reference (the orders/new precedent, fix-wave R4
    // finding 5): a 409 is the documented wrote-nothing outcome, and the retry carrying the SAME
    // clientRequestId is what makes it land as the same request rather than a second shipment.
    const body = buildBody();
    try {
      const result = await submitWithConflictRetry(body, (b) =>
        api<CreateResult>("/api/shippers", { method: "POST", body: JSON.stringify(b) }));
      // The operator can leave while this POST is in flight — the guard ASKS rather than blocks,
      // and accepting it navigates. Landing here afterwards used to run `router.push` and pull
      // them back to a page they had just chosen to leave (Codex P1 on #272). The request cannot
      // be un-sent, so the shipment does exist; what this stops is the navigation, which is the
      // half that is still ours to control. See the note on `mounted` for the half that is not.
      if (!mounted.current) return;
      if (result.warnings.length > 0) {
        // §5.7 warnings returned by the save are SHOWN, never raced past by the navigate.
        setSaving(false);
        setSavedShipment({ id: result.shipper.id, shipperNumber: result.shipper.shipperNumber, warnings: result.warnings });
      } else {
        router.push(`/shipping/${result.shipper.id}`);
      }
    } catch (e) {
      // §5.13: no reload after an error — every field stays exactly as typed.
      setSaving(false);
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  const shipToAddress = addresses.find((a) => a.id === shipToAddressId);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">New shipment</h1>
        <Link href="/shipping" className="text-sm text-blue-700 underline">← Back to shipping</Link>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700"><ErrorText message={error ?? permsError ?? ""} /></p>
      )}
      {loadError && <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{loadError}</p>}

      {savedShipment ? (
        // A save that succeeded WITH warnings stops here instead of navigating straight past them
        // (the orders/new precedent; owner's "visibly, never silently" ruling). The form is gone —
        // the shipment exists now, and a stray second Save from a kept-alive form is exactly what
        // this page must never produce.
        <div className="rounded border border-green-300 bg-green-50 p-4">
          <p className="mb-2 font-medium">Packing List {savedShipment.shipperNumber} saved.</p>
          <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-amber-800">
            {savedShipment.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
          <button type="button" onClick={() => router.push(`/shipping/${savedShipment.id}`)}
                  className="rounded bg-slate-800 px-4 py-2 text-sm text-white">
            Go to shipment
          </button>
        </div>
      ) : (
        <>
          {/* ---- Customer ---- */}
          <section className="mb-6 rounded border bg-white p-4">
            <h2 className="mb-2 font-medium">Customer</h2>
            <select value={customerId} onChange={(e) => pickCustomer(e.target.value)}
                    disabled={!customersGate.allowed} title={customersGate.title} aria-label="Customer"
                    className="w-full max-w-md rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
              <option value="">— choose a customer —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>

            {/* The credit-hold gate, made visible BEFORE the refused round trip (spec §5.4): named,
                linked, and — only for an actor who can actually override — the required reason. */}
            {selectedCustomer?.creditHold && (
              <div className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">
                <p>
                  {selectedCustomer.code} · {selectedCustomer.name} is on credit hold —{" "}
                  <Link href={`/customers/${selectedCustomer.id}`} className="underline">see their record</Link>.
                </p>
                {overrideGate.allowed ? (
                  <label className="mt-2 block">
                    Saving this shipment records a credit-hold override. Reason (required, kept in the audit history — printed nowhere):
                    <input value={creditHoldReason} onChange={(e) => setCreditHoldReason(e.target.value)}
                           aria-label="Credit hold override reason"
                           className="mt-1 w-full rounded border border-red-300 px-2 py-1" />
                  </label>
                ) : (
                  <p className="mt-1">Saving a shipment for them requires the <span className="font-mono">override_credit_hold</span> action.</p>
                )}
              </div>
            )}
            {selectedCustomer?.shippingNotes && (
              <div className="mt-2 rounded bg-blue-50 p-2 text-sm text-blue-900">
                <span className="font-medium">Customer standing shipping notes: </span>{selectedCustomer.shippingNotes}
              </div>
            )}
          </section>

          {/* ---- Header (the edit page's field set) ---- */}
          <section className="mb-6 rounded border bg-white p-4">
            <h2 className="mb-2 font-medium">Header</h2>
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              <label className="block">
                Ship-to address
                <select value={shipToAddressId} onChange={(e) => setShipToAddressId(e.target.value)}
                        disabled={!customerId} title={customerId ? undefined : "Pick a customer first"}
                        className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50">
                  <option value="">— none —</option>
                  {addresses.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.street}, {a.city} {a.state}</option>)}
                </select>
              </label>
              <label className="block">
                Ship date
                <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)}
                       className="mt-1 w-full rounded border px-2 py-1" />
              </label>
              <label className="block">
                Carrier
                <select value={carrierId} onChange={(e) => setCarrierId(e.target.value)}
                        className="mt-1 w-full rounded border px-2 py-1">
                  <option value="">— none —</option>
                  {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="block">
                Route
                <input value={route} onChange={(e) => setRoute(e.target.value)}
                       className="mt-1 w-full rounded border px-2 py-1" />
              </label>
              <label className="col-span-2 block md:col-span-3">
                Comments
                <textarea value={comments} rows={2} onChange={(e) => setComments(e.target.value)}
                          className="mt-1 w-full rounded border p-2" />
              </label>
            </div>

            <div className="mt-4 border-t pt-3">
              <h3 className="mb-2 text-sm font-medium">Freight</h3>
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={billFreight} onChange={(e) => setBillFreight(e.target.checked)} />
                  Bill freight
                </label>
                <label className="block">
                  Freight amount
                  <input value={freightAmount} inputMode="decimal" onChange={(e) => setFreightAmount(e.target.value)}
                         className="mt-1 w-full rounded border px-2 py-1" />
                </label>
                <label className="block">
                  Freight terms
                  <select value={freightTerms} onChange={(e) => setFreightTerms(e.target.value as FreightTermsValue)}
                          className="mt-1 w-full rounded border px-2 py-1">
                    {FREIGHT_TERMS.map((t) => <option key={t} value={t}>{FREIGHT_TERMS_LABELS[t]}</option>)}
                  </select>
                </label>
                <label className="block">
                  Freight class
                  <input value={freightClass} onChange={(e) => setFreightClass(e.target.value)}
                         className="mt-1 w-full rounded border px-2 py-1" />
                </label>
                <label className="col-span-2 block">
                  Freight description
                  <input value={freightDescription} onChange={(e) => setFreightDescription(e.target.value)}
                         className="mt-1 w-full rounded border px-2 py-1" />
                </label>
                <label className="block">
                  Package count
                  <input value={packageCount} inputMode="numeric" onChange={(e) => setPackageCount(e.target.value)}
                         placeholder="container count" title="Blank uses the current container count"
                         className="mt-1 w-full rounded border px-2 py-1" />
                </label>
                <label className="block">
                  Pro no
                  <input value={proNumber} onChange={(e) => setProNumber(e.target.value)}
                         className="mt-1 w-full rounded border px-2 py-1" />
                </label>
                <label className="block">
                  SCAC
                  <input value={scacCode} onChange={(e) => setScacCode(e.target.value)}
                         className="mt-1 w-full rounded border px-2 py-1" />
                </label>
              </div>
              {shipToAddress && (
                <p className="mt-2 text-xs text-slate-500">
                  Ships to: {shipToAddress.name} — {shipToAddress.street}, {shipToAddress.city} {shipToAddress.state} {shipToAddress.zip}
                </p>
              )}
            </div>
          </section>

          {/* ---- Add order ---- */}
          <section className="mb-6 rounded border bg-white p-4">
            <h2 className="mb-2 font-medium">Orders</h2>
            {!customerId && <p className="mb-2 text-sm text-slate-500">Pick a customer to add their orders.</p>}
            <div className="flex flex-wrap items-center gap-2">
              <select value={addChoice} onChange={(e) => setAddChoice(e.target.value)}
                      disabled={!customerId || !ordersGate.allowed || candidates.length === 0}
                      title={ordersGate.allowed ? undefined : ordersGate.title} aria-label="Add order"
                      className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
                <option value="">
                  {!customerId ? "Pick a customer first"
                    : candidates.length === 0 ? "No unshipped orders for this customer" : "Choose an order…"}
                </option>
                {candidates.map((o) => (
                  <option key={o.id} value={o.id}>#{o.orderNumber}{o.poNumber ? ` · PO ${o.poNumber}` : ""}</option>
                ))}
              </select>
              <button onClick={() => void addOrder()} disabled={!addChoice || addingOrder}
                      className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                {addingOrder ? "Adding…" : "Add order"}
              </button>
            </div>
          </section>

          {/* ---- One panel per selected order — the shared sibling-group grids ---- */}
          {selected.map((o) => (
            <section key={o.orderId} className="mb-6 rounded border bg-white p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-lg font-semibold">
                  <Link href={`/orders/${o.orderId}`} className="text-blue-700 underline">#{o.orderNumber}</Link>
                  {o.poNumber && <span className="ml-2 text-sm font-normal text-slate-500">PO {o.poNumber}</span>}
                  {o.customerJobNo && <span className="ml-2 text-sm font-normal text-slate-500">Job {o.customerJobNo}</span>}
                </h3>
                <button onClick={() => removeOrder(o.orderId)}
                        className="text-xs text-red-600">
                  Remove order
                </button>
              </div>

              <LinesGridView
                rows={o.lines}
                candidates={o.lineCandidates.filter((c) => !o.lines.some((r) => r.orderLineId === c.id))}
                infoByLineId={o.infoByLineId} shippedByLineId={o.shippedByLineId} gate={createGate}
                onPatch={(row, field, value) => patchOrder(o.orderId, (cur) => ({ ...cur, lines: gridPatch<LineFields>(cur.lines, row, field, value) }))}
                onRemove={(row) => patchOrder(o.orderId, (cur) => ({ ...cur, lines: gridRemove(cur.lines, row) }))}
                onAddRows={(rows) => patchOrder(o.orderId, (cur) => ({ ...cur, lines: [...cur.lines, ...newRows(rows)] }))} />
              <div className="my-4 border-t" />
              <ContainersGridView
                rows={o.containers}
                candidates={o.containerCandidates.filter((c) => !o.containers.some((r) => r.orderContainerId === c.id))}
                infoById={o.containerInfoById} gate={createGate}
                onPatch={(row, field, value) => patchOrder(o.orderId, (cur) => ({ ...cur, containers: gridPatch<ContainerFields>(cur.containers, row, field, value) }))}
                onRemove={(row) => patchOrder(o.orderId, (cur) => ({ ...cur, containers: gridRemove(cur.containers, row) }))}
                onAddRows={(rows) => patchOrder(o.orderId, (cur) => ({ ...cur, containers: [...cur.containers, ...newRows(rows)] }))} />
              <div className="my-4 border-t" />
              <SerialsGridView
                rows={o.serials}
                candidates={o.serialCandidates.filter((c) => !o.serials.some((r) => r.orderSerialId === c.id))}
                infoById={o.serialInfoById} gate={createGate}
                onPatch={(row, field, value) => patchOrder(o.orderId, (cur) => ({ ...cur, serials: gridPatch<SerialFields>(cur.serials, row, field, value) }))}
                onRemove={(row) => patchOrder(o.orderId, (cur) => ({ ...cur, serials: gridRemove(cur.serials, row) }))}
                onAddRows={(rows) => patchOrder(o.orderId, (cur) => ({ ...cur, serials: [...cur.serials, ...newRows(rows)] }))} />
            </section>
          ))}

          <div className="mb-10 flex items-center gap-3">
            <button type="button" onClick={() => void handleSave()}
                    disabled={saving || createGate.disabled || holdBlocked}
                    title={saveDisabledTitle}
                    className="rounded bg-slate-800 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
              {saving ? "Saving…" : "Save shipment"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
