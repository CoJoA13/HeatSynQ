"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { invalidateHistory } from "@/components/HistoryPanel";
import { useLatest } from "@/lib/use-latest";
import { attachmentSizeError } from "@/lib/upload-limits";

// Mirrors src/server/attachments.ts's AttachmentOwner/AttachmentMeta shape — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md "Constraints that will bite you"; the parts/[id]/page.tsx
// `Part` type precedent).
export type AttachmentOwner = "part" | "order";
type AttachmentRow = { id: string; filename: string; mimeType: string; size: number; createdAt: string };

const AREA_PATH: Record<AttachmentOwner, string> = { part: "parts", order: "orders" };
const EDIT_PERMISSION: Record<AttachmentOwner, string> = { part: "parts.edit", order: "orders.edit" };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One component for both attachment owners (parts and orders) — the UI half of the shared
 * attachments.ts service. Mounted on the part detail page now (src/app/parts/[id]/page.tsx); the
 * order hub mounts it in a later task.
 *
 * `canEdit` is a plain boolean rather than the raw `perms` array the page's other sections take
 * (gate(perms, "parts.edit").allowed, etc.): the caller already knows which area's `.edit`
 * permission applies to ITS owner kind, so this shared component only needs the yes/no answer —
 * not the whole permission array — plus `owner` itself to name the right permission in the
 * disabled tooltip below.
 *
 * §5.16: canEdit=false disables upload/delete with a tooltip naming the missing permission; it
 * never hides them. `disabledTitle` overrides that permission wording for a caller whose block
 * is NOT a permission at all — a voided order's page passes "Order is voided", because telling
 * an operator they lack orders.edit when the real reason is the order's own state names the
 * WRONG reason (#37, the same §5.16 rule).
 */
export function AttachmentsSection({
  owner, ownerId, canEdit, disabledTitle,
}: {
  owner: AttachmentOwner;
  ownerId: string;
  canEdit: boolean;
  disabledTitle?: string;
}) {
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  // #144: the error carries WHICH operation failed, so a success can only ever clear its own
  // operation's failure (plus a load failure, which its reload is about to either refresh away
  // or re-report) — an upload landing must never erase a delete's failure banner, nor the
  // reverse. One banner slot, tagged, rather than three states: the clearing rules change,
  // nothing else does.
  const [error, setError] =
    useState<{ source: "load" | "upload" | "delete"; message: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const basePath = `/api/${AREA_PATH[owner]}/${ownerId}/attachments`;
  const editTitle = canEdit ? undefined : (disabledTitle ?? `Requires ${EDIT_PERMISSION[owner]}`);

  const latest = useLatest();
  // F7 (customers/page.tsx precedent): ticket-gated on BOTH paths. `load` is the one funnel for
  // the mount fetch and the upload/delete refreshes, and delete stays enabled during an upload,
  // so two list GETs can overlap — the earlier snapshot landing last would hide a committed
  // change ("uploaded but not listed", "deleted but still listed") — and a superseded request's
  // rejection must not overwrite current state with a stale failure either. Deliberately no
  // clear on success here (§5.13): the handlers clear their own operation's failure themselves
  // before dispatching their refresh, and a reload must never erase a failure reported after it
  // started.
  const load = useCallback(async () => {
    const t = latest.next();
    let data: AttachmentRow[];
    try {
      data = await api<AttachmentRow[]>(basePath);
    } catch (e) {
      if (latest.isCurrent(t)) setError({ source: "load", message: (e as Error).message });
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
  }, [basePath, latest]);
  useEffect(() => { void load(); }, [load]);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // #38: refuse an oversized file BEFORE building the FormData — the server's exact refusal
    // (mirrored in src/lib/upload-limits.ts, drift-guarded), without first shipping 20MB+ of
    // body that can only end in that same message. The picker resets for the same reason as the
    // finally block below: re-choosing the same (perhaps since-shrunk) file must still fire.
    const sizeError = attachmentSizeError(file.size);
    if (sizeError) {
      // #38's pre-check rides the upload channel — it refuses the same operation the POST would.
      setError({ source: "upload", message: sizeError });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file, file.name);
      // `headers: {}` overrides fetcher.ts's default `content-type: application/json` (object
      // spread replaces the whole `headers` key, it doesn't merge per-header) — a FormData body
      // needs the browser's own auto-computed `multipart/form-data; boundary=...`, which only
      // happens when nothing has already claimed the Content-Type header.
      await api(basePath, { method: "POST", headers: {}, body: form });
      // #14 item 1, extended to attachments by #153: `partAttachment`/`orderAttachment` are
      // registered children of the part and order panels, so this write moves a history the
      // parent page is displaying. Success path, before the follow-up load.
      invalidateHistory();
      // Clears an upload or load failure only — never a delete's (#144).
      setError((cur) => (cur?.source === "delete" ? cur : null));
      await load();
    } catch (err) {
      setError({ source: "upload", message: (err as Error).message });
    } finally {
      setUploading(false);
      // Resets the picker so choosing the SAME file again still fires onChange (the DOM only
      // fires `change` on a value transition, and a file input's value can only ever be cleared
      // programmatically, never re-set to the same path by the browser itself).
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function remove(att: AttachmentRow) {
    if (!confirm(`Delete attachment "${att.filename}"?`)) return;
    try {
      await api(`${basePath}/${att.id}`, { method: "DELETE" });
      invalidateHistory(); // #14 item 1 — success path, before the follow-up load
      // Clears a delete or load failure only — never an upload's (#144).
      setError((cur) => (cur?.source === "upload" ? cur : null));
      await load();
    } catch (err) {
      setError({ source: "delete", message: (err as Error).message });
    }
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Attachments</h2>
        <input ref={fileInputRef} type="file" onChange={onFileChosen} disabled={!canEdit || uploading}
               title={editTitle} className="text-sm disabled:cursor-not-allowed" />
      </div>

      {/* Standard error banner — no silent catch on a failed list/upload/delete. */}
      {error && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{error.message}</p>}
      {uploading && <p className="mb-2 text-sm text-slate-500">Uploading…</p>}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No attachments.</p>
      ) : (
        <ul className="divide-y rounded border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between p-2">
              {/* Bytes URL opened in a new tab — the route sets Content-Disposition itself
                  (inline for images/PDF, attachment otherwise), so a plain link is enough. */}
              <a href={`${basePath}/${r.id}`} target="_blank" rel="noreferrer"
                 className="text-blue-700 hover:underline">
                {r.filename}
              </a>
              <span className="flex items-center gap-3">
                <span className="text-slate-500">
                  {formatSize(r.size)} · {new Date(r.createdAt).toLocaleDateString()}
                </span>
                <button onClick={() => remove(r)} disabled={!canEdit} title={editTitle}
                        className="text-xs text-red-600 underline disabled:cursor-not-allowed disabled:text-slate-400">
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
