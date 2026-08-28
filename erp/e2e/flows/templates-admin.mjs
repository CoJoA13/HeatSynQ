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
// a header placement chosen.
//
// Then Task 18's SAVE + updatedAt-409 CONFLICT UX (the load-bearing §5.13 proof): with those edits
// unsaved, a COMPETING change lands on the same draft from another request (bumping its updatedAt),
// so the editor's save precondition is stale. Saving surfaces the named 409 as a reload-vs-overwrite
// choice: the editor rolls back to server truth FIRST, THEN shows a persistent conflict banner that
// the reload does NOT wipe (§5.13), and the set-aside edits can be re-applied and saved over the new
// version (a deliberate overwrite). This flow drives both — the safe reload AND the overwrite.
//
// Then, re-logged-in as the restricted VIEW-ONLY user (holds templates.view but NOT admin.view):
// prove the nav decision + §5.16 — that user still sees the Templates entry and reaches the page
// (the silent-dead-end rule) while NOT seeing the admin.view-gated entries, and every mutating
// control there is disabled with a tooltip naming the missing permission. The credit-hold /
// permission-gating precedent for a mid-flow re-login.
//
// The created template ("E2E Doc Template") is fully owned by this flow and reaped by name in
// db-fixtures.ts (deleteDocumentTemplatesByName); the seeded Standard templates are only read, and
// this flow never sets a type DEFAULT.
//
// It DOES assign that template to a customer (the Task 20 section below) — the header used to say
// it never did, a false guarantee corrected with #234. Two things keep that honest: the assignment
// targets this run's OWN fixture customer, matched by exact code, and it is cleared back to
// use-default/inherit in the same section. `deleteDocumentTemplatesByName` also reaps any
// assignment pointing at this flow's template, so a mid-flow failure cannot leave one behind.
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

  // #234: assert PER DOCUMENT TYPE, never plant-wide. The old form counted every list item whose
  // text contained "Standard" and every starred row on the page, expecting exactly 8 of each — a
  // claim about the whole plant that any custom template breaks, on a dev DB the run does not own.
  // Each type's list carries an aria-label, so the scope is the type's own <ul>.
  async function assertStandardDefault(typeName) {
    const list = page.getByRole("list", { name: typeName });
    await list.waitFor({ state: "visible" });
    const starred = list.locator("li").filter({ has: page.locator('[aria-label="default"]') });
    assert.equal(await starred.count(), 1, `${typeName}: exactly one starred default template`);
    // Exact name, not a substring: "Standard Plus" must not satisfy "the seeded default is Standard".
    await starred.getByText("Standard", { exact: true }).waitFor({ state: "visible" });
  }

  // All 8 document types are offered (the create picker) and each has its Standard default starred.
  const docTypePicker = page.getByRole("combobox", { name: "New template document type" });
  await assert.equal(await docTypePicker.locator("option").count(), 8, "the create picker offers all 8 document types");
  assert.deepEqual(
    await docTypePicker.locator("option").allTextContents(), DOC_TYPES,
    "the 8 document types render in spec order",
  );
  for (const typeName of DOC_TYPES) await assertStandardDefault(typeName);
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
  // The panels are exercised first; Task 18's SAVE + updatedAt-409 conflict UX follows below.
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

  // --- Task 18: the updatedAt-409 conflict UX (reload-vs-overwrite, HANDOFF §5.13) ---
  // The editor now holds several UNSAVED edits (the hidden Part-lines section, the "Work Order #"
  // label, the flipped format knob, the header logo placement). Land a COMPETING change on the same
  // draft from another request so the editor's save precondition goes stale.
  const templateId = page.url().match(/\/admin\/templates\/([^/]+)\/edit/)[1];
  assert.ok(templateId, "extracted the template id from the editor URL");

  // Read the current server draft and PATCH it back with a real change (flip the page footer),
  // matching its own updatedAt so this competing write succeeds and advances updatedAt past what the
  // editor loaded. The read shares the browser context's cookies, so it acts as this same admin.
  //
  // The WRITE goes through `ctx.apiMutate` rather than the APIRequestContext directly (#184 fix
  // round, finding 1): Playwright emits no context request/response event for one, so a raw call
  // here is a real dev-DB write the retry gate's mutation counters cannot see — it would read
  // "this flow changed nothing" and re-run the flow from step 1. `run.mjs` refuses the whole run
  // on a raw one now, so this is enforced rather than remembered.
  const draftBefore = await (await page.request.get(`${ctx.baseURL}/api/templates/${templateId}`)).json();
  const competing = { ...draftBefore.draft.config, pageFooter: !draftBefore.draft.config.pageFooter };
  const competingRes = await ctx.apiMutate(page, `${ctx.baseURL}/api/templates/${templateId}/draft`, {
    method: "PATCH",
    data: { config: competing, updatedAt: draftBefore.draft.updatedAt },
  });
  assert.equal(competingRes.ok(), true, "the competing change saved, bumping the draft's updatedAt");

  // Save the editor's stale edits → the named 409, surfaced as the conflict banner. The editor rolls
  // back to server truth FIRST, THEN shows the banner — §5.13, so the reload never wipes it.
  await page.getByRole("button", { name: "Save draft" }).click();
  const conflictBanner = page.getByText(/reloaded the current draft/i);
  await conflictBanner.waitFor({ state: "visible" });
  await shot("editor-save-conflict-banner");

  // The reload DID roll back to server truth: the section the stale edit had hidden is visible again
  // and the stale label override is gone — the editor shows the current draft, not the stale edits.
  assert.equal(await partLines.isChecked(), true, "the reload restored the section the stale edit had hidden");
  assert.equal(await labelInput.inputValue(), "", "the reload discarded the stale label override");
  // ...and the banner SURVIVED that reload — the load-bearing §5.13 assertion.
  assert.equal(await conflictBanner.isVisible(), true, "the conflict banner persists through the reload");

  // The overwrite half of the choice: re-apply the set-aside edits onto the fresh precondition and
  // save over the competing version. Acting on the conflict clears the banner and the save succeeds.
  await page.getByRole("button", { name: "Re-apply my changes" }).click();
  await conflictBanner.waitFor({ state: "hidden" }); // acting on the conflict dismissed the banner
  assert.equal(await partLines.isChecked(), false, "re-apply put the stale edits back onto server truth");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  await shot("editor-conflict-overwrite-saved");
  // The template — logo bytes and the now-saved config — is reaped by name in teardown.

  // --- Task 19: the live PREVIEW pane (side-effect-free render of the WORKING config) ---
  // Pick a real order (this flow runs last, so earlier flows have left live orders in the dev DB)
  // and render a preview. The preview POSTs the editor's WORKING config to
  // /api/templates/<id>/preview and streams a PDF — nothing is saved, printed, or archived.
  const recordSelect = page.getByRole("combobox", { name: "Preview record" });
  await recordSelect.waitFor({ state: "visible" });
  // The picker only offers records the user can view; index 0 is the "— pick a … —" placeholder.
  const firstRecord = await recordSelect.locator("option").nth(1).getAttribute("value");
  assert.ok(firstRecord, "at least one order is available in the preview picker");
  await recordSelect.selectOption(firstRecord);

  // `bodyLabel` reads a field's label override out of a submitted config — the preview's proof is
  // that the config the pane POSTs is the WORKING one, edits and all.
  const bodyLabel = (config, section, field) =>
    config.sections.find((s) => s.key === section)?.fields.find((f) => f.key === field)?.label ?? null;

  // Preview 1: the working config already carries the re-applied "Work Order #" override, so it
  // must ride in the POST body — and the rendered PDF appears in the iframe.
  const [previewReq1] = await Promise.all([
    page.waitForRequest((r) => r.url().includes(`/api/templates/${templateId}/preview`) && r.method() === "POST"),
    page.getByRole("button", { name: "Run preview" }).click(),
  ]);
  assert.equal(
    bodyLabel(previewReq1.postDataJSON().config, "header", "order_number"), "Work Order #",
    "the preview POSTs the WORKING config (the saved 'Work Order #' override rides in the body)",
  );
  await page.getByTitle("Template preview").waitFor({ state: "visible" });
  await shot("editor-preview-rendered");

  // Edit the label again and RE-preview — the second POST must carry the just-made edit, proving
  // the preview reflects the working config live (the unit suite proves the byte shows up).
  await labelInput.fill("PREVIEW-EDIT-Order");
  const [previewReq2] = await Promise.all([
    page.waitForRequest((r) => r.url().includes(`/api/templates/${templateId}/preview`) && r.method() === "POST"),
    page.getByRole("button", { name: "Run preview" }).click(),
  ]);
  assert.equal(
    bodyLabel(previewReq2.postDataJSON().config, "header", "order_number"), "PREVIEW-EDIT-Order",
    "the re-preview reflects the just-made label edit — the WORKING config, not the saved one",
  );
  await page.getByTitle("Template preview").waitFor({ state: "visible" });
  await shot("editor-preview-reflects-edit");

  // --- Task 20: the customer-page template-assignment picker (§5.2, §5.15, §5.16) ---
  // Still as admin. Assign the just-published "E2E Doc Template" (a Traveler template) to THIS
  // RUN'S OWN fixture customer through the picker, watch the resolved state reflect it, then clear
  // back to the type's default. The page's request context shares the browser cookies, so it reads
  // /api/customers as this admin.
  //
  // #234: this used to take `customers[0]` — the alphabetically-FIRST customer in the dev DB.
  // `listCustomers` orders by code ascending and every fixture customer is E2E*-coded, so any
  // ambient customer ("ACME") sorted first and won: the flow then asserted that stranger's picker
  // state and PUT a real, audited assignment onto a row the run does not own. Matching the fixture
  // by its exact code is every other flow's pattern.
  const customers = await (await page.request.get(`${ctx.baseURL}/api/customers`)).json();
  assert.ok(Array.isArray(customers), "the customers list reads as an array");
  const target = customers.find((c) => c.code === fixtures.customerCode);
  assert.ok(target, `the fixture customer ${fixtures.customerCode} is present to assign a template to`);
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);

  // The picker is its own section; its two reads (the requireUser-only names + the customers.view
  // resolved state) are async and compiled by `next dev` on first hit, so wait for the Traveler
  // select to render rather than the loading line.
  const travelerPicker = page.getByRole("combobox", { name: "Template for Traveler" });
  await travelerPicker.waitFor({ state: "visible" });
  // The FIXTURE customer carries no TRAVELER assignment before this flow (#234: previously stated
  // of whichever customer sorted first, which is not this run's to claim), so the select starts on
  // the use-default/inherit option (§5.15 shows the resolved state beside it, never blank).
  assert.equal(await travelerPicker.inputValue(), "",
    `${fixtures.customerCode}'s Traveler picker starts on use-default/inherit`);

  // Assign the published template — the PUT lands and the resolved state reloads to show it OWNED.
  await travelerPicker.selectOption({ label: DOC_TEMPLATE_NAME });
  await page.getByText(`Assigned: ${DOC_TEMPLATE_NAME}`).waitFor({ state: "visible" });
  assert.notEqual(await travelerPicker.inputValue(), "", "the picker now holds the assigned template id");
  await shot("customer-template-assigned");

  // Clear back to the default — the DELETE lands and future paper falls back down the §5.2 chain.
  await travelerPicker.selectOption({ label: "Use default / inherit" });
  await page.getByText(`Assigned: ${DOC_TEMPLATE_NAME}`).waitFor({ state: "hidden" });
  assert.equal(await travelerPicker.inputValue(), "", "the picker is back on use-default/inherit");
  await shot("customer-template-cleared-to-default");

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
  await page.locator('li [aria-label="default"]').first().waitFor({ state: "visible" });
  // #234: per-type again — the claim is "a viewer still sees every type's seeded default", which
  // is exactly what this asserts, without counting rows the run does not own.
  for (const typeName of DOC_TYPES) await assertStandardDefault(typeName);
  await shot("templates-view-only-user-controls-disabled");
}
