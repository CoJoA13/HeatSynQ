"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";

type FieldRow = { fieldId: string; name: string; type: string; sort: number; active: boolean; value: string };

export function CustomFieldsSection({
  partId, perms, onError,
}: {
  partId: string;
  perms: string[] | undefined;
  onError: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<FieldRow[]>([]);
  // Snapshot of what the server holds, keyed by fieldId — diffed against `rows` on Save so only
  // CHANGED rows are sent. Inactive defs are already filtered server-side to "active, or
  // inactive with a non-empty value" (listPartFieldValues); this component just labels them.
  const [original, setOriginal] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const canEdit = gate(perms, "parts.edit");

  const load = useCallback(async () => {
    const data = await api<FieldRow[]>(`/api/parts/${partId}/fields`);
    setRows(data);
    setOriginal(new Map(data.map((r) => [r.fieldId, r.value])));
  }, [partId]);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  function setValue(fieldId: string, value: string) {
    setRows((cur) => cur.map((r) => (r.fieldId === fieldId ? { ...r, value } : r)));
  }

  const dirty = rows.filter((r) => r.value !== (original.get(r.fieldId) ?? ""));

  // Not routed through the optimistic-then-rollback shape the other sections use: nothing here
  // is applied to the UI as if it had already succeeded, so a failed save has nothing to roll
  // back — the draft simply stays on screen exactly as typed, for the user to fix and retry,
  // same as the reason customers/[id]/page.tsx's add-address/add-contact drafts survive a
  // rejected POST.
  async function save() {
    if (dirty.length === 0) return;
    setSaving(true);
    try {
      await api(`/api/parts/${partId}/fields`, {
        method: "PUT",
        body: JSON.stringify({ values: dirty.map((r) => ({ fieldId: r.fieldId, value: r.value })) }),
      });
      onError(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (rows.length === 0) {
    return (
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Custom fields</h2>
        <p className="text-sm text-slate-500">No custom fields defined.</p>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Custom fields</h2>
        <button onClick={save} disabled={canEdit.disabled || dirty.length === 0 || saving} title={canEdit.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          {saving ? "Saving…" : "Save custom fields"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {rows.map((r) => (
          <label key={r.fieldId} className="block text-sm">
            {r.name}{!r.active && " (inactive)"}
            {r.type === "CHECKBOX" ? (
              <span className="ml-2 inline-flex items-center gap-2">
                <input type="checkbox" checked={r.value === "true"} disabled={!canEdit.allowed} title={canEdit.title}
                       onChange={(e) => setValue(r.fieldId, e.target.checked ? "true" : "false")} />
                {/* H3 (Codex round 3 review): a checkbox can only ever land on "true" or "false"
                    once touched, and since "false" is non-empty it counts as usage for the
                    field-def delete/type-change blockers (setPartFieldValues/partFieldDefBlockers)
                    — an unresolvable block, since nothing else in this control can ever produce
                    "". Shown only once there is something to clear, so it isn't dead space on
                    every already-unset checkbox field. Stages "" the same way every other edit
                    here does (setValue → dirty diff → Save), no server change needed: "" always
                    validates regardless of type (validateValue, src/server/part-field-values.ts). */}
                {r.value !== "" && (
                  <button type="button" onClick={() => setValue(r.fieldId, "")}
                          disabled={!canEdit.allowed} title="Clear this field (unset)"
                          className="text-xs text-slate-600 underline disabled:cursor-not-allowed disabled:text-slate-400">
                    clear
                  </button>
                )}
              </span>
            ) : r.type === "DATE" ? (
              <input type="date" value={r.value} readOnly={!canEdit.allowed} title={canEdit.title}
                     onChange={(e) => setValue(r.fieldId, e.target.value)}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            ) : r.type === "NUMBER" ? (
              <input value={r.value} inputMode="decimal" readOnly={!canEdit.allowed} title={canEdit.title}
                     onChange={(e) => setValue(r.fieldId, e.target.value)}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            ) : (
              <input value={r.value} readOnly={!canEdit.allowed} title={canEdit.title}
                     onChange={(e) => setValue(r.fieldId, e.target.value)}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            )}
          </label>
        ))}
      </div>
    </section>
  );
}
