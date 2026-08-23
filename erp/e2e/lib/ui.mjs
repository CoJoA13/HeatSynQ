// Small shared helpers so the six flow modules don't each reinvent them.
import assert from "node:assert/strict";

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
 * Same shape as `armDialog` above, for a `window.prompt(...)` (Task 17's void-order flow, the
 * only prompt() in the app — order hub's void reason). `dialog.accept(responseText)` supplies the
 * typed answer; a bare `accept()` (what `armDialog` calls) would submit prompt()'s empty default,
 * which is indistinguishable from a user who typed nothing — voidOrder's own service rejects that
 * with a 400 ("A reason is required to void an order"), so this needs its own helper rather than
 * reusing armDialog with a second optional parameter that every OTHER caller would have to ignore.
 */
export function armPrompt(page, responseText) {
  return new Promise((resolve) => {
    page.on("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.accept(responseText);
      resolve(message);
    });
  });
}

/**
 * Drives one of this app's hand-built Combobox components (src/app/orders/new/Combobox.tsx) —
 * the customer and part pickers on order entry/the hub, none of which are a plain `<select>`
 * (spec §11 calls for free-text autocomplete, which a native select can't do). `labelText` locates
 * the combobox's own `<input>` by its `aria-label` (every instance carries one — "Customer",
 * "Line 1 part", etc.); `filterText` is typed to narrow the dropdown to the option intended;
 * `optionNamePattern` matches the option by its accessible name (a regex anchored on the
 * option's own leading text, e.g. `/^E2E-ORD-LEAD/`, is normally enough — the label also
 * carries a trailing `— name` or `· name` this doesn't need to match). The options are located
 * by role="option", NOT "button": #37's WAI-ARIA pass gave each option button an explicit
 * option role, and an explicit role replaces the implicit button role in the accessibility
 * tree — getByRole("button") stopped matching them the moment that landed (group-H E2E run,
 * 14 flows red on exactly this line).
 *
 * `.click()` before `.fill()` is not strictly required (Playwright's `.fill()` focuses the element
 * itself, and this component opens its dropdown `onFocus`) but mirrors how a real user would
 * interact with it, and costs nothing extra.
 */
export async function pickCombobox(page, labelText, filterText, optionNamePattern) {
  const input = page.getByLabel(labelText, { exact: true });
  await input.click();
  await input.fill(filterText);
  await page.getByRole("option", { name: optionNamePattern }).click();
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

/**
 * "This element must NOT be on screen" — the one absence assertion the flows are allowed to make
 * (#167a fix round). It replaces `assert.rejects(locator.waitFor(...), "…")`, which was in nine
 * places and is a FALSE-GREEN shape: `assert.rejects` passes on *any* rejection, and Playwright
 * rejects a `waitFor` for two entirely different reasons —
 *
 *   * the element never appeared        -> "Timeout 1500ms exceeded"      (what we mean)
 *   * SEVERAL elements matched          -> "strict mode violation: … resolved to 2 elements"
 *
 * — so the moment ambient data makes a locator match twice, the assertion swearing the element is
 * gone starts PASSING while it is on screen twice. `void-order.mjs` shipped exactly that: a voided
 * order still on the board plus one ambient cell holding the same digits, and the flow green.
 *
 * So the rejection is checked rather than merely awaited: a timeout is the pass, a strict-mode
 * violation is a named failure (the locator is too loose, which is a defect in its own right), and
 * anything else — a closed page, a transport error — is re-thrown untouched so the harness's
 * network/assertion classifier still sees it as itself.
 *
 * `assert.fail` deliberately, not `throw new Error`: an `ERR_ASSERTION` hard-overrides the netFailure
 * signal in `failure-classify.mjs`, which is what keeps "the element is still there" from being
 * laundered into a green retry.
 */
export async function assertNeverVisible(locator, message, timeoutMs = 1500) {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/strict mode violation/i.test(text)) {
      assert.fail(
        `${message} — but the locator is too loose to answer that: it resolved to SEVERAL ` +
        `elements, so "not visible" could never have been distinguished from "visible twice". ` +
        `Narrow it (the board's rows: boardRow() in e2e/lib/orders.mjs). Playwright said: ${text}`,
      );
    }
    if (!/Timeout \d+ms exceeded/.test(text)) throw err;
    return; // timed out waiting for it to appear — genuinely absent, which is the assertion
  }
  assert.fail(message);
}
