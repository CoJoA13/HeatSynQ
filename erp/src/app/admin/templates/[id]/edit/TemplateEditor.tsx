"use client";
// The structured template editor (Phase 7 Task 17, spec §5.5) — the orchestrator behind
// /admin/templates/[id]/edit. It loads the open draft's config from GET /api/templates/[id], holds
// it in component state, and renders the contract-driven panels over it. ONE component tree for all
// eight docTypes: the docType selects a contract (`contractFor`), and every panel renders from that
// contract with no per-type branch.
//
// SAVE SEAM (Task 18): `save()` does a PATCH /api/templates/[id]/draft with the config and the
// `updatedAt` it loaded, and on success advances `updatedAt` from the response so a second save in
// the same session still matches the precondition. The stale-precondition 409 (spec §5.1) gets the
// reload-vs-overwrite UX: on a 409 the editor rolls its working state back to server truth FIRST
// (fetch the fresh draft, reset the config/precondition), and only THEN shows a persistent conflict
// banner — the HANDOFF §5.13 ordering, so the reload never wipes the message it is reporting. The
// user's set-aside edits are stashed so they can re-apply them onto the fresh `updatedAt` and save
// over the new version (a deliberate overwrite). A successful save clears the banner; the reload the
// error triggered does not. Non-409 failures (a 400 from validateConfig, a 403) surface plainly,
// with no reload. The reload/overwrite decision is `resolveSaveError` (pure, unit-tested).
//
// Client component: it reaches the guarded API (which does its own `mustCan(... "templates" ...)`),
// so it never imports `src/server/**` — the contracts + editor logic it uses are pure and
// client-safe (the templates-admin list page precedent).
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError, api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { contractFor, type TemplateConfig, type TemplateDocTypeString } from "@/lib/template-contracts";
import { lockIndex, resolveSaveError, widthBudgetError } from "@/lib/template-editor";
import {
  FontsPanel, FormatsPanel, PageFooterPanel, SectionsPanel, TextBlocksPanel, WidthsPanel,
} from "./panels";
import { LogoPanel } from "./LogoPanel";

// Local mirror of the server read type (a "use client" file must not import src/server/**; the
// templates-admin page precedent). Dates arrive as ISO strings over JSON.
type Detail = {
  id: string; docType: TemplateDocTypeString; name: string;
  draft: { versionNumber: number; config: TemplateConfig; updatedAt: string; logoMimeType: string | null } | null;
};

