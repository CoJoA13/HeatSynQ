"use client";
// The /reports index (Phase 8A Task 0, spec §4) — the landing page for every report, closing the
// dead 404 the nav's Reports entry used to hit. A CLIENT component against the guarded /api/reports
// (the Phase 1 precedent: a server page that fetches must call requireUser itself, so a client
// component against a guarded API sidesteps that rule). Gated on reports.view — without it the page
// says why (§5.16), never a silently empty list, mirroring AgingReport.tsx.
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import type { ReportEntry } from "@/lib/report-registry";

export function ReportsIndex() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "reports.view");
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15): a failed fetch must say so,
  // never render as a genuinely empty, healthy index.
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowed = viewGate.allowed;
  useEffect(() => {
    if (!allowed) return;
    api<ReportEntry[]>("/api/reports")
      .then((data) => { setReports(data); setLoaded(true); })
      .catch((e) => { setError((e as Error).message); setLoaded(true); });
  }, [allowed]);

  // §5.16: a caller without reports.view sees the page saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <div className="p-6">
        <h1 className="mb-4 text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view reports."}</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Reports</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {reports.length === 0 && loaded && !error ? (
        <p className="text-sm text-slate-500">No reports are available to you yet.</p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.key} className="rounded border bg-white p-3">
              <a href={r.href} className="text-blue-700 underline">{r.label}</a>
              {r.description && <p className="mt-1 text-sm text-slate-500">{r.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
