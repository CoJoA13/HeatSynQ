"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { CERT_SCOPES, CERT_SCOPE_LABELS } from "@/lib/cert-constants";
import type { EditGuard } from "@/lib/use-edit-guard";
import type { Part } from "./page";

type MaterialOption = { id: string; name: string; active: boolean };

export function IdentitySection({
  part, perms, save, patchDraft, editGuard, onError, onOptionsError,
}: {
  part: Part;
  perms: string[] | undefined;
  save: (patch: Record<string, unknown>) => Promise<boolean>;
  patchDraft: (patch: Partial<Part>) => void;
  editGuard: EditGuard;
  onError: (message: string | null) => void;
  onOptionsError: (message: string) => void;
}) {
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  // F9: a failed material-options fetch used to report through the shared `onError`, the same
  // state a later successful field save resets to null — so a save elsewhere on this page could
  // silently erase the warning while the Material select sat enabled with an empty options list
  // (the customers/[id]/page.tsx F4 precedent this mirrors). `onOptionsError` writes into the
  // page's own persistent `loadError` instead, which no section save clears, and `materialsReady`
  // below disables the select until the fetch actually succeeds so a stale/blank assignment can't
  // be clobbered by a "successful" interaction with an empty list.
  //
  // includeInactive=1: the assigned material (part.materialId) may since have been marked
  // inactive by an admin — the R3 pattern from customers/[id]/page.tsx's Terms/Parent selects.
  // Without it, a controlled <select> whose value matches no <option> silently falls back to the
  // blank choice, misrepresenting stored data and risking clobbering a real material on the next
  // interaction.
  const [materialsReady, setMaterialsReady] = useState(false);
  useEffect(() => {
    api<MaterialOption[]>("/api/picklists/material?includeInactive=1").then((data) => {
      setMaterials(data);
      setMaterialsReady(true);
    }).catch((e) => onOptionsError((e as Error).message));
  }, [onOptionsError]);

  const canEdit = gate(perms, "parts.edit");

  // Blur-save guard, now the page-level editGuard (use-edit-guard.ts — the customers/[id]/
  // page.tsx noteFocusC shape): the no-op half is unchanged (only fields the user actually
  // changed reach the network), and registering WHICH Part property is under the cursor is what
  // lets the page's reload merge preserve the field mid-typing when a sibling save's §5.13
  // rollback (or any other reload) lands.
  const noteFocus = (key: keyof Part & string) => editGuard.onFocusField(key);
  function onBlurSave(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
    opts: { trim?: boolean },
    commit: (value: string, atFocus: string) => void,
  ) {
    editGuard.onBlurSave(e, commit, opts);
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Identity</h2>
      {/* Customer is read-only and never an input — customerId is immutable (updatePart rejects
          any patch carrying it outright). */}
      <p className="mb-3 text-sm">
        Customer:{" "}
        <Link href={`/customers/${part.customerId}`} className="text-blue-700 underline">
          {part.customerCode} · {part.customerName}
        </Link>
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          Part number
          <input value={part.partNumber} onFocus={noteFocus("partNumber")} readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ partNumber: e.target.value })}
                 onBlur={(e) => onBlurSave(e, { trim: true }, (partNumber) => void save({ partNumber }))}
                 className="mt-1 w-full rounded border px-2 py-1 font-mono read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Name
          <input value={part.name} onFocus={noteFocus("name")} readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ name: e.target.value })}
                 onBlur={(e) => onBlurSave(e, { trim: true }, (name) => void save({ name }))}
                 className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
        </label>
        <label className="col-span-2 block text-sm">
          Description
          <textarea value={part.description} rows={2} onFocus={noteFocus("description")} readOnly={!canEdit.allowed}
                    title={canEdit.title}
                    onChange={(e) => patchDraft({ description: e.target.value })}
                    onBlur={(e) => onBlurSave(e, {}, (description) => void save({ description }))}
                    className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
        </label>
        {/* Phase 7 Task 15: presentation vocabulary (spec §5.7 ruling 4) — names the part's process
            for the traveler's Process: slot, bound live at print, blank prints nothing. A plain
            optional text field; controlled off `part.processName` (which the id-keyed PartDetail
            reloads fresh per record, §5.12), read-only without parts.edit (§5.16). */}
        <label className="col-span-2 block text-sm">
          Process name
          <input value={part.processName} onFocus={noteFocus("processName")} readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ processName: e.target.value })}
                 onBlur={(e) => onBlurSave(e, { trim: true }, (processName) => void save({ processName }))}
                 className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          <span className="mt-1 block text-xs text-slate-500">
            Prints on the traveler&apos;s Process: line (e.g. Austemper). Blank prints nothing.
          </span>
        </label>
        <label className="block text-sm">
          Material
          <select value={part.materialId ?? ""} disabled={!canEdit.allowed || !materialsReady}
                  title={!materialsReady ? "Options failed to load — reload the page" : canEdit.title}
                  onChange={(e) => void save({ materialId: e.target.value || null })}
                  className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-100">
            <option value="">— none —</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>{m.name}{!m.active && " (inactive)"}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Each weight
          <input value={part.eachWeight} inputMode="decimal" onFocus={noteFocus("eachWeight")} readOnly={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => patchDraft({ eachWeight: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, (v) => void save({ eachWeight: v }))}
                 className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Load qty
          {/* Server-side loadQty is a real int (z.number().int(), not decimalField's
              number-or-decimal-string), so unlike every other numeric field here the commit path
              parses to a number itself rather than forwarding the typed text — a non-numeric
              value would otherwise JSON.stringify to `null` (JSON has no NaN) and silently clear
              the field instead of surfacing as the "must be a whole number" 400 the server would
              give a well-formed request. */}
          <input value={part.loadQty ?? ""} inputMode="numeric" onFocus={noteFocus("loadQty")} readOnly={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => patchDraft({ loadQty: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, (v, atFocus) => {
                   // Trim before the empty-check: Number(" ") is 0, not NaN, so an untrimmed
                   // whitespace-only value would silently parse as the integer 0 instead of
                   // being treated as "cleared" like a truly empty value.
                   const trimmed = v.trim();
                   if (trimmed === "") { void save({ loadQty: null }); return; }
                   const n = Number(trimmed);
                   if (!Number.isInteger(n)) {
                     // H2 (Codex round 3 review): this branch never reaches save(), so it can't
                     // rely on save()'s own catch (which rolls back via the page's rollback
                     // reload before reporting, §5.13) — but leaving the invalid typed text
                     // sitting in the shared `part` state (patchDraft already echoed it there on
                     // every keystroke, onChange below) makes it pseudo-server state: a later,
                     // unrelated successful save elsewhere on this page clears `error` on its
                     // own success path while the invalid text stays put looking saved. Restore
                     // server truth BEFORE reporting, same ordering as every other failure path
                     // on this page. `atFocus` is the editGuard's own snapshot of what this
                     // field displayed before THIS edit began — the last value it actually
                     // loaded/committed — the customers requestDaysOverride precedent.
                     patchDraft({ loadQty: atFocus });
                     onError("Load qty must be a whole number");
                     return;
                   }
                   void save({ loadQty: n });
                 })}
                 className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Load weight
          <input value={part.loadWeight ?? ""} inputMode="decimal" onFocus={noteFocus("loadWeight")} readOnly={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => patchDraft({ loadWeight: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, (v) => void save({ loadWeight: v === "" ? null : v }))}
                 className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Request days override
          {/* Same real-int shape (and the same client-side parse-before-send reasoning) as Load
              qty above — the server's requestDaysOverride is z.number().int(), not a
              decimalField's number-or-decimal-string, so the typed text is parsed to a number
              here rather than forwarded as-is. Blank clears the override, falling back to the
              customer's own override, then the plant default (spec §7.1's most-specific-wins
              chain — orders.ts). */}
          <input value={part.requestDaysOverride ?? ""} inputMode="numeric" onFocus={noteFocus("requestDaysOverride")}
                 readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ requestDaysOverride: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, (v, atFocus) => {
                   const trimmed = v.trim();
                   if (trimmed === "") { void save({ requestDaysOverride: null }); return; }
                   const n = Number(trimmed);
                   if (!Number.isInteger(n)) {
                     patchDraft({ requestDaysOverride: atFocus });
                     onError("Request days override must be a whole number");
                     return;
                   }
                   void save({ requestDaysOverride: n });
                 })}
                 className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          <span className="mt-1 block text-xs text-slate-500">Blank uses the plant/customer default.</span>
        </label>
      </div>
      <div className="mt-3 flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={part.serializationRequired} disabled={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => void save({ serializationRequired: e.target.checked })} />
          Serialization required
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={part.active} disabled={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => void save({ active: e.target.checked })} />
          Active
        </label>
      </div>
      {/* Certification chain (spec §6.1, Task 17): three-state, never a checkbox — an explicit
          "No" and "inherit" are different answers (a part can override a cert-required customer
          back DOWN), and the Inherit option names what it currently resolves to (customer
          default, else plant setting — `inheritedCert*`, computed server-side) so choosing it is
          never a blind fallback. Selects save on change like Material above; §5.16 gating. */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block text-sm">
          Certification required
          <select value={part.certRequired === null ? "" : part.certRequired ? "yes" : "no"}
                  disabled={!canEdit.allowed} title={canEdit.title}
                  onChange={(e) => void save({ certRequired: e.target.value === "" ? null : e.target.value === "yes" })}
                  className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-100">
            <option value="">Inherit — currently {part.inheritedCertRequired ? "Yes" : "No"}</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label className="block text-sm">
          Certification scope
          <select value={part.certScope ?? ""} disabled={!canEdit.allowed} title={canEdit.title}
                  onChange={(e) => void save({ certScope: e.target.value === "" ? null : e.target.value })}
                  className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-100">
            <option value="">Inherit — currently {CERT_SCOPE_LABELS[part.inheritedCertScope]}</option>
            {CERT_SCOPES.map((s) => <option key={s} value={s}>{CERT_SCOPE_LABELS[s]}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
