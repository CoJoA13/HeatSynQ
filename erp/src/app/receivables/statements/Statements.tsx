"use client";
// The statements screen (design spec §11 "/receivables/statements"; task-15-brief.md Step 1).
// Consumes Task 12's `GET /api/receivables/statements` (a PREVIEW — builds without archiving,
// `buildStatement`), `POST /api/receivables/statements` (render + archive + stream the PDF,
// `printStatement`), `POST /api/receivables/statements/run` (`runStatements`), and this task's own
// `GET /api/receivables/statements/documents` (a customer's archived STATEMENT history). The
// single print follows `InvoiceDetail.tsx`'s `printInvoice` fetch-blob-and-open-a-tab shape; the
// documents list follows that same file's `InvoiceDocumentsList`.
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gate, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { api } from "@/lib/fetcher";
import { AGING_BUCKETS, AGING_BUCKET_LABELS, type AgingBucketValue } from "@/lib/ar-constants";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { ReceivablesNav } from "../ReceivablesNav";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/aging.ts's `AgingRow`, src/server/pdf/statement.ts's
// `StatementOpenItem`/`StatementData` (trimmed to what this screen renders — no `company`/
// `remitTo`, which only the PDF itself needs), and src/server/documents.ts's `DocumentMeta`
// (trimmed the `InvoiceDocumentsList` way) — not imported from src/server/** (CLAUDE.md: a client
// component pulling from there drags node:async_hooks and Prisma into the browser bundle).
// ---------------------------------------------------------------------------------------------

type CustomerOption = { id: string; code: string; name: string; parentId: string | null };
/** What `POST .../statements/divisions` returns — one entry per printed family member (#85). */
type PerDivisionResult = {
  customerId: string; customerCode: string; customerName: string;
  documentId: string; totalDue: number;
};

type AgingRow = {
  customerId: string; customerCode: string; customerName: string;
  current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number;
  unapplied: number; net: number;
};

type StatementOpenItem = {
  documentNumber: string; date: string; dueDate: string | null; kind: "INVOICE" | "CREDIT";
  original: number; open: number;
};

type StatementPreview = {
  asOf: string;
  customer: { code: string; name: string; billTo: string[] };
  openItems: StatementOpenItem[];
  aging: AgingRow;
  financeCharge: number | null;
  totalDue: number;
};

type StoredDoc = { id: string; kind: string; createdAt: string };

type MoneyBucketKey = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";
const BUCKET_FIELD: Record<AgingBucketValue, MoneyBucketKey> = {
  CURRENT: "current", D1_30: "d1_30", D31_60: "d31_60", D61_90: "d61_90", D90_PLUS: "d90_plus",
};

// ---------------------------------------------------------------------------------------------
// StatementDocumentsList — the `InvoiceDocumentsList` precedent (InvoiceDetail.tsx), scoped by
// `customerId` rather than by an owning entity's own id: a statement is not its own persisted
// entity, only its printed output is, so there is no `/api/receivables/statements/[id]` to hang a
// documents route off of the way `/api/invoices/[id]/documents` does — `GET
// /api/receivables/statements/documents?customerId=` (this task's own new route) plays that role.
// ---------------------------------------------------------------------------------------------

