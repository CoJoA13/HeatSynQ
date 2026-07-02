import Link from "next/link";
import { SETUP_CARDS } from "@/lib/logic/setup";

export function SetupGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {SETUP_CARDS.map((c) =>
        c.href ? (
          <Link
            key={c.key}
            data-testid={`setup-card-${c.key}`}
            href={c.href}
            className="rounded-card border-border bg-surface hover:bg-canvas block border p-4"
          >
            <div className="flex items-center justify-between">
              <div className="text-[13.5px] font-semibold">{c.title}</div>
              <span className="text-text-faint">→</span>
            </div>
            <p className="text-text-muted mt-1 text-xs leading-relaxed">{c.desc}</p>
          </Link>
        ) : (
          <div key={c.key} data-testid={`setup-card-${c.key}`} className="rounded-card border-border bg-surface border p-4">
            <div className="text-[13.5px] font-semibold">{c.title}</div>
            <p className="text-text-muted mt-1 text-xs leading-relaxed">{c.desc}</p>
            <p className="text-text-faint mt-2 text-[11px]">Not built yet</p>
          </div>
        ),
      )}
    </div>
  );
}
