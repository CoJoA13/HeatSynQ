"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { gate } from "@/lib/permission-ui";
import { swapAt } from "@/lib/reorder";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { useUnsavedSection } from "@/lib/use-unsaved-section";

// Local mirrors of src/server/process-templates.ts's exported row types — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md "Constraints that will bite you").
type TemplateStep = {
  id: string; position: number; codeId: string; code: string; codeName: string; boilerplate: string;
};
type Template = { id: string; name: string; active: boolean; steps: TemplateStep[] };
type StepCodeOption = { id: string; code: string; name: string; active: boolean };

/**
 * Which name the box should show once a load lands: the server's, or the rename the user has
 * typed and not yet saved.
 *
 * Hook-free and exported so tests/process-template-name.test.ts can drive it directly — this repo
 * has no DOM test environment, and the established answer is to split the DECISION out of the
 * component (`printControlTitle` in receivables/statements/Statements.tsx, `runControlState` in
 * admin/backups/page.tsx) rather than reach for one.
 *
 * `prevServerName` is the name the LAST load returned, or null before any has — and it MUST be
 * read at dispatch time, not inside the setState updater (#219): the caller writes the ref
 * immediately after dispatching, and React runs the updater during the render pass, so a live
 * read always saw the just-written value and every branch fell through to `cur`. On mount that
 * left the box EMPTY on an existing template — this page's only identity element.
 *
 * The rule is focus-INDEPENDENT by design (Codex PR #22): every step action reloads after focus
 * has left the box, so an unsaved rename must survive a load the user did not initiate. That is
 * why this is not `use-edit-guard`'s `applyPayload`, which preserves only the FOCUSED field.
 */
export function adoptServerName(
  args: { prevServerName: string | null; currentDraft: string; serverName: string },
): string {
  const { prevServerName, currentDraft, serverName } = args;
  if (prevServerName === null) return serverName;      // first load — nothing typed to protect
  if (currentDraft === prevServerName) return serverName; // untouched since the last load — adopt
  return currentDraft;                                  // an unsaved rename — keep it
}

export default function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Next reuses this route's component instance across /processes/templates/A ->
  // /processes/templates/B (only the param changes, no remount). Keying the body by id forces a
  // fresh instance per template, so no draft state can carry one template's unsaved text onto
  // another template's id (HANDOFF §5.12, the parts/[id]/page.tsx precedent).
  return <Detail key={id} id={id} />;
}

