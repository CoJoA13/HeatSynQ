import { describe, it, expect } from "vitest";
import { parseSetpoint, parseDurationMinutes, equipmentForStep, equipmentLoads, shopFloorSummary } from "./shop-floor";
import type { WorkOrder, OrderStep, Equipment } from "@/lib/domain";

describe("parseSetpoint", () => {
  it("returns the first Fahrenheit setpoint", () => {
    expect(parseSetpoint(["1700°F", "8.0 hr", "0.90% C", "Oil quench"])).toBe("1700°F");
    expect(parseSetpoint(["350°F", "2.0 hr"])).toBe("350°F");
  });
  it("returns null when no temperature is present", () => {
    expect(parseSetpoint([])).toBeNull();
    expect(parseSetpoint(["Oil quench", "Furnace cool"])).toBeNull();
  });
});

describe("parseDurationMinutes", () => {
  it("parses hours to minutes", () => {
    expect(parseDurationMinutes(["1700°F", "8.0 hr"])).toBe(480);
    expect(parseDurationMinutes(["400°F", "2.0 hr"])).toBe(120);
  });
  it("parses minutes", () => {
    expect(parseDurationMinutes(["90 min"])).toBe(90);
  });
  it("returns null when no duration is present", () => {
    expect(parseDurationMinutes(["975°F", "Gas quench"])).toBeNull();
    expect(parseDurationMinutes([])).toBeNull();
  });
});

describe("equipmentForStep", () => {
  it("matches an exact roster name (case-insensitive)", () => {
    expect(equipmentForStep({ equip: "Batch IQ #3", op: "Carburize" }, ROSTER)).toBe("eq-iq-3");
    expect(equipmentForStep({ equip: "Pit Furnace #1", op: "Nitride" }, ROSTER)).toBe("eq-pit-1");
    expect(equipmentForStep({ equip: "wash station", op: "Wash & rack" }, ROSTER)).toBe("eq-wash-1");
    expect(equipmentForStep({ equip: "Inspection", op: "Final inspect" }, ROSTER)).toBe("eq-inspect-1");
  });

  it("falls back to a kind default via keyword when the name is not in the roster", () => {
    expect(equipmentForStep({ equip: "Temper Oven #4", op: "Temper" }, ROSTER)).toBe("eq-temper-1");
    expect(equipmentForStep({ equip: "Vacuum #1", op: "Vacuum harden" }, ROSTER)).toBe("eq-vac-1");
    expect(equipmentForStep({ equip: "Continuous Belt #2", op: "Carbonitride" }, ROSTER)).toBe("eq-belt-1");
  });

  it("falls back to eq-iq-1 for unmapped stations", () => {
    expect(equipmentForStep({ equip: "Receiving", op: "Receive & verify" }, ROSTER)).toBe("eq-iq-1");
    expect(equipmentForStep({ equip: "Shipping", op: "Certify & ship" }, ROSTER)).toBe("eq-iq-1");
  });
});

const AS_OF = "2026-07-01T00:00:00.000Z";

function step(p: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "equip" | "state">): OrderStep {
  return {
    track: "track_in_out", areaId: "in_process", instr: "", params: [],
    operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null, ...p,
  };
}
function wo(p: Partial<WorkOrder> & Pick<WorkOrder, "id" | "number" | "status" | "steps">): WorkOrder {
  return {
    createdAt: "", updatedAt: "", version: 1, customerId: "c1", customerPO: "", quoteId: null,
    processSummary: "", processMasterId: null, orderedDate: "2026-06-01T00:00:00.000Z",
    due: "2026-08-01T00:00:00.000Z", certifyRequired: false, certSpecId: null, orderValueCents: 0,
    progressPct: 50, lines: [], pricing: [], activity: [], ...p,
  };
}
function equip(p: Partial<Equipment> & Pick<Equipment, "id" | "name" | "kind">): Equipment {
  return { createdAt: "", updatedAt: "", version: 0, availability: "available", note: null, ...p };
}
const ROSTER: Equipment[] = [
  equip({ id: "eq-iq-1", name: "Batch IQ #1", kind: "batch_iq" }),
  equip({ id: "eq-iq-2", name: "Batch IQ #2", kind: "batch_iq" }),
  equip({ id: "eq-iq-3", name: "Batch IQ #3", kind: "batch_iq" }),
  equip({ id: "eq-temper-1", name: "Temper Oven #1", kind: "temper" }),
  equip({ id: "eq-temper-2", name: "Temper Oven #2", kind: "temper" }),
  equip({ id: "eq-vac-1", name: "Vacuum Furnace #1", kind: "vacuum" }),
  equip({ id: "eq-pit-1", name: "Pit Furnace #1", kind: "pit" }),
  equip({ id: "eq-belt-1", name: "Continuous Belt #1", kind: "continuous" }),
  equip({ id: "eq-wash-1", name: "Wash Station", kind: "wash" }),
  equip({ id: "eq-inspect-1", name: "Inspection", kind: "inspect" }),
];
function find(loads: ReturnType<typeof equipmentLoads>, id: string) {
  return loads.find((l) => l.equipmentId === id)!;
}

