"use client";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { NAV_GROUPS } from "./nav-config";

const CREATE = [
  { label: "New quote", href: "/quotes/new" },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  function go(href: string) { onOpenChange(false); router.push(href); }
  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette"
      className="fixed left-1/2 top-24 z-50 w-[560px] max-w-[90vw] -translate-x-1/2 rounded-modal border border-border bg-surface shadow-2xl">
      <Command.Input placeholder="Search destinations and actions…" autoFocus
        className="w-full border-b border-border px-4 py-3 text-[13px] outline-none" />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-text-muted text-xs">No results found.</Command.Empty>
        <Command.Group heading="Create" className="font-mono text-[10.5px] uppercase tracking-[.1em] text-text-faint">
          {CREATE.map((c) => (
            <Command.Item key={c.href} onSelect={() => go(c.href)}
              className="cursor-pointer rounded-[9px] px-3 py-2 text-[13px] text-text aria-selected:bg-primary-tint aria-selected:text-primary">
              {c.label}
            </Command.Item>
          ))}
        </Command.Group>
        {NAV_GROUPS.map((g, gi) => (
          <Command.Group key={gi} heading={g.label ?? "Go to"} className="font-mono text-[10.5px] uppercase tracking-[.1em] text-text-faint">
            {g.items.map((it) => (
              <Command.Item key={it.key} onSelect={() => go(it.href)}
                className="cursor-pointer rounded-[9px] px-3 py-2 text-[13px] text-text aria-selected:bg-primary-tint aria-selected:text-primary">
                {it.label}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
