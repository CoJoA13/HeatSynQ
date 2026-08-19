import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOGO_WIDTH,
  STALE_DRAFT_MESSAGE,
  canMoveField,
  canMoveSection,
  clearLogoPlacement,
  lockIndex,
  moveField,
  moveSection,
  previewRecordSpec,
  resolveSaveError,
  resolveSaveSettle,
  setFieldLabel,
  setFieldWidth,
  setFonts,
  setFormat,
  setLogoPlacement,
  setLogoWidth,
  setPageFooter,
  setTextBlock,
  tableBudgets,
  toggleFieldVisible,
  toggleSectionVisible,
  widthBudgetError,
} from "@/lib/template-editor";
import {
  CERT_CONTRACT,
  CERT_DEFAULT_CONFIG,
  INVOICE_CONTRACT,
  INVOICE_DEFAULT_CONFIG,
  TEMPLATE_DOC_TYPES,
  TRAVELER_CONTRACT,
  TRAVELER_DEFAULT_CONFIG,
  TemplateConfigError,
  validateConfig,
  type TemplateConfig,
  type TemplateContract,
} from "@/lib/template-contracts";

// Pure module, no DB, no DOM: the config-editing logic the editor's panels are thin wrappers over
// (Phase 7 Task 17). Every function is immutable — the input config is never mutated — and the
// width-budget check mirrors the server's own guardrail so the editor surfaces it early. The
// panels themselves (the rendered UI) are proven in the templates-admin E2E flow.

/** A deep JSON copy — a fresh working config per test, and a guard that a mutation didn't touch
 *  the input (compare the input to its pre-call clone). */
function clone(config: TemplateConfig): TemplateConfig {
  return JSON.parse(JSON.stringify(config)) as TemplateConfig;
}

const traveler = () => clone(TRAVELER_DEFAULT_CONFIG);
const invoice = () => clone(INVOICE_DEFAULT_CONFIG);

function sectionVisible(config: TemplateConfig, key: string): boolean {
  return config.sections.find((s) => s.key === key)!.visible;
}
function field(config: TemplateConfig, sectionKey: string, fieldKey: string) {
  return config.sections.find((s) => s.key === sectionKey)!.fields.find((f) => f.key === fieldKey)!;
}
function sectionOrder(config: TemplateConfig): string[] {
  return config.sections.map((s) => s.key);
}

describe("show/hide", () => {
  it("toggleSectionVisible flips visibility without mutating the input", () => {
    const before = traveler();
    const snapshot = clone(before);
    const after = toggleSectionVisible(before, "lines");
    expect(sectionVisible(after, "lines")).toBe(false);
    expect(toggleSectionVisible(after, "lines")).toEqual(before); // flips back
    expect(before).toEqual(snapshot); // input untouched
  });

  it("toggleFieldVisible flips a field's visibility", () => {
    const after = toggleFieldVisible(traveler(), "lines", "line_qty");
    expect(field(after, "lines", "line_qty").visible).toBe(false);
  });
});

describe("label override", () => {
  it("setFieldLabel sets an override, and '' clears it back to the contract default (null)", () => {
    const named = setFieldLabel(traveler(), "lines", "line_qty", "Qty");
    expect(field(named, "lines", "line_qty").label).toBe("Qty");
    const cleared = setFieldLabel(named, "lines", "line_qty", "");
    expect(field(cleared, "lines", "line_qty").label).toBeNull();
  });

  it("does not mutate the input", () => {
    const before = traveler();
    const snapshot = clone(before);
    setFieldLabel(before, "lines", "line_qty", "Qty");
    expect(before).toEqual(snapshot);
  });
});

