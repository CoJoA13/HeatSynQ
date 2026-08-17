import { describe, it, expect, afterEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  advanceBannerState,
  BackupBannerView,
  INITIAL_BANNER_STATE,
  REFRESH_MS,
  type BannerFetchState,
} from "@/components/BackupBanner";
import type { BackupHealth } from "@/lib/backup-constants";

// This repo has no DOM test environment (no jsdom/testing-library — see the "no DOM test env"
// comment in tests/practice-banner.test.tsx), so BackupBanner splits its throttle/403-latch
// decision and its fetch (`advanceBannerState`) from its presentational render (`BackupBannerView`)
// specifically so both halves can be driven directly here, without mounting the "use client"
// component or running a real useEffect. Together the two cover the same four ways the bar could
// silently fail to warn that a jsdom-mounted test would: a real payload renders, "ok" renders
// nothing, a 403 renders nothing without throwing, and /login neither renders nor fetches.

const NOW = Date.parse("2026-08-16T12:00:00Z");

const RED_HEALTH: BackupHealth = {
  state: "stale",
  lastSuccessAt: "2026-08-14T02:00:00Z",
  lastRunAt: "2026-08-16T02:00:00Z",
  lastRunOk: true,
  staleHours: 36,
  reason: "No integrity-passing backup in the last 36 hours.",
};

