"use client";
// The live PREVIEW pane (Phase 7 Task 19, spec §5.5) — beside the editor panels. The user picks a
// REAL record of the template's docType (reusing the house list endpoints, so the picker only offers
// records they can view), and this pane POSTs the WORKING (possibly-unsaved) config to
// /api/templates/[id]/preview, which renders it against that record and streams PDF bytes with ZERO
// side effects. The rendered PDF shows in an <iframe>, so a config edit + re-preview reflects live.
//
// Client component: it reaches the guarded APIs, so it never imports src/server/** — the
// docType→record mapping (`previewRecordSpec`) is pure/client-safe (the TemplateEditor precedent).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, trackedFetch } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { previewRecordSpec, type PreviewRecordKind } from "@/lib/template-editor";
import type { TemplateConfig, TemplateDocTypeString } from "@/lib/template-contracts";

/** A raw list row — the pane reads only the identity fields it labels, so it mirrors no server
 *  type (the client/server boundary). */
type RawRow = Record<string, unknown>;
type Option = { id: string; label: string };

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** Turn a list-endpoint's rows into pickable options — the shipment kinds filter by order count
 *  (SHIPPER = single, MOS_SHIPPER = multi; BOL = any), and voided/soft-deleted rows drop out. */
function optionsFor(kind: PreviewRecordKind, rows: RawRow[]): Option[] {
  // Drop soft-deleted rows (shipments/certs/invoices carry `deletedAt`) AND voided orders (the
  // board row carries `voided`, not `deletedAt`) — a preview against a dead record is confusing;
  // `!undefined` leaves the other kinds untouched.
  const live = rows.filter((r) => !r.deletedAt && !r.voided);
  switch (kind) {
    case "order":
      return live.map((r) => ({ id: str(r.id), label: `#${str(r.orderNumber)} — ${str(r.customerCode)} — ${str(r.leadPartNumber)}` }));
    case "shipment-single":
    case "shipment-multi":
    case "shipment": {
      const filtered = kind === "shipment-single" ? live.filter((r) => Number(r.orderCount) === 1)
        : kind === "shipment-multi" ? live.filter((r) => Number(r.orderCount) > 1)
        : live;
      return filtered.map((r) => ({
        id: str(r.id),
        label: `Shipment #${str(r.shipperNumber)} — ${str(r.customerCode)} (${str(r.orderCount)} order${Number(r.orderCount) === 1 ? "" : "s"})`,
      }));
    }
    case "cert":
      return live.map((r) => ({ id: str(r.id), label: `Cert — order #${str(r.orderNumber)} — ${str(r.customerCode)} (${str(r.scope)})` }));
    case "invoice":
      return live.map((r) => ({ id: str(r.id), label: `${r.kind === "CREDIT" ? "Credit" : "Invoice"} ${str(r.documentNumber)} — ${str(r.customerCode)}` }));
    case "customer":
      return live.map((r) => ({ id: str(r.id), label: `${str(r.code)} — ${str(r.name)}` }));
    case "quote":
      return live.map((r) => ({ id: str(r.id), label: `Quote #${str(r.quoteNumber)} — ${str(r.customerCode)} (${str(r.status)})` }));
  }
}

export function PreviewPane({
  templateId, docType, config,
}: {
  templateId: string;
  docType: TemplateDocTypeString;
  config: TemplateConfig;
}) {
  const spec = useMemo(() => previewRecordSpec(docType), [docType]);
  const { permissions: perms } = usePermissions();
  const listGate = gate(perms, spec.listPermission);

  const [options, setOptions] = useState<Option[] | null>(null);
  const [recordId, setRecordId] = useState("");
  const [asOf, setAsOf] = useState("");
  const [combineFamily, setCombineFamily] = useState(false);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the current object URL so it can be revoked before the next render / on unmount (the
  // Statements.tsx print precedent — a blob URL leaks until revoked).
  const urlRef = useRef<string | null>(null);

  // The picker's choices — fetched once the caller is known to hold the list permission (never a
  // silent-empty dropdown: the reason is named below when it's missing — §5.16).
  useEffect(() => {
    if (!listGate.allowed) { setOptions(null); return; }
    let live = true;
    api<RawRow[]>(spec.listPath)
      .then((rows) => { if (live) setOptions(optionsFor(spec.kind, rows)); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [spec, listGate.allowed]);

  // Revoke the outstanding blob URL when the pane unmounts.
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const runPreview = useCallback(async () => {
    if (!recordId) return;
    setRendering(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { recordId, config };
      if (spec.kind === "customer") { // STATEMENT — the only type with preview params
        if (asOf) body.asOf = asOf;
        body.combineFamily = combineFamily;
      }
      const res = await trackedFetch(`/api/templates/${templateId}/preview`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err: unknown = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `Preview failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setPreviewUrl(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRendering(false);
    }
  }, [recordId, config, spec.kind, asOf, combineFamily, templateId]);

  return (
    <section className="rounded border border-slate-200 p-3 lg:col-span-2" aria-label="Preview">
      <h2 className="mb-2 text-sm font-semibold text-slate-700">Live preview</h2>
      <p className="mb-2 text-xs text-slate-500">
        Renders the current draft — including unsaved edits — against a real {spec.noun}. Nothing is
        saved, printed, or archived.
      </p>

      {!listGate.allowed ? (
        <p className="rounded bg-slate-100 p-2 text-xs text-slate-600">
          Picking a {spec.noun} to preview requires the <code>{spec.listPermission}</code> permission.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">
            <span className="mr-1">Preview against:</span>
            <select aria-label="Preview record" value={recordId}
                    onChange={(e) => setRecordId(e.target.value)}
                    className="rounded border px-1.5 py-1">
              <option value="">— pick a {spec.noun} —</option>
              {(options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>

          {spec.kind === "customer" && (
            <>
              <label className="text-xs text-slate-600">
                <span className="mr-1">As of:</span>
                <input aria-label="Statement as-of date" type="date" value={asOf}
                       onChange={(e) => setAsOf(e.target.value)} className="rounded border px-1.5 py-1" />
              </label>
              <label className="flex items-center gap-1 text-xs text-slate-600">
                <input aria-label="Combine family" type="checkbox" checked={combineFamily}
                       onChange={(e) => setCombineFamily(e.target.checked)} />
                Combine family
              </label>
            </>
          )}

          <button type="button" aria-label="Run preview" onClick={() => void runPreview()}
                  disabled={!recordId || rendering}
                  className="rounded bg-slate-700 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {rendering ? "Rendering…" : previewUrl ? "Refresh preview" : "Preview"}
          </button>
        </div>
      )}

      {options !== null && options.length === 0 && listGate.allowed && (
        <p className="mt-2 text-xs text-slate-500">No {spec.noun}s to preview against yet.</p>
      )}
      {error && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700" role="alert">{error}</p>}

      {previewUrl && (
        <iframe title="Template preview" src={previewUrl}
                className="mt-3 h-[600px] w-full rounded border border-slate-300" />
      )}
    </section>
  );
}
