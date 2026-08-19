"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/fetcher";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useEditGuard } from "@/lib/use-edit-guard";
import { useSaveScope } from "@/lib/save-scope";
import type { CertScopeValue } from "@/lib/cert-constants";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { IdentitySection } from "./IdentitySection";
import { SpecsSection } from "./SpecsSection";
import { InspectionsSection } from "./InspectionsSection";
import { PricingSection } from "./PricingSection";
import { ActiveQuotesSection } from "./ActiveQuotesSection";
import { CustomFieldsSection } from "./CustomFieldsSection";
import { ProcessStepsSection } from "./ProcessStepsSection";
import { AttachmentsSection } from "@/components/AttachmentsSection";

// Local row type mirrors src/server/parts.ts's PartRow — not imported from src/server/**, since
// a client component pulling from there drags node:async_hooks and Prisma into the browser
// bundle (CLAUDE.md "Constraints that will bite you"). Decimal fields are `number | string`
// (loadQty is `number | string | null` for the same reason, even though the server ultimately
// wants a real int): a value loaded from the server is a number, but mid-edit the bound input
// holds whatever text the user is typing — the customers/[id]/page.tsx creditLimit precedent —
// and the server's decimal schemas accept that string as-is.
export type Part = {
  id: string; customerId: string; customerCode: string; customerName: string;
  partNumber: string; name: string; description: string;
  /** Presentation vocabulary for the traveler's Process: slot / the invoice snapshot
   *  (spec §5.7 ruling 4) — surfaced for data entry in Task 15. */
  processName: string;
  materialId: string | null; materialName: string | null;
  eachWeight: number | string;
  loadQty: number | string | null;
  loadWeight: number | string | null;
  requestDaysOverride: number | string | null;
  /** Certification chain (spec §6.1): null = inherit the customer default, else the plant
   *  setting. The `inheritedCert*` companions are what that null currently resolves to —
   *  computed server-side (parts.ts) so the three-state controls can label their "Inherit"
   *  option for every viewer, regardless of customers.view / admin.view. */
  certRequired: boolean | null;
  certScope: CertScopeValue | null;
  inheritedCertRequired: boolean;
  inheritedCertScope: CertScopeValue;
  serializationRequired: boolean;
  active: boolean;
};

export default function PartDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Next reuses this route's component instance across /parts/A -> /parts/B (only the param
  // changes, no remount). Keying the body by id forces a fresh instance per part, so no
  // draft/defaultValue-bound field can carry one part's unsaved text onto another part's id
  // (handoff §5.12).
  return <PartDetail key={id} id={id} />;
}

