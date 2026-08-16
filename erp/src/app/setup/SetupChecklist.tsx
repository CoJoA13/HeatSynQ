"use client";
// The first-run setup checklist (Phase 8B §5.5). A CLIENT component against the guarded
// /api/setup/readiness (the Phase 1 precedent, the ReportsIndex.tsx clone): gated admin.view —
// without it the page says why (§5.16 / GateNotice), never a silently empty list. Every step
// deep-links to an EXISTING admin screen; the only NEW mutation is PUT /api/setup/state, which
// records the two non-derivable facts (numbers confirmed, checklist dismissed).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { GateNotice } from "@/lib/report-ui";

type SetupStep = { key: string; label: string; href: string; complete: boolean; blocking: boolean };
type Readiness = { steps: SetupStep[]; dismissed: boolean; complete: boolean };

export function SetupChecklist() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "admin.view");
  const [data, setData] = useState<Readiness | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allowed = viewGate.allowed;
  const load = useCallback(() => {
    if (!allowed) return;
    api<Readiness>("/api/setup/readiness")
      .then((d) => { setData(d); setLoaded(true); })
      .catch((e) => { setError((e as Error).message); setLoaded(true); });
  }, [allowed]);
  useEffect(load, [load]);

  async function putState(body: { confirmNumbers?: boolean; dismiss?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      await api<unknown>("/api/setup/state", { method: "PUT", body: JSON.stringify(body) });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (permsError || perms === undefined || !viewGate.allowed) {
    return (
      <GateNotice
        header={<h1 className="mb-4 text-2xl font-semibold">Setup</h1>}
        permsError={permsError}
        loading={perms === undefined}
        deniedMessage={viewGate.title ?? "You do not have permission to view setup."}
      />
    );
  }

  return (
    <div className="p-6">
      <h1 className="mb-1 text-2xl font-semibold">Finish setting up</h1>
      <p className="mb-4 text-sm text-slate-500">
        Complete these steps to configure the system. The steps marked <span className="font-medium">required</span>{" "}
        must be done before you can enter orders.
      </p>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {!loaded && <p className="text-sm text-slate-500">Loading…</p>}
      {loaded && data && (
        <>
          <ul className="space-y-2">
            {data.steps.map((s) => (
              <li key={s.key} className="flex items-center justify-between rounded border bg-white p-3">
                <span className="flex items-center gap-2">
                  <span aria-hidden className={s.complete ? "text-green-600" : "text-slate-300"}>
                    {s.complete ? "✓" : "○"}
                  </span>
                  <span className={s.complete ? "text-slate-500 line-through" : ""}>{s.label}</span>
                  {s.blocking && !s.complete && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">required</span>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  {s.key === "numbers" && !s.complete && (
                    <button type="button" disabled={busy} onClick={() => void putState({ confirmNumbers: true })}
                            className="rounded border px-2 py-1 text-sm">
                      Mark confirmed
                    </button>
                  )}
                  {!s.complete && (
                    <Link href={s.href} className="text-sm text-blue-700 underline">Set up</Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <button type="button" disabled={busy || data.dismissed} onClick={() => void putState({ dismiss: true })}
                    className="rounded border px-3 py-1 text-sm text-slate-600">
              {data.dismissed ? "Checklist dismissed" : "Dismiss checklist"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
