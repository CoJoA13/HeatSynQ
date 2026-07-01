import { cn } from "@/lib/utils";
export function MonoId({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-text", className)}>{children}</span>;
}
