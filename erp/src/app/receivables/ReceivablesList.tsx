"use client";
// The A/R batch worklist (design spec §11 "/receivables" — "a batch worklist"; task-13-brief.md
// Step 1). The `InvoicingList.tsx` "Ready to invoice" + filtered list shape, scaled down to one
// section: a "New batch" form and a status-filterable table of deposit batches, each row linking
// to its own `/receivables/batches/[id]` detail page.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import {
  RECEIPT_BATCH_STATUSES, RECEIPT_BATCH_STATUS_LABELS, type ReceiptBatchStatusValue,
} from "@/lib/ar-constants";

// Local mirror of src/server/receipts.ts's `BatchListRow` — not imported from src/server/**
// (CLAUDE.md "Constraints that will bite you": a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle).
type BatchListRow = {
  id: string; batchNumber: number; depositDate: string; controlTotal: number | null;
  status: ReceiptBatchStatusValue; enteredTotal: number; balance: number;
};

type StatusFilter = ReceiptBatchStatusValue | "";

export function ReceivablesList() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();
  const createGate = gate(perms, "receivables.create");

  // ---------------------------------------------------------------------------------------
  // The worklist — defaults to OPEN (the batches still needing work), filterable to POSTED or
  // every live batch. `?status=` mirrors `listBatches`'s own filter one-for-one (receipts.ts).
  // ---------------------------------------------------------------------------------------
  const [status, setStatus] = useState<StatusFilter>("OPEN");
  const [batches, setBatches] = useState<BatchListRow[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15) — a failed fetch must say
  // so, never render as a genuinely empty, healthy worklist.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useLatest();

  const load = useCallback(async () => {
    const t = latest.next();
    let data: BatchListRow[];
    try {
      data = await api<BatchListRow[]>(`/api/receivables/batches${status ? `?status=${status}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setBatches(data);
    setError(null);
    setLoaded(true);
  }, [status, latest]);
  useEffect(() => { void load(); }, [load]);

  // ---------------------------------------------------------------------------------------
  // New batch — deposit date + optional control total (task-13-brief.md Step 1). On success,
  // navigate straight to the new batch's own page — the `InvoiceDetail.tsx` `raiseCredit`
  // `router.push` precedent (create a resource, land on its detail rather than the list).
  // ---------------------------------------------------------------------------------------
  const [depositDate, setDepositDate] = useState("");
  const [controlTotal, setControlTotal] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function createBatch() {
    if (!depositDate) { setCreateError("Deposit date is required."); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const batch = await api<{ id: string }>("/api/receivables/batches", {
        method: "POST",
        body: JSON.stringify({
          depositDate, controlTotal: controlTotal.trim() === "" ? null : controlTotal,
        }),
      });
      router.push(`/receivables/batches/${batch.id}`);
    } catch (e) {
      setCreateError((e as Error).message);
      setCreating(false);
    }
  }

  const createTitle = !createGate.allowed ? createGate.title : creating ? "Creating…" : undefined;

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Receivables</h1>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      {/* ------------------------------- New batch ------------------------------- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">New batch</h2>
        {createError && <p className="mb-2 text-sm text-red-700">{createError}</p>}
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Deposit date
            <input type="date" value={depositDate} disabled={!createGate.allowed} title={createGate.title}
                   onChange={(e) => setDepositDate(e.target.value)}
                   className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100" />
          </label>
          <label className="block">
            Control total (optional)
            <input value={controlTotal} inputMode="decimal" disabled={!createGate.allowed} title={createGate.title}
                   onChange={(e) => setControlTotal(e.target.value)} placeholder="e.g. 1250.00"
                   className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100" />
          </label>
          <button onClick={() => void createBatch()} disabled={createTitle !== undefined} title={createTitle}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {creating ? "Creating…" : "New batch"}
          </button>
        </div>
      </section>

      {/* -------------------------------- Batches -------------------------------- */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">Batches</h2>
          <label className="text-sm text-slate-600">
            Status{" "}
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}
                    className="rounded border px-2 py-1">
              {RECEIPT_BATCH_STATUSES.map((s) => (
                <option key={s} value={s}>{RECEIPT_BATCH_STATUS_LABELS[s]}</option>
              ))}
              <option value="">All</option>
            </select>
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full rounded border bg-white text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">Batch #</th>
                <th className="p-2">Deposit date</th>
                <th className="p-2">Status</th>
                <th className="p-2">Control total</th>
                <th className="p-2">Entered</th>
                <th className="p-2">Balance</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-t">
                  <td className="p-2 font-mono">
                    <Link href={`/receivables/batches/${b.id}`} className="text-blue-700 underline">
                      {b.batchNumber}
                    </Link>
                  </td>
                  <td className="p-2">{b.depositDate}</td>
                  <td className="p-2">{RECEIPT_BATCH_STATUS_LABELS[b.status]}</td>
                  <td className="p-2">{b.controlTotal === null ? "—" : b.controlTotal.toFixed(2)}</td>
                  <td className="p-2">{b.enteredTotal.toFixed(2)}</td>
                  <td className="p-2">{b.balance.toFixed(2)}</td>
                </tr>
              ))}
              {batches.length === 0 && loaded && !error && (
                <tr><td colSpan={6} className="p-4 text-center text-slate-400">No batches</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
