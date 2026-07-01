"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, isItemActive } from "./nav-config";

export function Sidebar({ badges = {} }: { badges?: Record<string, number> }) {
  const pathname = usePathname();
  return (
    <aside className="flex w-[252px] shrink-0 flex-col border-r border-border bg-surface-sidebar">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="grid size-8 place-items-center rounded-lg bg-primary font-mono text-surface">H</div>
        <div><div className="font-semibold leading-tight">HeatSynQ</div><div className="text-text-muted text-[11px]">Heritage Heat Treat</div></div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV_GROUPS.map((g, gi) => (
          <div key={gi} className="mb-3">
            {g.label && <div className="px-2 py-1 font-mono text-[10.5px] uppercase tracking-[.1em] text-text-faint">{g.label}</div>}
            {g.items.map((it) => {
              const active = isItemActive(it.href, pathname);
              return (
                <Link key={it.key} href={it.href}
                  className={cn("flex items-center justify-between rounded-[9px] px-2 py-1.5 text-[13px]",
                    active ? "bg-primary-tint text-primary font-medium" : "text-text-nav-idle hover:bg-canvas")}>
                  <span>{it.label}</span>
                  {badges[it.key] != null && <span className="font-mono text-[11px] text-text-muted">{badges[it.key]}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
