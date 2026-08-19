"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { PART_FIELD_TYPES, type PartFieldTypeValue } from "@/lib/part-constants";
import { nextSort } from "@/lib/next-sort";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";

type FieldDef = { id: string; name: string; type: PartFieldTypeValue; sort: number; active: boolean };

export default function PartFieldsPage() {
  const [rows, setRows] = useState<FieldDef[]>([]);
  const [draft, setDraft] = useState<{ name: string; type: PartFieldTypeValue; sort: number }>({
    name: "", type: PART_FIELD_TYPES[0], sort: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ row: FieldDef; list: Blocker[]; verb: string } | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();
  // Gated per the permission each route actually enforces (ReferenceTable.tsx precedent, fixed
  // in 2C-1's review, followed here rather than the step-codes page, which gates none of this):
  // add hits POST requiring admin.create, every row edit (name/type/sort/active) hits PUT
  // requiring admin.edit, delete hits DELETE requiring admin.delete
  // (src/app/api/admin/part-fields/route.ts, .../[id]/route.ts).
  const canCreate = gate(perms, "admin.create");
  const canEdit = gate(perms, "admin.edit");
  const canDelete = gate(perms, "admin.delete");

  // includeInactive=1 always: unlike the reference grid, there is no separate "show inactive"
  // filter here — the Active column IS the reactivation control, so an inactive def must stay
  // visible to be turned back on.
  // H1 (Codex round 3 review): the draft's sort used to be seeded once at mount (useState's
  // `sort: 0` initializer) and reset on a successful add to `rows.length` — a papercut on its
  // own (issue #14 item 3: the draft goes stale the moment rows change from any OTHER save/
  // delete, since nothing recomputed it) and a real bug once rows have a gap: two rows sorted
  // 0, 2 (e.g. after the row that held sort 1 was deleted) give `rows.length` = 2, which
  // duplicates the live sort-2 row instead of landing after it. Recomputing from the FRESHLY
  // loaded rows on every load() call — which already runs on mount and after every save/add/
  // delete — fixes both: the draft's sort default is never stale, and it is always one past the
  // highest live sort regardless of gaps.
  // Ticket-gated (the surcharges/page.tsx load shape): load() is refired from six caller sites
  // unserialized, so overlapping loads used to land in arrival order. The gate covers BOTH writes
  // — setRows AND the draft-sort recompute (stale bookkeeping is as wrong as stale rows).
  const latest = useLatest();
  const load = useCallback(async () => {
    const ticket = latest.next();
    try {
      const data = await api<FieldDef[]>("/api/admin/part-fields?includeInactive=1");
      if (!latest.isCurrent(ticket)) return; // a slower, now-superseded load lost the state race
      setRows(data);
      setDraft((d) => ({ ...d, sort: nextSort(data) }));
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not clobber current state.
      if (!latest.isCurrent(ticket)) return;
      throw e;
    }
  }, [latest]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // What the user has typed into a row's Name/Sort input but not yet blurred, keyed by
  // `${rowId}.${field}` — composed with the server value at render time (`draftValue`), never
  // written into `rows` (the surcharges/page.tsx textDrafts pattern). Writing keystrokes into
  // `rows` meant a landing load reverted mid-typing text, and a blur from there saved the mangled
  // value. NOTE: unlike surcharges/step-codes, save bodies here are SINGLE-FIELD partials, so
  // there is no whole-row write-back amplification and no rowsRef/accept mechanism is needed —
  // the drafts only protect the typing itself. Cleared when the field's OWN save settles.
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  function draftValue(key: string, serverValue: string): string {
    return Object.hasOwn(textDrafts, key) ? textDrafts[key] : serverValue;
  }

  async function save(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/admin/part-fields/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setError(null); setBlocked(null); await load();
    } catch (e) {
      // Roll back to server truth FIRST, then report why (§5.13) — a failed edit must not leave
      // a stale, unsaved value sitting in the grid looking as if it took effect. The reload's own
      // failure is swallowed here only because the original error below is what gets reported;
      // it is not silencing that original error.
      await load().catch(() => {});
      const message = (e as Error).message;
      // A blocked type change is the same "not a dead end" case as a blocked delete below
      // (ReferenceTable.tsx precedent): say what's holding a value on this field and make the
      // list exportable, rather than just reporting the 400 text.
      const row = rows.find((r) => r.id === id);
      if (e instanceof ApiError && e.status === 400 && message.includes("its type cannot change") && row) {
        try {
          const list = await api<Blocker[]>(`/api/admin/part-fields/${id}/blockers`);
          if (list.length) { setBlocked({ row, list, verb: "change the type of" }); setError(null); return; }
        } catch (listErr) {
          setError(`${message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError(message);
    }
  }

  // onFocus/onBlur split (IdentitySection.tsx precedent): typing doesn't hit the network on every
  // keystroke, and tabbing through a row without changing it writes no no-op audit entry.
  const focused = useRef<Record<string, string>>({});
  function noteFocus(id: string, field: string, value: string) {
    focused.current[`${id}.${field}`] = value;
  }

  function blurSaveName(id: string, value: string) {
    const key = `${id}.name`;
    const clearDraft = () => setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    const before = focused.current[key];
    const name = value.trim();
    if (name === before?.trim()) { clearDraft(); return; }
    if (!name) {
      // Revert to server truth; its own failure is swallowed here the same way save()'s catch
      // swallows it (§5.13) — the validation message below is what gets reported either way.
      void load().catch(() => {});
      setError("Name is required");
      clearDraft();
      return;
    }
    void save(id, { name }).finally(clearDraft);
  }

  function blurSaveSort(id: string, value: string) {
    const key = `${id}.sort`;
    const clearDraft = () => setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    const before = focused.current[key];
    if (value === before) { clearDraft(); return; }
    const n = Number(value);
    // Empty is rejected too (the surcharges position-blur guard): Number("") is 0, so a blur from
    // a backspaced-to-empty field used to silently save sort 0 — the mangled-value class.
    if (value.trim() === "" || !Number.isInteger(n) || n < 0) {
      void load().catch(() => {});
      setError("Sort must be a whole number, 0 or greater");
      clearDraft();
      return;
    }
    void save(id, { sort: n }).finally(clearDraft);
  }

  async function add() {
    try {
      await api("/api/admin/part-fields", { method: "POST", body: JSON.stringify(draft) });
      setError(null); setBlocked(null);
      // load() (above) recomputes the draft's sort from the freshly loaded rows, INCLUDING the
      // row just added — this reset must only clear name/type and keep that fresh sort, not
      // reintroduce the same stale rows.length calculation here.
      await load();
      setDraft((d) => ({ name: "", type: PART_FIELD_TYPES[0], sort: d.sort }));
    } catch (e) { setError((e as Error).message); }
  }

  async function remove(row: FieldDef) {
    if (!confirm(`Delete part field "${row.name}"?`)) return;
    try {
      await api(`/api/admin/part-fields/${row.id}`, { method: "DELETE" });
      setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end (ReferenceTable.tsx precedent): say what's blocking, and
      // make the list exportable. Only the delete guard's own 400 means a blocker list exists to
      // fetch — a 500 or a network failure is a genuine error, not a refusal, and fetching (and
      // likely finding no) blockers for it would misreport a real failure as "N records use it".
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/part-fields/${row.id}/blockers`);
          if (list.length) { setBlocked({ row, list, verb: "delete" }); setError(null); return; }
        } catch (listErr) {
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Part custom fields</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      <table className="w-full rounded border bg-white text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">Name</th><th className="p-2">Type</th><th className="p-2">Sort</th>
            <th className="p-2">Active</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="p-2">
                {/* value from the draft overlay; onChange writes the draft, never rows (the
                    surcharges/page.tsx textDrafts pattern). */}
                <input value={draftValue(`${r.id}.name`, r.name)} disabled={canEdit.disabled} title={canEdit.title}
                       onFocus={(e) => noteFocus(r.id, "name", e.target.value)}
                       onChange={(e) => setTextDrafts((d) => ({ ...d, [`${r.id}.name`]: e.target.value }))}
                       onBlur={(e) => blurSaveName(r.id, e.target.value)}
                       className="w-full rounded border px-2 py-1 disabled:bg-slate-100" />
              </td>
              <td className="p-2">
                <select value={r.type} disabled={canEdit.disabled} title={canEdit.title}
                        onChange={(e) => void save(r.id, { type: e.target.value })}
                        className="rounded border px-2 py-1 disabled:bg-slate-100">
                  {PART_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td className="p-2">
                {/* Draft overlay like Name — the old onChange parsed through `Number(...) || 0`
                    into rows, so backspacing to empty instantly re-rendered as "0" and a blur
                    from there saved sort 0 (the surcharges Position precedent). */}
                <input value={draftValue(`${r.id}.sort`, String(r.sort))} type="number"
                       disabled={canEdit.disabled} title={canEdit.title}
                       onFocus={(e) => noteFocus(r.id, "sort", e.target.value)}
                       onChange={(e) => setTextDrafts((d) => ({ ...d, [`${r.id}.sort`]: e.target.value }))}
                       onBlur={(e) => blurSaveSort(r.id, e.target.value)}
                       className="w-20 rounded border px-2 py-1 disabled:bg-slate-100" />
              </td>
              <td className="p-2">
                <input type="checkbox" checked={r.active} disabled={canEdit.disabled} title={canEdit.title}
                       onChange={(e) => void save(r.id, { active: e.target.checked })} />
              </td>
              <td className="p-2 text-right">
                <button onClick={() => remove(r)} disabled={canDelete.disabled} title={canDelete.title}
                        className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  delete
                </button>
              </td>
            </tr>
          ))}
          <tr className="border-t bg-slate-50">
            <td className="p-2">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                     placeholder="Name" className="w-full rounded border px-2 py-1" />
            </td>
            <td className="p-2">
              <select value={draft.type}
                      onChange={(e) => setDraft({ ...draft, type: e.target.value as PartFieldTypeValue })}
                      className="rounded border px-2 py-1">
                {PART_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </td>
            <td className="p-2">
              <input value={draft.sort} type="number"
                     onChange={(e) => setDraft({ ...draft, sort: Number(e.target.value) || 0 })}
                     className="w-20 rounded border px-2 py-1" />
            </td>
            <td />
            <td className="p-2 text-right">
              <button onClick={add} disabled={canCreate.disabled} title={canCreate.title}
                      className="rounded bg-slate-800 px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {blocked && (
        <BlockerPanel
          label="part field"
          rowName={blocked.row.name}
          list={blocked.list}
          action={blocked.verb}
          exportHref={`/api/admin/part-fields/${blocked.row.id}/blockers/export`}
          onDismiss={() => setBlocked(null)}
        />
      )}
    </div>
  );
}
