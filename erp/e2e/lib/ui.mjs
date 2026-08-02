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

/**
 * Fills a field, then confirms the typed value actually held — re-filling once and polling if it
 * didn't.
 *
 * Why this exists: a field that just appeared because of an "Add" action (a new step's boilerplate
 * or instruction textarea, right after the add POST's own reload) can have a state-sync effect
 * from that SAME reload still scheduled — not yet run — at the instant `fill()` dispatches its
 * input event. A real user always loses that race by default (clicking, finding the new field,
 * and starting to type takes far longer than the microtask gap between a React commit and its
 * effect), but a script's `fill()` can land inside that gap, and when it does the effect runs
 * a moment later and silently overwrites the just-typed value back to server truth — same class
 * of test-timing artifact as `waitForValue` above, not an app bug, just on the write side instead
 * of the read side. One re-fill after the first mismatch is enough: nothing schedules a second
 * clobber unless another mutating action runs meanwhile, which these flows never do here.
 */
export async function fillReliable(locator, value, timeoutMs = 5000) {
  await locator.fill(value);
  const deadline = Date.now() + timeoutMs;
  let refilled = false;
  for (;;) {
    const current = await locator.inputValue().catch(() => undefined);
    if (current === value) return;
    if (!refilled) {
      await locator.fill(value);
      refilled = true;
    }
    if (Date.now() > deadline) {
      throw new Error(`fillReliable: value would not hold at ${JSON.stringify(value)} — last saw ${JSON.stringify(current)}`);
    }
    await new Promise((r) => { setTimeout(r, 150); });
  }
}

/** Same race, for a checkbox — see `fillReliable`'s doc comment. */
export async function checkReliable(locator, checked, timeoutMs = 5000) {
  await (checked ? locator.check() : locator.uncheck());
  const deadline = Date.now() + timeoutMs;
  let redone = false;
  for (;;) {
    const current = await locator.isChecked().catch(() => undefined);
    if (current === checked) return;
    if (!redone) {
      await (checked ? locator.check() : locator.uncheck());
      redone = true;
    }
    if (Date.now() > deadline) {
      throw new Error(`checkReliable: checked state would not hold at ${checked} — last saw ${JSON.stringify(current)}`);
    }
    await new Promise((r) => { setTimeout(r, 150); });
  }
}

/**
 * Waits for the "Save step" button inside the `<li>` whose text contains `liText` to become
 * disabled again — the signal that a save's round trip (PATCH, then the reload it triggers) has
 * actually finished and the local draft matches server truth once more (`isDirty` flipped back to
 * false). A bare `getByText(savedValue).waitFor()` right after clicking Save is unreliable here:
 * `getByText` matches element text content, and a `<textarea>`'s current `value` is a DOM
 * property, not reflected in `textContent` — so that wait can resolve for the wrong reason (or
 * hang) instead of actually confirming the save landed.
 */
export async function waitForSaveSettled(page, liText, timeoutMs = 10000) {
  await page.waitForFunction(
    (label) => {
      const li = [...document.querySelectorAll("li")].find((el) => el.textContent?.includes(label));
      const btn = li && [...li.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save step");
      return Boolean(btn?.disabled);
    },
    liText,
    { timeout: timeoutMs },
  );
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
