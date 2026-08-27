"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { usePermissions } from "@/lib/use-permissions";
import { gate } from "@/lib/permission-ui";
import { percentFromFraction, fractionFromPercent } from "@/lib/rate-display";

// number|null once loaded from the server, but also string mid-edit for the two decimal fields —
// the input is bound straight to these and the server's decimalField schema accepts a decimal
// string as-is (customers/[id]/page.tsx creditLimit precedent).
type Cfg = {
  salesTaxRate: number | string | null;
  salesTaxGlAccountId: string | null;
  freightGlAccountId: string | null;
  otherChargeGlAccountId: string | null;
  certChargeStepCodeId: string | null;
  certChargeDefault: number | string | null;
  billForCertDefault: boolean;
  // Task 4 (P5B §4.3, §7): plant default monthly finance-charge rate. Same string-mid-edit
  // convention as the two decimal fields above.
  financeChargeRate: number | string | null;
  // Phase 5C: the A/R close's three GL defaults.
  arGlAccountId: string | null;
  discountGlAccountId: string | null;
  writeOffGlAccountId: string | null;
};
type GlAccount = { id: string; name: string; description?: string | null };

// #227: the page displays PERCENT everywhere, but `salesTaxRate` is STORED as a fraction
// (0.07 = 7% — pricing.ts multiplies directly) while `financeChargeRate` is stored as the
// percent number itself (finance-charges.ts divides by 100). State holds the displayed text, so
// the one fraction field converts at every server→state landing through this map and back to the
// fraction in `blurDecimal` before the wire — the API and the database never change convention.
const displayCfg = (c: Cfg): Cfg => ({ ...c, salesTaxRate: percentFromFraction(c.salesTaxRate) });
type StepCodeOption = { id: string; name: string; active: boolean };

