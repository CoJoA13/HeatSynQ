// Small shared helpers so the six flow modules don't each reinvent them.

/**
 * Arms a one-shot `page.on("dialog", ...)` listener BEFORE the action that triggers a
 * window.confirm()/prompt(), and returns a promise that resolves with the dialog's message once
 * Playwright has accepted it. Call this first, THEN perform the click — registering the
 * listener after the click risks the dialog firing (and Playwright's built-in auto-dismiss
 * kicking in) before the handler exists.
 */
export function armDialog(page) {
  return new Promise((resolve) => {
    page.on("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      resolve(message);
    });
  });
}

/**
 * Polls `locator.inputValue()` until it equals `expected` or `timeoutMs` elapses.
 *
 * Why this exists: a step's `<li>` becomes visible (and matches a `hasText` locator) as soon as
 * `detail.steps` updates, but ProcessStepsSection.tsx's typed-in `value` comes from a SEPARATE
 * `drafts` map rebuilt by its own effect (gated on `detail` AND `codesReady`) — a distinct React
 * commit that can land a render tick after the `<li>` itself first appears. `locator.inputValue()`
 * is a snapshot, not an auto-retrying assertion (unlike `@playwright/test`'s `expect(...)`, which
 * this harness doesn't use — HANDOFF §5a's bundled-Chromium path drives the raw `playwright`
 * library directly) — reading it right after `waitFor({state:"visible"})` on the container can
 * catch that brief empty-then-populated gap. This is a test-timing artifact, not an app bug: a
 * real user never perceives a same-tick React effect ordering gap.
 */
export async function waitForValue(locator, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await locator.inputValue().catch(() => undefined);
    if (last === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for value ${JSON.stringify(expected)} — last saw ${JSON.stringify(last)}`);
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

/** Same race, for a checkbox's `checked` state — see `waitForValue`'s doc comment. */
export async function waitForChecked(locator, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await locator.isChecked().catch(() => undefined);
    if (last === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for checked=${expected} — last saw ${JSON.stringify(last)}`);
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

/** Fails loudly with context instead of letting a mismatch surface as a bare assertion trace. */
export function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function expectTrue(condition, label) {
  if (!condition) throw new Error(`${label}: expected condition to be true`);
}
