import Link from "next/link";
import { ArrowLeft } from "lucide-react";
export function DetailHeader({ backHref, backLabel, title, subtitle, statusPill, actions }: {
  backHref: string; backLabel: string; title: React.ReactNode; subtitle?: string;
  statusPill?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <Link href={backHref} className="text-primary text-xs"> <ArrowLeft className="inline size-3" /> {backLabel}</Link>
      <div className="mt-2 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
          {statusPill}
        </div>
        <div className="flex gap-2">{actions}</div>
      </div>
      {subtitle && <p className="text-text-muted text-xs">{subtitle}</p>}
    </div>
  );
}
