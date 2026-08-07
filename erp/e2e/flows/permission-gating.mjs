// Flow 5: the fixture restricted user (parts.view + processes.view only, no processes.edit) — a
// second, deliberately underprivileged login, per spec §12 — opens the fixture part. The
// designer must render fully (view is granted) but every mutating control must be disabled, each
// with a tooltip naming the permission that would unlock it (processes.edit), never just silently
// missing.
//
// Fix-wave 1 (Task 5 review, finding 8) adds a second section: the Pricing section's double gate
// (parts.edit AND action.change_prices, PricingSection.tsx) — the one place on this page two
// permissions AND together rather than a single gate deciding everything, and, before this,
// something no automated check anywhere in the suite ever touched. Case 1 (still the restricted
// user, holding neither) shows the parts.edit title wins the tie-break — the same shape every
// other gate in this flow already proves. Case 2 re-logs-in (the credit-hold-block-and-override.
// mjs precedent) as a purpose-built fixture user who HAS parts.edit but not change_prices, and
// shows the SECOND gate bite once the first is satisfied — the part of this screen a single-gate
// section can never demonstrate.
import assert from "node:assert/strict";
import { login } from "../lib/auth.mjs";

const EM_DASH = "—";
const REQUIRES_EDIT = "Requires processes.edit";
const REQUIRES_PARTS_EDIT = "Requires parts.edit";
const REQUIRES_CHANGE_PRICES = "Requires change_prices";

async function assertDisabledWithTooltip(locator, label, expectedTitle = REQUIRES_EDIT) {
  assert.equal(await locator.isDisabled(), true, `${label} should be disabled`);
  assert.equal(await locator.getAttribute("title"), expectedTitle, `${label} tooltip should read "${expectedTitle}"`);
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

  // --- Pricing section, Case 1: still the restricted user (neither parts.edit nor
  // change_prices). "Price per" and "Remove operation" are picked deliberately: both are
  // `disabled={disabled}` alone in PricingSection.tsx, with no other condition (unlike the
  // money inputs, which are `readOnly` not `disabled`, or the step-code select, which also
  // depends on the options fetch having settled) — so a `true` here can only be the permission
  // gate, never a confound. ---
  const pricingSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Pricing" }) });
  await pricingSection.waitFor({ state: "visible" });
  await assertDisabledWithTooltip(pricingSection.getByLabel("Price per"), "Price per select", REQUIRES_PARTS_EDIT);
  await assertDisabledWithTooltip(
    pricingSection.getByRole("button", { name: "Remove operation" }), "Remove operation button", REQUIRES_PARTS_EDIT);
  await shot("pricing-disabled-for-restricted-user");

  // --- Pricing section, Case 2: re-logged-in as the fixture price editor (parts.view +
  // parts.edit, deliberately NOT action.change_prices). The FIRST gate is now satisfied, so the
  // title has to come from the second one — the double-AND this screen is built around. ---
  await login(page, ctx.baseURL, fixtures.priceEditUsername, fixtures.priceEditPassword);
  await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
  const pricingSectionAsEditor = page.locator("section").filter({ has: page.getByRole("heading", { name: "Pricing" }) });
  await pricingSectionAsEditor.waitFor({ state: "visible" });
  await assertDisabledWithTooltip(
    pricingSectionAsEditor.getByLabel("Price per"), "Price per select", REQUIRES_CHANGE_PRICES);
  await assertDisabledWithTooltip(
    pricingSectionAsEditor.getByRole("button", { name: "Remove operation" }), "Remove operation button",
    REQUIRES_CHANGE_PRICES);
  await shot("pricing-requires-change-prices-with-parts-edit-held");
}
