import { cn } from "@/lib/utils";
import { toneClasses, type StatusTone } from "@/lib/domain/enums";

export function StatusPill({ tone, children, className }: { tone: StatusTone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-pill px-2.5 py-0.5 font-mono text-[11px]", toneClasses(tone), className)}>
      {children}
    </span>
  );
}
