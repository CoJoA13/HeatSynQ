"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";

type Me = { displayName: string; permissions: string[] };

const NAV: { label: string; href: string; area: string }[] = [
  { label: "Orders", href: "/orders", area: "orders" },
  { label: "Quotes", href: "/quotes", area: "quotes" },
  { label: "Certifications", href: "/certs", area: "certs" },
  { label: "Shipping", href: "/shipping", area: "shipping" },
  { label: "Invoicing", href: "/invoicing", area: "invoicing" },
  { label: "A/R", href: "/ar", area: "ar" },
  { label: "Customers", href: "/customers", area: "customers" },
  { label: "Parts", href: "/parts", area: "parts" },
  { label: "Processes", href: "/processes", area: "processes" },
  { label: "Reports", href: "/reports", area: "reports" },
];

const ADMIN = [
  { label: "Users", href: "/admin/users" },
  { label: "Roles", href: "/admin/roles" },
  { label: "Settings", href: "/admin/settings" },
  { label: "Audit log", href: "/admin/audit" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(() => router.push("/login"));
  }, [router]);

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  if (pathname === "/login") return <>{children}</>;
  if (!me) return null;

  const canView = (area: string) => me.permissions.includes(`${area}.view`);

  return (
    <div className="flex min-h-screen bg-slate-100">
      <aside className="w-52 shrink-0 bg-slate-900 text-slate-100">
        <div className="p-4 text-lg font-semibold">Shop ERP</div>
        <nav className="space-y-1 px-2 text-sm">
          {NAV.filter((n) => canView(n.area)).map((n) => (
            <Link key={n.href} href={n.href}
                  className={`block rounded px-2 py-1.5 hover:bg-slate-700 ${pathname.startsWith(n.href) ? "bg-slate-700" : ""}`}>
              {n.label}
            </Link>
          ))}
          {canView("admin") && (
            <>
              <div className="pt-3 text-xs uppercase text-slate-400">Admin</div>
              {ADMIN.map((n) => (
                <Link key={n.href} href={n.href}
                      className={`block rounded px-2 py-1.5 hover:bg-slate-700 ${pathname.startsWith(n.href) ? "bg-slate-700" : ""}`}>
                  {n.label}
                </Link>
              ))}
            </>
          )}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center gap-4 border-b bg-white px-4 py-2">
          <form className="flex-1" onSubmit={(e) => { e.preventDefault(); setNotice("Search arrives with the Orders phase."); setTimeout(() => setNotice(null), 2000); }}>
            <input placeholder="Search orders, POs, parts… (scan a traveler barcode)"
                   className="w-full max-w-xl rounded border px-3 py-1.5 text-sm" />
          </form>
          {notice && <span className="text-xs text-slate-500">{notice}</span>}
          <span className="text-sm">{me.displayName}</span>
          <button onClick={signOut} className="rounded border px-2 py-1 text-sm">Sign out</button>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
