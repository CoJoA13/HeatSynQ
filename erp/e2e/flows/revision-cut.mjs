// Flow 3: THE revision-cut rule (spec §5) made visible. Locks the fixture part's revision 1 —
// standing in for Phase 3's order save, via ctx.lockRevision (db-fixtures.ts's lock-revision
// command, which calls the real, audited part-process-steps.ts lockRevision service function) —
// then edits a step on that now-locked current revision. Editing a locked current revision
// silently cuts a new one (§5.4): the UI must show "Rev 2 · working", and switching back to
// Rev 1 must show it read-only and untouched by the edit.
import assert from "node:assert/strict";
import { waitForValue, waitForChecked } from "../lib/ui.mjs";

const EM_DASH = "—";
const MIDDOT = "·";
const ORIGINAL_INSTRUCTION = "Heat to target temperature and hold.";
const EDITED_INSTRUCTION = "Heat to target temperature and hold. Then air cool (rev2 edit).";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const { stepCodeA } = fixtures;
  const stepLabel = `${stepCodeA.code} ${EM_DASH} ${stepCodeA.name}`;

  const lockResult = ctx.lockRevision(fixtures.partId, 1);
  assert.equal(lockResult.ok, true, "lockRevision fixture call did not report ok");

  await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Process steps" }) });
  await section.getByText(`Rev 1 ${MIDDOT} locked`).waitFor({ state: "visible" });
  await section.getByText("Locked revision — editing will create a new revision").waitFor({ state: "visible" });
  await shot("rev1-locked-current");

  const step = section.locator("li", { hasText: stepLabel });
  await step.getByPlaceholder("Instruction").fill(EDITED_INSTRUCTION);
  await step.getByRole("button", { name: "Save step" }).click();

  // The PATCH's response carries revisionNumber: 2 (a cut just happened), which
  // ProcessStepsSection.tsx's refreshAfter treats as "switch the picker to it".
  await section.getByText(`Rev 2 ${MIDDOT} working`).waitFor({ state: "visible", timeout: 10000 });
  const cutStep = section.locator("li", { hasText: stepLabel });
  // waitForValue, not a bare inputValue() snapshot — see ui.mjs's doc comment: the <li> matches
  // hasText a render tick before the drafts-rebuild effect fills the textarea in.
  await waitForValue(cutStep.getByPlaceholder("Instruction"), EDITED_INSTRUCTION);
  await shot("rev2-working-after-cut");

  // Switch the picker back to the now-superseded Rev 1.
  const revisionSelect = section.locator("select").first();
  await revisionSelect.selectOption({ label: "Rev 1" });
  await section.getByText(`Rev 1 ${MIDDOT} locked`).waitFor({ state: "visible" });

  const historicalStep = section.locator("li", { hasText: stepLabel });
  const historicalInstruction = historicalStep.getByPlaceholder("Instruction");
  await waitForValue(historicalInstruction, ORIGINAL_INSTRUCTION);
  await waitForValue(historicalStep.getByLabel("Temperature"), "1550");
  await waitForChecked(historicalStep.getByLabel("Passed"), true);
  // disabled/title come from the same render pass as the value above (no separate effect), so
  // once the value has settled these are safe to read directly.
  assert.equal(await historicalInstruction.isDisabled(), true, "Rev 1 fields should be read-only");
  assert.equal(await historicalInstruction.getAttribute("title"), "Superseded revision — read-only");
  await shot("rev1-readonly-unchanged");
}
