// Flow 6: the Processes template list, still as the restricted (processes.view-only) user —
// search narrows the grid client-side, the export link still serves a real file, and Add is
// disabled with a tooltip naming processes.create for a user who can view templates but not
// create them.
import assert from "node:assert/strict";
import { assertNeverVisible } from "../lib/ui.mjs";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  await page.goto(`${ctx.baseURL}/processes`);
  await page.getByText(fixtures.liveTemplateName, { exact: true }).waitFor({ state: "visible" });
  await page.getByText(fixtures.decoyTemplateName, { exact: true }).waitFor({ state: "visible" });
  await shot("list-before-search");

  const search = page.getByPlaceholder("Search name");
  await search.fill("Austemper");
  await page.getByText(fixtures.liveTemplateName, { exact: true }).waitFor({ state: "visible" });
  await assertNeverVisible(
    page.getByText(fixtures.decoyTemplateName, { exact: true }),
    "decoy template should be filtered out by the search term",
    1000,
  );
  await shot("search-narrowed");

  await search.fill("");
  await page.getByText(fixtures.decoyTemplateName, { exact: true }).waitFor({ state: "visible" });

  const exportHref = await page.getByRole("link", { name: "Export to Excel" }).getAttribute("href");
  const exportUrl = new URL(exportHref, ctx.baseURL).toString();
  const response = await page.request.get(exportUrl);
  assert.equal(response.status(), 200, `templates export should respond 200, got ${response.status()}`);
  const contentType = response.headers()["content-type"] ?? "";
  assert.ok(contentType.includes("spreadsheetml"), `unexpected export content-type: ${contentType}`);

  const addButton = page.getByRole("button", { name: "Add", exact: true });
  assert.equal(await addButton.isDisabled(), true, "Add should be disabled without processes.create");
  assert.equal(await addButton.getAttribute("title"), "Requires processes.create");
  await shot("add-disabled-for-restricted-user");
}
