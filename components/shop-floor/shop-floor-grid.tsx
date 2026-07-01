import { KpiTile } from "@/components/patterns";
import { EQUIPMENT } from "@/lib/domain/enums";
import { equipmentLoads, shopFloorSummary } from "@/lib/logic/shop-floor";
import { EquipmentTile } from "./equipment-tile";
import type { WorkOrder, Customer } from "@/lib/domain";

export function ShopFloorGrid({ orders, customers, asOf, onSelect }: {
  orders: WorkOrder[];
  customers: Customer[];
  asOf: string;
  onSelect?: (workOrderId: string) => void;
}) {
  const loads = equipmentLoads(orders, asOf);
  const summary = shopFloorSummary(loads);
  const custById = new Map(customers.map((c) => [c.id, c]));
  const equipById = new Map(EQUIPMENT.map((e) => [e.id, e]));

  return (
    <div>
      <div data-testid="shopfloor-summary" className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Running" value={String(summary.running)} />
        <KpiTile label="Idle" value={String(summary.idle)} />
        <KpiTile label="On hold" value={String(summary.onHold)} tone="warn" />
        <KpiTile label="Late" value={String(summary.late)} tone="danger" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {loads.map((entry) => {
          const equipment = equipById.get(entry.equipmentId)!;
          const name = entry.load ? (custById.get(entry.load.customerId)?.name ?? null) : null;
          return (
            <EquipmentTile key={entry.equipmentId} equipment={equipment} entry={entry} customerName={name} onSelect={onSelect} />
          );
        })}
      </div>
    </div>
  );
}
