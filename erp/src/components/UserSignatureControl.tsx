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
 * `hasSignature` (#160) is the users list's own flag, derived server-side from `signatureMimeType`
 * (listUsers, src/server/users.ts). It replaces what this docblock used to describe: there being no
 * existence flag to check, so the preview `<img>` was pointed at GET .../signature optimistically
 * and its 404 WAS the discovery mechanism. That cost one failed request per signature-less user on
 * every page load — the normal case for most of a shop's staff — which made a completely healthy
 * screen unable to pass any console/failed-request health gate (`npm run manual:capture`).
 * The `<img>` now renders only when there is something to fetch, and `onError` stays as the belt
 * for a race (a signature cleared in another tab between the list read and the image request).
 *
 * `hasSignature` SEEDS the state and is then adopted again whenever it actually CHANGES — see the
 * adopt-on-change block below, which carries the full reasoning. The page's `TitleCell` precedent
 * (remount via `key={`${u.id}-${u.title}`}`) is still not copied: a remount would also discard the
 * error banner, the busy flag and the cache-busting `version`, none of which the server has an
 * opinion about. Comparing one prop during render adopts the server's truth without throwing away
 * state the server does not own.
 *
 * This note has been wrong twice, so both corrections are recorded rather than overwritten. It
 * first claimed a keyed remount would reset a just-uploaded signature to `false`; that mechanism is
 * NOT reachable, since a `${u.id}-${u.hasSignature}` key only remounts when the flag changes and so
 * would always re-seed from the fresh value. It then claimed the page's flag is "strictly behind"
 * this component's state, which holds only within ONE session — another administrator's upload or
 * clear makes the prop the fresher value. The conclusion (do not remount) survived both; the
 * reasoning did not.
 *
 * `gate`: passed straight from the page's own `gateDo(perms, "manage_users")` (§5.16) — every
 * verb on this route requires that same special action, upload and clear both disabled with its
 * tooltip when it's missing, never hidden.
 */
export function UserSignatureControl(
  { userId, hasSignature, gate }: { userId: string; hasSignature: boolean; gate: Gate },
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Seeded from the list read (#160), not optimistically true; the <img>'s onError is now only
  // the race belt. See the docblock on why this is not re-baselined by a keyed remount.
  const [hasImage, setHasImage] = useState(hasSignature);
  // ADOPT-ON-CHANGE (Codex round 1 on PR #168). The React "adjust state when a prop changes"
  // idiom — compared during render, not in an effect, so there is no extra commit and no flash.
  //
  // Why it is needed, and why the docblock's "strictly behind" claim was too strong: it holds only
  // within one session. ANOTHER administrator can upload or clear this user's signature, and this
  // page reloads its list after any unrelated edit (title, role, active) — so the prop can arrive
  // NEWER than local state, and a seed-once control would show the stale placeholder or a cached
  // image indefinitely. The pre-#160 code self-corrected here by accident: it always rendered the
  // <img> and let the 404 tell it the truth, so every reload re-probed. Seeding from the flag
  // removed that probe, which removed the correction with it — this puts the correction back
  // deliberately instead.
  //
  // Local upload/clear move `hasImage` WITHOUT moving `hasSignature`, so `lastSeen` still matches
  // and nothing here fires: a local edit still wins over a server value that has not changed since.
  const [lastSeen, setLastSeen] = useState(hasSignature);
  if (hasSignature !== lastSeen) {
    setLastSeen(hasSignature);
    setHasImage(hasSignature);
  }
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
        accept="image/png,image/jpeg"
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