export function TemplateEditor({ templateId }: { templateId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [config, setConfig] = useState<TemplateConfig | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [logoMimeType, setLogoMimeType] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The stale-updatedAt 409 banner (spec §5.1). Kept SEPARATE from `error` because it must survive
  // the rollback that precedes it (§5.13) and persist until the user acts — a plain `error` is
  // cleared on the next save attempt. `stashed` holds the edits the failed save tried to write, so
  // the user can re-apply them onto the fresh precondition (the deliberate-overwrite path).
  const [conflict, setConflict] = useState<string | null>(null);
  const [stashed, setStashed] = useState<TemplateConfig | null>(null);

  const { permissions: perms, error: permsError } = usePermissions();
  const canEdit = gate(perms, "templates.edit");

  const load = useCallback(async () => {
    const d = await api<Detail>(`/api/templates/${templateId}`);
    setDetail(d);
    if (d.draft) {
      setConfig(d.draft.config);
      setUpdatedAt(d.draft.updatedAt);
      setLogoMimeType(d.draft.logoMimeType);
      setDirty(false);
    } else {
      setConfig(null); // no open draft — nothing to edit (discarded/published elsewhere)
    }
  }, [templateId]);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  // The one config mutation entry point handed to every panel: swap the working config for the
  // result of a pure editor function, and mark the draft dirty. Functional setState so rapid edits
  // never read a stale closure. A deliberate edit is the user "acting", so it dismisses the
  // conflict banner (they have moved on from the stale-draft resolution) and drops the stash.
  const apply = useCallback((fn: (c: TemplateConfig) => TemplateConfig) => {
    setConfig((prev) => (prev === null ? prev : fn(prev)));
    setDirty(true);
    setSavedTick(false);
    setConflict(null);
    setStashed(null);
  }, []);

  // After a logo upload/clear (which bumps the draft's updatedAt on the server), refresh ONLY the
  // precondition + the logo-present flag — never the config, so in-progress unsaved edits survive.
  const refreshDraftMeta = useCallback(async () => {
    const d = await api<Detail>(`/api/templates/${templateId}`);
    if (d.draft) { setUpdatedAt(d.draft.updatedAt); setLogoMimeType(d.draft.logoMimeType); }
  }, [templateId]);

  // Roll the working state back to the server's current draft — the FIRST half of the 409 conflict
  // response (§5.13): it replaces the config and the precondition with server truth and clears
  // dirty. It deliberately does NOT touch `conflict`/`stashed`: the caller sets the banner AFTER
  // this resolves, so nothing here can wipe the message it is about to show.
  const rollbackToServerTruth = useCallback(async () => {
    const d = await api<Detail>(`/api/templates/${templateId}`);
    if (d.draft === null) throw new ApiError("This template no longer has an open draft.", 404);
    setConfig(d.draft.config);
    setUpdatedAt(d.draft.updatedAt);
    setLogoMimeType(d.draft.logoMimeType);
    setDirty(false);
    setSavedTick(false);
  }, [templateId]);

  async function save() {
    if (config === null || updatedAt === null) return;
    const attempted = config; // capture the edits this save is trying to write, for the stash
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ updatedAt: string }>(`/api/templates/${templateId}/draft`, {
        method: "PATCH", body: JSON.stringify({ config, updatedAt }),
      });
      setUpdatedAt(res.updatedAt); // keep the precondition fresh for the next save
      setDirty(false);
      setSavedTick(true);
      setConflict(null); // a save that SUCCEEDS clears the conflict banner
      setStashed(null);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : null;
      const resolution = resolveSaveError(status, e instanceof Error ? e.message : String(e));
      if (resolution.action === "reload-then-conflict") {
        // §5.13: roll back to server truth FIRST, then set the banner LAST so the reload can't wipe
        // it. Stash the attempted edits so the user can re-apply them (the overwrite path).
        setStashed(attempted);
        try {
          await rollbackToServerTruth();
          setConflict(resolution.message);
        } catch (reloadErr) {
          // The rollback fetch itself failed — surface that rather than a half-reloaded editor.
          setStashed(null);
          setError(reloadErr instanceof Error ? reloadErr.message : String(reloadErr));
        }
      } else {
        setError(resolution.message); // 400/403/network — plain surface, no reload
      }
    } finally {
      setSaving(false);
    }
  }

  // The overwrite half of the reload-vs-overwrite choice: put the stashed edits back on top of the
  // fresh precondition and mark dirty, so the next Save writes over the version that displaced them.
  // Acting on the conflict dismisses its banner.
  function reapplyStashed() {
    if (stashed === null) return;
    setConfig(stashed);
    setDirty(true);
    setSavedTick(false);
    setConflict(null);
    setStashed(null);
  }

  const contract = useMemo(() => (detail ? contractFor(detail.docType) : null), [detail]);
  const locks = useMemo(() => (contract ? lockIndex(contract) : new Map<string, string>()), [contract]);
  // The client-side Save gate (Task 18 minor): the reason a save would only bounce back a 400, or
  // null when the working config is savable. Disables Save early and names the over-budget table in
  // a tooltip; the server's validateConfig stays the backstop.
  const saveBlock = useMemo(
    () => (contract && config ? widthBudgetError(contract, config) : null), [contract, config]);

  if (error && detail === null) {
    return (
      <div className="p-6">
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>
        <Link href="/admin/templates" className="text-sm text-blue-700 underline">Back to templates</Link>
      </div>
    );
  }
  if (detail === null || contract === null) {
    return <p className="p-6 text-sm text-slate-500">Loading…</p>;
  }
  if (detail.draft === null || config === null) {
    return (
      <div className="p-6">
        <p className="mb-3 text-sm text-slate-600">
          This template has no open draft to edit. Open one from the templates list first.
        </p>
        <Link href="/admin/templates" className="text-sm text-blue-700 underline">Back to templates</Link>
      </div>
    );
  }

  const panelProps = { contract, config, apply, disabled: canEdit.disabled, editTitle: canEdit.title, locks };

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/admin/templates" className="text-sm text-blue-700 underline">← Templates</Link>
        <div className="mr-auto">
          <h1 className="text-xl font-semibold">{detail.name}</h1>
          <p className="text-xs text-slate-500">
            {contract.name} · editing draft v{detail.draft.versionNumber}
          </p>
        </div>
        {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
        {savedTick && !dirty && <span className="text-xs text-emerald-700">Saved</span>}
        <button type="button" onClick={() => void save()}
                disabled={canEdit.disabled || saving || !dirty || saveBlock !== null}
                title={canEdit.title ?? saveBlock ?? undefined}
                className="rounded bg-slate-800 px-4 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          {saving ? "Saving…" : "Save draft"}
        </button>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700" role="alert">{error ?? permsError}</p>
      )}
      {conflict && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
          <p>{conflict}</p>
          {stashed !== null && (
            <button type="button" onClick={reapplyStashed}
                    className="mt-2 rounded border border-amber-400 bg-white px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100">
              Re-apply my changes
            </button>
          )}
        </div>
      )}
      {canEdit.disabled && (
        <p className="mb-3 rounded bg-slate-100 p-2 text-xs text-slate-600">
          You are viewing this draft. Editing requires the <code>templates.edit</code> permission.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4 lg:col-span-2">
          <SectionsPanel {...panelProps} />
        </div>
        <WidthsPanel {...panelProps} />
        <FormatsPanel {...panelProps} />
        <FontsPanel {...panelProps} />
        <TextBlocksPanel {...panelProps} />
        <PageFooterPanel {...panelProps} />
        <LogoPanel templateId={templateId} logoMimeType={logoMimeType} config={config} apply={apply}
                   disabled={canEdit.disabled} editTitle={canEdit.title} onLogoChanged={refreshDraftMeta} />
      </div>
    </div>
  );
}