describe("column widths", () => {
  it("setFieldWidth sets an override; null clears it", () => {
    const wide = setFieldWidth(traveler(), "lines", "line_qty", 90);
    expect(field(wide, "lines", "line_qty").width).toBe(90);
    expect(field(setFieldWidth(wide, "lines", "line_qty", null), "lines", "line_qty").width).toBeNull();
  });

  it("tableBudgets: the default traveler config is within budget", () => {
    const budgets = tableBudgets(TRAVELER_CONTRACT, traveler());
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets.every((b) => !b.over)).toBe(true);
  });

  it("tableBudgets: over-budget column widths report over-budget, matching the server's budget rule", () => {
    // The traveler's "lines" table: [78, "*", 78, 88]; the flex column counts 0. Each field width
    // must stay <=564 (the per-field shape cap), so blow the budget with the SUM of two legal
    // widths: line_qty 300 + line_each_weight 78 + line_weight 300 = 678 > 564.
    const bad = setFieldWidth(setFieldWidth(traveler(), "lines", "line_qty", 300),
      "lines", "line_weight", 300);
    const linesBudget = tableBudgets(TRAVELER_CONTRACT, bad).find((b) => b.table === "lines")!;
    expect(linesBudget.over).toBe(true);
    expect(linesBudget.budget).toBe(564);
    expect(linesBudget.total).toBe(300 + 78 + 300); // "*" counts 0
    // The client shows this early; the SERVER still refuses the hand-built config via the budget
    // rule (TemplateConfigError, NOT a per-field shape ZodError — every field here is <=564).
    expect(() => validateConfig("TRAVELER", bad)).toThrow(TemplateConfigError);
  });

  it("tableBudgets: hiding a column frees its budget (only visible columns count)", () => {
    // Widen line_qty over budget, then hide the flex part column — still over; hide line_qty's
    // section-mates until under. Simpler: widen to exactly the edge and confirm the hide drops it.
    const wide = setFieldWidth(traveler(), "lines", "line_weight", 400); // 78+0+78+400 = 556, ok
    expect(tableBudgets(TRAVELER_CONTRACT, wide).find((b) => b.table === "lines")!.over).toBe(false);
    const wider = setFieldWidth(wide, "lines", "line_qty", 200); // 200+0+78+400 = 678 > 564
    expect(tableBudgets(TRAVELER_CONTRACT, wider).find((b) => b.table === "lines")!.over).toBe(true);
    const hidden = toggleFieldVisible(wider, "lines", "line_weight"); // drops 400 → 278, ok
    expect(tableBudgets(TRAVELER_CONTRACT, hidden).find((b) => b.table === "lines")!.over).toBe(false);
  });
});

describe("section reorder respecting pins", () => {
  // Traveler section order: header(0), lines(1), quantities(2), process(3), inspections(4),
  // steps(5, PINNED non-reorderable), footer(6). steps must stay at index 5.
  it("moves two reorderable neighbours", () => {
    const moved = moveSection(traveler(), TRAVELER_CONTRACT, "header", 1);
    expect(sectionOrder(moved).slice(0, 2)).toEqual(["lines", "header"]);
  });

  it("canMoveSection: a pinned section cannot move in either direction", () => {
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "steps", -1)).toBe(false);
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "steps", 1)).toBe(false);
    expect(moveSection(traveler(), TRAVELER_CONTRACT, "steps", -1)).toEqual(traveler());
  });

  it("canMoveSection: a move that would displace a pinned neighbour is blocked", () => {
    // inspections(4) down would swap into steps(5) — blocked, keeping steps at its index.
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "inspections", 1)).toBe(false);
    // footer(6) up would swap with steps — blocked; footer is otherwise reorderable.
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "footer", -1)).toBe(false);
  });

  it("canMoveSection: false at the list boundaries", () => {
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "header", -1)).toBe(false);
  });

  it("a config produced by legal moves keeps steps at its contract index and validates", () => {
    let config = traveler();
    config = moveSection(config, TRAVELER_CONTRACT, "header", 1);
    config = moveSection(config, TRAVELER_CONTRACT, "quantities", -1);
    expect(sectionOrder(config).indexOf("steps")).toBe(5);
    expect(() => validateConfig("TRAVELER", config)).not.toThrow();
  });
});

