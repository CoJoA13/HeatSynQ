"use client";
// The structured template editor (Phase 7 Task 17, spec §5.5) — the orchestrator behind
// /admin/templates/[id]/edit. It loads the open draft's config from GET /api/templates/[id], holds
// it in component state, and renders the contract-driven panels over it. ONE component tree for all
// eight docTypes: the docType selects a contract (`contractFor`), and every panel renders from that
// contract with no per-type branch.
//
// SAVE SEAM (Task 17 → Task 18): `save()` does a PLAIN PATCH /api/templates/[id]/draft with the
// config and the `updatedAt` it loaded, and on success advances `updatedAt` from the response so a
// second save in the same session still matches the precondition. It has NO 409-conflict UX: a
// stale-precondition 409 surfaces its server message in the error banner like any other failure.
// Task 18 hardens exactly this catch — detecting `ApiError.status === 409` and offering the
// reload/re-apply flow — building on the config state and PATCH wiring this component establishes.
//
// Client component: it reaches the guarded API (which does its own `mustCan(... "templates" ...)`),
// so it never imports `src/server/**` — the contracts + editor logic it uses are pure and
// client-safe (the templates-admin list page precedent).
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { contractFor, type TemplateConfig, type TemplateDocTypeString } from "@/lib/template-contracts";
import { lockIndex } from "@/lib/template-editor";
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
  // never read a stale closure.
  const apply = useCallback((fn: (c: TemplateConfig) => TemplateConfig) => {
    setConfig((prev) => (prev === null ? prev : fn(prev)));
    setDirty(true);
    setSavedTick(false);
  }, []);

  // After a logo upload/clear (which bumps the draft's updatedAt on the server), refresh ONLY the
  // precondition + the logo-present flag — never the config, so in-progress unsaved edits survive.
  const refreshDraftMeta = useCallback(async () => {
    const d = await api<Detail>(`/api/templates/${templateId}`);
    if (d.draft) { setUpdatedAt(d.draft.updatedAt); setLogoMimeType(d.draft.logoMimeType); }
  }, [templateId]);

  async function save() {
    if (config === null || updatedAt === null) return;
    setSaving(true);
    try {
      const res = await api<{ updatedAt: string }>(`/api/templates/${templateId}/draft`, {
        method: "PATCH", body: JSON.stringify({ config, updatedAt }),
      });
      setUpdatedAt(res.updatedAt); // keep the precondition fresh for the next save (happy path only)
      setDirty(false);
      setSavedTick(true);
      setError(null);
    } catch (e) {
      // TASK 17 SEAM (see the file header): plain error surface, no 409-specific handling. Task 18
      // replaces this catch with the updatedAt-conflict reload/re-apply UX.
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const contract = useMemo(() => (detail ? contractFor(detail.docType) : null), [detail]);
  const locks = useMemo(() => (contract ? lockIndex(contract) : new Map<string, string>()), [contract]);

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
                disabled={canEdit.disabled || saving || !dirty}
                title={canEdit.title}
                className="rounded bg-slate-800 px-4 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          {saving ? "Saving…" : "Save draft"}
        </button>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700" role="alert">{error ?? permsError}</p>
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
