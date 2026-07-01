import { cn } from "@/lib/utils";
import type { StatusTone } from "@/lib/domain/enums";

export function KpiTile({ label, value, sub, delta, tone }: {
  label: string; value: string; sub?: string; delta?: string; tone?: StatusTone;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="text-text-muted text-[11px]">{label}</div>
      <div className={cn("mt-1 font-mono text-[26px] font-semibold", tone === "danger" && "text-status-danger")}>{value}</div>
      {delta && <div className="text-status-success text-[11px]">{delta}</div>}
      {sub && <div className="text-text-muted text-[11px]">{sub}</div>}
    </div>
  );
}
