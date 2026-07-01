import { Skeleton } from "@/lib/ui/skeleton";
export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-2 rounded-card border border-border bg-surface p-4">
      {Array.from({ length: count }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  );
}
