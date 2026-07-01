"use client";
import { useEffect, useRef, useState } from "react";
import type { CreateInput } from "@/lib/data/repositories";
import type { Customer, Part, PricingRule, PricingBasis, Discount, Quote } from "@/lib/domain";
import { PRICING_BASES, basisLabel } from "@/lib/domain/enums";
import { rateForLine, buildQuoteDraft, STUB_COST_RATIO } from "@/lib/logic/quote-builder";
import { quoteSubtotalCents, quoteTotalCents, lineAmountCents, marginPct } from "@/lib/logic/pricing";
import { PageHeader, SummaryRail, FormField } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { Input } from "@/lib/ui/input";
import { formatMoney } from "@/lib/utils";

type LineState = { id: string; process: string; basis: PricingBasis; qtyOrWeight: number; rateCents: number; minChargeCents: number | null };
type PartState = { id: string; partId: string; material: string; quantity: number; lines: LineState[] };
export type BuilderState = { customerPO: string; requiredBy: string; notes: string; discount: Discount | null; parts: PartState[] };

const PROCESS_OPTIONS = ["Carburize", "Carbonitride", "Nitride", "Neutral harden", "Vacuum harden", "Temper", "Anneal", "Certification"];
const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm";

// Largest numeric suffix across a draft's part + line ids (e.g. qp-1, ql-3 → 3),
// so a reopened draft keeps generating fresh ids instead of colliding on qp-1/ql-1.
function maxIdSeq(initial: BuilderState | null | undefined): number {
  if (!initial) return 0;
  let max = 0;
  const scan = (id: string) => {
    const m = /(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const p of initial.parts) {
    scan(p.id);
    for (const l of p.lines) scan(l.id);
  }
  return max;
}

export function QuoteBuilder({
  customers, parts, pricingRules, salespersonId, canDiscount, todayIso, initial,
  initialCustomerId, submitting, onSaveDraft, onSend, onCustomerChange,
}: {
  customers: Customer[]; parts: Part[]; pricingRules: PricingRule[];
  salespersonId: string; canDiscount: boolean; todayIso: string;
  initial?: BuilderState | null; initialCustomerId?: string; submitting: boolean;
  onSaveDraft: (input: CreateInput<Quote>) => void; onSend: (input: CreateInput<Quote>) => void;
  onCustomerChange?: (customerId: string) => void;
}) {
  const seq = useRef<number | null>(null);
  if (seq.current === null) seq.current = maxIdSeq(initial); // lazy init once, beyond any id in `initial`
  const nid = (p: string) => `${p}-${(seq.current! += 1)}`;
  const [customerId, setCustomerId] = useState(initialCustomerId ?? "");
  const [state, setState] = useState<BuilderState>(initial ?? { customerPO: "", requiredBy: "", notes: "", discount: null, parts: [] });

  const customerParts = parts.filter((p) => p.customerId === customerId);

  function addPart() {
    setState((s) => ({ ...s, parts: [...s.parts, { id: nid("qp"), partId: "", material: "", quantity: 0, lines: [] }] }));
  }
  function removePart(pi: number) {
    setState((s) => ({ ...s, parts: s.parts.filter((_, i) => i !== pi) }));
  }
  function patchPart(pi: number, patch: Partial<PartState>) {
    setState((s) => ({ ...s, parts: s.parts.map((p, i) => (i === pi ? { ...p, ...patch } : p)) }));
  }
  function addLine(pi: number) {
    setState((s) => ({
      ...s,
      parts: s.parts.map((p, i) =>
        i === pi
          ? { ...p, lines: [...p.lines, { id: nid("ql"), process: "", basis: "per_lb" as PricingBasis, qtyOrWeight: 0, rateCents: 0, minChargeCents: null }] }
          : p),
    }));
  }
  function patchLine(pi: number, li: number, patch: Partial<LineState>) {
    setState((s) => ({
      ...s,
      parts: s.parts.map((p, i) => {
        if (i !== pi) return p;
        const lines = p.lines.map((l, j) => (j === li ? { ...l, ...patch } : l));
        // when process/basis change, prefill rate + min-charge from the price key rules
        if ("process" in patch || "basis" in patch) {
          const l = lines[li];
          const r = rateForLine(pricingRules, l.process, l.basis);
          lines[li] = { ...l, rateCents: r.rateCents, minChargeCents: r.minChargeCents };
        }
        return { ...p, lines };
      }),
    }));
  }
  function removeLine(pi: number, li: number) {
    setState((s) => ({
      ...s,
      parts: s.parts.map((p, i) => (i === pi ? { ...p, lines: p.lines.filter((_, j) => j !== li) } : p)),
    }));
  }

  // If rules arrive after a process/basis was picked, backfill any line still at rate 0
  // (untouched — manual non-zero rates are preserved). Keyed on pricingRules identity.
  useEffect(() => {
    if (pricingRules.length === 0) return;
    setState((s) => {
      let changed = false;
      const parts = s.parts.map((p) => ({
        ...p,
        lines: p.lines.map((l) => {
          if (l.process === "" || l.rateCents !== 0) return l;
          const r = rateForLine(pricingRules, l.process, l.basis);
          if (r.rateCents === 0 && r.minChargeCents === l.minChargeCents) return l;
          changed = true;
          return { ...l, rateCents: r.rateCents, minChargeCents: r.minChargeCents };
        }),
      }));
      return changed ? { ...s, parts } : s;
    });
  }, [pricingRules]);

  const pricingParts = state.parts.map((p) => ({ id: p.id, partId: p.partId, material: p.material, quantity: p.quantity, lines: p.lines }));
  const subtotal = quoteSubtotalCents(pricingParts);
  const total = quoteTotalCents({ parts: pricingParts, discount: state.discount });
  const margin = marginPct(total, Math.round(total * STUB_COST_RATIO));

  const discountValid = !(state.discount?.kind === "percent" && (state.discount.value < 0 || state.discount.value > 100));
  const valid = customerId !== "" && state.parts.length > 0 && discountValid &&
    state.parts.every((p) => p.partId !== "" && p.quantity >= 0 && p.lines.length > 0 &&
      p.lines.every((l) => l.process !== "" && l.qtyOrWeight >= 0 && l.rateCents >= 0));

  function assemble(): CreateInput<Quote> {
    return buildQuoteDraft({
      customerId, customerPO: state.customerPO, salespersonId,
      requiredBy: state.requiredBy ? new Date(state.requiredBy).toISOString() : null,
      discount: state.discount, notes: state.notes, parts: pricingParts,
    }, todayIso);
  }

  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <PageHeader title="New quote" subtitle="Build a multi-part estimate. Rates default from the customer's price key." />
        <div className="space-y-4 rounded-card border border-border bg-surface p-4">
          <FormField label="Customer" htmlFor="cust">
            <select id="cust" aria-label="Customer" className={selectCls} value={customerId} onChange={(e) => { const v = e.target.value; setCustomerId(v); setState((s) => ({ ...s, parts: [] })); onCustomerChange?.(v); }}>
              <option value="">Select customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FormField>
          <FormField label="Customer PO" htmlFor="po">
            <Input id="po" value={state.customerPO} onChange={(e) => setState((s) => ({ ...s, customerPO: e.target.value }))} />
          </FormField>
          <FormField label="Required by" htmlFor="req">
            <Input id="req" type="date" value={state.requiredBy} onChange={(e) => setState((s) => ({ ...s, requiredBy: e.target.value }))} />
          </FormField>
        </div>

        {state.parts.map((p, pi) => (
          <div key={p.id} data-testid={`part-block-${pi}`} className="mt-4 rounded-card border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">Part {pi + 1}</span>
              <Button size="sm" variant="ghost" onClick={() => removePart(pi)}>Remove part</Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Part" htmlFor={`part-${pi}`}>
                <select id={`part-${pi}`} aria-label="Part" className={selectCls} value={p.partId}
                  onChange={(e) => { const pt = parts.find((x) => x.id === e.target.value); patchPart(pi, { partId: e.target.value, material: pt?.material ?? "" }); }}>
                  <option value="">Select part…</option>
                  {customerParts.map((pt) => <option key={pt.id} value={pt.id}>{pt.partNumber} — {pt.description}</option>)}
                </select>
              </FormField>
              <FormField label="Quantity" htmlFor={`qty-${pi}`}>
                <Input id={`qty-${pi}`} aria-label="Quantity" type="number" min={0} value={p.quantity || ""} onChange={(e) => patchPart(pi, { quantity: Number(e.target.value) })} />
              </FormField>
            </div>

            <table className="mt-3 w-full text-[13px]">
              <thead><tr className="text-left font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">
                <th className="py-1">Process</th><th>Basis</th><th>Qty / weight</th><th>Rate</th><th className="text-right">Amount</th><th></th>
              </tr></thead>
              <tbody>
                {p.lines.map((l, li) => (
                  <tr key={l.id} data-testid={`line-${li}`} className="border-t border-border-faint">
                    <td className="py-1 pr-2">
                      <select aria-label="Process" className={selectCls} value={l.process} onChange={(e) => patchLine(pi, li, { process: e.target.value })}>
                        <option value="">…</option>
                        {PROCESS_OPTIONS.map((pr) => <option key={pr} value={pr}>{pr}</option>)}
                      </select>
                    </td>
                    <td className="pr-2">
                      <select aria-label="Basis" className={selectCls} value={l.basis} onChange={(e) => patchLine(pi, li, { basis: e.target.value as PricingBasis })}>
                        {PRICING_BASES.map((b) => <option key={b} value={b}>{basisLabel[b]}</option>)}
                      </select>
                    </td>
                    <td className="pr-2"><Input aria-label="Qty / weight" type="number" min={0} value={l.qtyOrWeight || ""} onChange={(e) => patchLine(pi, li, { qtyOrWeight: Number(e.target.value) })} /></td>
                    <td className="pr-2"><Input aria-label="Rate (cents)" type="number" min={0} value={l.rateCents || ""} onChange={(e) => patchLine(pi, li, { rateCents: Number(e.target.value) })} /></td>
                    <td className="text-right font-mono">{formatMoney(lineAmountCents(l))}</td>
                    <td><Button size="sm" variant="ghost" onClick={() => removeLine(pi, li)}>×</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => addLine(pi)}>+ Add line</Button>
          </div>
        ))}

        <Button variant="outline" className="mt-4" onClick={addPart}>+ Add part</Button>
      </div>

      <SummaryRail title="Quote summary">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between"><dt className="text-text-muted">Subtotal</dt><dd className="font-mono">{formatMoney(subtotal)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Discount</dt>
            <dd className="font-mono">{canDiscount ? (
              <Input aria-label="Discount %" type="number" min={0} max={100} className="h-6 w-16 text-right"
                value={state.discount?.kind === "percent" ? state.discount.value : ""}
                onChange={(e) => setState((s) => ({ ...s, discount: e.target.value ? { kind: "percent", value: Number(e.target.value) } : null }))} />
            ) : "—"}</dd>
          </div>
          <div className="flex justify-between border-t border-border pt-2"><dt className="font-semibold">Total</dt><dd data-testid="quote-total" className="font-mono font-semibold">{formatMoney(total)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Est. margin</dt><dd className="font-mono">{margin}%</dd></div>
        </dl>
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="outline" disabled={!valid || submitting} onClick={() => onSaveDraft(assemble())}>Save draft</Button>
          <Button disabled={!valid || submitting} onClick={() => onSend(assemble())}>Send quote</Button>
        </div>
      </SummaryRail>
    </div>
  );
}
