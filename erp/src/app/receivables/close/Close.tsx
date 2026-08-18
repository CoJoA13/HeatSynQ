"use client";
// The month-end close + GL-export screen (Task 8, P5C §4.1/§4.3/§7). Reachability-critical: Phase
// 5B shipped a deliverable API-only (owner-flagged lesson, docs/history/2026-08-08-phase-5b-
// accounts-receivable.md) — every close/export capability Tasks 5-7 built must be reachable from
// here. Modelled on AgingReport.tsx (guarded `api()` fetch + `useLatest()` + `gate(perms, ...)`)
// and Statements.tsx (mutation gate shape, disabled-with-tooltip buttons, a refresh counter that
// re-pulls both the schedule and the closed-periods list after every mutation).
//
// Consumes: GET .../close/preliminary?year=&month=, GET .../close/readiness?year=&month=
// (fetched together for the SAME month so the readiness panel and the Export button's disabled
// count can never disagree — both read the identical period window `exportClose` refuses on),
// GET .../close/readiness/export?year=&month= (plain <a href>, the aging/export precedent),
// GET .../close (Task 8's own gap fill — nothing listed closed periods + their batches before
// this), POST .../close, POST .../close/[id]/reopen, POST .../close/[id]/export, and
// GET .../close/export/[batchId]/file|register (plain <a href> downloads — cookie-authenticated
// GETs, same as the aging Excel export and the statement documents list).
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gate, gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { api } from "@/lib/fetcher";
import { todayDateOnly } from "@/lib/business-days";
import { ReceivablesNav } from "../ReceivablesNav";

// ---------------------------------------------------------------------------------------------
// Local mirrors of src/server/close-periods.ts's `ContinuitySchedule`/`PreliminaryReport`/
// `ClosePeriodDetail`/`ClosePeriodListItem` and src/server/gl-mapping.ts's `ReadinessGap` — never
// imported from src/server/** (CLAUDE.md: a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle).
// ---------------------------------------------------------------------------------------------

type ContinuitySchedule = {
  beginningAr: number; invoicedTotal: number; creditTotal: number; paymentTotal: number;
  discountTotal: number; writeOffTotal: number; endingAr: number; agingEndingAr: number; variance: number;
};
type PreliminaryReport = {
  year: number; month: number; schedule: ContinuitySchedule;
  unpostedBatchCount: number; alreadyClosed: boolean;
};
type ReadinessGap = { kind: string; id: string | null; label: string; href: string };
type ExportBatchSummary = { id: string; exportNumber: number; emittedAt: string; fileName: string };
type ClosePeriodListItem = ContinuitySchedule & {
  id: string; year: number; month: number; status: string; closedAt: string;
  // #88: server-derived broken-chain flag — this CLOSED month's frozen beginning no longer equals
  // the prior month's frozen ending. Flag only; the operator re-closes the month to re-chain.
  chainBroken: boolean;
  priorEndingAr: number | null;
  exportBatches: ExportBatchSummary[];
};
type ClosePeriodDetail = ContinuitySchedule & { id: string; year: number; month: number; status: string };

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function periodLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** Defaults the picker to the most recently COMPLETED month — the one an operator closing books
 *  at the start of a new month is actually here for, not the still-open current month. */