describe("field reorder", () => {
  it("moveField swaps within a section; canMoveField bounds", () => {
    const moved = moveField(traveler(), "lines", "line_qty", 1);
    expect(field(moved, "lines", "line_part")).toBeDefined();
    expect(moved.sections.find((s) => s.key === "lines")!.fields.slice(0, 2).map((f) => f.key))
      .toEqual(["line_part", "line_qty"]);
    expect(canMoveField(traveler(), "lines", "line_qty", -1)).toBe(false); // already first
    expect(canMoveField(traveler(), "lines", "line_qty", 1)).toBe(true);
  });
});

describe("format knobs", () => {
  it("setFormat sets a declared knob on the invoice", () => {
    const c = setFormat(invoice(), "negativeStyle", "PARENTHESES");
    expect(c.formats.negativeStyle).toBe("PARENTHESES");
    const d = setFormat(c, "priceDecimals", 3);
    expect(d.formats.priceDecimals).toBe(3);
    const e = setFormat(d, "dateFormat", "YYYY-MM-DD");
    expect(e.formats.dateFormat).toBe("YYYY-MM-DD");
    expect(() => validateConfig("INVOICE", e)).not.toThrow();
  });
});

describe("fonts, text blocks, page footer", () => {
  it("setFonts patches family and sizes", () => {
    const c = setFonts(traveler(), { family: "Liberation Sans", baseSize: 9 });
    expect(c.fonts.family).toBe("Liberation Sans");
    expect(c.fonts.baseSize).toBe(9);
    expect(c.fonts.headingSize).toBe(TRAVELER_DEFAULT_CONFIG.fonts.headingSize); // untouched
  });

  it("setTextBlock sets a block body (cert statement)", () => {
    const c = setTextBlock(clone(CERT_DEFAULT_CONFIG), "cert_statement", "We certify the above.");
    expect(c.textBlocks.cert_statement).toBe("We certify the above.");
    expect(() => validateConfig("CERT", c)).not.toThrow();
    expect(CERT_CONTRACT.textBlocks.some((t) => t.key === "cert_statement")).toBe(true);
  });

  it("setPageFooter toggles the page footer", () => {
    expect(setPageFooter(traveler(), true).pageFooter).toBe(true);
  });
});

describe("logo placement + width", () => {
  it("setLogoPlacement creates the logo block with the default width", () => {
    const c = setLogoPlacement(traveler(), "header-left");
    expect(c.logo).toEqual({ placement: "header-left", width: DEFAULT_LOGO_WIDTH });
  });

  it("setLogoWidth preserves the placement; changing placement preserves the width", () => {
    const placed = setLogoPlacement(traveler(), "header-left");
    const sized = setLogoWidth(placed, 200);
    expect(sized.logo).toEqual({ placement: "header-left", width: 200 });
    const moved = setLogoPlacement(sized, "header-center");
    expect(moved.logo).toEqual({ placement: "header-center", width: 200 });
  });

  it("setLogoWidth is a no-op when no placement is chosen", () => {
    expect(setLogoWidth(traveler(), 200).logo).toBeNull();
  });

  it("clearLogoPlacement removes the logo block", () => {
    expect(clearLogoPlacement(setLogoPlacement(traveler(), "header-left")).logo).toBeNull();
  });
});

