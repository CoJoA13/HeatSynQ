"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { HistoryPanel } from "@/components/HistoryPanel";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import type { PricePerValue } from "@/lib/part-constants";
import { IdentitySection } from "./IdentitySection";
import { SpecsSection } from "./SpecsSection";
import { InspectionsSection } from "./InspectionsSection";
import { PricingSection } from "./PricingSection";
import { CustomFieldsSection } from "./CustomFieldsSection";

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
  materialId: string | null; materialName: string | null;
  eachWeight: number | string;
  loadQty: number | string | null;
  loadWeight: number | string | null;
  serializationRequired: boolean;
  setupCharge: number | string | null;
  unitPrice: number | string | null;
  minimumCharge: number | string | null;
  pricePer: PricePerValue;
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
  const { permissions: perms, error: permsError } = usePermissions();

  const load = useCallback(async () => {
    const p = await api<Part>(`/api/parts/${id}`);
    setPart(p);
    setError(null);
  }, [id]);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  // Per-key request queue + optimistic-then-persist save, the customers/[id]/page.tsx save()/
  // serial() precedent. Shared by IdentitySection and PricingSection — each only ever includes
  // ITS OWN field subset in `body`, which is what keeps a non-change_prices identity edit from
  // tripping the route's PRICING_FIELDS-presence gate, and a name-only edit by a
  // change_prices-less user out of the pricing audit path.
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
    return serial(key, async () => {
      try {
        await api(`/api/parts/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        setError(null);
        return true;
      } catch (e) {
        // Roll back to server truth FIRST, then report why — load() clears the error on
        // success, so setting the error before the reload would let that clear wipe it out
        // before the user ever saw it (§5.13).
        await load().catch(() => {});
        setError((e as Error).message);
        return false;
      }
    });
  }
  // Pure local edit — keeps a controlled input showing what the user is typing without a round
  // trip. save() above applies the same shape of patch permanently; this is the onChange half of
  // the onChange-sets-local/onBlur-saves split customers/[id]/page.tsx uses throughout.
  function patchDraft(patch: Partial<Part>) {
    setPart((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  const canDelete = gate(perms, "parts.delete");
  // prompt() rather than confirm() — spec §9 requires a reason on a destructive action (the
  // customers/[id]/page.tsx removeCustomer() precedent). deletePart() soft-deletes the part's
  // specifications, inspections, and price breaks with it (but not custom field values, which
  // are never soft-deleted — "" means unset). The part number is unique only among live rows, so
  // it becomes reusable by a fresh part for this customer, not a revival of this one.
  async function removePart() {
    if (!part) return;
    const reason = prompt(
      `Delete part "${part.customerCode} · ${part.partNumber}"?\n\n` +
      `Its specifications, inspections, and price breaks are deleted with it. The part number ` +
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
      setError((e as Error).message);
    }
  }

  if (!part) return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;

  return (
    <div className="p-6">
      <h1 className="mb-3 text-2xl font-semibold">
        {part.customerCode} · <span className="font-mono">{part.partNumber}</span>
      </h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      <IdentitySection part={part} perms={perms} save={save} patchDraft={patchDraft} onError={setError} />
      <SpecsSection partId={id} perms={perms} onError={setError} />
      <InspectionsSection partId={id} perms={perms} onError={setError} />
      <PricingSection part={part} perms={perms} save={save} patchDraft={patchDraft} onError={setError} />
      <CustomFieldsSection partId={id} perms={perms} onError={setError} />

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
