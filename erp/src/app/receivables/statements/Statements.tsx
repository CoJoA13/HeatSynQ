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

type CustomerOption = { id: string; code: string; name: string; parentId: string | null; active: boolean };
/** What `POST .../statements/divisions` returns — one entry per printed family member (#85). */
type PerDivisionResult = {
  customerId: string; customerCode: string; customerName: string;
  /** Null when that member's statement FAILED — `error` says why. Each member is its own committed
   *  transaction, so one failing must not hide the ones already archived (review round 4). */
  documentId: string | null; totalDue: number | null; error: string | null;
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

/** Exported only so `printControlTitle`'s tests can build one — see that function's note. */
export type StatementPreview = {
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
  // §5.13 stale-gate, both paths (F7), the ShipmentDocumentsList shape — with the ticket taken at
  // the TOP of the effect, before the early-return clear, so clearing the selection also
  // invalidates any in-flight response (it must not repaint the just-cleared list).
  const latest = useLatest();
  useEffect(() => {
    const t = latest.next();
    if (!allowed || !customerId) { setDocs([]); return; }
    api<StoredDoc[]>(`/api/receivables/statements/documents?customerId=${customerId}`)
      .then((d) => { if (latest.isCurrent(t)) { setDocs(d); setErr(null); } })
      .catch((e) => { if (latest.isCurrent(t)) setErr((e as Error).message); });
  }, [customerId, allowed, refresh, latest]);

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
// The Print gate.
// ---------------------------------------------------------------------------------------------

/**
 * Has the customer-options fetch settled, and did it ANSWER? (#137 defect 2.)
 *
 * Which print path is correct depends on whether the selected customer has live divisions, and
 * that customer list is the only thing on this screen that knows. The predecessor was a boolean
 * `familyKnown`, set true only when the fetch SUCCEEDED — but that fetch needs `customers.view`,
 * which `receivables.view` does not imply. A caller holding statements permission alone can still
 * arrive on a bookmarked `?customerId=`, and both statement routes authorise them; the boolean
 * left Print disabled forever, making a statement permission depend on an unrelated one.
 *
 * A tri-state separates the two cases the boolean conflated. `"pending"` means the lookup can
 * still answer, so waiting for it costs a moment and keeps round 4's protection. `"unknown"` means
 * it never will — no `customers.view`, or it failed — and holding the control then is a permanent
 * lockout, so the gate falls open there.
 */
export type FamilyLookup = "pending" | "known" | "unknown";

/**
 * Why Print cannot be pressed, or `undefined` when it can (§5.16: a control the user cannot use is
 * visible and DISABLED with a tooltip naming why, never offered and then refused).
 *
 * Hook-free and exported so tests/statements-screen.test.ts can drive it directly — this repo has
 * no DOM test environment, and the established answer is to split the DECISION out of the
 * component (`runControlState` in admin/backups/page.tsx, `advanceBannerState` in BackupBanner)
 * rather than reach for one. It takes the `preview` itself rather than a derived boolean so the
 * call site cannot get the derivation wrong; only its nullness is read.
 *
 * ORDER IS THE CONTRACT. Permission first, then a chosen customer, then the two async facts this
 * screen waits on, then the per-division grant, then the in-flight print.
 */
export function printControlTitle(s: {
  viewAllowed: boolean; viewTitle: string | undefined;
  customerId: string; familyLookup: FamilyLookup; loaded: boolean;
  preview: StatementPreview | null; perDivisionMode: boolean;
  runAllowed: boolean; runTitle: string | undefined;
  printing: boolean;
}): string | undefined {
  if (!s.viewAllowed) return s.viewTitle;
  if (s.customerId === "") return "Pick a customer first";
  // Only while the lookup can still answer — see `FamilyLookup`. `"unknown"` falls through, and
  // the SERVER is the authority that makes that safe (see the note on `printSingle`'s call site).
  if (s.familyLookup === "pending") return "Checking whether this customer has divisions…";
  if (!s.loaded) return "Loading this customer's statement…";
  // SETTLED BUT EMPTY = the preview for THESE inputs failed (#137 defect 1). `loadPreview`'s catch
  // clears `preview` inside its own `isCurrent` guard, so this is precise. Without it the previous
  // customer's/date's tables stayed on screen with Print live: the operator reviewed the old
  // result and archived statements for the new inputs.
  //
  // Gated on `preview === null`, NOT on `error` — deliberately, and against the issue's own
  // wording. `error` is a SHARED bucket the customer-options catch also writes, so gating on it
  // would re-disable Print for precisely the `customers.view`-less caller defect 2 opens up.
  if (s.preview === null) return "This customer's statement could not be loaded — try again before printing";
  // Per-division printing archives N documents, so it needs `receivables.create` — the same grant
  // its endpoint requires. Without this a view-only user saw an ENABLED button, confirmed a
  // multi-document print, and got a 403.
  if (s.perDivisionMode && !s.runAllowed) return s.runTitle;
  if (s.printing) return "Printing…";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The screen itself.
// ---------------------------------------------------------------------------------------------

function StatementsScreen() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "receivables.view");
  const runGate = gate(perms, "receivables.create");
  const customersGate = gate(perms, "customers.view");
  // A FRESH primitive, deliberately — NOT a bare alias into `viewGate`. `gate()` builds that object
  // during render, so the React Compiler cannot prove it immutable; `viewAllowed` is both a
  // `loadPreview` dependency AND an argument to `printControlTitle`, and handing an alias of an
  // un-provable object to a call the compiler cannot see into marks that dependency "may be
  // modified later". The whole component then loses its memoization, which `eslint src` reports as
  // an ERROR ("Compilation Skipped: Existing memoization could not be preserved") — measured, both
  // ways, on this file. The comparison is what makes it a new value; do not simplify it away.
  //
  // It is the ALIAS alone that trips it, independent of how `printControlTitle` is shaped: probed
  // four ways, an object-taking signature with this same comparison lints CLEAN, and passing
  // `viewGate.allowed` directly reds it whichever signature is in use (review round 1).
  const viewAllowed = viewGate.allowed === true;

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
  // Whether the family lookup actually ANSWERED — not merely "the array is empty" (§5.15). Which
  // print path is correct depends on whether the selected customer has divisions, and this list is
  // the only thing on this screen that knows: while it is pending, an empty array is
  // indistinguishable from "no divisions", and printing on that assumption silently archives the
  // parent alone, which is the omission #85 exists to fix.
  //
  // A TRI-STATE, not a boolean (#137 defect 2 — see `FamilyLookup`). `"unknown"` — no
  // `customers.view`, or the fetch failed — is a case the boolean conflated with `"pending"` and
  // answered with a permanent lockout.
  const [familyLookup, setFamilyLookup] = useState<FamilyLookup>("pending");
  const customersAllowed = customersGate.allowed;
  useEffect(() => {
    // NOTE the ordering: `customersAllowed` is false while `usePermissions` is still resolving, so
    // this branch runs first on every mount. That is harmless — `printControlTitle` answers a
    // caller with no permissions on its FIRST branch, ahead of the family one — and permissions
    // landing flips this effect back to `"pending"` for the duration of the fetch below, so the
    // in-flight window is never open for a caller who does hold `customers.view`.
    if (!customersAllowed) { setFamilyLookup("unknown"); return; }
    setFamilyLookup("pending");
    // Effect-scoped stale flag (§5.13, the fetch-keyed-by-an-effect-dep shape): a response from a
    // superseded run of this effect must not land, on EITHER path (F7) — a stale rejection
    // reporting `"unknown"` over a fresh `"known"` would open the gate on a list we do have.
    let stale = false;
    // `includeInactive=1` because BOTH service halves define the family by `deletedAt: null`,
    // not by `active` (review round 1). A parent whose divisions are merely deactivated —
    // how a dormant division that still owes money is parked — otherwise never switched the
    // button, so unchecking "Combine family" silently printed the parent alone: #85's exact
    // symptom, unfixed for that family, while the COMBINED print included those divisions.
    api<CustomerOption[]>("/api/customers?includeInactive=1")
      .then((rows) => { if (!stale) { setCustomers(rows); setFamilyLookup("known"); } })
      .catch((e) => { if (!stale) { setError((e as Error).message); setFamilyLookup("unknown"); } });
    return () => { stale = true; };
  }, [customersAllowed]);

  // ---- Preview (GET, build-only — the route's own "a preview" comment) ----
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const latest = useLatest();

  const loadPreview = useCallback(async () => {
    // Ticket BEFORE the clear branch (§5.13 stale-gate): clearing the selection must also
    // invalidate an in-flight preview, or it lands afterwards and repaints the cleared pane.
    const t = latest.next();
    if (!viewAllowed || !customerId) { setPreview(null); setLoaded(false); return; }
    // The previous preview describes the PREVIOUS inputs, so it goes stale the moment any of them
    // change — clearing `loaded` here rather than leaving the old one on screen while a new request
    // is in flight. Without this the confirm dialog could say "the preview above shows this
    // customer's statement" over a preview built for a different customer, as-of date, or
    // finance-charge choice, and then print with the new ones (review round 8). The print button is
    // gated on `loaded`, so it waits for the matching answer instead of guessing.
    setLoaded(false);
    const query = `customerId=${encodeURIComponent(customerId)}&asOf=${encodeURIComponent(asOf)}` +
      `&combineFamily=${combineFamily}&assessFinanceCharges=${assessFinanceCharges}`;
    let data: StatementPreview;
    try {
      data = await api<StatementPreview>(`/api/receivables/statements?${query}`);
    } catch (e) {
      // CLEAR THE PREVIEW TOO (#137 defect 1). Setting `loaded` back to true while leaving the
      // previous inputs' `preview` on screen re-enabled Print over a stale result: the operator
      // reviewed the old customer's/date's tables and archived statements for the new ones. Round
      // 8's fix made printing wait for the matching answer on the SUCCESS path only.
      //
      // INSIDE the `isCurrent` guard, which is what makes it compose with the stale-load rule: a
      // SUPERSEDED rejection must not clobber current state either (F7 — both landings gated).
      // Not at the top of `loadPreview` either: this callback re-runs on every keystroke in the
      // as-of field, and blanking a good preview there would flash the pane empty on each one.
      // Round 8 deliberately cleared only `loaded` up there, and that stays true.
      //
      // LOAD-BEARING AND UNPINNED — nothing in the suite would catch its removal. The gate is
      // correct only because this line runs, and `tests/statements-screen.test.ts` drives the pure
      // `printControlTitle`, which cannot observe this wiring; there is no DOM environment to
      // mount the component in and assert it. Drop `setPreview(null)` and all ten gate tests stay
      // GREEN while the reported defect returns exactly as filed.
      if (latest.isCurrent(t)) { setError((e as Error).message); setPreview(null); setLoaded(true); }
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
  const familyMembers = customerId === "" ? [] : customers.filter((c) => c.parentId === customerId);
  const perDivisionMode = !combineFamily && familyMembers.length > 0;

  async function printPerDivision() {
    // The preview below shows the PARENT's statement only — `buildStatement` with combineFamily
    // false is a single customer by definition — while this archives one document per member.
    // Naming them and confirming is the disclosure that gap needs (review round 1): the operator
    // must not approve a parent-only preview and silently create child paper they never saw.
    const members = [customerId, ...familyMembers.map((c) => c.id)];
    const names = familyMembers.map((c) => `${c.code}${c.active ? "" : " (inactive)"}`).join(", ");
    if (!confirm(
      `Print ${members.length} statements as of ${asOf} — this customer plus its divisions `
      + `(${names})?\n\nThe preview above shows this customer's statement only; each division's `
      + "is archived and listed with a link once printed.",
    )) return;
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

  // §5.16, decided in `printControlTitle` above — a pure function so it can be driven directly in
  // this repo's node-only test environment (the `runControlState` precedent).
  //
  // THE SERVER IS THE AUTHORITY, and this gate is belt-and-braces (#136, owner ruling
  // 2026-08-17). `POST /api/receivables/statements` refuses an un-combined print for a customer
  // with live divisions (`hasLiveDivisions`, route.ts), so a client that guesses the print path
  // wrong — from a list that has been wrong three different ways across review: active-only, not
  // yet loaded, stale — can now only produce a refusal naming the fix, never a silently
  // parent-only statement. That is exactly what lets the family gate fall open on `"unknown"`
  // (#137 defect 2): a permanent lockout becomes an occasional, self-describing 409.
  //
  // Scalar FIELDS rather than the two `Gate` objects: a pure function over plain args, driven
  // directly in the node-only test env. A preference, not a requirement — the React Compiler
  // constraint is on `viewAllowed`'s derivation above and is independent of this signature.
  const printTitle = printControlTitle({
    viewAllowed, viewTitle: viewGate.title, customerId, familyLookup, loaded, preview,
    perDivisionMode, runAllowed: runGate.allowed, runTitle: runGate.title, printing,
  });
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
        <div className={`mb-3 rounded p-2 text-sm ${perDivision.some((r) => r.error !== null)
          ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-800"}`}>
          <p className="mb-1">
            Printed {perDivision.filter((r) => r.error === null).length} of {perDivision.length}
            {" "}statements — one per division.
          </p>
          {/* Each result links to ITS OWN archived PDF: the Documents table below is filtered to the
              selected parent, so without these the children's statements would be unreachable from
              this screen (and an inactive child's doubly so). */}
          <ul className="list-inside list-disc">
            {perDivision.map((r) => (
              <li key={r.customerId} className={r.error === null ? undefined : "text-red-700"}>
                <span className="font-mono">{r.customerCode}</span> {r.customerName}
                {r.error === null ? (
                  <>
                    {" "}— {(r.totalDue ?? 0).toFixed(2)} due —{" "}
                    <a href={`/api/documents/${r.documentId}`} target="_blank" rel="noreferrer"
                       className="text-blue-700 underline">open PDF</a>
                  </>
                ) : (
                  <> — not printed: {r.error}</>
                )}
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
              {/* Inactive customers are LISTED (a deactivated division can still owe money, and its
                  statement has to be reachable) but marked, so the list stays honest. */}
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}{c.active ? "" : " (inactive)"}
                </option>
              ))}
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
          {/* WHO this preview is for, named from the payload the server already sends (#137). The
              selector above answers it only for a caller holding `customers.view`; without that
              grant it is disabled and empty, and once the family gate falls open such a caller can
              print — so this is their only way to confirm the `?customerId=` they arrived on is the
              customer they meant. */}
          <h2 className="mb-2 font-medium">
            Preview
            {loaded && preview && (
              <>
                {" — "}<span className="font-mono">{preview.customer.code}</span>{" "}
                <span className="font-normal text-slate-600">{preview.customer.name}</span>
              </>
            )}
          </h2>
          {!loaded && !error && <p className="text-sm text-slate-500">Loading…</p>}
          {/* Settled with nothing to show — the request for THESE inputs failed. Said here as well
              as in the banner above, because the banner is a SHARED bucket (the customer-options
              catch writes it too) and this pane must not simply go blank. */}
          {loaded && !preview && (
            <p className="text-sm text-red-700">This customer&apos;s statement could not be loaded.</p>
          )}
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
