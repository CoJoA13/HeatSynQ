export function SummaryRail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="rounded-card border border-border bg-surface p-4">
      <div className="mb-3 font-semibold">{title}</div>
      {children}
    </aside>
  );
}