export default function BillingPage() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [glAccounts, setGlAccounts] = useState<GlAccount[]>([]);
  const [stepCodes, setStepCodes] = useState<StepCodeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<keyof Cfg | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();
  // Every write here hits PUT /api/admin/billing, which requires admin.edit
  // (src/app/api/admin/billing/route.ts) — disabled with a tooltip, never hidden (§5.16).
  const canEdit = gate(perms, "admin.edit");

  // GL accounts are deliberately not on the pick-list route (PICKLIST_KINDS excludes them,
  // §5.15) — this is an admin page, so the admin reference route is the right source. Neither
  // request asks for includeInactive: the step-codes page's GL-account select (the precedent for
  // this screen) doesn't either.
  const load = () => Promise.all([
    api<Cfg>("/api/admin/billing"),
    api<GlAccount[]>("/api/admin/reference/glAccount"),
    api<StepCodeOption[]>("/api/picklists/processStepCode"),
  ]).then(([c, gl, sc]) => { setCfg(displayCfg(c)); setGlAccounts(gl); setStepCodes(sc); });

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function save(patch: Partial<Cfg>) {
    const field = Object.keys(patch)[0] as keyof Cfg;
    try {
      const updated = await api<Cfg>("/api/admin/billing", { method: "PUT", body: JSON.stringify(patch) });
      // #110: assigning (or clearing) the A/R GL account moves the banner's `chart` readiness
      // step — fired the instant the PUT resolves (the #124/#131 ordering; no follow-up load on
      // this success path, the response body is the fresh truth).
      invalidateSetupBanner();
      setCfg(displayCfg(updated)); setError(null);
      setSaved(field); setTimeout(() => setSaved(null), 1500);
    } catch (e) {
      void load().catch(() => {}); // roll back to server truth first, then report why (§5.13)
      setError((e as Error).message);
    }
  }

  // The two free-typed decimal fields only save a genuine change: this records the value at
  // focus time so tabbing through an untouched field doesn't write a no-op audit entry.
  const focused = useRef<Record<string, string>>({});
  function noteFocus(key: string, value: string) { focused.current[key] = value; }
  function blurDecimal(key: "salesTaxRate" | "certChargeDefault" | "financeChargeRate", value: string) {
    if (value === focused.current[key]) return;
    // Only salesTaxRate converts (#227) — the displayed percent becomes the stored fraction.
    const wire = key === "salesTaxRate" ? fractionFromPercent(value) : value;
    void save({ [key]: wire === "" ? null : wire } as Partial<Cfg>);
  }

  if (!cfg) return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;

  const savedMark = (key: keyof Cfg) => saved === key && <em className="ml-2 text-green-700">saved</em>;

  return (
    <div className="max-w-2xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Billing</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      <div className="rounded border bg-white">
        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>Sales tax rate (%){savedMark("salesTaxRate")}</span>
          <input
            value={cfg.salesTaxRate ?? ""}
            inputMode="decimal"
            placeholder="4.00"
            disabled={canEdit.disabled}
            title={canEdit.title}
            onFocus={(e) => noteFocus("salesTaxRate", e.target.value)}
            onChange={(e) => setCfg({ ...cfg, salesTaxRate: e.target.value })}
            onBlur={(e) => blurDecimal("salesTaxRate", e.target.value)}
            className="w-40 rounded border px-2 py-1 text-right disabled:cursor-not-allowed disabled:bg-slate-100"
          />
        </label>

        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>Sales tax GL account{savedMark("salesTaxGlAccountId")}</span>
          <select
            value={cfg.salesTaxGlAccountId ?? ""}
            disabled={canEdit.disabled}
            title={canEdit.title}
            onChange={(e) => void save({ salesTaxGlAccountId: e.target.value || null })}
            className="w-56 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="">(none)</option>
            {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>Freight GL account{savedMark("freightGlAccountId")}</span>
          <select
            value={cfg.freightGlAccountId ?? ""}
            disabled={canEdit.disabled}
            title={canEdit.title}
            onChange={(e) => void save({ freightGlAccountId: e.target.value || null })}
            className="w-56 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="">(none)</option>
            {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>Other charge GL account{savedMark("otherChargeGlAccountId")}</span>
          <select
            value={cfg.otherChargeGlAccountId ?? ""}
            disabled={canEdit.disabled}
            title={canEdit.title}
            onChange={(e) => void save({ otherChargeGlAccountId: e.target.value || null })}
            className="w-56 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="">(none)</option>
            {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>A/R GL account{savedMark("arGlAccountId")}</span>
          <select
            value={cfg.arGlAccountId ?? ""}
            disabled={canEdit.disabled}
            title={canEdit.title}
            onChange={(e) => void save({ arGlAccountId: e.target.value || null })}
            className="w-56 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="">(none)</option>
            {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>Discount GL account{savedMark("discountGlAccountId")}</span>
          <select
            value={cfg.discountGlAccountId ?? ""}
            disabled={canEdit.disabled}
            title={canEdit.title}
            onChange={(e) => void save({ discountGlAccountId: e.target.value || null })}
            className="w-56 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="">(none)</option>
            {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>Write-off GL account{savedMark("writeOffGlAccountId")}</span>
          <select
            value={cfg.writeOffGlAccountId ?? ""}
            disabled={canEdit.disabled}
            title={canEdit.title}
            onChange={(e) => void save({ writeOffGlAccountId: e.target.value || null })}
            className="w-56 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="">(none)</option>
            {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>Certification charge step code{savedMark("certChargeStepCodeId")}</span>
          <select
            value={cfg.certChargeStepCodeId ?? ""}
            disabled={canEdit.disabled}
            title={canEdit.title}
            onChange={(e) => void save({ certChargeStepCodeId: e.target.value || null })}
            className="w-56 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="">(none)</option>
            {stepCodes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>Certification charge default amount{savedMark("certChargeDefault")}</span>
          <input
            value={cfg.certChargeDefault ?? ""}
            inputMode="decimal"
            placeholder="0.00"
            disabled={canEdit.disabled}
            title={canEdit.title}
            onFocus={(e) => noteFocus("certChargeDefault", e.target.value)}
            onChange={(e) => setCfg({ ...cfg, certChargeDefault: e.target.value })}
            onBlur={(e) => blurDecimal("certChargeDefault", e.target.value)}
            className="w-40 rounded border px-2 py-1 text-right disabled:cursor-not-allowed disabled:bg-slate-100"
          />
        </label>

        <label className="flex items-center justify-between border-b p-2 text-sm">
          <span>Finance charge (monthly %){savedMark("financeChargeRate")}</span>
          <input
            value={cfg.financeChargeRate ?? ""}
            inputMode="decimal"
            placeholder="1.5000"
            disabled={canEdit.disabled}
            title={canEdit.title}
            onFocus={(e) => noteFocus("financeChargeRate", e.target.value)}
            onChange={(e) => setCfg({ ...cfg, financeChargeRate: e.target.value })}
            onBlur={(e) => blurDecimal("financeChargeRate", e.target.value)}
            className="w-40 rounded border px-2 py-1 text-right disabled:cursor-not-allowed disabled:bg-slate-100"
          />
        </label>

        <label className="flex items-center justify-between p-2 text-sm">
          <span>Bill for certification by default{savedMark("billForCertDefault")}</span>
          <input
            type="checkbox"
            checked={cfg.billForCertDefault}
            disabled={canEdit.disabled}
            title={canEdit.title}
            onChange={(e) => void save({ billForCertDefault: e.target.checked })}
          />
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Plant-wide billing defaults. Values save as soon as they change; an invalid value is
        rejected with a message and nothing is stored.
      </p>
    </div>
  );
}