function StatementDocumentsList({ customerId, viewGate, refresh }: {
  customerId: string;
  viewGate: Gate;
  /** Bumped by every successful print (single or run), so a just-archived document appears
   *  without a reload. */
  refresh: number;
}) {
  const [docs, setDocs] = useState<StoredDoc[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const allowed = viewGate.allowed;
  useEffect(() => {
    if (!allowed || !customerId) { setDocs([]); return; }
    api<StoredDoc[]>(`/api/receivables/statements/documents?customerId=${customerId}`)
      .then((d) => { setDocs(d); setErr(null); })
      .catch((e) => setErr((e as Error).message));
  }, [customerId, allowed, refresh]);

  if (!viewGate.allowed) {
    return <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view statements."}</p>;
  }
  if (!customerId) return <p className="text-sm text-slate-500">Pick a customer to see its statement history.</p>;
  if (err) return <p className="text-sm text-red-700">{err}</p>;
  if (docs.length === 0) return <p className="text-sm text-slate-500">Nothing printed yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="py-1 font-medium">Document</th><th className="font-medium">Printed</th>
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id} className="border-t">
            <td className="py-1">
              <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer" className="text-blue-700 underline">
                Statement
              </a>
            </td>
            <td className="text-slate-600">{new Date(d.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------
// The screen itself.
// ---------------------------------------------------------------------------------------------

function StatementsScreen() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "receivables.view");
  const runGate = gate(perms, "receivables.create");
  const customersGate = gate(perms, "customers.view");
  const viewAllowed = viewGate.allowed;

  // `?customerId=` preselects — the customer page's "Statement" link (ReceivablesSection.tsx)
  // arrives here with its own id already in the URL, rather than making the operator pick again.
  const initialCustomerId = useSearchParams().get("customerId") ?? "";

  // ---- Selection ----
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [asOf, setAsOf] = useState(() => formatDateOnly(todayDateOnly()));
  const [combineFamily, setCombineFamily] = useState(false);
  const [assessFinanceCharges, setAssessFinanceCharges] = useState(false); // off by default (brief)

  const [error, setError] = useState<string | null>(null);

  // Customer/family options — fetched only once the caller is known to hold customers.view
  // (§5.16), never left silently empty on failure — the AgingReport.tsx precedent.
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const customersAllowed = customersGate.allowed;
  useEffect(() => {
    if (!customersAllowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setError((e as Error).message));
  }, [customersAllowed]);

  // ---- Preview (GET, build-only — the route's own "a preview" comment) ----
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const latest = useLatest();

  const loadPreview = useCallback(async () => {
    if (!viewAllowed || !customerId) { setPreview(null); setLoaded(false); return; }
    const t = latest.next();
    const query = `customerId=${encodeURIComponent(customerId)}&asOf=${encodeURIComponent(asOf)}` +
      `&combineFamily=${combineFamily}&assessFinanceCharges=${assessFinanceCharges}`;
    let data: StatementPreview;
    try {
      data = await api<StatementPreview>(`/api/receivables/statements?${query}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setPreview(data);
    setError(null);
    setLoaded(true);
  }, [customerId, asOf, combineFamily, assessFinanceCharges, viewAllowed, latest]);
  useEffect(() => { void loadPreview(); }, [loadPreview]);

  // ---- Print (single) — the InvoiceDetail.tsx `printInvoice` fetch-blob-and-open precedent ----
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [docsRefresh, setDocsRefresh] = useState(0);

  async function printSingle() {
    setPrinting(true);
    setPrintError(null);
    try {
      const res = await fetch("/api/receivables/statements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, asOf, combineFamily, assessFinanceCharges }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Print failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      const opened = window.open(url, "_blank");
      if (opened) opened.opener = null;
      if (opened === null) {
        setPrintError("The browser blocked the print window — the document was archived and is in Documents below.");
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDocsRefresh((n) => n + 1);
    } catch (e) {
      setPrintError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }

  // ---- Print per division (#85) ----
  // Unchecking "Combine family" on a PARENT used to send one request for the parent alone, so the
  // divisions were silently omitted and the advertised choice produced strictly less than the
  // combined one. This prints one statement per family member. It returns a LIST rather than a PDF
  // (N documents cannot be one blob), so it reports like "Run for everyone" does instead of opening
  // a tab — the archived statements are in Documents below, each under its own customer.
  const [perDivision, setPerDivision] = useState<PerDivisionResult[] | null>(null);
  // A family HEAD (some other customer names it as parent) printed un-combined. A division printed
  // un-combined is already correct — it is its own statement — so only the head switches behaviour.
  const perDivisionMode = !combineFamily
    && customerId !== ""
    && customers.some((c) => c.parentId === customerId);

  async function printPerDivision() {
    setPrinting(true);
    setPrintError(null);
    setPerDivision(null);
    try {
      const printed = await api<PerDivisionResult[]>("/api/receivables/statements/divisions", {
        method: "POST",
        body: JSON.stringify({ customerId, asOf, assessFinanceCharges }),
      });
      setPerDivision(printed);
      setDocsRefresh((n) => n + 1);
    } catch (e) {
      setPrintError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }

  // ---- Run for everyone with a balance ----
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ customerId: string; documentId: string }[] | null>(null);

  async function runForEveryone() {
    if (!confirm(`Print a statement for every customer with an open balance as of ${asOf}?`)) return;
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const result = await api<{ customerId: string; documentId: string }[]>("/api/receivables/statements/run", {
        method: "POST", body: JSON.stringify({ asOf, assessFinanceCharges }),
      });
      setRunResult(result);
      setDocsRefresh((n) => n + 1); // covers the case the selected customer is among those just printed
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const printTitle = !viewGate.allowed ? viewGate.title
    : !customerId ? "Pick a customer first"
      : printing ? "Printing…" : undefined;
  const runTitle = !runGate.allowed ? runGate.title : running ? "Running…" : undefined;

  // §5.16: a caller without receivables.view sees the page saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <div className="p-6">
        <ReceivablesNav />
        <h1 className="mb-4 text-2xl font-semibold">Statements</h1>
        <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view statements."}</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <ReceivablesNav />
      <h1 className="mb-4 text-2xl font-semibold">Statements</h1>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {printError && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{printError}</p>}
      {runError && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{runError}</p>}
      {perDivision && (
        <div className="mb-3 rounded bg-emerald-50 p-2 text-sm text-emerald-800">
          <p className="mb-1">
            Printed {perDivision.length} statement{perDivision.length === 1 ? "" : "s"} — one per division.
          </p>
          <ul className="list-inside list-disc">
            {perDivision.map((r) => (
              <li key={r.documentId}>
                <span className="font-mono">{r.customerCode}</span> {r.customerName} — {r.totalDue.toFixed(2)} due
              </li>
            ))}
          </ul>
        </div>
      )}
      {runResult && (
        <p className="mb-3 rounded bg-emerald-50 p-2 text-sm text-emerald-800">
          {runResult.length === 0
            ? "No customer carries an open balance as of that date — nothing was printed."
            : `Printed ${runResult.length} statement${runResult.length === 1 ? "" : "s"}.`}
        </p>
      )}

      {/* ---- Selection ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Selection</h2>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Customer / family
            <select value={customerId} disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                    onChange={(e) => setCustomerId(e.target.value)}
                    className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
              <option value="">Select…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </label>
          <label className="block">
            As of
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
                   className="mt-1 block rounded border px-2 py-1" />
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={combineFamily} onChange={(e) => setCombineFamily(e.target.checked)} />
            Combine family
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={assessFinanceCharges} onChange={(e) => setAssessFinanceCharges(e.target.checked)} />
            Assess finance charges
          </label>
          {/* A family head printed UN-combined is the per-division choice, and it prints one
              statement per member (#85). Every other case — a division, a standalone customer, or
              "Combine family" checked — is the ordinary single print. */}
          <button onClick={() => void (perDivisionMode ? printPerDivision() : printSingle())}
                  disabled={printTitle !== undefined} title={printTitle}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {printing ? "Printing…" : perDivisionMode ? "Print per division" : "Print"}
          </button>
          <button onClick={() => void runForEveryone()} disabled={runTitle !== undefined} title={runTitle}
                  className="rounded border bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
            {running ? "Running…" : "Run for everyone with a balance"}
          </button>
        </div>
      </section>

      {/* ---- Preview ---- */}
      {customerId && (
        <section className="mb-6 rounded border bg-white p-4">
          <h2 className="mb-2 font-medium">Preview</h2>
          {!loaded && !error && <p className="text-sm text-slate-500">Loading…</p>}
          {loaded && preview && (
            <>
              <div className="mb-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500">
                      {AGING_BUCKETS.map((b) => <th key={b} className="p-1 text-right font-medium">{AGING_BUCKET_LABELS[b]}</th>)}
                      <th className="p-1 text-right font-medium">Unapplied</th>
                      <th className="p-1 text-right font-medium">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {AGING_BUCKETS.map((b) => <td key={b} className="p-1 text-right">{preview.aging[BUCKET_FIELD[b]].toFixed(2)}</td>)}
                      <td className="p-1 text-right">{preview.aging.unapplied.toFixed(2)}</td>
                      <td className="p-1 text-right font-medium">{preview.aging.net.toFixed(2)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h3 className="mb-1 text-sm font-medium text-slate-600">Open items</h3>
              {preview.openItems.length === 0 ? (
                <p className="mb-3 text-sm text-slate-500">No open items as of this date.</p>
              ) : (
                <table className="mb-3 w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="py-1 font-medium">Document</th><th className="font-medium">Date</th>
                      <th className="font-medium">Due</th><th className="font-medium">Original</th><th className="font-medium">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.openItems.map((r) => (
                      <tr key={r.documentNumber} className="border-t">
                        <td className="py-1 font-mono">{r.documentNumber}</td>
                        <td>{r.date}</td>
                        <td>{r.dueDate ?? "—"}</td>
                        <td>{r.original.toFixed(2)}</td>
                        <td>{r.open.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {preview.financeCharge !== null && (
                <p className="mb-1 text-sm">
                  Finance charge: <span className="font-medium">{preview.financeCharge.toFixed(2)}</span>
                </p>
              )}
              <p className="text-sm">Total due: <span className="font-medium">{preview.totalDue.toFixed(2)}</span></p>
            </>
          )}
        </section>
      )}

      {/* ---- Documents ---- */}
      <section className="rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Documents</h2>
        <StatementDocumentsList customerId={customerId} viewGate={viewGate} refresh={docsRefresh} />
      </section>
    </div>
  );
}

/** `useSearchParams` suspends during prerender, and Next refuses to build a page that reads it
 *  outside a Suspense boundary — the `orders/[id]/page.tsx` wrapper precedent. */
export function Statements() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <StatementsScreen />
    </Suspense>
  );
}