describe("lockIndex — the namespaced padlock lookup the panels render from", () => {
  it("keys each locked element by (scope, key) so a section lookup never matches a field lookup", () => {
    const idx = lockIndex(TRAVELER_CONTRACT);
    // The steps section AND its typed-field columns are both locked (spec §5.6) — each reachable
    // under its own scope, both carrying the step-fields reason.
    expect(idx.get("section:steps")).toMatch(/Step-fields ruling/);
    expect(idx.get("field:step_code")).toMatch(/Step-fields ruling/);
    // The header section is locked (it carries the barcode) and so is the barcode field.
    expect(idx.get("section:header")).toBeDefined();
    expect(idx.get("field:barcode")).toBeDefined();
    // A free section/field is absent — the editor renders no padlock for it.
    expect(idx.get("section:lines")).toBeUndefined();
    expect(idx.get("field:line_qty")).toBeUndefined();
  });

  it("resolves a section and a field that SHARE a key independently, by scope", () => {
    // A section key and a field key are each only unique within their own kind, so a contract can
    // legitimately carry both "shared" a locked section and "shared" a free field. Keyed by scope,
    // the two never collide into one ambiguous padlock (the Task 1 review carry's whole point).
    const SECTION_LOCK = "the shared section is pinned";
    const collide: TemplateContract = {
      docType: "TRAVELER", name: "Collide",
      sections: [
        {
          key: "shared", name: "Shared section", hideable: false, reorderable: true,
          lockReason: SECTION_LOCK,
          fields: [{ key: "shared", name: "Shared field", defaultLabel: "", removable: true }],
        },
      ],
      textBlocks: [], formats: {},
      fonts: { family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6 },
    };
    const idx = lockIndex(collide);
    expect(idx.get("section:shared")).toBe(SECTION_LOCK); // the section is locked
    expect(idx.get("field:shared")).toBeUndefined();      // the same-keyed field is NOT
  });
});

describe("defense in depth — the server refuses a hand-built bad config", () => {
  it("refuses a config that hides a locked section (the traveler steps)", () => {
    // The UI disables the steps hide toggle, so this config is un-producible from the editor —
    // but if one reached the server anyway, validateConfig refuses it (spec §5.6).
    const bad = toggleSectionVisible(traveler(), "steps");
    expect(sectionVisible(bad, "steps")).toBe(false);
    expect(() => validateConfig("TRAVELER", bad)).toThrow(TemplateConfigError);
  });

  it("refuses a config that hides a locked field (the traveler barcode)", () => {
    const bad = toggleFieldVisible(traveler(), "header", "barcode");
    expect(() => validateConfig("TRAVELER", bad)).toThrow(TemplateConfigError);
  });

  it("the invoice contract has no format-knob drift — every default validates round-trip", () => {
    expect(() => validateConfig("INVOICE", invoice())).not.toThrow();
    expect(INVOICE_CONTRACT.formats.negativeStyle).toBeDefined();
  });
});

describe("resolveSaveError — the save-conflict state machine (Task 18)", () => {
  it("a 409 asks the caller to roll back to server truth THEN show the stale-draft banner", () => {
    // The one status that earns the reload-vs-overwrite treatment. The action name encodes the
    // HANDOFF §5.13 ordering: the caller reloads FIRST, then shows `message` (a reload after the
    // banner is set would wipe it). The server's own 409 wording is ignored in favour of one that
    // describes what the editor has already done (auto-reloaded) and offers re-apply.
    const r = resolveSaveError(
      409, "The draft changed since you loaded it — reload the editor and re-apply your changes");
    expect(r.action).toBe("reload-then-conflict");
    expect(r.message).toBe(STALE_DRAFT_MESSAGE);
  });

  it("every non-409 failure surfaces its own message with NO reload path", () => {
    // A 400 from validateConfig, a 403, a 404, a 500, and a network error (null status) all take
    // the plain-error branch — only the stale-precondition 409 reloads (brief §3).
    for (const status of [400, 403, 404, 500, null]) {
      const r = resolveSaveError(status, "the server's own message");
      expect(r.action).toBe("error");
      expect(r.message).toBe("the server's own message");
    }
  });
});

