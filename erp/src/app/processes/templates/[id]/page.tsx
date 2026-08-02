"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { HistoryPanel } from "@/components/HistoryPanel";
import { gate } from "@/lib/permission-ui";
import { swapAt } from "@/lib/reorder";
import { usePermissions } from "@/lib/use-permissions";

// Local mirrors of src/server/process-templates.ts's exported row types — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md "Constraints that will bite you").
type TemplateStep = {
  id: string; position: number; codeId: string; code: string; codeName: string; boilerplate: string;
};
type Template = { id: string; name: string; active: boolean; steps: TemplateStep[] };
type StepCodeOption = { id: string; code: string; name: string; active: boolean };

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
  const [togglingActive, setTogglingActive] = useState(false);

  // Per-step boilerplate draft, keyed by stepId. Rebuilt from server truth (`template.steps`)
  // whenever the template reloads — the ProcessStepsSection.tsx `drafts`/`originals` precedent,
  // narrowed to a single field since a template step carries no per-code field values, only
  // boilerplate text. Because `template` itself is never optimistically mutated for step edits
  // (every step mutation reloads from the server before updating state), comparing a draft
  // straight against `template.steps` is enough to know whether it's dirty — no separate
  // `originals` map needed.
  const [boilerplateDrafts, setBoilerplateDrafts] = useState<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    const t = await api<Template>(`/api/process-templates/${id}`);
    setTemplate(t);
    setNameDraft(t.name);
    setError(null);
  }, [id]);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  // Merge, not replace (Codex, PR #22). This effect keys on `template`, and `toggleActive`
  // optimistically builds a NEW template object whose steps are untouched — so a blanket rebuild
  // erased every unsaved boilerplate edit on the page the moment the Active box was ticked, with
  // no warning. Successful name saves and every other `load()` did the same to steps other than
  // the one being saved. A step that already has a draft keeps it; a step that doesn't (first
  // load, or one just added) takes the server's text. Steps that are gone drop out, since the map
  // is rebuilt from `template.steps`. Saving a step reloads it with the text just written, so the
  // kept draft and the server value agree and it reads as clean.
  useEffect(() => {
    if (!template) return;
    setBoilerplateDrafts((cur) => new Map(
      template.steps.map((s) => [s.id, cur.get(s.id) ?? s.boilerplate]),
    ));
  }, [template]);

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
      setError(null);
    } catch (e) {
      await load().catch(() => {});
      setError((e as Error).message);
    } finally {
      setTogglingActive(false);
    }
  }

  function setBoilerplateDraft(stepId: string, value: string) {
    setBoilerplateDrafts((cur) => {
      const next = new Map(cur);
      next.set(stepId, value);
      return next;
    });
  }
  function isBoilerplateDirty(step: TemplateStep): boolean {
    return (boilerplateDrafts.get(step.id) ?? step.boilerplate) !== step.boilerplate;
  }

  async function addStep() {
    if (!addCodeId) return;
    try {
      await api(`/api/process-templates/${id}/steps`, { method: "POST", body: JSON.stringify({ codeId: addCodeId }) });
      setAddCodeId("");
      setError(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function saveBoilerplate(stepId: string) {
    try {
      await api(`/api/process-templates/${id}/steps/${stepId}`, {
        method: "PATCH", body: JSON.stringify({ boilerplate: boilerplateDrafts.get(stepId) ?? "" }),
      });
      setError(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function removeStep(stepId: string) {
    try {
      await api(`/api/process-templates/${id}/steps/${stepId}`, { method: "DELETE" });
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
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
                <textarea value={boilerplateDrafts.get(s.id) ?? s.boilerplate} disabled={!canEdit.allowed}
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
          <button type="button" onClick={addStep} disabled={canEdit.disabled || !addCodeId} title={canEdit.title}
                  className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            Add step
          </button>
        </div>
      </section>

      <div className="mb-6">
        <HistoryPanel entity="processTemplate" entityId={id} />
      </div>
    </div>
  );
}
