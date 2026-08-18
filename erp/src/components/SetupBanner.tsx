"use client";
// The first-run surfacing (Phase 8B §5.5 "reachable from the shell until complete", owner decision
// 5) PLUS the §5.7 dismissible admin-password reminder. Mounted by the root layout above Shell, so
// it survives Shell's early returns; it renders NOTHING for a non-admin or signed-out caller (the
// admin-gated readiness fetch 403s → caught → null) and NOTHING once setup is complete/dismissed.
// The nav is not a static entry (that would stay after completion, contradicting "until complete");
// this dynamic strip is the surfacing. The password reminder's dismiss is CLIENT-side (localStorage)
// — §7 keeps SetupState to two fields, and the live "still admin" signal self-clears the reminder
// once the password changes.
//
// This repo has no DOM test environment (no jsdom/testing-library — see tests/backup-banner.test.tsx
// and the precedent comment in tests/practice-banner.test.tsx), so the one-shot/fetch decision, the
// invalidation skip guard, and the presentational render are split into plain, hook-free exports
// (`advanceSetupBannerState`, `shouldSkipSetupInvalidation`, `SetupBannerView`) that
// tests/setup-banner.test.tsx can exercise directly with a stubbed global fetch and
// `renderToStaticMarkup`, without mounting the "use client" component itself.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/fetcher";
import { shouldCommitBannerFetch } from "@/components/BackupBanner";

export type SetupStep = { key: string; complete: boolean };
export type Readiness = { steps: SetupStep[]; dismissed: boolean; complete: boolean };

const PW_DISMISS_KEY = "hsq_pw_reminder_dismissed";

export type SetupBannerFetchState = {
  data: Readiness | null;
  /** The one-shot latch (the old `fetchedRef`): readiness is fetched ONCE per authenticated
   *  session, not per navigation — the rollup argon2-verifies the admin password server-side
   *  (install-readiness.ts), far too costly for the banner's nav-time path (Codex). Re-armed only
   *  by /login, a fetch failure, or an explicit invalidation (#110). */
  fetched: boolean;
};

export const INITIAL_SETUP_BANNER_STATE: SetupBannerFetchState = { data: null, fetched: false };

/** The whole decision + fetch as one pure(ish) async step (the BackupBanner `advanceBannerState`
 *  recipe): given the pathname and the current banner state, decide whether a fetch is due, and if
 *  so perform it and fold the outcome into a new state. Returns the SAME state object (no-op) once
 *  the one-shot has fired, so a navigation never touches the network — which is what
 *  tests/setup-banner.test.tsx asserts with a stubbed `fetch` and `.not.toHaveBeenCalled()`. */
export async function advanceSetupBannerState(
  pathname: string | null,
  state: SetupBannerFetchState,
): Promise<SetupBannerFetchState> {
  if (pathname === "/login") {
    // Signed out: clear the banner and allow a fresh fetch after the NEXT login.
    return INITIAL_SETUP_BANNER_STATE;
  }
  if (state.fetched) return state;
  try {
    const data = await api<Readiness>("/api/setup/readiness");
    return { data, fetched: true };
  } catch {
    // A transient failure — or the non-admin 403 — clears the banner and re-arms so the next
    // navigation retries. Cheap for non-admins: the route 403s at mustCan before
    // installReadiness() ever runs, so the retry never spends an argon2.
    return { data: null, fetched: false };
  }
}

/** The render decision, shared by the view and the invalidation skip guard so the two can never
 *  disagree about what "the banner shows nothing" means. */
function visibility(data: Readiness | null, pwDismissed: boolean) {
  if (!data) return { showSetup: false, showPassword: false };
  const passwordIncomplete = data.steps.some((s) => s.key === "password" && !s.complete);
  return {
    showSetup: !data.complete && !data.dismissed,
    showPassword: passwordIncomplete && !pwDismissed,
  };
}

/** The banner-side refetch guard (#110's cost ruling): skip the invalidation when readiness is
 *  loaded AND the banner currently renders nothing — a banner showing nothing cannot be made MORE
 *  correct by refetching, and every skipped refetch is an argon2 verify the server never runs.
 *  That is what makes the wide call-site set affordable (a customer create three years after
 *  install fires no argon2), and it deliberately preserves the existing
 *  never-re-shows-after-dismissal behavior: a dismissed checklist/reminder stays dismissed. When
 *  data is null (never fetched, or the last fetch failed), invalidate normally — nothing loaded
 *  can prove the refetch pointless. */
export function shouldSkipSetupInvalidation(data: Readiness | null, pwDismissed: boolean): boolean {
  if (!data) return false;
  const { showSetup, showPassword } = visibility(data, pwDismissed);
  return !showSetup && !showPassword;
}

/** Pure presentational half, hook-free so tests/setup-banner.test.tsx can render it with
 *  `react-dom/server`'s `renderToStaticMarkup`. The localStorage read/write stays in the
 *  component; the view only receives the flag and the dismiss callback. */
