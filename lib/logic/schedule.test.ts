import { describe, it, expect } from "vitest";
import {
  weekDays, weekDayLabel, unscheduledOrders, scheduleCells, scheduleSummary,
  assignPatch, unschedulePatch, movePatch,
} from "./schedule";
import type { WorkOrder, ScheduleBlock } from "@/lib/domain";

const ASOF = "2026-06-30T12:00:00.000Z"; // Tuesday
const WEEK = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03"];

function wo(over: Partial<WorkOrder>): WorkOrder {
  return {
    id: "wo-x", createdAt: "t", updatedAt: "t", version: 0, number: "WO-X",
    customerId: "cust-apex", customerPO: "", quoteId: null, processSummary: "Carburize",
    processMasterId: null, status: "received", orderedDate: "2026-06-01T00:00:00.000Z",
    due: "2026-07-03T00:00:00.000Z", certifyRequired: false, certSpecId: null,
    orderValueCents: 0, progressPct: 0, lines: [], pricing: [],
    steps: [{ n: 1, op: "Carburize", equip: "Batch IQ #1", instr: "", params: [], track: "track_in_out",
      areaId: "in_process", state: "pending", operatorId: null, operatorInitials: null,
      trackedInAt: null, trackedOutAt: null, inspectResult: null }],
    activity: [], ...over,
  };
}
function block(over: Partial<ScheduleBlock>): ScheduleBlock {
  return { id: "sb-x", createdAt: "t", updatedAt: "t", version: 0,
    workOrderId: "wo-x", equipmentId: "eq-iq-1", day: "2026-07-01T00:00:00.000Z", state: "planned", ...over };
}

describe("weekDays", () => {
  it("returns Mon–Fri of the week containing a mid-week asOf", () => {
    const days = weekDays(ASOF);
    expect(days.map((d) => d.iso.slice(0, 10))).toEqual(WEEK);
    expect(days[0].label).toBe("Mon 6/29");
    expect(days[0].iso).toBe("2026-06-29T00:00:00.000Z");
  });
  it("Monday asOf resolves to its own week", () => {
    expect(weekDays("2026-06-29T00:00:00.000Z").map((d) => d.iso.slice(0, 10))).toEqual(WEEK);
  });
  it("Sunday asOf resolves to the Monday on/before (week just ending)", () => {
    // 2026-07-05 is a Sunday → Monday-on-or-before is 2026-06-29.
    expect(weekDays("2026-07-05T00:00:00.000Z").map((d) => d.iso.slice(0, 10))).toEqual(WEEK);
  });
});

describe("weekDayLabel", () => {
  it("formats an ISO day in UTC", () => {
    expect(weekDayLabel("2026-07-02T00:00:00.000Z")).toBe("Thu 7/2");
  });
});

describe("unscheduledOrders", () => {
  it("returns received orders with no planned block, sorted by due", () => {
    const a = wo({ id: "a", status: "received", due: "2026-07-03T00:00:00.000Z" });
    const b = wo({ id: "b", status: "received", due: "2026-07-01T00:00:00.000Z" });
    const scheduled = wo({ id: "c", status: "scheduled" });
    const blocks = [block({ id: "sb-a", workOrderId: "a", state: "cancelled" })]; // cancelled → still unscheduled
    const out = unscheduledOrders([a, b, scheduled], blocks);
    expect(out.map((o) => o.id)).toEqual(["b", "a"]);
  });
  it("excludes an order that has a planned block", () => {
    const a = wo({ id: "a", status: "received" });
    const out = unscheduledOrders([a], [block({ workOrderId: "a", state: "planned" })]);
    expect(out).toEqual([]);
  });
});

