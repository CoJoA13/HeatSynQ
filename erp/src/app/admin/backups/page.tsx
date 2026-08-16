"use client";
// The Backups page (Phase 8C §6.2). Gated on `manage_backups`, production-only (the routes refuse
// the practice copy). Everything it shows comes from one guarded endpoint; it holds no business
// logic — the green rule lives in evaluateHealth (backups.ts), which is where it is tested.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import type { ArchiveInfo, BackupsView } from "@/lib/backup-constants";

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
  : `${n} B`;

const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

export default function BackupsPage() {
  const [view, setView] = useState<BackupsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
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
    return v;
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiError ? e.message : "Could not read the backup folder."));
  }, [load]);

  const gate = gateDo(permissions, "manage_backups");

  async function backUpNow() {
    setRunning(true);
    setError(null);
    try {
      await api<{ archive: ArchiveInfo }>("/api/admin/backups/run", { method: "POST" });
      await load();
    } catch (e) {
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
          disabled={gate.disabled || running}
          title={gate.title}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {running ? "Backing up…" : "Back up now"}
        </button>
        <span className="text-sm text-slate-600">
          Backup folder: <code className="rounded bg-slate-100 px-1">{view?.folder ?? "…"}</code>
        </span>
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
