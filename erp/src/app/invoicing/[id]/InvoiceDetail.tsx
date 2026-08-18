"use client";
// The invoice page's body (design spec §11 "/invoicing/[id]"). Remounted per id by page.tsx's
// `key={id}` (HANDOFF §5.12 — a Critical in Phase 2B): every field bound straight to `invoice`
// below and every bulk-grid overlay is therefore guaranteed fresh per invoice id, never carrying
// one invoice's unsaved text onto another's.
//
// THE BINDING STATE MODEL — copied from ShipmentDetail.tsx (task-18-brief.md's explicit
// precedent), not reinvented: header PATCHes are optimistic with rollback-then-report on failure
// (§5.13 — reload BEFORE setting the error, never after); one monotonic mutation ticket
// (`useMutationGate`) is shared by every write AND by `load` itself, so overlapping calls resolve
// to whichever is genuinely newest; `useEditGuard` preserves the field under the cursor when a
// server detail lands mid-edit — the notes-clobber trio's fix, and this page is a fourth member
// of that sibling group; the line grid keeps only what the user actually edited/added/removed
// (`useBulkGrid`, src/lib/bulk-grid.ts), composed with server state at render.
//
// "Raise credit" is the one action that does NOT go through `applyMutation`: unlike every other
// mutator here, POST .../credit answers with a DIFFERENT document (a new CREDIT with its own id),
// not a fresh copy of THIS invoice — applying it here would silently swap the page's content out
// from under the URL. It navigates to the new credit's own page instead, the orders/new
// "Save & Print" `router.push` precedent.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest, useMutationGate } from "@/lib/use-latest";
import { useEditGuard } from "@/lib/use-edit-guard";
import { useBulkGrid, type ComposedRow } from "@/lib/bulk-grid";
import { HistoryPanel } from "@/components/HistoryPanel";
import {
  INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS, INVOICE_LINE_KIND_LABELS, PRICE_SOURCE_LABELS,
  type InvoiceKindValue, type InvoiceStatusValue, type InvoiceLineKindValue, type PriceSourceValue,
} from "@/lib/invoice-constants";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/invoices.ts's InvoiceDetail/InvoiceLineDetail — not imported
// from src/server/** (CLAUDE.md: a client component pulling from there drags node:async_hooks and
// Prisma into the browser bundle). Named `InvoiceDetailData`, not `InvoiceDetail` — the component
// below is `InvoiceDetail` (task-18-brief.md's exact file/component name), and the two would
// collide (the CertDetail.tsx / `CertDetailData` precedent).
// ---------------------------------------------------------------------------------------------

export type InvoiceLineRow = {
  id: string; position: number; kind: InvoiceLineKindValue; parentLineId: string | null;
  orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null; glAccountId: string | null;
  partNumber: string; partName: string; partDescription: string;
  description: string; glAccountName: string;
  qty: number | null; weight: number | null; eachWeight: number | null;
  pricePer: string | null;
  unitPrice: number | null; setupCharge: number | null; minimumCharge: number | null;
  breakThreshold: number | null; minimumApplied: boolean;
  rate: number | null; priceSource: string | null;
  /** The FROZEN quote number ("Quote #N" on a QUOTE-sourced line) — the line's own column,
   *  never a live join to the quote (the frozen-paper rule; the quote may be long deleted). */
  sourceQuoteNumber: number | null;
  needsPrice: boolean;
  amount: number;
};

export type InvoiceDetailData = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  sourceInvoiceId: string | null; creditNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; poNumber: string; termsName: string;
  billTo: string; shipTo: string; materialName: string; processNames: string;
  taxRate: number | null;
  subtotal: number; surchargeTotal: number; chargeTotal: number;
  certTotal: number; freightTotal: number; taxTotal: number; total: number;
  finalizedAt: string | null; deletedAt: string | null;
  lines: InvoiceLineRow[];
};

/** Every mutating invoice route (PATCH, lines PUT, recalculate/finalize/unlock POST) — and GET
 *  itself — is wrapped through `invoiceResponse` (src/app/api/invoices/response.ts) into this ONE
 *  shape. `.../credit` answers with the same shape but describing a DIFFERENT document — see the
 *  top comment on why that one is never routed through `applyMutation`. */
export type InvoiceMutationResult = { invoice: InvoiceDetailData; warnings: string[] };

type AuditEntry = { id: string; action: string; reason: string | null };
/** Slice of a future `GET /api/invoices/[id]/documents` (Task 19 — not built yet; the route 404s
 *  until then, exactly like this page's own Print button, both by task-18-brief.md's explicit
 *  license). Shape mirrors `listDocumentsForShipper`'s `DocumentMeta` (src/server/documents.ts). */