describe("scheduleCells", () => {
  it("projects a planned block in-week onto a cell with live status", () => {
    const order = wo({ id: "a", number: "WO-A", status: "scheduled", due: "2026-07-03T00:00:00.000Z" });
    const cells = scheduleCells([block({ id: "sb-a", workOrderId: "a" })], [order], ASOF);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      blockId: "sb-a", equipmentId: "eq-iq-1", day: "2026-07-01T00:00:00.000Z",
      workOrderNumber: "WO-A", op: "Carburize", status: "scheduled", late: false, actionable: true,
    });
  });
  it("drops cancelled blocks, shipped orders, and blocks outside the week", () => {
    const order = wo({ id: "a", status: "scheduled" });
    const shipped = wo({ id: "b", status: "shipped" });
    const cells = scheduleCells([
      block({ id: "c1", workOrderId: "a", state: "cancelled" }),
      block({ id: "c2", workOrderId: "b", state: "planned" }),
      block({ id: "c3", workOrderId: "a", day: "2026-08-10T00:00:00.000Z", state: "planned" }),
    ], [order, shipped], ASOF);
    expect(cells).toEqual([]);
  });
  it("marks a past-due open order LATE and non-actionable once in_process", () => {
    const order = wo({ id: "a", status: "in_process", due: "2026-06-20T00:00:00.000Z" });
    const cells = scheduleCells([block({ workOrderId: "a" })], [order], ASOF);
    expect(cells[0].late).toBe(true);
    expect(cells[0].actionable).toBe(false);
  });
  it("received WO with in-week planned block yields actionable:true (stale planned block recovery)", () => {
    const order = wo({ id: "a", number: "WO-A", status: "received", due: "2026-07-03T00:00:00.000Z" });
    const cells = scheduleCells([block({ id: "sb-a", workOrderId: "a" })], [order], ASOF);
    expect(cells).toHaveLength(1);
    expect(cells[0].actionable).toBe(true);
  });
  it("in_process WO with planned block yields actionable:false", () => {
    const order = wo({ id: "a", number: "WO-A", status: "in_process", due: "2026-07-03T00:00:00.000Z" });
    const cells = scheduleCells([block({ id: "sb-a", workOrderId: "a" })], [order], ASOF);
    expect(cells).toHaveLength(1);
    expect(cells[0].actionable).toBe(false);
  });
  it("ready_to_ship WO with planned block yields actionable:false", () => {
    const order = wo({ id: "a", number: "WO-A", status: "ready_to_ship", due: "2026-07-03T00:00:00.000Z" });
    const cells = scheduleCells([block({ id: "sb-a", workOrderId: "a" })], [order], ASOF);
    expect(cells).toHaveLength(1);
    expect(cells[0].actionable).toBe(false);
  });
  it("orders same-cell collisions deterministically by WO number", () => {
    const o1 = wo({ id: "1", number: "WO-100", status: "scheduled" });
    const o2 = wo({ id: "2", number: "WO-050", status: "scheduled" });
    const cells = scheduleCells([
      block({ id: "b1", workOrderId: "1" }), block({ id: "b2", workOrderId: "2" }),
    ], [o1, o2], ASOF);
    expect(cells.map((c) => c.workOrderNumber)).toEqual(["WO-050", "WO-100"]);
  });
});

describe("scheduleSummary", () => {
  it("counts scheduled, unscheduled, late", () => {
    const order = wo({ id: "a", status: "in_process", due: "2026-06-20T00:00:00.000Z" });
    const cells = scheduleCells([block({ workOrderId: "a" })], [order], ASOF);
    expect(scheduleSummary(cells, [wo({ id: "q" })])).toEqual({ scheduled: 1, unscheduled: 1, late: 1 });
  });
});

describe("mutation patch builders", () => {
  it("assignPatch sets scheduled + activity and a planned block input", () => {
    const order = wo({ id: "a", activity: [{ actor: "System", message: "Order received", at: "t0" }] });
    const p = assignPatch(order, { id: "eq-iq-2", name: "Batch IQ #2" }, "2026-07-01T00:00:00.000Z", "Dana Mercer", "t1");
    expect(p.workOrder.status).toBe("scheduled");
    expect(p.workOrder.activity.at(-1)).toEqual({ actor: "Dana Mercer", message: "Scheduled — Batch IQ #2 · Wed 7/1", at: "t1" });
    expect(p.block).toEqual({ workOrderId: "a", equipmentId: "eq-iq-2", day: "2026-07-01T00:00:00.000Z", state: "planned" });
  });
  it("unschedulePatch cancels the block and reverts to received + activity", () => {
    const order = wo({ id: "a", status: "scheduled", activity: [] });
    const p = unschedulePatch(order, "Dana Mercer", "t2");
    expect(p.block).toEqual({ state: "cancelled" });
    expect(p.workOrder.status).toBe("received");
    expect(p.workOrder.activity.at(-1)).toEqual({ actor: "Dana Mercer", message: "Unscheduled — returned to Received", at: "t2" });
  });
  it("movePatch returns the new equipment + day", () => {
    expect(movePatch("eq-vac-1", "2026-07-02T00:00:00.000Z")).toEqual({ equipmentId: "eq-vac-1", day: "2026-07-02T00:00:00.000Z" });
  });
});
