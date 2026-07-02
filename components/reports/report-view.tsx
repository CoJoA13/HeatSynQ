import { DetailHeader, EmptyState, KpiTile } from "@/components/patterns";
import { formatDate } from "@/lib/utils";
import type { ReportDef, ReportResult } from "@/lib/logic/reports";
import { ReportTable } from "./report-table";

export function ReportView({ def, result, asOf }: { def: ReportDef; result: ReportResult; asOf: string }) {
  return (
    <div>
      <DetailHeader backHref="/reports" backLabel="Reports" title={def.title} subtitle={def.framing} />
      <div className="text-text-muted mb-4 font-mono text-[11px]">As of {formatDate(asOf)}</div>
      <div
        data-testid="report-kpis"
        className="mb-5 grid gap-3"
        style={{ gridTemplateColumns: `repeat(${result.kpis.length}, minmax(0, 1fr))` }}
      >
        {result.kpis.map((k) => (
          <KpiTile key={k.label} label={k.label} value={k.value} sub={k.sub} tone={k.tone} />
        ))}
      </div>
      {result.table.rows.length === 0 ? <EmptyState title={def.empty} /> : <ReportTable table={result.table} />}
    </div>
  );
}
