"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { STEP_FIELD_TYPES, type StepFieldType } from "@/lib/step-field-constants";
import { gate } from "@/lib/permission-ui";
import { swapAt } from "@/lib/reorder";
import { usePermissions } from "@/lib/use-permissions";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { HistoryPanel } from "@/components/HistoryPanel";

type Field = { id?: string; label: string; type: StepFieldType; unit: string | null; sort: number };
type Code = {
  id: string; code: string; name: string; glAccountId: string | null;
  active: boolean; needsGlAccount: boolean; fields: Field[];
};
type Gl = { id: string; name: string; description?: string };
type SavePayload = { body: object; fieldCtx?: { defId: string; label: string } };

export default function StepCodesPage() {
  const [codes, setCodes] = useState<Code[]>([]);
  const [gls, setGls] = useState<Gl[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState({ code: "", name: "" });
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ code: Code; list: Blocker[] } | null>(null);
  // Fix-wave Finding 1 (2026-08-02 final review): stepFieldBlockers existed and was tested but
  // nothing consumed it — a field-def delete/type-change refusal showed only a count, no
  // discoverable blockers (spec §5.14). `defId`/`label` name the field the refusal named.
  const [fieldBlocked, setFieldBlocked] = useState<{ defId: string; label: string; list: Blocker[] } | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();

  // Gated per the permission each route actually enforces (part-fields.tsx / ReferenceTable.tsx
  // precedent — this page previously gated none of this): create hits POST requiring
  // admin.create; every scalar edit, active toggle, and field-def change hits PUT requiring
  // admin.edit (fields are replaced wholesale, id-preserving, through the same PUT — there is no
  // separate per-field route); delete hits DELETE requiring admin.delete.
  const canCreate = gate(perms, "admin.create");
  const canEdit = gate(perms, "admin.edit");
  const canDelete = gate(perms, "admin.delete");

  // includeInactive=1 always: the Active column IS the reactivation control (part-fields.tsx
  // precedent), so a code just switched off must stay visible and selectable to be switched back on.
  // Mirrors `codes` for the save queue to read at RUN time. A queued transform must see the field
  // set as it is when its turn comes, not as it was when the user clicked — see enqueueFieldOp.
  const codesRef = useRef<Code[]>([]);
  const load = useCallback(async () => {
    const [c, g] = await Promise.all([
      api<Code[]>("/api/admin/step-codes?includeInactive=1"),
      api<Gl[]>("/api/admin/reference/glAccount"),
    ]);
    setCodes(c); codesRef.current = c; setGls(g);
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // A stale blocker panel from a previously selected code must not linger once selection moves on.
  useEffect(() => { setBlocked(null); setFieldBlocked(null); }, [selected]);

  const current = codes.find((c) => c.id === selected) ?? null;

  // The two exact refusal messages syncStepFields (process-step-codes.ts) throws when a field def
  // still has PartProcessStepValue rows pointing at it — the only two field-save failures a
  // blocker panel can actually explain.
  const isFieldGuardMessage = (message: string) =>
    message.startsWith('Cannot remove field "') || message.startsWith('Cannot change the type of "');

  // Shared by every scalar/active/field-def edit: rolls back to server truth on failure BEFORE
  // reporting why (§5.13) — a failed save must not leave a stale, unsaved value in the grid
  // looking as if it took effect. The reload's own failure is swallowed only because the original
  // error is what gets reported; it is not silencing that error.
  //
  // `fieldCtx` is passed only by callers that removed a field or changed a field's type (the two
  // operations syncStepFields can refuse over existing values) and know which def id/label was
  // targeted; a scalar edit, active toggle, or label/unit rename never triggers that guard, so
  // there is nothing to look up a blocker list for.
  // One at a time (Codex, PR #22). Every write here PUTs the code's ENTIRE field array, so two
  // overlapping saves are last-writer-wins over the whole set — and they overlap on the most
  // ordinary interaction there is: editing a label and then clicking a control. mousedown blurs
  // the input, which starts the label save, and the click then starts a second save before the
  // first has returned. If the label save lands second, its payload — which carries the old order
  // and the old field set — silently reverts the reorder, type change or removal that was just
  // clicked, and the two `load()` calls race to leave the grid showing either.
  //
  // A queue rather than disabling the controls: disabling on blur would swallow the very click
  // that caused the blur. Chained on both settle paths so one failure cannot wedge the rest —
  // `run` handles its own errors, so this is belt and braces.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  function save(id: string, build: SavePayload | (() => SavePayload | null)): Promise<void> {
    const run = async () => {
      // Resolved here, not at call time: a deferred build sees the field set as it is when its
      // turn in the queue comes. `null` means the operation no longer applies (its code or row
      // went away while it waited) — a no-op, not an error.
      const payload = typeof build === "function" ? build() : build;
      if (!payload) return;
      const { body, fieldCtx } = payload;
      try {
        await api(`/api/admin/step-codes/${id}`, { method: "PUT", body: JSON.stringify(body) });
        setError(null); setBlocked(null); setFieldBlocked(null); await load();
      } catch (e) {
        await load().catch(() => {});
        const message = (e as Error).message;
        setError(message);
        if (fieldCtx && e instanceof ApiError && e.status === 400 && isFieldGuardMessage(message)) {
          try {
            const list = await api<Blocker[]>(`/api/admin/step-codes/field-defs/${fieldCtx.defId}/blockers`);
            setFieldBlocked({ defId: fieldCtx.defId, label: fieldCtx.label, list });
          } catch {
            // The plain error text above already explains the refusal; a failed blocker-list fetch
            // just means no panel this time, not a worse error to report.
            setFieldBlocked(null);
          }
        } else {
          setFieldBlocked(null);
        }
      }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  async function add() {
    try {
      await api("/api/admin/step-codes", { method: "POST", body: JSON.stringify(draft) });
      setDraft({ code: "", name: "" }); setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function removeCode(code: Code) {
    if (!confirm(`Delete step code "${code.code} — ${code.name}"?`)) return;
    try {
      await api(`/api/admin/step-codes/${code.id}`, { method: "DELETE" });
      setSelected(null); setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end (ReferenceTable.tsx / part-fields.tsx precedent): say what's
      // blocking, and make the list exportable. Only the delete guard's own 400 means a blocker
      // list exists to fetch — a 500 or network failure is a genuine error, not a refusal.
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/step-codes/${code.id}/blockers`);
          if (list.length) { setBlocked({ code, list }); setError(null); return; }
        } catch (listErr) {
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  // Optimistic local edit for a field-def row (label/unit typing), mirroring part-fields.tsx's
  // `editLocal` — the array index is a stable key while the user is only editing text, since add/
  // remove/reorder always go straight to the server and reload rather than mutating locally.
  function editFieldLocal(codeId: string, fieldIdx: number, patch: Partial<Field>) {
    setCodes((cur) => {
      const next = cur.map((c) => (
        c.id !== codeId ? c : { ...c, fields: c.fields.map((f, i) => (i === fieldIdx ? { ...f, ...patch } : f)) }
      ));
      codesRef.current = next;
      return next;
    });
  }

  // Every field op replaces the whole field-def set, id-preserving — each field carries its own
  // `id` from listStepCodes and it is passed straight through, so a relabel or unit edit keeps
  // pointing at the same PartProcessStepValue rows instead of losing them to a delete+recreate.
  // `sort` is renumbered to the on-screen order (see enqueueFieldOp).

  // Spec §6 lists reorder alongside add/edit/delete as one of the field-def row operations, and
  // it was the one that never got built (Codex, PR #22). `sort` is what orders the inputs on the
  // part-detail step editor and the traveler, so without this a field's position was fixed for
  // good the moment it recorded a value: remove-and-re-add, the only other way to change it, is
  // exactly what the server refuses once values exist. No `fieldCtx` — reordering touches neither
  // the set of fields nor any type, so it can't hit that guard. enqueueFieldOp renumbers `sort`
  // to the resulting order, so returning a reordered array is the whole operation.
  function moveField(codeId: string, fieldIdx: number, dir: -1 | 1) {
    void enqueueFieldOp(codeId, (fields) => swapAt(fields, fieldIdx, dir));
  }

  /**
   * Queues a save whose payload is computed when it RUNS, from the freshest field set, rather than
   * captured now. Serializing the requests was only half the problem (Codex, PR #22): each payload
   * is the whole field array, so a payload built before an earlier queued save reloaded carries
   * that save's column back to its old value and undoes it — change a field's type, click reorder
   * before the reload lands, and the reorder's stale array restores the old type. Expressing each
   * operation as a transform over the current fields removes the staleness rather than papering
   * over it, and it keeps the controls live, which disabling them would not.
   *
   * `fieldCtx` is resolved at run time too, since it names a field by index.
   */
  function enqueueFieldOp(
    codeId: string,
    transform: (fields: Field[]) => Field[] | null,
    ctxOf?: (fields: Field[]) => { defId: string; label: string } | undefined,
  ): Promise<void> {
    return save(codeId, () => {
      const code = codesRef.current.find((c) => c.id === codeId);
      if (!code) return null;
      const fields = transform(code.fields);
      if (!fields) return null;
      return { body: { fields: fields.map((f, i) => ({ ...f, sort: i })) }, fieldCtx: ctxOf?.(code.fields) };
    });
  }

  // The removed field is the one a refusal (still-in-use) would name — pass it along so `save` can
  // fetch its blockers on a 400.
  function removeField(codeId: string, fieldIdx: number) {
    void enqueueFieldOp(
      codeId,
      (fields) => (fieldIdx < fields.length ? fields.filter((_, i) => i !== fieldIdx) : null),
      (fields) => (fields[fieldIdx]?.id
        ? { defId: fields[fieldIdx].id as string, label: fields[fieldIdx].label } : undefined),
    );
  }

  // onFocus/onBlur split (part-fields.tsx precedent): typing doesn't hit the network on every
  // keystroke, and tabbing through a row without changing it writes no no-op audit entry.
  const focused = useRef<Record<string, string>>({});
  function noteFocus(key: string, value: string) { focused.current[key] = value; }

  function blurSaveLabel(codeId: string, fieldIdx: number, value: string) {
    const key = `${codeId}.${fieldIdx}.label`;
    const before = focused.current[key];
    const label = value.trim();
    if (label === before?.trim()) return;
    if (!label) {
      void load().catch(() => {});
      setError("Field label is required");
      return;
    }
    void enqueueFieldOp(codeId, (fields) => fields.map((f, i) => (i === fieldIdx ? { ...f, label } : f)));
  }

  function blurSaveUnit(codeId: string, fieldIdx: number, value: string) {
    const key = `${codeId}.${fieldIdx}.unit`;
    const before = focused.current[key];
    if (value === before) return;
    void enqueueFieldOp(codeId, (fields) => fields.map((f, i) => (i === fieldIdx ? { ...f, unit: value || null } : f)));
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Process step codes</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      <div className="flex gap-6">
        <div className="w-72 shrink-0">
          <ul className="mb-3 divide-y rounded border bg-white text-sm">
            {codes.map((c) => (
              <li key={c.id} onClick={() => setSelected(c.id)}
                  className={`cursor-pointer px-3 py-2 ${selected === c.id ? "bg-slate-100" : ""} ${c.active ? "" : "text-slate-400"}`}>
                <span className="font-mono">{c.code}</span> {c.name}
                {!c.active && <span className="ml-2 rounded bg-slate-200 px-1 text-xs">inactive</span>}
                {c.needsGlAccount && (
                  <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-800">needs GL</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex gap-1">
            <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                   disabled={canCreate.disabled} title={canCreate.title}
                   placeholder="Code" className="w-24 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                   disabled={canCreate.disabled} title={canCreate.title}
                   placeholder="Name" className="flex-1 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
            <button onClick={add} disabled={canCreate.disabled} title={canCreate.title}
                    className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
              Add
            </button>
          </div>
        </div>

        {current && (
          <div className="flex-1 rounded border bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">{current.code} — {current.name}</h2>
              <button onClick={() => removeCode(current)} disabled={canDelete.disabled} title={canDelete.title}
                      className="text-sm text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                Delete
              </button>
            </div>

            <label className="mb-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={current.active} disabled={canEdit.disabled} title={canEdit.title}
                     onChange={(e) => void save(current.id, { body: { active: e.target.checked } })} />
              Active
            </label>

            <label className="mb-4 block text-sm">
              GL account
              <select value={current.glAccountId ?? ""} disabled={canEdit.disabled} title={canEdit.title}
                      className="ml-2 rounded border px-2 py-1 disabled:bg-slate-100"
                      onChange={(e) => void save(current.id, { body: { glAccountId: e.target.value || null } })}>
                <option value="">(needs GL account)</option>
                {gls.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>

            <h3 className="mb-2 font-medium">Fields a step of this kind asks for</h3>
            <table className="mb-2 w-full text-sm">
              <thead><tr className="text-left"><th>Label</th><th>Type</th><th>Unit</th><th /></tr></thead>
              <tbody>
                {current.fields.map((f, i) => (
                  <tr key={f.id ?? i} className="border-t">
                    <td className="py-1">
                      <input value={f.label} disabled={canEdit.disabled} title={canEdit.title}
                             onFocus={(e) => noteFocus(`${current.id}.${i}.label`, e.target.value)}
                             onChange={(e) => editFieldLocal(current.id, i, { label: e.target.value })}
                             onBlur={(e) => blurSaveLabel(current.id, i, e.target.value)}
                             className="w-full rounded border px-2 py-1 disabled:bg-slate-100" />
                    </td>
                    <td>
                      <select value={f.type} disabled={canEdit.disabled} title={canEdit.title}
                              onChange={(e) => void enqueueFieldOp(
                                current.id,
                                (fields) => fields.map((ff, j) => (
                                  j === i ? { ...ff, type: e.target.value as StepFieldType } : ff
                                )),
                                (fields) => (fields[i]?.id
                                  ? { defId: fields[i].id as string, label: fields[i].label } : undefined),
                              )}
                              className="rounded border px-2 py-1 disabled:bg-slate-100">
                        {STEP_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td>
                      <input value={f.unit ?? ""} disabled={canEdit.disabled} title={canEdit.title}
                             onFocus={(e) => noteFocus(`${current.id}.${i}.unit`, e.target.value)}
                             onChange={(e) => editFieldLocal(current.id, i, { unit: e.target.value })}
                             onBlur={(e) => blurSaveUnit(current.id, i, e.target.value)}
                             className="w-20 rounded border px-2 py-1 disabled:bg-slate-100" />
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button type="button" onClick={() => moveField(current.id, i, -1)}
                                disabled={canEdit.disabled || i === 0}
                                title={canEdit.title} aria-label="Move field up"
                                className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                          ↑
                        </button>
                        <button type="button" onClick={() => moveField(current.id, i, 1)}
                                disabled={canEdit.disabled || i === current.fields.length - 1}
                                title={canEdit.title} aria-label="Move field down"
                                className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                          ↓
                        </button>
                        <button disabled={canEdit.disabled} title={canEdit.title}
                                className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400"
                                onClick={() => removeField(current.id, i)}>
                          remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <AddField disabled={canEdit.disabled} title={canEdit.title}
                      onAdd={(f) => void enqueueFieldOp(current.id, (fields) => [...fields, f])} />
            <p className="mt-3 text-xs text-slate-500">
              A code with no fields is text-only — that is correct for steps like Hot Wash.
              The order here is the order the fields are asked for on a process step and printed
              on the traveler. Deleting or changing the type of a field that still has recorded
              values is refused — the error names the field and how many values use it.
            </p>

            {blocked && blocked.code.id === current.id && (
              <BlockerPanel
                label="process step code"
                rowName={`${blocked.code.code} — ${blocked.code.name}`}
                list={blocked.list}
                exportHref={`/api/admin/step-codes/${blocked.code.id}/blockers/export`}
                onDismiss={() => setBlocked(null)}
              />
            )}

            {fieldBlocked && (
              <BlockerPanel
                label="process step field"
                rowName={fieldBlocked.label}
                list={fieldBlocked.list}
                exportHref={`/api/admin/step-codes/field-defs/${fieldBlocked.defId}/blockers/export`}
                onDismiss={() => setFieldBlocked(null)}
              />
            )}

            <div className="mt-6">
              <h3 className="mb-2 font-medium">History</h3>
              <HistoryPanel entity="processStepCode" entityId={current.id} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AddField({ onAdd, disabled, title }: {
  onAdd: (f: Field) => void; disabled: boolean; title: string | undefined;
}) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<StepFieldType>("NUMBER");
  const [unit, setUnit] = useState("");
  return (
    <div className="flex gap-1">
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Field label"
             disabled={disabled} title={title}
             className="flex-1 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
      <select value={type} onChange={(e) => setType(e.target.value as StepFieldType)}
              disabled={disabled} title={title}
              className="rounded border px-2 py-1 text-sm disabled:bg-slate-100">
        {STEP_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit"
             disabled={disabled} title={title}
             className="w-20 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
      <button disabled={disabled} title={title}
              className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400"
              onClick={() => { if (label) { onAdd({ label, type, unit: unit || null, sort: 0 }); setLabel(""); setUnit(""); } }}>
        Add field
      </button>
    </div>
  );
}