function defaultPeriod(): { year: number; month: number } {
  const today = todayDateOnly();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1; // 1-based
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

/**
 * A CLIENT-SIDE HINT ONLY, mirroring close-periods.ts's `priorEndingAr` genesis rule (spec §4.1,
 * ruling 5): the immediately-prior month must be CLOSED, UNLESS nothing strictly earlier is
 * closed either (a legitimate genesis close). The server re-derives and enforces this
 * independently under its own lock — this only decides whether the Close button shows a reason
 * up front instead of the operator discovering it from a 409 after clicking.
 */
function priorMonthOk(periods: ClosePeriodListItem[], year: number, month: number): boolean {
  const py = month === 1 ? year - 1 : year;
  const pm = month === 1 ? 12 : month - 1;
  const prior = periods.find((p) => p.year === py && p.month === pm);
  if (prior) return prior.status === "CLOSED";
  return !periods.some((p) => p.status === "CLOSED" && (p.year < year || (p.year === year && p.month < month)));
}

function ClosePeriodsScreen() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "receivables.view");
  // Close and export both require receivables.edit on top of their own dangerous special — one
  // gate covers the shared half, so it isn't recomputed per button.
  const editGate = gate(perms, "receivables.edit");
  const closeDoGate = gateDo(perms, "close_ar_period");
  const exportDoGate = gateDo(perms, "run_qbo_export");
  const viewAllowed = viewGate.allowed;

  // `?year=&month=` preselects — a readiness "Fix" link (e.g. /admin/billing) sends the operator
  // away from this screen; round-tripping the period in the URL means Back returns to the same
  // month instead of resetting to the default. Read once; the picker below owns the state after.
  const searchParams = useSearchParams();
  const initial = defaultPeriod();
  const [year, setYear] = useState(() => {
    const y = Number(searchParams.get("year"));
    return Number.isInteger(y) && y >= 2000 ? y : initial.year;
  });
  const [month, setMonth] = useState(() => {
    const m = Number(searchParams.get("month"));
    return Number.isInteger(m) && m >= 1 && m <= 12 ? m : initial.month;
  });

  // Bumped by every successful close/reopen/export so the schedule, readiness, and closed-periods
  // list all re-pull without a page reload (the Statements.tsx `docsRefresh` precedent).
  const [refresh, setRefresh] = useState(0);

  // ---- Preliminary schedule + readiness gap list, fetched together for the SAME month ----
  const [preliminary, setPreliminary] = useState<PreliminaryReport | null>(null);
  const [readinessGaps, setReadinessGaps] = useState<ReadinessGap[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useLatest();

  const load = useCallback(async () => {
    if (!viewAllowed) return;
    const t = latest.next();
    let prelim: PreliminaryReport;
    let gaps: ReadinessGap[];
    try {
      [prelim, gaps] = await Promise.all([
        api<PreliminaryReport>(`/api/receivables/close/preliminary?year=${year}&month=${month}`),
        api<ReadinessGap[]>(`/api/receivables/close/readiness?year=${year}&month=${month}`),
      ]);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setPreliminary(prelim);
    setReadinessGaps(gaps);
    setError(null);
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refresh` triggers a re-pull; unused in the body (Statements.tsx `docsRefresh` precedent)
  }, [year, month, viewAllowed, latest, refresh]);
  useEffect(() => { void load(); }, [load]);

  // ---- Closed periods + their export batches (Task 8's own gap fill) ----
  const [closedPeriods, setClosedPeriods] = useState<ClosePeriodListItem[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const listLatest = useLatest();

  const loadClosed = useCallback(async () => {
    if (!viewAllowed) return;
    const t = listLatest.next();
    let data: ClosePeriodListItem[];
    try {
      data = await api<ClosePeriodListItem[]>("/api/receivables/close");
    } catch (e) {
      if (listLatest.isCurrent(t)) { setListError((e as Error).message); setListLoaded(true); }
      return;
    }
    if (!listLatest.isCurrent(t)) return;
    setClosedPeriods(data);
    setListError(null);
    setListLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refresh` triggers a re-pull; unused in the body
  }, [viewAllowed, listLatest, refresh]);
  useEffect(() => { void loadClosed(); }, [loadClosed]);

  // ---- Close ----
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  async function doClose() {
    setClosing(true);
    setCloseError(null);
    try {
      await api<ClosePeriodDetail>("/api/receivables/close", {
        method: "POST", body: JSON.stringify({ year, month }),
      });
      setRefresh((n) => n + 1);
    } catch (e) {
      setCloseError((e as Error).message);
    } finally {
      setClosing(false);
    }
  }

  // ---- Reopen (per closed-period row) ----
  const [reopenError, setReopenError] = useState<string | null>(null);
  async function doReopen(id: string, label: string) {
    if (!confirm(`Reopen ${label}? Postings will be allowed into it again until it is re-closed.`)) return;
    const reason = prompt("Reason for reopening (required):");
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setReopenError("A reason is required to reopen a period"); return; }
    setReopenError(null);
    try {
      await api(`/api/receivables/close/${id}/reopen`, { method: "POST", body: JSON.stringify({ reason }) });
      setRefresh((n) => n + 1);
    } catch (e) {
      setReopenError((e as Error).message);
    }
  }

  // ---- Export to GL (per closed-period row) ----
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  async function doExport(id: string) {
    setExportingId(id);
    setExportError(null);
    try {
      await api(`/api/receivables/close/${id}/export`, { method: "POST" });
      setRefresh((n) => n + 1);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExportingId(null);
    }
  }

  // §5.16: a caller without receivables.view sees the page saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <div className="p-6">
        <ReceivablesNav />
        <h1 className="mb-4 text-2xl font-semibold">Month-End Close</h1>
        <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view A/R close."}</p>
      </div>
    );
  }

  const schedule = preliminary?.schedule ?? null;
  const varianceNonZero = !schedule || schedule.variance !== 0;
  const priorOk = priorMonthOk(closedPeriods, year, month);

  const closeTitle = !editGate.allowed ? editGate.title
    : !closeDoGate.allowed ? closeDoGate.title
      : !loaded ? "Loading…"
        : varianceNonZero ? `Variance must be zero to close (currently ${schedule ? schedule.variance.toFixed(2) : "?"})`
          : !priorOk ? "The prior month must be closed first"
            : closing ? "Closing…" : undefined;

  const query = `year=${year}&month=${month}`;

  return (
    <div className="p-6">
      <ReceivablesNav />
      <h1 className="mb-4 text-2xl font-semibold">Month-End Close</h1>

      {(error ?? permsError ?? listError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError ?? listError}</p>
      )}
      {closeError && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{closeError}</p>}
      {reopenError && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{reopenError}</p>}
      {exportError && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{exportError}</p>}

      {/* ---- Period picker + Close ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Period</h2>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Year
            <input type="number" value={year}
                   onChange={(e) => { const v = Number(e.target.value); if (Number.isInteger(v)) setYear(v); }}
                   className="mt-1 block w-24 rounded border px-2 py-1" />
          </label>
          <label className="block">
            Month
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
                    className="mt-1 block rounded border px-2 py-1">
              {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
            </select>
          </label>
          <button onClick={() => void doClose()} disabled={closeTitle !== undefined} title={closeTitle}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {closing ? "Closing…" : "Close period"}
          </button>
        </div>
        {preliminary?.alreadyClosed && (
          <p className="mt-2 text-sm text-amber-700">This period is already closed — closing again re-freezes its schedule.</p>
        )}
        {!!preliminary && preliminary.unpostedBatchCount > 0 && (
          <p className="mt-2 text-sm text-amber-700">
            {preliminary.unpostedBatchCount} open receipt batch{preliminary.unpostedBatchCount === 1 ? "" : "es"} dated
            in this month {preliminary.unpostedBatchCount === 1 ? "is" : "are"} not yet posted — post first if it belongs in this close.
          </p>
        )}
      </section>

      {/* ---- Continuity schedule ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Continuity schedule — {periodLabel(year, month)}</h2>
        {!loaded && !error && <p className="text-sm text-slate-500">Loading…</p>}
        {schedule && (
          <table className="w-full max-w-md text-sm">
            <tbody>
              <tr><td className="py-1">Beginning A/R</td><td className="py-1 text-right">{schedule.beginningAr.toFixed(2)}</td></tr>
              <tr><td className="py-1">+ Invoiced</td><td className="py-1 text-right">{schedule.invoicedTotal.toFixed(2)}</td></tr>
              <tr><td className="py-1">− Credits</td><td className="py-1 text-right">{schedule.creditTotal.toFixed(2)}</td></tr>
              <tr><td className="py-1">− Payments</td><td className="py-1 text-right">{schedule.paymentTotal.toFixed(2)}</td></tr>
              <tr><td className="py-1">− Discounts</td><td className="py-1 text-right">{schedule.discountTotal.toFixed(2)}</td></tr>
              <tr><td className="py-1">− Write-offs</td><td className="py-1 text-right">{schedule.writeOffTotal.toFixed(2)}</td></tr>
              <tr className="border-t font-medium"><td className="py-1">= Ending A/R</td><td className="py-1 text-right">{schedule.endingAr.toFixed(2)}</td></tr>
              <tr>
                <td className="py-1 text-slate-600">Aging ending A/R (independent check)</td>
                <td className="py-1 text-right text-slate-600">{schedule.agingEndingAr.toFixed(2)}</td>
              </tr>
              <tr className={schedule.variance !== 0 ? "font-medium text-red-700" : "text-emerald-700"}>
                <td className="py-1">Variance</td>
                <td className="py-1 text-right">{schedule.variance.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {/* ---- Readiness ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">GL-export readiness</h2>
        {readinessGaps.length === 0 ? (
          <p className="text-sm text-emerald-700">No GL account gaps for this period — ready to export once closed.</p>
        ) : (
          <>
            <ul className="mb-2 list-inside list-disc text-sm">
              {readinessGaps.map((g, i) => (
                <li key={`${g.kind}-${g.id ?? i}`}>
                  {g.label} — <a href={g.href} className="text-blue-700 underline">Fix</a>
                </li>
              ))}
            </ul>
            <a href={`/api/receivables/close/readiness/export?${query}`} className="text-sm text-blue-700 underline">
              Export gap list to Excel
            </a>
          </>
        )}
      </section>

      {/* ---- Closed periods ---- */}
      <section className="rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Closed periods</h2>
        {!listLoaded && !listError && <p className="text-sm text-slate-500">Loading…</p>}
        {listLoaded && closedPeriods.length === 0 && (
          <p className="text-sm text-slate-500">No period has been closed yet.</p>
        )}
        {closedPeriods.map((p) => {
          const isSelected = p.year === year && p.month === month;
          // The gap count is only known-fresh for the period under the picker above (the SAME
          // fetch the Close button's own variance check reads) — a historical row's gap count
          // would need its own readiness fetch, which this screen deliberately doesn't do N times
          // over. Any real gap on a non-selected row still surfaces: `exportClose` refuses (409)
          // and the message lands in the error banner.
          const gapCount = isSelected ? readinessGaps.length : 0;
          const exportTitle = !editGate.allowed ? editGate.title
            : !exportDoGate.allowed ? exportDoGate.title
              : p.status !== "CLOSED" ? "Must be closed (not reopened) to export"
                : gapCount > 0 ? `${gapCount} GL account gap${gapCount === 1 ? "" : "s"} must be resolved first`
                  : exportingId === p.id ? "Exporting…" : undefined;
          const reopenTitle = !editGate.allowed ? editGate.title
            : !closeDoGate.allowed ? closeDoGate.title
              : p.status !== "CLOSED" ? "Already reopened" : undefined;
          return (
            <div key={p.id} className="mb-3 rounded border p-3 text-sm last:mb-0">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{periodLabel(p.year, p.month)}</span>{" "}
                  <span className={`rounded px-1.5 py-0.5 text-xs ${p.status === "CLOSED" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                    {p.status}
                  </span>{" "}
                  {p.chainBroken && (
                    <>
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800">CHAIN BROKEN</span>{" "}
                    </>
                  )}
                  <span className="text-slate-500">closed {new Date(p.closedAt).toLocaleString()}</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => void doReopen(p.id, periodLabel(p.year, p.month))}
                          disabled={reopenTitle !== undefined} title={reopenTitle}
                          className="rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:text-slate-400">
                    Reopen
                  </button>
                  <button onClick={() => void doExport(p.id)} disabled={exportTitle !== undefined} title={exportTitle}
                          className="rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:text-slate-400">
                    {exportingId === p.id ? "Exporting…" : "Export to GL"}
                  </button>
                </div>
              </div>
              <p className="text-slate-600">
                Beginning {p.beginningAr.toFixed(2)} · Ending {p.endingAr.toFixed(2)} · Variance {p.variance.toFixed(2)}
              </p>
              {p.chainBroken && (
                <p className="text-red-700">
                  {/* Three flagged shapes, each named with its real way out (§5.14): a moved prior
                      ending re-closes THIS month; a gap must close the MISSING month first (this
                      month's re-close would 409 on the skipped-month rule); a nonzero genesis has
                      no prior at all — its beginning should be the 0.00 chain baseline. */}
                  {p.priorEndingAr !== null ? (
                    <>Beginning {p.beginningAr.toFixed(2)} no longer matches the prior month&apos;s ending{" "}
                      {p.priorEndingAr.toFixed(2)} — re-close this month to re-chain.</>
                  ) : closedPeriods.some((q) => q.year < p.year || (q.year === p.year && q.month < p.month)) ? (
                    <>Beginning {p.beginningAr.toFixed(2)} does not chain — the month before this one has
                      no close on record; close the missing month first, then re-close this one.</>
                  ) : (
                    <>Beginning {p.beginningAr.toFixed(2)} does not chain — this is the first closed month,
                      so its beginning should be 0.00; re-close this month to re-chain.</>
                  )}
                </p>
              )}
              {p.exportBatches.length === 0 ? (
                <p className="mt-1 text-slate-400">No export yet.</p>
              ) : (
                <ul className="mt-1">
                  {p.exportBatches.map((b) => (
                    <li key={b.id}>
                      Export #{b.exportNumber} ({new Date(b.emittedAt).toLocaleString()}) —{" "}
                      <a href={`/api/receivables/close/export/${b.id}/file`} className="text-blue-700 underline">File</a>
                      {" "}·{" "}
                      <a href={`/api/receivables/close/export/${b.id}/register`} target="_blank" rel="noreferrer"
                         className="text-blue-700 underline">
                        Register
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

/** `useSearchParams` suspends during prerender, and Next refuses to build a page that reads it
 *  outside a Suspense boundary — the `Statements.tsx` wrapper precedent. */
export function Close() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <ClosePeriodsScreen />
    </Suspense>
  );
}
