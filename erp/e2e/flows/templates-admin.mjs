// Flow: the document-template admin screen (Phase 7 Task 16) — the first template-designer screen.
//
// As admin: reach /admin/templates via the Admin > Templates nav entry (NOT a top-level entry —
// the nav decision, spec §5.5), see the 8 document types each with its seeded "Standard" default
// starred, create a template (which opens its v1 draft — "opening a draft"), publish it, and open
// a fresh draft from the published version (the lifecycle end to end).
//
// Then open the Task 17 structured editor on that v2 draft and exercise the contract-driven panels:
// a LOCKED element (the traveler barcode / Process-steps section) renders locked and disabled with
// its §5.6 reason; a free section toggles (and the draft goes dirty); a field label override is set;
// a format knob is picked; and the fixture logo is uploaded through the Task 4 sniff/cap route with
// a header placement chosen. The Save button + the updatedAt-409 conflict UX are Task 18, so this
// flow does NOT save — it proves the panels produce the edited config in state.
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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { login } from "../lib/auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_FIXTURE = path.join(__dirname, "..", "fixtures", "logo.png");

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

  // --- The structured editor (Task 17): open the v2 draft and exercise the contract-driven panels ---
  // The panels are the whole point of Task 17; SAVE + the updatedAt-409 conflict UX is Task 18, so
  // this flow drives the panels (and the logo route, a separate write) but does NOT click "Save draft".
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByRole("heading", { name: DOC_TEMPLATE_NAME }).waitFor({ state: "visible" });
  await page.getByText("Traveler · editing draft v2").waitFor({ state: "visible" });

  // A LOCKED element renders locked and its controls are disabled (spec §5.6): the traveler barcode
  // and the whole Process-steps section cannot be hidden — the padlock + reason are shown.
  const barcodeToggle = page.getByRole("checkbox", { name: "Show field Order barcode" });
  await barcodeToggle.waitFor({ state: "visible" });
  assert.equal(await barcodeToggle.isDisabled(), true, "the locked barcode field cannot be hidden");
  assert.equal(
    await page.getByRole("checkbox", { name: "Show section Process steps" }).isDisabled(), true,
    "the locked steps section cannot be hidden",
  );
  await page.locator('[aria-label^="locked:"]').first().waitFor({ state: "visible" });
  await shot("editor-locked-elements");

  // Toggle a FREE section (Part lines is hideable) — it flips and the draft is marked dirty.
  const partLines = page.getByRole("checkbox", { name: "Show section Part lines" });
  assert.equal(await partLines.isDisabled(), false, "a hideable section's toggle is enabled");
  await partLines.uncheck();
  assert.equal(await partLines.isChecked(), false, "the section is now hidden in the working config");
  await page.getByText("Unsaved changes").waitFor({ state: "visible" });

  // Set a LABEL override on a free field.
  const labelInput = page.getByRole("textbox", { name: "Label for Order number" });
  await labelInput.fill("Work Order #");
  assert.equal(await labelInput.inputValue(), "Work Order #", "the label override is held in state");

  // Pick a FORMAT knob — the traveler declares thousands grouping (the FormatsPanel renders exactly
  // the knobs the contract declares; the billing docs' negative-style/date dropdowns are the same
  // panel, no per-type branch).
  const thousands = page.getByRole("checkbox", { name: "Group thousands" });
  await thousands.waitFor({ state: "visible" });
  const wasGrouped = await thousands.isChecked();
  await thousands.setChecked(!wasGrouped);
  assert.equal(await thousands.isChecked(), !wasGrouped, "the format knob flips");

  // Upload the FIXTURE logo (the Task 4 route sniffs + caps the bytes) and choose a placement.
  await page.getByText("No image uploaded").waitFor({ state: "visible" });
  await page.getByLabel("Upload logo image").setInputFiles(LOGO_FIXTURE);
  await page.getByText(/Image on file \(image\/png\)/).waitFor({ state: "visible" });
  await page.getByRole("combobox", { name: "Logo placement" }).selectOption("header-left");
  await shot("editor-panels-exercised-logo-uploaded");
  // The config edits stay UNSAVED — the Save button + the updatedAt-409 conflict UX are Task 18's;
  // this flow proves the panels. The logo BYTES were written (a separate route), and the whole
  // template is reaped by name in teardown, logo and all.

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
