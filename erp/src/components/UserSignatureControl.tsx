"use client";
import { useRef, useState } from "react";
import { ApiError } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";

/**
 * Per-user signature image control (Task 12) — upload/preview/clear for the users admin table
 * (src/app/admin/users/page.tsx). Owner ruling (spec §3.11): the signature that prints on a
 * certification is the PRINTING user's own, so this is a plain per-user field, not a document
 * list — there is nothing here to browse or delete-one-of-many, only set/clear one image.
 *
 * Follows AttachmentsSection's FormData upload pattern (src/components/AttachmentsSection.tsx):
 * `fetch` directly rather than `api()` (src/lib/fetcher.ts), since a multipart body needs the
 * browser's own computed `multipart/form-data; boundary=...` Content-Type, and `api()` always
 * forces `application/json`.
 *
 * There is no "does a signature exist" flag from the users list to check first — GET .../signature
 * either streams the bytes or 404s "No signature on file" (src/app/api/admin/users/[id]/signature/
 * route.ts). The preview is a plain `<img>` pointed at that URL; the 404 case is exactly what
 * `onError` reports as "No signature on file" instead of a broken-image icon.
 *
 * `gate`: passed straight from the page's own `gateDo(perms, "manage_users")` (§5.16) — every
 * verb on this route requires that same special action, upload and clear both disabled with its
 * tooltip when it's missing, never hidden.
 */
export function UserSignatureControl({ userId, gate }: { userId: string; gate: Gate }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasImage, setHasImage] = useState(true); // optimistic; the <img>'s onError flips it
  const [version, setVersion] = useState(0); // cache-busts the <img> src after upload/clear
  const fileInputRef = useRef<HTMLInputElement>(null);
  const path = `/api/admin/users/${userId}/signature`;

  async function readError(res: Response, fallback: string): Promise<never> {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as { error?: string }).error ?? fallback, res.status);
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file, file.name);
      const res = await fetch(path, { method: "PUT", body: form });
      if (!res.ok) await readError(res, `Upload failed (${res.status})`);
      setError(null);
      setHasImage(true);
      setVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      // Resets the picker so choosing the SAME file again still fires onChange (AttachmentsSection
      // precedent — a file input only fires `change` on a value transition).
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function clear() {
    if (!confirm("Clear this signature?")) return;
    setBusy(true);
    try {
      const res = await fetch(path, { method: "DELETE" });
      if (!res.ok) await readError(res, `Clear failed (${res.status})`);
      setError(null);
      setHasImage(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      {hasImage ? (
        // A same-origin API byte stream, not a static asset next/image's optimizer has any
        // business rewriting.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${path}?v=${version}`}
          alt={`Signature for user ${userId}`}
          onError={() => setHasImage(false)}
          className="h-8 w-20 rounded border bg-white object-contain"
        />
      ) : (
        <span className="text-xs text-slate-400">No signature</span>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/bmp"
        onChange={onFileChosen}
        disabled={gate.disabled || busy}
        title={gate.title}
        className="w-32 text-xs disabled:cursor-not-allowed"
      />
      <button
        type="button"
        onClick={() => void clear()}
        disabled={gate.disabled || busy || !hasImage}
        title={gate.title}
        className="text-xs text-red-600 underline disabled:cursor-not-allowed disabled:text-slate-400"
      >
        Clear
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
