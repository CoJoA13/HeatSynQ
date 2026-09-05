"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { useLatest } from "@/lib/use-latest";
import { visibleNav, visibleAdmin } from "@/lib/nav";
import { unsavedLabels, shouldGuardNavigation, subscribeUnsaved, unsavedCount } from "@/lib/unsaved-guard";
import { confirmDiscard } from "@/lib/use-unsaved-section";

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

  // A second, SEPARATE gate for the /api/auth/me fetch — deliberately not sharing sequence
  // numbers with the search gate (`latest`, below): the two answer different questions, and a
  // search dispatch must not orphan a me-response or vice versa.
  const meLatest = useLatest();
  // F7 (customers/page.tsx precedent): ticket-gated on BOTH paths. This effect refires on EVERY
  // pathname change, so a superseded request's transient REJECTION landing after a newer
  // success used to redirect a logged-in user to /login. A stale success is dropped, a stale
  // rejection is swallowed; a CURRENT rejection keeps the redirect.
  useEffect(() => {
    if (pathname === "/login") return;
    const t = meLatest.next();
    api<Me>("/api/auth/me")
      .then((data) => { if (meLatest.isCurrent(t)) setMe(data); })
      .catch(() => { if (meLatest.isCurrent(t)) router.push("/login"); });
  }, [pathname, router, meLatest]);

  // THE UNSAVED-EDIT GUARD (the Shell half; the registry and both predicates are in
  // src/lib/unsaved-guard.ts). A detail page runs two save models at once — blur-save fields above
  // grids that need an explicit "Save X" click — and before this, an edited-but-unsaved grid was
  // discarded silently the moment anyone clicked a nav link. Mounted here because the Shell owns
  // the rail and the search results, which is where that click almost always is; the listener is
  // on `document` in the CAPTURE phase so it runs before next/link's own handler navigates.
  //
  // Both halves are needed and neither covers the other: `beforeunload` is the only thing that can
  // catch a reload, a close, or a typed URL, and it CANNOT catch an in-app route change (no
  // document unload happens); the click guard is the only thing that can catch the in-app case, and
  // it cannot see a reload. Programmatic navigation is covered separately, by `confirmDiscard`
  // above at each `router.push` — a push produces neither a click nor an unload.
  //
  // ACCEPTED, SMALLER GAP (Codex P2 on #272): a plain `<a href>` to an in-app PAGE — BlockerPanel's
  // blocker links, the reports' "All reports" — causes a real document load, so a dirty user gets
  // this prompt and then the browser's own `beforeunload` one. Suppressing the second needs a flag
  // set on confirm and cleared on unload, and it CANNOT be cleared reliably: an SPA link never
  // unloads, so a stale flag would swallow the next genuine prompt. Double-asking is the safe
  // direction and the case is rare; the false-POSITIVE half (export/document links, where the page
  // does not move at all) is the one that mattered and `shouldGuardNavigation` now excludes it.
  //
  // KNOWN GAP, STATED RATHER THAN PAPERED OVER (Codex P1 on #272): the browser BACK/FORWARD buttons
  // are an in-document `popstate` navigation, so none of the three paths above sees them and edits
  // are still discarded silently there. The App Router has no navigation-blocking API — Next 16 has
  // no `beforePopState` (that was the Pages Router), no `onNavigate`, no blocker hook — so the only
  // available workaround is the sentinel-history-entry trick: push a duplicate entry while dirty and
  // re-push it when the user cancels. That was deliberately NOT taken, because the sentinel cannot
  // be removed once the grid is saved: `pushState` adds an entry and nothing pops it, so after the
  // ordinary edit-then-save the FIRST Back press lands on a same-URL entry and appears to do
  // nothing. Trading a rare silent loss for a Back button that feels broken on the common path is
  // the worse deal in a tool people drive all day. Revisit if the App Router grows a real blocker. The predicate is deliberately narrow about which clicks count — see its
  // docstring — because a prompt that also fires on downloads and in-page anchors is one people
  // learn to click through.
  // Whether anything is dirty, as reactive state — a COUNT rather than the label array, because a
  // fresh array each read would look like a new snapshot on every render and loop.
  const dirtyCount = useSyncExternalStore(subscribeUnsaved, unsavedCount, () => 0);

  // `beforeunload` is armed ONLY while something is dirty (Codex P2 on #272). Merely REGISTERING a
  // handler makes a document ineligible for Firefox's back/forward cache, so a permanently-armed
  // listener would cost every clean user a full reload on Back for a prompt that was never going to
  // fire. Subscribing to the registry and crossing zero is what makes that affordable.
  useEffect(() => {
    if (dirtyCount === 0) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (unsavedLabels().length === 0) return;
      // The modern signal is preventDefault(); returnValue is kept for the browsers that still
      // read it. No browser shows our text here — the wording is the click guard's alone.
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  useEffect(() => {
    function onClickCapture(e: MouseEvent) {
      // Read the registry FIRST: on a page with nothing dirty this costs one Map size check and
      // never touches the DOM, which matters for a listener on every click in the app.
      const labels = unsavedLabels();
      if (labels.length === 0) return;
      const target = e.target instanceof Element ? e.target : null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      const raw = anchor?.getAttribute("href") ?? null;
      if (!shouldGuardNavigation({
        // A bare hash keeps its raw form so the predicate can recognise an in-page jump; anything
        // else is normalised through the anchor's resolved pathname, so an absolute same-origin
        // href compares against location.pathname on equal terms.
        href: raw === null ? null : raw.startsWith("#") ? raw : `${anchor!.pathname}${anchor!.hash}`,
        sameOrigin: anchor !== null && anchor.origin === window.location.origin,
        currentPath: window.location.pathname,
        modifierKey: e.ctrlKey || e.metaKey || e.shiftKey || e.altKey,
        newTab: anchor?.target === "_blank",
        download: anchor?.hasAttribute("download") ?? false,
        defaultPrevented: e.defaultPrevented,
      })) return;
      if (!confirmDiscard()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    // The click guard stays armed unconditionally: it reads the registry first, so on a clean page
    // it costs one Map size check and never touches the DOM, and unlike `beforeunload` a click
    // listener has no bfcache consequence.
    document.addEventListener("click", onClickCapture, true);
    return () => { document.removeEventListener("click", onClickCapture, true); };
  }, []);

  async function signOut() {
    // Before the logout request, not after: once the session is dropped there is no way back to
    // the page holding the edits.
    if (!confirmDiscard()) return;
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
      // Bump the ticket so an in-flight search for the erased term cannot land after this clear
      // and re-open the dropdown under an empty box — the debounce may already have fired, and
      // selectResult/Enter clear the box mid-flight while navigating (Shell never remounts, so
      // the stale response would otherwise re-open over the NEW page). A discarded ticket
      // nothing will ever match: the makeLatestGate discipline.
      latest.next();
      setResults(null);
      setOpen(false);
      setSearchError(null);
      return;
    }
    const timer = setTimeout(() => { void runSearch(term); }, 250);
    debounceRef.current = timer;
    return () => clearTimeout(timer);
  }, [query, runSearch, latest]);

  // Barcode scanners type digits then send Enter near-instantly — often faster than the 250ms
  // debounce window — so Enter cannot simply read whatever `results` happens to already hold. It
  // cancels any pending debounce timer and issues its own immediate, ticket-gated search, and
  // navigates on THAT response's `exactOrderId`. This is the scan path (task-12-brief.md).
  // A deliberate close (Escape, blur) also discards any in-flight search: without the ticket
  // bump, a late current-ticket response would re-open the dropdown the user just closed (same
  // makeLatestGate discipline as the blank-query branch above).
  function closeSearchDropdown() {
    latest.next();
    setOpen(false);
  }

  async function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      closeSearchDropdown();
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
      if (!confirmDiscard()) return;
      setOpen(false);
      setQuery("");
      setResults(null);
      router.push(`/orders/${data.exactOrderId}`);
    }
  }

  function selectResult(href: string) {
    if (!confirmDiscard()) return;
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
      {/* STICK THE INNER WRAPPER, NOT THE <aside>. The aside stays in normal flow and stretches to
          the full page height (a flex item at the default align-items:stretch), which is what keeps
          the dark column running the whole way down a long page — the order board runs to several
          thousand px. Sticking the aside itself would instead end that column at one viewport
          height, a purely cosmetic regression on every screen taller than the viewport, the manual's
          captures included. What has to stay put is the LINKS: before this, scrolling the board far
          enough left the operator with no navigation on screen at all.
          `max-h-screen overflow-y-auto` is the other half, and is not optional — a pinned rail is
          clipped at the viewport, so on a short screen (or once the admin group is visible, which
          roughly doubles the rail) its last entries would be unreachable rather than merely
          off-screen. Scroll the rail, don't grow it. */}
      <aside className="w-52 shrink-0 bg-slate-900 text-slate-100">
        <div className="sticky top-0 max-h-screen overflow-y-auto">
          <div className="p-4 text-lg font-semibold">Shop ERP</div>
          <nav className="space-y-1 px-2 pb-4 text-sm">
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
        </div>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center gap-4 border-b bg-white px-4 py-2">
          <div className="relative flex-1">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { void onSearchKeyDown(e); }}
              onFocus={() => { if (results) setOpen(true); }}
              onBlur={closeSearchDropdown}
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
