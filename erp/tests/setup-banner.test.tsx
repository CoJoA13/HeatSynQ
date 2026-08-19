import { describe, it, expect, afterEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  advanceSetupBannerState,
  beginSetupFetch,
  SetupBannerView,
  shouldSkipSetupInvalidation,
  subscribeSetupInvalidations,
  invalidateSetupBanner,
  INITIAL_SETUP_BANNER_STATE,
  type SetupBannerFetchState,
  type Readiness,
} from "@/components/SetupBanner";
import { shouldCommitBannerFetch } from "@/components/BackupBanner";

// This repo has no DOM test environment (no jsdom/testing-library — see the "no DOM test env"
// comment in tests/practice-banner.test.tsx), so SetupBanner follows the BackupBanner recipe:
// its one-shot/fetch decision (`advanceSetupBannerState`), its invalidation skip guard
// (`shouldSkipSetupInvalidation`), and its presentational render (`SetupBannerView`) are plain,
// hook-free exports driven directly here with a stubbed global fetch and `renderToStaticMarkup`,
// without mounting the "use client" component or running a real useEffect.
//
// The mid-flight commit guard is IMPORTED from BackupBanner (`shouldCommitBannerFetch`), whose
// truth table is already pinned in tests/backup-banner.test.tsx — not re-pinned here.

// Both bars possible: setup incomplete and not dismissed, admin password still default.
const INCOMPLETE: Readiness = {
  steps: [
    { key: "password", complete: false },
    { key: "company", complete: false },
  ],
  dismissed: false,
  complete: false,
};

// Every step done: neither bar can show, whatever pwDismissed says.
const ALL_DONE: Readiness = {
  steps: [
    { key: "password", complete: true },
    { key: "company", complete: true },
  ],
  dismissed: false,
  complete: true,
};

