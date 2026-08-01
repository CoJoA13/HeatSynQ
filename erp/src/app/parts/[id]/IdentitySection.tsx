"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import type { Part } from "./page";

type MaterialOption = { id: string; name: string; active: boolean };

export function IdentitySection({
  part, perms, save, patchDraft, onError,
}: {
  part: Part;
  perms: string[] | undefined;
  save: (patch: Record<string, unknown>) => Promise<boolean>;
  patchDraft: (patch: Partial<Part>) => void;
  onError: (message: string | null) => void;
}) {
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  // includeInactive=1: the assigned material (part.materialId) may since have been marked
  // inactive by an admin — the R3 pattern from customers/[id]/page.tsx's Terms/Parent selects.
  // Without it, a controlled <select> whose value matches no <option> silently falls back to the
  // blank choice, misrepresenting stored data and risking clobbering a real material on the next
  // interaction. No `.catch(() => {})` — a failed fetch here goes into the page's one error
  // banner via onError, same as every other fetch on this page.
  useEffect(() => {
    api<MaterialOption[]>("/api/picklists/material?includeInactive=1").then(setMaterials)
      .catch((e) => onError((e as Error).message));
  }, [onError]);

  const canEdit = gate(perms, "parts.edit");

  // Blur-save guard (customers/[id]/page.tsx precedent): only fields the user actually changed
  // reach the network, so tabbing through the form without editing doesn't write a no-op audit
  // entry for every field.
  const focusedValue = useRef("");
  const noteFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    focusedValue.current = e.target.value;
  };
  function onBlurSave(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
    opts: { trim?: boolean },
    commit: (value: string) => void,
  ) {
    const normalize = (v: string) => (opts.trim ? v.trim() : v);
    const value = normalize(e.target.value);
    if (value === normalize(focusedValue.current)) return;
    commit(value);
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
          <input value={part.partNumber} onFocus={noteFocus} readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ partNumber: e.target.value })}
                 onBlur={(e) => onBlurSave(e, { trim: true }, (partNumber) => void save({ partNumber }))}
                 className="mt-1 w-full rounded border px-2 py-1 font-mono read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Name
          <input value={part.name} onFocus={noteFocus} readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ name: e.target.value })}
                 onBlur={(e) => onBlurSave(e, { trim: true }, (name) => void save({ name }))}
                 className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
        </label>
        <label className="col-span-2 block text-sm">
          Description
          <textarea value={part.description} rows={2} onFocus={noteFocus} readOnly={!canEdit.allowed}
                    title={canEdit.title}
                    onChange={(e) => patchDraft({ description: e.target.value })}
                    onBlur={(e) => onBlurSave(e, {}, (description) => void save({ description }))}
                    className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Material
          <select value={part.materialId ?? ""} disabled={!canEdit.allowed} title={canEdit.title}
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
          <input value={part.eachWeight} inputMode="decimal" onFocus={noteFocus} readOnly={!canEdit.allowed}
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
          <input value={part.loadQty ?? ""} inputMode="numeric" onFocus={noteFocus} readOnly={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => patchDraft({ loadQty: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, (v) => {
                   // Trim before the empty-check: Number(" ") is 0, not NaN, so an untrimmed
                   // whitespace-only value would silently parse as the integer 0 instead of
                   // being treated as "cleared" like a truly empty value.
                   const trimmed = v.trim();
                   if (trimmed === "") { void save({ loadQty: null }); return; }
                   const n = Number(trimmed);
                   if (!Number.isInteger(n)) { onError("Load qty must be a whole number"); return; }
                   void save({ loadQty: n });
                 })}
                 className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Load weight
          <input value={part.loadWeight ?? ""} inputMode="decimal" onFocus={noteFocus} readOnly={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => patchDraft({ loadWeight: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, (v) => void save({ loadWeight: v === "" ? null : v }))}
                 className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
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
    </section>
  );
}
