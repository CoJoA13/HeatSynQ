import { Button } from "@/lib/ui/button";
export function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-card border border-status-danger-tint bg-surface p-6 text-center">
      <div className="text-status-danger font-semibold">Something went wrong</div>
      <p className="mt-1 text-text-muted text-xs">{message}</p>
      <Button variant="outline" className="mt-4" onClick={onRetry}>Retry</Button>
    </div>
  );
}
