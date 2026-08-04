"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";

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
 * never hides them.
 */
export function AttachmentsSection({
  owner, ownerId, canEdit,
}: {
  owner: AttachmentOwner;
  ownerId: string;
  canEdit: boolean;
}) {
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const basePath = `/api/${AREA_PATH[owner]}/${ownerId}/attachments`;
  const editTitle = canEdit ? undefined : `Requires ${EDIT_PERMISSION[owner]}`;

  const load = useCallback(async () => {
    const data = await api<AttachmentRow[]>(basePath);
    setRows(data);
  }, [basePath]);
  useEffect(() => { load().then(() => setError(null)).catch((e) => setError((e as Error).message)); }, [load]);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file, file.name);
      // `headers: {}` overrides fetcher.ts's default `content-type: application/json` (object
      // spread replaces the whole `headers` key, it doesn't merge per-header) — a FormData body
      // needs the browser's own auto-computed `multipart/form-data; boundary=...`, which only
      // happens when nothing has already claimed the Content-Type header.
      await api(basePath, { method: "POST", headers: {}, body: form });
      setError(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
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
      setError(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
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
      {error && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
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