describe("resolveSaveSettle — the edit-epoch gate at a save's two settle points (Group D Task 8)", () => {
  it("save-success with an intervening apply keeps dirty: the outcome is withheld, the precondition still advances", () => {
    // apply() bumped the edit epoch while the PATCH was in flight, so the save's ticket is no
    // longer current: marking the editor clean/Saved would falsely claim the newer edits were
    // written (the user navigates away, work lost). The precondition (updatedAt) DID genuinely
    // advance server-side, so freshening it is always safe — and required for the next save.
    const d = resolveSaveSettle(true);
    expect(d.freshenPrecondition).toBe(true);
    expect(d.applyOutcome).toBe(false); // dirty stays true, Save stays live
  });

  it("409-rollback with an intervening apply skips the config reset and the conflict banner", () => {
    // The same decision at the OTHER settle point: an apply() during the rollback fetch means the
    // user has moved on (the exact semantics apply's conflict-dismissal already claims), so the
    // fetched config must NOT replace what they typed and no banner blames another editor —
    // updatedAt/logo meta are still freshened from the fetch.
    const d = resolveSaveSettle(true);
    expect(d.freshenPrecondition).toBe(true);
    expect(d.applyOutcome).toBe(false); // no setConfig, no setDirty(false), no conflict banner
  });

  it("with no intervening edit, both settle points apply their outcome in full", () => {
    const d = resolveSaveSettle(false);
    expect(d.freshenPrecondition).toBe(true);
    expect(d.applyOutcome).toBe(true); // success marks clean/Saved; the 409 path resets + banners
  });
});

describe("widthBudgetError — early-disable Save on an over-budget config (Task 18 minor)", () => {
  it("returns null for a within-budget working config (Save is not blocked)", () => {
    expect(widthBudgetError(TRAVELER_CONTRACT, traveler())).toBeNull();
  });

  it("names the over-budget table — the SAME config the server's validateConfig refuses", () => {
    // 300 + 78 (line_each_weight) + 300 = 678 > the 564 "lines" budget — every field width stays
    // <=564, so this is the budget rule, not a per-field shape cap (mirrors the tableBudgets test).
    const bad = setFieldWidth(
      setFieldWidth(traveler(), "lines", "line_qty", 300), "lines", "line_weight", 300);
    const reason = widthBudgetError(TRAVELER_CONTRACT, bad);
    expect(reason).not.toBeNull();
    expect(reason).toContain("lines");
    // Client early-disable and server backstop agree on the same config (spec §5.6 defense-in-depth).
    expect(() => validateConfig("TRAVELER", bad)).toThrow(TemplateConfigError);
  });
});

describe("previewRecordSpec — the picker's docType → record-type mapping (Task 19)", () => {
  it("covers every docType with a list endpoint and a list permission", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      const spec = previewRecordSpec(docType);
      expect(spec.listPath).toMatch(/^\/api\//);
      expect(spec.listPermission).toMatch(/\.view$/);
      expect(spec.noun.length).toBeGreaterThan(0);
    }
  });

  it("maps each type to the right record and list route", () => {
    expect(previewRecordSpec("TRAVELER")).toMatchObject({ kind: "order", listPath: "/api/orders", listPermission: "orders.view" });
    expect(previewRecordSpec("BOL")).toMatchObject({ kind: "shipment", listPath: "/api/shippers", listPermission: "shipping.view" });
    expect(previewRecordSpec("CERT")).toMatchObject({ kind: "cert", listPath: "/api/certs", listPermission: "certs.view" });
    expect(previewRecordSpec("INVOICE")).toMatchObject({ kind: "invoice", listPath: "/api/invoices", listPermission: "invoicing.view" });
    expect(previewRecordSpec("QUOTE")).toMatchObject({ kind: "quote", listPath: "/api/quotes", listPermission: "quotes.view" });
  });

  it("splits shipments by order count — SHIPPER single, MOS_SHIPPER multi — both on /api/shippers", () => {
    const single = previewRecordSpec("SHIPPER");
    const multi = previewRecordSpec("MOS_SHIPPER");
    expect(single).toMatchObject({ kind: "shipment-single", orderCount: "single", listPermission: "shipping.view" });
    expect(multi).toMatchObject({ kind: "shipment-multi", orderCount: "multi", listPermission: "shipping.view" });
  });

  it("statement's record is a CUSTOMER, listed via /api/customers (customers.view) — distinct from the preview's receivables gate", () => {
    expect(previewRecordSpec("STATEMENT")).toMatchObject({
      kind: "customer", listPath: "/api/customers", listPermission: "customers.view",
    });
  });
});
