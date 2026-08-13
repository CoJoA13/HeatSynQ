import { describe, it, expect } from "vitest";
import { widgetKindFor, selectOptionsFor, selectLabelsFor, coerceForSubmit } from "@/lib/settings-ui";
import { CERT_SCOPES, CERT_SCOPE_LABELS } from "@/lib/cert-constants";

// Task 12, Step 0a/0b: the settings page (src/app/admin/settings/page.tsx) has only ever
// rendered every value as a string `<input>` and submitted every value as a string — so
// Task 1's first boolean setting (cert_required_default) and first enum setting
// (cert_scope_default) were unusable from the UI even though setSetting's zod schema
// (src/server/settings.ts) already accepts their real types. These pure, client-safe helpers are
// what the page now uses to pick a widget per setting and to submit the real JS type each widget
// implies — the actual fix, not just its symptom.
describe("settings page widget selection (Task 12 Step 0a/0b)", () => {
  it("renders a checkbox for a boolean setting", () => {
    expect(widgetKindFor("cert_required_default", false)).toBe("checkbox");
    expect(widgetKindFor("cert_required_default", true)).toBe("checkbox");
  });

  it("renders a select over CERT_SCOPES for the scope enum, not a boolean/number/text guess", () => {
    expect(widgetKindFor("cert_scope_default", "ORDER")).toBe("select");
    expect(selectOptionsFor("cert_scope_default")).toEqual(CERT_SCOPES);
    expect(selectLabelsFor("cert_scope_default")).toEqual(CERT_SCOPE_LABELS);
  });

  it("no longer special-cases the retired standing-text keys — they render as plain text now", () => {
    // cert_statement / shipper_liability_text retired into template text blocks (Phase 7 Task 14),
    // so no textarea keys remain on the settings page; a stray string key falls through to text.
    expect(widgetKindFor("cert_statement", "some long legal text")).toBe("text");
    expect(widgetKindFor("shipper_liability_text", "some long legal text")).toBe("text");
  });

  it("renders a number input for a numeric setting", () => {
    expect(widgetKindFor("order_number_next", 1000)).toBe("number");
    expect(widgetKindFor("session_timeout_minutes", 480)).toBe("number");
  });

  it("falls back to plain text for an ordinary string setting", () => {
    expect(widgetKindFor("company_name", "Acme Heat Treating")).toBe("text");
  });

  it("has no select options for a non-enum key", () => {
    expect(selectOptionsFor("company_name")).toBeUndefined();
    expect(selectLabelsFor("company_name")).toBeUndefined();
  });

  it("submits a real boolean for a checkbox widget, not the stringified 'true'/'false' the old page sent", () => {
    expect(coerceForSubmit("checkbox", true)).toBe(true);
    expect(coerceForSubmit("checkbox", false)).toBe(false);
  });

  it("submits a real number for a number widget", () => {
    expect(coerceForSubmit("number", "2000")).toBe(2000);
  });

  it("submits the raw string, unchanged, for select/textarea/text widgets", () => {
    expect(coerceForSubmit("select", "SHIPMENT")).toBe("SHIPMENT");
    expect(coerceForSubmit("textarea", "Custom statement text")).toBe("Custom statement text");
    expect(coerceForSubmit("text", "Acme Heat Treating")).toBe("Acme Heat Treating");
  });
});
