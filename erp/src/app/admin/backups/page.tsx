"use client";
// The Backups page (Phase 8C §6.2). Gated on `manage_backups`, production-only (the routes refuse
// the practice copy). Everything it shows comes from one guarded endpoint; it holds no business
// logic — the green rule lives in evaluateHealth (backups.ts), which is where it is tested.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { invalidateBackupBanner } from "@/components/BackupBanner";
import type { ArchiveInfo, BackupsView } from "@/lib/backup-constants";

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
  : `${n} B`;

const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

/**
 * Whether "Back up now" can be pressed, and what the tooltip says if not (#123).
 *
 * Hook-free and exported so tests/backups-page-state.test.ts can drive it directly — this repo has
 * no DOM test environment, and the established answer is to split the DECISION out of the component
 * (BackupBanner.tsx's `advanceBannerState`, bulk-grid.ts's `computeOrphanChurn`) rather than reach
 * for one.
 *
 * §5.16: a control that cannot work is visible and DISABLED with a tooltip naming why — never
 * hidden, and never enabled-but-doomed. On the practice copy the routes 403 with "Backups are
 * managed on the production copy only…", and the page used to keep an enabled button over it.
 *
 * `refusal` is the server's own sentence from ANY 403 on the view endpoint, and keying on the
 * status rather than on which CAUSE produced it is deliberate: `mustDo("manage_backups")` and
 * `assertNotPracticeDatabase()` are both reasons this page's actions cannot work, so one branch
 * handles both and the tooltip carries whichever sentence the server actually sent. Nothing here
 * reads the practice flag — §8 forbids that in a client component, which is also why `nav.ts` is
 * left alone and the nav entry stays (the ruling).
 */
export function runControlState(
  gate: { disabled: boolean; title?: string }, running: boolean, refusal: string | null,
): { disabled: boolean; title: string | undefined } {
  // The refusal wins the TOOLTIP even when the gate is also closed: it is the more specific fact,
  // and it is the one the operator can act on ("use the production copy") versus a generic
  // permission line.
  if (refusal !== null) return { disabled: true, title: refusal };
  return { disabled: gate.disabled || running, title: gate.title };
}

