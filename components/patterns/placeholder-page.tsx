import { EmptyState } from "./empty-state";

export function PlaceholderPage({ title, note }: { title: string; note?: string }) {
  return (
    <div>
      <h1 className="mb-5 text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
      <EmptyState title="Coming in a later phase" description={note ?? `${title} isn't part of this build yet.`} />
    </div>
  );
}
