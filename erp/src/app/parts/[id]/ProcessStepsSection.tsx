"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";

// Local mirrors of src/server/part-process-steps.ts's exported row types — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md "Constraints that will bite you"). Dates cross the wire as
// ISO strings once run through NextResponse.json, not the `Date` the service type says.
type RevisionSummary = { revisionNumber: number; lockedAt: string | null; stepCount: number; createdAt: string };
type StepValueRow = { fieldDefId: string; label: string; type: string; unit: string | null; sort: number; value: string };
type StepRow = { id: string; position: number; codeId: string; code: string; codeName: string; instruction: string; values: StepValueRow[] };
type RevisionDetail = { revisionNumber: number; lockedAt: string | null; steps: StepRow[] };
type FieldDefOption = { id: string; label: string; type: string; unit: string | null; sort: number };
type StepCodeOption = { id: string; code: string; name: string; active: boolean; fields: FieldDefOption[] };
type TemplateOption = { id: string; name: string; active: boolean; stepCount: number; updatedAt: string };

// Per-step editable draft, keyed by stepId in the two Maps below — the CustomFieldsSection
// `original`-map diffing pattern, widened to carry both the instruction text and a value-per-
// fieldDefId map so a per-step Save sends only what actually changed.
type Draft = { instruction: string; values: Map<string, string> };

