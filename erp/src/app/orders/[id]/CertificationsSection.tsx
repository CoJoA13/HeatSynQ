"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useLatest } from "@/lib/use-latest";
import { CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import type { OrderLoad } from "./page";

/** Local mirror of src/server/certs.ts's `CertRow`, narrowed to what this section renders — not
 *  imported from src/server/** (CLAUDE.md; the CertList.tsx precedent). Dates cross the wire as
 *  ISO strings. */
export type CertRow = {
  id: string; scope: CertScopeValue; loadNumber: number | null;
  shipperId: string | null; shipperNumber: number | null; sequence: number | null;
  printedAt: string | null; deletedAt: string | null;
  readingCount: number; passedCount: number; failCount: number;
};

/** Local mirror of `ShipperRow` (src/server/shippers.ts) narrowed to what the scope picker needs
 *  — the ShipmentsSection.tsx precedent, same endpoint. */
type ShipmentOption = {
  id: string; shipperNumber: number; deletedAt: string | null;
  /** Set when this shipment is a REVERSAL (§5.6): its lines carry negative quantities. #183 keeps it
   *  out of the picker — `createCert` refuses a shipment-scope cert on one. */
  reversesShipperNumber: number | null;
};

/**
 * One scope INSTANCE a certification can be raised for (#165) — the thing the picker picks and
 * the three creation routes are keyed on. ORDER carries nothing, LOAD a load number, SHIPMENT a
 * shipment id: exactly `assertScopeShape`'s per-scope shape (spec §4.1), which is what makes each
 * variant map to precisely one endpoint.
 */
export type CertTarget =
  | { scope: "ORDER" }
  | { scope: "LOAD"; loadNumber: number }
  | { scope: "SHIPMENT"; shipperId: string };

/** The `<option value>` / in-flight key for a target. Round-trips through `parseTarget`. */
export function targetKey(target: CertTarget): string {
  if (target.scope === "LOAD") return `LOAD:${target.loadNumber}`;
  if (target.scope === "SHIPMENT") return `SHIPMENT:${target.shipperId}`;
  return "ORDER";
}

/** The inverse. `null` for anything this component did not itself emit — deliberately NOT a
 *  fallback to ORDER, which would turn an unrecognized key into a silent order-scope create. */
export function parseTarget(key: string): CertTarget | null {
  if (key === "ORDER") return { scope: "ORDER" };
  if (key.startsWith("LOAD:")) {
    const loadNumber = Number(key.slice("LOAD:".length));
    return Number.isSafeInteger(loadNumber) && loadNumber > 0 ? { scope: "LOAD", loadNumber } : null;
  }
  if (key.startsWith("SHIPMENT:")) {
    const shipperId = key.slice("SHIPMENT:".length);
    return shipperId ? { scope: "SHIPMENT", shipperId } : null;
  }
  return null;
}

/**
 * The LIVE cert already covering `target`, if this order has one — §5.14's "name the thing that
 * is blocking you", applied to the walkthrough's blind-collision rough edge: `createCert`'s
 * refusal says a cert exists for that scope but never says WHICH, so the operator learns nothing
 * they can act on.
 *
 * This is NOT a second uniqueness rule. Uniqueness stays service-enforced under the order claim
 * (CLAUDE.md — `Cert` has no unique column, and no index could express it), and nothing here
 * refuses, hides or disables a create: the control always posts, the server always decides, and
 * this only IDENTIFIES the row behind a refusal that already happened.
 */
export function coveringCert(rows: CertRow[], target: CertTarget): CertRow | undefined {
  return rows.find((r) => {
    if (r.deletedAt !== null || r.scope !== target.scope) return false;
    if (target.scope === "LOAD") return r.loadNumber === target.loadNumber;
    if (target.scope === "SHIPMENT") return r.shipperId === target.shipperId;
    return true;
  });
}

/** The sentence shown beside the server's own refusal — never instead of it. */
export function coverageNotice(covering: CertRow): string {
  return `A live certification already covers ${subject(covering) || "this order"}.`;
}

/** The §11 "load or shipment" subject column — the CertList.tsx shape, minus the order number
 *  (every cert here belongs to THIS order). */
function subject(row: CertRow): string {
  if (row.scope === "LOAD") return row.loadNumber !== null ? `Load ${row.loadNumber}` : "";
  if (row.scope === "SHIPMENT") return row.shipperNumber !== null ? `Shipper #${row.shipperNumber}` : "";
  return "";
}

/** Three states, never two (the CertList.tsx lesson): a reading with no value is pending, not
 *  passed — `readingCount - failCount` would overstate completeness for every mid-entry cert. */
function results(row: CertRow): string {
  if (row.readingCount === 0) return "—";
  const pending = row.readingCount - row.passedCount - row.failCount;
  const parts: string[] = [];
  if (row.failCount > 0) parts.push(`${row.failCount} of ${row.readingCount} failed`);
  else if (row.passedCount > 0) parts.push(`${row.passedCount} passed`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.join(", ") || "—";
}

/**
 * The hub's Certifications section (design spec §4.1/§6.2/§11, Task 17). Lists every cert for
 * this order — voided included, dimmed rather than hidden (the certsForOrder contract).
 *
 * **#165: creation here is every scope, not just LOAD.** §6.2's eager rules still hold — an
 * ORDER-scope cert is minted at order save and a SHIPMENT-scope one at shipment save — but
 * "eager" is not "only": a cert voided in error, or one a scope change left un-minted, had no way
 * back short of the API, and `POST /api/certs` had no caller in the entire application. This
 * section is where all three scopes are now raised BY HAND, because a cert's scope instance is
 * always one of THIS ORDER's things (`Cert.orderId` is mandatory) and this section already lists
 * all three, subject column included. The shipment page was the alternative for SHIPMENT scope
 * and is the weaker home: a shipment can carry several orders, so a control there has to ask
 * "which order?" before it can ask anything else — from here the order is already known and the
 * only open question is which of its shipments. Each variant posts to the endpoint that owns it:
 * ORDER → `POST /api/certs`, LOAD → `POST /api/orders/[id]/certs`, SHIPMENT → `POST
 * /api/shippers/[id]/certs` (#165's new route — `shipperId` is still never read off a body).
 *
 * Two §4.1 obligations render here and nowhere else:
 * - the explicit gap — "by load · 4 loads · 0 certs" with a create action per uncovered load —
 *   shown when the ORDER's frozen resolution is (required, LOAD), so lazy creation is never
 *   silent forgetting;
 * - the orphan warning — a LIVE load-scope cert whose loadNumber no longer exists after a
 *   re-split is flagged, never hidden: "a person voids or re-creates it, never the system
 *   silently." A VOIDED orphan is not re-flagged — voiding is exactly the human resolution the
 *   flag asks for.
 *
 * State model: `call()`-shaped, never optimistic (the page's binding model, case (b)) — a create
 * POSTs, then the list refetches; nothing here touches `order`.
 */
export function CertificationsSection({
  orderId, loads, certRequired, certScope, viewGate, createGate, shipmentsGate,
}: {
  orderId: string;
  loads: OrderLoad[];
  certRequired: boolean;
  certScope: CertScopeValue;
  viewGate: Gate;
  /** Already void-locked by the page (voidLocked), like every other mutating gate here. */
  createGate: Gate;
  /** `shipping.view` — what it takes to LIST this order's shipments, which is the only way the
   *  picker can name one. Creating the cert itself needs `certs.create` alone (the route's gate);
   *  a caller without this gate simply gets no shipment targets, and is told why (§5.16). */
  shipmentsGate: Gate;
}) {
  const [rows, setRows] = useState<CertRow[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15, the InvoicesSection shape):
  // rows=[] before the first fetch lands must not render every "Create cert for Load N" button —
  // a click there is a guaranteed-400 double create once the real rows arrive.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // load()'s failures get their OWN channel (fix round): createForLoad's catch writes `error` and
  // does not reload, so sharing one channel let a transient create failure hide the §4.1 gap block
  // until a full page reload. Only a LOAD failure makes the coverage set untrustworthy.
  const [loadError, setLoadError] = useState<string | null>(null);
  // The target currently being created, as its `targetKey` — one field for both create controls
  // (the §4.1 gap block's per-load buttons and the scope picker), so neither can be clicked while
  // the other is in flight.
  const [creating, setCreating] = useState<string | null>(null);
  // The order's LIVE shipments, for the SHIPMENT-scope options. Its own error channel, the
  // `loadError` precedent: a shipment-list failure must not read as a cert-list failure.
  const [shipments, setShipments] = useState<ShipmentOption[]>([]);
  const [shipmentsError, setShipmentsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>("ORDER");
  // The scope instance the LAST create attempt named, kept only while that attempt is the newest
  // news — it is what `coveringCert` resolves the §5.14 identification against.
  const [attempt, setAttempt] = useState<CertTarget | null>(null);

  const allowed = viewGate.allowed;
  // §5.13 stale-gate, the InvoicesSection shape, both paths (F7): mount races createForLoad's
  // refresh, and a superseded response — success or rejection — must touch nothing.
  const latest = useLatest();
  const load = useCallback(async () => {
    if (!allowed) return;
    const t = latest.next();
    let data: CertRow[];
    try {
      data = await api<CertRow[]>(`/api/orders/${orderId}/certs`);
    } catch (e) {
      if (latest.isCurrent(t)) {
        setLoadError((e as Error).message);
        setLoaded(true);
      }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
    setLoadError(null);
    setLoaded(true);
  }, [orderId, allowed, latest]);
  useEffect(() => { void load(); }, [load]);

  // Effect-scoped `stale` flag rather than a second `useLatest` (the ActiveQuotesSection shape):
  // this fetch is keyed by its own deps and never re-fired by an action, so the cleanup flag is
  // the whole discipline it needs. Attempted only once the caller is known to hold shipping.view
  // — the hub page's own precedent for its customer/parts fetches — rather than firing a call
  // guaranteed to 403.
  const shipmentsAllowed = shipmentsGate.allowed;
  useEffect(() => {
    if (!shipmentsAllowed) return;
    let stale = false;
    api<ShipmentOption[]>(`/api/orders/${orderId}/shipments`).then((data) => {
      if (stale) return;
      // Live, NON-REVERSAL shipments only. A voided one is refused by `createCert` ("that shipment
      // does not exist or has been voided") and a reversal by #183 ("a reversing shipment cannot be
      // certified"), so listing either would offer a choice that cannot succeed. Both are facts off
      // the shipment's own row, not uniqueness judgements, which this component never makes.
      setShipments(data.filter((s) => s.deletedAt === null && s.reversesShipperNumber === null));
      setShipmentsError(null);
    }).catch((e) => {
      if (!stale) setShipmentsError((e as Error).message);
    });
    return () => { stale = true; };
  }, [orderId, shipmentsAllowed]);

  /**
   * The one create path, shared by the §4.1 gap block and the scope picker. Non-optimistic (the
   * page's binding model, case (b)): POST, then refetch.
   *
   * The refetch runs on the FAILURE path too, which the LOAD-only version did not do. That is the
   * §5.14 fix: `createCert`'s refusal names a scope but not the cert holding it, so the operator
   * met a wall with nothing behind it — the eagerly-created cert was often already there and the
   * screen never said so. Reloading makes the row present, and the render resolves it into a
   * named link beside the server's own words (never instead of them).
   *
   * **NO `invalidateHistory()` HERE, BY OWNER RULING (2026-08-21, #158's review).** This section
   * writes `cert` rows and sits on a page mounting an `order` panel, so the question was asked
   * directly: should raising a certification show in the ORDER's History?
   *
   * It should not. `audit-children.ts` deliberately keeps child DOCUMENTS off the parent panel — a
   * cert is its own document, with its own page and its own History panel, and raising one from
   * here is navigation to a different document rather than an edit to this order. The order panel
   * would gain rows it structurally cannot explain.
   *
   * So this is a deliberate absence, not an oversight, and it is written here because the #158
   * page-keyed sweep (tests/audit-children.test.ts) does not reach a SECTION that mounts no panel
   * of its own — which means nothing mechanical will re-raise the question, and the next reader
   * would otherwise re-derive it from scratch. Registering `cert` as a child of `order` is the
   * FOUR-edit change CLAUDE.md's audit paragraph describes, and it reverses this ruling; do not do
   * it as a one-liner.
   */
  async function createCertFor(target: CertTarget) {
    setCreating(targetKey(target));
    try {
      if (target.scope === "ORDER") {
        await api("/api/certs", { method: "POST", body: JSON.stringify({ orderId, scope: "ORDER" }) });
      } else if (target.scope === "LOAD") {
        await api(`/api/orders/${orderId}/certs`,
          { method: "POST", body: JSON.stringify({ loadNumber: target.loadNumber }) });
      } else {
        await api(`/api/shippers/${target.shipperId}/certs`,
          { method: "POST", body: JSON.stringify({ orderId }) });
      }
      setError(null);
      setAttempt(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      setAttempt(target);
      await load();
    } finally {
      setCreating(null);
    }
  }

  // §5.16: a caller without certs.view sees the section saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Certifications</h2>
        <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view certifications."}</p>
      </section>
    );
  }

  const liveLoadCerts = rows.filter((r) => r.scope === "LOAD" && r.deletedAt === null);
  const currentLoadNumbers = new Set(loads.map((l) => l.loadNumber));
  const coveredLoadNumbers = new Set(liveLoadCerts.map((r) => r.loadNumber));
  // §4.1: a LIVE load-scope cert pinned to a number no current load carries — the re-split
  // orphan. Flagged by name; the voided case is deliberately excluded (see the header comment).
  const orphans = liveLoadCerts.filter((r) => r.loadNumber !== null && !currentLoadNumbers.has(r.loadNumber));
  const uncovered = loads.filter((l) => !coveredLoadNumbers.has(l.loadNumber));
  // The gap block renders once the first load has SETTLED, success or failure (fix round): a
  // LOAD failure disables the create buttons with a reason instead of hiding them (§5.16 —
  // nothing re-triggers load, its deps are fixed for the page's life, so disabled-with-reason is
  // the honest state), while a createForLoad failure (`error`) hides and disables NOTHING: the
  // retry click is the recovery.
  const showLoadGap = loaded && certRequired && certScope === "LOAD";

  // §5.14: the live cert behind the last refusal, if the refusal was a collision. Derived at
  // render from the rows the failing create just refetched, so it stays right as the list moves.
  const covering = attempt === null ? undefined : coveringCert(rows, attempt);
  const pickedTarget = parseTarget(picked);

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Certifications</h2>

      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {loadError && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{loadError}</p>}

      {/* Beside the server's refusal above, never instead of it: the server says a cert already
          covers that scope, this says WHICH one and links to it. */}
      {covering && (
        <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
          {coverageNotice(covering)}{" "}
          <Link href={`/certs/${covering.id}`} className="text-blue-700 underline">Open it</Link>
        </p>
      )}

      {orphans.map((r) => (
        <p key={r.id} className="mb-2 rounded bg-amber-50 p-2 text-sm text-amber-800">
          <Link href={`/certs/${r.id}`} className="text-blue-700 underline">Certification for Load {r.loadNumber}</Link>
          {" "}points at a load that no longer exists after a re-split — void it or re-create it for a current load.
        </p>
      ))}

      {showLoadGap && (
        <div className="mb-3 text-sm">
          <p className="mb-1 text-slate-600">
            by load · {loads.length} load{loads.length === 1 ? "" : "s"} · {liveLoadCerts.length} cert{liveLoadCerts.length === 1 ? "" : "s"}
          </p>
          {uncovered.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {uncovered.map((l) => (
                <button key={l.id} type="button"
                        onClick={() => void createCertFor({ scope: "LOAD", loadNumber: l.loadNumber })}
                        disabled={createGate.disabled || creating !== null || loadError !== null}
                        title={createGate.allowed && loadError !== null
                          ? "Could not confirm which loads already have a cert — reload the page to try again"
                          : createGate.title}
                        className="rounded border border-slate-800 px-2 py-0.5 text-slate-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
                  {creating === targetKey({ scope: "LOAD", loadNumber: l.loadNumber })
                    ? "Creating…" : `Create cert for Load ${l.loadNumber}`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* #165 — the by-hand raise, at whichever scope the operator names. Deliberately NOT gated
          on coverage: the options are every scope instance this order HAS, covered or not, and
          the create always posts. Uniqueness is the service's under the order claim, and a UI
          that pre-filtered would be a second opinion able to disagree with it. */}
      <div className="mb-3 border-t pt-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="cert-raise-target" className="text-slate-600">Raise a certification</label>
          <select id="cert-raise-target" value={picked} onChange={(e) => setPicked(e.target.value)}
                  disabled={createGate.disabled}
                  title={createGate.title}
                  className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
            <option value="ORDER">By order — this order</option>
            {loads.map((l) => (
              <option key={l.id} value={targetKey({ scope: "LOAD", loadNumber: l.loadNumber })}>
                By load — Load {l.loadNumber}
              </option>
            ))}
            {shipments.map((s) => (
              <option key={s.id} value={targetKey({ scope: "SHIPMENT", shipperId: s.id })}>
                By shipment — Shipper #{s.shipperNumber}
              </option>
            ))}
          </select>
          <button type="button"
                  onClick={() => { if (pickedTarget) void createCertFor(pickedTarget); }}
                  disabled={createGate.disabled || creating !== null || pickedTarget === null}
                  title={createGate.title}
                  className="rounded bg-slate-800 px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {pickedTarget !== null && creating === targetKey(pickedTarget) ? "Creating…" : "Create certification"}
          </button>
        </div>
        {/* §5.16 again, one level down: the shipment options are ABSENT for a reason, and the
            picker says which rather than looking like this order has never shipped. */}
        {!shipmentsGate.allowed ? (
          <p className="mt-1 text-xs text-slate-500">
            Shipment-scope targets are not listed — {shipmentsGate.title ?? "you do not have permission to view shipments"}.
          </p>
        ) : shipmentsError !== null ? (
          <p className="mt-1 text-xs text-amber-700">
            Shipment-scope targets could not be listed — {shipmentsError}
          </p>
        ) : null}
      </div>

      {loaded && !loadError && rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          {certRequired ? "No certifications yet." : "None — this order does not require a certification."}
        </p>
      ) : rows.length > 0 ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Scope</th>
              <th className="font-medium">Subject</th>
              <th className="font-medium">Printed</th>
              <th className="font-medium">Results</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-t ${r.deletedAt ? "text-slate-400" : ""}`}>
                <td className="py-1">
                  {/* /certs/[id] is this branch's own Task 16 page — the one hub link that works
                      on this lane's dev server today. */}
                  <Link href={`/certs/${r.id}`} className="text-blue-700 underline">
                    {CERT_SCOPE_LABELS[r.scope]}
                  </Link>
                  {r.deletedAt && (
                    <span className="ml-2 rounded bg-slate-200 px-1 text-xs text-slate-700">voided</span>
                  )}
                </td>
                <td className="text-slate-500">{subject(r)}</td>
                <td>{r.printedAt ? "yes" : "no"}</td>
                <td>{results(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