describe("equipmentLoads", () => {
  it("returns one entry per roster unit, all idle when no in_process steps", () => {
    const loads = equipmentLoads([], ROSTER, AS_OF);
    expect(loads).toHaveLength(10);
    expect(loads.every((l) => l.state === "idle" && l.load === null)).toBe(true);
  });

  it("marks a unit running with its in_process load, setpoint and est finish", () => {
    const o = wo({
      id: "wo-1", number: "WO-1", status: "in_process", progressPct: 40,
      steps: [step({
        n: 3, op: "Carburize", equip: "Batch IQ #3", state: "in_process",
        params: ["1700°F", "8.0 hr", "Oil quench"], operatorInitials: "DM",
        trackedInAt: "2026-07-01T06:00:00.000Z",
      })],
    });
    const iq3 = find(equipmentLoads([o], ROSTER, AS_OF), "eq-iq-3");
    expect(iq3.state).toBe("running");
    expect(iq3.load?.workOrderNumber).toBe("WO-1");
    expect(iq3.load?.op).toBe("Carburize");
    expect(iq3.load?.progressPct).toBe(40);
    expect(iq3.load?.operatorInitials).toBe("DM");
    expect(iq3.load?.setpoint).toBe("1700°F");
    expect(iq3.load?.estFinishIso).toBe("2026-07-01T14:00:00.000Z"); // +8h
    expect(iq3.load?.late).toBe(false);
  });

  it("marks a unit on_hold when the holding order is on_hold", () => {
    const o = wo({
      id: "wo-h", number: "WO-H", status: "on_hold",
      steps: [step({ n: 2, op: "Neutral harden", equip: "Batch IQ #3", state: "in_process" })],
    });
    expect(find(equipmentLoads([o], ROSTER, AS_OF), "eq-iq-3").state).toBe("on_hold");
  });

  it("flags a late running load", () => {
    const o = wo({
      id: "wo-late", number: "WO-LATE", status: "in_process", due: "2026-06-20T00:00:00.000Z",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process" })],
    });
    expect(find(equipmentLoads([o], ROSTER, AS_OF), "eq-pit-1").load?.late).toBe(true);
  });

  it("on contention keeps the earliest trackedInAt as the current load and counts the rest queued", () => {
    const older = wo({
      id: "wo-old", number: "WO-OLD", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: "2026-07-01T01:00:00.000Z" })],
    });
    const newer = wo({
      id: "wo-new", number: "WO-NEW", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: "2026-07-01T05:00:00.000Z" })],
    });
    const pit = find(equipmentLoads([newer, older], ROSTER, AS_OF), "eq-pit-1");
    expect(pit.load?.workOrderNumber).toBe("WO-OLD");
    expect(pit.queued).toBe(1);
  });

  it("ignores steps that are not in_process", () => {
    const o = wo({
      id: "wo-p", number: "WO-P", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "pending" })],
    });
    expect(find(equipmentLoads([o], ROSTER, AS_OF), "eq-pit-1").state).toBe("idle");
  });

  it("on_hold load with a duration param yields estFinishIso === null (no false forecast)", () => {
    const o = wo({
      id: "wo-hold-dur", number: "WO-HOLD-DUR", status: "on_hold",
      steps: [step({
        n: 2, op: "Carbonitride", equip: "Continuous Belt #1", state: "in_process",
        params: ["1550°F", "2.0 hr"],
        trackedInAt: "2026-07-01T06:00:00.000Z",
      })],
    });
    const load = find(equipmentLoads([o], ROSTER, AS_OF), "eq-belt-1");
    expect(load.state).toBe("on_hold");
    expect(load.load?.setpoint).toBe("1550°F");
    expect(load.load?.estFinishIso).toBeNull();
  });

  it("null trackedInAt sorts last — non-null candidate wins current slot, null goes to queued", () => {
    const withTime = wo({
      id: "wo-timed", number: "WO-TIMED", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: "2026-07-01T03:00:00.000Z" })],
    });
    const noTime = wo({
      id: "wo-notime", number: "WO-NOTIME", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: null })],
    });
    const pit = find(equipmentLoads([noTime, withTime], ROSTER, AS_OF), "eq-pit-1");
    expect(pit.load?.workOrderNumber).toBe("WO-TIMED");
    expect(pit.queued).toBe(1);
  });

  it("identical trackedInAt — lower WO number wins current slot", () => {
    const shared = "2026-07-01T04:00:00.000Z";
    const lower = wo({
      id: "wo-lower", number: "WO-100", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: shared })],
    });
    const higher = wo({
      id: "wo-higher", number: "WO-200", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: shared })],
    });
    const pit = find(equipmentLoads([higher, lower], ROSTER, AS_OF), "eq-pit-1");
    expect(pit.load?.workOrderNumber).toBe("WO-100");
    expect(pit.queued).toBe(1);
  });

  it("availability wins the displayed state but the tracked-in load still shows (honest)", () => {
    const roster = ROSTER.map((e) => e.id === "eq-iq-3" ? { ...e, availability: "down" as const, note: "Broken" } : e);
    const o = wo({
      id: "wo-1", number: "WO-1", status: "in_process",
      steps: [step({ n: 3, op: "Carburize", equip: "Batch IQ #3", state: "in_process",
        params: ["1700°F", "8.0 hr"], trackedInAt: "2026-07-01T06:00:00.000Z" })],
    });
    const iq3 = find(equipmentLoads([o], roster, AS_OF), "eq-iq-3");
    expect(iq3.state).toBe("down");
    expect(iq3.load?.workOrderNumber).toBe("WO-1");
    expect(iq3.load?.estFinishIso).toBeNull(); // no forecast unless running
  });

  it("an unloaded unit under maintenance reports state maintenance, not idle", () => {
    const roster = ROSTER.map((e) => e.id === "eq-vac-1" ? { ...e, availability: "maintenance" as const, note: "SAT" } : e);
    expect(find(equipmentLoads([], roster, AS_OF), "eq-vac-1").state).toBe("maintenance");
  });
});

describe("shopFloorSummary", () => {
  it("counts running / idle / on_hold / late", () => {
    const running = wo({ id: "r", number: "R", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: "2026-07-01T01:00:00.000Z" })] });
    const held = wo({ id: "h", number: "H", status: "on_hold",
      steps: [step({ n: 2, op: "Neutral harden", equip: "Batch IQ #3", state: "in_process" })] });
    const s = shopFloorSummary(equipmentLoads([running, held], ROSTER, AS_OF));
    expect(s.running).toBe(1);
    expect(s.onHold).toBe(1);
    expect(s.idle).toBe(8);
    expect(s.late).toBe(0);
  });

  it("summary counts out-of-service units", () => {
    const roster = ROSTER.map((e) =>
      e.id === "eq-vac-1" ? { ...e, availability: "maintenance" as const } :
      e.id === "eq-temper-2" ? { ...e, availability: "down" as const } : e);
    const s = shopFloorSummary(equipmentLoads([], roster, AS_OF));
    expect(s.outOfService).toBe(2);
    expect(s.idle).toBe(8);
  });
});
