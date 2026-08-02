// Flow 5: the fixture restricted user (parts.view + processes.view only, no processes.edit) — a
// second, deliberately underprivileged login, per spec §12 — opens the fixture part. The
// designer must render fully (view is granted) but every mutating control must be disabled, each
// with a tooltip naming the permission that would unlock it (processes.edit), never just silently
// missing.
import assert from "node:assert/strict";

const EM_DASH = "—";
const REQUIRES_EDIT = "Requires processes.edit";

async function assertDisabledWithTooltip(locator, label) {
  assert.equal(await locator.isDisabled(), true, `${label} should be disabled for a processes.edit-less user`);
  assert.equal(await locator.getAttribute("title"), REQUIRES_EDIT, `${label} tooltip should name processes.edit`);
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const { stepCodeA } = fixtures;
  const stepLabel = `${stepCodeA.code} ${EM_DASH} ${stepCodeA.name}`;

  await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Process steps" }) });
  await section.waitFor({ state: "visible" });
  // A restricted-but-still-view-holding user sees the real designer, not a "Requires
  // processes.view" placeholder — this is the disabled-with-a-reason path, not the denied one.
  await assert.rejects(
    section.getByText("Requires processes.view.").waitFor({ state: "visible", timeout: 1000 }),
    "view-denied placeholder should not render for a user who holds processes.view",
  );
  await shot("part-designer-visible-to-restricted-user");

  const step = section.locator("li", { hasText: stepLabel });
  await step.waitFor({ state: "visible" });

  await assertDisabledWithTooltip(step.getByPlaceholder("Instruction"), "step instruction textarea");
  await assertDisabledWithTooltip(step.getByLabel("Temperature"), "Temperature field");
  await assertDisabledWithTooltip(step.getByLabel("Passed"), "Passed checkbox");
  await assertDisabledWithTooltip(step.getByRole("button", { name: "Save step" }), "Save step button");
  await assertDisabledWithTooltip(step.getByRole("button", { name: "Remove" }), "Remove button");
  await assertDisabledWithTooltip(step.getByRole("button", { name: "Move up" }), "Move up button");

  const addStepSelect = section.locator("select").filter({ has: page.locator("option", { hasText: "Add step: code…" }) });
  await assertDisabledWithTooltip(addStepSelect, "Add step code picker");
  await assertDisabledWithTooltip(section.getByRole("button", { name: "Add step" }), "Add step button");

  const loadTemplateSelect = section.locator("select").filter({ has: page.locator("option", { hasText: "Load template…" }) });
  await assertDisabledWithTooltip(loadTemplateSelect, "Load template picker");
  await assertDisabledWithTooltip(section.getByRole("button", { name: "Load template" }), "Load template button");

  await shot("mutating-controls-disabled-with-tooltips");
}