type StoredDoc = { id: string; kind: string; createdAt: string };

const DOC_KIND_LABELS: Record<string, string> = { INVOICE: "Invoice", CREDIT: "Credit" };

/** A FINALIZED invoice locks every editing control; a DISCARDED draft reuses the shape with its
 *  own title — the `voidLocked` helper's shape (ShipmentDetail.tsx:110-127), applied twice since
 *  an invoice has two lock states voided-shipment doesn't. Discarded wins if somehow both were
 *  true (they cannot co-occur — discard refuses a FINALIZED invoice — but the check order still
 *  names the more specific state first, the way voidLocked itself is unconditional). */
function statusLocked(g: Gate, finalized: boolean, discarded: boolean): Gate {
  if (discarded) return { allowed: false, disabled: true, title: "Invoice is discarded" };
  if (finalized) return { allowed: false, disabled: true, title: "Invoice is finalized" };
  return g;
}

/** The stored-documents list (spec §10/§11) — mirrors ShipmentDocumentsList (ShipmentDetail.tsx),
 *  minus the print/blob plumbing this page owns itself above. */
function InvoiceDocumentsList({ invoiceId, viewGate, refresh }: {
  invoiceId: string; viewGate: Gate;
  /** Bumped by every successful print, so a just-archived document appears without a reload. */
  refresh: number;
}) {
  const [docs, setDocs] = useState<StoredDoc[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // §5.13 stale-gate, both paths (F7): the mount fetch races the print-bumped `refresh` refetch
  // (the ShipmentDocumentsList shape).
  const latest = useLatest();
  useEffect(() => {
    if (!viewGate.allowed) return;
    const t = latest.next();
    api<StoredDoc[]>(`/api/invoices/${invoiceId}/documents`)
      .then((rows) => { if (latest.isCurrent(t)) setDocs(rows); })
      .catch((e) => { if (latest.isCurrent(t)) setErr((e as Error).message); });
  }, [invoiceId, viewGate.allowed, refresh, latest]);

  if (!viewGate.allowed) return <p className="text-sm text-slate-500">{viewGate.title}</p>;
  if (err) return <p className="text-sm text-red-700">{err}</p>;
  if (docs.length === 0) return <p className="text-sm text-slate-500">Nothing printed yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="py-1 font-medium">Document</th><th className="font-medium">Printed</th>
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
            <td className="text-slate-600">{new Date(d.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------
// The line grid — one `useBulkGrid` instance shared by BOTH visual sections (the PART/OPERATION
// grid and the surcharge/freight/charge/cert/tax lines), because `PUT .../lines` replaces the
// WHOLE array in one call (§5.5) — splitting into two grid instances would need to be recombined
// at save time anyway, so one instance composed once and filtered twice for display is simpler
// and cannot let the two "halves" drift out of position order relative to each other.
//
// `key`/`parentKey` carry the OPERATION -> PART self-relation across the save (invoices.ts's
// `wirePayloadParents`): every row keeps its own server id as `key` so a child can still resolve
// its parent, and a PART line removed without removing its children leaves them flat rather than
// dangling (the server's own documented fallback — not re-implemented here).
//
// Editing a row's `amount` is the one edit that also stamps `priceSource: MANUAL` and clears
// `needsPrice` — a deliberate UI decision (not spec-mandated): the operator just supplied the
// missing/overridden price, so Recalculate (which preserves only `priceSource = MANUAL` lines)
// must not silently discard it on its next run, and a line the operator just priced no longer
// "needs" one. Editing other fields (description, qty, weight) does not reclassify the line —
// those are corrections, not a pricing decision.
// ---------------------------------------------------------------------------------------------

type LineFields = {
  key: string; parentKey: string; kind: string;
  orderLineId: string; processStepCodeId: string; surchargeId: string; orderChargeId: string; glAccountId: string;
  partNumber: string; partName: string; partDescription: string;
  description: string; glAccountName: string;
  qty: string; weight: string; eachWeight: string;
  pricePer: string; unitPrice: string; setupCharge: string; minimumCharge: string; breakThreshold: string;
  minimumApplied: string; rate: string; priceSource: string; sourceQuoteNumber: string;
  needsPrice: string; amount: string;
};

/** The §7.5 "every line names its source" label for an OPERATION row: "Part price", "Manual", or
 *  "Quote #1006" — the QUOTE label with the line's FROZEN sourceQuoteNumber appended (never a live
 *  join; the quote may be long deleted and the label must not blank). */
function sourceLabel(row: { priceSource: string; sourceQuoteNumber: string }): string | null {
  if (row.priceSource === "") return null;
  const label = PRICE_SOURCE_LABELS[row.priceSource as PriceSourceValue] ?? row.priceSource;
  if (row.priceSource === "QUOTE" && row.sourceQuoteNumber !== "") {
    return `${label} #${row.sourceQuoteNumber}`;
  }
  return label;
}

function toLineFields(l: InvoiceLineRow): LineFields {
  return {
    key: l.id, parentKey: l.parentLineId ?? "", kind: l.kind,
    orderLineId: l.orderLineId ?? "", processStepCodeId: l.processStepCodeId ?? "",
    surchargeId: l.surchargeId ?? "", orderChargeId: l.orderChargeId ?? "", glAccountId: l.glAccountId ?? "",
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty === null ? "" : String(l.qty),
    weight: l.weight === null ? "" : String(l.weight),
    eachWeight: l.eachWeight === null ? "" : String(l.eachWeight),
    pricePer: l.pricePer ?? "",
    unitPrice: l.unitPrice === null ? "" : String(l.unitPrice),
    setupCharge: l.setupCharge === null ? "" : String(l.setupCharge),
    minimumCharge: l.minimumCharge === null ? "" : String(l.minimumCharge),
    breakThreshold: l.breakThreshold === null ? "" : String(l.breakThreshold),
    minimumApplied: String(l.minimumApplied),
    rate: l.rate === null ? "" : String(l.rate),
    priceSource: l.priceSource ?? "",
    sourceQuoteNumber: l.sourceQuoteNumber === null ? "" : String(l.sourceQuoteNumber),
    needsPrice: String(l.needsPrice),
    amount: String(l.amount),
  };
}

/** A manually-added line — always kind CHARGE (the one ad-hoc addition that needs no order-side
 *  or surcharge-side link) and pre-stamped MANUAL/needsPrice=false, the same reasoning as the
 *  amount-edit stamp above: a line the operator typed in themselves is never "needs price". */
function blankChargeRow(): LineFields {
  return {
    key: "", parentKey: "", kind: "CHARGE",
    orderLineId: "", processStepCodeId: "", surchargeId: "", orderChargeId: "", glAccountId: "",
    partNumber: "", partName: "", partDescription: "", description: "", glAccountName: "",
    qty: "", weight: "", eachWeight: "",
    pricePer: "", unitPrice: "", setupCharge: "", minimumCharge: "", breakThreshold: "",
    minimumApplied: "false", rate: "", priceSource: "MANUAL", sourceQuoteNumber: "",
    needsPrice: "false", amount: "0",
  };
}

function InvoiceLinesGrid({
  invoiceId, lines, moneyGate, applyMutation, onError,
}: {
  invoiceId: string;
  lines: InvoiceLineRow[];
  moneyGate: Gate;
  applyMutation: (run: () => Promise<InvoiceMutationResult>) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<LineFields>();
  const rows = grid.compose(lines, toLineFields);
  const partOpRows = rows.filter((r) => r.kind === "PART" || r.kind === "OPERATION");
  const otherRows = rows.filter((r) => r.kind !== "PART" && r.kind !== "OPERATION");

  function patchRow(row: { key: string; isNew: boolean }, field: keyof LineFields, value: string) {
    const patch: Partial<LineFields> = { [field]: value };
    if (field === "amount") { patch.priceSource = "MANUAL"; patch.needsPrice = "false"; }
    if (row.isNew) grid.updateAdded(row.key, patch); else grid.updateExisting(row.key, patch);
  }
  function removeRow(row: { key: string; isNew: boolean }) {
    if (row.isNew) grid.removeAdded(row.key); else grid.removeExisting(row.key);
  }

  async function save() {
    const payload: Record<string, unknown>[] = [];
    for (const [i, row] of rows.entries()) {
      const amount = row.amount.trim();
      if (amount === "" || Number.isNaN(Number(amount))) { onError(`Line ${i + 1}: enter a valid amount.`); return; }
      let qty: number | null = null;
      if (row.qty.trim() !== "") {
        qty = Number(row.qty);
        if (!Number.isInteger(qty)) { onError(`Line ${i + 1}: quantity must be a whole number.`); return; }
      }
      payload.push({
        ...(row.key ? { key: row.key } : {}),
        parentKey: row.parentKey || null,
        kind: row.kind,
        orderLineId: row.orderLineId || null, processStepCodeId: row.processStepCodeId || null,
        surchargeId: row.surchargeId || null, orderChargeId: row.orderChargeId || null, glAccountId: row.glAccountId || null,
        partNumber: row.partNumber, partName: row.partName, partDescription: row.partDescription,
        description: row.description, glAccountName: row.glAccountName,
        qty,
        weight: row.weight.trim() === "" ? null : row.weight,
        eachWeight: row.eachWeight.trim() === "" ? null : row.eachWeight,
        pricePer: row.pricePer === "" ? null : row.pricePer,
        unitPrice: row.unitPrice.trim() === "" ? null : row.unitPrice,
        setupCharge: row.setupCharge.trim() === "" ? null : row.setupCharge,
        minimumCharge: row.minimumCharge.trim() === "" ? null : row.minimumCharge,
        breakThreshold: row.breakThreshold.trim() === "" ? null : row.breakThreshold,
        minimumApplied: row.minimumApplied === "true",
        rate: row.rate.trim() === "" ? null : row.rate,
        priceSource: row.priceSource === "" ? null : row.priceSource,
        // Echoed back whole (a hidden round-trip field, like priceSource): dropping it from the
        // save would blank the frozen "Quote #N" off the paper on any line edit.
        sourceQuoteNumber: row.sourceQuoteNumber === "" ? null : Number(row.sourceQuoteNumber),
        needsPrice: row.needsPrice === "true",
        amount,
      });
    }
    try {
      await applyMutation(() => api<InvoiceMutationResult>(`/api/invoices/${invoiceId}/lines`, {
        method: "PUT", body: JSON.stringify(payload),
      }));
      grid.reset();
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  function partOpRow(row: ComposedRow<LineFields>, i: number) {
    return (
      <tr key={row.key} className={row.needsPrice === "true" ? "bg-amber-50" : undefined}>
        <td className="py-1 pr-2 text-xs text-slate-500">
          {INVOICE_LINE_KIND_LABELS[row.kind as InvoiceLineKindValue] ?? row.kind}
        </td>
        <td className="pr-2">
          <input value={row.description} disabled={!moneyGate.allowed} title={moneyGate.title}
                 onChange={(e) => patchRow(row, "description", e.target.value)}
                 aria-label={`Line ${i + 1} description`}
                 className="w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          {row.partNumber && <div className="text-xs text-slate-500">{row.partNumber} · {row.partName}</div>}
          {row.kind === "OPERATION" && sourceLabel(row) && (
            // §7.5: every line names its source — "Quote #1006" reads the FROZEN sourceQuoteNumber.
            <div className="text-xs text-slate-500">{sourceLabel(row)}</div>
          )}
        </td>
        <td className="w-20 pr-2">
          <input value={row.qty} inputMode="numeric" disabled={!moneyGate.allowed} title={moneyGate.title}
                 onChange={(e) => patchRow(row, "qty", e.target.value)}
                 aria-label={`Line ${i + 1} qty`} className="w-full rounded border px-2 py-1 text-right disabled:bg-slate-50" />
        </td>
        <td className="w-24 pr-2">
          <input value={row.weight} inputMode="decimal" disabled={!moneyGate.allowed} title={moneyGate.title}
                 onChange={(e) => patchRow(row, "weight", e.target.value)}
                 aria-label={`Line ${i + 1} weight`} className="w-full rounded border px-2 py-1 text-right disabled:bg-slate-50" />
        </td>
        <td className="pr-2 text-right text-slate-600">{row.unitPrice || "—"}</td>
        <td className="pr-2 text-right text-slate-600">{row.rate || "—"}</td>
        <td className="pr-2 text-slate-600">{row.glAccountName || "—"}</td>
        <td className="w-28 pr-2">
          <input value={row.amount} inputMode="decimal"
                 disabled={row.kind === "PART" || !moneyGate.allowed}
                 title={row.kind === "PART" ? "A PART line carries no money — its operations do" : moneyGate.title}
                 onChange={(e) => patchRow(row, "amount", e.target.value)}
                 aria-label={`Line ${i + 1} amount`} className="w-full rounded border px-2 py-1 text-right disabled:bg-slate-50" />
        </td>
        <td className="pr-2">
          {row.needsPrice === "true" && (
            <span className="rounded bg-amber-100 px-1 text-xs text-amber-800">needs price</span>
          )}
        </td>
        <td>
          <button onClick={() => removeRow(row)} disabled={!moneyGate.allowed} title={moneyGate.title}
                  className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
            Remove
          </button>
        </td>
      </tr>
    );
  }

  function otherRow(row: ComposedRow<LineFields>, i: number) {
    return (
      <tr key={row.key} className={row.needsPrice === "true" ? "bg-amber-50" : undefined}>
        <td className="py-1 pr-2 text-xs text-slate-500">
          {INVOICE_LINE_KIND_LABELS[row.kind as InvoiceLineKindValue] ?? row.kind}
        </td>
        <td className="pr-2">
          <input value={row.description} disabled={!moneyGate.allowed} title={moneyGate.title}
                 onChange={(e) => patchRow(row, "description", e.target.value)}
                 aria-label={`Line ${i + 1} description`}
                 className="w-full rounded border px-2 py-1 disabled:bg-slate-50" />
        </td>
        <td className="pr-2 text-slate-600">{row.glAccountName || "—"}</td>
        <td className="w-28 pr-2">
          <input value={row.amount} inputMode="decimal" disabled={!moneyGate.allowed} title={moneyGate.title}
                 onChange={(e) => patchRow(row, "amount", e.target.value)}
                 aria-label={`Line ${i + 1} amount`} className="w-full rounded border px-2 py-1 text-right disabled:bg-slate-50" />
        </td>
        <td className="pr-2">
          {row.needsPrice === "true" && (
            <span className="rounded bg-amber-100 px-1 text-xs text-amber-800">needs price</span>
          )}
        </td>
        <td>
          <button onClick={() => removeRow(row)} disabled={!moneyGate.allowed} title={moneyGate.title}
                  className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
            Remove
          </button>
        </td>
      </tr>
    );
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Lines</h2>
      {grid.orphanWarning && (
        <p className="mb-2 rounded bg-amber-50 p-2 text-sm text-amber-800">{grid.orphanWarning}</p>
      )}

      <h3 className="mb-1 text-sm font-medium text-slate-600">Part / operation lines</h3>
      {partOpRows.length === 0 ? (
        <p className="mb-3 text-sm text-slate-500">None.</p>
      ) : (
        <table className="mb-4 w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Kind</th><th className="font-medium">Description</th>
              <th className="font-medium">Qty</th><th className="font-medium">Weight</th>
              <th className="font-medium">Unit price</th><th className="font-medium">Rate</th>
              <th className="font-medium">GL account</th><th className="font-medium">Amount</th>
              <th /><th />
            </tr>
          </thead>
          <tbody>{partOpRows.map((row, i) => partOpRow(row, i))}</tbody>
        </table>
      )}

      <h3 className="mb-1 text-sm font-medium text-slate-600">Surcharges, freight, charges, cert &amp; tax</h3>
      {otherRows.length === 0 ? (
        <p className="mb-3 text-sm text-slate-500">None.</p>
      ) : (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Kind</th><th className="font-medium">Description</th>
              <th className="font-medium">GL account</th><th className="font-medium">Amount</th>
              <th /><th />
            </tr>
          </thead>
          <tbody>{otherRows.map((row, i) => otherRow(row, i))}</tbody>
        </table>
      )}

      <div className="mt-2 flex items-center gap-3">
        <button onClick={() => grid.addRow(blankChargeRow())} disabled={!moneyGate.allowed} title={moneyGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add charge line
        </button>
        <button onClick={() => void save()} disabled={!moneyGate.allowed || !grid.dirty} title={moneyGate.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Save lines
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The page itself.
// ---------------------------------------------------------------------------------------------

export function InvoiceDetail({ id }: { id: string }) {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();

  const [invoice, setInvoice] = useState<InvoiceDetailData | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [discardReason, setDiscardReason] = useState<string | null | undefined>(null);

  const mutations = useMutationGate();
  const editGuard = useEditGuard();

  const load = useCallback(async () => {
    const ticket = mutations.next();
    const res = await api<InvoiceMutationResult>(`/api/invoices/${id}`);
    if (mutations.accept(ticket)) { setInvoice((cur) => editGuard.merge(cur, res.invoice)); setWarnings(res.warnings); }
    return res.invoice;
  }, [id, mutations, editGuard]);
  useEffect(() => {
    load().then(() => setError(null)).catch((e) => setError((e as Error).message));
  }, [load]);

  const applyMutation = useCallback(async (run: () => Promise<InvoiceMutationResult>) => {
    const ticket = mutations.next();
    const res = await run();
    if (!mutations.accept(ticket)) return;
    setInvoice((cur) => editGuard.merge(cur, res.invoice));
    setWarnings(res.warnings);
  }, [mutations, editGuard]);

  const finalized = invoice?.status === "FINALIZED";
  const discarded = (invoice?.deletedAt ?? null) !== null;

  const auditGate = gate(perms, "admin.view");
  const editGate = statusLocked(gate(perms, "invoicing.edit"), finalized, discarded);
  // §5.5/task-18-brief.md Step 3: money-bearing controls take BOTH invoicing.edit and
  // change_prices, computed once with the "whichever is actually the blocker" title (the
  // parts/[id]/PricingSection.tsx precedent), THEN status-locked on top — a user holding both
  // permissions still sees "Invoice is finalized" once that is the real blocker.
  const editGateRaw = gate(perms, "invoicing.edit");
  const priceGateRaw = gateDo(perms, "change_prices");
  const moneyDisabled = editGateRaw.disabled || priceGateRaw.disabled;
  const moneyGateRaw: Gate = {
    allowed: !moneyDisabled, disabled: moneyDisabled,
    title: editGateRaw.disabled ? editGateRaw.title : priceGateRaw.title,
  };
  const moneyGate = statusLocked(moneyGateRaw, finalized, discarded);

  const finalizeGate: Gate = discarded
    ? { allowed: false, disabled: true, title: "Invoice is discarded" }
    : finalized
      ? { allowed: false, disabled: true, title: "Already finalized" }
      : gate(perms, "invoicing.edit");
  const unlockGate: Gate = !finalized
    ? { allowed: false, disabled: true, title: "That invoice is not finalized — there is nothing to unlock" }
    : gateDo(perms, "unlock_invoice");
  const discardGate: Gate = discarded
    ? { allowed: false, disabled: true, title: "Already discarded" }
    : finalized
      ? { allowed: false, disabled: true, title: "Cannot discard a finalized invoice — unlock or credit it instead" }
      : gate(perms, "invoicing.delete");
  const creditGate: Gate = invoice && invoice.kind !== "INVOICE"
    ? { allowed: false, disabled: true, title: "A credit cannot itself be credited" }
    : !finalized
      ? { allowed: false, disabled: true, title: "Only a finalized invoice can be credited" }
      : gate(perms, "invoicing.create");
  // A credit's lines are derived from its source invoice with the sign flipped (§5.6) — recalculate
  // re-derives from the order at ordinary POSITIVE prices, which has no meaning for a credit and
  // would overwrite its negated lines. Kind check takes precedence over moneyGate's own reasons,
  // same shape as `creditGate` above.
  const recalcGate: Gate = invoice && invoice.kind === "CREDIT"
    ? { allowed: false, disabled: true, title: "A credit cannot be recalculated" }
    : moneyGate;
  // Print (Task 19 — the route does not exist yet and 404s until then, per task-18-brief.md's
  // explicit license). Gated on the area's OWN .view permission, locked by "discarded" rather
  // than "finalized" (a finalized invoice prints — the stored-PDF case is the whole point) — the
  // ShipmentDetail.tsx `printGate`/DocumentsSection.tsx traveler-print precedent: both gate
  // printing on `<area>.view`, not `.edit`, and lock it only on the state that makes a NEW print
  // meaningless (voided there, discarded here — nothing to print from and nothing was ever
  // printed to fall back on).
  const printGate: Gate = discarded
    ? { allowed: false, disabled: true, title: "Invoice is discarded — nothing to print" }
    : gate(perms, "invoicing.view");
  const docsGate = gate(perms, "invoicing.view");

  // Discarded banner's reason — the order hub / ShipmentDetail `voidReason` precedent. Safe to
  // key on `discarded` alone: once discarded, no mutator can touch the invoice again.
  useEffect(() => {
    if (!discarded) { setDiscardReason(null); return; }
    if (!auditGate.allowed) { setDiscardReason(undefined); return; }
    api<AuditEntry[]>(`/api/admin/audit?entity=invoice&entityId=${id}`)
      .then((entries) => {
        const latest = entries[0];
        setDiscardReason(latest?.action === "delete" ? (latest.reason ?? undefined) : undefined);
      })
      .catch(() => setDiscardReason(undefined));
  }, [discarded, auditGate.allowed, id]);

  // ---- Header: optimistic scalar PATCH (ShipmentDetail.tsx `patchHeader` precedent) ----

  const queue = useRef<Map<string, Promise<unknown>>>(new Map());
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queue.current.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queue.current.set(key, next.catch(() => {}));
    return next;
  }

  type HeaderPatch = { poNumber?: string; invoiceDate?: string; termsName?: string; billTo?: string; shipTo?: string };

  async function patchHeader(patch: HeaderPatch): Promise<boolean> {
    setInvoice((cur) => (cur ? { ...cur, ...patch } : cur));
    const key = Object.keys(patch).sort().join(",");
    return serial(key, async () => {
      try {
        await applyMutation(() => api<InvoiceMutationResult>(
          `/api/invoices/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
        setError(null);
        return true;
      } catch (e) {
        await load().catch(() => {});
        setError((e as Error).message);
        return false;
      }
    });
  }

  // ---- Lifecycle actions ----

  async function recalculate() {
    try {
      await applyMutation(() => api<InvoiceMutationResult>(`/api/invoices/${id}/recalculate`, { method: "POST" }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function finalize() {
    try {
      await applyMutation(() => api<InvoiceMutationResult>(`/api/invoices/${id}/finalize`, { method: "POST" }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function unlock() {
    if (!invoice) return;
    const reason = prompt(
      `Unlock ${INVOICE_KIND_LABELS[invoice.kind]} ${invoice.documentNumber}?\n\n` +
      "It returns to Draft and every editing control unlocks; the order returns to its " +
      "ship-derived status.\n\nReason for unlocking (recorded in the audit history):",
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to unlock an invoice."); return; }
    try {
      await applyMutation(() => api<InvoiceMutationResult>(
        `/api/invoices/${id}/unlock`, { method: "POST", body: JSON.stringify({ reason }) }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Non-optimistic and NOT routed through applyMutation — see the file's top comment: the
  // response describes a different document (the new credit), not this invoice.
  async function raiseCredit() {
    try {
      const res = await api<InvoiceMutationResult>(`/api/invoices/${id}/credit`, { method: "POST" });
      router.push(`/invoicing/${res.invoice.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function discard() {
    if (!invoice) return;
    const reason = prompt(
      `Discard ${INVOICE_KIND_LABELS[invoice.kind]} ${invoice.documentNumber}?\n\n` +
      "This frees the order for a new invoice and cannot be undone through the UI.\n\n" +
      "Reason for discarding (recorded in the audit history):",
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to discard an invoice."); return; }
    // Two separate try/catches (the ShipmentDetail.tsx `voidAction` precedent): DELETE returns
    // `{ ok: true }`, not a fresh detail, so picking up `deletedAt` needs a follow-up `load()` —
    // and if THAT fails, the discard itself still succeeded.
    try {
      await api(`/api/invoices/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Invoice discarded, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  // ---- Print (Task 19; the ShipmentDetail.tsx `printDoc` precedent, minus the cert/multi-doc
  // complexity that page's shipment paper needs and this one doesn't) ----

  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [docsRefresh, setDocsRefresh] = useState(0);

  async function printInvoice() {
    setPrinting(true);
    setPrintError(null);
    try {
      const res = await fetch(`/api/invoices/${id}/print`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Print failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      const opened = window.open(url, "_blank");
      if (opened) opened.opener = null;
      if (opened === null) {
        setPrintError("The browser blocked the print window — the document was archived and is in Documents below.");
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDocsRefresh((n) => n + 1);
    } catch (e) {
      setPrintError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }

  if (!invoice) return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          {INVOICE_KIND_LABELS[invoice.kind]} {invoice.documentNumber}
          <span className="ml-3 rounded bg-slate-100 px-2 py-0.5 text-base font-normal text-slate-600">
            {INVOICE_STATUS_LABELS[invoice.status]}
          </span>
          {discarded && (
            <span className="ml-2 rounded bg-slate-200 px-2 py-0.5 text-base font-normal text-slate-700">
              Discarded
            </span>
          )}
        </h1>
        <div className="flex items-center gap-2">
          <button onClick={() => void printInvoice()} disabled={!printGate.allowed || printing} title={printGate.title}
                  className="rounded border bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
            {printing ? "Printing…" : "Print"}
          </button>
          <button onClick={() => void raiseCredit()} disabled={!creditGate.allowed} title={creditGate.title}
                  className="rounded border bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
            Raise credit
          </button>
          <button onClick={() => void unlock()} disabled={!unlockGate.allowed} title={unlockGate.title}
                  className="rounded border bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
            Unlock
          </button>
          <button onClick={() => void discard()} disabled={!discardGate.allowed} title={discardGate.title}
                  className="rounded border border-red-600 px-3 py-1.5 text-sm text-red-600 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
            Discard
          </button>
        </div>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {discarded && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm font-medium text-red-700">
          Discarded — {discardReason ?? "see History for the reason"}
        </p>
      )}
      {printError && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{printError}</p>}
      {warnings.length > 0 && (
        <ul className="mb-3 list-disc space-y-0.5 rounded bg-amber-50 p-2 pl-7 text-sm text-amber-800">
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}

      {/* ---- Header ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Header</h2>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div className="block">
            Customer
            <div className="mt-1 rounded border bg-slate-50 px-2 py-1">
              <Link href={`/customers/${invoice.customerId}`} className="text-blue-700 underline">
                {invoice.customerCode} · {invoice.customerName}
              </Link>
            </div>
          </div>
          <div className="block">
            Order
            <div className="mt-1 rounded border bg-slate-50 px-2 py-1">
              <Link href={`/orders/${invoice.orderId}`} className="text-blue-700 underline">
                #{invoice.orderNumber}
              </Link>
            </div>
          </div>
          {invoice.kind === "CREDIT" && invoice.sourceInvoiceId && (
            <div className="block">
              Credit for
              <div className="mt-1 rounded border bg-slate-50 px-2 py-1">
                <Link href={`/invoicing/${invoice.sourceInvoiceId}`} className="text-blue-700 underline">
                  source invoice
                </Link>
              </div>
            </div>
          )}
          <label className="block">
            PO number
            <input value={invoice.poNumber} onFocus={editGuard.onFocusField("poNumber")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => setInvoice({ ...invoice, poNumber: e.target.value })}
                   onBlur={(e) => editGuard.onBlurSave(e, (poNumber) => void patchHeader({ poNumber }))}
                   className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="block">
            Terms
            <input value={invoice.termsName} onFocus={editGuard.onFocusField("termsName")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => setInvoice({ ...invoice, termsName: e.target.value })}
                   onBlur={(e) => editGuard.onBlurSave(e, (termsName) => void patchHeader({ termsName }))}
                   className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="block">
            Invoice date
            <input type="date" value={invoice.invoiceDate} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void patchHeader({ invoiceDate: e.target.value })}
                   className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <label className="block">
            Bill to
            <textarea value={invoice.billTo} rows={3} onFocus={editGuard.onFocusField("billTo")} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => setInvoice({ ...invoice, billTo: e.target.value })}
                      onBlur={(e) => editGuard.onBlurSave(e, (billTo) => void patchHeader({ billTo }))}
                      className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
          </label>
          <label className="block">
            Ship to
            <textarea value={invoice.shipTo} rows={3} onFocus={editGuard.onFocusField("shipTo")} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => setInvoice({ ...invoice, shipTo: e.target.value })}
                      onBlur={(e) => editGuard.onBlurSave(e, (shipTo) => void patchHeader({ shipTo }))}
                      className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
          </label>
          <div className="block">
            Material / process
            <div className="mt-1 rounded border bg-slate-50 px-2 py-1 text-slate-600">
              {invoice.materialName || "—"}{invoice.processNames ? ` · ${invoice.processNames}` : ""}
            </div>
          </div>
          <div className="block">
            Tax rate
            <div className="mt-1 rounded border bg-slate-50 px-2 py-1 text-slate-600">
              {invoice.taxRate === null ? "Not taxable" : `${invoice.taxRate}%`}
            </div>
          </div>
        </div>
      </section>

      {/* ---- Lines ---- */}
      <InvoiceLinesGrid invoiceId={id} lines={invoice.lines} moneyGate={moneyGate} applyMutation={applyMutation} onError={setError} />

      {/* ---- Totals + Recalculate/Finalize ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button onClick={() => void recalculate()} disabled={!recalcGate.allowed} title={recalcGate.title}
                  className="rounded border bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
            Recalculate
          </button>
          <button onClick={() => void finalize()} disabled={!finalizeGate.allowed} title={finalizeGate.title}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            Finalize
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm md:w-96">
          <span className="text-slate-600">Subtotal (operations)</span><span className="text-right">{invoice.subtotal.toFixed(2)}</span>
          <span className="text-slate-600">Surcharges</span><span className="text-right">{invoice.surchargeTotal.toFixed(2)}</span>
          <span className="text-slate-600">Charges</span><span className="text-right">{invoice.chargeTotal.toFixed(2)}</span>
          <span className="text-slate-600">Certification</span><span className="text-right">{invoice.certTotal.toFixed(2)}</span>
          <span className="text-slate-600">Freight</span><span className="text-right">{invoice.freightTotal.toFixed(2)}</span>
          <span className="text-slate-600">Tax</span><span className="text-right">{invoice.taxTotal.toFixed(2)}</span>
          <span className="border-t pt-1 font-medium">Total</span><span className="border-t pt-1 text-right font-medium">{invoice.total.toFixed(2)}</span>
        </div>
      </section>

      {/* ---- Documents + History ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Documents</h2>
        <InvoiceDocumentsList invoiceId={id} viewGate={docsGate} refresh={docsRefresh} />
      </section>

      <div className="mb-6">
        <HistoryPanel entity="invoice" entityId={id} />
      </div>
    </div>
  );
}
