"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { invalidateHistory } from "@/components/HistoryPanel";
import { gate } from "@/lib/permission-ui";
import { swapAt } from "@/lib/reorder";
import {
  buildStepOriginals, editsAfterSave, isStepDirty, pendingChanges, shownInstruction, shownValue,
  type StepEdits,
  dropStepEdits, remapStepEdits, stepEditsAfterRemoval,
} from "@/lib/step-drafts";
import { useLatest } from "@/lib/use-latest";
import { useUnsavedSection } from "@/lib/use-unsaved-section";

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

// What the user has typed and not yet saved, keyed by stepId — ONLY touched fields appear, and
// everything untouched shows server truth through it (src/lib/step-drafts.ts). Deliberately not a
// full copy of each step: a full copy has to be carried across every reload, and carrying a CLEAN
// copy is how another user's change gets masked and then reverted (Codex, PR #22).
type Edits = StepEdits;

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
  // Gates the Add step picker, which has nothing to offer without the field definitions. It used
  // to have a `codesSettled` companion gating draft-building, so a failed fetch could not leave
  // steps draft-less with empty textareas over persisted instructions. The overlay model removed
  // the need: `originals` derives straight from the revision detail and simply carries no field
  // seeds when `codes` is empty, so there is no state left that a failed fetch can withhold.
  const [codesReady, setCodesReady] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templatesReady, setTemplatesReady] = useState(false);

  const [edits, setEdits] = useState<Map<string, Edits>>(new Map());
  // Derived, not state: `originals` is by definition whatever the server last returned for this
  // revision, so deriving it can never drift out of step with `detail`. Nothing needs to carry it
  // forward or merge into it — the edits overlay above is the only thing that survives a reload,
  // and it holds only fields the user actually touched.
  const originals = useMemo(() => buildStepOriginals(detail?.steps ?? [], codes), [detail, codes]);

  const [addCodeId, setAddCodeId] = useState("");
  const [addingStep, setAddingStep] = useState(false);
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
    }).catch((e) => onError((e as Error).message));
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

  // Every mutation response carries `revisionNumber` (context doc). When it differs from what
  // was selected — the very first step ever added (null -> 1), or a locked current revision
  // silently cut to N+1 (spec §5.4) — reload the revision list and switch to it, which is how
  // that silent cut becomes visible instead of leaving the picker pointed at a now-superseded
  // number. Same-revision mutations still reload the list (stepCount changed) but only need a
  // detail refetch, not a `selected` change.
  // Re-keys the pending drafts through a cut's old->new step id mapping. The copies carry brand
  // new ids, so without this the rebuild finds nothing to carry and every unsaved edit on every
  // other step is replaced by persisted values — the same silent loss the same-revision carry
  // already prevents, one level harder (Codex, PR #22). Empty mapping = no cut = nothing to do.
  /**
   * Drop the overlay for steps this page just DESTROYED on purpose.
   *
   * The registration below counts an edit key with no entry in `originals` as dirty, so that a
   * draft held on another revision fails closed rather than reading as saved. A deleted or
   * template-replaced step trips the same arm — but it is not the same situation: there is no
   * revision to switch back to that can still SAVE it (an older revision renders read-only), so
   * the page warned about inaccessible work on every navigation, forever, with no control able to
   * clear it (Codex P2 on #272). `remapDrafts` cannot do this itself: it keeps unmapped keys by
   * design, which is right for a rename and wrong for a removal, and the two are indistinguishable
   * from the map alone. So the caller that knows what it destroyed says so.
   */
  function dropDrafts(stepIds: string[] | "all") {
    setEdits((cur) => dropStepEdits(cur, stepIds));
  }

  function remapDrafts(stepIdMap: Record<string, string>) {
    setEdits((cur) => remapStepEdits(cur, stepIdMap));
  }

  async function refreshAfter(revisionNumber: number) {
    // The reload's failure used to be swallowed, and the selection moved anyway. That left the
    // stale list authoritative for `highest`, so the revision just created was classified as
    // superseded and every control disabled — and `selected` named a revision the picker had no
    // option for — with nothing on screen saying why (Codex, PR #22). The mutation itself
    // succeeded, so the honest report is that the view is behind, not that the save failed.
    try {
      await loadRevisions();
    } catch (e) {
      onError(`Saved, but the revision list could not be reloaded — reload the page to see the ` +
        `current state. (${(e as Error).message})`);
      return;
    }
    if (revisionNumber !== selected) {
      setSelected(revisionNumber);
    } else {
      await loadDetail(revisionNumber);
    }
  }

  // No "does a draft exist yet" guard on either setter: an edit is recorded for whatever the user
  // typed into, whether or not anything has been loaded for that step. That removes the failure
  // mode where a missing draft silently swallowed keystrokes.
  function setInstruction(stepId: string, instruction: string) {
    setEdits((cur) => {
      const next = new Map(cur);
      const e = cur.get(stepId);
      next.set(stepId, { instruction, values: e ? e.values : new Map() });
      return next;
    });
  }
  function setValue(stepId: string, fieldDefId: string, value: string) {
    setEdits((cur) => {
      const next = new Map(cur);
      const e = cur.get(stepId);
      const values = new Map(e?.values ?? []);
      values.set(fieldDefId, value);
      next.set(stepId, { instruction: e?.instruction, values });
      return next;
    });
  }
  // Only what this save actually submitted, and only where it is still what the user has. The
  // row stays editable during the PATCH by design, so anything typed after the request left must
  // survive its success handler (see editsAfterSave).
  function clearSubmittedEdits(
    stepId: string, submitted: { instruction?: string; values: { fieldDefId: string; value: string }[] },
  ) {
    setEdits((cur) => {
      const kept = editsAfterSave(cur.get(stepId), submitted);
      const next = new Map(cur);
      if (kept) next.set(stepId, kept); else next.delete(stepId);
      return next;
    });
  }
  function isDirty(stepId: string): boolean {
    return isStepDirty(originals.get(stepId), edits.get(stepId));
  }
  // Dirtiness here is PER STEP, but the guard asks one question about the section — so aggregate
  // over the steps that currently hold edits (Codex P1 on #272 named the shape; the sweep in
  // tests/unsaved-registration-sweep.test.ts found this instance).
  //
  // An edit key with NO entry in the current revision's `originals` counts as dirty on its own
  // (Codex P2, round 6). `isStepDirty` compares an overlay against its baseline, and after a
  // revision switch a step edited on the OTHER revision has no baseline here — so an edit that
  // cleared a value to "" compares equal to an absent default and reads clean, while the overlay
  // is still held and would reappear on switching back. Held work the comparison cannot see must
  // fail CLOSED, not read as saved.
  useUnsavedSection(
    [...edits.keys()].some((stepId) => !originals.has(stepId) || isDirty(stepId)),
    "Process steps",
  );

  async function saveStep(stepId: string) {
    const { instruction, values } = pendingChanges(originals.get(stepId), edits.get(stepId));
    const patch: { instruction?: string; values?: { fieldDefId: string; value: string }[] } = {};
    if (instruction !== undefined) patch.instruction = instruction;
    if (values.length > 0) patch.values = values;
    if (patch.instruction === undefined && patch.values === undefined) return;
    try {
      const res = await api<{ revisionNumber: number; stepIdMap: Record<string, string> }>(
        `/api/parts/${partId}/process/steps/${stepId}`, { method: "PATCH", body: JSON.stringify(patch) });
      // #14 item 1, extended by #153: every write here is audited against `partProcessRevision`,
      // a registered child of the part panel. Success path, before the follow-up load.
      invalidateHistory();
      onError(null);
      // What was submitted is server truth now; anything typed since is not. Through the cut
      // mapping, since a save against a locked revision cuts N+1 and renumbers the step.
      remapDrafts(res.stepIdMap);
      clearSubmittedEdits(res.stepIdMap[stepId] ?? stepId, { instruction, values });
      await refreshAfter(res.revisionNumber);
    } catch (e) { onError((e as Error).message); }
  }

  // One at a time (Codex, PR #22). `addCodeId` is not cleared until the POST returns, and the
  // button was gated on nothing else, so two quick clicks sent two requests. Repeating a code on
  // a recipe is legitimate — Wash, Temper, Wash — so the server has no reason to refuse the
  // second, and the part quietly ended up with a step nobody asked for.
  async function addStepAction() {
    if (!addCodeId || addingStep) return;
    setAddingStep(true);
    try {
      const res = await api<{ revisionNumber: number; stepId: string; stepIdMap: Record<string, string> }>(
        `/api/parts/${partId}/process/steps`, { method: "POST", body: JSON.stringify({ codeId: addCodeId }) });
      invalidateHistory(); // #14 item 1
      setAddCodeId("");
      onError(null);
      remapDrafts(res.stepIdMap);
      await refreshAfter(res.revisionNumber);
    } catch (e) { onError((e as Error).message); } finally { setAddingStep(false); }
  }

  async function removeStepAction(stepId: string) {
    try {
      const res = await api<{ revisionNumber: number; stepIdMap: Record<string, string> }>(
        `/api/parts/${partId}/process/steps/${stepId}`, { method: "DELETE" });
      invalidateHistory(); // #14 item 1
      onError(null);
      // The removed step's own draft goes with it, and everything else rides the cut's mapping —
      // in ONE call, because the ORDER is the defect (#283). These were two calls, remap then drop,
      // beneath a comment claiming the drop came second so it would see the pre-remap key: the
      // exact opposite of what happens. `workingRevision` copies every step of a locked revision,
      // so the map carried the removed step too, the remap moved its draft onto the copy the same
      // transaction had deleted, and the drop then deleted a key holding nothing — leaving the page
      // registered unsaved with nothing on screen able to clear it.
      setEdits((cur) => stepEditsAfterRemoval(cur, res.stepIdMap, stepId));
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
      const res = await api<{ revisionNumber: number; stepIdMap: Record<string, string> }>(
        `/api/parts/${partId}/process/reorder`,
        { method: "POST", body: JSON.stringify({ orderedStepIds: reordered.map((s) => s.id) }) });
      invalidateHistory(); // #14 item 1
      onError(null);
      remapDrafts(res.stepIdMap);
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
      invalidateHistory(); // #14 item 1
      setTemplateId("");
      onError(null);
      // Every step on the recipe was just replaced, so every draft is an orphan — and the confirm
      // above already asked for exactly this ("Replace the current steps…"). Without it the page
      // is permanently, unresolvably dirty; see `dropDrafts`.
      dropDrafts("all");
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
          const stepEdits = edits.get(s.id);
          const original = originals.get(s.id);
          const dirty = isDirty(s.id);
          // The code's own field defs when they loaded; otherwise whatever this step already has
          // recorded, which the revision response carries in full (fieldDefId, label, type, unit,
          // sort). Restoring the instruction on a failed step-code-fields fetch but not the typed
          // values left every recorded temperature and pass/fail invisible on the recipe until a
          // full-page retry succeeded (Codex, PR #22) — worse than the missing instruction, since
          // the values ARE the recipe. The fallback cannot show a field that has never been set,
          // having nothing to learn it from, but it never hides one that has.
          const fields = code?.fields ?? [...s.values]
            .sort((a, b) => a.sort - b.sort)
            .map((v) => ({ id: v.fieldDefId, label: v.label, type: v.type, unit: v.unit, sort: v.sort }));
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
              <textarea value={shownInstruction(original, stepEdits)} disabled={rowDisabled} title={rowTitle}
                        onChange={(e) => setInstruction(s.id, e.target.value)} rows={2}
                        placeholder="Instruction"
                        className="mb-2 w-full rounded border px-2 py-1 text-sm disabled:bg-slate-50" />
              {fields.length > 0 && (
                <div className="mb-2 grid grid-cols-2 gap-3">
                  {fields.map((f) => {
                    const value = shownValue(original, stepEdits, f.id);
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
                                Shown only when there is something to clear.

                                Its title follows the page's disabled-with-a-reason rule like every
                                sibling control — a hard-coded description told a user without
                                processes.edit, or one on a superseded revision, nothing about why
                                it would not respond (Codex, PR #22). The description moves to
                                aria-label so it survives for assistive tech either way. */}
                            {value !== "" && (
                              <button type="button" onClick={() => setValue(s.id, f.id, "")}
                                      disabled={rowDisabled} aria-label="Clear this field (unset)"
                                      title={rowDisabled ? rowTitle : "Clear this field (unset)"}
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
        <button type="button" onClick={addStepAction}
                disabled={canEdit.disabled || readOnly || !addCodeId || addingStep}
                title={addingStep ? "Adding…" : rowTitle}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          {addingStep ? "Adding…" : "Add step"}
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
