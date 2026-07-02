"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Part, Quote, Operator, WorkOrder, OrderStatus, Certification, Invoice, Customer, ScheduleBlock, Equipment, Maintenance } from "@/lib/domain";
import { orderStatusMeta, type EquipmentAvailability } from "@/lib/domain/enums";
import type { CreateInput } from "@/lib/data/repositories";
import { useRepositories } from "@/lib/data/provider";
import { queryKeys } from "./keys";
import { navBadgeCounts } from "@/lib/logic/dashboard";
import { sendQuote, approveQuote, rejectQuote, loseQuote, reviseQuote } from "@/lib/logic/quote-state";
import { createOrderFromQuote, createCertForOrder, canTransitionOrder, canShipOrder, activityEntry } from "@/lib/logic/order";
import { trackInStep, trackOutStep, rollUpOrderStatus, orderProgressPct } from "@/lib/logic/tracking";
import { DEMO_NOW } from "@/lib/clock";
import { toBillInvoiceFromOrder, billInvoice, payInvoice } from "@/lib/logic/invoice";
import { assignPatch, unschedulePatch, movePatch } from "@/lib/logic/schedule";
import { completePatch } from "@/lib/logic/maintenance";

export function useCustomers() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.customers, queryFn: () => r.customers.list() }); }
export function useCustomer(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.customer(id), queryFn: () => r.customers.get(id) }); }
export function useParts() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.parts, queryFn: () => r.parts.list() }); }
export function usePart(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.part(id), queryFn: () => r.parts.get(id) }); }
export function useProcessMasters() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.processMasters, queryFn: () => r.processMasters.list() }); }
export function useSpecifications() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.specifications, queryFn: () => r.specifications.list() }); }
export function useStandards() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.standards, queryFn: () => r.standards.list() }); }
export function useQuotes() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.quotes, queryFn: () => r.quotes.list() }); }
export function useQuote(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.quote(id), queryFn: () => r.quotes.get(id) }); }
export function useWorkOrders() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.workOrders, queryFn: () => r.workOrders.list() }); }
export function useWorkOrder(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.workOrder(id), queryFn: () => r.workOrders.get(id) }); }
export function useInvoices() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.invoices, queryFn: () => r.invoices.list() }); }
export function useCertifications() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.certifications, queryFn: () => r.certifications.list() }); }
export function useCertification(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.certification(id), queryFn: () => r.certifications.get(id) }); }
export function useOperators() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.operators, queryFn: () => r.operators.list() }); }
export function useProcessMaster(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.processMaster(id), queryFn: () => r.processMasters.get(id) }); }
export function useContactsByCustomer(customerId: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.contactsByCustomer(customerId), queryFn: () => r.contacts.byCustomer(customerId) }); }
export function usePartsByCustomer(customerId: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.partsByCustomer(customerId), queryFn: () => r.parts.byCustomer(customerId) }); }
export function usePriceKeys() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.priceKeys, queryFn: () => r.priceKeys.list() }); }
export function usePricingRulesByPriceKey(priceKeyId: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.pricingRulesByPriceKey(priceKeyId), queryFn: () => r.pricingRules.byPriceKey(priceKeyId), enabled: priceKeyId !== "" }); }

export function useUpdatePart() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      patch: Partial<Omit<Part, "id" | "createdAt" | "updatedAt" | "version">>;
      version: number;
    }) => r.parts.update(vars.id, vars.patch, vars.version),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: queryKeys.parts });
      qc.invalidateQueries({ queryKey: queryKeys.part(updated.id) });
      qc.invalidateQueries({ queryKey: queryKeys.partsByCustomer(updated.customerId) });
    },
  });
}

export function useReleaseCertification() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; version: number }) =>
      r.certifications.update(vars.id, { status: "released" }, vars.version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.certifications });
    },
  });
}

export function useNavBadges(): Record<string, number> {
  const quotes = useQuotes();
  const orders = useWorkOrders();
  const certs = useCertifications();
  if (!quotes.data || !orders.data || !certs.data) return {};
  return navBadgeCounts(quotes.data, orders.data, certs.data);
}

export function useCreateQuoteDraft() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInput<Quote>) => r.quotes.create(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.quotes }); },
  });
}

export function useUpdateQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<Omit<Quote, "id" | "createdAt" | "updatedAt" | "version">>; version: number }) =>
      r.quotes.update(vars.id, vars.patch, vars.version),
    onSuccess: (u) => { qc.invalidateQueries({ queryKey: queryKeys.quotes }); qc.invalidateQueries({ queryKey: queryKeys.quote(u.id) }); },
  });
}

function invalidateQuote(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: queryKeys.quotes });
  qc.invalidateQueries({ queryKey: queryKeys.quote(id) });
}

