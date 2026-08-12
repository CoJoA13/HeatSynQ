"use client";
// The quote page's body (spec §5.1; task-08-brief.md item 2). Remounted per id by page.tsx's
// `key={id}` (HANDOFF §5.12): every field below binds to this instance's own form state, so no
// draft can carry one quote's unsaved text onto another quote's id.
//
// THE BINDING STATE MODEL — a SINGLE-SAVE form, deliberately NOT the optimistic per-field PATCH
// the sibling detail pages use: `PATCH /api/quotes/[id]` is the only write surface for header
// AND line tree alike (Task 4's array-replace), and the notes pair (`notes`/`internalNotes`)
// riding one form with one Save is the brief's named defense against the three-page
// optimistic-PATCH notes-clobber family — this page must not become its fourth member. The form
// is an explicit draft over the last-loaded server detail:
//
//  - Save sends the CLIENT-SIDE DIFF (quote-form.ts: changed header keys only, plus `lines`
//    only when the tree changed), so an untouched load→save is a server-side no-op — nothing is
//    even sent (Save stays disabled), and a partial edit writes exactly what changed, with
//    `eachWeight` carried on free-text lines (the Task 4 Minor this page exists to fix).
//  - A failed save KEEPS the draft and surfaces the server's message verbatim (the
//    InvoiceLinesGrid precedent): nothing was optimistic, so there is no divergence to roll
//    back — §5.13's rollback-first rule applies to the page's optimistic surfaces (none here)
//    and to the actions below, which reload server truth before reporting.
//  - Actions that ADOPT a fresh server detail (close/reopen/attach-part) are disabled while the
//    form is dirty — adopting would silently discard the draft — with a title saying so.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { HistoryPanel } from "@/components/HistoryPanel";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { PRICE_PER, PRICE_PER_LABELS, type PricePerValue } from "@/lib/part-constants";
import { QUOTE_STATUS_LABELS, QUOTE_EXPIRED_LABEL } from "@/lib/quote-constants";
import {
  headerFormFrom, headerPatch, lineFormsFrom, linesComparable, linesPayload,
  type HeaderForm, type LineForm, type LinkedOrderRef, type PriceForm,
  type QuoteCloseResultData, type QuoteDetailData, type QuoteMutationData,
} from "../quote-form";

// Picker option slices (local mirrors, never src/server/** imports — CLAUDE.md).
type ContactOption = { id: string; name: string; active: boolean };
type UserOption = { id: string; displayName: string; active: boolean };
type PickListOption = { id: string; name: string; active: boolean };
type PartOption = {
  id: string; customerId: string; partNumber: string; name: string;
  materialName: string | null; eachWeight: number; active: boolean;
};
/** Slice of the quote documents list (kind QUOTE — Task 10's print route archives into it;
 *  mirrors the invoices documents shape). */
type StoredDoc = { id: string; kind: string; createdAt: string };

/** Lock every editing control on a CLOSED or deleted quote (the InvoiceDetail `statusLocked`
 *  shape): the service refuses non-OPEN edits, so the controls say so up front (§5.16 style —
 *  disabled with the reason, never hidden). */
function statusLocked(g: Gate, closed: boolean, deleted: boolean): Gate {
  if (deleted) return { allowed: false, disabled: true, title: "Quote is deleted" };
  if (closed) return { allowed: false, disabled: true, title: "This quote is closed — reopen it before editing" };
  return g;
}

/** The stored-documents list — mirrors InvoiceDocumentsList (InvoiceDetail.tsx). Task 8 wired
 *  this section one task ahead of the route (the invoices Task 18→19 precedent, 404 rendered as
 *  the empty state); Task 10 landed `GET /api/quotes/[id]/documents` at exactly this path, so a
 *  failure now surfaces as the error it is. */
function QuoteDocumentsList({ quoteId, viewGate, refresh }: {
  quoteId: string; viewGate: Gate;
  /** Bumped by every successful print, so a just-archived document appears without a reload. */
  refresh: number;
}) {
  const [docs, setDocs] = useState<StoredDoc[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!viewGate.allowed) return;
    api<StoredDoc[]>(`/api/quotes/${quoteId}/documents`).then(setDocs)
      .catch((e) => setErr((e as Error).message));
  }, [quoteId, viewGate.allowed, refresh]);

  if (!viewGate.allowed) return <p className="text-sm text-slate-500">{viewGate.title}</p>;
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
                {d.kind === "QUOTE" ? "Quote" : d.kind}
              </a>
            </td>
            <td className="text-slate-600">{new Date(d.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The §5.14 delete-blocker list, derived from the detail payload itself: every line's
 *  `linkedOrders` is exactly the live-order predicate `quoteOrderBlockers` refuses over
 *  (quotes.ts reads both from `OrderLine.quoteLineId` with voided orders excluded), so the
 *  panel needs no extra route — the Excel export rides the existing blockers/export route. */
function blockersFrom(d: QuoteDetailData): Blocker[] {
  const seen = new Map<string, number>();
  for (const l of d.lines) for (const o of l.linkedOrders) seen.set(o.id, o.orderNumber);
  return [...seen.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id, n]) => ({ entityLabel: "Order", name: `#${n}`, id, href: `/orders/${id}` }));
}

const linkedOrderNumbers = (orders: LinkedOrderRef[]): string =>
  orders.map((o) => `#${o.orderNumber}`).join(", ");

