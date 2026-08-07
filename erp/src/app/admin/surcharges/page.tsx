"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { percentToDecimal, decimalToPercentText } from "@/lib/surcharge-percent";
import {
  SURCHARGE_KINDS, SURCHARGE_KIND_LABELS, SURCHARGE_SCOPES, SURCHARGE_SCOPE_LABELS,
  type SurchargeKindValue, type SurchargeScopeValue,
} from "@/lib/invoice-constants";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { HistoryPanel } from "@/components/HistoryPanel";

// Local mirror of src/server/surcharges.ts's SurchargeRow — not imported from src/server/**
// (CLAUDE.md: a client component pulling from there drags node:async_hooks and Prisma into the
// browser bundle).
type Surcharge = {
  id: string; name: string; kind: SurchargeKindValue;
  rate: number | null; amount: number | null; minimumAmount: number | null;
  glAccountId: string | null; glAccountName: string | null; needsGlAccount: boolean;
  scope: SurchargeScopeValue; position: number; active: boolean;
  stepCodeIds: string[];
};
type Gl = { id: string; name: string; description?: string };
type StepCodeOption = { id: string; name: string; active: boolean };

// The fields `updateSurcharge`/`createSurcharge` validate as ONE row (surcharges.ts's `SAVE`
// schema). `buildBody` below always assembles every one of these before a PUT/POST, never a
// bare patch — see the dispatch's Fix-1 warning: `updateSurcharge` persists exactly the keys it
// receives, so an omitted key clears that column (`toSurchargeRow`'s normalize-on-write treats
// "absent" as "explicitly empty"). `rate`/`amount`/`minimumAmount` accept a decimal STRING as
// well as a number — the server's `decimalField` takes either — so a blur handler can hand this
// the exact text the user typed without an intermediate `Number(...)` that would only reintroduce
// the "trailing decimal point disappears mid-type" problem `textDrafts` exists to avoid.
type SaveFields = {
  name: string; kind: SurchargeKindValue;
  rate: number | string | null;
  amount: number | string | null;
  minimumAmount: number | string | null;
  glAccountId: string | null;
  scope: SurchargeScopeValue;
  position: number;
  active: boolean;
};

/** Composes the COMPLETE row `updateSurcharge`/`createSurcharge` expect, from the freshest known
 *  row plus only the field(s) actually being changed. Each field falls back to the row's current
 *  value only when `patch` genuinely omits it (`!== undefined`, not a truthiness check) — a
 *  patch that deliberately sets a field to `null` (clearing `glAccountId`, say) must not fall
 *  back to the row's old value. `rate`/`amount` are then pinned to the pair the current `kind`
 *  allows and nulled on the other — the same invariant `SAVE`'s superRefine enforces server-side
 *  (a percent surcharge can never carry an amount and vice versa) — so a save that only touched,
 *  say, `minimumAmount` can never accidentally resurrect a stale rate left over from before a
 *  kind flip. */
