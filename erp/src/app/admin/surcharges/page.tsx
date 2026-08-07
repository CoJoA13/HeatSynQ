"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { percentToDecimal, decimalToPercentText } from "@/lib/surcharge-percent";
import {
  buildSurchargeBody as buildBody,
  type SurchargeRow as Surcharge,
  type SurchargeSaveFields as SaveFields,
} from "@/lib/surcharge-body";
import {
  SURCHARGE_KINDS, SURCHARGE_KIND_LABELS, SURCHARGE_SCOPES, SURCHARGE_SCOPE_LABELS,
  type SurchargeKindValue, type SurchargeScopeValue,
} from "@/lib/invoice-constants";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { HistoryPanel } from "@/components/HistoryPanel";

type Gl = { id: string; name: string; description?: string };
type StepCodeOption = { id: string; name: string; active: boolean };

/** Formats a Decimal(12,2) money value the way the field itself is scaled, not however many
 *  digits happen to survive `Decimal.toNumber()` — `String(2.5)` is `"2.5"`, silently dropping
 *  the trailing cent a stored `2.50` actually carries (Fix 7, review). */
function moneyText(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

export default function SurchargesPage() {
  const [rows, setRows] = useState<Surcharge[]>([]);
  const [gls, setGls] = useState<Gl[]>([]);
  const [stepCodeOptions, setStepCodeOptions] = useState<StepCodeOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; kind: SurchargeKindValue; valueText: string }>({
    name: "", kind: "PERCENT", valueText: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ row: Surcharge; list: Blocker[] } | null>(null);
  // What the user has actually typed into a free-text numeric field (rate%, amount, minimum
  // amount, position) but not yet blurred, keyed by `${rowId}.${field}` — composed with the
  // server value at render time (`draftValue` below), not a parallel editable copy of the row.
  // Reformatting the display on every keystroke (e.g. converting through `Number(...)`
  // immediately) strips a trailing decimal point the instant it's typed, making "4.5" untypeable
  // — and for `position`, `Number("")` is `0`, so backspacing to empty would instantly re-render
  // as "0" and a stray blur from there would silently save `position: 0` (Fix 4, review). Keeping
  // the raw text here until blur avoids both. Cleared on selection change and after every save
  // settles.
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  function draftValue(key: string, serverValue: string): string {
    return Object.hasOwn(textDrafts, key) ? textDrafts[key] : serverValue;
  }
  // The one place this page departed from "keep only what the user typed" (Fix 3, review):
  // `setKindLocal` used to write straight into `rows`/`rowsRef`, so a kind flipped but never
  // paired with a rate/amount edit survived switching to another row and back, showing e.g.
  // PERCENT with an empty Rate while the server still held FLAT + amount — and any later
  // unrelated save then composed `kind: PERCENT, rate: null` and failed with an error naming a
  // field the user never touched. Tracked as a draft instead, exactly like `textDrafts`, and
  // cleared alongside it below.
  const [kindDraft, setKindDraft] = useState<Record<string, SurchargeKindValue>>({});
  function kindValue(row: Surcharge): SurchargeKindValue {
    return Object.hasOwn(kindDraft, row.id) ? kindDraft[row.id] : row.kind;
  }
  const { permissions: perms, error: permsError } = usePermissions();

  // Gated per the permission each route actually enforces (step-codes/page.tsx precedent, review
  // Fix 2 — an owner ruling: split like every other admin CRUD list rather than the single
  // admin.edit gate this page originally shipped with). Create hits POST requiring admin.create;
  // every scalar edit, the active toggle, and the step-code list hits PUT requiring admin.edit;
  // delete hits DELETE requiring admin.delete. Disabled with a tooltip, never hidden (§5.16).
  const canCreate = gate(perms, "admin.create");
  const canEdit = gate(perms, "admin.edit");
  const canDelete = gate(perms, "admin.delete");

  // Mirrors `rows` for save-time reads: a save must compose its payload from the FRESHEST known
  // row, not a value captured when the input was first focused (the step-codes/page.tsx
  // `codesRef` precedent).
  const rowsRef = useRef<Surcharge[]>([]);
  const latest = useLatest();
  const load = useCallback(async () => {
    const ticket = latest.next();
    const [r, g, sc] = await Promise.all([
      api<Surcharge[]>("/api/admin/surcharges?includeInactive=1"),
      api<Gl[]>("/api/admin/reference/glAccount"),
      api<StepCodeOption[]>("/api/picklists/processStepCode"),
    ]);
    // rowsRef always takes this fetch's result, ticket or no: it exists to hand a QUEUED run the
    // freshest server truth, not to gate what the user sees, so a superseded load must still land
    // it (Task 7 re-review — a save queued between a superseded load and the load that supersedes
    // it was composing from the PRE-save row instead). Only the rendered state below is gated.
    rowsRef.current = r;
    if (!latest.isCurrent(ticket)) return; // a slower, now-superseded load lost the state race
    setRows(r); setGls(g); setStepCodeOptions(sc);
  }, [latest]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // A stale blocker panel — and any in-progress typing/kind draft — from a previously selected
  // row must not linger once selection moves on.
  useEffect(() => { setBlocked(null); setTextDrafts({}); setKindDraft({}); }, [selected]);

  const current = rows.find((r) => r.id === selected) ?? null;

  // One at a time (step-codes/page.tsx precedent, Codex PR #22 — the same class of bug, fix wave
  // 1 Fix 1). Every write here PUTs the surcharge's ENTIRE row, so two overlapping saves are
  // last-writer-wins over the whole thing — and they overlap on the most ordinary interaction
  // there is: typing a value, then clicking a control. mousedown blurs the input, which starts
  // save #1; the click starts save #2 before #1 has returned. Serializing the requests is only
  // half of it: `save`/`toggleStepCode` below look their row up from `rowsRef.current` INSIDE the
  // queued run, not at call time, so save #2 composes against the row as it stands on ITS OWN
  // turn — after `rowsRef.current` has been updated by save #1's `load()` fetch (or a later one
  // still, if another load's fetch landed after it; `load()` writes the ref unconditionally on
  // every completed fetch, never gated by the `useLatest` ticket that guards only the rendered
  // state, so a queued run is never left composing from a pre-save ref — Task 7 re-review) —
  // instead of the stale snapshot that existed when the click first fired. Shared by both
  // functions because they must serialize against EACH OTHER too: a rate edit and a step-code
  // toggle fired in quick succession are exactly as ordinary an overlap as two field saves.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  /** The one save path every field on the detail pane goes through. `patch` carries only what
   *  changed; `buildBody` composes it — at the queued run's own turn, not at call time — with the
   *  freshest server row into the whole thing the route expects. On failure, rolls back to server
   *  truth FIRST (reload), then reports why (§5.13) — a failed save must not leave a stale,
   *  unsaved value in the grid looking as if it took effect. `blocked` is cleared unconditionally
   *  (Fix 7, review): a stale delete-blocker panel from an earlier refused delete has nothing to
   *  do with a field save's own outcome, success or failure, so the previous code's
   *  success-only clear left it lingering through an unrelated failed save. */
  function save(id: string, patch: Partial<SaveFields>): Promise<void> {
    const run = async () => {
      const row = rowsRef.current.find((r) => r.id === id);
      if (!row) return;
      const body = buildBody(row, patch);
      setBlocked(null);
      try {
        await api(`/api/admin/surcharges/${id}`, { method: "PUT", body: JSON.stringify(body) });
        setError(null); await load();
      } catch (e) {
        await load().catch(() => {});
        setError((e as Error).message);
      }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  /** Local-only — no network call. Switching `kind` alone can never be a valid save on its own
   *  (a PERCENT row with no rate yet, or a FLAT row with no amount yet, both fail `SAVE`'s
   *  superRefine), so this only flips which control the pane shows; the actual PUT happens when
   *  the user then edits the newly-visible rate/amount field, at which point that field's `save`
   *  call passes `kind: kindValue(current)` explicitly (the row in `rowsRef` is never mutated by
   *  this — see `kindDraft` above) so `buildBody` nulls the opposite field correctly. */
  function setKindLocal(id: string, kind: SurchargeKindValue) {
    setKindDraft((d) => ({ ...d, [id]: kind }));
  }

  /** Same queue as `save` — see its comment above. `next` is derived from `rowsRef.current`
   *  inside the queued run, not at call time: the checkbox below isn't optimistic
   *  (`checked={current.stepCodeIds.includes(sc.id)}`), so a fast second click lands before the
   *  first's round trip completes, and computing `next` from the stale `row.stepCodeIds`
   *  captured when the click fired would overwrite the first click's effect entirely instead of
   *  adding to it (Fix 1(b), review — the brief's own Step 4 scenario). */
  function toggleStepCode(id: string, stepCodeId: string): Promise<void> {
    const run = async () => {
      const row = rowsRef.current.find((r) => r.id === id);
      if (!row) return;
      const has = row.stepCodeIds.includes(stepCodeId);
      const next = has ? row.stepCodeIds.filter((s) => s !== stepCodeId) : [...row.stepCodeIds, stepCodeId];
      try {
        await api(`/api/admin/surcharges/${id}/step-codes`, { method: "PUT", body: JSON.stringify({ stepCodeIds: next }) });
        setError(null); await load();
      } catch (e) {
        await load().catch(() => {});
        setError((e as Error).message);
      }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  async function add() {
    const position = rows.reduce((max, r) => Math.max(max, r.position), 0) + 1;
    const body: SaveFields = {
      name: draft.name, kind: draft.kind,
      rate: draft.kind === "PERCENT" ? percentToDecimal(draft.valueText) : null,
      amount: draft.kind === "FLAT" ? (draft.valueText.trim() === "" ? null : draft.valueText) : null,
      minimumAmount: null, glAccountId: null, scope: "ALL", position, active: true,
    };
    try {
      await api("/api/admin/surcharges", { method: "POST", body: JSON.stringify(body) });
      setDraft({ name: "", kind: "PERCENT", valueText: "" }); setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function removeRow(row: Surcharge) {
    if (!confirm(`Delete surcharge "${row.name}"?`)) return;
    try {
      await api(`/api/admin/surcharges/${row.id}`, { method: "DELETE" });
      setSelected(null); setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end (step-codes/page.tsx precedent): say what's blocking, and
      // make the list exportable. Only the delete guard's own 400 means a blocker list exists to
      // fetch — a 500 or network failure is a genuine error, not a refusal.
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/surcharges/${row.id}/blockers`);
          if (list.length) { setBlocked({ row, list }); setError(null); return; }
        } catch (listErr) {
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  // onFocus/onBlur split (step-codes/page.tsx, billing/page.tsx precedent): typing doesn't hit
  // the network on every keystroke, and tabbing through an untouched field writes no no-op save.
  const focused = useRef<Record<string, string>>({});
  function noteFocus(key: string, value: string) { focused.current[key] = value; }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Surcharges</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      <div className="flex gap-6">
        <div className="w-72 shrink-0">
          <ul className="mb-3 divide-y rounded border bg-white text-sm">
            {[...rows].sort((a, b) => a.position - b.position).map((r) => (
              <li key={r.id} onClick={() => setSelected(r.id)}
                  className={`cursor-pointer px-3 py-2 ${selected === r.id ? "bg-slate-100" : ""} ${r.active ? "" : "text-slate-400"}`}>
                {r.name}
                {!r.active && <span className="ml-2 rounded bg-slate-200 px-1 text-xs">inactive</span>}
                {r.needsGlAccount && (
                  <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-800">needs GL</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-1">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                   disabled={canCreate.disabled} title={canCreate.title}
                   placeholder="Name" className="rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
            <div className="flex gap-1">
              <select value={draft.kind}
                      onChange={(e) => setDraft({ ...draft, kind: e.target.value as SurchargeKindValue, valueText: "" })}
                      disabled={canCreate.disabled} title={canCreate.title}
                      className="rounded border px-2 py-1 text-sm disabled:bg-slate-100">
                {SURCHARGE_KINDS.map((k) => <option key={k} value={k}>{SURCHARGE_KIND_LABELS[k]}</option>)}
              </select>
              <input value={draft.valueText} onChange={(e) => setDraft({ ...draft, valueText: e.target.value })}
                     disabled={canCreate.disabled} title={canCreate.title} inputMode="decimal"
                     placeholder={draft.kind === "PERCENT" ? "% rate" : "$ amount"}
                     className="w-24 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
              <button onClick={add} disabled={canCreate.disabled} title={canCreate.title}
                      className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                Add
              </button>
            </div>
          </div>
        </div>

        {current && (
          <div className="flex-1 rounded border bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">{current.name}</h2>
              <button onClick={() => removeRow(current)} disabled={canDelete.disabled} title={canDelete.title}
                      className="text-sm text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                Delete
              </button>
            </div>

            <label className="mb-2 block text-sm">
              Name
              <input value={current.name} disabled={canEdit.disabled} title={canEdit.title}
                     onFocus={(e) => noteFocus(`${current.id}.name`, e.target.value)}
                     onChange={(e) => setRows((cur) => {
                       const next = cur.map((r) => (r.id === current.id ? { ...r, name: e.target.value } : r));
                       rowsRef.current = next; return next;
                     })}
                     onBlur={(e) => {
                       const before = focused.current[`${current.id}.name`];
                       const name = e.target.value.trim();
                       if (name === before?.trim()) return;
                       if (!name) { void load().catch(() => {}); setError("Name is required"); return; }
                       void save(current.id, { name });
                     }}
                     className="ml-2 w-full rounded border px-2 py-1 disabled:bg-slate-100" />
            </label>

            <div className="mb-2 flex gap-4">
              <label className="flex-1 text-sm">
                Kind
                <select value={kindValue(current)} disabled={canEdit.disabled} title={canEdit.title}
                        onChange={(e) => setKindLocal(current.id, e.target.value as SurchargeKindValue)}
                        className="ml-2 w-full rounded border px-2 py-1 disabled:bg-slate-100">
                  {SURCHARGE_KINDS.map((k) => <option key={k} value={k}>{SURCHARGE_KIND_LABELS[k]}</option>)}
                </select>
              </label>

              {kindValue(current) === "PERCENT" ? (
                <label className="flex-1 text-sm">
                  Rate (%)
                  <input value={draftValue(`${current.id}.rate`, decimalToPercentText(current.rate))}
                         disabled={canEdit.disabled} title={canEdit.title} inputMode="decimal"
                         onFocus={(e) => noteFocus(`${current.id}.rate`, e.target.value)}
                         onChange={(e) => setTextDrafts((d) => ({ ...d, [`${current.id}.rate`]: e.target.value }))}
                         onBlur={(e) => {
                           const key = `${current.id}.rate`;
                           const before = focused.current[key];
                           const value = e.target.value;
                           if (value === before) { setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; }); return; }
                           // `kind` is sent explicitly — the row in `rowsRef` still carries the
                           // server's real kind (setKindLocal no longer mutates it, Fix 3), so
                           // buildBody needs telling which kind this save is for in order to null
                           // `amount` correctly on a pending PERCENT flip.
                           void save(current.id, { kind: kindValue(current), rate: percentToDecimal(value) })
                             .finally(() => {
                               setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
                               setKindDraft((d) => { const n = { ...d }; delete n[current.id]; return n; });
                             });
                         }}
                         className="ml-2 w-full rounded border px-2 py-1 text-right disabled:bg-slate-100" />
                </label>
              ) : (
                <label className="flex-1 text-sm">
                  Amount ($)
                  <input value={draftValue(`${current.id}.amount`, moneyText(current.amount))}
                         disabled={canEdit.disabled} title={canEdit.title} inputMode="decimal"
                         onFocus={(e) => noteFocus(`${current.id}.amount`, e.target.value)}
                         onChange={(e) => setTextDrafts((d) => ({ ...d, [`${current.id}.amount`]: e.target.value }))}
                         onBlur={(e) => {
                           const key = `${current.id}.amount`;
                           const before = focused.current[key];
                           const value = e.target.value;
                           if (value === before) { setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; }); return; }
                           // Sent as the raw string, not `Number(value)` — `amount`'s server-side
                           // decimalField accepts a decimal string directly, and parsing here
                           // would only reintroduce the reformat-while-typing problem this draft
                           // state exists to avoid. `kind` explicit for the same reason as Rate's
                           // onBlur above.
                           void save(current.id, { kind: kindValue(current), amount: value.trim() === "" ? null : value })
                             .finally(() => {
                               setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
                               setKindDraft((d) => { const n = { ...d }; delete n[current.id]; return n; });
                             });
                         }}
                         className="ml-2 w-full rounded border px-2 py-1 text-right disabled:bg-slate-100" />
                </label>
              )}
            </div>

            <div className="mb-2 flex gap-4">
              <label className="flex-1 text-sm">
                Minimum amount ($)
                <input value={draftValue(`${current.id}.minimumAmount`, moneyText(current.minimumAmount))}
                       disabled={canEdit.disabled} title={canEdit.title} inputMode="decimal"
                       onFocus={(e) => noteFocus(`${current.id}.minimumAmount`, e.target.value)}
                       onChange={(e) => setTextDrafts((d) => ({ ...d, [`${current.id}.minimumAmount`]: e.target.value }))}
                       onBlur={(e) => {
                         const key = `${current.id}.minimumAmount`;
                         const before = focused.current[key];
                         const value = e.target.value;
                         if (value === before) { setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; }); return; }
                         void save(current.id, { minimumAmount: value.trim() === "" ? null : value })
                           .finally(() => setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; }));
                       }}
                       className="ml-2 w-full rounded border px-2 py-1 text-right disabled:bg-slate-100" />
              </label>

              <label className="flex-1 text-sm">
                Position
                {/* Routed through textDrafts like rate/amount/minimumAmount (Fix 4, review):
                    `onChange` used to run `Number(e.target.value)` immediately, and
                    `Number("")` is `0`, so backspacing to empty instantly re-rendered as "0" —
                    blurring from there saved `position: 0`, silently jumping the row to the top
                    of the list. Reformatting/parsing now happens only on blur. */}
                <input value={draftValue(`${current.id}.position`, String(current.position))}
                       disabled={canEdit.disabled} title={canEdit.title}
                       inputMode="numeric"
                       onFocus={(e) => noteFocus(`${current.id}.position`, e.target.value)}
                       onChange={(e) => setTextDrafts((d) => ({ ...d, [`${current.id}.position`]: e.target.value }))}
                       onBlur={(e) => {
                         const key = `${current.id}.position`;
                         const before = focused.current[key];
                         const value = e.target.value;
                         if (value === before) { setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; }); return; }
                         const trimmed = value.trim();
                         const n = Number(trimmed);
                         if (trimmed === "" || !Number.isFinite(n)) {
                           void load().catch(() => {});
                           setError("Position must be a number");
                           setTextDrafts((d) => { const n2 = { ...d }; delete n2[key]; return n2; });
                           return;
                         }
                         void save(current.id, { position: n })
                           .finally(() => setTextDrafts((d) => { const n2 = { ...d }; delete n2[key]; return n2; }));
                       }}
                       className="ml-2 w-full rounded border px-2 py-1 text-right disabled:bg-slate-100" />
              </label>
            </div>

            <label className="mb-4 block text-sm">
              GL account
              <select value={current.glAccountId ?? ""} disabled={canEdit.disabled} title={canEdit.title}
                      className="ml-2 w-full rounded border px-2 py-1 disabled:bg-slate-100"
                      onChange={(e) => void save(current.id, { glAccountId: e.target.value || null })}>
                <option value="">(needs GL account)</option>
                {gls.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>

            <label className="mb-2 block text-sm">
              Scope
              <select value={current.scope} disabled={canEdit.disabled} title={canEdit.title}
                      className="ml-2 w-full rounded border px-2 py-1 disabled:bg-slate-100"
                      onChange={(e) => void save(current.id, { scope: e.target.value as SurchargeScopeValue })}>
                {SURCHARGE_SCOPES.map((s) => <option key={s} value={s}>{SURCHARGE_SCOPE_LABELS[s]}</option>)}
              </select>
            </label>

            {current.scope !== "ALL" && (
              <div className="mb-4">
                <h3 className="mb-1 text-sm font-medium">
                  {current.scope === "INCLUDE"
                    ? "Applies only to these operations"
                    : "Applies to all operations except these"}
                </h3>
                <div className="max-h-48 overflow-y-auto rounded border p-2 text-sm">
                  {stepCodeOptions.length === 0 && <p className="text-slate-500">No process step codes yet.</p>}
                  {stepCodeOptions.map((sc) => (
                    <label key={sc.id} className="flex items-center gap-2 py-0.5">
                      <input type="checkbox" checked={current.stepCodeIds.includes(sc.id)}
                             disabled={canEdit.disabled} title={canEdit.title}
                             onChange={() => void toggleStepCode(current.id, sc.id)} />
                      {sc.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <label className="mb-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={current.active} disabled={canEdit.disabled} title={canEdit.title}
                     onChange={(e) => void save(current.id, { active: e.target.checked })} />
              Active
            </label>

            {blocked && blocked.row.id === current.id && (
              <BlockerPanel
                label="surcharge"
                rowName={blocked.row.name}
                list={blocked.list}
                exportHref={`/api/admin/surcharges/${blocked.row.id}/blockers/export`}
                onDismiss={() => setBlocked(null)}
              />
            )}

            <div className="mt-6">
              <h3 className="mb-2 font-medium">History</h3>
              <HistoryPanel entity="surcharge" entityId={current.id} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
