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
 * The `<img>` now renders only when there is something to fetch.
 *
 * **TWO KINDS OF EVENT, AND THEY MUST NOT BE CONFLATED** — this is the whole design, and it took
 * five review rounds to see it:
 *
 *   - A **MUTATION** (upload or clear succeeded). The server's answer changed. Reported up through
 *     `onSignatureChange`; the PAGE's row is the one and only copy of "does a signature exist".
 *     This component keeps none.
 *   - A **RENDER FAILURE** (`<img> onError`). The server's answer did NOT change — this browser
 *     could not display these bytes. Handled locally in `brokenSrc`, reported to nobody.
 *
 * The history, because each fix was correct about the defect in front of it and created the next
 * (Phase-4 lesson 4: when successive rounds keep landing on one mechanism, the DESIGN is the
 * finding):
 *
 *   1. Seed a local `hasImage` once, never re-baseline — justified by a keyed-remount hazard that
 *      is not even reachable, and blind to every later server change.
 *   2. Seed once, "the page's flag is strictly behind us" — true within ONE session; another
 *      administrator's upload or clear makes the prop the fresher value. (The pre-#160 code had
 *      been self-correcting this by accident, by always rendering the `<img>` and letting the 404
 *      speak. Removing that wasteful probe removed the correction with it.)
 *   3. Adopt when the prop CHANGES — misses a change that ROUND-TRIPS: upload locally (prop still
 *      `false`), another administrator clears, the list reloads `false`, equal to the last seen
 *      value, so nothing fires and a cached image shows forever.
 *   4. Lift the state away entirely — right, but the lifted write then sat outside the page's
 *      `useLatest` load discipline and an in-flight list load could put the row back.
 *   5. Reload after the write — right, but `onError` was still routed through the SAME callback, so
 *      a genuinely undecodable image (upload validation checks magic bytes, not decodability) set
 *      the row false, reloaded, got `true` back, remounted, errored again: an unbounded loop.
 *
 * 1–3 were one bug (two copies of a fact, reconciled by a rule). 4–5 were a second (one channel
 * carrying two meanings). Splitting the channel is what finally makes both unrepresentable: a
 * render failure cannot move server state, and a mutation cannot be undone by a stale read.
 *
 * `brokenSrc` is keyed to the exact URL that failed, not a boolean, so a LOCAL upload yields a new
 * URL (`version` bumps) and retries by construction — no staleness rule to get wrong, which is the
 * mistake rounds 1–3 kept making.
 *
 * **That does NOT extend to a server-side change, and an earlier draft of this note wrongly said it
 * did** (caught in review). The URL carries only the local `version` counter, so if a preview fails
 * and ANOTHER administrator then clears and re-uploads, the flag round-trips false→true while the
 * URL stays identical — and this branch keeps showing "Preview unavailable" without ever
 * re-requesting. It needs a corrupt image plus two other-session mutations to reach, and a reload
 * clears it. Filed rather than patched, because the honest fix is a server-side revision in the URL
 * (which `listUsers` does not yet expose) and this component has already taken five rounds of
 * local rules that each looked right and were not.
 *
 * The page's `TitleCell` keyed-remount precedent is still not copied: a remount would discard
 * `error`, `busy`, `version` and `brokenSrc`, all of which are genuinely this component's own.
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
  // directly and every MUTATION is reported up through `onSignatureChange`.
  const [version, setVersion] = useState(0); // cache-busts the <img> src after a local upload
  // A RENDER failure, which is a different thing from a mutation and must not be reported up
  // (Codex round 5 — doing so was an unbounded request loop; see the docblock). Keyed to the exact
  // src that failed, so a new upload or a server-side change produces a new URL and retries by
  // construction, with no comparison rule to get wrong.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const path = `/api/admin/users/${userId}/signature`;
  const src = `${path}?v=${version}`;

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
      {!hasSignature ? (
        <span className="text-xs text-slate-400">No signature</span>
      ) : brokenSrc === src ? (
        // The server HAS a signature; this browser could not render these bytes. Saying "No
        // signature" here would be a lie, and Clear stays enabled because there is something to
        // clear.
        <span className="text-xs text-amber-700" title="The stored image could not be displayed.">
          Preview unavailable
        </span>
      ) : (
        // A same-origin API byte stream, not a static asset next/image's optimizer has any
        // business rewriting.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={`Signature for user ${userId}`}
          onError={() => setBrokenSrc(src)}
          className="h-8 w-20 rounded border bg-white object-contain"
        />
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