function Detail({ id }: { id: string }) {
  const router = useRouter();
  const [template, setTemplate] = useState<Template | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();

  const [codes, setCodes] = useState<StepCodeOption[]>([]);
  const [codesReady, setCodesReady] = useState(false);
  const [addCodeId, setAddCodeId] = useState("");
  const [addingStep, setAddingStep] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);

  // ONLY what the user has typed and not yet saved, keyed by stepId — a step absent from this map
  // shows the server's boilerplate. The ProcessStepsSection.tsx edits-overlay precedent, narrowed
  // to a single field since a template step carries no per-code values.
  //
  // It held a full copy of every step's text before, rebuilt-then-merged on each reload, which
  // meant a CLEAN copy was carried forward too: another user's edit to a step came back correct
  // and was immediately masked by this user's untouched stale text, displayed as freshly dirty
  // and revertible with one click of Save (Codex, PR #22). Keeping only genuine edits makes that
  // unrepresentable — there is nothing to carry for a step nobody has typed into.
  const [boilerplateEdits, setBoilerplateEdits] = useState<Map<string, string>>(new Map());

  // Tracks the name the server last returned, so `load()` can tell an untouched draft (adopt the
  // server's name) from an unsaved rename (keep it). Every step action — add, save, remove,
  // reorder — calls `load()`, and a blanket reassignment discarded a rename the user had typed
  // but not yet saved, silently and on an unrelated action (Codex, PR #22). A ref rather than
  // state: it is bookkeeping for the next load, and nothing renders from it.
  const lastServerName = useRef<string | null>(null);

  // §5.13 stale-gate, the processes/page.tsx shape, both paths (F7): six mutation callers funnel
  // through this full refetch, so overlapping loads race — and a dropped stale response must not
  // advance the rename bookkeeping either, so the gate covers `setNameDraft`'s reconciliation and
  // the `lastServerName.current` write alongside `setTemplate`.
  const latest = useLatest();
  const load = useCallback(async () => {
    const ticket = latest.next();
    let t: Template;
    try {
      t = await api<Template>(`/api/process-templates/${id}`);
    } catch (e) {
      if (latest.isCurrent(ticket)) setError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(ticket)) return;
    // #219: capture the bookkeeping ref BEFORE dispatching, and close the updater over the
    // CAPTURED value. Read live (`lastServerName.current` inside the updater) this was the
    // impure-updater/live-ref shape `use-edit-guard.ts` exists to prevent: `setTemplate` above
    // has already marked pending lanes, so React runs this updater during the render pass —
    // i.e. AFTER the synchronous `lastServerName.current = t.name` below — and the comparison
    // never saw the pre-load value. On mount that made every branch fall through to `cur`, so
    // the name box (this page's only identity element) rendered EMPTY on an existing template.
    const prevServerName = lastServerName.current;
    setTemplate(t);
    setNameDraft((cur) => adoptServerName({
      prevServerName, currentDraft: cur, serverName: t.name,
    }));
    lastServerName.current = t.name;
    setError(null);
  }, [id, latest]);
  useEffect(() => { void load(); }, [load]);

  // Session-only read (§5.15 vocabulary rule) — every signed-in user can see which step codes
  // exist, the same pick-list idiom ProcessStepsSection.tsx uses for the part-detail Add-step
  // picker.
  useEffect(() => {
    api<StepCodeOption[]>("/api/process/step-code-fields").then((data) => {
      setCodes(data);
      setCodesReady(true);
    }).catch((e) => setError((e as Error).message));
  }, []);

  const canEdit = gate(perms, "processes.edit");
  const canDelete = gate(perms, "processes.delete");
  const nameDirty = !!template && nameDraft.trim() !== template.name;

  async function saveName() {
    if (!nameDirty) return;
    try {
      await api(`/api/process-templates/${id}`, {
        method: "PATCH", body: JSON.stringify({ name: nameDraft.trim() }),
      });
      // #158 — success path, before the follow-up load (#124/#131). Every mutation on this page
      // except the template delete (which navigates away) writes a `processTemplate` row — its
      // steps are audited as the template's own before/after diff — so each one moves the history
      // the panel at the bottom of this page is showing.
      invalidateHistory();
      setError(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  // Optimistic: applied immediately so the checkbox always lands visually on a single click, then
  // persisted. Rolled back to server truth on failure (the customers/[id]/page.tsx `save()`
  // precedent) — reload BEFORE setting the error, since a successful load() resets `error` to
  // null and would otherwise wipe a message set before it (§5.13).
  //
  // One at a time (Codex, PR #22): the control stays enabled through the PATCH otherwise, and two
  // clicks faster than a round trip issue two unordered updates. If the first lands second the
  // database keeps the first click's value while the checkbox shows the second's — and a
  // successful toggle deliberately doesn't reload, so nothing would ever reveal the divergence.
  async function toggleActive(active: boolean) {
    if (togglingActive) return;
    setTogglingActive(true);
    setTemplate((cur) => (cur ? { ...cur, active } : cur));
    try {
      await api(`/api/process-templates/${id}`, { method: "PATCH", body: JSON.stringify({ active }) });
      invalidateHistory(); // #158 — the active toggle's success path, before the reconcile load
      // Reconcile from the server on success too, not only on failure (Codex, PR #22). The name
      // and step controls stay live during this PATCH and their handlers call load(); one landing
      // mid-flight reads the OLD active value and overwrites the optimistic checkbox, and with no
      // reload here nothing ever corrected it — the box showed one thing, the database held the
      // other. Safe to reload now that load() preserves an unsaved name and merges step drafts.
      // (load() reports its own failures through the gated catch and never rejects.)
      await load();
      setError(null);
    } catch (e) {
      await load();
      setError((e as Error).message);
    } finally {
      setTogglingActive(false);
    }
  }

  function setBoilerplateDraft(stepId: string, value: string) {
    setBoilerplateEdits((cur) => {
      const next = new Map(cur);
      next.set(stepId, value);
      return next;
    });
  }
  function shownBoilerplate(step: TemplateStep): string {
    return boilerplateEdits.get(step.id) ?? step.boilerplate;
  }
  function isBoilerplateDirty(step: TemplateStep): boolean {
    return shownBoilerplate(step) !== step.boilerplate;
  }
  // Per-step dirtiness aggregated into the one question the guard asks about this section.
  // BOTH drafts on this page, not just the steps: the template NAME has its own draft and its own
  // Save button, so covering only the boilerplate left a rename to be discarded in silence (Codex
  // P1 on #272 — and the registration sweep passed this file because it checks that a file
  // registers, not that the registration covers every draft in it).
  useUnsavedSection(nameDirty || (template?.steps ?? []).some(isBoilerplateDirty), "Process template");

  // One at a time, the same guard the part-detail Add step carries (Codex, PR #22): addCodeId is
  // not cleared until the POST returns, and repeating a code on a template is legitimate, so two
  // quick clicks both succeeded and appended a duplicate step nobody asked for.
  async function addStep() {
    if (!addCodeId || addingStep) return;
    setAddingStep(true);
    try {
      await api(`/api/process-templates/${id}/steps`, { method: "POST", body: JSON.stringify({ codeId: addCodeId }) });
      invalidateHistory(); // #158 — the add-step success path, before the follow-up load
      setAddCodeId("");
      setError(null);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setAddingStep(false); }
  }

  async function saveBoilerplate(stepId: string) {
    // Captured before the request, and only dropped afterwards if it is still what the user has:
    // the textarea stays editable during the PATCH, so text typed after the request went out must
    // survive its success handler rather than being painted over by the reload (Codex, PR #22).
    const submitted = boilerplateEdits.get(stepId) ?? "";
    try {
      await api(`/api/process-templates/${id}/steps/${stepId}`, {
        method: "PATCH", body: JSON.stringify({ boilerplate: submitted }),
      });
      invalidateHistory(); // #158 — the boilerplate save's success path, before the follow-up load
      setBoilerplateEdits((cur) => {
        if (cur.get(stepId) !== submitted) return cur; // typed since — keep it
        const next = new Map(cur);
        next.delete(stepId);
        return next;
      });
      setError(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function removeStep(stepId: string) {
    try {
      await api(`/api/process-templates/${id}/steps/${stepId}`, { method: "DELETE" });
      invalidateHistory(); // #158 — the remove-step success path, before the follow-up load
      setError(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  // Computes the full new order client-side and sends it as one call to the atomic reorder route
  // (the ProcessStepsSection.tsx `move()` precedent — a two-PATCH swap risks a tied `position` if
  // the second write fails).
  async function move(idx: number, dir: -1 | 1) {
    if (!template) return;
    const reordered = swapAt(template.steps, idx, dir);
    if (!reordered) return;
    try {
      await api(`/api/process-templates/${id}/reorder`, {
        method: "POST", body: JSON.stringify({ orderedStepIds: reordered.map((s) => s.id) }),
      });
      invalidateHistory(); // #158 — the reorder's success path, before the follow-up load
      setError(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  // prompt(), not confirm() — spec §9 requires a reason on a destructive action. Refused
  // client-side on blank/whitespace-only text as a courtesy; deleteTemplate() rejects the same
  // way server-side (a 400, not a silent no-op) so a caller that bypasses this UI is still
  // stopped.
  async function removeTemplate() {
    const reason = prompt("Reason for deleting this template:");
    if (reason === null) return; // cancelled
    if (!reason.trim()) {
      setError("A reason is required to delete this template.");
      return;
    }
    try {
      await api(`/api/process-templates/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      router.push("/processes");
    } catch (e) { setError((e as Error).message); }
  }

  if (!template) return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;

  return (
    <div className="p-6">
      {/* #219: the screen carried no heading, breadcrumb or back link — with the name box blank
          it identified itself not at all. The caption names the SERVER's name, so it still says
          which template is open while the box holds an unsaved rename. */}
      <Link href="/processes" className="text-sm text-blue-700 underline">← Process templates</Link>
      <h1 className="mt-1 text-2xl font-semibold">{template.name}</h1>
      <p className="mb-2 text-xs text-slate-500">Process template</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
               aria-label="Template name"
               disabled={!canEdit.allowed} title={canEdit.title}
               className="min-w-[16rem] flex-1 rounded border px-2 py-1 text-xl font-semibold disabled:bg-slate-50" />
        <button onClick={saveName} disabled={canEdit.disabled || !nameDirty} title={canEdit.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Save
        </button>
        <button onClick={removeTemplate} disabled={canDelete.disabled} title={canDelete.title}
                className="ml-auto text-sm text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
          Delete template
        </button>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      <label className="mb-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={template.active}
               disabled={!canEdit.allowed || togglingActive}
               title={togglingActive ? "Saving…" : canEdit.title}
               onChange={(e) => toggleActive(e.target.checked)} />
        Active
      </label>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Steps</h2>
        <ol className="mb-3 space-y-3">
          {template.steps.map((s, idx) => {
            const dirty = isBoilerplateDirty(s);
            return (
              <li key={s.id} className="rounded border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">{s.code} — {s.codeName}</span>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => move(idx, -1)} disabled={canEdit.disabled || idx === 0}
                            title={canEdit.title} aria-label="Move up"
                            className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                      ↑
                    </button>
                    <button type="button" onClick={() => move(idx, 1)}
                            disabled={canEdit.disabled || idx === template.steps.length - 1}
                            title={canEdit.title} aria-label="Move down"
                            className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                      ↓
                    </button>
                    <button type="button" onClick={() => removeStep(s.id)} disabled={canEdit.disabled}
                            title={canEdit.title}
                            className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                      Remove
                    </button>
                  </div>
                </div>
                <textarea value={shownBoilerplate(s)} disabled={!canEdit.allowed}
                          title={canEdit.title} rows={2} placeholder="Boilerplate"
                          onChange={(e) => setBoilerplateDraft(s.id, e.target.value)}
                          className="mb-2 w-full rounded border px-2 py-1 text-sm disabled:bg-slate-50" />
                <button type="button" onClick={() => saveBoilerplate(s.id)} disabled={canEdit.disabled || !dirty}
                        title={canEdit.title}
                        className="rounded bg-slate-800 px-3 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                  Save step
                </button>
              </li>
            );
          })}
          {template.steps.length === 0 && (
            <li className="text-sm text-slate-500">No steps yet — add the first one below.</li>
          )}
        </ol>

        <div className="flex flex-wrap items-end gap-2">
          <select value={addCodeId} disabled={canEdit.disabled || !codesReady}
                  title={!codesReady ? "Options failed to load — reload the page" : canEdit.title}
                  onChange={(e) => setAddCodeId(e.target.value)}
                  className="rounded border px-2 py-1 text-sm">
            <option value="">Add step: code…</option>
            {codes.filter((c) => c.active).map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </select>
          <button type="button" onClick={addStep}
                  disabled={canEdit.disabled || !addCodeId || addingStep}
                  title={addingStep ? "Adding…" : canEdit.title}
                  className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {addingStep ? "Adding…" : "Add step"}
          </button>
        </div>
      </section>

      <div className="mb-6">
        <HistoryPanel entity="processTemplate" entityId={id} />
      </div>
    </div>
  );
}
