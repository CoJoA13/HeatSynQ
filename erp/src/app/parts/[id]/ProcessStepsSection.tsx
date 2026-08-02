"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { swapAt } from "@/lib/reorder";
import { buildStepDrafts, type StepDraft } from "@/lib/step-drafts";
import { useLatest } from "@/lib/use-latest";

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
// fieldDefId map so a per-step Save sends only what actually changed. Built by
// `buildStepDrafts` (src/lib/step-drafts.ts), where it is `StepDraft`.
type Draft = StepDraft;

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
  // Two flags, not one. `codesReady` means the field definitions are in hand — it gates the Add
  // step picker, which has nothing to offer without them. `codesSettled` means the request is
  // merely over, success or failure, and gates draft-building: the drafts carry the instruction
  // text and the already-persisted values, neither of which needs the definitions, so waiting on
  // `codesReady` there left a failed fetch showing empty textareas over persisted instructions
  // and silently discarding keystrokes (Codex, PR #22).
  const [codesReady, setCodesReady] = useState(false);
  const [codesSettled, setCodesSettled] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templatesReady, setTemplatesReady] = useState(false);

  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [originals, setOriginals] = useState<Map<string, Draft>>(new Map());

  const [addCodeId, setAddCodeId] = useState("");
  const [templateId, setTemplateId] = useState("");

  const canEdit = gate(perms, "processes.edit");

  // Stale-response gates (src/lib/use-latest.ts, the parts/page.tsx `load()` precedent): a rapid
  // revision-picker change can let an older in-flight GET revisions/[n] resolve after a newer
  // one — without this, the older response could overwrite `detail` for a revision the badge no
  // longer shows. `revisionsLatest` covers the same class of race on the list itself (mount vs.
  // a mutation's own `refreshAfter` reload landing out of order).
  const revisionsLatest = useLatest();
  const detailLatest = useLatest();

  const loadRevisions = useCallback(async (): Promise<RevisionSummary[]> => {
    const t = revisionsLatest.next();
    try {
      const data = await api<RevisionSummary[]>(`/api/parts/${partId}/process/revisions`);
      if (revisionsLatest.isCurrent(t)) {
        setRevisions(data);
        setViewDenied(false);
      }
      return data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        if (revisionsLatest.isCurrent(t)) setViewDenied(true);
        return [];
      }
      throw e;
    }
  }, [partId, revisionsLatest]);

  // Errors are handled inside (not re-thrown) so every caller — the mount effect, the
  // `[selected]` effect, and `refreshAfter` — gets consistent reporting without each needing its
  // own `.catch`, the parts/page.tsx `load()` precedent.
  const loadDetail = useCallback(async (revisionNumber: number) => {
    const t = detailLatest.next();
    try {
      const data = await api<RevisionDetail>(`/api/parts/${partId}/process/revisions/${revisionNumber}`);
      if (detailLatest.isCurrent(t)) setDetail(data);
    } catch (e) {
      // Drop whatever is on screen rather than leaving it there indefinitely under a revision
      // number it does not belong to — the same reason the `[selected]` effect below clears
      // ahead of the fetch. Reached on the refreshAfter path, which reloads in place.
      if (detailLatest.isCurrent(t)) { setDetail(null); onError((e as Error).message); }
    }
  }, [partId, detailLatest, onError]);

  // Initial load: revisions first, then default `selected` to the current (highest — newest
  // first) revision. A part with no process steps yet has zero revisions (§5.1 — revision 1 is
  // created lazily on the first step mutation), so `selected` legitimately stays null: the
  // section still renders Add step / Load Template, just with no revision picker or step list.
  useEffect(() => {
    loadRevisions().then((data) => {
      if (data.length > 0) setSelected(data[0].revisionNumber);
    }).catch((e) => onError((e as Error).message));
  }, [loadRevisions, onError]);

  // Clear before fetching, not after: `readOnly` and the Rev badge both derive from `selected`,
  // so leaving the previous revision's steps on screen while the new one loads renders one
  // revision's recipe under another's number — and, selecting the current revision from a
  // superseded one, re-enables the edit controls over it (Codex, PR #22). The steps a user acts
  // on are now always the steps of the revision the badge names.
  useEffect(() => {
    setDetail(null);
    if (selected === null) return;
    void loadDetail(selected);
  }, [selected, loadDetail]);

  // Session-only reads (§5.15 vocabulary rule, /api/process/step-code-fields; ordinary
  // processes.view pick-list, /api/process-templates with no query — the route already filters
  // to active-only by default). Neither uses onOptionsError: the brief mirrors CustomFieldsSection
  // exactly (`{ partId, perms, onError }`, no separate options channel), unlike the
  // Inspections/Specs sections' pick-list split.
  useEffect(() => {
    api<StepCodeOption[]>("/api/process/step-code-fields").then((data) => {
      setCodes(data);
      setCodesReady(true);
    }).catch((e) => onError((e as Error).message))
      .finally(() => setCodesSettled(true));
  }, [onError]);
  useEffect(() => {
    api<TemplateOption[]>("/api/process-templates").then((data) => {
      setTemplates(data);
      setTemplatesReady(true);
    }).catch((e) => {
      // Same processes.view gate as the revisions fetch — a denied user 403s here too. That
      // denial is already surfaced once, by loadRevisions setting `viewDenied` (the section
      // frame replaces all data with "Requires processes.view."); reporting it a second time
      // through the shared `onError` banner would leak a redundant top-page error above that
      // frame (the bug task-10-view-denied.png accidentally captured).
      if (e instanceof ApiError && e.status === 403) return;
      onError((e as Error).message);
    });
  }, [onError]);

  // Rebuilds the per-step drafts once the revision detail is in hand and the codes request has
  // settled — see `codesSettled` above for why that is "settled", not "succeeded". Gating on
  // settlement rather than on `codes` being non-empty keeps this to a single rebuild: waiting for
  // the request either way means the drafts are built once, not built bare and then thrown away
  // (with whatever the user had typed into them) when the codes land a moment later.
  useEffect(() => {
    if (!detail || !codesSettled) return;
    const { drafts: nextDrafts, originals: nextOriginals } = buildStepDrafts(detail.steps, codes);
    setDrafts(nextDrafts);
    setOriginals(nextOriginals);
  }, [detail, codesSettled, codes]);

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
    const reordered = swapAt(detail.steps, idx, dir);
    if (!reordered) return;
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
  // Spec §10: the current revision, when locked, stays fully editable (see `readOnly` above) —
  // but an edit there silently cuts N+1, so the user is warned before it happens rather than
  // only finding out via the picker jumping to a new number after the fact.
  const isCurrentLocked = isCurrent && !!selectedMeta?.lockedAt;

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
          {isCurrentLocked && (
            <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
              Locked revision — editing will create a new revision
            </span>
          )}
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
                          <span className="ml-2 inline-flex items-center gap-2">
                            <input type="checkbox" checked={value === "true"} disabled={rowDisabled}
                                   title={rowTitle}
                                   onChange={(e) => setValue(s.id, f.id, e.target.checked ? "true" : "false")} />
                            {/* The CustomFieldsSection H3 fix, which this control had reproduced
                                the bug of: a checkbox alone can only ever stage "true" or "false"
                                once touched, and "false" is a recorded value — enough to block
                                its own field def's delete and type change (stepFieldBlockers),
                                with nothing in the control able to produce the "" that clears it.
                                applyValues (part-process-steps.ts) deletes the value row on "",
                                and "" validates for every type, so no server change is needed.
                                Shown only when there is something to clear. */}
                            {value !== "" && (
                              <button type="button" onClick={() => setValue(s.id, f.id, "")}
                                      disabled={rowDisabled} title="Clear this field (unset)"
                                      className="text-xs text-slate-600 underline disabled:cursor-not-allowed disabled:text-slate-400">
                                clear
                              </button>
                            )}
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
        {/* `detail` is cleared the moment the selection changes, so this covers the gap the
            fetch leaves — without it the list would just go blank, which reads as "no steps". */}
        {!detail && selected !== null && (
          <li className="text-sm text-slate-500">Loading revision {selected}…</li>
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
