import { Button } from "@/lib/ui/button";
import { Filter } from "lucide-react";
export function PageHeader({ title, subtitle, action, onFilter }: {
  title: string; subtitle?: string; action?: React.ReactNode; onFilter?: () => void;
}) {
  return (
    <div className="mb-5 flex items-start justify-between">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="text-text-muted text-xs">{subtitle}</p>}
      </div>
      <div className="flex gap-2">
        {onFilter && <Button variant="outline" onClick={onFilter}><Filter className="mr-1 size-4" />Filter</Button>}
        {action}
      </div>
    </div>
  );
}
