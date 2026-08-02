// Flow 4: attempt to delete E2E-QNCH — the step code template-build-and-load's template and the
// fixture part's process steps both still use — from the admin Process step codes screen. Spec
// §3.2/§7: ANY live use blocks the delete, and the refusal must name what's blocking it (CLAUDE.md
// "blocked deletes need discoverable blockers" — the Visual Shop dead end this app is escaping),
// not just say no. Also checks the blocker export link actually serves a file.
import assert from "node:assert/strict";
import { armDialog } from "../lib/ui.mjs";

const EM_DASH = "—";

export async function run(page, shot, ctx) {
  const { fixtures, created } = ctx;
  const { stepCodeA } = fixtures;
  const codeHeading = `${stepCodeA.code} ${EM_DASH} ${stepCodeA.name}`;
  const templateId = created.templateIds[0];
  assert.ok(templateId, "expected template-build-and-load to have registered a template id");

  await page.goto(`${ctx.baseURL}/admin/step-codes`);
  await page.locator("li", { hasText: stepCodeA.code }).click();
  await page.getByRole("heading", { name: codeHeading }).waitFor({ state: "visible" });
  await shot("step-code-selected");

  const dialogMessage = armDialog(page);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const message = await dialogMessage;
  assert.equal(message, `Delete step code "${codeHeading}"?`);

  const panel = page.getByText(/Cannot delete process step code/);
  await panel.waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(/2 record\(s\) use it/).waitFor({ state: "visible" });

  // Names what's blocking the delete, and links to each one — the panel is never a dead end.
  const partLink = page.getByRole("link", { name: `${fixtures.customerCode} · ${fixtures.partNumber}` });
  await partLink.waitFor({ state: "visible" });
  assert.equal(await partLink.getAttribute("href"), `/parts/${fixtures.partId}`);

  const templateLink = page.getByRole("link", { name: fixtures.liveTemplateName });
  await templateLink.waitFor({ state: "visible" });
  assert.equal(await templateLink.getAttribute("href"), `/processes/templates/${templateId}`);

  await shot("blocked-delete-panel");

  const exportHref = await page.getByRole("link", { name: "Export list to Excel" }).getAttribute("href");
  const exportUrl = new URL(exportHref, ctx.baseURL).toString();
  const response = await page.request.get(exportUrl);
  assert.equal(response.status(), 200, `blocker export should respond 200, got ${response.status()}`);
  const contentType = response.headers()["content-type"] ?? "";
  assert.ok(contentType.includes("spreadsheetml"), `unexpected export content-type: ${contentType}`);

  await page.getByRole("button", { name: "dismiss" }).click();
  await panel.waitFor({ state: "hidden" });
  await shot("panel-dismissed");
}
