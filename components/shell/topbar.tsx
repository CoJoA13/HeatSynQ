"use client";
import { Search } from "lucide-react";
import { useAuth } from "@/lib/auth/provider";

export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { operator } = useAuth();
  return (
    <header className="flex h-[60px] shrink-0 items-center gap-4 border-b border-border bg-surface px-4">
      <button onClick={onOpenPalette}
        className="flex w-[420px] max-w-full items-center gap-2 rounded-[10px] bg-surface-subtle px-3 py-2 text-text-muted text-[13px]">
        <Search className="size-4" />
        <span>Search work orders, customers, parts…</span>
        <kbd className="ml-auto rounded-[5px] border border-border-alt bg-surface-subtle px-1.5 font-mono text-[11px]">⌘K</kbd>
      </button>
      <div className="ml-auto flex items-center gap-3 text-text-muted text-[13px]">
        <span className="font-mono">{new Intl.DateTimeFormat("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"}).format(new Date())}</span>
        <div className="grid size-8 place-items-center rounded-full bg-primary-tint font-mono text-primary text-xs">{operator?.initials ?? "—"}</div>
      </div>
    </header>
  );
}
