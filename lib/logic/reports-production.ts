import { equipmentKindMeta, equipmentStateMeta, orderStatusMeta } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import { isLate, lateOrders, onSchedulePct, openOrders } from "./dashboard";
import { equipmentLoads, shopFloorSummary } from "./shop-floor";
import { cell, ratioPct, type ReportCell, type ReportDef } from "./report-types";

export const equipmentUtilization: ReportDef = {
  key: "equipment-utilization",
  title: "Equipment Utilization",
  framing: "Current equipment state — utilization history isn't tracked yet.",
  empty: "No equipment on the roster.",
  build(data, asOf) {
    const loads = equipmentLoads(openOrders(data.orders), data.equipment, asOf);
    const summary = shopFloorSummary(loads);
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const equipById = new Map(data.equipment.map((e) => [e.id, e]));
    const rows = loads.map((l) => {
      const e = equipById.get(l.equipmentId)!;
      const meta = equipmentStateMeta[l.state];
      return [
        cell.text(e.name),
        cell.text(equipmentKindMeta[e.kind].label),
        cell.pill(meta.label, meta.tone),
        l.load ? cell.mono(l.load.workOrderNumber) : cell.text("—"),
        l.load ? cell.text(nameById.get(l.load.customerId) ?? "—") : cell.text("—"),
      ];
    });
    const inService = loads.length - summary.outOfService;
    return {
      kpis: [
        { label: "Running", value: String(summary.running) },
        { label: "Idle", value: String(summary.idle) },
        { label: "Out of service", value: String(summary.outOfService), tone: summary.outOfService > 0 ? "warn" : undefined },
        { label: "Utilization", value: ratioPct(summary.running, inService) },
      ],
      table: { columns: ["EQUIPMENT", "KIND", "STATE", "WORK ORDER", "CUSTOMER"], rows },
    };
  },
};

export const onTimeDelivery: ReportDef = {
  key: "on-time-delivery",
  title: "On-Time Delivery",
  framing: "Open orders against due date — shipped-delivery history isn't tracked yet.",
  empty: "No open orders.",
  build(data, asOf) {
    const open = [...openOrders(data.orders)].sort((a, b) => a.due.localeCompare(b.due) || a.number.localeCompare(b.number));
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const late = lateOrders(data.orders, asOf).length;
    return {
      kpis: [
        { label: "On-time %", value: String(onSchedulePct(data.orders, asOf)), sub: "of open orders" },
        { label: "Open", value: String(open.length) },
        { label: "Late", value: String(late), tone: late > 0 ? "danger" : undefined },
      ],
      table: {
        columns: ["WORK ORDER", "CUSTOMER", "DUE", "STATUS", "LATE"],
        rows: open.map((o) => {
          const meta = orderStatusMeta[o.status];
          return [
            cell.mono(o.number),
            cell.text(nameById.get(o.customerId) ?? "—"),
            cell.date(o.due),
            cell.pill(meta.label, meta.tone),
            isLate(o, asOf) ? cell.pill("Late", "danger") : cell.text("—"),
          ];
        }),
      },
    };
  },
};

export const rejectReport: ReportDef = {
  key: "reject-report",
  title: "Reject Report",
  empty: "No inspection failures recorded.",
  build(data) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    let inspected = 0;
    const rows: ReportCell[][] = [];
    const sorted = [...data.orders].sort((a, b) => a.number.localeCompare(b.number));
    for (const o of sorted) {
      for (const s of o.steps) {
        if (s.inspectResult == null) continue;
        inspected += 1;
        if (s.inspectResult !== "fail") continue;
        rows.push([
          cell.mono(o.number),
          cell.text(nameById.get(o.customerId) ?? "—"),
          cell.text(s.op),
          cell.mono(s.operatorInitials ?? "—"),
          cell.pill("Fail", "danger"),
        ]);
      }
    }
    return {
      kpis: [
        { label: "Inspect failures", value: String(rows.length), tone: rows.length > 0 ? "danger" : undefined },
        { label: "Steps inspected", value: String(inspected) },
      ],
      table: { columns: ["WORK ORDER", "CUSTOMER", "STEP", "OPERATOR", "RESULT"], rows },
    };
  },
};

export const workInProcess: ReportDef = {
  key: "work-in-process",
  title: "Work-in-Process",
  empty: "Nothing on the floor.",
  build(data, asOf) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const wip = data.orders
      .filter((o) => o.status === "in_process" || o.status === "on_hold")
      .sort((a, b) => a.due.localeCompare(b.due) || a.number.localeCompare(b.number));
    const value = wip.reduce((s, o) => s + o.orderValueCents, 0);
    const late = wip.filter((o) => isLate(o, asOf)).length;
    return {
      kpis: [
        { label: "WIP orders", value: String(wip.length) },
        { label: "WIP value", value: formatMoney(value) },
        { label: "Late in WIP", value: String(late), tone: late > 0 ? "danger" : undefined },
      ],
      table: {
        columns: ["WORK ORDER", "CUSTOMER", "PROCESS", "DUE", "PROGRESS", "VALUE"],
        rows: wip.map((o) => [
          cell.mono(o.number),
          cell.text(nameById.get(o.customerId) ?? "—"),
          cell.text(o.processSummary),
          cell.date(o.due),
          cell.progress(o.progressPct),
          cell.money(o.orderValueCents),
        ]),
      },
    };
  },
};
