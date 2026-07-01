"use client";
import { KpiTile } from "@/components/patterns";
import { cn } from "@/lib/utils";
import type { RoleKey } from "@/lib/domain";
import type { KpiDescriptor } from "@/lib/logic/dashboard";

const ROLES: { key: RoleKey; label: string }[] = [
  { key: "manager", label: "Manager" },
  { key: "sales", label: "Sales" },
  { key: "office", label: "Office" },
];

export function TodayDashboard({
  greeting,
  viewAs,
  onViewAs,
  tiles,
}: {
  greeting: string;
  viewAs: RoleKey;
  onViewAs: (r: RoleKey) => void;
  tiles: KpiDescriptor[];
}) {
  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{greeting}</h1>
          <p className="text-text-muted text-xs">Here&apos;s your shop at a glance.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-xs">Viewing as</span>
          <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
            {ROLES.map((r) => (
              <button
                key={r.key}
                onClick={() => onViewAs(r.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs",
                  r.key === viewAs ? "bg-primary-tint text-primary font-medium" : "text-text-muted",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {tiles.map((t) => (
          <KpiTile key={t.label} label={t.label} value={t.value} sub={t.sub} tone={t.tone} />
        ))}
      </div>
    </div>
  );
}
