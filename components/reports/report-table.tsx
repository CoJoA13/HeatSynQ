import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { formatDate, formatMoney } from "@/lib/utils";
import type { ReportCell, ReportTable as ReportTableData } from "@/lib/logic/reports";

function renderCell(c: ReportCell, key: number): React.ReactNode {
  switch (c.kind) {
    case "text":
      return c.value;
    case "mono":
      return <MonoId key={key}>{c.value}</MonoId>;
    case "date":
      return <span key={key} className="text-text-muted font-mono">{formatDate(c.iso)}</span>;
    case "money":
      return <span key={key} className="font-mono">{formatMoney(c.cents)}</span>;
    case "pct":
      return <span key={key} className="font-mono">{c.value}</span>;
    case "pill":
      return <StatusPill key={key} tone={c.tone}>{c.label}</StatusPill>;
    case "progress":
      return (
        <div key={key} data-testid="report-cell-progress" className="bg-canvas-alt mt-1 h-1.5 w-24 rounded-full">
          <div className="bg-primary h-1.5 rounded-full" style={{ width: `${c.pct}%` }} />
        </div>
      );
  }
}

export function ReportTable({ table }: { table: ReportTableData }) {
  return (
    <div data-testid="report-table">
      <ListCard headers={table.columns} rows={table.rows.map((row) => row.map((c, i) => renderCell(c, i)))} />
    </div>
  );
}
