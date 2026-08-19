import { describe, it, expect } from "vitest";
import { printControlTitle, type StatementPreview } from "@/app/receivables/statements/Statements";

/**
 * Issue #137, defects 1 and 2 — the Print gate on the statements screen.
 *
 * Driven directly rather than through a DOM, the way `runControlState`
 * (tests/backups-page-state.test.ts) is: this repo has no DOM test environment
 * (`vitest.config.ts` sets `environment: "node"`) and the established answer is to split the
 * DECISION out of the component rather than add one.
 *
 * Defect 1: `loadPreview`'s catch set `loaded` back to true without clearing `preview`, and the
 * title chain never looked at either the error or the preview — so a preview that FAILED for the
 * new customer/date/options re-displayed the PREVIOUS one with Print live. The operator reviewed
 * the old result and archived statements for the new inputs.
 *
 * Defect 2: `familyKnown` only became true when the customer-options fetch SUCCEEDED, and that
 * fetch needs `customers.view` — so a `receivables.view`-only user arriving on a bookmarked
 * `?customerId=` had printing disabled forever, making a statement permission depend on an
 * unrelated one. The tri-state keeps round 4's protection while the lookup can still answer
 * ("pending") and falls open when it never can ("unknown").
 */

const PREVIEW: StatementPreview = {
  asOf: "2026-08-08",
  customer: { code: "ACME", name: "Acme Heat Treat", billTo: ["Acme Heat Treat"] },
  openItems: [],
  aging: {
    customerId: "c1", customerCode: "ACME", customerName: "Acme Heat Treat",
    current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unapplied: 0, net: 0,
  },
  financeCharge: null,
  totalDue: 0,
};

/** The all-clear: every gate open, the family known, a matching preview on screen. */
const ready = {
  viewAllowed: true, viewTitle: undefined,
  customerId: "c1", familyLookup: "known" as const, loaded: true, preview: PREVIEW,
  perDivisionMode: false, runAllowed: true, runTitle: undefined, printing: false,
};

const PREVIEW_FAILED = "This customer's statement could not be loaded — try again before printing";

describe("printControlTitle — the Print gate (#137)", () => {
  it("enables Print when everything has landed", () => {
    expect(printControlTitle(ready)).toBeUndefined();
  });

  // (e) The two outermost branches still win first — a caller without receivables.view, and a
  // caller who has not picked anyone, are answered before anything about previews or families.
  it("still answers a missing permission and a missing customer FIRST", () => {
    expect(printControlTitle({ ...ready, viewAllowed: false, viewTitle: "Requires receivables.view" }))
      .toBe("Requires receivables.view");
    // Even with everything else broken, the permission line is the one that shows.
    expect(printControlTitle({
      ...ready, viewAllowed: false, viewTitle: "Requires receivables.view",
      customerId: "", familyLookup: "pending", loaded: false, preview: null,
    })).toBe("Requires receivables.view");
    expect(printControlTitle({ ...ready, customerId: "" })).toBe("Pick a customer first");
    // ...and it beats the family/preview branches too.
    expect(printControlTitle({ ...ready, customerId: "", familyLookup: "pending", preview: null }))
      .toBe("Pick a customer first");
  });

  // (c) The lookup can still answer — hold the control, exactly as round 4 did. Which print path
  // is correct depends on whether this customer has divisions, and only that list knows.
  it("holds Print while the family lookup is PENDING", () => {
    expect(printControlTitle({ ...ready, familyLookup: "pending" }))
      .toBe("Checking whether this customer has divisions…");
  });

  // (b) THE #137 DEFECT 2 FIX. The lookup can never answer (no `customers.view`, or it failed), so
  // holding the control forever makes a statement permission depend on an unrelated one. Since
  // #136 the SERVER refuses an un-combined print for a customer with live divisions, so the client
  // gate is belt-and-braces and can fall open: a permanent lockout becomes an occasional refusal.
  it("falls OPEN when the family lookup can never answer", () => {
    expect(printControlTitle({ ...ready, familyLookup: "unknown" })).toBeUndefined();
    // Specifically NOT the pending sentence — that was the lockout.
    expect(printControlTitle({ ...ready, familyLookup: "unknown" }))
      .not.toBe("Checking whether this customer has divisions…");
  });

  // Falling open is not falling through: an unknown family still waits for the preview.
  it("still waits for the preview when the family lookup is unknown", () => {
    expect(printControlTitle({ ...ready, familyLookup: "unknown", loaded: false, preview: null }))
      .toBe("Loading this customer's statement…");
  });

  it("holds Print while the preview for the current inputs is still in flight", () => {
    expect(printControlTitle({ ...ready, loaded: false })).toBe("Loading this customer's statement…");
  });

  // (a) THE #137 DEFECT 1 FIX. `loadPreview`'s catch now clears `preview` inside its own
  // `isCurrent` guard, so a settled-but-empty preview is exactly "the request for THESE inputs
  // failed". Gating on `preview === null` rather than on `error` is deliberate: `error` is a
  // SHARED bucket the customers-options catch also writes, so gating on it would re-disable Print
  // for precisely the `customers.view`-less user defect 2 opens up.
  it("disables Print when the preview FAILED, instead of printing over the stale one", () => {
    expect(printControlTitle({ ...ready, preview: null })).toBe(PREVIEW_FAILED);
  });

  it("keeps the failed preview disabled even when everything else is ready to print", () => {
    // The pre-fix behaviour: `loaded` back to true, the previous customer's tables still on
    // screen, Print live. Every one of these would have been ENABLED.
    expect(printControlTitle({ ...ready, preview: null, familyLookup: "unknown" })).toBe(PREVIEW_FAILED);
    expect(printControlTitle({ ...ready, preview: null, perDivisionMode: true })).toBe(PREVIEW_FAILED);
    expect(printControlTitle({ ...ready, preview: null, printing: true })).toBe(PREVIEW_FAILED);
  });

  // (d) Unchanged: per-division printing archives N documents, so it needs `receivables.create` —
  // the same grant its endpoint requires. A view-only user must not see an ENABLED button, confirm
  // a multi-document print, and get a 403 (§5.16).
  it("keeps the per-division run-gate precedence exactly as it was", () => {
    const runClosed = { runAllowed: false, runTitle: "Requires receivables.create" };
    expect(printControlTitle({ ...ready, perDivisionMode: true, ...runClosed }))
      .toBe("Requires receivables.create");
    // Only in per-division mode — the ordinary single print is gated on `view`, not `create`.
    expect(printControlTitle({ ...ready, perDivisionMode: false, ...runClosed })).toBeUndefined();
    // ...and it still beats the in-flight branch below it.
    expect(printControlTitle({ ...ready, perDivisionMode: true, ...runClosed, printing: true }))
      .toBe("Requires receivables.create");
  });

  it("reports an in-flight print last, as before", () => {
    expect(printControlTitle({ ...ready, printing: true })).toBe("Printing…");
  });
});