export function SetupBannerView({
  data,
  pwDismissed,
  onDismissPassword,
}: {
  data: Readiness | null;
  pwDismissed: boolean;
  onDismissPassword?: () => void;
}) {
  const { showSetup, showPassword } = visibility(data, pwDismissed);
  if (!showSetup && !showPassword) return null;

  return (
    <>
      {showSetup && (
        <div className="bg-blue-600 px-4 py-1.5 text-center text-sm text-white">
          Setup isn’t finished.{" "}
          <Link href="/setup" className="font-semibold underline">Finish setup</Link>
        </div>
      )}
      {showPassword && (
        <div className="flex items-center justify-center gap-3 bg-amber-100 px-4 py-1.5 text-sm text-amber-900">
          <span>
            The admin account still uses the default password.{" "}
            <Link href="/admin/users" className="font-semibold underline">Change it</Link>
          </span>
          <button
            type="button"
            onClick={onDismissPassword}
            className="text-amber-700 underline"
          >
            Not now
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Mounted banner ↔ mutating pages, the invalidateBackupBanner mechanism (#124) cloned for #110.
 *
 * A module-level set rather than context: the banner lives in the SHELL and the mutations that
 * move a readiness signal live on PAGES, so there is no common provider to hang context off
 * without wrapping the whole app for one edge. A Set also means a remount cannot leave a stale
 * subscriber behind.
 */
const invalidationListeners = new Set<() => void>();

/** Subscribe a listener; returns the unsubscribe. Exported so tests/setup-banner.test.tsx can pin
 *  the register/invalidate/unsubscribe contract without mounting the component (no DOM test env);
 *  the component's own effect subscribes through this too, so the tested path IS the wired path. */
export function subscribeSetupInvalidations(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

/**
 * Tell the shell's setup banner that the readiness it cached is certainly out of date, and to
 * refetch NOW (#110). The banner otherwise fetches once per session (see the one-shot latch), so
 * without this a completed step — the admin password changed, the first customer created — kept
 * both bars up until a full page reload, teaching an operator the banner lies.
 *
 * Call sites fire it on the SUCCESS path, the instant the mutation resolves and BEFORE any
 * follow-up load (the #124/#131 ordering: the server state has certainly changed by then, and a
 * transiently failing follow-up read must not skip the signal). The one-shot nav path is
 * untouched: refetches fire only here and at first-mount/post-login, never per navigation — no
 * per-nav argon2. Cross-tab staleness is out of scope, same as the BackupBanner precedent: the
 * Set is per-tab.
 */
export function invalidateSetupBanner(): void {
  for (const listen of invalidationListeners) listen();
}

export function SetupBanner() {
  const [data, setData] = useState<Readiness | null>(null);
  const [pwDismissed, setPwDismissed] = useState(true); // assume dismissed until localStorage is read

  const pathname = usePathname();
  const stateRef = useRef<SetupBannerFetchState>(INITIAL_SETUP_BANNER_STATE);
  // Bumped by an invalidation to re-run the fetch effect below; the handler re-arms the one-shot
  // first, so the refetch is not swallowed by the latch.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Bumped SYNCHRONOUSLY by the same invalidation, which is what makes it usable by a promise that
  // resolves before React has processed the nonce (see BackupBanner's `shouldCommitBannerFetch`).
  const generationRef = useRef(0);

  useEffect(() => {
    return subscribeSetupInvalidations(() => {
      // The refetch guard (see shouldSkipSetupInvalidation). localStorage is read directly rather
      // than through the pwDismissed state: this mount-only handler would close over the initial
      // value, and localStorage is the dismissal's source of truth anyway — the "Not now" button
      // writes it before setting state.
      if (shouldSkipSetupInvalidation(stateRef.current.data, localStorage.getItem(PW_DISMISS_KEY) === "1")) {
        return;
      }
      generationRef.current += 1;
      stateRef.current = { ...stateRef.current, fetched: false }; // re-arm the one-shot
      setRefreshNonce((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    setPwDismissed(localStorage.getItem(PW_DISMISS_KEY) === "1");
    // Fetch ONCE per authenticated session, not on every navigation: the readiness rollup runs an
    // argon2 password verify, far too costly to repeat on the banner's nav-time path (Codex).
    // Keying on pathname (rather than []) is what lets it appear after a client-side login — this
    // layout-mounted component is not remounted by /login → / — and refreshNonce is the explicit
    // invalidation channel (#110).
    const startedGeneration = generationRef.current;
    const before = stateRef.current;
    if (pathname !== "/login" && !before.fetched) {
      // Burn the one-shot at DISPATCH time (the old `fetchedRef.current = true` ordering, which a
      // commit-time flag alone would lose): a navigation landing while the readiness fetch is in
      // flight re-runs this effect into the no-op branch instead of dispatching a second
      // argon2-backed fetch. The resolved state below overwrites this marker — including
      // re-arming it on failure, the transient-retry behaviour.
      stateRef.current = { ...before, fetched: true };
    }
    advanceSetupBannerState(pathname, before).then((next) => {
      // An invalidation that landed mid-flight wins (the imported guard, pinned in
      // tests/backup-banner.test.tsx). `cancelled` is deliberately hardwired false, unlike
      // BackupBanner: this component never unmounts, and a pathname re-run must not discard the
      // in-flight one-shot result — the latch has already burned above, so a discard here would
      // leave the banner blank for the rest of the session with nothing re-arming it (BackupBanner
      // can afford the discard because its throttle re-fetches on a later navigation; this banner
      // deliberately never does). Only an explicit invalidation — which re-arms AND refetches —
      // makes a stale result safely discardable, and that is the generation check.
      if (!shouldCommitBannerFetch(startedGeneration, generationRef.current, false)) return;
      stateRef.current = next;
      setData(next.data);
    });
  }, [pathname, refreshNonce]);

  return (
    <SetupBannerView
      data={data}
      pwDismissed={pwDismissed}
      onDismissPassword={() => {
        localStorage.setItem(PW_DISMISS_KEY, "1");
        setPwDismissed(true);
      }}
    />
  );
}