function PartDetail({ id }: { id: string }) {
  const router = useRouter();
  const [part, setPart] = useState<Part | null>(null);
  const [error, setError] = useState<string | null>(null);
  // F9: a failed pick-list fetch (material, specification, inspectionCode, inspectionScale) used
  // to report through the shared `error` state above — the same state a later successful field
  // save resets to null (save() below, and load() itself on every successful refresh). That left
  // a window where a save on one section silently erased a load failure reported by another,
  // while the affected select sat enabled with an empty options list — a controlled <select>
  // whose value matches no <option> renders blank, misrepresenting a real (if now-hidden)
  // assignment and risking clobbering it on the next interaction. `loadError` is its own state,
  // written only by `addLoadError` below and never cleared by a section save, rendered as its own
  // banner. Mirrors customers/[id]/page.tsx's `optionsError`/`addOptionsError` (F4 there).
  const [loadError, setLoadError] = useState<string | null>(null);
  const addLoadError = useCallback((message: string) => {
    setLoadError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);
  // Task 15: deletePart now refuses while a live order's line references it (lead or rider) —
  // the customers/[id]/page.tsx "blocked" precedent, populated only from the delete refusal
  // below and cleared on dismiss, so the refusal names what's actually using the part instead of
  // leaving a bare count with nothing to click through.
  const [blocked, setBlocked] = useState<{ list: Blocker[] } | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();
  // Every set-of-`part`-from-server routes through `editGuard.applyPayload` so a reload landing
  // mid-typing — most notably save()'s own §5.13 failure-path rollback for a SIBLING field —
  // never resets the field the user is actively editing (use-edit-guard.ts; the customers/
  // CertDetail/ShipmentDetail fix-wave trio, which this page never received). IdentitySection
  // registers WHICH Part property is under the cursor via `editGuard` below.
  const editGuard = useEditGuard();
  // And every optimistic save registers with this scope, every reload routing through it
  // (save-scope.ts, issue #15): the reload's GET waits out registered saves and re-fetches if
  // one is dispatched mid-fetch, so a rollback can never apply a payload that predates a newer
  // save's optimistic value — the merge protects only the focused field; the scope protects
  // every other key (an in-flight `active`/`serializationRequired` toggle included).
  const saveScope = useSaveScope();

  const fetchPart = useCallback(() => api<Part>(`/api/parts/${id}`), [id]);
  const applyPart = useCallback((p: Part) => {
    // Captured-session apply (use-edit-guard.ts, the round-3 fixpoint).
    setPart(editGuard.applyPayload(p));
  }, [editGuard]);
  const load = useCallback(
    () => saveScope.reload(fetchPart, (p) => { applyPart(p); setError(null); }),
    [saveScope, fetchPart, applyPart],
  );
  // The rollback variant skips load()'s setError(null): a rollback reload lands AFTER the
  // failure it rolls back was reported, and must never clear that banner (§5.13).
  const rollbackLoad = useCallback(
    () => saveScope.reload(fetchPart, applyPart),
    [saveScope, fetchPart, applyPart],
  );
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  // Per-key request queue + optimistic-then-persist save, the customers/[id]/page.tsx save()/
  // serial() precedent.
  const queue = useRef<Map<string, Promise<unknown>>>(new Map());
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queue.current.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queue.current.set(key, next.catch(() => {}));
    return next;
  }
  async function save(body: Record<string, unknown>): Promise<boolean> {
    setPart((cur) => (cur ? ({ ...cur, ...body } as Part) : cur));
    const key = Object.keys(body).sort().join(",");
    const settled = serial(key, async () => {
      try {
        await api(`/api/parts/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        setError(null);
        // #14 item 1, on the success path the instant the PATCH resolves (the #124/#131
        // ordering): the History panel below refetches, so an edit made while staying on this
        // page shows up without a reload.
        invalidateHistory();
        return true;
      } catch (e) {
        // §5.13 rollback, detached: report first, then fire rollbackLoad() WITHOUT awaiting it
        // — awaiting from inside this queued fn deadlocks, since the reload waits for every
        // registered save chain (this one included) to settle before its GET dispatches. The
        // no-clear apply means the reload can never wipe this banner however late it lands, and
        // the settle-defer means its payload postdates every save queued behind this one (#15).
        setError((e as Error).message);
        void rollbackLoad().catch(() => {});
        return false;
      }
    });
    // Registered at save call time, beside the optimistic set above: reloads defer to this
    // save's whole chain and re-fetch if it was dispatched mid-fetch (save-scope.ts).
    saveScope.begin(settled);
    return settled;
  }
  // Pure local edit — keeps a controlled input showing what the user is typing without a round
  // trip. save() above applies the same shape of patch permanently; this is the onChange half of
  // the onChange-sets-local/onBlur-saves split customers/[id]/page.tsx uses throughout. It must
  // NOT register with saveScope: typing is not a save, and bumping the epoch per keystroke would
  // starve reloads — mid-typing protection is editGuard's job, not the scope's.
  function patchDraft(patch: Partial<Part>) {
    setPart((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  const canDelete = gate(perms, "parts.delete");
  // prompt() rather than confirm() — spec §9 requires a reason on a destructive action (the
  // customers/[id]/page.tsx removeCustomer() precedent). deletePart() soft-deletes the part's
  // specifications, inspections, and price rows with it (but not custom field values, which are
  // never soft-deleted — "" means unset). The part number is unique only among live rows, so it
  // becomes reusable by a fresh part for this customer, not a revival of this one.
  async function removePart() {
    if (!part) return;
    const reason = prompt(
      `Delete part "${part.customerCode} · ${part.partNumber}"?\n\n` +
      `Its specifications, inspections, and prices are deleted with it. The part number ` +
      `can be reused later for this customer, which starts a fresh part rather than restoring ` +
      `this one.\n\n` +
      `Reason for deleting (recorded in the audit history):`
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) {
      setError("A reason is required to delete a part.");
      return;
    }
    try {
      await api(`/api/parts/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      router.push("/parts");
    } catch (e) {
      // Matched on "live order(s)" or "live quote(s)" — deletePart's two refusal reasons
      // (parts.ts; Task 7 added the quotes guard) other than a missing/empty reason, which never
      // reaches this far — the customers/[id]/page.tsx removeCustomer() precedent for turning a
      // bare-count refusal into a discoverable list. The blockers route returns the UNION of
      // both categories, so whichever guard fired, the panel shows everything blocking.
      const message = (e as Error).message;
      if (e instanceof ApiError && e.status === 400
        && (message.includes("live order(s)") || message.includes("live quote(s)"))) {
        try {
          const list = await api<Blocker[]>(`/api/parts/${id}/blockers`);
          if (list.length) { setBlocked({ list }); setError(null); return; }
        } catch (listErr) {
          setError(`${message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError(message);
    }
  }

  if (!part) return <div className="p-6">{error ?? permsError ?? loadError ?? "Loading…"}</div>;

  return (
    <div className="p-6">
      <h1 className="mb-3 text-2xl font-semibold">
        {part.customerCode} · <span className="font-mono">{part.partNumber}</span>
      </h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {/* F9: its own banner, its own state — a section save (which clears `error` on success)
          must not be able to silently clear a report that a pick-list failed to load, since the
          affected select stays disabled (and, before this fix, misrepresented stored data) until
          the page is reloaded. */}
      {loadError && (
        <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{loadError}</p>
      )}
      {blocked && (
        <BlockerPanel
          label="part"
          rowName={`${part.customerCode} · ${part.partNumber}`}
          list={blocked.list}
          action="delete"
          exportHref={`/api/parts/${id}/blockers/export`}
          onDismiss={() => setBlocked(null)}
        />
      )}

      <IdentitySection part={part} perms={perms} save={save} patchDraft={patchDraft} editGuard={editGuard}
                        onError={setError} onOptionsError={addLoadError} />
      <SpecsSection partId={id} perms={perms} onError={setError} onOptionsError={addLoadError} />
      <InspectionsSection partId={id} perms={perms} onError={setError} onOptionsError={addLoadError} />
      <PricingSection partId={id} perms={perms} onError={setError} onOptionsError={addLoadError} />
      {/* Spec §4.2 (Task 9): the part's in-date OPEN quote lines, latest-effective first, linked
          — beside Pricing, since an active quote is what displaces these part prices (§7.5). */}
      <ActiveQuotesSection partId={id} customerId={part.customerId} perms={perms} />
      <CustomFieldsSection partId={id} perms={perms} onError={setError} />
      <AttachmentsSection owner="part" ownerId={id} canEdit={gate(perms, "parts.edit").allowed} />
      <ProcessStepsSection partId={id} perms={perms} onError={setError} />

      <div className="mb-6">
        <HistoryPanel entity="part" entityId={id} />
      </div>

      <button onClick={removePart} disabled={canDelete.disabled} title={canDelete.title}
              className="text-sm text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
        Delete part
      </button>
    </div>
  );
}
