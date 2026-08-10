"use client";
// The `/receivables` sub-nav (Task 15 Step 3, closing Task 14's flagged gap: nothing linked to
// `/receivables/aging` or `/receivables/statements` before this). Shared across the
// `/receivables*` screens — the worklist, aging, statements, and (P5C Task 8) the month-end
// close/GL-export screen — mirroring Shell.tsx's own `navIsActive` shape (exact match for the
// section root, prefix match for its sub-pages) at a smaller scale, since no other multi-page
// area in this app has its own sub-nav to copy instead. No permission check of its own: every
// tab's destination page gates itself on `receivables.view` (§5.16) and shows why if denied —
// same as the aging/statements entries this "Close" tab mirrors.
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: { label: string; href: string }[] = [
  { label: "Batches", href: "/receivables" },
  { label: "Aging", href: "/receivables/aging" },
  { label: "Statements", href: "/receivables/statements" },
  { label: "Close", href: "/receivables/close" },
];

function tabActive(href: string, pathname: string): boolean {
  return href === "/receivables" ? pathname === "/receivables" : pathname.startsWith(href);
}

export function ReceivablesNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-4 flex gap-4 border-b text-sm">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href}
              className={`border-b-2 px-1 pb-2 ${
                tabActive(t.href, pathname)
                  ? "border-slate-800 font-medium text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
