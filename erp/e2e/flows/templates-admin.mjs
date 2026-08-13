// Flow: the document-template admin screen (Phase 7 Task 16) — the first template-designer screen.
//
// As admin: reach /admin/templates via the Admin > Templates nav entry (NOT a top-level entry —
// the nav decision, spec §5.5), see the 8 document types each with its seeded "Standard" default
// starred, create a template (which opens its v1 draft — "opening a draft"), publish it, and open
// a fresh draft from the published version (the lifecycle end to end).
//
// Then, re-logged-in as the restricted VIEW-ONLY user (holds templates.view but NOT admin.view):
// prove the nav decision + §5.16 — that user still sees the Templates entry and reaches the page
// (the silent-dead-end rule) while NOT seeing the admin.view-gated entries, and every mutating
// control there is disabled with a tooltip naming the missing permission. The credit-hold /
// permission-gating precedent for a mid-flow re-login.
//
// The created template ("E2E Doc Template") is fully owned by this flow and reaped by name in
// db-fixtures.ts (deleteDocumentTemplatesByName); the seeded Standard templates are only read, and
// this flow never sets a default or assigns to a customer, so no shared/seeded state is mutated.
import assert from "node:assert/strict";
import { login } from "../lib/auth.mjs";

const DOC_TEMPLATE_NAME = "E2E Doc Template";
const DOC_TYPES = [
  "Traveler", "Shipping ticket", "Multi-order shipping ticket", "Bill of lading",
  "Certification", "Invoice / credit", "Statement", "Quotation",
];

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- As admin: reach the screen via the Admin > Templates nav entry ---
  const navTemplates = page.getByRole("link", { name: "Templates" });
  await navTemplates.waitFor({ state: "visible" });
  await navTemplates.click();
  await page.waitForURL(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });

  // The list loads via an async GET /api/templates, so the rows appear AFTER the (static) heading —
  // and on the E2E run this route is compiled by `next dev` on first hit, widening that gap to
  // seconds. `locator.count()` does NOT auto-wait, so wait for the list to render (a starred
  // default is visible) before counting, or the count reads 0 against an empty list.
  await page.locator('li [aria-label="default"]').first().waitFor({ state: "visible" });

  // All 8 document types are offered (the create picker) and each has its Standard default starred.
  const docTypePicker = page.getByRole("combobox", { name: "New template document type" });
  await assert.equal(await docTypePicker.locator("option").count(), 8, "the create picker offers all 8 document types");
  assert.deepEqual(
    await docTypePicker.locator("option").allTextContents(), DOC_TYPES,
    "the 8 document types render in spec order",
  );
  await assert.equal(
    await page.locator('li [aria-label="default"]').count(), 8,
    "each of the 8 document types has exactly one starred (default) template",
  );
  await assert.equal(
    await page.getByRole("listitem").filter({ hasText: "Standard" }).count(), 8,
    "the seeded default for each type is named Standard",
  );
  await shot("templates-list-8-types-standard-starred");

  // --- Create a template under Traveler — creating opens its v1 draft ---
  await docTypePicker.selectOption("TRAVELER");
  await page.getByPlaceholder("Template name").fill(DOC_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Create template" }).click();

  const newRow = page.getByRole("listitem").filter({ hasText: DOC_TEMPLATE_NAME });
  await newRow.waitFor({ state: "visible" });
  // The v1 draft is open (create opened it) and the row is NOT the default (star is the default's).
  await newRow.getByText("Draft", { exact: true }).waitFor({ state: "visible" });
  await assert.equal(
    await newRow.locator('[aria-label="default"]').count(), 0,
    "a freshly created template is not the default (it carries no star)",
  );
  await shot("template-created-with-open-draft");

  // Select it — the detail pane shows the open v1 draft and its lifecycle controls.
  await newRow.click();
  await page.getByText("Open draft: v1").waitFor({ state: "visible" });

  // Publish the draft (admin holds the edit_templates special) — v1 becomes the published version.
  await page.getByRole("button", { name: "Publish" }).click();
  await newRow.getByText("Published v1").waitFor({ state: "visible" });

  // Open a fresh draft from the published version (the ordinary edit-after-publish path) — v2.
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await shot("template-published-then-redrafted-v2");

  // --- Re-logged-in as the restricted VIEW-ONLY user (templates.view, NOT admin.view) ---
  await login(page, ctx.baseURL, fixtures.restrictedUsername, fixtures.restrictedPassword);

  // The nav decision: this user SEES the Templates entry (reaches the page) but NOT the
  // admin.view-gated entries.
  await page.getByRole("link", { name: "Templates" }).waitFor({ state: "visible" });
  await assert.equal(
    await page.getByRole("link", { name: "Users" }).count(), 0,
    "a templates.view-only user (no admin.view) does not see the admin.view-gated entries",
  );
  await page.getByRole("link", { name: "Templates" }).click();
  await page.waitForURL(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });

  // §5.16: every mutating control is disabled with a tooltip naming the missing permission.
  const createBtn = page.getByRole("button", { name: "Create template" });
  await assert.equal(await createBtn.isDisabled(), true, "Create is disabled for a view-only user");
  await assert.equal(
    await createBtn.getAttribute("title"), "Requires templates.create",
    "the disabled Create names the missing permission",
  );
  // The list still renders fully for a viewer — this is the disabled-with-reason path, not denied.
  // Wait for the async list before counting (same reason as the admin section above).
  await page.getByRole("listitem").filter({ hasText: "Standard" }).first().waitFor({ state: "visible" });
  await assert.equal(
    await page.getByRole("listitem").filter({ hasText: "Standard" }).count(), 8,
    "a view-only user still sees all 8 types' templates",
  );
  await shot("templates-view-only-user-controls-disabled");
}
