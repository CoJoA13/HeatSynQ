// Static sweeps over the flow sources (#167a fix round). `failure-classify.mjs` answers "may this
// RED run become a green one?"; this file answers the opposite and nastier question:
//
//     can this GREEN run be green while the thing it asserts is broken?
//
// Both shapes below were found in code that had just been reviewed, and both produce a PASS rather
// than a failure — which is why neither can be left to a census by hand. Nothing here does IO; the
// caller reads the files and owns the refusal (the `findRawApiMutations` precedent, and the same
// two enforcement points: `run.mjs` before flow 1, and a sweep in `tests/e2e-harness.test.ts` so
// CI sees it without running the suite).
//
// Both detectors deliberately OVER-match and fail CLOSED, `issuesMutatingRequest`'s rule: a sweep a
// comment can talk its way past is a sweep a real call can talk its way past too. The escape hatch
// is the sanctioned helper, never a comment.

/** The statement a hit sits in: from the hit to the next `;`, capped so a missing semicolon cannot
 *  swallow the rest of the file. Chained locator statements routinely span three or four lines, so
 *  a line-at-a-time scan would miss the half that matters. */
function statementAt(source, index) {
  const end = source.indexOf(";", index);
  const stop = end === -1 ? source.length : end + 1;
  return source.slice(index, Math.min(stop, index + 600));
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function snippetOf(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  let lineEnd = source.indexOf("\n", index);
  if (lineEnd === -1) lineEnd = source.length;
  return source.slice(lineStart, lineEnd).trim();
}

// A row locator taken straight off `page` — no section, no table, no scope of any kind.
const PAGE_ROW_LOCATOR = /\bpage\s*\.\s*(?:locator\(\s*["'](?:table\s+)?(?:tbody\s+)?tr\b|getByRole\(\s*["']row["'])/g;
// ...filtered by an ORDER NUMBER. That combination is the board-row family and nothing else: the
// board is the one screen whose rows are keyed by order number and whose OTHER columns (PO, Qty,
// Weight, Loads, VS #) print bare numbers of their own.
const ORDER_NUMBER_TOKEN = /\borderNumber\b|\border\s*\.\s*number\b|\bcreated\s*\.\s*orderNumber\b/;

/**
 * Row locators built on `page` and filtered by an order number — the shape that went red for real
 * on 2026-08-22 (`ship-partial-then-complete`'s order weighs exactly 1200 lb, so its Weight cell
 * collided with order #1200's number cell) and that then survived a whole review round in
 * `void-order.mjs`, where it sat inside an `assert.rejects` and so would have PASSED while the
 * voided row was still on screen. `boardRow` (`e2e/lib/orders.mjs`) is the sanctioned shape: it
 * matches the order-number CELL, resolved from the table header.
 *
 * What it deliberately does NOT flag, so the refusal stays actionable:
 *   * a row locator scoped to a section or a table (`sectionByHeading(...).locator("tr")`,
 *     `receivables.locator("tbody tr")`) — the /invoicing and /receivables family, whose collision
 *     surface is far narrower and which #167a recorded as found-not-fixed rather than fixing;
 *   * a bare `page.locator("tr")` filtered by something that is not an order number (a surcharge
 *     kind, a payment-type name) — no other column prints those.
 */
export function findAmbientRowLocators(source) {
  const found = [];
  for (const m of source.matchAll(PAGE_ROW_LOCATOR)) {
    const statement = statementAt(source, m.index);
    if (!ORDER_NUMBER_TOKEN.test(statement)) continue;
    found.push({ line: lineOf(source, m.index), snippet: snippetOf(source, m.index) });
  }
  return found;
}

const ASSERT_REJECTS = /\bassert\s*\.\s*rejects\s*\(/g;

/**
 * `assert.rejects(someLocator.waitFor(...), "it should not be there")` — an absence assertion that
 * passes on ANY rejection, including Playwright's strict-mode violation. Two matching elements make
 * the locator throw, the promise rejects, and the assertion reports SUCCESS — while the element it
 * swears is absent is on screen twice. A green run proving nothing, which is worse than a red one.
 *
 * `assertNeverVisible` (`e2e/lib/ui.mjs`) is the sanctioned shape: it requires the rejection to be
 * the TIMEOUT, and turns a strict-mode violation into a named failure.
 *
 * `assert.rejects` around anything else (an API call that must 403, a service that must throw) is
 * untouched — it is only the `waitFor` pairing that can launder a strict-mode violation into a
 * pass, because "no such element" and "several such elements" both reject there.
 */
export function findUncheckedAbsenceAssertions(source) {
  const found = [];
  for (const m of source.matchAll(ASSERT_REJECTS)) {
    const statement = statementAt(source, m.index);
    if (!/\.\s*waitFor\s*\(/.test(statement)) continue;
    found.push({ line: lineOf(source, m.index), snippet: snippetOf(source, m.index) });
  }
  return found;
}
