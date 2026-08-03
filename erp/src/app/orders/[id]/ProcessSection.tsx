"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";

// Local mirror of src/server/part-process-steps.ts's `RevisionDetail`/`StepRow`/`StepValueRow`,
// narrowed to what this READ-ONLY render needs — the OrderLineCard.tsx precedent (entry page),
// which fetches the identical endpoint for its own lead-part preview.
type RevisionStepValue = { fieldDefId: string; label: string; unit: string | null; value: string };
type RevisionStep = {
  id: string; position: number; code: string; codeName: string; instruction: string;
  values: RevisionStepValue[];
};
type RevisionDetail = { revisionNumber: number; steps: RevisionStep[] };

type Status = "loading" | "ok" | "denied" | "error";

/**
 * Read-only render of the order's LOCKED recipe (spec §5.3/§11) — no editing, no revision picker
 * (unlike ProcessStepsSection on the part page): the order locked exactly one revision at save
 * and that is the only one this order's paperwork ever describes, whatever the part's process
 * looks like today. Fetches `GET /api/parts/[id]/process/revisions/[n]` — the 2C-3 route, no new
 * endpoint (task-14-brief.md).
 */
export function ProcessSection({
  leadPartId, revisionNumber, processesGate,
}: {
  leadPartId: string;
  /** Null only if the create-time invariant were somehow violated — defensive, not expected. */
  revisionNumber: number | null;
  processesGate: Gate;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (revisionNumber === null) { setStatus("error"); setMessage("This order has no locked revision on file."); return; }
    if (!processesGate.allowed) { setStatus("denied"); return; }
    setStatus("loading");
    api<RevisionDetail>(`/api/parts/${leadPartId}/process/revisions/${revisionNumber}`)
      .then((d) => { setDetail(d); setStatus("ok"); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) { setStatus("denied"); return; }
        setStatus("error");
        setMessage((e as Error).message);
      });
  }, [leadPartId, revisionNumber, processesGate.allowed]);

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Process</h2>

      {status === "loading" && <p className="text-sm text-slate-500">Loading…</p>}
      {status === "denied" && <p className="text-sm text-slate-500">Requires processes.view.</p>}
      {status === "error" && <p className="text-sm text-red-700">{message ?? "Could not load the locked process."}</p>}

      {status === "ok" && detail && (
        <>
          <p className="mb-3 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            Rev {detail.revisionNumber} · locked at order save
          </p>
          {detail.steps.length === 0 ? (
            <p className="text-sm text-slate-500">This revision has no steps.</p>
          ) : (
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              {detail.steps.map((s) => (
                <li key={s.id}>
                  <span className="font-medium">{s.code} — {s.codeName}</span>
                  {s.instruction && <span className="text-slate-600">: {s.instruction}</span>}
                  {s.values.length > 0 && (
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
                      {s.values.map((v) => (
                        <li key={v.fieldDefId}>{v.label}: {v.value}{v.unit ? ` ${v.unit}` : ""}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