export default function BackupsPage() {
  const [view, setView] = useState<BackupsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  /**
   * The server's own sentence when the VIEW endpoint refuses this caller (#123) — set on any 403,
   * cleared on a successful load.
   *
   * On the practice copy the routes 403 with "Backups are managed on the production copy only…",
   * and the page went on rendering an enabled "Back up now" plus a `…` folder placeholder: a
   * control that can never work, presented as available (§5.16). It keys on the 403 itself rather
   * than on which CAUSE produced it, deliberately — `mustDo` and `assertNotPracticeDatabase` are
   * both reasons this page's actions cannot work, so one path handles both and the tooltip carries
   * whichever sentence the server actually sent. Nothing here reads the practice flag: §8 forbids
   * that in a client component, and `nav.ts` is left alone for the same reason (the ruling keeps the
   * nav entry).
   */
  const [refusal, setRefusal] = useState<string | null>(null);
  // The SHARED hook, never a hand-rolled /api/auth/me effect. Its own header names "reimplemented
  // rather than shared" as this repo's recurring defect shape, and it gets two things right that a
  // local copy reliably gets wrong: `permissions` stays `undefined` while in flight (so gateDo
  // keeps controls DISABLED rather than flashing them open and then locking), and a failed fetch
  // surfaces as `error` instead of being swallowed into `[]`, which is indistinguishable from a
  // real "no grants" account and would permanently disable every control with no explanation.
  const { permissions, error: permError } = usePermissions();

  const load = useCallback(async () => {
    const v = await api<BackupsView>("/api/admin/backups");
    setView(v);
    setRefusal(null);
    return v;
  }, []);

  useEffect(() => {
    load().catch((e) => {
      if (e instanceof ApiError && e.status === 403) setRefusal(e.message);
      setError(e instanceof ApiError ? e.message : "Could not read the backup folder.");
    });
  }, [load]);

  const gate = gateDo(permissions, "manage_backups");

  async function backUpNow() {
    setRunning(true);
    setError(null);
    try {
      await api<{ archive: ArchiveInfo }>("/api/admin/backups/run", { method: "POST" });
      // #124: the shell's staleness bar caches its health for REFRESH_MS, so without this the bar
      // stayed RED directly above a panel that had just gone green — the two contradicting each
      // other on one screen. The ordinary polling throttle is untouched; this is an explicit
      // "something happened" signal.
      //
      // Fired the instant the POST resolves, BEFORE the view refresh (Codex, PR #131). The backup
      // has already happened by then, so the banner's cached health is already wrong — and if
      // `load()` were to fail transiently we would fall into the catch, which retries it and can
      // turn the panel green while never reaching an invalidation placed after it. That recreates
      // the exact stale-red-over-green contradiction this is here to prevent.
      invalidateBackupBanner();
      await load();
    } catch (e) {
      // A FAILED attempt invalidates too (Codex, PR #131). `runBackupNow`'s `fail()` writes
      // `ok:false` to the status file, so the health the banner is holding is now stale in the RED
      // direction — and without this the page would render a red panel while the shell bar stayed
      // HIDDEN on its cached green until the throttle lapsed. That is #124's contradiction pointing
      // the other way, and the more dangerous direction of the two: a failure that does not surface.
      invalidateBackupBanner();
      // §5.13: refresh to server truth FIRST, then report — a reload after setError would wipe the
      // banner the operator needs to read.
      await load().catch(() => {});
      setError(e instanceof ApiError ? e.message : "The backup failed.");
    } finally {
      setRunning(false);
    }
  }

  const health = view?.health;
  const green = health?.state === "ok";
  const { disabled: runDisabled, title: runTitle } = runControlState(gate, running, refusal);

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Backups</h1>

      {/* The permissions failure folds in beside the page's own — a swallowed one would leave every
          control disabled with nothing on screen explaining why (usePermissions' documented rule). */}
      {(error ?? permError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permError}</p>
      )}

      {health && (
        <div
          className={`mb-4 rounded border px-4 py-3 ${
            green ? "border-green-300 bg-green-50 text-green-900"
                  : "border-red-300 bg-red-50 text-red-900"}`}
        >
          <div className="font-semibold">
            {green ? "Backups are up to date" : "Backups need attention"}
          </div>
          <div className="text-sm">{health.reason}</div>
          <div className="mt-1 text-xs opacity-80">
            {health.lastSuccessAt
              ? `Last successful backup: ${fmtWhen(health.lastSuccessAt)}`
              : "No successful backup on record."}
            {" · "}Threshold: {health.staleHours} hours
          </div>
        </div>
      )}

      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={backUpNow}
          disabled={runDisabled}
          title={runTitle}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {running ? "Backing up…" : "Back up now"}
        </button>
        {/* #123: no `…` placeholder. When the folder is unknown because the route refused us, the
            refusal above already says why — a lone ellipsis just reads as "still loading" forever. */}
        {view?.folder && (
          <span className="text-sm text-slate-600">
            Backup folder: <code className="rounded bg-slate-100 px-1">{view.folder}</code>
          </span>
        )}
      </div>

      <p className="mb-4 text-sm text-slate-600">
        Restoring is a deliberate terminal command, not a button — see the restore runbook in{" "}
        <code className="rounded bg-slate-100 px-1">erp/README.md</code>.
      </p>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1">Archive</th><th>Taken</th><th>Source</th><th>Size</th><th>Integrity</th>
          </tr>
        </thead>
        <tbody>
          {(view?.archives ?? []).map((a) => (
            <tr key={a.name} className="border-b">
              <td className="py-1 font-mono text-xs">{a.name}</td>
              <td>{fmtWhen(a.modifiedAt)}</td>
              <td>{a.source === "manual" ? "On demand" : "Nightly"}</td>
              <td>{fmtBytes(a.sizeBytes)}</td>
              <td className={a.integrityOk ? "text-green-700" : "text-red-700"}>
                {a.integrityOk ? "OK" : "CORRUPT"}
              </td>
            </tr>
          ))}
          {view && view.archives.length === 0 && (
            <tr><td colSpan={5} className="py-3 text-slate-500">No backup archives in this folder yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
