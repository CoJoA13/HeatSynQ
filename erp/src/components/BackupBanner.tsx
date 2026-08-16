"use client";
// The backup staleness bar (Phase 8C §6.4). A red light on a page nobody opens is the same silent
// failure this feature exists to kill, so staleness surfaces on EVERY screen — but only for holders
// of `manage_backups`: the health route 403s for everyone else and this renders nothing, so the
// shop floor is never nagged about an admin concern. A deliberate SetupBanner clone.
//
// Unlike SetupBanner (whose readiness rollup runs an argon2 verify and so is fetched once per
// session), this endpoint is a cheap stat + one gzip -t, so it refetches on navigation — throttled,
// because a backup's state changes nightly, not per click.
//
// This repo has no DOM test environment (no jsdom/testing-library — see tests/backup-banner.test.tsx
// and the precedent comment in tests/practice-banner.test.tsx), so the fetch-throttle/latch decision
// and the presentational render are split into plain, hook-free exports (`advanceBannerState`,
// `BackupBannerView`) that tests/backup-banner.test.tsx can exercise directly with a stubbed global
// fetch and `renderToStaticMarkup`, without mounting the "use client" component itself.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api, ApiError } from "@/lib/fetcher";
import type { BackupHealth } from "@/lib/backup-constants";

export const REFRESH_MS = 5 * 60 * 1000;

export type BannerFetchState = {
  health: BackupHealth | null;
  lastFetchedAt: number;
  /** Latched true for the rest of the signed-in session once the health route 403s. A 403 is a
   *  STABLE fact about the signed-in user (their grants don't change navigation to navigation),
   *  unlike a transient network failure — re-requesting it on every single page view forever (the
   *  common case: every caller without `manage_backups`) would be pure waste for a result that
   *  cannot change until they log out, which already clears this state via the `/login` branch. */
  forbidden: boolean;
};

export const INITIAL_BANNER_STATE: BannerFetchState = { health: null, lastFetchedAt: 0, forbidden: false };

/** Calls the health endpoint and classifies the outcome. Never throws — the caller (component or
 *  test) always gets a value back. */
async function fetchHealth(): Promise<
  { kind: "success"; health: BackupHealth } | { kind: "forbidden" } | { kind: "error" }
> {
  try {
    const health = await api<BackupHealth>("/api/admin/backups/health");
    return { kind: "success", health };
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return { kind: "forbidden" };
    return { kind: "error" };
  }
}

/** The whole decision + fetch, as one pure(ish) async step: given the current pathname and banner
 *  state, decide whether a fetch is even due, and if so, perform it and fold the outcome back into
 *  a new state. Returns the SAME state object (no-op) when no fetch is due, so a throttled or
 *  latched call never touches the network — this is what tests/backup-banner.test.tsx asserts with
 *  a stubbed `fetch` mock and `.not.toHaveBeenCalled()`. */
export async function advanceBannerState(
  pathname: string | null,
  state: BannerFetchState,
  now: number,
): Promise<BannerFetchState> {
  if (pathname === "/login") {
    // Signed out: clear the banner and re-arm (including the 403 latch) for the next login.
    return INITIAL_BANNER_STATE;
  }
  if (state.forbidden || now - state.lastFetchedAt < REFRESH_MS) {
    return state;
  }
  const outcome = await fetchHealth();
  if (outcome.kind === "success") return { health: outcome.health, lastFetchedAt: now, forbidden: false };
  if (outcome.kind === "forbidden") return { health: null, lastFetchedAt: now, forbidden: true };
  // Transient failure: reset lastFetchedAt so the NEXT navigation retries immediately.
  return { health: null, lastFetchedAt: 0, forbidden: false };
}

/** Pure presentational piece: renders the bar for a health snapshot, or nothing. Hook-free, so
 *  tests/backup-banner.test.tsx can render it with `react-dom/server`'s `renderToStaticMarkup`. */
export function BackupBannerView({ health }: { health: BackupHealth | null }) {
  if (!health || health.state === "ok") return null;
  return (
    <div className="flex items-center justify-center gap-3 bg-red-700 px-4 py-1.5 text-sm text-white">
      <span>⚠ {health.reason}</span>
      <Link href="/admin/backups" className="font-semibold underline">Open Backups</Link>
    </div>
  );
}

export function BackupBanner() {
  const pathname = usePathname();
  const [health, setHealth] = useState<BackupHealth | null>(null);
  const stateRef = useRef<BannerFetchState>(INITIAL_BANNER_STATE);

  useEffect(() => {
    let cancelled = false;
    advanceBannerState(pathname, stateRef.current, Date.now()).then((next) => {
      if (cancelled) return;
      stateRef.current = next;
      setHealth(next.health);
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return <BackupBannerView health={health} />;
}