export function ProcessStepsSection({
  partId, perms, onError,
}: {
  partId: string;
  perms: string[] | undefined;
  onError: (message: string | null) => void;
}) {
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  // Set only on a 403 from the revisions fetch, never cleared by any later successful mutation
  // (there is nothing to reload once the section frame has replaced the data with this message —
  // every mutating route requires processes.edit, which implies view was already denied).
  const [viewDenied, setViewDenied] = useState(false);

  const [codes, setCodes] = useState<StepCodeOption[]>([]);
  const [codesReady, setCodesReady] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templatesReady, setTemplatesReady] = useState(false);

  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [originals, setOriginals] = useState<Map<string, Draft>>(new Map());

  const [addCodeId, setAddCodeId] = useState("");
  const [templateId, setTemplateId] = useState("");

  const canEdit = gate(perms, "processes.edit");

  const loadRevisions = useCallback(async (): Promise<RevisionSummary[]> => {
    try {
      const data = await api<RevisionSummary[]>(`/api/parts/${partId}/process/revisions`);
      setRevisions(data);
      setViewDenied(false);
      return data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setViewDenied(true);
        return [];
      }
      throw e;
    }
  }, [partId]);

  const loadDetail = useCallback(async (revisionNumber: number) => {
    const data = await api<RevisionDetail>(`/api/parts/${partId}/process/revisions/${revisionNumber}`);
    setDetail(data);
  }, [partId]);

  // Initial load: revisions first, then default `selected` to the current (highest — newest
  // first) revision. A part with no process steps yet has zero revisions (§5.1 — revision 1 is
  // created lazily on the first step mutation), so `selected` legitimately stays null: the
  // section still renders Add step / Load Template, just with no revision picker or step list.
  useEffect(() => {
    loadRevisions().then((data) => {
      if (data.length > 0) setSelected(data[0].revisionNumber);
    }).catch((e) => onError((e as Error).message));
  }, [loadRevisions, onError]);

  useEffect(() => {
    if (selected === null) { setDetail(null); return; }
    loadDetail(selected).catch((e) => onError((e as Error).message));
  }, [selected, loadDetail, onError]);

  // Session-only reads (§5.15 vocabulary rule, /api/process/step-code-fields; ordinary
  // processes.view pick-list, /api/process-templates with no query — the route already filters
  // to active-only by default). Neither uses onOptionsError: the brief mirrors CustomFieldsSection
  // exactly (`{ partId, perms, onError }`, no separate options channel), unlike the
  // Inspections/Specs sections' pick-list split.
  useEffect(() => {
    api<StepCodeOption[]>("/api/process/step-code-fields").then((data) => {
      setCodes(data);
      setCodesReady(true);
    }).catch((e) => onError((e as Error).message));
  }, [onError]);
  useEffect(() => {
    api<TemplateOption[]>("/api/process-templates").then((data) => {
      setTemplates(data);
      setTemplatesReady(true);
    }).catch((e) => onError((e as Error).message));
  }, [onError]);

  // Rebuilds the per-step drafts once both the revision detail and the live codes are in hand.
  // Each step's value map is seeded with an "" entry for every field def the step's code
  // currently carries (so a never-set field still renders an input), then overwritten with
  // whatever values actually came back from the server. `originals` is a deep-enough snapshot
  // (its own `Map` per step) so later edits to `drafts` never mutate it.
  useEffect(() => {
    if (!detail || !codesReady) return;
    const nextDrafts = new Map<string, Draft>();
    const nextOriginals = new Map<string, Draft>();
    for (const s of detail.steps) {
      const code = codes.find((c) => c.id === s.codeId);
      const values = new Map<string, string>();
      for (const f of code?.fields ?? []) values.set(f.id, "");
      for (const v of s.values) values.set(v.fieldDefId, v.value);
      nextDrafts.set(s.id, { instruction: s.instruction, values });
      nextOriginals.set(s.id, { instruction: s.instruction, values: new Map(values) });
    }
    setDrafts(nextDrafts);
    setOriginals(nextOriginals);
  }, [detail, codesReady, codes]);

  // Every mutation response carries `revisionNumber` (context doc). When it differs from what
  // was selected — the very first step ever added (null -> 1), or a locked current revision
  // silently cut to N+1 (spec §5.4) — reload the revision list and switch to it, which is how
  // that silent cut becomes visible instead of leaving the picker pointed at a now-superseded
  // number. Same-revision mutations still reload the list (stepCount changed) but only need a
  // detail refetch, not a `selected` change.
  async function refreshAfter(revisionNumber: number) {
    await loadRevisions().catch(() => {});
    if (revisionNumber !== selected) {
      setSelected(revisionNumber);
    } else {
      await loadDetail(revisionNumber);
    }
  }

  function setInstruction(stepId: string, instruction: string) {
    setDrafts((cur) => {
      const d = cur.get(stepId);
      if (!d) return cur;
      const next = new Map(cur);
      next.set(stepId, { ...d, instruction });
      return next;
    });
  }
  function setValue(stepId: string, fieldDefId: string, value: string) {
    setDrafts((cur) => {
      const d = cur.get(stepId);
      if (!d) return cur;
      const next = new Map(cur);
      const values = new Map(d.values);
      values.set(fieldDefId, value);
      next.set(stepId, { ...d, values });
      return next;
    });
  }
  function isDirty(stepId: string): boolean {
    const draft = drafts.get(stepId);
    const original = originals.get(stepId);
    if (!draft || !original) return false;
    if (draft.instruction !== original.instruction) return true;
    for (const [fieldDefId, value] of draft.values) {
      if (value !== (original.values.get(fieldDefId) ?? "")) return true;
    }
    return false;
  }

  async function saveStep(stepId: string) {
    const draft = drafts.get(stepId);
    const original = originals.get(stepId);
    if (!draft || !original) return;
    const patch: { instruction?: string; values?: { fieldDefId: string; value: string }[] } = {};
    if (draft.instruction !== original.instruction) patch.instruction = draft.instruction;
    const changedValues: { fieldDefId: string; value: string }[] = [];
    for (const [fieldDefId, value] of draft.values) {
      if (value !== (original.values.get(fieldDefId) ?? "")) changedValues.push({ fieldDefId, value });
    }
    if (changedValues.length > 0) patch.values = changedValues;
    if (patch.instruction === undefined && patch.values === undefined) return;
    try {
      const res = await api<{ revisionNumber: number }>(`/api/parts/${partId}/process/steps/${stepId}`, {
        method: "PATCH", body: JSON.stringify(patch),
      });
      onError(null);
      await refreshAfter(res.revisionNumber);
    } catch (e) { onError((e as Error).message); }
  }

  async function addStepAction() {
    if (!addCodeId) return;
    try {
      const res = await api<{ revisionNumber: number; stepId: string }>(`/api/parts/${partId}/process/steps`, {
        method: "POST", body: JSON.stringify({ codeId: addCodeId }),
      });
      setAddCodeId("");
      onError(null);
      await refreshAfter(res.revisionNumber);
    } catch (e) { onError((e as Error).message); }
  }

  async function removeStepAction(stepId: string) {
    try {
      const res = await api<{ revisionNumber: number }>(`/api/parts/${partId}/process/steps/${stepId}`, {
        method: "DELETE",
      });
      onError(null);
      await refreshAfter(res.revisionNumber);
    } catch (e) { onError((e as Error).message); }
  }

  // Computes the full new order client-side and sends it as one call to the atomic reorder route
  // (the InspectionsSection `move()` precedent — G1: a two-PATCH swap risks a tied `sort`/
  // `position` if the second write fails).
  async function move(idx: number, dir: -1 | 1) {
    if (!detail) return;
    const j = idx + dir;
    if (j < 0 || j >= detail.steps.length) return;
    const reordered = [...detail.steps];
    [reordered[idx], reordered[j]] = [reordered[j], reordered[idx]];
    try {
      const res = await api<{ revisionNumber: number }>(`/api/parts/${partId}/process/reorder`, {
        method: "POST", body: JSON.stringify({ orderedStepIds: reordered.map((s) => s.id) }),
      });
      onError(null);
      await refreshAfter(res.revisionNumber);
    } catch (e) { onError((e as Error).message); }
  }

  async function loadTemplateAction() {
    if (!templateId) return;
    if (!confirm("Replace the current steps with this template's blank skeleton?")) return;
    try {
      const res = await api<{ revisionNumber: number }>(`/api/parts/${partId}/process/load-template`, {
        method: "POST", body: JSON.stringify({ templateId }),
      });
      setTemplateId("");
      onError(null);
      await refreshAfter(res.revisionNumber);
    } catch (e) { onError((e as Error).message); }
  }

  if (viewDenied) {
    return (
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Process steps</h2>
        <p className="text-sm text-slate-500">Requires processes.view.</p>
      </section>
    );
  }

  const highest = revisions[0]?.revisionNumber ?? null; // newest first
  const isCurrent = selected !== null && selected === highest;
  // Only a non-current selection is forced read-only. The current revision stays editable even
  // when locked — a mutation there is exactly what cuts N+1 (§5.4), and refreshAfter's
  // reload-and-switch is how that cut is surfaced, not something to block client-side.
  const readOnly = revisions.length > 0 && !isCurrent;
  const readOnlyTitle = "Superseded revision — read-only";
  const selectedMeta = revisions.find((r) => r.revisionNumber === selected);
  const rowDisabled = canEdit.disabled || readOnly;
  const rowTitle = readOnly ? readOnlyTitle : canEdit.title;

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Process steps</h2>

      {revisions.length > 0 ? (
        <div className="mb-3 flex items-center gap-2">
          <select value={selected ?? ""} onChange={(e) => setSelected(Number(e.target.value))}
                  className="rounded border px-2 py-1 text-sm">
            {revisions.map((r) => (
              <option key={r.revisionNumber} value={r.revisionNumber}>Rev {r.revisionNumber}</option>
            ))}
          </select>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            Rev {selected} · {selectedMeta?.lockedAt ? "locked" : "working"}
          </span>
        </div>
      ) : (
        <p className="mb-3 text-sm text-slate-500">No steps yet — add the first one below.</p>
      )}

      <ol className="mb-3 space-y-3">
        {(detail?.steps ?? []).map((s, idx) => {
          const code = codes.find((c) => c.id === s.codeId);
          const draft = drafts.get(s.id);
          const dirty = isDirty(s.id);
          return (
            <li key={s.id} className="rounded border p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">{s.code} — {s.codeName}</span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => move(idx, -1)} disabled={rowDisabled || idx === 0}
                          title={rowTitle} aria-label="Move up"
                          className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                    ↑
                  </button>
                  <button type="button" onClick={() => move(idx, 1)}
                          disabled={rowDisabled || idx === (detail?.steps.length ?? 0) - 1}
                          title={rowTitle} aria-label="Move down"
                          className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                    ↓
                  </button>
                  <button type="button" onClick={() => removeStepAction(s.id)} disabled={rowDisabled}
                          title={rowTitle}
                          className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                    Remove
                  </button>
                </div>
              </div>
              <textarea value={draft?.instruction ?? ""} disabled={rowDisabled} title={rowTitle}
                        onChange={(e) => setInstruction(s.id, e.target.value)} rows={2}
                        placeholder="Instruction"
                        className="mb-2 w-full rounded border px-2 py-1 text-sm disabled:bg-slate-50" />
              {(code?.fields ?? []).length > 0 && (
                <div className="mb-2 grid grid-cols-2 gap-3">
                  {(code?.fields ?? []).map((f) => {
                    const value = draft?.values.get(f.id) ?? "";
                    return (
                      <label key={f.id} className="block text-xs">
                        {f.label}
                        {f.type === "CHECKBOX" ? (
                          <span className="ml-2 inline-flex items-center">
                            <input type="checkbox" checked={value === "true"} disabled={rowDisabled}
                                   title={rowTitle}
                                   onChange={(e) => setValue(s.id, f.id, e.target.checked ? "true" : "false")} />
                          </span>
                        ) : f.type === "DATE" ? (
                          <input type="date" value={value} disabled={rowDisabled} title={rowTitle}
                                 onChange={(e) => setValue(s.id, f.id, e.target.value)}
                                 className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
                        ) : (
                          <input value={value} disabled={rowDisabled} title={rowTitle}
                                 inputMode={f.type === "NUMBER" ? "decimal" : undefined}
                                 onChange={(e) => setValue(s.id, f.id, e.target.value)}
                                 className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
                        )}
                        {f.unit && <span className="ml-1 text-slate-500">{f.unit}</span>}
                      </label>
                    );
                  })}
                </div>
              )}
              <button type="button" onClick={() => saveStep(s.id)} disabled={rowDisabled || !dirty}
                      title={rowTitle}
                      className="rounded bg-slate-800 px-3 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                Save step
              </button>
            </li>
          );
        })}
        {detail && detail.steps.length === 0 && (
          <li className="text-sm text-slate-500">No steps on this revision.</li>
        )}
      </ol>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <select value={addCodeId} disabled={canEdit.disabled || readOnly || !codesReady}
                title={!codesReady ? "Options failed to load — reload the page" : rowTitle}
                onChange={(e) => setAddCodeId(e.target.value)}
                className="rounded border px-2 py-1 text-sm">
          <option value="">Add step: code…</option>
          {codes.filter((c) => c.active).map((c) => (
            <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
          ))}
        </select>
        <button type="button" onClick={addStepAction} disabled={canEdit.disabled || readOnly || !addCodeId}
                title={rowTitle}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Add step
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <select value={templateId} disabled={canEdit.disabled || readOnly || !templatesReady}
                title={!templatesReady ? "Options failed to load — reload the page" : rowTitle}
                onChange={(e) => setTemplateId(e.target.value)}
                className="rounded border px-2 py-1 text-sm">
          <option value="">Load template…</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button type="button" onClick={loadTemplateAction}
                disabled={canEdit.disabled || readOnly || !templateId} title={rowTitle}
                className="rounded border border-slate-800 px-3 py-1 text-sm text-slate-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
          Load template
        </button>
      </div>
    </section>
  );
}
