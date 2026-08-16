// Flow: the first-run setup checklist + the order-entry gate (Phase 8B §5.5/§5.6). READ-ONLY proof
// that /setup renders the dependency-ordered checklist and that — because the shared fixture seeds
// company identity + a chart of accounts (order-gate prereqs, db-fixtures.ts) — order entry is
// UNBLOCKED (the form shows, not the "Finish setup" notice).
//
// The BLOCK path (unconfigured → the notice + createOrder's HttpError 400) is exhaustively covered
// by vitest (order-gate.test.ts, orders-entry-readiness-route.test.ts, install-readiness.test.ts):
// reproducing it here would require CLEARING the shared company-identity settings mid-suite, which
// every other order-creating flow then depends on being SET — the exact conflict the reviewer
// flagged. So this flow verifies the unblocked steady state, not the block. Mutates nothing shared;
// safe at the FLOWS tail. /setup is reached by URL (its surfacing is the practice-only SetupBanner /
// the order-entry notice, neither present in a configured production-identity dev DB).
import assert from "node:assert/strict";

export async function run(page, shot, ctx) {
  // --- 1. /setup renders the checklist; the two blocking steps read as configured. ---
  await page.goto(`${ctx.baseURL}/setup`);
  await page.getByRole("heading", { name: "Finish setting up", exact: true }).waitFor({ state: "visible" });
  await page.getByText("Company identity", { exact: false }).first().waitFor({ state: "visible" });
  await page.getByText("Chart of accounts", { exact: false }).first().waitFor({ state: "visible" });
  assert.equal(
    await page.getByText("Finish setting up").count(), 1,
    "the setup checklist renders",
  );
  await shot("setup-checklist");

  // --- 2. Order entry is UNBLOCKED: the form (Customer section) shows, not the blocking notice. ---
  await page.goto(`${ctx.baseURL}/orders/new`);
  await page.getByRole("heading", { name: "New order", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "Customer", exact: true }).waitFor({ state: "visible" });
  assert.equal(
    await page.getByText("Finish setup before entering orders").count(), 0,
    "order entry is unblocked when company identity + chart of accounts are configured",
  );
  await shot("order-entry-unblocked");
}
