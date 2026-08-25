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
 * **The URL carries a SERVER revision, and that is what makes the render-failure key correct (#171).**
 * `src` is `signatureSrc(userId, signatureRev)`, and `signatureRev` (User.signatureUpdatedAt, via
 * listUsers) MOVES whenever the stored image does — `setSignature` and `clearSignature` both stamp
 * it. So `brokenSrc`, keyed to that exact URL, retries by construction on ANY change: this browser's
 * upload, or ANOTHER administrator's clear-and-replace. There is no local counter and no prop-transition
 * rule to get wrong — the mistake rounds 1–3 kept making, and the exact hole rounds 4–5 left open:
 *
 *   - #171's headline: a preview that failed, then another administrator clears and re-uploads —
 *     the flag round-trips false→true but the SERVER revision is strictly newer, so on the next list
 *     load `src` is a new URL and this branch re-requests instead of showing "Preview unavailable"
 *     forever. (The heal lands when this browser next refetches the list — the same load that
 *     delivers the flag — not as a live cross-session push; there is no such push anywhere here.)
 *   - The residual an earlier version of this note stated rather than hid: another administrator
 *     REPLACING a signature (the flag stays `true` throughout) now also moves the revision, so the
 *     next list load fetches the new bytes instead of serving the previously fetched ones.
 *
 * `brokenSrc` does NOT retire (an earlier sketch on #171 hoped it could): a magic-byte-valid but
 * undecodable image can only be discovered by THIS browser's `<img> onError`, so the "Preview
 * unavailable" state is inherently local — the server cannot report it. Keying it to the
 * server-revisioned URL is precisely what turns that local state from a staleness trap into a
 * self-healing retry. A LOCAL upload cache-busts at once WITHOUT a per-session counter: the page
 * owns `signatureRev` and advances it optimistically beside `hasSignature` (`applySignatureMutation`,
 * page.tsx), so `src` moves even if the trailing reload fails; the reload then reconciles the rev to
 * the server's true stamp. That optimistic bump is the page's, not this component's — the same
 * single-owner discipline #160 established for the existence flag.
 *
 * The page's `TitleCell` keyed-remount precedent is still not copied: a remount would discard
 * `error`, `busy` and `brokenSrc`, all of which are genuinely this component's own.
 *
 * `gate`: passed straight from the page's own `gateDo(perms, "manage_users")` (§5.16) — every
 * verb on this route requires that same special action, upload and clear both disabled with its
 * tooltip when it's missing, never hidden.
 */

export type SignaturePreview =
  | { kind: "none" }
  | { kind: "broken" }
  | { kind: "image"; src: string };

/** The preview URL for a user's signature. `?v=` is a pure cache-bust token — the GET route ignores
 *  it and streams the CURRENT bytes — carrying the SERVER revision `signatureRev`
 *  (User.signatureUpdatedAt, surfaced by listUsers). The URL therefore changes on EVERY change to
 *  the stored image, this browser's OR another admin's, never on a merely-local counter (#171). */
export function signatureSrc(userId: string, signatureRev: number | null): string {
  return `/api/admin/users/${userId}/signature?v=${signatureRev ?? 0}`;
}

/** Pure render decision, split out for the same reason ReverseShipmentButton / advanceBannerState
 *  are (no DOM test env): the branch logic is unit-pinnable while the `<img> onError` click stays
 *  Playwright's. `brokenSrc` is compared to the CURRENT revisioned `src`, so a failure recorded at
 *  an older revision (or for another user) can never suppress a preview the server has since
 *  changed — the #171 fix, `tests/user-signature-control.test.tsx`. */
export function signaturePreview(
  { userId, hasSignature, signatureRev, brokenSrc }:
    { userId: string; hasSignature: boolean; signatureRev: number | null; brokenSrc: string | null },
): SignaturePreview {
  if (!hasSignature) return { kind: "none" };
  const src = signatureSrc(userId, signatureRev);
  if (brokenSrc === src) return { kind: "broken" };
  return { kind: "image", src };
}

export function UserSignatureControl(
  { userId, hasSignature, signatureRev, gate, onSignatureChange }:
    {
      userId: string; hasSignature: boolean; signatureRev: number | null; gate: Gate;
      onSignatureChange: (next: boolean) => void;
    },
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // NO local copy of "does a signature exist" — see the docblock. `hasSignature` is rendered
  // directly and every MUTATION is reported up through `onSignatureChange`.
  //
  // A RENDER failure, which is a different thing from a mutation and must not be reported up
  // (Codex round 5 — doing so was an unbounded request loop; see the docblock). Keyed to the exact
  // src that failed; because `src` carries the SERVER revision, a new upload or ANOTHER admin's
  // change produces a new URL and retries by construction, with no comparison rule to get wrong.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const path = `/api/admin/users/${userId}/signature`;
  const preview = signaturePreview({ userId, hasSignature, signatureRev, brokenSrc });

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
      // Report the mutation up: the page advances `signatureRev` optimistically (so `src` moves at
      // once, even if its reload fails) and then RELOADS to reconcile the rev to the server stamp —
      // replacing the old per-session `version` counter this component used to keep (#171).
      onSignatureChange(true);
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
      {preview.kind === "none" ? (
        <span className="text-xs text-slate-400">No signature</span>
      ) : preview.kind === "broken" ? (
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
          src={preview.src}
          alt={`Signature for user ${userId}`}
          onError={() => setBrokenSrc(preview.src)}
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