export function QuoteDetail({ id }: { id: string }) {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();

  const [detail, setDetail] = useState<QuoteDetailData | null>(null);
  const [header, setHeader] = useState<HeaderForm | null>(null);
  const [lines, setLines] = useState<LineForm[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Pick-list failures get their own banner, never cleared by a later successful save (the
  // parts/[id] F9 `loadError` pattern) — the affected select stays honest via its synthesized
  // current-value option meanwhile.
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const addOptionsError = useCallback((message: string) => {
    setOptionsError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);
  const [saving, setSaving] = useState(false);
  const [closeWarning, setCloseWarning] = useState<LinkedOrderRef[] | null>(null);
  // Ruling 7's overlap-save warnings (amber, non-blocking — the ShipmentDetail warnings banner).
  // Set ONLY from mutation responses (Save and attach-part carry them; GET does not), and load()
  // deliberately never touches this state — so a reload that follows the save (§5.13's
  // rollback-first refresh after some LATER failed action, or any other adopt) cannot clear a
  // warning the save just raised. Navigation dismisses it: page.tsx remounts this component per
  // id. A later save with ZERO warnings replaces it with the empty surface — the fresh save's
  // truth (the §5.7 full-surface rule).
  const [overlapWarnings, setOverlapWarnings] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<{ list: Blocker[] } | null>(null);

  // Minted React keys for rows added client-side (their server ids don't exist yet).
  const seq = useRef(0);
  const newKey = () => `new-${++seq.current}`;

  /** Adopt a fresh server detail as the form's new baseline — load, save, close/reopen,
   *  attach-part all land here. Any draft is replaced wholesale, which is why the adopting
   *  ACTIONS are dirty-locked below (Save itself is the draft's own commit). */
  const adopt = useCallback((d: QuoteDetailData) => {
    setDetail(d);
    setHeader(headerFormFrom(d));
    setLines(lineFormsFrom(d));
  }, []);

  const load = useCallback(async () => {
    adopt(await api<QuoteDetailData>(`/api/quotes/${id}`));
  }, [id, adopt]);
  useEffect(() => {
    load().then(() => setError(null)).catch((e) => setError((e as Error).message));
  }, [load]);

  // ---- Dirty tracking: the loaded detail IS the baseline; both diffs derive from it. ----
  const baseHeader = detail === null ? null : headerFormFrom(detail);
  const patch = header !== null && baseHeader !== null ? headerPatch(header, baseHeader) : {};
  const linesDirty = detail !== null && linesComparable(lines) !== linesComparable(lineFormsFrom(detail));
  const dirty = Object.keys(patch).length > 0 || linesDirty;

  // ---- Gates (§5.16: every gated control disabled WITH the reason, via the shared helper). ----
  const closed = detail?.status === "CLOSED";
  const deleted = (detail?.deletedAt ?? null) !== null;
  const editGateRaw = gate(perms, "quotes.edit");
  const editGate = statusLocked(editGateRaw, closed, deleted);
  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");
  const usersGate = gateDo(perms, "manage_users");
  const docsGate = gate(perms, "quotes.view");

  /** Actions that adopt a fresh detail are locked while the form holds unsaved edits. */
  const dirtyLocked = (g: Gate): Gate =>
    (g.allowed && dirty ? { allowed: false, disabled: true, title: "Save or discard your changes first" } : g);

  const closeGate: Gate = dirtyLocked(deleted
    ? { allowed: false, disabled: true, title: "Quote is deleted" }
    : closed
      ? { allowed: false, disabled: true, title: "Already closed" }
      : editGateRaw);
  const reopenGate: Gate = dirtyLocked(deleted
    ? { allowed: false, disabled: true, title: "Quote is deleted" }
    : !closed
      ? { allowed: false, disabled: true, title: "This quote is not closed" }
      : editGateRaw);
  const deleteGate: Gate = deleted
    ? { allowed: false, disabled: true, title: "Already deleted" }
    : gate(perms, "quotes.delete");
  // Print (Task 10) — gated on the area's OWN .view permission, locked only by "deleted" (the
  // InvoiceDetail printGate / traveler-print precedent: printing is a read of the document, and
  // the one state that refuses a NEW print is a voided owner — the server's shared VOIDED_PRINT
  // guard; a CLOSED or expired quote still prints the agreement it records).
  const printGate: Gate = deleted
    ? { allowed: false, disabled: true, title: "Quote is deleted — nothing to print" }
    : gate(perms, "quotes.view");

  // Compound picker gates (the PricingSection two-gate precedent): the control needs quotes.edit
  // AND the permission its options ride on; the title names whichever is actually the blocker.
  const contactGate: Gate = editGate.disabled ? editGate
    : customersGate.allowed ? editGate : { allowed: false, disabled: true, title: customersGate.title };
  const quotedByGate: Gate = editGate.disabled ? editGate
    : usersGate.allowed ? editGate : { allowed: false, disabled: true, title: usersGate.title };

  // ---- Pick-lists (§5.15: ending statements + step codes via /api/picklists; contacts/users/
  // parts from their own guarded reads, fetched only when the gate allows — never silently
  // empty for someone who lacks the permission). includeInactive=1 throughout: a stored pick may
  // point at a row that has since gone inactive (the PricingSection precedent). ----
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [statements, setStatements] = useState<PickListOption[]>([]);
  const [stepCodes, setStepCodes] = useState<PickListOption[]>([]);
  const [stepCodesReady, setStepCodesReady] = useState(false);
  const [parts, setParts] = useState<PartOption[]>([]);

  const customerId = detail?.customerId;
  useEffect(() => {
    if (!customersGate.allowed || !customerId) return;
    api<ContactOption[]>(`/api/customers/${customerId}/contacts?includeInactive=1`)
      .then(setContacts).catch((e) => addOptionsError((e as Error).message));
  }, [customersGate.allowed, customerId, addOptionsError]);
  useEffect(() => {
    if (!usersGate.allowed) return;
    api<UserOption[]>("/api/admin/users").then(setUsers).catch((e) => addOptionsError((e as Error).message));
  }, [usersGate.allowed, addOptionsError]);
  useEffect(() => {
    api<PickListOption[]>("/api/picklists/endingStatement?includeInactive=1")
      .then(setStatements).catch((e) => addOptionsError((e as Error).message));
  }, [addOptionsError]);
  useEffect(() => {
    api<PickListOption[]>("/api/picklists/processStepCode?includeInactive=1")
      .then((data) => { setStepCodes(data); setStepCodesReady(true); })
      .catch((e) => addOptionsError((e as Error).message));
  }, [addOptionsError]);
  useEffect(() => {
    if (!partsGate.allowed) return;
    api<PartOption[]>("/api/parts?includeInactive=1").then(setParts)
      .catch((e) => addOptionsError((e as Error).message));
  }, [partsGate.allowed, addOptionsError]);

  const customerParts = customerId ? parts.filter((p) => p.customerId === customerId) : [];

  // ---- Save / discard ----

  async function save() {
    if (detail === null || header === null || saving) return;
    for (const [value, label] of [
      [header.quoteDate, "Quote date"], [header.effectiveDate, "Effective date"],
      [header.expiryDate, "Expiry date"],
    ] as const) {
      if (value === "") { setError(`${label} is required.`); return; }
    }
    const body: Record<string, unknown> = headerPatch(header, headerFormFrom(detail));
    if (linesDirty) {
      const built = linesPayload(lines);
      if (!built.ok) { setError(built.error); return; }
      body.lines = built.lines;
    }
    if (Object.keys(body).length === 0) return; // Save is disabled when clean — belt and braces.
    setSaving(true);
    try {
      const res = await api<QuoteMutationData>(`/api/quotes/${id}`, {
        method: "PATCH", body: JSON.stringify(body),
      });
      adopt(res);
      setOverlapWarnings(res.warnings);
      setError(null);
    } catch (e) {
      // Draft retained on purpose (see the top comment): the server refused, the user's edits
      // are the thing being negotiated, and the message names what to fix.
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function discardChanges() {
    if (detail === null) return;
    setHeader(headerFormFrom(detail));
    setLines(lineFormsFrom(detail));
    setError(null);
  }

  // ---- Lifecycle actions ----

  async function closeQuote() {
    if (detail === null) return;
    const reason = prompt(
      `Close quote #${detail.quoteNumber}?\n\nIt stops pricing new orders; orders already ` +
      `linked keep their pricing. Closing is reversible (Reopen).\n\n` +
      `Reason for closing (recorded in the audit history):`,
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to close a quote."); return; }
    try {
      const res = await api<QuoteCloseResultData>(`/api/quotes/${id}/close`, {
        method: "POST", body: JSON.stringify({ reason }),
      });
      adopt(res.quote);
      setCloseWarning(res.linkedOpenOrders.length > 0 ? res.linkedOpenOrders : null);
      setError(null);
    } catch (e) {
      // §5.13: back to server truth first (another session may have closed it already), then
      // report why. The form is clean here — close is dirty-locked — so nothing is lost. A
      // failed rollback reload is APPENDED, never swallowed (the deleteQuote shape below):
      // stale detail beside a banner explaining a different failure would misdescribe what the
      // user is looking at.
      const message = (e as Error).message;
      try {
        await load();
        setError(message);
      } catch (reloadErr) {
        setError(`${message} — and the page could not be refreshed ` +
          `(${(reloadErr as Error).message}). Reload to see the current state.`);
      }
    }
  }

  async function reopenQuote() {
    if (detail === null) return;
    const reason = prompt(
      `Reopen quote #${detail.quoteNumber}?\n\nIt becomes a standing agreement again and ` +
      `resumes pricing new orders in its window.\n\n` +
      `Reason for reopening (recorded in the audit history):`,
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to reopen a quote."); return; }
    try {
      adopt(await api<QuoteDetailData>(`/api/quotes/${id}/reopen`, {
        method: "POST", body: JSON.stringify({ reason }),
      }));
      setError(null);
      setCloseWarning(null);
    } catch (e) {
      // Same rollback-then-report shape as closeQuote, reload failure appended.
      const message = (e as Error).message;
      try {
        await load();
        setError(message);
      } catch (reloadErr) {
        setError(`${message} — and the page could not be refreshed ` +
          `(${(reloadErr as Error).message}). Reload to see the current state.`);
      }
    }
  }

  async function deleteQuote() {
    if (detail === null) return;
    const reason = prompt(
      `Delete quote #${detail.quoteNumber}?\n\nIts lines and price rows are deleted with it; ` +
      `the quote number is never reused.\n\n` +
      `Reason for deleting (recorded in the audit history):`,
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to delete a quote."); return; }
    try {
      await api(`/api/quotes/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      router.push("/quotes");
    } catch (e) {
      const message = (e as Error).message;
      // The §5.14 refusal ("order(s) … still price from it") becomes the discoverable blockers
      // panel (the parts/[id] removePart precedent) — the list derives from a FRESH detail so it
      // names what is blocking right now, with the Excel export riding the existing route.
      // Deliberately NOT adopt(fresh): delete is the one action allowed while the form is dirty
      // (report deviation 3 — "a refusal leaves the draft untouched"), so adopting here would
      // silently discard the user's unsaved edits, the exact clobber the dirty-lock model
      // exists to prevent (review fix round, Important 1). The panel gets the fresh truth; the
      // per-line indicators keep the load-time links until the next adopt — the server guard,
      // not the indicator, is the enforcement.
      if (e instanceof ApiError && e.status === 400 && message.includes("still price from it")) {
        try {
          const fresh = await api<QuoteDetailData>(`/api/quotes/${id}`);
          const list = blockersFrom(fresh);
          if (list.length > 0) { setBlocked({ list }); setError(null); return; }
        } catch (listErr) {
          setError(`${message} — the list of blocking orders could not be refreshed ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError(message);
    }
  }

  // ---- Print (Task 10; the InvoiceDetail.tsx `printInvoice` precedent — POST, stream the blob
  // into a new tab, bump the documents list so the just-archived print appears). Legal while the
  // form is dirty: the print renders the SAVED quote, and the archived paper is the record of
  // what the server holds — nothing here adopts or discards the draft. ----

  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [docsRefresh, setDocsRefresh] = useState(0);

  async function printQuote() {
    setPrinting(true);
    setPrintError(null);
    try {
      const res = await fetch(`/api/quotes/${id}/print`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
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

  // ---- Line-tree local edits (saved only by Save) ----

  function patchLine(key: string, linePatch: Partial<LineForm>) {
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...linePatch } : l)));
  }
  function addLine() {
    setLines((cur) => [...cur, {
      key: newKey(), partId: null,
      partNumberText: "", partNameText: "", partDescriptionText: "", materialText: "",
      eachWeight: "", quotedQty: "", quotedUnlimited: false, prices: [], linkedOrders: [],
    }]);
  }
  function removeLine(key: string) {
    setLines((cur) => cur.filter((l) => l.key !== key));
  }
  function moveLine(index: number, dir: -1 | 1) {
    setLines((cur) => {
      const j = index + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }
  function patchPrice(lineKey: string, priceKey: string, pricePatch: Partial<PriceForm>) {
    setLines((cur) => cur.map((l) => (l.key === lineKey
      ? { ...l, prices: l.prices.map((p) => (p.key === priceKey ? { ...p, ...pricePatch } : p)) }
      : l)));
  }
  function addPrice(lineKey: string, stepId: string) {
    const step = stepCodes.find((s) => s.id === stepId);
    setLines((cur) => cur.map((l) => (l.key === lineKey
      ? {
        ...l,
        prices: [...l.prices, {
          key: newKey(), processStepCodeId: stepId,
          stepCode: step?.name ?? "", stepName: "",
          setupCharge: "", unitPrice: "", minimumCharge: "",
          pricePer: "EACH" as PricePerValue, notes: "", breaks: [],
        }],
      }
      : l)));
  }
  function removePrice(lineKey: string, priceKey: string) {
    setLines((cur) => cur.map((l) => (l.key === lineKey
      ? { ...l, prices: l.prices.filter((p) => p.key !== priceKey) } : l)));
  }
  function movePrice(lineKey: string, index: number, dir: -1 | 1) {
    setLines((cur) => cur.map((l) => {
      if (l.key !== lineKey) return l;
      const j = index + dir;
      if (j < 0 || j >= l.prices.length) return l;
      const next = [...l.prices];
      [next[index], next[j]] = [next[j], next[index]];
      return { ...l, prices: next };
    }));
  }
  /** The 5A basis-change warning (PricingSection.changePricePer, same wording): moving a row
   *  among the non-LOT units while it has breaks silently changes what every stored number
   *  means — warn, don't refuse, don't re-derive. LOT-with-breaks stays the server's refusal,
   *  surfaced verbatim at save. */
  function changePricePer(lineKey: string, price: PriceForm, next: PricePerValue) {
    if (next === price.pricePer) return;
    if (price.breaks.length > 0 && price.pricePer !== "LOT" && next !== "LOT") {
      const ok = confirm(
        `This operation has ${price.breaks.length} price break(s). Its Unit price, and every ` +
        `break's own threshold and price, are all read today as ${PRICE_PER_LABELS[price.pricePer]} ` +
        `amounts. Switching to ${PRICE_PER_LABELS[next]} does not change any of those stored ` +
        `numbers — every one of them will be read as a ${PRICE_PER_LABELS[next]} amount from now ` +
        `on. Continue?`,
      );
      if (!ok) return;
    }
    patchPrice(lineKey, price.key, { pricePer: next });
  }
  function patchBreak(lineKey: string, priceKey: string, breakKey: string, field: "threshold" | "price", value: string) {
    setLines((cur) => cur.map((l) => (l.key === lineKey
      ? {
        ...l,
        prices: l.prices.map((p) => (p.key === priceKey
          ? { ...p, breaks: p.breaks.map((b) => (b.key === breakKey ? { ...b, [field]: value } : b)) }
          : p)),
      }
      : l)));
  }
  // Per-price "add a break" draft, keyed by price KEY (the PricingSection breakDrafts shape).
  const [breakDrafts, setBreakDrafts] = useState<Record<string, { threshold: string; price: string }>>({});
  const draftFor = (priceKey: string) => breakDrafts[priceKey] ?? { threshold: "", price: "" };
  function addBreak(lineKey: string, priceKey: string) {
    const draft = draftFor(priceKey);
    if (!draft.threshold || !draft.price) return;
    setLines((cur) => cur.map((l) => (l.key === lineKey
      ? {
        ...l,
        prices: l.prices.map((p) => (p.key === priceKey
          ? { ...p, breaks: [...p.breaks, { key: newKey(), threshold: draft.threshold, price: draft.price }] }
          : p)),
      }
      : l)));
    setBreakDrafts((cur) => ({ ...cur, [priceKey]: { threshold: "", price: "" } }));
  }
  function removeBreak(lineKey: string, priceKey: string, breakKey: string) {
    setLines((cur) => cur.map((l) => (l.key === lineKey
      ? {
        ...l,
        prices: l.prices.map((p) => (p.key === priceKey
          ? { ...p, breaks: p.breaks.filter((b) => b.key !== breakKey) } : p)),
      }
      : l)));
  }

  // ---- Attach part (the dedicated route — an immediate, audited action; spec §4.1) ----

  const [attachPicks, setAttachPicks] = useState<Record<string, string>>({});
  async function attachPart(line: LineForm) {
    const partId = attachPicks[line.key];
    if (!partId || line.id === undefined) return;
    try {
      const res = await api<QuoteMutationData>(`/api/quotes/${id}/attach-part`, {
        method: "POST", body: JSON.stringify({ lineId: line.id, partId }),
      });
      adopt(res);
      setOverlapWarnings(res.warnings);
      setAttachPicks((cur) => ({ ...cur, [line.key]: "" }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---- Rendering ----

  if (detail === null || header === null) {
    return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;
  }

  const saveTitle = editGate.disabled ? editGate.title
    : saving ? "Saving…" : !dirty ? "No unsaved changes" : undefined;

  /** Part display for a part-linked line: catalog row first (covers re-picks), the detail line's
   *  own resolved identity as fallback when the id is the loaded one (covers a missing
   *  parts.view or a catalog fetch failure — the R3 honest-select rule). */
  function partDisplay(line: LineForm): { partNumber: string; name: string; material: string; eachWeight: string } {
    const fromCatalog = customerParts.find((p) => p.id === line.partId);
    if (fromCatalog) {
      return {
        partNumber: fromCatalog.partNumber, name: fromCatalog.name,
        material: fromCatalog.materialName ?? "", eachWeight: String(fromCatalog.eachWeight),
      };
    }
    const loaded = detail?.lines.find((dl) => dl.id === line.id);
    if (loaded && loaded.partId === line.partId) {
      return {
        partNumber: loaded.partNumber, name: loaded.partName, material: loaded.material,
        eachWeight: loaded.eachWeight === null ? "" : String(loaded.eachWeight),
      };
    }
    return { partNumber: "", name: "", material: "", eachWeight: "" };
  }

  function lineCard(line: LineForm, index: number) {
    const linked = line.linkedOrders.length > 0;
    // §5.14, said up front: a linked line's part cannot be changed and the line cannot be
    // removed — a vanished or re-pointed line would silently re-price the named orders.
    const linkLockTitle = linked
      ? `Order(s) ${linkedOrderNumbers(line.linkedOrders)} still price from this line — its part ` +
        "cannot be changed and the line cannot be removed while they do"
      : undefined;
    const lastLine = lines.length === 1;
    const removeGate: Gate = editGate.disabled ? editGate
      : linked ? { allowed: false, disabled: true, title: linkLockTitle }
        : lastLine ? { allowed: false, disabled: true, title: "A quote must keep at least one line" }
          : editGate;
    const display = line.partId !== null ? partDisplay(line) : null;
    const attachGate: Gate = editGate.disabled ? editGate
      : dirty ? { allowed: false, disabled: true, title: "Save or discard your changes first" }
        : !partsGate.allowed ? { allowed: false, disabled: true, title: partsGate.title }
          : editGate;

    return (
      <div key={line.key} className="rounded border p-3">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div className="text-sm">
            <span className="font-medium">Line {index + 1}</span>
            {line.partId !== null
              ? <span className="ml-2 font-mono">{display?.partNumber}</span>
              : <span className="ml-2 text-slate-500">free text</span>}
            {linked && (
              <span className="ml-3 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-800">
                Priced on order(s):{" "}
                {line.linkedOrders.map((o, i) => (
                  <span key={o.id}>
                    {i > 0 && ", "}
                    <Link href={`/orders/${o.id}`} className="underline">#{o.orderNumber}</Link>
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => moveLine(index, -1)}
                    disabled={editGate.disabled || index === 0} title={editGate.title} aria-label="Move line up"
                    className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">↑</button>
            <button type="button" onClick={() => moveLine(index, 1)}
                    disabled={editGate.disabled || index === lines.length - 1} title={editGate.title} aria-label="Move line down"
                    className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">↓</button>
            <button type="button" onClick={() => removeLine(line.key)}
                    disabled={removeGate.disabled} title={removeGate.title}
                    className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
              Remove line
            </button>
          </div>
        </div>

        {/* ---- Part identity: part-picker vs free-text (spec §4.1's XOR, ruling 1) ---- */}
        {line.partId !== null ? (
          <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
            {linked ? (
              <div className="block">
                Part
                <div className="mt-1 rounded border bg-slate-50 px-2 py-1" title={linkLockTitle}>
                  <span className="font-mono">{display?.partNumber}</span> — {display?.name}
                </div>
              </div>
            ) : (
              <>
                <label className="block">
                  Part
                  <select value={line.partId}
                          disabled={editGate.disabled || !partsGate.allowed}
                          title={editGate.disabled ? editGate.title : partsGate.allowed ? undefined : partsGate.title}
                          onChange={(e) => patchLine(line.key, { partId: e.target.value })}
                          className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
                    {/* Synthesized current option when the catalog lacks the id (R3). */}
                    {!customerParts.some((p) => p.id === line.partId) && (
                      <option value={line.partId}>{display?.partNumber || "(current part)"}</option>
                    )}
                    {customerParts.filter((p) => p.active || p.id === line.partId).map((p) => (
                      <option key={p.id} value={p.id}>{p.partNumber} — {p.name}{p.active ? "" : " (inactive)"}</option>
                    ))}
                  </select>
                </label>
                <button type="button"
                        onClick={() => patchLine(line.key, {
                          partId: null,
                          // Prefill from what the paper currently shows, so the XOR rule is
                          // satisfied and the printed identity survives the detach.
                          partNumberText: display?.partNumber ?? "",
                          partNameText: display?.name ?? "",
                          materialText: display?.material ?? "",
                          eachWeight: display?.eachWeight ?? "",
                        })}
                        disabled={editGate.disabled} title={editGate.title}
                        className="pb-1 text-xs text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
                  Switch to free text
                </button>
              </>
            )}
            <div className="text-xs text-slate-500">
              {display?.name}{display?.material ? ` · ${display.material}` : ""}
              {display?.eachWeight ? ` · ${display.eachWeight} lb ea` : ""} (live from the part)
            </div>
          </div>
        ) : (
          <div className="mb-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <label className="block">
              Part number (free text)
              <input value={line.partNumberText} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchLine(line.key, { partNumberText: e.target.value })}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            <label className="block">
              Name
              <input value={line.partNameText} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchLine(line.key, { partNameText: e.target.value })}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            <label className="block">
              Material
              <input value={line.materialText} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchLine(line.key, { materialText: e.target.value })}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            <label className="block">
              Each weight (lb)
              <input value={line.eachWeight} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchLine(line.key, { eachWeight: e.target.value })}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            <label className="col-span-2 block">
              Description
              <input value={line.partDescriptionText} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchLine(line.key, { partDescriptionText: e.target.value })}
                     className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
            </label>
            {line.id !== undefined ? (
              // The dedicated attach-part action (spec §4.1: an audited quotes.edit act — from
              // then on the line auto-links). Immediate, so it adopts a fresh detail.
              <div className="flex items-end gap-2">
                <label className="block">
                  Attach part
                  <select value={attachPicks[line.key] ?? ""}
                          disabled={attachGate.disabled} title={attachGate.title}
                          onChange={(e) => setAttachPicks((cur) => ({ ...cur, [line.key]: e.target.value }))}
                          className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
                    <option value="">Part…</option>
                    {customerParts.filter((p) => p.active).map((p) => (
                      <option key={p.id} value={p.id}>{p.partNumber} — {p.name}</option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={() => void attachPart(line)}
                        disabled={attachGate.disabled || !(attachPicks[line.key] ?? "")}
                        title={attachGate.disabled ? attachGate.title : !(attachPicks[line.key] ?? "") ? "Pick a part first" : undefined}
                        className="rounded border bg-white px-2 py-1 disabled:cursor-not-allowed disabled:text-slate-400">
                  Attach
                </button>
              </div>
            ) : (
              <label className="block">
                Use memorized part instead
                <select value=""
                        disabled={editGate.disabled || !partsGate.allowed}
                        title={editGate.disabled ? editGate.title : partsGate.allowed ? undefined : partsGate.title}
                        onChange={(e) => { if (e.target.value) patchLine(line.key, { partId: e.target.value }); }}
                        className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
                  <option value="">Part…</option>
                  {customerParts.filter((p) => p.active).map((p) => (
                    <option key={p.id} value={p.id}>{p.partNumber} — {p.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {/* ---- Quoted quantity (ruling 9 — informational; brackets remain the breaks' job) ---- */}
        <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Quoted qty (&quot;based on N pcs&quot;)
            <input value={line.quotedQty} inputMode="numeric"
                   readOnly={!editGate.allowed || line.quotedUnlimited}
                   title={editGate.disabled ? editGate.title : line.quotedUnlimited ? "Untick Unlimited to quote a quantity" : undefined}
                   onChange={(e) => patchLine(line.key, { quotedQty: e.target.value })}
                   className="mt-1 w-32 rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="flex items-center gap-1 pb-1">
            <input type="checkbox" checked={line.quotedUnlimited}
                   disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => patchLine(line.key, {
                     quotedUnlimited: e.target.checked,
                     // Mutually exclusive (the service 400s the pair) — ticking clears the qty.
                     ...(e.target.checked ? { quotedQty: "" } : {}),
                   })} />
            Unlimited
          </label>
        </div>

        {/* ---- Price rows (ruling 2: the exact PartPrice mirror — the 5A grid UX) ---- */}
        <h3 className="mb-1 text-xs font-medium text-slate-600">Pricing</h3>
        {line.prices.length === 0 && (
          <p className="mb-2 text-sm text-slate-500">
            No priced operations yet — an empty agreement invoices as needs-price, never part
            prices (ruling 4).
          </p>
        )}
        <div className="mb-2 space-y-3">
          {line.prices.map((price, pIdx) => {
            const hasCode = stepCodes.some((c) => c.id === price.processStepCodeId);
            return (
              <div key={price.key} className="rounded border bg-slate-50/50 p-2">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <select value={price.processStepCodeId} disabled={editGate.disabled || !stepCodesReady}
                          title={!stepCodesReady ? "Options failed to load — reload the page" : editGate.title}
                          onChange={(e) => patchPrice(line.key, price.key, { processStepCodeId: e.target.value })}
                          className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
                    {!hasCode && (
                      <option value={price.processStepCodeId}>
                        {price.stepCode}{price.stepName ? ` — ${price.stepName}` : ""}
                      </option>
                    )}
                    {stepCodes.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>
                    ))}
                  </select>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => movePrice(line.key, pIdx, -1)}
                            disabled={editGate.disabled || pIdx === 0} title={editGate.title} aria-label="Move operation up"
                            className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">↑</button>
                    <button type="button" onClick={() => movePrice(line.key, pIdx, 1)}
                            disabled={editGate.disabled || pIdx === line.prices.length - 1}
                            title={editGate.title} aria-label="Move operation down"
                            className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">↓</button>
                    <button type="button" onClick={() => removePrice(line.key, price.key)}
                            disabled={editGate.disabled} title={editGate.title}
                            className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                      Remove operation
                    </button>
                  </div>
                </div>

                <div className="mb-2 grid grid-cols-2 gap-3 md:grid-cols-5">
                  <label className="block text-sm">
                    Setup charge
                    <input value={price.setupCharge} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patchPrice(line.key, price.key, { setupCharge: e.target.value })}
                           className="mt-1 w-full rounded border px-2 py-1 text-right read-only:bg-slate-50" />
                  </label>
                  <label className="block text-sm">
                    Unit price
                    <input value={price.unitPrice} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patchPrice(line.key, price.key, { unitPrice: e.target.value })}
                           className="mt-1 w-full rounded border px-2 py-1 text-right read-only:bg-slate-50" />
                  </label>
                  <label className="block text-sm">
                    Minimum charge
                    <input value={price.minimumCharge} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patchPrice(line.key, price.key, { minimumCharge: e.target.value })}
                           className="mt-1 w-full rounded border px-2 py-1 text-right read-only:bg-slate-50" />
                  </label>
                  <label className="block text-sm">
                    Price per
                    <select value={price.pricePer} disabled={editGate.disabled} title={editGate.title}
                            onChange={(e) => changePricePer(line.key, price, e.target.value as PricePerValue)}
                            className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-100">
                      {PRICE_PER.map((p) => <option key={p} value={p}>{PRICE_PER_LABELS[p]}</option>)}
                    </select>
                  </label>
                  <label className="block text-sm">
                    Quote notes (print)
                    <input value={price.notes} readOnly={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patchPrice(line.key, price.key, { notes: e.target.value })}
                           className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
                  </label>
                </div>

                <h4 className="mb-1 text-xs font-medium text-slate-600">Price breaks</h4>
                {price.breaks.length > 0 && (
                  <table className="mb-2 w-full text-sm">
                    <thead>
                      <tr className="text-left"><th className="py-1">Threshold</th><th>Price</th><th /></tr>
                    </thead>
                    <tbody>
                      {price.breaks.map((b) => (
                        <tr key={b.key} className="border-t">
                          <td className="py-1">
                            <input value={b.threshold} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                                   onChange={(e) => patchBreak(line.key, price.key, b.key, "threshold", e.target.value)}
                                   className="w-24 rounded border px-1 py-0.5 text-right read-only:bg-slate-50" />
                          </td>
                          <td>
                            <input value={b.price} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                                   onChange={(e) => patchBreak(line.key, price.key, b.key, "price", e.target.value)}
                                   className="w-24 rounded border px-1 py-0.5 text-right read-only:bg-slate-50" />
                          </td>
                          <td className="text-right">
                            <button type="button" onClick={() => removeBreak(line.key, price.key, b.key)}
                                    disabled={editGate.disabled} title={editGate.title}
                                    className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                              delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="flex gap-2">
                  <input value={draftFor(price.key).threshold} placeholder="Threshold" inputMode="decimal"
                         disabled={editGate.disabled} title={editGate.title}
                         onChange={(e) => setBreakDrafts((cur) => ({ ...cur, [price.key]: { ...draftFor(price.key), threshold: e.target.value } }))}
                         className="w-24 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
                  <input value={draftFor(price.key).price} placeholder="Price" inputMode="decimal"
                         disabled={editGate.disabled} title={editGate.title}
                         onChange={(e) => setBreakDrafts((cur) => ({ ...cur, [price.key]: { ...draftFor(price.key), price: e.target.value } }))}
                         className="w-24 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
                  <button type="button" onClick={() => addBreak(line.key, price.key)}
                          disabled={editGate.disabled || !draftFor(price.key).threshold || !draftFor(price.key).price}
                          title={editGate.disabled ? editGate.title
                            : !draftFor(price.key).threshold || !draftFor(price.key).price
                              ? "Enter a threshold and price first" : undefined}
                          className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                    Add break
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-end gap-2">
          <select value="" disabled={editGate.disabled || !stepCodesReady}
                  title={!stepCodesReady ? "Options failed to load — reload the page" : editGate.title}
                  onChange={(e) => { if (e.target.value) addPrice(line.key, e.target.value); }}
                  className="rounded border px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-slate-100">
            <option value="">Add operation: code…</option>
            {stepCodes.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          Quote #{detail.quoteNumber}
          <span className="ml-3 rounded bg-slate-100 px-2 py-0.5 text-base font-normal text-slate-600">
            {QUOTE_STATUS_LABELS[detail.status]}
          </span>
          {detail.expired && (
            <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-base font-normal text-amber-800">
              {QUOTE_EXPIRED_LABEL}
            </span>
          )}
          {deleted && (
            <span className="ml-2 rounded bg-slate-200 px-2 py-0.5 text-base font-normal text-slate-700">
              Deleted
            </span>
          )}
        </h1>
        <div className="flex items-center gap-2">
          <button onClick={() => void printQuote()} disabled={!printGate.allowed || printing} title={printGate.title}
                  className="rounded border bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
            {printing ? "Printing…" : "Print"}
          </button>
          {detail.status === "OPEN" ? (
            <button onClick={() => void closeQuote()} disabled={closeGate.disabled} title={closeGate.title}
                    className="rounded border bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
              Close…
            </button>
          ) : (
            <button onClick={() => void reopenQuote()} disabled={reopenGate.disabled} title={reopenGate.title}
                    className="rounded border bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400">
              Reopen…
            </button>
          )}
          <button onClick={() => void deleteQuote()} disabled={deleteGate.disabled} title={deleteGate.title}
                  className="rounded border border-red-600 px-3 py-1.5 text-sm text-red-600 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
            Delete…
          </button>
        </div>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {printError && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{printError}</p>}
      {optionsError && (
        <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{optionsError}</p>
      )}
      {overlapWarnings.length > 0 && (
        // Ruling 7: overlapping open quotes for the same part WARN at save and never block —
        // the house amber warnings list (ShipmentDetail.tsx's §5.7 banner).
        <ul className="mb-3 list-disc space-y-0.5 rounded bg-amber-50 p-2 pl-7 text-sm text-amber-800">
          {overlapWarnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {closed && (
        <p className="mb-3 rounded bg-slate-100 p-2 text-sm text-slate-700">
          Closed — {detail.closeReason || "no reason recorded"}
          {detail.closedByName && ` — by ${detail.closedByName}`}
          {detail.closedAt !== null && ` on ${new Date(detail.closedAt).toLocaleString()}`}.
          Existing links keep pricing their orders; it no longer prices new ones.
        </p>
      )}
      {closeWarning && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="mb-1 font-medium">
            {closeWarning.length} open order(s) still price from this quote and are not yet fully
            invoiced:
          </p>
          <ul className="mb-2 flex flex-wrap gap-2">
            {closeWarning.map((o) => (
              <li key={o.id}>
                <Link href={`/orders/${o.id}`} className="text-blue-700 underline">#{o.orderNumber}</Link>
              </li>
            ))}
          </ul>
          <p className="mb-2 text-slate-700">
            Their stored links keep pricing them — invoices for these orders will still use this
            quote&apos;s rows (judged at link time).
          </p>
          <button onClick={() => setCloseWarning(null)} className="text-slate-600">dismiss</button>
        </div>
      )}
      {blocked && (
        <BlockerPanel
          label="quote"
          rowName={`#${detail.quoteNumber}`}
          list={blocked.list}
          action="delete"
          exportHref={`/api/quotes/${id}/blockers/export`}
          onDismiss={() => setBlocked(null)}
          note={"Unlinking is an order-side edit: re-pick or unlink the quote on each order's " +
            "line, or invoice the orders through — then the delete goes through."}
        />
      )}

      {/* ---- Header (single-save; the notes pair saves together with everything else) ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Header</h2>
          <div className="flex items-center gap-3">
            {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
            <button onClick={discardChanges} disabled={!dirty}
                    title={dirty ? undefined : "No unsaved changes"}
                    className="text-sm text-slate-600 underline disabled:cursor-not-allowed disabled:text-slate-300 disabled:no-underline">
              Discard changes
            </button>
            <button onClick={() => void save()} disabled={editGate.disabled || !dirty || saving} title={saveTitle}
                    className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div className="block">
            Customer
            <div className="mt-1 rounded border bg-slate-50 px-2 py-1"
                 title="The customer on a quote cannot be changed — delete this quote and enter a new one">
              <Link href={`/customers/${detail.customerId}`} className="text-blue-700 underline">
                {detail.customerCode} · {detail.customerName}
              </Link>
            </div>
          </div>
          <label className="block">
            Contact (prints in the Attn block)
            <select value={header.contactId} disabled={contactGate.disabled} title={contactGate.title}
                    onChange={(e) => setHeader({ ...header, contactId: e.target.value })}
                    className="mt-1 w-full rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
              <option value="">No contact</option>
              {/* Synthesized current option when the list lacks the stored pick (R3) — a DELETED
                  contact renders blank server-side (deletion is deliberately not blocked). */}
              {header.contactId !== "" && !contacts.some((c) => c.id === header.contactId) && (
                <option value={header.contactId}>{detail.contactName || "(current contact)"}</option>
              )}
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>
              ))}
            </select>
          </label>
          <label className="block">
            Quoted by (signs the quote)
            <select value={header.quotedById} disabled={quotedByGate.disabled} title={quotedByGate.title}
                    onChange={(e) => setHeader({ ...header, quotedById: e.target.value })}
                    className="mt-1 w-full rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
              {!users.some((u) => u.id === header.quotedById) && (
                <option value={header.quotedById}>{detail.quotedByName}</option>
              )}
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.displayName}{!u.active && " (inactive)"}</option>
              ))}
            </select>
          </label>
          <label className="block">
            Quote date
            <input type="date" value={header.quoteDate} disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => setHeader({ ...header, quoteDate: e.target.value })}
                   className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <label className="block">
            Effective
            <input type="date" value={header.effectiveDate} disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => setHeader({ ...header, effectiveDate: e.target.value })}
                   className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <label className="block">
            Expires
            <input type="date" value={header.expiryDate} disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => setHeader({ ...header, expiryDate: e.target.value })}
                   className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <label className="block">
            Follow-up
            <input type="date" value={header.followUpDate} disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => setHeader({ ...header, followUpDate: e.target.value })}
                   className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <label className="block">
            RFQ number (prints)
            <input value={header.rfqNumber} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => setHeader({ ...header, rfqNumber: e.target.value })}
                   className="mt-1 w-full rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="block">
            Ending statement (prints in the footer)
            <select value={header.endingStatementId} disabled={editGate.disabled} title={editGate.title}
                    onChange={(e) => setHeader({ ...header, endingStatementId: e.target.value })}
                    className="mt-1 w-full rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
              <option value="">None</option>
              {header.endingStatementId !== "" && !statements.some((s) => s.id === header.endingStatementId) && (
                <option value={header.endingStatementId}>{detail.endingStatementName || "(current statement)"}</option>
              )}
              {statements.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{!s.active && " (inactive)"}</option>
              ))}
            </select>
            {header.endingStatementId === (detail.endingStatementId ?? "") && detail.endingStatementText !== "" && (
              <span className="mt-1 block text-xs text-slate-500">{detail.endingStatementText}</span>
            )}
          </label>
          <label className="block md:col-span-2">
            Notes (print on the quote)
            <textarea value={header.notes} rows={3} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => setHeader({ ...header, notes: e.target.value })}
                      className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
          </label>
          <label className="block">
            Internal notes (never print)
            <textarea value={header.internalNotes} rows={3} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => setHeader({ ...header, internalNotes: e.target.value })}
                      className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
          </label>
        </div>
      </section>

      {/* ---- Lines ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Lines</h2>
        <div className="mb-3 space-y-4">
          {lines.map((line, i) => lineCard(line, i))}
        </div>
        <button onClick={addLine} disabled={editGate.disabled} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add line
        </button>
      </section>

      {/* ---- Documents + History ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Documents</h2>
        <QuoteDocumentsList quoteId={id} viewGate={docsGate} refresh={docsRefresh} />
      </section>

      <div className="mb-6">
        <HistoryPanel entity="quote" entityId={id} />
      </div>
    </div>
  );
}
