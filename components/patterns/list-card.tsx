import { cn } from "@/lib/utils";
export function ListCard({ headers, rows, onRowClick }: {
  headers: string[]; rows: React.ReactNode[][]; onRowClick?: (index: number) => void;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-border">
            {headers.map((h) => <th key={h} className="px-4 py-3 font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} onClick={() => onRowClick?.(i)}
              className={cn("border-b border-border-faint last:border-0", onRowClick && "cursor-pointer hover:bg-canvas")}>
              {row.map((cell, j) => <td key={j} className="px-4 py-3 align-top">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
