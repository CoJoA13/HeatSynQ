// Flow 1: build a two-step template with boilerplate on the Processes screen, then load it onto
// the fixture part from the part detail page's Process steps designer — asserting the
// confirm-before-replace dialog spec §8/§3.1 requires (Load Template = replace-with-confirm).
import assert from "node:assert/strict";
import { armDialog, waitForValue, waitForChecked, fillReliable, waitForSaveSettled } from "../lib/ui.mjs";

const EM_DASH = "—";
const TEMPLATE_NAME = "E2E Austemper";

function codeOptionLabel(stepCode) {
  return `${stepCode.code} ${EM_DASH} ${stepCode.name}`;
}

export async function run(page, shot, ctx) {
  const { fixtures, created } = ctx;
  const { stepCodeA, stepCodeB } = fixtures;

  // --- Build the template on the Processes list + detail pages ---
  await page.goto(`${ctx.baseURL}/processes`);
  await page.getByPlaceholder("Template name").fill(TEMPLATE_NAME);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText(TEMPLATE_NAME, { exact: true }).waitFor({ state: "visible" });
  await shot("template-created-in-list");

  await page.getByText(TEMPLATE_NAME, { exact: true }).click();
  await page.waitForURL(/\/processes\/templates\/.+/);
  const templateId = page.url().split("/").pop();
  created.templateIds.push(templateId);

  const addStepSelect = page.locator("select")
    .filter({ has: page.locator("option", { hasText: "Add step: code…" }) });

  // Step 1: E2E-QNCH with boilerplate
  await addStepSelect.selectOption({ label: codeOptionLabel(stepCodeA) });
  await page.getByRole("button", { name: "Add step" }).click();
  const templateStep1 = page.locator("li", { hasText: codeOptionLabel(stepCodeA) });
  await templateStep1.waitFor({ state: "visible" });
  // fillReliable, not a bare fill() — the boilerplate textarea just appeared from addStep's own
  // reload; that reload's boilerplateDrafts-sync effect can still be scheduled (not yet run) the
  // instant fill() dispatches its input event, and land a moment later, clobbering the typed text
  // back to "" (ui.mjs's doc comment — the write-side twin of the waitForValue race below).
  await fillReliable(templateStep1.getByPlaceholder("Boilerplate"), "Heat to target temperature and hold.");
  await templateStep1.getByRole("button", { name: "Save step" }).click();
  await waitForSaveSettled(page, codeOptionLabel(stepCodeA));

  // Step 2: E2E-WASH with boilerplate
  await addStepSelect.selectOption({ label: codeOptionLabel(stepCodeB) });
  await page.getByRole("button", { name: "Add step" }).click();
  const templateStep2 = page.locator("li", { hasText: codeOptionLabel(stepCodeB) });
  await templateStep2.waitFor({ state: "visible" });
  await fillReliable(templateStep2.getByPlaceholder("Boilerplate"), "Rinse and inspect the load.");
  await templateStep2.getByRole("button", { name: "Save step" }).click();
  await waitForSaveSettled(page, codeOptionLabel(stepCodeB));
  await shot("template-two-steps-with-boilerplate");

  // --- Load the template onto the fixture part, asserting the confirm-replace dialog ---
  await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
  await page.getByRole("heading", { name: "Process steps" }).waitFor({ state: "visible" });
  await shot("part-before-load-template");

  const loadTemplateSelect = page.locator("select")
    .filter({ has: page.locator("option", { hasText: "Load template…" }) });
  await loadTemplateSelect.selectOption({ label: TEMPLATE_NAME });

  const dialogMessage = armDialog(page);
  await page.getByRole("button", { name: "Load template" }).click();
  const message = await dialogMessage;
  assert.equal(message, "Replace the current steps with this template's blank skeleton?");

  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Process steps" }) });
  const loadedStep1 = section.locator("li", { hasText: codeOptionLabel(stepCodeA) });
  const loadedStep2 = section.locator("li", { hasText: codeOptionLabel(stepCodeB) });
  await loadedStep1.waitFor({ state: "visible" });
  await loadedStep2.waitFor({ state: "visible" });

  // Boilerplate seeds the step's instruction; the code's own typed fields start empty (spec §8:
  // a template carries no per-code field values, only boilerplate text). waitForValue, not a
  // bare inputValue() snapshot: the <li> matches hasText as soon as detail.steps updates, one
  // render tick before the separate drafts-rebuild effect (gated on codesReady too) fills in the
  // textarea's value — see ui.mjs's doc comment.
  await waitForValue(loadedStep1.getByPlaceholder("Instruction"), "Heat to target temperature and hold.");
  await waitForValue(loadedStep1.getByLabel("Temperature"), "");
  await waitForChecked(loadedStep1.getByLabel("Passed"), false);
  await waitForValue(loadedStep2.getByPlaceholder("Instruction"), "Rinse and inspect the load.");

  await shot("template-loaded-onto-part");
}
