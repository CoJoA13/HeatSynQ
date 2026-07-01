export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="grid place-items-center rounded-card border border-border bg-surface py-16 text-center">
      <div className="max-w-[240px]">
        <div className="font-semibold">{title}</div>
        {description && <p className="mt-1 text-text-muted text-xs">{description}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
