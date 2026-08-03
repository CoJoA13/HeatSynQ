"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";

// Local mirror of src/server/part-process-steps.ts's `RevisionDetail`/`StepRow`/`StepValueRow`,
// narrowed to what this READ-ONLY render needs.
type RevisionStepValue = { fieldDefId: string; label: string; unit: string | null; value: string };
type RevisionStep = {
  id: string; position: number; code: string; codeName: string; instruction: string;
  values: RevisionStepValue[];
};
type RevisionDetail = { revisionNumber: number; steps: RevisionStep[] };

type Status = "loading" | "ok" | "error";

/**
 * Read-only render of the order's LOCKED recipe (spec §5.3/§11) — no editing, no revision picker
 * (unlike ProcessStepsSection on the part page): the order locked exactly one revision at save
 * and that is the only one this order's paperwork ever describes, whatever the part's process
 * looks like today.
 *
 * Fetches `GET /api/orders/[id]/process` — Fix-wave R2 finding 7, replacing the original
 * `GET /api/parts/[id]/process/revisions/[n]` (task-14-brief.md's 2C-3 route). That route reads
 * the LIVE part (`getRevision`'s own liveness gate) and 404s "Part not found" the instant the
 * part is soft-deleted — legal once every order referencing it is voided (parts.ts's deletePart)
 * — which turned a voided order's own historical paperwork unreadable. The new route is gated
 * `orders.view` alone (no separate `processes.view` check here: this is an order-scoped read of
 * the order's own frozen recipe, not a live parts-process one, and every caller reaching this
 * component already holds `orders.view` — it is what loaded `order` in the first place,
 * page.tsx's own `if (!order) return …` gate) and reads the order's stored (partId,
 * revisionNumber) reference without gating on the part's current liveness
 * (`getLockedRevision`/`getRevisionContentUnchecked`, orders.ts / part-process-steps.ts).
 */
export function ProcessSection({ orderId }: { orderId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setStatus("loading");
    api<RevisionDetail>(`/api/orders/${orderId}/process`)
      .then((d) => { setDetail(d); setStatus("ok"); })
      .catch((e) => {
        setStatus("error");
        setMessage((e as Error).message);
      });
  }, [orderId]);

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Process</h2>

      {status === "loading" && <p className="text-sm text-slate-500">Loading…</p>}
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
