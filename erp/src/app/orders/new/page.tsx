"use client";
// Order entry — the shop's keyboard-speed data-entry screen (design spec §11) and the page the
// spec's crash-safety promise lives on (autosaved drafts, task-13-brief.md).
//
// THE BINDING STATE MODEL (the 2C-3 lesson): every piece of state below is either something the
// user actually typed/chose, or an explicit override flag/value. Nothing server-derived — the
// selected part's eachWeight, the entry-defaults request date, the customer's defaultPo — is ever
// stored here; those compose with the typed state at render time (computeLineWeight below,
// entryDefaultRequestDate, selectedCustomer.defaultPo). `OrderDraftState` is exactly what gets
// autosaved, so its shape below IS the draft payload — there is no separate "what do we send to
// /api/order-drafts" mapping to drift from what the form actually holds.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { normalizeRequestNonce, submitWithConflictRetry } from "@/lib/idempotent-save";
import { resolveLeadValidity, type LeadValidityReport } from "@/lib/lead-validity";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { CERT_SCOPES, CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import { Combobox, type ComboboxOption } from "./Combobox";
import { OrderLineCard, computeLineWeight, findDuplicateSerials } from "./OrderLineCard";

// ---------------------------------------------------------------------------------------------
// Types. Exported so the colocated components (Combobox.tsx, OrderLineCard.tsx) can import the
// ones they need — the parts/[id]/page.tsx `Part` type precedent. Local mirrors of server row
// shapes, not imports from src/server/**, for the usual reason (CLAUDE.md): a client component
// pulling from there drags node:async_hooks and Prisma into the browser bundle.
// ---------------------------------------------------------------------------------------------

export type CustomerOption = {
  id: string; code: string; name: string;
  defaultPo: string; orderNotes: string; creditHold: boolean;
};

export type PartOption = {
  id: string; customerId: string; partNumber: string; name: string;
  eachWeight: number; serializationRequired: boolean;
  /** Whether the part's current process revision carries ≥1 step — surfaced by listParts
   *  (src/server/parts.ts) so the lead-part picker can show this up front (spec §11) rather than
   *  only after a pick. Irrelevant for riders, which never lock a revision. */
  hasProcessSteps: boolean;
  /** Certification chain (spec §6.1, Task 17): the part's own three-state override plus what a
   *  null would inherit (customer default, else plant — computed server-side, parts.ts). The
   *  untouched entry preview composes `certRequired ?? inheritedCertRequired` per line at render
   *  (2C-3: derive, never store), which is exactly `resolveCertSettings`'s own chain because
   *  every part in this customer's catalog shares this customer's defaults. */
  certRequired: boolean | null; certScope: CertScopeValue | null;
  inheritedCertRequired: boolean; inheritedCertScope: CertScopeValue;
};

type ContainerTypeOption = { id: string; name: string };

export type SerialDraft = { id: string; serial: string; description: string };

export type LineDraft = {
  id: string;
  partId: string | null;
  qty: string;
  /** null = show `computed eachWeight × qty`, recomputed every render; non-null = the user's own
   *  typed text, which wins until they use the "reset to computed" affordance. */
  weightOverride: string | null;
  serials: SerialDraft[];
  /** The three-way quote-link pick (spec §5.2, Task 9). ABSENT/undefined = untouched — the
   *  create body OMITS `quoteLineId` and the SERVER's auto-resolution stays authoritative at the
   *  moment it saves; a string = the operator's explicit re-pick; null = the explicit "No quote".
   *  The previewed auto-link's id is NEVER copied in here (QuoteLinkPicker's own contract: the
   *  preview is display, the sentinel is state), which is what structurally guarantees an
   *  untouched control sends ABSENT, not the displayed id. Autosave round-trip: JSON.stringify
   *  drops undefined keys, so a draft carries the pick exactly — absent key = auto, null and an
   *  explicit id survive as themselves (`pickOrUndefined` restores all three states). */
  quoteLineIdOverride?: string | null;
};

export type ContainerDraft = {
  id: string; typeId: string | null; count: string; qty: string; tareWeight: string; grossWeight: string;
  /** §3.22 (Task 17): the customer's own bin id — the ticket's "Cust Cont Id" column. */
  customerContainerId: string;
};

export type ChargeDraft = { id: string; description: string; amount: string };

/** Exactly what gets PUT to /api/order-drafts as `{ payload }`, and exactly what a resumed draft
 *  hydrates back into state — typed values and override flags only, never a server default. */
export type OrderDraftState = {
  /**
   * This draft's idempotency nonce (fix-wave R4 finding 5), minted when a fresh form mounts and
   * carried through every autosave. It lives INSIDE the payload deliberately: that is what makes
   * two tabs resuming the same draft — and the automatic 409 retry of either one's save — the
   * same request as far as `createOrder` is concerned, so they settle on ONE order instead of two.
   * Not something the user types, so `isDraftEmpty` ignores it exactly as it ignores the
   * synthetic row ids.
   */
  clientRequestId: string;
  customerId: string | null;
  /** null = show the selected customer's defaultPo; non-null = the user's own text. */
  poOverride: string | null;
  vsOrderNumber: string;
  customerJobNo: string;
  /** Cert preview overrides (spec §6.1 "overridable at entry", Task 17). null = show the chain's
   *  own resolution, recomputed every render from the picked parts (2C-3: nothing derived is
   *  ever stored); non-null = the user's explicit answer, which wins until reset and is the only
   *  case where the create body carries the key at all. */
  certRequiredOverride: boolean | null;
  certScopeOverride: CertScopeValue | null;
  /** null = show today (recomputed every render); non-null = the user's own text. */
  receivedDateOverride: string | null;
  /** null = show the entry-defaults fetch result; non-null = the user's own text. */
  requestDateOverride: string | null;
  targetDate: string | null;
  notes: string;
  lines: LineDraft[];
  containers: ContainerDraft[];
  charges: ChargeDraft[];
};

// ---------------------------------------------------------------------------------------------
// Blank-state builders and defensive normalization for a resumed draft.
// ---------------------------------------------------------------------------------------------

function blankLine(): LineDraft {
  return { id: crypto.randomUUID(), partId: null, qty: "", weightOverride: null, serials: [] };
}
function blankContainer(): ContainerDraft {
  return { id: crypto.randomUUID(), typeId: null, count: "", qty: "", tareWeight: "", grossWeight: "", customerContainerId: "" };
}
function blankCharge(): ChargeDraft {
  return { id: crypto.randomUUID(), description: "", amount: "" };
}
function blankDraft(): OrderDraftState {
  return {
    clientRequestId: crypto.randomUUID(),
    customerId: null, poOverride: null, vsOrderNumber: "", customerJobNo: "",
    certRequiredOverride: null, certScopeOverride: null,
    receivedDateOverride: null, requestDateOverride: null, targetDate: null,
    notes: "", lines: [blankLine()], containers: [], charges: [],
  };
}

// The autosaved payload is `unknown` on the wire (OrderDraft.payload is opaque Json) — normalize
// defensively on the way back in rather than trusting it blindly, the same caution
// buildStepOriginals's callers take with server data of unknown shape.
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function strOrNull(v: unknown): string | null { return typeof v === "string" ? v : null; }
/** The quote pick's three states must all survive the round trip — unlike `strOrNull`, a
 *  genuine null here means the explicit "No quote", so only a truly absent/garbage value
 *  degrades to undefined (= auto, the safe state: the server resolves). */
function pickOrUndefined(v: unknown): string | null | undefined {
  return v === null ? null : typeof v === "string" ? v : undefined;
}
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function normalizeLine(raw: unknown): LineDraft {
  const r = rec(raw);
  return {
    id: typeof r.id === "string" ? r.id : crypto.randomUUID(),
    partId: strOrNull(r.partId),
    qty: str(r.qty),
    weightOverride: strOrNull(r.weightOverride),
    serials: arr(r.serials).map((s) => {
      const sr = rec(s);
      return { id: typeof sr.id === "string" ? sr.id : crypto.randomUUID(), serial: str(sr.serial), description: str(sr.description) };
    }),
    quoteLineIdOverride: pickOrUndefined(r.quoteLineIdOverride),
  };
}
function normalizeContainer(raw: unknown): ContainerDraft {
  const r = rec(raw);
  return {
    id: typeof r.id === "string" ? r.id : crypto.randomUUID(),
    typeId: strOrNull(r.typeId), count: str(r.count), qty: str(r.qty),
    tareWeight: str(r.tareWeight), grossWeight: str(r.grossWeight),
    customerContainerId: str(r.customerContainerId),
  };
}
/** A resumed draft's stored override is trusted only when it is one of the three real scopes —
 *  anything else (a hand-edited payload, a future enum change) degrades to "no override", which
 *  is the safe state: the preview re-derives. */
function scopeOrNull(v: unknown): CertScopeValue | null {
  return typeof v === "string" && (CERT_SCOPES as readonly string[]).includes(v) ? (v as CertScopeValue) : null;
}
function boolOrNull(v: unknown): boolean | null { return typeof v === "boolean" ? v : null; }
function normalizeCharge(raw: unknown): ChargeDraft {
  const r = rec(raw);
  return { id: typeof r.id === "string" ? r.id : crypto.randomUUID(), description: str(r.description), amount: str(r.amount) };
}
function normalizeDraft(raw: unknown): OrderDraftState {
  const r = rec(raw);
  const lines = arr(r.lines).map(normalizeLine);
  return {
    // KEPT, not regenerated: a resumed draft carrying the same nonce is precisely how the second
    // tab's save is recognized as the first tab's request rather than a new order. A draft
    // autosaved before this field existed gets a fresh one (normalizeRequestNonce).
    clientRequestId: normalizeRequestNonce(r.clientRequestId),
    customerId: strOrNull(r.customerId),
    poOverride: strOrNull(r.poOverride),
    vsOrderNumber: str(r.vsOrderNumber),
    customerJobNo: str(r.customerJobNo),
    certRequiredOverride: boolOrNull(r.certRequiredOverride),
    certScopeOverride: scopeOrNull(r.certScopeOverride),
    receivedDateOverride: strOrNull(r.receivedDateOverride),
    requestDateOverride: strOrNull(r.requestDateOverride),
    targetDate: strOrNull(r.targetDate),
    notes: str(r.notes),
    lines: lines.length > 0 ? lines : [blankLine()],
    containers: arr(r.containers).map(normalizeContainer),
    charges: arr(r.charges).map(normalizeCharge),
  };
}

/** True for the untouched blank starting state (ignoring the synthetic local `id` fields and the
 *  draft's own `clientRequestId` nonce, none of which is anything the user typed and all of which
 *  differ from a freshly-generated blank's by construction). Gates autosave so that simply
 *  visiting this page and leaving — without typing anything — does not leave behind a draft that
 *  greets the next visit with a "Resume a draft?" prompt for nothing (caught live in this task's
 *  own dev-server smoke test, not a hypothetical). A draft that WAS resumed or edited and is then
 *  cleared back to blank still autosaves normally — this only suppresses the FIRST write. */
function isDraftEmpty(d: OrderDraftState): boolean {
  return d.customerId === null && d.poOverride === null && d.vsOrderNumber === ""
    && d.customerJobNo === "" && d.certRequiredOverride === null && d.certScopeOverride === null
    && d.receivedDateOverride === null && d.requestDateOverride === null && d.targetDate === null
    && d.notes === "" && d.containers.length === 0 && d.charges.length === 0
    && d.lines.length === 1 && d.lines[0].partId === null && d.lines[0].qty === ""
    && d.lines[0].weightOverride === null && d.lines[0].serials.length === 0
    && d.lines[0].quoteLineIdOverride === undefined;
}

function netWeight(gross: string, tare: string): number | null {
  if (gross.trim() === "" || tare.trim() === "") return null;
  const g = Number(gross), t = Number(tare);
  if (!Number.isFinite(g) || !Number.isFinite(t)) return null;
  return Math.round((g - t) * 100) / 100;
}

type DraftPrompt = { payload: unknown; updatedAt: string };

export default function NewOrderPage() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();

  const [draft, setDraft] = useState<OrderDraftState>(blankDraft);

  // Draft-resume gate: the form (and autosave) stay off-screen until either the mount-time check
  // finds no draft, or the user has answered Resume/Discard. Starting the form (and its 2s
  // autosave) BEFORE that question is answered would risk the blank draft's own autosave PUT
  // overwriting the very draft the banner is about to offer — see the mount effect below.
  const [draftPrompt, setDraftPrompt] = useState<DraftPrompt | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftPromptError, setDraftPromptError] = useState<string | null>(null);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [parts, setParts] = useState<PartOption[]>([]);
  const [containerTypes, setContainerTypes] = useState<ContainerTypeOption[]>([]);
  // F9 precedent (parts/[id]/page.tsx): a failed background list fetch gets its OWN banner, never
  // the shared `error` state a later successful save clears — otherwise a save elsewhere on the
  // page can silently erase the report that a picker's options failed to load.
  const [loadError, setLoadError] = useState<string | null>(null);
  const addLoadError = useCallback((message: string) => {
    setLoadError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);

  const [entryDefaultRequestDate, setEntryDefaultRequestDate] = useState<string | null>(null);
  // Fix-wave R4 finding 9: the lead-part check's verdict is stored WITH the line id it came from,
  // and read back only while that line is still the lead. A late report from a line the operator
  // has since removed (or that a removal demoted out of position 1) describes a part that is no
  // longer being ordered, and used to block — or unblock — Save on it. `resolveLeadValidity` is
  // that read; OrderLineCard's own effect cleanup is the other half, stopping an unmounted card
  // from reporting at all.
  const [leadReport, setLeadReport] = useState<LeadValidityReport | null>(null);
  const onLeadValidity = useCallback(
    (lineId: string, ok: boolean | null) => setLeadReport({ lineId, ok }), []);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set only when a save SUCCEEDS with non-empty warnings — the owner's standing "visibly, never
  // silently" ruling (HANDOFF issue #4 heritage) means a credit-hold or serialization notice
  // returned alongside a successful save must not vanish behind an immediate navigate. Zero
  // warnings still navigates immediately (below); this state exists only for the other case.
  const [savedOrder, setSavedOrder] =
    useState<{ id: string; orderNumber: number; warnings: string[]; print: boolean } | null>(null);
  // Phase 8B §5.6: null until the gate predicate is fetched; `ready:false` shows the blocking notice.
  const [readiness, setReadiness] =
    useState<{ ready: boolean; gaps: { label: string; href: string }[] } | null>(null);

  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");
  const processesGate = gate(perms, "processes.view");
  const saveGate = gate(perms, "orders.create");
  // The quote-link preview fetch (/api/quotes/eligible) is gated orders.view server-side; the
  // re-pick CONTROL itself is gated on the save permission this form feeds (§5.16 — saveGate).
  const ordersViewGate = gate(perms, "orders.view");

  // ---- mount-time fetches ----

  useEffect(() => {
    api<DraftPrompt | null>("/api/order-drafts").then((row) => {
      if (row && row.payload !== null) setDraftPrompt(row);
      else setDraftReady(true);
    }).catch((e) => {
      setDraftPromptError((e as Error).message);
      setDraftReady(true); // don't get stuck on "Loading…" forever over a failed draft check
    });
  }, []);

  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => addLoadError((e as Error).message));
  }, [customersGate.allowed, addLoadError]);

  useEffect(() => {
    // No customerId filter exists on GET /api/parts (verified against src/app/api/parts/route.ts
    // and listParts in src/server/parts.ts — only includeInactive/search) — fetch the whole
    // active catalog once and filter to the chosen customer client-side (customerParts below).
    if (!partsGate.allowed) return;
    api<PartOption[]>("/api/parts").then(setParts).catch((e) => addLoadError((e as Error).message));
  }, [partsGate.allowed, addLoadError]);

  useEffect(() => {
    // Session-only route (no permission gate beyond being signed in) — matches every other
    // pick-list consumer in the app.
    api<ContainerTypeOption[]>("/api/picklists/containerType").then(setContainerTypes)
      .catch((e) => addLoadError((e as Error).message));
  }, [addLoadError]);

  useEffect(() => {
    // The Phase 8B order-entry gate: if company identity + a chart of accounts are not configured,
    // createOrder is blocked server-side, so show the blocking notice instead of the form. This is
    // the SAME predicate the gate enforces (order-entry-readiness.ts), so the two cannot disagree.
    if (!saveGate.allowed) return;
    api<{ ready: boolean; gaps: { label: string; href: string }[] }>("/api/orders/entry-readiness")
      .then(setReadiness).catch((e) => addLoadError((e as Error).message));
  }, [saveGate.allowed, addLoadError]);

  // ---- entry-defaults (request date) — refetched whenever the customer, the LEAD part, or the
  // operator's own received-date override changes (fix-wave finding 1: the untouched preview
  // used to always compute from TODAY even after the received date was backdated on this same
  // form, so it could show a request date the eventual save — which computes from the OVERRIDDEN
  // received date, exactly like createOrder itself — would not agree with). ----

  const customerId = draft.customerId;
  const leadPartId = draft.lines[0]?.partId ?? null;
  const receivedDateOverride = draft.receivedDateOverride;
  const entryDefaultsLatest = useLatest();
  useEffect(() => {
    if (!customerId) { setEntryDefaultRequestDate(null); return; }
    const t = entryDefaultsLatest.next();
    const qs = new URLSearchParams({
      customerId,
      ...(leadPartId ? { partId: leadPartId } : {}),
      // Omitted while untouched — same "not overridden yet" shape as buildCreateBody's own
      // `receivedDate: draft.receivedDateOverride ?? undefined` — so the server bases the preview
      // on ITS OWN today, identically to what an unbackdated save would do.
      ...(receivedDateOverride ? { receivedDate: receivedDateOverride } : {}),
    });
    api<{ requestDate: string }>(`/api/orders/entry-defaults?${qs}`).then((r) => {
      if (entryDefaultsLatest.isCurrent(t)) setEntryDefaultRequestDate(r.requestDate);
    }).catch((e) => {
      if (entryDefaultsLatest.isCurrent(t)) addLoadError((e as Error).message);
    });
  }, [customerId, leadPartId, receivedDateOverride, entryDefaultsLatest, addLoadError]);

  // ---- autosave: 2s debounce PUT, gated until the resume/discard question is answered ----

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A ref, not state: handleSave below needs to suppress the NEXT scheduling synchronously (a
  // state flag would not be visible until a re-render), closing the common case of the autosave
  // debounce firing while a save is in flight and re-writing a draft the save's own transaction
  // is about to clear.
  const savingRef = useRef(false);
  // Set once, permanently, the moment a save actually SUCCEEDS — distinct from savingRef (which
  // only spans one attempt and resets on failure so autosave resumes for a retry). Nothing this
  // page instance does after a successful save should ever touch the draft row again: the
  // create transaction already cleared it, and (fix round 1) a successful save no longer always
  // navigates away immediately (see the warnings panel below), so the component can stay mounted
  // — and therefore keep re-running this effect — well past the point autosave must stop for good.
  const savedRef = useRef(false);
  // Tracks whether the draft has EVER held real content this page instance, independent of what
  // it holds right now — the untouched-blank guard below (isDraftEmpty) needs to tell "never
  // typed anything" apart from "typed something, then cleared it back to blank", which look
  // identical from isDraftEmpty(draft) alone.
  const hasEverBeenNonEmpty = useRef(false);
  // Single-flight queue for the actual request (the parts/[id]/page.tsx `serial()` precedent,
  // reduced to one key since there is only one draft): each attempt is wrapped in a thunk and
  // chained onto the previous attempt's settlement, so a second request never fires while one is
  // still in flight — two autosaves can never race each other out of order at the database.
  // Debounce alone only cancels a timer that HASN'T fired yet; it can't stop a request already
  // dispatched, which is exactly the gap handleSave's own `await autosaveChain.current` closes.
  const autosaveChain = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!draftReady || savingRef.current || savedRef.current) return;
    const empty = isDraftEmpty(draft);
    // Simply visiting the page and leaving — without typing anything — must not leave behind a
    // draft that greets the next visit with a "Resume a draft?" prompt for nothing (caught live
    // in this task's own dev-server smoke test). Once the draft HAS held content, though, clearing
    // it back to blank must actively clear the server-side row too (fix round 1) — otherwise the
    // last non-empty snapshot lingers there and resurrects the very same stale-prompt problem for
    // content the user deliberately discarded.
    if (empty && !hasEverBeenNonEmpty.current) return;
    if (!empty) hasEverBeenNonEmpty.current = true;

    const timer = setTimeout(() => {
      const payload = draft; // this timer's own snapshot, sent once it's this queue entry's turn
      const attempt = () => (empty
        ? api("/api/order-drafts", { method: "DELETE" })
        : api("/api/order-drafts", { method: "PUT", body: JSON.stringify({ payload }) }));
      autosaveChain.current = autosaveChain.current
        .then(attempt)
        .then(() => setAutosaveError(null))
        .catch((e) => setAutosaveError(`Draft autosave failed: ${(e as Error).message}`));
    }, 2000);
    autosaveTimer.current = timer;
    return () => clearTimeout(timer);
  }, [draft, draftReady]);

  function resumeDraft() {
    if (!draftPrompt) return;
    setDraft(normalizeDraft(draftPrompt.payload));
    setDraftPrompt(null);
    setDraftReady(true);
  }
  async function discardDraft() {
    try {
      await api("/api/order-drafts", { method: "DELETE" });
      setDraftPrompt(null);
      setDraftReady(true);
    } catch (e) {
      setDraftPromptError((e as Error).message);
    }
  }

  // ---- derived display values (composed at render, never persisted) ----

  const selectedCustomer = customers.find((c) => c.id === draft.customerId) ?? null;
  const customerParts = draft.customerId ? parts.filter((p) => p.customerId === draft.customerId) : [];
  // Composed at render from the id-keyed report, never stored as its own state — a stale verdict
  // about a line that is no longer the lead is simply not read (R4 finding 9).
  const leadValid = resolveLeadValidity(leadReport, draft.lines[0]?.id ?? null);
  const displayedPo = draft.poOverride ?? (selectedCustomer?.defaultPo ?? "");
  const displayedReceivedDate = draft.receivedDateOverride ?? formatDateOnly(todayDateOnly());
  const displayedRequestDate = draft.requestDateOverride ?? (entryDefaultRequestDate ?? "");

  // The §6.1 chain, composed AT RENDER from the picked parts (2C-3: derive, never store) —
  // `certRequired ?? inheritedCertRequired` per line IS `part ?? customer ?? plant`, because
  // parts.ts folds the customer default and the plant setting into `inheritedCert*` server-side.
  // Required is OR'd across every picked line (a rider's requirement is never dropped); scope
  // reads the LEAD alone. Until a lead part is picked there is nothing to resolve — `null` here
  // renders the controls disabled with that reason (§5.16), never a made-up "No".
  const linePartRows = draft.lines.map((l) => (l.partId ? parts.find((p) => p.id === l.partId) ?? null : null));
  const leadPartRow = linePartRows[0];
  const resolvedCertRequired: boolean | null = leadPartRow
    ? linePartRows.some((p) => p !== null && (p.certRequired ?? p.inheritedCertRequired))
    : null;
  const resolvedCertScope: CertScopeValue | null = leadPartRow
    ? (leadPartRow.certScope ?? leadPartRow.inheritedCertScope)
    : null;
  const displayedCertRequired = draft.certRequiredOverride ?? resolvedCertRequired;
  const displayedCertScope = draft.certScopeOverride ?? resolvedCertScope;
  const certPreviewReady = resolvedCertRequired !== null;

  const customerOptions: ComboboxOption[] = customers.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }));

  // ---- typed-state mutators ----

  function patch(p: Partial<OrderDraftState>) {
    setDraft((d) => ({ ...d, ...p }));
  }
  function patchLine(id: string, p: Partial<LineDraft>) {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.id === id ? { ...l, ...p } : l)) }));
  }
  function addLine() {
    setDraft((d) => ({ ...d, lines: [...d.lines, blankLine()] }));
  }
  function removeLine(id: string) {
    // At least one line always — the empty-state rule — so this is a no-op on the last one rather
    // than something the caller needs to guard against separately.
    setDraft((d) => (d.lines.length <= 1 ? d : { ...d, lines: d.lines.filter((l) => l.id !== id) }));
  }
  function patchContainer(id: string, p: Partial<ContainerDraft>) {
    setDraft((d) => ({ ...d, containers: d.containers.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
  }
  function addContainer() {
    setDraft((d) => ({ ...d, containers: [...d.containers, blankContainer()] }));
  }
  function removeContainer(id: string) {
    setDraft((d) => ({ ...d, containers: d.containers.filter((c) => c.id !== id) }));
  }
  function patchCharge(id: string, p: Partial<ChargeDraft>) {
    setDraft((d) => ({ ...d, charges: d.charges.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
  }
  function addCharge() {
    setDraft((d) => ({ ...d, charges: [...d.charges, blankCharge()] }));
  }
  function removeCharge(id: string) {
    setDraft((d) => ({ ...d, charges: d.charges.filter((c) => c.id !== id) }));
  }

  // ---- validation + save ----

  // Client-side pre-check for the common empty-state mistakes (spec's own empty-state rules) —
  // a UX nicety, not a substitute for the server's authoritative validation, which still runs
  // (and still wins) on every save.
  function validate(): string | null {
    if (!draft.customerId) return "Pick a customer.";
    if (draft.lines.length === 0) return "Add at least one part line.";
    for (const [i, line] of draft.lines.entries()) {
      const label = i === 0 ? "Lead line" : `Line ${i + 1}`;
      if (!line.partId) return `${label}: pick a part.`;
      const qty = Number(line.qty);
      if (!Number.isInteger(qty) || qty < 1) return `${label}: enter a quantity of at least 1.`;
      const part = parts.find((p) => p.id === line.partId);
      const weight = line.weightOverride !== null ? Number(line.weightOverride) : computeLineWeight(part, qty);
      if (weight === null || !(weight > 0)) return `${label}: enter a weight greater than zero.`;
      // The live inline "Duplicate serial" warning was previously advisory only — a duplicate
      // could still reach the server, which does reject it, just after a wasted round trip and a
      // less specific message than this one.
      const dupes = findDuplicateSerials(line.serials);
      if (dupes.size > 0) return `${label}: serial "${[...dupes][0]}" is entered twice.`;
    }
    if (leadValid === false) return "Lead line: this part has no process steps — choose a different lead part.";
    for (const [i, c] of draft.containers.entries()) {
      if (!c.typeId) return `Container ${i + 1}: pick a type.`;
      const count = Number(c.count);
      if (!Number.isInteger(count) || count < 1) return `Container ${i + 1}: enter a count of at least 1.`;
      // qty-per-container is optional, but a garbage (non-numeric) value must not silently become
      // "unset" — Number("abc") is NaN, and JSON.stringify(NaN) serializes to null, which would
      // otherwise reach the server as a quiet, valid-looking omission instead of the typo it is.
      if (c.qty.trim() !== "" && (!Number.isInteger(Number(c.qty)) || Number(c.qty) < 1)) {
        return `Container ${i + 1}: quantity per container must be a whole number of at least 1.`;
      }
    }
    for (const [i, c] of draft.charges.entries()) {
      if (!c.description.trim()) return `Charge ${i + 1}: enter a description.`;
    }
    return null;
  }

  function buildCreateBody() {
    return {
      customerId: draft.customerId,
      // The draft's own nonce (R4 finding 5) — sent on the first attempt AND, because handleSave
      // builds this body once and hands the SAME object to the retry, on the 409 retry too.
      clientRequestId: draft.clientRequestId,
      poNumber: displayedPo,
      vsOrderNumber: draft.vsOrderNumber,
      customerJobNo: draft.customerJobNo,
      // Omitted (never frozen to the client's preview) while untouched — the SERVER resolves and
      // freezes the chain at the moment it saves (spec §6.1), exactly like receivedDate below.
      // Only an explicit override travels.
      certRequired: draft.certRequiredOverride ?? undefined,
      certScope: draft.certScopeOverride ?? undefined,
      // Omitted (not frozen to the client's preview) while untouched — the server computes its
      // own "today"/business-day default at the moment it actually saves, which is the more
      // correct instant to read "today" from than whenever the form happened to render.
      receivedDate: draft.receivedDateOverride ?? undefined,
      requestDate: draft.requestDateOverride ?? undefined,
      targetDate: draft.targetDate,
      notes: draft.notes,
      lines: draft.lines.map((l) => {
        const part = parts.find((p) => p.id === l.partId);
        const qty = Number(l.qty);
        // Same trimmed-string wire shape either way (matching containers'/charges' decimal
        // fields below) — validate() has already confirmed this resolves to a real number > 0,
        // so String(...) here is never "NaN" or an empty string in practice.
        const weight = l.weightOverride !== null ? l.weightOverride.trim() : String(computeLineWeight(part, qty) ?? 0);
        return {
          partId: l.partId,
          qty,
          weight,
          serials: l.serials.map((s) => ({ serial: s.serial, description: s.description })),
          // Three-way (spec §5.2): the key is PRESENT only for an explicit pick (id) or an
          // explicit "No quote" (null); untouched sends ABSENT and the server auto-resolves at
          // save time — never the previewed id (LineDraft.quoteLineIdOverride's contract).
          ...(l.quoteLineIdOverride !== undefined ? { quoteLineId: l.quoteLineIdOverride } : {}),
        };
      }),
      containers: draft.containers.map((c) => ({
        typeId: c.typeId,
        count: Number(c.count),
        qty: c.qty.trim() === "" ? null : Number(c.qty),
        tareWeight: c.tareWeight.trim() === "" ? null : c.tareWeight.trim(),
        grossWeight: c.grossWeight.trim() === "" ? null : c.grossWeight.trim(),
        customerContainerId: c.customerContainerId,
      })),
      charges: draft.charges.map((c) => ({
        description: c.description.trim(),
        amount: c.amount.trim() === "" ? null : c.amount.trim(),
      })),
    };
  }

  /** `deduped` (fix-wave R4 finding 5) marks a response that is the order this same request
   *  already created — the retry's own first attempt, or the other tab's. It arrives with no
   *  warnings and is treated exactly like any other success below: navigate to the order. */
  type CreateResult = {
    order: { id: string; orderNumber: number }; warnings: string[]; deduped?: true;
  };

  async function submitOnce(body: unknown) {
    return api<CreateResult>("/api/orders", { method: "POST", body: JSON.stringify(body) });
  }

  /**
   * `print` is Save & Print (spec §11). The traveler is NOT rendered from here: the order has to
   * exist before it can be printed, and the hub is where prints live (the button, the per-load
   * menu, the archive). So Save & Print saves, then hands the hub a one-shot `?print=1`, which
   * DocumentsSection honours exactly once on arrival. Two shapes were considered and rejected —
   * printing inline before navigating (a second failure mode on the save path, and the resulting
   * PDF's own window would be lost across the navigation), and printing from the warnings panel
   * (which would print BEFORE the user has read the warnings). With warnings present the panel
   * still shows first; `print` rides on it and fires when the user clicks through to the order.
   */
  async function handleSave(print = false) {
    const problem = validate();
    if (problem) { setError(problem); return; }
    setError(null);
    // Cancel any pending (not-yet-fired) autosave timer, and stop the debounce effect from
    // scheduling a new one — savingRef is checked there synchronously (a state flag would not be
    // visible until a re-render).
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    savingRef.current = true;
    setSaving(true);
    const body = buildCreateBody();
    try {
      // Fix round 1: AWAIT any autosave request already dispatched (network round trip in
      // flight) before proceeding. Cancelling the timer above only stops a NEW one from being
      // scheduled — it does nothing about a PUT that already left the browser. Without this
      // await, that PUT can land after createOrder's own transaction clears the draft, upserting
      // it back to non-null: the next visit to this page would offer to "Resume" a draft for an
      // order that already saved, and an operator who clicked Resume and then Save again would
      // create a genuine duplicate order — exactly the outcome the no-duplication rule (spec
      // §15) exists to prevent. Awaiting the chain (rather than e.g. an AbortController) also
      // means the in-flight request still completes and reports its own real outcome, instead of
      // being silently cut off.
      await autosaveChain.current;
      // The T4-measured concurrent-save behavior: a 409 means the transaction wrote NOTHING and
      // consumed no order number (src/server/orders.ts), so retrying the identical body is the
      // documented-safe response, not a guess. `body` was built ONCE above and is handed through
      // by reference — fix-wave R4 finding 5: rebuilding it would mint a new `clientRequestId`,
      // and the retry would then create a SECOND order rather than being recognized as the same
      // request the first attempt already committed under another tab's (or its own) save.
      const result = await submitWithConflictRetry(body, submitOnce);
      // Permanently stop autosaving this page instance — belt to savingRef's suspenders. Matters
      // more than it did before fix round 1: a successful save with warnings no longer navigates
      // away immediately (below), so the component can stay mounted well past this point.
      savedRef.current = true;
      if (result.warnings.length > 0) {
        // Owner ruling, applied (HANDOFF issue #4 heritage: skipped/degraded outcomes are named
        // visibly, never silently) — a credit-hold or serialization warning returned alongside a
        // successful save must be SEEN, not raced past by an immediate navigate. Zero warnings
        // keeps the immediate navigate below; this is the one case that doesn't.
        setSaving(false);
        setSavedOrder({
          id: result.order.id, orderNumber: result.order.orderNumber, warnings: result.warnings, print,
        });
      } else {
        // createOrder clears the caller's draft inside the SAME transaction as the save — a
        // second, client-side DELETE here would be redundant and racy against that clear.
        router.push(`/orders/${result.order.id}${print ? "?print=1" : ""}`);
      }
    } catch (e) {
      // §5.13: no reload after an error. Every field above is left exactly as typed so the user
      // can fix the one thing that was wrong and retry without losing anything else.
      savingRef.current = false;
      setSaving(false);
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">New order</h1>
        <Link href="/" className="text-sm text-blue-700 underline">← Back to board</Link>
      </div>

      {(error ?? permsError ?? draftPromptError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError ?? draftPromptError}</p>
      )}
      {(loadError ?? autosaveError) && (
        <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{loadError ?? autosaveError}</p>
      )}

      {readiness && !readiness.ready ? (
        // Phase 8B §5.6: real order entry is blocked until company identity + a chart of accounts
        // are configured. The form is replaced (not merely disabled) by a notice linking to /setup.
        <div className="rounded border border-amber-300 bg-amber-50 p-4">
          <p className="mb-2 font-medium text-amber-900">Finish setup before entering orders</p>
          <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-amber-800">
            {readiness.gaps.map((g, i) => <li key={i}>{g.label}</li>)}
          </ul>
          <Link href="/setup" className="inline-block rounded bg-slate-800 px-4 py-2 text-sm text-white">
            Go to setup
          </Link>
        </div>
      ) : savedOrder ? (
        // Owner ruling, applied (HANDOFF issue #4 heritage — a degraded/flagged outcome is named
        // visibly, never silently): a save that succeeded WITH warnings stops here instead of
        // navigating straight past them. The form is gone (not merely disabled) — draft state is
        // never touched again post-save (savedRef above), so there is nothing left to autosave
        // regardless, and there is nothing here for a stray keystroke to land in.
        <div className="rounded border border-green-300 bg-green-50 p-4">
          <p className="mb-2 font-medium">Order #{savedOrder.orderNumber} saved.</p>
          <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-amber-800">
            {savedOrder.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
          <button type="button"
                  onClick={() => router.push(`/orders/${savedOrder.id}${savedOrder.print ? "?print=1" : ""}`)}
                  className="rounded bg-slate-800 px-4 py-2 text-sm text-white">
            {savedOrder.print ? "Go to order and print" : "Go to order"}
          </button>
        </div>
      ) : (
        <>
          {!draftReady && !draftPrompt && <p className="text-sm text-slate-500">Loading…</p>}

          {draftPrompt && (
            <div className="mb-4 rounded border border-blue-300 bg-blue-50 p-3 text-sm">
              <p className="mb-2">
                Draft from{" "}
                {new Date(draftPrompt.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
              <div className="flex gap-3">
                <button type="button" onClick={resumeDraft} className="rounded bg-slate-800 px-3 py-1 text-white">
                  Resume
                </button>
                <button type="button" onClick={() => void discardDraft()} className="rounded border px-3 py-1">
                  Discard
                </button>
              </div>
            </div>
          )}

          {draftReady && (
            <>
              <section className="mb-6 rounded border bg-white p-4">
                <h2 className="mb-2 font-medium">Customer</h2>
                <Combobox value={draft.customerId} options={customerOptions} onSelect={(id) => patch({ customerId: id })}
                           disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                           placeholder="Customer code or name" ariaLabel="Customer" />
                {/* A resumed draft's customerId can outlive the customer it names (deactivated —
                    listCustomers is active-only by default — or deleted between autosave and
                    resume, caught live while re-verifying this task's own fix for the analogous
                    part case below). Without this the picker just goes silently blank, the exact
                    misrepresenting-stored-data shape this codebase's history keeps flagging as
                    Critical; naming it matches OrderLineCard's "not in this customer's catalog". */}
                {draft.customerId && !selectedCustomer && customers.length > 0 && (
                  <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-800">
                    This customer is no longer available — pick a different one.
                  </p>
                )}
                {selectedCustomer?.creditHold && (
                  <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-800">
                    ⚠ {selectedCustomer.code} is on credit hold — orders can be entered; shipping will require release.
                  </p>
                )}
                {selectedCustomer?.orderNotes && (
                  <p className="mt-2 rounded bg-blue-50 p-2 text-sm text-blue-800">
                    Standing order notes: {selectedCustomer.orderNotes}
                  </p>
                )}
              </section>

              <section className="mb-6 rounded border bg-white p-4">
                <h2 className="mb-2 font-medium">Reference &amp; dates</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <label className="block">
                    PO number
                    <input value={displayedPo} onChange={(e) => patch({ poOverride: e.target.value })}
                           className="mt-1 w-full rounded border px-2 py-1" />
                  </label>
                  <label className="block">
                    VS order #
                    <input value={draft.vsOrderNumber} onChange={(e) => patch({ vsOrderNumber: e.target.value })}
                           className="mt-1 w-full rounded border px-2 py-1" />
                  </label>
                  <label className="block">
                    Customer job #
                    {/* §3.22 (Task 17): the customer's own job number, printed on the shipping
                        ticket beside the PO. Plain typed state, no derivation to override. */}
                    <input value={draft.customerJobNo} onChange={(e) => patch({ customerJobNo: e.target.value })}
                           className="mt-1 w-full rounded border px-2 py-1" />
                  </label>
                  <label className="block">
                    Received date
                    <input type="date" value={displayedReceivedDate}
                           onChange={(e) => patch({ receivedDateOverride: e.target.value })}
                           className="mt-1 w-full rounded border px-2 py-1" />
                  </label>
                  <label className="block">
                    Request date
                    <input type="date" value={displayedRequestDate}
                           onChange={(e) => patch({ requestDateOverride: e.target.value })}
                           className="mt-1 w-full rounded border px-2 py-1" />
                  </label>
                  <label className="block">
                    Target date
                    <input type="date" value={draft.targetDate ?? ""}
                           onChange={(e) => patch({ targetDate: e.target.value || null })}
                           className="mt-1 w-full rounded border px-2 py-1" />
                  </label>
                </div>
              </section>

              <section className="mb-6 rounded border bg-white p-4">
                <h2 className="mb-2 font-medium">Containers</h2>
                {draft.containers.length === 0 && <p className="text-sm text-slate-500">None.</p>}
                {draft.containers.map((c, i) => {
                  const net = netWeight(c.grossWeight, c.tareWeight);
                  return (
                    <div key={c.id} className="mb-2 grid grid-cols-7 items-end gap-2 text-sm">
                      <label className="block">
                        Type
                        <select value={c.typeId ?? ""} onChange={(e) => patchContainer(c.id, { typeId: e.target.value || null })}
                                aria-label={`Container ${i + 1} type`}
                                className="mt-1 w-full rounded border px-2 py-1">
                          <option value="">— choose —</option>
                          {containerTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </label>
                      <label className="block">
                        Count
                        <input value={c.count} inputMode="numeric" onChange={(e) => patchContainer(c.id, { count: e.target.value })}
                               aria-label={`Container ${i + 1} count`} className="mt-1 w-full rounded border px-2 py-1" />
                      </label>
                      <label className="block">
                        Qty/container
                        <input value={c.qty} inputMode="numeric" onChange={(e) => patchContainer(c.id, { qty: e.target.value })}
                               aria-label={`Container ${i + 1} quantity`} className="mt-1 w-full rounded border px-2 py-1" />
                      </label>
                      <label className="block">
                        Tare
                        <input value={c.tareWeight} inputMode="decimal" onChange={(e) => patchContainer(c.id, { tareWeight: e.target.value })}
                               aria-label={`Container ${i + 1} tare weight`} className="mt-1 w-full rounded border px-2 py-1" />
                      </label>
                      <label className="block">
                        Gross
                        <input value={c.grossWeight} inputMode="decimal" onChange={(e) => patchContainer(c.id, { grossWeight: e.target.value })}
                               aria-label={`Container ${i + 1} gross weight`} className="mt-1 w-full rounded border px-2 py-1" />
                      </label>
                      <label className="block">
                        Cust Cont Id
                        {/* §3.22 (Task 17): the customer's own bin id — the ticket's "Cust Cont
                            Id" column. Sibling of the hub ContainersSection's identical column
                            (the sibling-grid rule, spec §11). */}
                        <input value={c.customerContainerId} onChange={(e) => patchContainer(c.id, { customerContainerId: e.target.value })}
                               aria-label={`Container ${i + 1} customer container id`} className="mt-1 w-full rounded border px-2 py-1" />
                      </label>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-600">Net: {net ?? "—"}</span>
                        <button type="button" onClick={() => removeContainer(c.id)} className="text-xs text-red-600">Remove</button>
                      </div>
                    </div>
                  );
                })}
                <button type="button" onClick={addContainer} className="text-sm text-blue-700 underline">Add container</button>
              </section>

              <section className="mb-6 rounded border bg-white p-4">
                <h2 className="mb-2 font-medium">Part lines</h2>
                {!draft.customerId && <p className="mb-2 text-sm text-slate-500">Pick a customer to add part lines.</p>}
                {draft.lines.map((line, i) => (
                  <OrderLineCard key={line.id} index={i} isLead={i === 0} line={line} parts={customerParts}
                                 customerChosen={!!draft.customerId} partsGate={partsGate} processesGate={processesGate}
                                 customerId={draft.customerId}
                                 // Untouched = undefined = the param is OMITTED and the preview
                                 // uses the server's own today, exactly like the save would
                                 // (QuoteLinkPicker's contract). A change re-runs every line's
                                 // preview — all entry lines are unsaved, so this is precisely
                                 // ruling 6's "refresh the preview for unsaved lines".
                                 receivedDate={draft.receivedDateOverride ?? undefined}
                                 ordersViewAllowed={ordersViewGate.allowed} quotePickGate={saveGate}
                                 onChange={(p) => patchLine(line.id, p)}
                                 onRemove={draft.lines.length > 1 ? () => removeLine(line.id) : undefined}
                                 onLeadValidity={i === 0 ? onLeadValidity : undefined} />
                ))}
                <button type="button" onClick={addLine} className="text-sm text-blue-700 underline">Add part line</button>
              </section>

              <section className="mb-6 rounded border bg-white p-4">
                <h2 className="mb-2 font-medium">Certification</h2>
                {/* Spec §6.1/§11 (Task 17): the RESOLVED preview with an override. The untouched
                    state re-derives from the picked parts on every render (the 2C-3 rule — see
                    the derivation beside displayedPo above); touching a control records an
                    explicit override that wins until "reset to resolved", and only an override
                    ever travels in the create body — the server re-resolves and freezes its own
                    answer otherwise. Until a lead part is picked there is nothing to resolve, so
                    the controls are disabled saying exactly that (§5.16), never showing a
                    made-up "No". */}
                {!certPreviewReady && (
                  <p className="mb-2 text-sm text-slate-500">Pick a lead part to resolve the certification requirement.</p>
                )}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="block">
                    <span className="flex items-center gap-2">
                      <input type="checkbox" id="entry-cert-required" checked={displayedCertRequired ?? false}
                             disabled={!certPreviewReady}
                             title={certPreviewReady ? undefined : "Pick a lead part first"}
                             onChange={(e) => patch({ certRequiredOverride: e.target.checked })} />
                      <label htmlFor="entry-cert-required">Certification required</label>
                      {draft.certRequiredOverride !== null && (
                        <button type="button" onClick={() => patch({ certRequiredOverride: null })}
                                className="text-xs text-blue-700 underline">
                          overridden — reset to resolved
                        </button>
                      )}
                    </span>
                    {certPreviewReady && draft.certRequiredOverride === null && (
                      <span className="mt-1 block text-xs text-slate-500">
                        Resolved from the part/customer settings: {resolvedCertRequired ? "Yes" : "No"}.
                      </span>
                    )}
                  </div>
                  <div className="block">
                    <label className="block">
                      Scope
                      <select value={displayedCertScope ?? ""} disabled={!certPreviewReady}
                              title={certPreviewReady ? undefined : "Pick a lead part first"}
                              onChange={(e) => patch({ certScopeOverride: e.target.value === "" ? null : e.target.value as CertScopeValue })}
                              className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-100">
                        {!certPreviewReady && <option value="">—</option>}
                        {CERT_SCOPES.map((s) => <option key={s} value={s}>{CERT_SCOPE_LABELS[s]}</option>)}
                      </select>
                    </label>
                    {certPreviewReady && (draft.certScopeOverride === null ? (
                      <span className="mt-1 block text-xs text-slate-500">
                        Resolved from the lead part: {CERT_SCOPE_LABELS[resolvedCertScope!]}.
                      </span>
                    ) : (
                      <button type="button" onClick={() => patch({ certScopeOverride: null })}
                              className="mt-1 text-xs text-blue-700 underline">
                        overridden — reset to resolved
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="mb-6 rounded border bg-white p-4">
                <h2 className="mb-2 font-medium">Charges</h2>
                {draft.charges.length === 0 && <p className="text-sm text-slate-500">None.</p>}
                {draft.charges.map((c, i) => (
                  <div key={c.id} className="mb-2 flex items-end gap-2 text-sm">
                    <label className="block flex-1">
                      Description
                      <input value={c.description} onChange={(e) => patchCharge(c.id, { description: e.target.value })}
                             aria-label={`Charge ${i + 1} description`} className="mt-1 w-full rounded border px-2 py-1" />
                    </label>
                    <label className="block w-40">
                      Amount
                      <input value={c.amount} inputMode="decimal" placeholder="needs price"
                             onChange={(e) => patchCharge(c.id, { amount: e.target.value })}
                             aria-label={`Charge ${i + 1} amount`} className="mt-1 w-full rounded border px-2 py-1" />
                    </label>
                    <button type="button" onClick={() => removeCharge(c.id)} className="text-xs text-red-600">Remove</button>
                  </div>
                ))}
                <button type="button" onClick={addCharge} className="text-sm text-blue-700 underline">Add charge</button>
              </section>

              <section className="mb-6 rounded border bg-white p-4">
                <h2 className="mb-2 font-medium">Notes</h2>
                <textarea value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} rows={3}
                          className="w-full rounded border p-2 text-sm" />
              </section>

              <div className="mb-10 flex items-center gap-3">
                <button type="button" onClick={() => void handleSave()} disabled={saving || saveGate.disabled}
                        title={saveGate.title}
                        className="rounded bg-slate-800 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                  {saving ? "Saving…" : "Save"}
                </button>
                <button type="button" onClick={() => void handleSave(true)} disabled={saving || saveGate.disabled}
                        title={saveGate.title}
                        className="rounded border border-slate-800 px-4 py-2 text-sm text-slate-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
                  Save &amp; Print
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