const OK_HEALTH: BackupHealth = {
  state: "ok",
  lastSuccessAt: "2026-08-16T02:00:00Z",
  lastRunAt: "2026-08-16T02:00:00Z",
  lastRunOk: true,
  staleHours: 36,
  reason: "",
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

describe("BackupBanner (Phase 8C §6.4)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Case 1: a red health payload renders the bar, its reason, and a link to /admin/backups.
  it("fetches a non-ok payload and renders its reason with a link to /admin/backups", async () => {
    stubFetch(200, RED_HEALTH);
    const next = await advanceBannerState("/customers", INITIAL_BANNER_STATE, NOW);
    expect(next.health).toEqual(RED_HEALTH);

    const markup = renderToStaticMarkup(<BackupBannerView health={next.health} />);
    expect(markup).toContain("No integrity-passing backup in the last 36 hours.");
    expect(markup).toContain('href="/admin/backups"');
  });

  // Case 2: state: "ok" renders nothing (both the raw view and the fetched-then-rendered path).
  it("renders nothing for state: ok", async () => {
    expect(renderToStaticMarkup(<BackupBannerView health={OK_HEALTH} />)).toBe("");

    stubFetch(200, OK_HEALTH);
    const next = await advanceBannerState("/customers", INITIAL_BANNER_STATE, NOW);
    expect(renderToStaticMarkup(<BackupBannerView health={next.health} />)).toBe("");
  });

  it("renders nothing before any health has loaded", () => {
    expect(renderToStaticMarkup(<BackupBannerView health={null} />)).toBe("");
  });

  // Case 3: a 403 (a caller without manage_backups) renders nothing and does not throw.
  it("a 403 clears health, renders nothing, latches forbidden, and does not throw", async () => {
    stubFetch(403, { error: "You do not have permission for that" });

    // If fetchHealth's catch let the ApiError escape, this await would reject and fail the test —
    // the assertion IS that this line resolves.
    const next = await advanceBannerState("/customers", INITIAL_BANNER_STATE, NOW);

    expect(next.health).toBeNull();
    expect(next.forbidden).toBe(true);
    expect(renderToStaticMarkup(<BackupBannerView health={next.health} />)).toBe("");
  });

  // The judgment call: a 403 is a stable fact about the signed-in user (their grants don't change
  // navigation to navigation), unlike a transient network blip — so it latches off for the rest of
  // the session rather than re-requesting on every single page view forever (the common case: every
  // caller without manage_backups, on every page).
  it("does not re-fetch on a later navigation once latched forbidden", async () => {
    const forbiddenState: BannerFetchState = {
      health: null,
      lastFetchedAt: NOW,
      forbidden: true,
      error: false,
    };
    const fetchMock = stubFetch(200, OK_HEALTH);

    const next = await advanceBannerState("/orders", forbiddenState, NOW + REFRESH_MS * 100);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(next).toBe(forbiddenState);
  });

  it("re-arms the forbidden latch on /login, so the next signed-in session retries", async () => {
    const forbiddenState: BannerFetchState = {
      health: null,
      lastFetchedAt: NOW,
      forbidden: true,
      error: false,
    };
    const next = await advanceBannerState("/login", forbiddenState, NOW);
    expect(next).toEqual(INITIAL_BANNER_STATE);
  });

  // Case 4: on /login it renders nothing AND does not fetch.
  it("does not fetch on /login, even when a fetch is otherwise due", async () => {
    const fetchMock = stubFetch(200, RED_HEALTH);

    const next = await advanceBannerState("/login", INITIAL_BANNER_STATE, NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<BackupBannerView health={next.health} />)).toBe("");
  });

  it("throttles: skips the fetch when the last one is within REFRESH_MS", async () => {
    const recentState: BannerFetchState = {
      health: RED_HEALTH,
      lastFetchedAt: NOW,
      forbidden: false,
      error: false,
    };
    const fetchMock = stubFetch(200, OK_HEALTH);

    const next = await advanceBannerState("/customers", recentState, NOW + REFRESH_MS - 1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(next).toBe(recentState);
  });

  it("refetches once REFRESH_MS has elapsed since the last fetch", async () => {
    const staleState: BannerFetchState = {
      health: RED_HEALTH,
      lastFetchedAt: NOW,
      forbidden: false,
      error: false,
    };
    const fetchMock = stubFetch(200, OK_HEALTH);

    const next = await advanceBannerState("/customers", staleState, NOW + REFRESH_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(next.health).toEqual(OK_HEALTH);
  });

  // C2 (whole-branch review, Important): §6.2's "absence is failure" applies to the health
  // ENDPOINT, not just the on-disk status file. A non-403 failure (a 500, a thrown
  // resolveBackupDir() before the route's own try/catch, a DB-down 500, a network blip) must
  // still surface as a visible red bar on THIS render, while still resetting lastFetchedAt so the
  // next navigation retries immediately — the pre-existing transient-retry behaviour.
  it("a transient (non-403) failure resets lastFetchedAt for retry AND renders a red 'could not be read' bar this render", async () => {
    stubFetch(500, { error: "boom" });
    const next = await advanceBannerState("/customers", INITIAL_BANNER_STATE, NOW);
    expect(next).toEqual({ health: null, lastFetchedAt: 0, forbidden: false, error: true });

    const markup = renderToStaticMarkup(<BackupBannerView health={next.health} error={next.error} />);
    expect(markup).toContain("System status could not be read");
  });

  /**
   * Issue #121, owner ruling 2026-08-16 — reword the unknown-cause bar; do not silence it.
   *
   * `handle()` resolves the session OUTSIDE its try/catch, so in a database outage the health route
   * fails BEFORE reaching its own `mustDo("manage_backups")`: the 403 that normally silences a
   * non-admin never happens, and every signed-in user saw a bar naming BACKUPS and linking to an
   * admin page they may not be able to open. The misattribution is the cost — someone chases a
   * backup problem while the database is the actual fault.
   *
   * (The issue's own suggested direction — distinguish "cannot determine your permissions" from
   * "status unavailable" — is not buildable: determining the permission needs the same database.)
   */
  it("the unknown-cause bar names neither backups nor a link the reader may not be able to use (#121)", async () => {
    stubFetch(500, { error: "boom" });
    const next = await advanceBannerState("/customers", INITIAL_BANNER_STATE, NOW);
    const markup = renderToStaticMarkup(<BackupBannerView health={next.health} error={next.error} />);

    expect(markup).toContain("System status could not be read");
    expect(markup).toMatch(/database or the server may be unavailable/i);
    expect(markup).not.toContain("href=");        // no admin link for a fault that may not be admin's
    expect(markup.toLowerCase()).not.toContain("backup");
  });

  /**
   * Codex, PR #131 — the two bars must be DISTINGUISHABLE, not just differently worded.
   *
   * They are visually identical and the generic one deliberately carries no link, so "is the Open
   * Backups link absent?" does not answer "is the staleness bar gone?" — an assertion written that
   * way is satisfied by the generic error bar still being on screen. The E2E flow now locates each
   * by its accessible name, so those names are a contract and are pinned here.
   */
  it("gives the two bars distinct accessible names", () => {
    const stale = { ...OK_HEALTH, state: "stale" as const, reason: "The newest backup is 40 hours old." };
    const staleMarkup = renderToStaticMarkup(<BackupBannerView health={stale} />);
    const errorMarkup = renderToStaticMarkup(<BackupBannerView health={null} error />);

    expect(staleMarkup).toContain('aria-label="Backup status"');
    expect(errorMarkup).toContain('aria-label="System status"');
    // Neither may answer to the other's name, or the E2E locators would cross over.
    expect(staleMarkup).not.toContain('aria-label="System status"');
    expect(errorMarkup).not.toContain('aria-label="Backup status"');
  });

  /** ...while a GENUINE staleness verdict keeps its specific message AND its link — the reword must
   *  not have flattened the case where we do know it is backups and who can fix it. */
  it("a real staleness verdict still names backups and links to the page", async () => {
    const stale = { ...OK_HEALTH, state: "stale" as const, reason: "The newest backup is 40 hours old." };
    const markup = renderToStaticMarkup(<BackupBannerView health={stale} />);
    expect(markup).toContain("The newest backup is 40 hours old.");
    expect(markup).toContain('href="/admin/backups"');
  });

  // The other half of C2: a 403 (no manage_backups) must still render nothing, not the error bar —
  // that is a legitimate "not your concern", the one case §6.2's rule does not apply to.
  it("a 403 does NOT render the error bar", async () => {
    stubFetch(403, { error: "You do not have permission for that" });
    const next = await advanceBannerState("/customers", INITIAL_BANNER_STATE, NOW);
    expect(next.error).toBe(false);
    expect(
      renderToStaticMarkup(<BackupBannerView health={next.health} error={next.error} />),
    ).toBe("");
  });
});
