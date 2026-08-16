// Flow: the Backups page (Phase 8C §6.2). Proves the red-when-empty indicator, the resolved folder,
// and — the headline control — that "Back up now" writes a real archive with a real pg_dump and
// flips the indicator green. The host's pg_dump is major-matched to the postgres:18 server
// (§6.4); vitest deliberately does NOT use it (CI's is older and pg_dump refuses a newer server),
// so this flow is the only place the real binary is exercised.
//
// Mutates only the backup folder, never shared DB fixtures — safe at the FLOWS tail.
import assert from "node:assert/strict";

export async function run(page, shot, ctx) {
  // --- 1. The page renders with the resolved folder and the archive table. ---
  await page.goto(`${ctx.baseURL}/admin/backups`);
  await page.getByRole("heading", { name: "Backups", exact: true }).waitFor({ state: "visible" });
  await page.getByText("Backup folder:", { exact: false }).waitFor({ state: "visible" });

  // --- 2. Back up now writes a real archive and the indicator turns green. ---
  const before = await page.locator("table tbody tr").count();
  await page.getByRole("button", { name: "Back up now" }).click();
  await page.getByText("Backups are up to date", { exact: false })
    .waitFor({ state: "visible", timeout: 60_000 });
  const after = await page.locator("table tbody tr").count();
  assert.ok(after > before || after >= 1, "an archive row appears after Back up now");
  await page.getByText("OK", { exact: true }).first().waitFor({ state: "visible" });
  await shot("backups-after-run");

  // --- 3. The staleness bar is gone once a fresh backup exists. ---
  // BackupBanner throttles its own health re-fetch to once per 5 minutes and latches a 403 for the
  // rest of the session (BackupBanner.tsx's `advanceBannerState`) — but both are per-mount state
  // (a `useRef`/`useState` pair), and `page.goto` below is a full browser navigation, not a
  // client-side route change: it tears down the whole React tree, so the banner remounts with
  // `INITIAL_BANNER_STATE` and fetches fresh regardless of how recently /admin/backups fetched.
  // The one real race is ours, not the banner's: `page.goto` resolves on `load`, before the
  // post-mount effect's fetch to /api/admin/backups/health has necessarily completed, so reading
  // the DOM immediately could read "nothing rendered yet" rather than "confirmed healthy" — a
  // vacuous pass. Arm the response wait before navigating and await it before asserting, so the
  // assertion is on settled state, not a race against the fetch.
  const healthFetch = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/admin/backups/health"
    && res.request().method() === "GET" && res.ok());
  await page.goto(`${ctx.baseURL}/customers`);
  await healthFetch;
  assert.equal(
    await page.getByText("Open Backups", { exact: true }).count(), 0,
    "the shell staleness bar clears once a recent successful backup exists",
  );
}
