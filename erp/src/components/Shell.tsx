"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { useLatest } from "@/lib/use-latest";
import { visibleNav, visibleAdmin } from "@/lib/nav";

type Me = { displayName: string; permissions: string[] };

// Local mirror of src/server/search.ts's SearchResults — not imported from src/server/**
// (CLAUDE.md "Constraints that will bite you": a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle).
type SearchResults = {
  exactOrderId: string | null;
  orders: { id: string; orderNumber: number; customerCode: string; poNumber: string; leadPartNumber: string }[];
  parts: { id: string; partNumber: string; customerCode: string; name: string }[];
  customers: { id: string; code: string; name: string }[];
};

// NAV, ADMIN, and the visible-entries decision live in src/lib/nav.ts — a pure client-safe module
// so the gating is unit-testable (tests/nav.test.ts). THE NAV DECISION (Task 16) is documented
// there: Templates is an admin-group entry gated on `templates.view` specifically, and the Admin
// group header shows whenever any admin-group entry is visible.

// "Orders" now lands on "/" (the board replaces the Phase 1 welcome stub), and every other nav
// entry still highlights on a path-prefix match — but "/".startsWith is true for EVERY pathname,
// so the plain `pathname.startsWith(href)` rule Phase 1 used would light "Orders" up on every
// single page. "/" needs an exact match instead; every other href keeps the prefix match (so e.g.
// "/customers/abc123" still highlights "Customers").
function navIsActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pathname === "/login") return;
    api<Me>("/api/auth/me").then(setMe).catch(() => router.push("/login"));
  }, [pathname, router]);

  async function signOut() {
    setMe(null);
    await api("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  // Named `latest`, not `gate` — this file has no `gate()` import of its own, but the parts/
  // customers/processes page precedent always names this binding `latest` for readability at the
  // call sites below, so this file keeps that name too.
  const latest = useLatest();
  // F7 (parts/page.tsx precedent): ticket-gated on BOTH the success and the failure path — a
  // superseded request's rejection landing after a newer request already succeeded must not
  // overwrite fresh results with a stale failure message, and a superseded success must not
  // overwrite a newer one either.
  //
  // Resolves to `null` on failure rather than rethrowing. The debounce timer below fires this
  // with `void runSearch(term)` and attaches no `.catch` — `void` only tells the linter this
  // promise is deliberately not awaited, it does not attach a rejection handler, so a rethrow
  // here would be a genuine unhandled promise rejection at runtime for any search that fails
  // before the Enter path ever calls it. Returning `null` after recording `searchError` keeps
  // this function's promise always-resolving, so no caller needs to remember to catch it —
  // `onSearchKeyDown` below checks the result instead of using try/catch.
  const runSearch = useCallback(async (term: string): Promise<SearchResults | null> => {
    const t = latest.next();
    let data: SearchResults;
    try {
      data = await api<SearchResults>(`/api/search?q=${encodeURIComponent(term)}`);
    } catch (e) {
      if (latest.isCurrent(t)) {
        setSearchError((e as Error).message);
        setOpen(false);
      }
      return null;
    }
    if (latest.isCurrent(t)) {
      setResults(data);
      setOpen(true);
      setSearchError(null);
    }
    return data;
  }, [latest]);

  // Debounced 250ms dropdown (design spec §11). A blank query means nothing to search — clears
  // any stale dropdown/error rather than leaving one on screen from a term the user has since
  // erased.
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults(null);
      setOpen(false);
      setSearchError(null);
      return;
    }
    const timer = setTimeout(() => { void runSearch(term); }, 250);
    debounceRef.current = timer;
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  // Barcode scanners type digits then send Enter near-instantly — often faster than the 250ms
  // debounce window — so Enter cannot simply read whatever `results` happens to already hold. It
  // cancels any pending debounce timer and issues its own immediate, ticket-gated search, and
  // navigates on THAT response's `exactOrderId`. This is the scan path (task-12-brief.md).
  async function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const term = query.trim();
    if (!term) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const data = await runSearch(term);
    if (!data) return; // runSearch already recorded the failure via searchError
    if (data.exactOrderId) {
      setOpen(false);
      setQuery("");
      setResults(null);
      router.push(`/orders/${data.exactOrderId}`);
    }
  }

  function selectResult(href: string) {
    setOpen(false);
    setQuery("");
    setResults(null);
    router.push(href);
  }

  if (pathname === "/login") return <>{children}</>;
  if (!me) return null;

  // Which admin-group entries this user can see — the Admin header renders iff any are visible
  // (admin.view OR the templates.view-gated Templates entry). See src/lib/nav.ts's nav decision.
  const adminEntries = visibleAdmin(me.permissions);
  const noMatches = results !== null
    && results.orders.length === 0 && results.parts.length === 0 && results.customers.length === 0;

  return (
    <div className="flex min-h-screen bg-slate-100">
      <aside className="w-52 shrink-0 bg-slate-900 text-slate-100">
        <div className="p-4 text-lg font-semibold">Shop ERP</div>
        <nav className="space-y-1 px-2 text-sm">
          {visibleNav(me.permissions).map((n) => (
            <Link key={n.href} href={n.href}
                  className={`block rounded px-2 py-1.5 hover:bg-slate-700 ${navIsActive(n.href, pathname) ? "bg-slate-700" : ""}`}>
              {n.label}
            </Link>
          ))}
          {adminEntries.length > 0 && (
            <>
              <div className="pt-3 text-xs uppercase text-slate-400">Admin</div>
              {adminEntries.map((n) => (
                <Link key={n.href} href={n.href}
                      className={`block rounded px-2 py-1.5 hover:bg-slate-700 ${navIsActive(n.href, pathname) ? "bg-slate-700" : ""}`}>
                  {n.label}
                </Link>
              ))}
            </>
          )}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center gap-4 border-b bg-white px-4 py-2">
          <div className="relative flex-1">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { void onSearchKeyDown(e); }}
              onFocus={() => { if (results) setOpen(true); }}
              onBlur={() => setOpen(false)}
              placeholder="Search orders, parts, customers… (scan a traveler barcode)"
              className="w-full max-w-xl rounded border px-3 py-1.5 text-sm"
            />
            {open && results && (
              <div className="absolute z-10 mt-1 w-full max-w-xl rounded border bg-white text-sm shadow-lg">
                {noMatches ? (
                  <div className="p-2 text-slate-500">No matches</div>
                ) : (
                  <>
                    {results.orders.length > 0 && (
                      <div>
                        <div className="bg-slate-50 px-2 py-1 text-xs font-medium text-slate-500">Orders</div>
                        {results.orders.map((o) => (
                          <button key={o.id} type="button" onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => selectResult(`/orders/${o.id}`)}
                                  className="block w-full px-2 py-1 text-left hover:bg-slate-100">
                            #{o.orderNumber} · {o.customerCode} · PO {o.poNumber || "—"} · {o.leadPartNumber}
                          </button>
                        ))}
                      </div>
                    )}
                    {results.parts.length > 0 && (
                      <div>
                        <div className="bg-slate-50 px-2 py-1 text-xs font-medium text-slate-500">Parts</div>
                        {results.parts.map((p) => (
                          <button key={p.id} type="button" onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => selectResult(`/parts/${p.id}`)}
                                  className="block w-full px-2 py-1 text-left hover:bg-slate-100">
                            {p.customerCode} · {p.partNumber} — {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {results.customers.length > 0 && (
                      <div>
                        <div className="bg-slate-50 px-2 py-1 text-xs font-medium text-slate-500">Customers</div>
                        {results.customers.map((c) => (
                          <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => selectResult(`/customers/${c.id}`)}
                                  className="block w-full px-2 py-1 text-left hover:bg-slate-100">
                            {c.code} · {c.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {searchError && (
              <div className="absolute z-10 mt-1 w-full max-w-xl rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                {searchError}
              </div>
            )}
          </div>
          <span className="text-sm">{me.displayName}</span>
          <button onClick={signOut} className="rounded border px-2 py-1 text-sm">Sign out</button>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
