"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { invalidateHistory } from "@/components/HistoryPanel";
import { gate, gateDo } from "@/lib/permission-ui";
import { useLatest } from "@/lib/use-latest";
import { TEMPLATE_DOC_TYPES } from "@/lib/template-contracts/index";
import {
  buildPickerRow, type AssignmentDisplay, type TemplateNameRow,
} from "@/lib/template-assignment-picker";

/**
 * The per-document-type template-assignment picker (spec §5.2, §5.5, §5.15, §5.16) — Task 20.
 *
 * For each of the 8 document types it shows the customer's CURRENT resolved state (its OWN
 * assignment / "Inherited from <ancestor>" / "<type> default (Standard)" — never blank, §5.15) and
 * a dropdown of that type's live templates. Selecting one ASSIGNS (PUT); the "Use default / inherit"
 * option CLEARS (DELETE), falling future paper back down the §5.2 chain.
 *
 * The resolution SOURCE is computed on the SERVER by the same walk the print resolver uses
 * (`resolveAssignmentsForCustomer` → the shared `resolveAssignment`), so this control never
 * reimplements resolution; it only renders it. The dropdown's template NAMES come from the
 * `requireUser`-only /api/templates/names read (§5.15: a customers.edit user without templates.view
 * must still see the names — the picklists precedent), the resolved STATE from the customers.view
 * /template-assignments/resolved read. A never-published template is disabled with its §5.16 tooltip
 * (the assign route refuses it — this matches that, it is not the gate).
 */
export function TemplateAssignmentsSection({
  customerId, perms, onError, onOptionsError,
}: {
  customerId: string;
  perms: string[] | undefined;
  onError: (message: string | null) => void;
  /** The mount fetch's own failure channel (the SurchargeOverridesSection precedent): `onError` is
   *  wired to the page's shared banner, which the page's own `load()` clears on its unrelated
   *  success — so a load failure reported there could vanish before the user saw it. `onOptionsError`
   *  is the page's `optionsError` channel that no unrelated refresh clears. */
  onOptionsError: (message: string) => void;
}) {
  // Both gates, exactly the route's own pair (customers.edit + edit_templates) and the templates
  // admin / surcharge sections' shape: the control is disabled-with-reason naming whichever is
  // missing (§5.16). The routes ENFORCE this; the UI only matches it.
  const canEdit = gate(perms, "customers.edit");
  const editTemplates = gateDo(perms, "edit_templates");
  const disabled = canEdit.disabled || editTemplates.disabled;
  const title = canEdit.disabled ? canEdit.title : editTemplates.title;

  const [names, setNames] = useState<TemplateNameRow[]>([]);
  const [resolutions, setResolutions] = useState<AssignmentDisplay[]>([]);
  // Set only once BOTH reads have landed — `resolutions` starts `[]` the same as "loaded, empty",
  // and the picker rows compose names × resolutions (the SurchargeOverridesSection `rowsReady`
  // precedent). Until then, show a quiet loading line rather than 8 blank rows.
  const [ready, setReady] = useState(false);

  const latest = useLatest();
  const loadResolved = useCallback(async () => {
    const ticket = latest.next();
    const r = await api<AssignmentDisplay[]>(`/api/customers/${customerId}/template-assignments/resolved`);
    if (!latest.isCurrent(ticket)) return;
    setResolutions(r);
  }, [customerId, latest]);

  useEffect(() => {
    // Names are stable for the page's life (no template is created from here); the resolved state
    // changes on every assign/clear, so only THAT is reloaded after a mutation.
    Promise.all([
      api<TemplateNameRow[]>("/api/templates/names"),
      loadResolved(),
    ]).then(([n]) => { setNames(n); setReady(true); })
      .catch((e) => onOptionsError(`Could not load template assignments: ${(e as Error).message}`));
  }, [loadResolved, onOptionsError]);

  // One at a time (the surcharge saveQueue precedent): a stray double-interaction on one row must
  // not race a change to another. Each mutation reloads the resolved state on its own turn; on
  // failure it reloads to server truth FIRST, then reports why (§5.13).
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  function run(fn: () => Promise<void>): void {
    const task = async () => {
      try {
        await fn();
        // #14 item 1, extended by #153: both callers of `run()` write a
        // `customerTemplateAssignment`, a registered child of this page's panel. Wired here
        // because this is the single success path they share; before the follow-up load.
        invalidateHistory();
        onError(null);
        await loadResolved();
      } catch (e) {
        await loadResolved().catch(() => {});
        onError((e as Error).message);
      }
    };
    saveQueue.current = saveQueue.current.then(task, task);
  }

  function onPick(docType: string, hasOwnAssignment: boolean, value: string): void {
    if (value === "") {
      if (!hasOwnAssignment) return; // already on the inherited/default fallback — nothing to clear
      run(() => api(`/api/customers/${customerId}/template-assignments?docType=${docType}`, { method: "DELETE" }));
      return;
    }
    run(() => api(`/api/customers/${customerId}/template-assignments`, {
      method: "PUT", body: JSON.stringify({ docType, templateId: value }),
    }));
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-1 font-medium">Document templates</h2>
      <p className="mb-3 max-w-2xl text-xs text-slate-500">
        Which template each document type prints with for this customer. Unset types inherit the
        parent division&rsquo;s choice, then fall back to the type&rsquo;s default.
      </p>
      {!ready ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="divide-y">
          {TEMPLATE_DOC_TYPES.map((docType) => {
            const display = resolutions.find((r) => r.docType === docType);
            if (!display) return null; // the resolved read always returns all 8 — defensive only
            const row = buildPickerRow(display, names);
            return (
              <div key={docType} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="w-48 shrink-0 font-medium">{row.docTypeLabel}</span>
                <select
                  aria-label={`Template for ${row.docTypeLabel}`}
                  value={row.selectedTemplateId}
                  disabled={disabled}
                  title={title}
                  onChange={(e) => onPick(docType, row.hasOwnAssignment, e.target.value)}
                  className="rounded border px-2 py-1 disabled:bg-slate-100"
                >
                  <option value="">Use default / inherit</option>
                  {row.options.map((o) => (
                    <option key={o.id} value={o.id} disabled={o.disabled} title={o.title}>
                      {o.name}{o.disabled ? " (not yet published)" : ""}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-slate-500">{row.stateLabel}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
