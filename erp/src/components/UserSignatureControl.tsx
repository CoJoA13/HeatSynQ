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
 * **THIS COMPONENT KEEPS NO COPY OF "does a signature exist".** `hasSignature` is rendered
 * directly, and every change — a local upload, a local clear, the `<img>`'s 404 belt — is reported
 * up through `onSignatureChange` so the PAGE's row is the one and only truth. Local state here is
 * `error`, `busy` and the cache-busting `version`: things the server has no opinion about.
 *
 * That shape was arrived at the hard way, and the history is the point (Phase-4 lesson 4 — when
 * three rounds land on one mechanism, the DESIGN is the finding). Three successive attempts to keep
 * a local `hasImage` in step with the prop were each wrong in a way the previous one could not see:
 *
 *   1. Seed once, never re-baseline. Justified with a keyed-remount hazard that is not reachable
 *      (a `${u.id}-${u.hasSignature}` key only remounts when the flag changes, so it would always
 *      re-seed FRESH). Wrong reason; and the rule itself missed every later server change.
 *   2. Seed once, "the page's flag is strictly behind us". True within one session only — another
 *      administrator's upload or clear makes the PROP the fresher value, and the pre-#160 code had
 *      been self-correcting that by accident, because it always rendered the `<img>` and let the
 *      404 tell it the truth. Removing that probe removed the correction with it.
 *   3. Adopt when the prop CHANGES (`lastSeen` compare). Misses a change that round-trips: upload
 *      locally (prop still `false`), another administrator clears, the list reloads `false` — equal
 *      to `lastSeen`, so nothing fires and a cached image shows indefinitely. The clear-then-upload
 *      inverse strands the placeholder the same way.
 *
 * Every one of those is the same bug: two copies of one fact, reconciled by a rule. Deleting the
 * second copy deletes the class — there is no longer any state that CAN diverge, so none of the
 * three scenarios above is expressible. The page's `TitleCell` keyed-remount precedent is still not
 * copied, and now for a plain reason: a remount would also discard `error`, `busy` and `version`,
 * which are genuinely this component's own.
 *
 * ONE residual, stated rather than hidden: `version` cache-busts only on a LOCAL upload, so if
 * another administrator REPLACES a signature (the flag stays `true` throughout), the browser may
 * keep serving the previously fetched bytes for this URL until a reload. Fixing that would mean
 * re-requesting every signature on every list load, which is exactly the cost #160 removed.
 *
 * `gate`: passed straight from the page's own `gateDo(perms, "manage_users")` (§5.16) — every
 * verb on this route requires that same special action, upload and clear both disabled with its
 * tooltip when it's missing, never hidden.
 */
export function UserSignatureControl(
  { userId, hasSignature, gate, onSignatureChange }:
    { userId: string; hasSignature: boolean; gate: Gate; onSignatureChange: (next: boolean) => void },
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // NO local copy of "does a signature exist" — see the docblock. `hasSignature` is rendered
  // directly and every change is reported up through `onSignatureChange`.
  const [version, setVersion] = useState(0); // cache-busts the <img> src after a local upload
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
      onSignatureChange(true);
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
      onSignatureChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      {hasSignature ? (
        // A same-origin API byte stream, not a static asset next/image's optimizer has any
        // business rewriting.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${path}?v=${version}`}
          alt={`Signature for user ${userId}`}
          onError={() => onSignatureChange(false)}
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
        disabled={gate.disabled || busy || !hasSignature}
        title={gate.title}
        className="text-xs text-red-600 underline disabled:cursor-not-allowed disabled:text-slate-400"
      >
        Clear
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
