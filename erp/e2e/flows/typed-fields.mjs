// Flow 2: fill a NUMBER field and a CHECKBOX field on the E2E-QNCH step template-build-and-load
// left on the fixture part's working revision, save, reload the page, and confirm both values
// render back in their typed inputs — not just persisted server-side.
import { waitForValue, waitForChecked } from "../lib/ui.mjs";

const EM_DASH = "—";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const { stepCodeA } = fixtures;
  const stepLabel = `${stepCodeA.code} ${EM_DASH} ${stepCodeA.name}`;

  await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Process steps" }) });
  const step = section.locator("li", { hasText: stepLabel });
  await step.waitFor({ state: "visible" });
  await shot("before-fill");

  const temperature = step.getByLabel("Temperature");
  const passed = step.getByLabel("Passed");
  // waitForValue/waitForChecked, not bare snapshots — the field's <input> appears as soon as
  // `codes` (loaded independently) and detail.steps are ready, one render tick before the
  // separate drafts-rebuild effect fills in its value (ui.mjs's doc comment).
  await waitForValue(temperature, "");
  await waitForChecked(passed, false);

  await temperature.fill("1550");
  await passed.check();
  await shot("filled-before-save");

  const saveButton = step.getByRole("button", { name: "Save step" });
  await saveButton.click();
  // Save round-trips through refreshAfter (reload revisions + detail), which resets the local
  // draft to server truth and flips isDirty back to false — the button disabling itself is a
  // cleaner "the PATCH landed" signal than a fixed sleep.
  await page.waitForFunction(
    (label) => {
      const li = [...document.querySelectorAll("li")].find((el) => el.textContent?.includes(label));
      const btn = li && [...li.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save step");
      return Boolean(btn?.disabled);
    },
    stepLabel,
    { timeout: 5000 },
  );
  await shot("saved");

  await page.reload();
  const reloadedSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Process steps" }) });
  const reloadedStep = reloadedSection.locator("li", { hasText: stepLabel });
  await reloadedStep.waitFor({ state: "visible" });

  await waitForValue(reloadedStep.getByLabel("Temperature"), "1550");
  await waitForChecked(reloadedStep.getByLabel("Passed"), true);
  await shot("persisted-after-reload");
}