export function useSendQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { quote: Quote; operator: Operator }) => {
      const { status } = sendQuote(vars.quote, vars.operator);
      return r.quotes.update(vars.quote.id, { status }, vars.quote.version);
    },
    onSuccess: (u) => invalidateQuote(qc, u.id),
  });
}

export function useApproveQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { quote: Quote }) => r.quotes.update(vars.quote.id, { status: approveQuote(vars.quote).status }, vars.quote.version),
    onSuccess: (u) => invalidateQuote(qc, u.id),
  });
}

export function useRejectQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { quote: Quote }) => r.quotes.update(vars.quote.id, { status: rejectQuote(vars.quote).status }, vars.quote.version),
    onSuccess: (u) => invalidateQuote(qc, u.id),
  });
}

export function useLoseQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { quote: Quote }) => r.quotes.update(vars.quote.id, { status: loseQuote(vars.quote).status }, vars.quote.version),
    onSuccess: (u) => invalidateQuote(qc, u.id),
  });
}

export function useWinQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: async (quote: Quote) => {
      const [parts, pms, customer] = await Promise.all([
        r.parts.list(), r.processMasters.list(), r.customers.get(quote.customerId),
      ]);
      if (!customer) throw new Error("Customer not found: " + quote.customerId);
      if (customer.status === "hold") throw new Error("Customer on credit hold — cannot create order");
      const partsById = Object.fromEntries(parts.map((p) => [p.id, p]));
      const processMastersById = Object.fromEntries(pms.map((m) => [m.id, m]));
      // Version-check BEFORE any side effect: a stale quote throws here, leaving no orphan order/cert.
      const won = await r.quotes.update(quote.id, { status: "won" }, quote.version);
      const order = await r.workOrders.create(createOrderFromQuote(quote, { partsById, processMastersById, customer, nowIso: DEMO_NOW }));
      if (order.certifyRequired) await r.certifications.create(createCertForOrder(order, customer));
      return r.quotes.update(quote.id, { wonOrderId: order.id }, won.version);
    },
    onSuccess: (u) => {
      invalidateQuote(qc, u.id);
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.certifications });
    },
  });
}

export function useReviseQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (quote: Quote) => r.quotes.create(reviseQuote(quote)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.quotes }); },
  });
}

export function useTransitionOrder() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { order: WorkOrder; to: OrderStatus; actor: string; at: string }) => {
      if (!canTransitionOrder(vars.order.status, vars.to)) {
        throw new Error(`Illegal transition ${vars.order.status} → ${vars.to}`);
      }
      const activity = [...vars.order.activity, activityEntry(vars.actor, `Status → ${orderStatusMeta[vars.to].label}`, vars.at)];
      return r.workOrders.update(vars.order.id, { status: vars.to, activity }, vars.order.version);
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
    },
  });
}

export function useShipOrder() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { order: WorkOrder; cert: Certification | null; actor: string; at: string; customer?: Customer | null }) => {
      const gate = canShipOrder(vars.order, vars.cert, vars.customer);
      if (!gate.ok) throw new Error(gate.reason ?? "Cannot ship");
      // Read-only first: decide whether a to-bill invoice is still needed (idempotent).
      const existing = await r.invoices.list();
      const willCreate = !existing.some((i) => i.workOrderId === vars.order.id);
      const message = willCreate ? "Shipped — to-bill invoice created" : "Shipped";
      const activity = [...vars.order.activity, activityEntry(vars.actor, message, vars.at)];
      // Version-check the order BEFORE the invoice write: a stale order throws here,
      // so no orphan invoice is ever persisted.
      const shipped = await r.workOrders.update(vars.order.id, { status: "shipped", progressPct: 100, activity }, vars.order.version);
      if (willCreate) await r.invoices.create(toBillInvoiceFromOrder(vars.order, vars.at));
      return shipped;
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
      qc.invalidateQueries({ queryKey: queryKeys.invoices });
    },
  });
}

export function useTrackInStep() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { order: WorkOrder; stepN: number; operator: Operator }) => {
      const at = DEMO_NOW;
      const step = vars.order.steps.find((s) => s.n === vars.stepN);
      const steps = trackInStep(vars.order.steps, vars.stepN, { id: vars.operator.id, initials: vars.operator.initials }, at);
      const status = rollUpOrderStatus(steps, vars.order.status);
      const message = step?.equip ? `Tracked in ${step.op} · ${step.equip}` : `Tracked in ${step?.op ?? "step"}`;
      const activity = [...vars.order.activity, activityEntry(vars.operator.name, message, at)];
      return r.workOrders.update(vars.order.id, { steps, status, progressPct: orderProgressPct(steps), activity }, vars.order.version);
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
    },
  });
}