// Checklist dismissed but the admin password is still default — only the amber bar can show,
// and only while its own client-side dismissal has not been clicked.
const PASSWORD_ONLY: Readiness = {
  steps: [
    { key: "password", complete: false },
    { key: "company", complete: true },
  ],
  dismissed: true,
  complete: false,
};

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SetupBanner (#110)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The first advance of a session fetches, latches the one-shot, and the strip renders with its
  // exact text (curly apostrophe) and link.
  it("fetches readiness once and renders the setup strip with a link to /setup", async () => {
    const fetchMock = stubFetch(200, INCOMPLETE);
    const next = await advanceSetupBannerState("/customers", INITIAL_SETUP_BANNER_STATE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(next.data).toEqual(INCOMPLETE);
    expect(next.fetched).toBe(true); // the one-shot is latched for the rest of the session

    const markup = renderToStaticMarkup(<SetupBannerView data={next.data} pwDismissed={true} />);
    expect(markup).toContain("Setup isn’t finished");
    expect(markup).toContain('href="/setup"');
  });

  // The one-shot: readiness runs an argon2 verify server-side, so it is fetched ONCE per
  // authenticated session — a navigation must be a no-op (same object back, network untouched).
  it("does not fetch again once the one-shot has fired (same-object no-op)", async () => {
    const fetched: SetupBannerFetchState = { data: INCOMPLETE, fetched: true };
    const fetchMock = stubFetch(200, ALL_DONE);

    const next = await advanceSetupBannerState("/orders", fetched);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(next).toBe(fetched);
  });

  // The state the component's invalidation handler produces — data kept, one-shot re-armed —
  // must actually refetch and pick up the fresh payload (#110's whole point).
  it("an invalidation-produced state (fetched re-armed) refetches and applies the new payload", async () => {
    const invalidated: SetupBannerFetchState = { data: INCOMPLETE, fetched: false };
    const fetchMock = stubFetch(200, ALL_DONE);

    const next = await advanceSetupBannerState("/customers", invalidated);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(next.data).toEqual(ALL_DONE);
    expect(next.fetched).toBe(true);
  });

  it("/login clears the banner and re-arms for the next login, without fetching", async () => {
    const fetchMock = stubFetch(200, INCOMPLETE);

    const next = await advanceSetupBannerState("/login", { data: INCOMPLETE, fetched: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(next).toEqual(INITIAL_SETUP_BANNER_STATE);
    expect(renderToStaticMarkup(<SetupBannerView data={next.data} pwDismissed={false} />)).toBe("");
  });

  // A failure — including the non-admin 403 — clears the banner and re-arms so the next
  // navigation retries (cheap for non-admins: the route 403s at mustCan, before any argon2).
  // The assertion IS that this await resolves rather than rejects.
  it("a failed fetch (the non-admin 403) clears data and re-arms for a retry", async () => {
    stubFetch(403, { error: "You do not have permission for that" });

    const next = await advanceSetupBannerState("/customers", INITIAL_SETUP_BANNER_STATE);

    expect(next).toEqual({ data: null, fetched: false });
    expect(renderToStaticMarkup(<SetupBannerView data={next.data} pwDismissed={false} />)).toBe("");
  });

  // The banner-side refetch guard (#110's cost ruling): a banner showing nothing cannot be made
  // MORE correct by refetching, so those invalidations are skipped — which both bounds the
  // perpetual-churn argon2 cost (customer/part creates fire for the life of the install) and
  // deliberately preserves the never-re-shows-after-dismissal behavior.
  describe("shouldSkipSetupInvalidation (the renders-nothing skip rule)", () => {
    it("never skips while no readiness is loaded — never fetched or failed invalidates normally", () => {
      expect(shouldSkipSetupInvalidation(null, true)).toBe(false);
      expect(shouldSkipSetupInvalidation(null, false)).toBe(false);
    });

    it("skips when everything is complete (banner renders nothing)", () => {
      expect(shouldSkipSetupInvalidation(ALL_DONE, true)).toBe(true);
      expect(shouldSkipSetupInvalidation(ALL_DONE, false)).toBe(true);
    });

    it("skips when the checklist is dismissed and the password bar is dismissed", () => {
      expect(shouldSkipSetupInvalidation(PASSWORD_ONLY, true)).toBe(true);
    });

    it("does not skip while the setup strip is showing", () => {
      expect(shouldSkipSetupInvalidation(INCOMPLETE, true)).toBe(false);
    });

    it("does not skip while the password bar is showing", () => {
      expect(shouldSkipSetupInvalidation(PASSWORD_ONLY, false)).toBe(false);
    });
  });

  it("renders the amber password bar with its link and its client-side dismissal", () => {
    const markup = renderToStaticMarkup(
      <SetupBannerView data={PASSWORD_ONLY} pwDismissed={false} onDismissPassword={() => {}} />,
    );
    expect(markup).toContain('href="/admin/users"');
    expect(markup).toContain("Not now");
    // The checklist is dismissed here, so the blue strip must NOT ride along.
    expect(markup).not.toContain('href="/setup"');
  });

  it("renders nothing when setup is complete/dismissed and the password bar is dismissed", () => {
    expect(renderToStaticMarkup(<SetupBannerView data={ALL_DONE} pwDismissed={true} />)).toBe("");
    expect(renderToStaticMarkup(<SetupBannerView data={PASSWORD_ONLY} pwDismissed={true} />)).toBe("");
    expect(renderToStaticMarkup(<SetupBannerView data={null} pwDismissed={false} />)).toBe("");
  });

  // The fetch effect's synchronous pre-dispatch half, extracted hook-free (Task 4 fix round) so
  // its two load-bearing orderings are pinned rather than living only in effect wiring.
  describe("beginSetupFetch (the effect's synchronous pre-dispatch half)", () => {
    it("burns the one-shot at dispatch time; a plain navigation never moves the generation", () => {
      const generation = { current: 3 };
      const { startedGeneration, latched } =
        beginSetupFetch("/customers", INITIAL_SETUP_BANNER_STATE, generation);

      expect(generation.current).toBe(3); // no per-nav generation churn
      expect(startedGeneration).toBe(3);
      expect(latched).toEqual({ data: null, fetched: true });
      // A navigation landing while that fetch is in flight re-runs into the no-op branch
      // (same object back) instead of dispatching a second argon2-backed fetch.
      expect(beginSetupFetch("/orders", latched, generation).latched).toBe(latched);
    });

    it("/login bumps the generation before the reset dispatch (review finding 1)", () => {
      const generation = { current: 3 };
      const state: SetupBannerFetchState = { data: INCOMPLETE, fetched: true };
      const { startedGeneration, latched } = beginSetupFetch("/login", state, generation);

      expect(generation.current).toBe(4); // supersedes any fetch dispatched before the logout
      expect(startedGeneration).toBe(4);  // while the /login run's own reset commit still lands
      expect(latched).toBe(state);
    });
  });

  /**
   * Review finding 1 (Task 4 fix round): the /login reset must survive a readiness fetch that
   * was dispatched BEFORE the logout and resolves AFTER the reset committed. Without the /login
   * generation bump that resolve passed the commit guard — `cancelled` is deliberately hardwired
   * false in the component, and /login never moved the generation — and committed
   * `{ data, fetched: true }` over the reset: the PRIOR session's readiness strip, shown to the
   * NEXT signed-in user (possibly a different, non-admin one) all session, with a stuck latch
   * that nothing re-arms. The old fetchedRef code could not re-latch here; this pins that the
   * extracted wiring cannot either.
   *
   * The sequence drives the component's exact effect wiring by hand: beginSetupFetch (sync
   * pre-dispatch), advanceSetupBannerState (the fetch), shouldCommitBannerFetch (the commit
   * guard, `cancelled` false as in the component).
   */
  it("the /login reset survives an in-flight fetch resolving after logout", async () => {
    const generation = { current: 0 };
    let committed: SetupBannerFetchState = INITIAL_SETUP_BANNER_STATE;
    const commit = (startedGeneration: number, next: SetupBannerFetchState) => {
      if (shouldCommitBannerFetch(startedGeneration, generation.current, false)) committed = next;
    };

    // A navigation dispatches the session's readiness fetch; the one-shot burns at dispatch.
    let resolveFetch!: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((r) => { resolveFetch = r; })));
    const before1 = committed;
    const run1 = beginSetupFetch("/customers", before1, generation);
    committed = run1.latched;
    expect(committed.fetched).toBe(true);
    const inFlight = advanceSetupBannerState("/customers", before1);

    // The user signs out mid-flight: the /login run resets, and its own commit must land.
    const run2 = beginSetupFetch("/login", committed, generation);
    commit(run2.startedGeneration, await advanceSetupBannerState("/login", run2.latched));
    expect(committed).toEqual(INITIAL_SETUP_BANNER_STATE);

    // The pre-logout fetch finally resolves: its commit must be DROPPED, leaving the reset —
    // data cleared AND the latch re-armed for the next session's own fetch.
    resolveFetch({ ok: true, status: 200, json: async () => INCOMPLETE });
    commit(run1.startedGeneration, await inFlight);
    expect(committed).toEqual(INITIAL_SETUP_BANNER_STATE);
  });

  // The module-level listener Set: registered listeners fire on invalidateSetupBanner(), and the
  // returned unsubscribe removes them (a remount cannot leave a stale subscriber behind).
  it("invalidateSetupBanner calls every registered listener until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSetupInvalidations(listener);

    invalidateSetupBanner();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    invalidateSetupBanner();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