function buildBody(row: Surcharge, patch: Partial<SaveFields>): SaveFields {
  const name = patch.name !== undefined ? patch.name : row.name;
  const kind = patch.kind !== undefined ? patch.kind : row.kind;
  const rate = patch.rate !== undefined ? patch.rate : row.rate;
  const amount = patch.amount !== undefined ? patch.amount : row.amount;
  const minimumAmount = patch.minimumAmount !== undefined ? patch.minimumAmount : row.minimumAmount;
  const glAccountId = patch.glAccountId !== undefined ? patch.glAccountId : row.glAccountId;
  const scope = patch.scope !== undefined ? patch.scope : row.scope;
  const position = patch.position !== undefined ? patch.position : row.position;
  const active = patch.active !== undefined ? patch.active : row.active;
  return {
    name, kind,
    rate: kind === "PERCENT" ? rate : null,
    amount: kind === "FLAT" ? amount : null,
    minimumAmount, glAccountId, scope, position, active,
  };
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
  // amount) but not yet blurred, keyed by `${rowId}.${field}` — composed with the server value
  // at render time (`draftValue` below), not a parallel editable copy of the row. Reformatting
  // the display on every keystroke (e.g. converting through `Number(...)` immediately) strips a
  // trailing decimal point the instant it's typed, making "4.5" untypeable; keeping the raw text
  // here until blur avoids that. Cleared on selection change and after every save settles.
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  function draftValue(key: string, serverValue: string): string {
    return Object.hasOwn(textDrafts, key) ? textDrafts[key] : serverValue;
  }
  const { permissions: perms, error: permsError } = usePermissions();

  // Every write in this file hits a route requiring admin.edit (the five routes this page
  // consumes all gate POST/PUT/DELETE on admin.edit, not a separate create/delete grant — see
  // src/app/api/admin/surcharges/route.ts). Disabled with a tooltip, never hidden (§5.16).
  const canEdit = gate(perms, "admin.edit");

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
    if (!latest.isCurrent(ticket)) return; // a slower, now-superseded load lost the race
    setRows(r); rowsRef.current = r; setGls(g); setStepCodeOptions(sc);
  }, [latest]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // A stale blocker panel — and any in-progress typing draft — from a previously selected row
  // must not linger once selection moves on.
  useEffect(() => { setBlocked(null); setTextDrafts({}); }, [selected]);

  const current = rows.find((r) => r.id === selected) ?? null;

  /** The one save path every field on the detail pane goes through. `patch` carries only what
   *  changed; `buildBody` composes it with the freshest server row into the whole thing the
   *  route expects. On failure, rolls back to server truth FIRST (reload), then reports why
   *  (§5.13) — a failed save must not leave a stale, unsaved value in the grid looking as if it
   *  took effect. */
  async function save(id: string, patch: Partial<SaveFields>) {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row) return;
    const body = buildBody(row, patch);
    try {
      await api(`/api/admin/surcharges/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setError(null); setBlocked(null); await load();
    } catch (e) {
      await load().catch(() => {});
      setError((e as Error).message);
    }
  }

  /** Local-only — no network call. Switching `kind` alone can never be a valid save on its own
   *  (a PERCENT row with no rate yet, or a FLAT row with no amount yet, both fail `SAVE`'s
   *  superRefine), so this only flips which control the pane shows; the actual PUT happens when
   *  the user then edits the newly-visible rate/amount field, at which point `save` reads this
   *  already-updated `kind` back off `rowsRef` and submits both together. */
  function setKindLocal(id: string, kind: SurchargeKindValue) {
    setRows((cur) => {
      const next = cur.map((r) => (r.id === id ? { ...r, kind } : r));
      rowsRef.current = next;
      return next;
    });
  }

  async function toggleStepCode(id: string, stepCodeId: string) {
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
                   disabled={canEdit.disabled} title={canEdit.title}
                   placeholder="Name" className="rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
            <div className="flex gap-1">
              <select value={draft.kind}
                      onChange={(e) => setDraft({ ...draft, kind: e.target.value as SurchargeKindValue, valueText: "" })}
                      disabled={canEdit.disabled} title={canEdit.title}
                      className="rounded border px-2 py-1 text-sm disabled:bg-slate-100">
                {SURCHARGE_KINDS.map((k) => <option key={k} value={k}>{SURCHARGE_KIND_LABELS[k]}</option>)}
              </select>
              <input value={draft.valueText} onChange={(e) => setDraft({ ...draft, valueText: e.target.value })}
                     disabled={canEdit.disabled} title={canEdit.title} inputMode="decimal"
                     placeholder={draft.kind === "PERCENT" ? "% rate" : "$ amount"}
                     className="w-24 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
              <button onClick={add} disabled={canEdit.disabled} title={canEdit.title}
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
              <button onClick={() => removeRow(current)} disabled={canEdit.disabled} title={canEdit.title}
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
                <select value={current.kind} disabled={canEdit.disabled} title={canEdit.title}
                        onChange={(e) => setKindLocal(current.id, e.target.value as SurchargeKindValue)}
                        className="ml-2 w-full rounded border px-2 py-1 disabled:bg-slate-100">
                  {SURCHARGE_KINDS.map((k) => <option key={k} value={k}>{SURCHARGE_KIND_LABELS[k]}</option>)}
                </select>
              </label>

              {current.kind === "PERCENT" ? (
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
                           void save(current.id, { rate: percentToDecimal(value) })
                             .finally(() => setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; }));
                         }}
                         className="ml-2 w-full rounded border px-2 py-1 text-right disabled:bg-slate-100" />
                </label>
              ) : (
                <label className="flex-1 text-sm">
                  Amount ($)
                  <input value={draftValue(`${current.id}.amount`, String(current.amount ?? ""))}
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
                           // state exists to avoid.
                           void save(current.id, { amount: value.trim() === "" ? null : value })
                             .finally(() => setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; }));
                         }}
                         className="ml-2 w-full rounded border px-2 py-1 text-right disabled:bg-slate-100" />
                </label>
              )}
            </div>

            <div className="mb-2 flex gap-4">
              <label className="flex-1 text-sm">
                Minimum amount ($)
                <input value={draftValue(`${current.id}.minimumAmount`, String(current.minimumAmount ?? ""))}
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
                <input value={current.position} disabled={canEdit.disabled} title={canEdit.title}
                       inputMode="numeric"
                       onFocus={(e) => noteFocus(`${current.id}.position`, e.target.value)}
                       onChange={(e) => {
                         const n = Number(e.target.value);
                         if (!Number.isFinite(n)) return;
                         setRows((cur) => {
                           const next = cur.map((r) => (r.id === current.id ? { ...r, position: n } : r));
                           rowsRef.current = next; return next;
                         });
                       }}
                       onBlur={(e) => {
                         const before = focused.current[`${current.id}.position`];
                         if (e.target.value === before) return;
                         const n = Number(e.target.value);
                         if (!Number.isFinite(n)) { void load().catch(() => {}); setError("Position must be a number"); return; }
                         void save(current.id, { position: n });
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