export function useTrackOutStep() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { order: WorkOrder; stepN: number; operator: Operator; cert: Certification | null; inspectResult?: "pass" | "fail" }) => {
      const at = DEMO_NOW;
      const step = vars.order.steps.find((s) => s.n === vars.stepN);
      const steps = trackOutStep(vars.order.steps, vars.stepN, { id: vars.operator.id, initials: vars.operator.initials }, at, vars.inspectResult);
      const failed = vars.inspectResult === "fail";
      const willRelease = vars.inspectResult === "pass" && vars.cert != null && vars.cert.status === "pending";
      const status = failed ? "on_hold" : rollUpOrderStatus(steps, vars.order.status);
      const message = failed
        ? `Final inspect failed — order on hold`
        : vars.inspectResult === "pass"
          ? willRelease ? `Final inspect passed — cert ${vars.cert!.number} released` : "Final inspect passed"
          : `Tracked out ${step?.op ?? "step"}`;
      const activity = [...vars.order.activity, activityEntry(vars.operator.name, message, at)];
      // Version-check the order update FIRST; a stale order throws before the cert write.
      const updated = await r.workOrders.update(vars.order.id, { steps, status, progressPct: orderProgressPct(steps), activity }, vars.order.version);
      // Inspect pass auto-releases a required pending cert (dependent write, WO-first ordering).
      if (willRelease) {
        await r.certifications.update(vars.cert!.id, { status: "released" }, vars.cert!.version);
      }
      return updated;
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
      qc.invalidateQueries({ queryKey: queryKeys.certifications });
    },
  });
}

export function useBillInvoice() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { invoice: Invoice; at: string }) => {
      const number = await r.numbers.next("invoices");
      const billed = billInvoice(vars.invoice, number, vars.at);
      return r.invoices.update(vars.invoice.id, { status: billed.status, number: billed.number, invoicedDate: billed.invoicedDate }, vars.invoice.version);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.invoices }); },
  });
}

export function usePayInvoice() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { invoice: Invoice; at: string }) => {
      const paid = payInvoice(vars.invoice, vars.at);
      return r.invoices.update(vars.invoice.id, { status: paid.status, paidDate: paid.paidDate }, vars.invoice.version);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.invoices }); },
  });
}

export function useScheduleBlocks() {
  const r = useRepositories();
  return useQuery({ queryKey: queryKeys.scheduleBlocks, queryFn: () => r.scheduleBlocks.list() });
}

export function useEquipment() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.equipment, queryFn: () => r.equipment.list() }); }
export function useEquipmentUnit(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.equipmentUnit(id), queryFn: () => r.equipment.get(id) }); }
export function useMaintenance() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.maintenance, queryFn: () => r.maintenance.list() }); }

export function useAssignSchedule() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { order: WorkOrder; equipment: Pick<Equipment, "id" | "name">; day: string; operator: Operator; at: string }) => {
      const patch = assignPatch(vars.order, vars.equipment, vars.day, vars.operator.name, vars.at);
      // Version-check the WO update FIRST — a stale order throws before any orphan block is created.
      const updated = await r.workOrders.update(vars.order.id, patch.workOrder, vars.order.version);
      await r.scheduleBlocks.create(patch.block);
      return updated;
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
      qc.invalidateQueries({ queryKey: queryKeys.scheduleBlocks });
    },
  });
}

export function useMoveSchedule() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { block: ScheduleBlock; equipmentId: string; day: string }) =>
      r.scheduleBlocks.update(vars.block.id, movePatch(vars.equipmentId, vars.day), vars.block.version),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.scheduleBlocks }); },
  });
}

export function useUnschedule() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { order: WorkOrder; block: ScheduleBlock; operator: Operator; at: string }) => {
      const patch = unschedulePatch(vars.order, vars.operator.name, vars.at);
      // Version-check the WO revert FIRST — a stale order (e.g. already tracked in) throws
      // before the block is cancelled, so no orphaned cancelled block on a non-received order.
      const updated = await r.workOrders.update(vars.order.id, patch.workOrder, vars.order.version);
      await r.scheduleBlocks.update(vars.block.id, patch.block, vars.block.version);
      return updated;
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
      qc.invalidateQueries({ queryKey: queryKeys.scheduleBlocks });
    },
  });
}

export function useSetEquipmentAvailability() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { equipment: Equipment; availability: EquipmentAvailability; note: string | null }) =>
      r.equipment.update(vars.equipment.id, { availability: vars.availability, note: vars.note }, vars.equipment.version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.equipment }); // prefix covers ["equipment", id] detail
    },
  });
}

export function useCompleteMaintenance() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { task: Maintenance; at: string }) =>
      r.maintenance.update(vars.task.id, completePatch(vars.task, vars.at), vars.task.version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.maintenance });
    },
  });
}
