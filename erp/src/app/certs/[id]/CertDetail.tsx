"use client";
// The certification page's body (design spec §11 "Cert page"): header (order link, scope and its
// subject, printed date, void), a prominent three-state pass/fail summary WITH the §3.21
// explanation (none of it prints), one requirement block per seeded `CertRequirement` grouped by
// part line (RequirementBlock.tsx), freeform + internal notes, the live print action (Task 19's
// POST /api/certs/[id]/print, wired at the fold-in), stored documents, and History. Remounted per
// id by page.tsx's `key={id}` (HANDOFF §5.12).
//
// THE BINDING STATE MODEL (the ShipmentDetail.tsx / order-hub precedent): notes PATCHes are
// optimistic with rollback-then-report on failure (§5.13 — reload BEFORE setting the error,
// never after); a readings save is non-optimistic (the block's draft is applied only through the
// server's own fresh response) and a FAILED save is also rollback-then-report — reload server
// truth, discard the block's draft (bumpReset remounts it), then show the error. Every mutating
// call on this page answers with the ENTIRE fresh CertDetail, so all of them share ONE monotonic
// mutation-ticket sequence (`useMutationGate`, fix-wave R4 finding 6).
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useMutationGate } from "@/lib/use-latest";
import { HistoryPanel } from "@/components/HistoryPanel";
import { CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import { RequirementBlock, type ReadingPayload } from "./RequirementBlock";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/certs.ts's `CertDetail`/`CertRequirementDetail`/
// `CertReadingDetail` — not imported from src/server/** (CLAUDE.md: a client component pulling
// from there drags node:async_hooks and Prisma into the browser bundle). Dates cross the wire as
// ISO strings. Exported so RequirementBlock.tsx imports the ones it needs — the
// ShipmentDetail.tsx precedent.
// ---------------------------------------------------------------------------------------------

export type CertReadingRow = {
  id: string; position: number; value: number | null;
  passed: boolean | null; overridden: boolean; note: string;
};
export type CertRequirementRow = {
  id: string; orderLineId: string; linePosition: number; partNumber: string; partName: string;
  position: number; inspectionCodeName: string; scaleName: string | null;
  min: number | null; max: number | null; sampleQty: string; location: string;
  readings: CertReadingRow[];
};
export type CertDetailData = {
  id: string; orderId: string; orderNumber: number; sequence: number | null;
  customerCode: string; customerName: string; scope: CertScopeValue;
  loadNumber: number | null; shipperId: string | null; shipperNumber: number | null;
  printedAt: string | null; deletedAt: string | null;
  freeform: string; internalNotes: string;
  poNumber: string; material: string; receivedDate: string;
  requirements: CertRequirementRow[];
};

/** Slice of `GET /api/certs/[id]/documents`'s `DocumentMeta` (src/server/documents.ts). */
type StoredDoc = { id: string; kind: string; createdAt: string };
type AuditEntry = { id: string; action: string; reason: string | null };

/** Spec §3.19: a cert has no number of its own — its label is its order number, plus that
 *  order's shipment sequence for SHIPMENT scope (`#72036-3`), the CertList.tsx precedent. */
function certLabel(cert: CertDetailData): string {
  return cert.scope === "SHIPMENT" && cert.sequence !== null
    ? `#${cert.orderNumber}-${cert.sequence}`
    : `#${cert.orderNumber}`;
}

/** The scope's SUBJECT (task-16-brief.md Step 1): the load number or the packing-list number —
 *  ORDER scope carries neither, the CertList.tsx `loadOrShipment` precedent. */
function scopeSubject(cert: CertDetailData): string | null {
  if (cert.scope === "LOAD") return cert.loadNumber !== null ? `Load ${cert.loadNumber}` : null;
  if (cert.scope === "SHIPMENT") return cert.shipperNumber !== null ? `Packing List ${cert.shipperNumber}` : null;
  return null;
}

/** A voided cert is read-only everywhere (spec §5.6, the P3 voided-order shape) regardless of
 *  what the permission grid would otherwise allow — the ShipmentDetail.tsx `voidLocked`
 *  precedent. */
function voidLocked(g: Gate, voided: boolean): Gate {
  return voided ? { allowed: false, disabled: true, title: "Certification is voided" } : g;
}

/** The results-grid gate (§5.16 — a disabled control SAYS WHY): voided locks everything; then
 *  `certs.edit`; then, once `printedAt` is set, additionally the named special action. The
 *  after-print title names the missing permission the way `gateDo`'s own tooltip would. */
function resultsGateFor(perms: string[] | undefined, voided: boolean, printed: boolean): Gate {
  const edit = voidLocked(gate(perms, "certs.edit"), voided);
  if (!edit.allowed) return edit;
  if (printed) {
    const after = gateDo(perms, "edit_cert_results_after_print");
    if (!after.allowed) {
      return {
        allowed: false, disabled: true,
        title: "This certification has been printed — editing results requires edit_cert_results_after_print",
      };
    }
  }
  return edit;
}

/** The stored-documents list (spec §11) — `GET /api/certs/[id]/documents` (Task 16; no other
 *  HTTP caller existed for `listDocumentsForCert` before this page needed one). Not printing
 *  itself (Task 19 owns that); a plain link to the existing, already-gated
 *  `GET /api/documents/[id]` download route — the ShipmentDocumentsList precedent. */
function CertDocumentsList({ certId, viewGate, refresh }: { certId: string; viewGate: Gate; refresh: number }) {
  const [docs, setDocs] = useState<StoredDoc[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!viewGate.allowed) return;
    api<StoredDoc[]>(`/api/certs/${certId}/documents`).then(setDocs)
      .catch((e) => setErr((e as Error).message));
  }, [certId, viewGate.allowed, refresh]);

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
                {d.kind === "CERT" ? "Certification" : d.kind}
              </a>
            </td>
            <td className="text-slate-600">{new Date(d.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CertDetail({ id }: { id: string }) {
  const { permissions: perms, error: permsError } = usePermissions();

  const [cert, setCert] = useState<CertDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // undefined = fetched but no reason could be resolved (missing admin.view, the fetch failed,
  // or the latest entry wasn't a delete); null = not applicable (cert isn't voided) — the
  // ShipmentDetail.tsx `voidReason` precedent.
  const [voidReason, setVoidReason] = useState<string | null | undefined>(null);
  // Per-requirement remount counters: bumping one discards THAT block's draft and re-seeds it
  // from server truth — after a successful save (fresh computed pass/fail comes back) and after
  // a FAILED save (rollback-then-report). Other blocks' keys are untouched, so their unsaved
  // drafts survive — the merge semantics of PUT …/results, mirrored client-side.
  const [blockResets, setBlockResets] = useState<Map<string, number>>(new Map());
  const bumpReset = useCallback((requirementId: string) => {
    setBlockResets((prev) => {
      const next = new Map(prev);
      next.set(requirementId, (next.get(requirementId) ?? 0) + 1);
      return next;
    });
  }, []);

  // ONE monotonic ticket sequence shared by every write and by `load`'s own refresh — every
  // mutating call here replaces the whole `cert` state, so overlapping calls race and the ticket
  // ensures the winner is whichever is genuinely newest (the ShipmentDetail.tsx precedent).
  const mutations = useMutationGate();

  const load = useCallback(async () => {
    const ticket = mutations.next();
    const detail = await api<CertDetailData>(`/api/certs/${id}`);
    if (mutations.accept(ticket)) setCert(detail);
    return detail;
  }, [id, mutations]);
  useEffect(() => {
    load().then(() => setError(null)).catch((e) => setError((e as Error).message));
  }, [load]);

  const applyMutation = useCallback(async (run: () => Promise<CertDetailData>) => {
    const ticket = mutations.next();
    const detail = await run();
    if (mutations.accept(ticket)) setCert(detail);
  }, [mutations]);

  const voided = (cert?.deletedAt ?? null) !== null;
  const printed = (cert?.printedAt ?? null) !== null;
  const auditGate = gate(perms, "admin.view");
  const docsGate = gate(perms, "certs.view");
  const notesGate = voidLocked(gate(perms, "certs.edit"), voided);
  const resultsGate = resultsGateFor(perms, voided, printed);
  const voidGate = voided
    ? { allowed: false, disabled: true, title: "Already voided" }
    : gate(perms, "certs.delete");
  // Print (Task 19's POST /api/certs/[id]/print, live since the fold-in). Gated certs.view like
  // the route — printing mutates nothing beyond the first-print printedAt fact and its own
  // audited archive. A voided cert refuses NEW prints forever (spec §5.6), which is the more
  // specific reason when both apply (§5.16 — disabled with a truthful title, never hidden).
  const printGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Certification is voided — no new documents can be produced for it" }
    : gate(perms, "certs.view");

  // Voided banner's reason (ShipmentDetail.tsx precedent) — safe to key on `voided` alone: once
  // voided, no mutator can touch the cert again, so the delete entry, if readable, is entries[0].
  useEffect(() => {
    if (!voided) { setVoidReason(null); return; }
    if (!auditGate.allowed) { setVoidReason(undefined); return; }
    api<AuditEntry[]>(`/api/admin/audit?entity=cert&entityId=${id}`)
      .then((entries) => {
        const latest = entries[0];
        setVoidReason(latest?.action === "delete" ? (latest.reason ?? undefined) : undefined);
      })
      .catch(() => setVoidReason(undefined));
  }, [voided, auditGate.allowed, id]);

  // ---- Notes: optimistic blur-save PATCH (ShipmentDetail.tsx `patchHeader` precedent) ----

  /** Optimistic: the field shows the typed value immediately; a rejection rolls back to server
   *  truth FIRST and only then reports why (§5.13 — a reload after the error is set would clear
   *  it, since the initial-load effect resets `error` on success but `load` itself never does). */
  async function patchNotes(patch: { freeform?: string; internalNotes?: string }): Promise<void> {
    setCert((cur) => (cur ? { ...cur, ...patch } : cur));
    try {
      await applyMutation(() => api<CertDetailData>(
        `/api/certs/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
      setError(null);
    } catch (e) {
      await load().catch(() => {});
      setError((e as Error).message);
    }
  }

  // Blur-save guard (customers/[id]/page.tsx precedent): a field that saved unconditionally on
  // blur would PATCH (and audit) every simple tab-through even when nothing changed.
  const focusedValue = useRef("");
  const onFocusRemember = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    focusedValue.current = e.target.value;
  };
  function onBlurSave(e: React.FocusEvent<HTMLTextAreaElement>, commit: (value: string) => void) {
    if (e.target.value === focusedValue.current) return;
    commit(e.target.value);
  }

  // ---- Readings: non-optimistic per-requirement save (merge semantics — only the named
  // requirement's readings are replaced; every other requirement is untouched server-side) ----

  const saveReadings = useCallback(async (requirementId: string, readings: ReadingPayload[]) => {
    try {
      await applyMutation(() => api<CertDetailData>(`/api/certs/${id}/results`, {
        method: "PUT", body: JSON.stringify({ requirements: [{ id: requirementId, readings }] }),
      }));
      setError(null);
      bumpReset(requirementId); // re-seed the block from the fresh server truth (computed passed)
    } catch (e) {
      // Rollback-then-report (§5.13): server truth back into state, the block's draft discarded,
      // and only THEN the error — so the report survives the reload.
      await load().catch(() => {});
      bumpReset(requirementId);
      setError((e as Error).message);
    }
  }, [id, applyMutation, load, bumpReset]);

  // ---- Print: the ShipmentDetail.tsx `printDoc` pipeline (popup handling and error surfacing
  // shared shape; the x-print-warnings decode there is shipment-specific and has no counterpart
  // here — the cert route carries no warnings header). After a successful print the page reloads
  // server truth so the §5.16 post-print gate engages live (printedAt is now set), and the
  // Documents list refreshes to show the newly archived print. ----

  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [docsRefresh, setDocsRefresh] = useState(0);

  const printCertAction = useCallback(async () => {
    setPrinting(true);
    setPrintError(null);
    try {
      const res = await fetch(`/api/certs/${id}/print`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Print failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      const opened = window.open(url, "_blank");
      if (opened) opened.opener = null;
      if (opened === null) {
        // Never silent (the DocumentsSection rule): the print HAPPENED and is archived — the
        // refreshed Documents list below is the escape hatch, and this message says so.
        setPrintError("The browser blocked the print window — the certification was archived and is in Documents below.");
      }
      // Revoked on a delay either way — revoking immediately would race the new tab's own load
      // (the DocumentsSection precedent, fix-wave finding 6).
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDocsRefresh((n) => n + 1);
      // printedAt is now set server-side (first print) — reload so the results-grid gate and the
      // header's Printed fact reflect it. A failed refresh must not read as a failed print.
      try {
        await load();
      } catch (e) {
        setPrintError(`Printed and archived, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
      }
    } catch (e) {
      setPrintError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }, [id, load]);

  // ---- Void: non-optimistic (ShipmentDetail.tsx `voidAction` precedent) ----

  async function voidAction() {
    if (!cert) return;
    const reason = prompt(
      `Void certification ${certLabel(cert)}?\n\n` +
      "Every control on this certification becomes read-only; its stored prints stay " +
      "reprintable forever, and this cannot be undone through the UI.\n\n" +
      "Reason for voiding (recorded in the audit history):",
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to void a certification."); return; }
    // Two separate try/catches: DELETE returns `{ ok: true }`, not a fresh CertDetail, so
    // picking up deletedAt needs a follow-up `load()` — and if THAT fails, the void succeeded.
    try {
      await api(`/api/certs/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Certification voided, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  if (!cert) return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;

  // Three explicit states over the actual readings — passed === true / failed === false /
  // pending === null. Never inferred by subtraction (the Task 15 review finding CertList.tsx's
  // own header comment records): a reading nobody has entered is PENDING, not a pass.
  const allReadings = cert.requirements.flatMap((r) => r.readings);
  const passedCount = allReadings.filter((r) => r.passed === true).length;
  const failCount = allReadings.filter((r) => r.passed === false).length;
  const pendingCount = allReadings.filter((r) => r.passed === null).length;

  // Requirement blocks grouped by part line (task-16-brief.md Step 2), preserving the cert's own
  // running `position` order within and across groups — requirements arrive position-ordered, so
  // grouping by consecutive orderLineId keeps both orders intact.
  const groups: { orderLineId: string; linePosition: number; partNumber: string; partName: string; requirements: CertRequirementRow[] }[] = [];
  for (const req of cert.requirements) {
    const last = groups[groups.length - 1];
    if (last && last.orderLineId === req.orderLineId) last.requirements.push(req);
    else groups.push({
      orderLineId: req.orderLineId, linePosition: req.linePosition,
      partNumber: req.partNumber, partName: req.partName, requirements: [req],
    });
  }

  const subject = scopeSubject(cert);

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          Certification {certLabel(cert)}
          <span className="ml-3 text-base font-normal text-slate-500">
            {cert.customerCode} · {cert.customerName}
          </span>
        </h1>
        <button onClick={() => void voidAction()} disabled={voidGate.disabled} title={voidGate.title}
                className="rounded border border-red-600 px-3 py-1.5 text-sm text-red-600 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
          Void certification
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

      {/* ---- Header facts (brief Step 1): order link, scope + subject, printed date ---- */}
      <section className="mb-4 rounded border bg-white p-4 text-sm">
        <div className="flex flex-wrap gap-x-8 gap-y-1">
          <span>
            Order{" "}
            <Link href={`/orders/${cert.orderId}`} className="font-mono text-blue-700 underline">
              #{cert.orderNumber}
            </Link>
          </span>
          <span>
            Scope <b>{CERT_SCOPE_LABELS[cert.scope]}</b>
            {subject && <span className="text-slate-600"> — {subject}</span>}
          </span>
          <span>
            Printed{" "}
            {cert.printedAt
              ? <b>{new Date(cert.printedAt).toLocaleString()}</b>
              : <span className="text-slate-500">not yet</span>}
          </span>
          {cert.poNumber && <span className="text-slate-600">PO {cert.poNumber}</span>}
          {cert.material && <span className="text-slate-600">Material {cert.material}</span>}
          <span className="text-slate-600">Received {cert.receivedDate}</span>
        </div>
      </section>

      {/* ---- Pass/fail, prominently — with the §3.21 explanation (brief Step 2) ---- */}
      <section className="mb-4 rounded border bg-white p-4">
        <div className="flex flex-wrap items-baseline gap-x-6 text-lg font-semibold">
          {allReadings.length === 0 ? (
            <span className="text-slate-500">No readings yet</span>
          ) : (
            <>
              <span className="text-green-700">{passedCount} passed</span>
              <span className={failCount > 0 ? "text-red-700" : "text-slate-400"}>{failCount} failed</span>
              <span className={pendingCount > 0 ? "text-amber-700" : "text-slate-400"}>{pendingCount} pending</span>
            </>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Pass/fail is shown on screen only — it <b>never appears on the printed certification</b>,
          and neither do min/max, scale, or override marks. The printed document carries the bare
          reading values.
        </p>
      </section>

      {/* ---- Print + documents (brief Step 5; live via POST /api/certs/[id]/print) ---- */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded border bg-slate-50 p-3 text-sm">
        {/* §5.16: while a print is in flight the button is disabled for a reason the gate cannot
            name (printGate.title is undefined when allowed), so the in-progress state says why
            itself (fix-wave 2026-08-06). */}
        <button type="button" onClick={() => void printCertAction()}
                disabled={printGate.disabled || printing}
                title={printing ? "A print is already in progress — wait for it to finish" : printGate.title}
                className="rounded border bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
          {printing ? "Printing…" : "Print certification"}
        </button>
        <span className="text-xs text-slate-500">
          {voided
            ? "This certification is voided — stored prints below remain reprintable; new prints are refused."
            : "Prints with your signature, and is archived under Documents below."}
        </span>
        {printError && <span className="text-xs text-red-700">{printError}</span>}
      </div>

      {/* ---- Requirement blocks, grouped by part line (brief Step 2) ---- */}
      {groups.length === 0 && (
        <p className="mb-4 rounded border bg-white p-4 text-sm text-slate-500">
          No requirements were seeded for this certification — none of its order&apos;s parts had
          live inspection requirements when it was created.
        </p>
      )}
      {groups.map((group) => (
        <section key={group.orderLineId} className="mb-4 rounded border bg-white p-4">
          <h2 className="mb-3 font-medium">
            Line {group.linePosition} — <span className="font-mono">{group.partNumber}</span>
            <span className="ml-2 font-normal text-slate-600">{group.partName}</span>
          </h2>
          {group.requirements.map((req) => (
            <RequirementBlock
              key={`${req.id}:${blockResets.get(req.id) ?? 0}`}
              requirement={req} editGate={resultsGate} onSave={saveReadings}
            />
          ))}
        </section>
      ))}

      {/* ---- Notes (brief Step 3) ---- */}
      <section className="mb-4 rounded border bg-white p-4 text-sm">
        <h2 className="mb-2 font-medium">Notes</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span>Freeform <span className="text-xs text-slate-500">(prints on the certification)</span></span>
            <textarea value={cert.freeform} rows={4} onFocus={onFocusRemember}
                      readOnly={!notesGate.allowed} title={notesGate.title}
                      onChange={(e) => setCert({ ...cert, freeform: e.target.value })}
                      onBlur={(e) => onBlurSave(e, (freeform) => void patchNotes({ freeform }))}
                      className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
          </label>
          <label className="block">
            <span>
              Internal notes{" "}
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                never printed
              </span>
            </span>
            <textarea value={cert.internalNotes} rows={4} onFocus={onFocusRemember}
                      readOnly={!notesGate.allowed} title={notesGate.title}
                      onChange={(e) => setCert({ ...cert, internalNotes: e.target.value })}
                      onBlur={(e) => onBlurSave(e, (internalNotes) => void patchNotes({ internalNotes }))}
                      className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
          </label>
        </div>
      </section>

      {/* ---- Documents + History (brief Step 5) ---- */}
      <section className="mb-4 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Documents</h2>
        <CertDocumentsList certId={id} viewGate={docsGate} refresh={docsRefresh} />
      </section>

      <div className="mb-6">
        <HistoryPanel entity="cert" entityId={id} />
      </div>
    </div>
  );
}
