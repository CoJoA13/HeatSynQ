"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/fetcher";
import { gate, gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
// Client-safe: the contract registry is pure declarations (spec §5.3 — the editor imports it),
// no src/server import. `contractFor(dt).name` is the single source of truth for each docType's
// display name ("Traveler", "Bill of lading", …) — a local label map would drift from it.
import { TEMPLATE_DOC_TYPES, contractFor, type TemplateDocTypeString } from "@/lib/template-contracts/index";

// Local mirrors of src/server/templates.ts's read types (the Shell.tsx precedent: a "use client"
// file must not import from src/server/**). Dates arrive as ISO strings over JSON.
type ListRow = {
  id: string; docType: TemplateDocTypeString; name: string; isDefault: boolean;
  publishedVersionNumber: number | null; hasDraft: boolean; assignmentCount: number;
};
type VersionSummary = {
  versionNumber: number; status: "DRAFT" | "PUBLISHED" | "DISCARDED";
  publishedAt: string | null; publishedBy: string | null; hasLogo: boolean;
};
type Detail = {
  id: string; docType: TemplateDocTypeString; name: string; isDefault: boolean;
  publishedVersionNumber: number | null;
  draft: { versionNumber: number; updatedAt: string } | null;
  versions: VersionSummary[];
};

function docTypeName(dt: TemplateDocTypeString): string {
  return contractFor(dt).name;
}

export default function TemplatesPage() {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ id: string; name: string; list: Blocker[] } | null>(null);
  const [newDocType, setNewDocType] = useState<TemplateDocTypeString>(TEMPLATE_DOC_TYPES[0]);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string>("");

  const { permissions: perms, error: permsError } = usePermissions();
  // Publish AND set-default both require templates.edit AND the edit_templates special (spec §7,
  // the change_prices pattern) — disabled if either is missing, the tooltip naming whichever is
  // the blocker (PricingSection's "whichever is actually the blocker" rule).
  const canCreate = gate(perms, "templates.create");
  const canEdit = gate(perms, "templates.edit");
  const canDelete = gate(perms, "templates.delete");
  const editTemplates = gateDo(perms, "edit_templates");
  const consequentialDisabled = canEdit.disabled || editTemplates.disabled;
  const consequentialTitle = canEdit.disabled ? canEdit.title : editTemplates.title;

  // Rows-list gate (the surcharges/page.tsx load shape): refresh()/createTemplate/removeTemplate
  // refire load() with the buttons un-disabled, so overlapping list loads used to land in
  // arrival order.
  const rowsLatest = useLatest();
  const load = useCallback(async () => {
    const ticket = rowsLatest.next();
    try {
      const data = await api<ListRow[]>("/api/templates");
      if (!rowsLatest.isCurrent(ticket)) return; // a slower, now-superseded load lost the race
      setRows(data);
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not clobber current state.
      if (!rowsLatest.isCurrent(ticket)) return;
      throw e;
    }
  }, [rowsLatest]);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  // ONE shared gate for EVERY writer of `detail` — the selection effect below and loadDetail (the
  // post-mutation refresh path). loadDetail used to be ungated: publish A then click B, and
  // loadDetail(A)'s late response repainted A's pane under B's highlighted row — "always targets
  // the open detail's id" was only true at dispatch time, not response time. On the shared gate a
  // newer selection automatically invalidates any in-flight post-mutation detail refresh.
  const detailLatest = useLatest();
  const loadDetail = useCallback(async (id: string) => {
    const ticket = detailLatest.next();
    try {
      const d = await api<Detail>(`/api/templates/${id}`);
      if (!detailLatest.isCurrent(ticket)) return; // selection moved on — the pane is theirs now
      setDetail(d);
    } catch (e) {
      // F7 (customers/page.tsx): a superseded refresh's rejection must not clobber current state.
      if (!detailLatest.isCurrent(ticket)) return;
      throw e;
    }
  }, [detailLatest]);
  // §5.13 stale-gate: selecting A then B before A's detail lands must not let A's response
  // overwrite B — every lifecycle/rename/delete handler acts on `detail.id`, so a stale adopt
  // would aim publish/rename/DELETE at the wrong template. Ticketed on the SAME gate as loadDetail
  // (replacing the old effect-scoped `stale` flag) so the two writers of `detail` order against
  // each other; success never clears the error banner (§5.13 — a reload must not erase a live
  // failure), and deselecting bumps the gate so an in-flight detail fetch cannot repaint a pane
  // the user just closed.
  useEffect(() => {
    setBlocked(null);
    setRenaming("");
    const ticket = detailLatest.next();
    if (selected === null) { setDetail(null); return; }
    setDetail(null);
    api<Detail>(`/api/templates/${selected}`)
      .then((d) => { if (detailLatest.isCurrent(ticket)) setDetail(d); })
      .catch((e) => { if (detailLatest.isCurrent(ticket)) setError((e as Error).message); });
  }, [selected, detailLatest]);

  // Every mutation reloads BOTH the list (badges/counts) and the open detail (lifecycle state),
  // then reports on failure — rolling back to server truth first is unnecessary here because
  // nothing is optimistic (no local edits held), so a plain reload after the action suffices.
  async function refresh(id: string | null) {
    await load();
    if (id !== null) await loadDetail(id);
  }

  async function createTemplate() {
    const name = newName.trim();
    if (!name) { setError("A template name is required"); return; }
    try {
      const created = await api<{ id: string }>("/api/templates", {
        method: "POST", body: JSON.stringify({ docType: newDocType, name }),
      });
      setNewName(""); setError(null);
      await load();
      setSelected(created.id); // select the new template — its v1 draft is open (create opens it)
    } catch (e) { setError((e as Error).message); }
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setError(null);
      await refresh(id);
    } catch (e) { setError((e as Error).message); }
  }

  const openDraft = (id: string, fromVersion?: number) =>
    act(id, () => api(`/api/templates/${id}/draft`, {
      method: "POST", body: JSON.stringify(fromVersion === undefined ? {} : { fromVersion }),
    }));
  const discardDraft = (id: string) =>
    act(id, () => api(`/api/templates/${id}/draft`, { method: "DELETE" }));
  const publish = (id: string) =>
    act(id, () => api(`/api/templates/${id}/publish`, { method: "POST" }));
  const setDefault = (id: string) =>
    act(id, () => api(`/api/templates/${id}/default`, { method: "POST" }));

  async function rename(id: string) {
    const name = renaming.trim();
    if (!name) { setError("A template name is required"); return; }
    try {
      await api(`/api/templates/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setRenaming(""); setError(null);
      await refresh(id);
    } catch (e) { setError((e as Error).message); }
  }

  async function removeTemplate(row: Detail) {
    // Reasoned delete (§5.17 — it retires a whole version history and frees a name for reuse). The
    // server requires the reason too (deleteTemplate); this prompt only spares a round trip.
    const reason = prompt(
      `Delete template "${row.name}" (${docTypeName(row.docType)})?\n\n` +
      `Its entire version history is retired from view and the name can be reused later, ` +
      `starting a fresh template rather than restoring this one.\n\n` +
      `Reason for deleting (recorded in the audit history):`,
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to delete a template"); return; }
    try {
      await api(`/api/templates/${row.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      setSelected(null); setError(null); setBlocked(null);
      await load();
    } catch (e) {
      // §5.14: a refused delete is not a dead end. On a 400, fetch the blocker list and show it
      // linked, with the Excel export (carried Task-4 minor b: the export is reachable ONLY from
      // this refusal, never as a standalone control). An empty list means the refusal was the
      // default-template guard (no assignments), which falls through to the plain banner below.
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/templates/${row.id}/blockers`);
          if (list.length) { setBlocked({ id: row.id, name: row.name, list }); setError(null); return; }
        } catch (listErr) {
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  const grouped = TEMPLATE_DOC_TYPES.map((dt) => ({
    docType: dt,
    templates: rows.filter((r) => r.docType === dt).sort((a, b) => a.name.localeCompare(b.name)),
  }));

  return (
    <div className="p-6">
      <h1 className="mb-1 text-2xl font-semibold">Document templates</h1>
      <p className="mb-4 max-w-3xl text-sm text-slate-600">
        One template per document type is starred as the default. Editing happens in a draft that
        you publish when ready; published versions are frozen and kept as history.
      </p>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      {/* Create — a docType picker + name, gated on templates.create (§5.16 disabled-with-reason) */}
      <div className="mb-5 flex flex-wrap items-end gap-2 rounded border bg-white p-3">
        <label className="text-sm">
          <span className="mr-2">New template for</span>
          <select aria-label="New template document type" value={newDocType}
                  disabled={canCreate.disabled} title={canCreate.title}
                  onChange={(e) => setNewDocType(e.target.value as TemplateDocTypeString)}
                  className="rounded border px-2 py-1 disabled:bg-slate-100">
            {TEMPLATE_DOC_TYPES.map((dt) => <option key={dt} value={dt}>{docTypeName(dt)}</option>)}
          </select>
        </label>
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
               disabled={canCreate.disabled} title={canCreate.title}
               placeholder="Template name"
               className="rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
        <button onClick={() => void createTemplate()} disabled={canCreate.disabled} title={canCreate.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Create template
        </button>
      </div>

      <div className="flex gap-6">
        <div className="w-80 shrink-0 space-y-4">
          {grouped.map(({ docType, templates }) => (
            <div key={docType}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {docTypeName(docType)}
              </div>
              <ul className="divide-y rounded border bg-white text-sm">
                {templates.length === 0 && (
                  <li className="px-3 py-2 text-slate-400">No templates yet</li>
                )}
                {templates.map((r) => (
                  <li key={r.id} onClick={() => setSelected(r.id)}
                      className={`cursor-pointer px-3 py-2 ${selected === r.id ? "bg-slate-100" : ""}`}>
                    <div className="flex items-center gap-1">
                      {r.isDefault && <span title="Default for this document type" aria-label="default">★</span>}
                      <span className="font-medium">{r.name}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-slate-500">
                      <span>{r.publishedVersionNumber !== null
                        ? `Published v${r.publishedVersionNumber}` : "No published version"}</span>
                      {r.hasDraft && <span className="rounded bg-amber-100 px-1 text-amber-800">Draft</span>}
                      <span>{r.assignmentCount} assigned</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex-1">
          {detail === null ? (
            <p className="text-sm text-slate-500">Select a template to manage its versions.</p>
          ) : (
            <div className="rounded border bg-white p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium">
                    {detail.isDefault && <span className="mr-1" aria-label="default">★</span>}
                    {detail.name}
                  </h2>
                  <p className="text-xs text-slate-500">{docTypeName(detail.docType)}</p>
                </div>
                <button onClick={() => void removeTemplate(detail)}
                        disabled={canDelete.disabled} title={canDelete.title}
                        className="text-sm text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  Delete
                </button>
              </div>

              {/* Rename (templates.edit) */}
              <div className="mb-4 flex items-center gap-2">
                <input value={renaming === "" ? detail.name : renaming}
                       disabled={canEdit.disabled} title={canEdit.title}
                       onChange={(e) => setRenaming(e.target.value)}
                       className="w-64 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
                <button onClick={() => void rename(detail.id)}
                        disabled={canEdit.disabled || renaming.trim() === "" || renaming.trim() === detail.name}
                        title={canEdit.title}
                        className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:text-slate-400">
                  Rename
                </button>
              </div>

              {/* Lifecycle */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {detail.draft ? (
                  <>
                    <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-800">
                      Open draft: v{detail.draft.versionNumber}
                    </span>
                    <Link href={`/admin/templates/${detail.id}/edit`}
                          className="rounded bg-slate-800 px-3 py-1 text-sm text-white">
                      Edit draft
                    </Link>
                    <button onClick={() => void discardDraft(detail.id)}
                            disabled={canEdit.disabled} title={canEdit.title}
                            className="rounded border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:text-slate-400">
                      Discard draft
                    </button>
                    <button onClick={() => void publish(detail.id)}
                            disabled={consequentialDisabled} title={consequentialTitle}
                            className="rounded bg-emerald-700 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                      Publish
                    </button>
                  </>
                ) : (
                  <button onClick={() => void openDraft(detail.id)}
                          disabled={canEdit.disabled} title={canEdit.title}
                          className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                    Open draft
                  </button>
                )}
                {!detail.isDefault && (
                  <button onClick={() => void setDefault(detail.id)}
                          disabled={consequentialDisabled || detail.publishedVersionNumber === null}
                          title={detail.publishedVersionNumber === null
                            ? "Publish a version before making this the default" : consequentialTitle}
                          className="rounded border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:text-slate-400">
                    Set as default
                  </button>
                )}
              </div>

              {/* Version history */}
              <h3 className="mb-2 text-sm font-medium">Version history</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-slate-500">
                    <th className="py-1">Version</th>
                    <th className="py-1">Status</th>
                    <th className="py-1">Published</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {detail.versions.map((v) => (
                    <tr key={v.versionNumber} className="border-b last:border-0">
                      <td className="py-1">v{v.versionNumber}{v.hasLogo && <span className="ml-1 text-xs text-slate-400">(logo)</span>}</td>
                      <td className="py-1">
                        {v.versionNumber === detail.publishedVersionNumber ? "PUBLISHED (current)" : v.status}
                      </td>
                      <td className="py-1 text-xs text-slate-500">
                        {v.publishedAt ? `${new Date(v.publishedAt).toLocaleDateString()}${v.publishedBy ? ` · ${v.publishedBy}` : ""}` : "—"}
                      </td>
                      <td className="py-1 text-right">
                        {v.status === "PUBLISHED" && (
                          <button onClick={() => void openDraft(detail.id, v.versionNumber)}
                                  disabled={canEdit.disabled || detail.draft !== null}
                                  title={detail.draft !== null
                                    ? "Discard or publish the open draft first" : canEdit.title}
                                  className="text-xs text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
                            Open draft from this version
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {blocked && blocked.id === detail.id && (
                <BlockerPanel
                  label="template"
                  rowName={blocked.name}
                  list={blocked.list}
                  exportHref={`/api/templates/${detail.id}/blockers/export`}
                  onDismiss={() => setBlocked(null)}
                  note="Clear the assignment on each customer's page, then delete the template."
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
