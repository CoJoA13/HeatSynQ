import { describe, it, expect } from "vitest";
import { visibleNav, visibleAdmin, NAV, ADMIN } from "@/lib/nav";

// The Shell's nav-gating logic, pulled into a pure client-safe module so the permission-set →
// visible-entries decision is unit-testable without rendering React (the permission-ui.ts
// precedent). This pins THE NAV DECISION for Task 16 (Option B, spec §5.5 "under the existing
// admin area UI"): Templates lives under the Admin group but is gated on `templates.view`
// SPECIFICALLY, and the Admin group header shows whenever ANY admin-group entry is visible
// (admin.view OR templates.view) — so a templates.view-only user (no admin.view) still reaches
// /admin/templates (the silent-dead-end rule), and an admin.view-only user without templates does
// NOT see the Templates entry (it is a different area).

describe("nav gating", () => {
  it("a templates.view-only user sees ONLY Templates under the Admin group (reaches it without admin.view)", () => {
    expect(visibleAdmin(["templates.view"]).map((e) => e.label)).toEqual(["Templates"]);
  });

  it("an admin.view-only user sees the admin entries but NOT Templates (different area)", () => {
    const labels = visibleAdmin(["admin.view"]).map((e) => e.label);
    expect(labels).toContain("Users");
    expect(labels).toContain("Audit log");
    expect(labels).not.toContain("Templates");
  });

  it("neither admin.view nor templates.view → the Admin group is empty, so the header hides", () => {
    expect(visibleAdmin(["orders.view"])).toEqual([]);
    expect(visibleAdmin([])).toEqual([]);
    expect(visibleAdmin(undefined)).toEqual([]);
  });

  it("both permissions → Templates joins the rest of the admin entries", () => {
    const labels = visibleAdmin(["admin.view", "templates.view"]).map((e) => e.label);
    expect(labels).toContain("Users");
    expect(labels).toContain("Templates");
  });

  it("Templates is an admin-group entry, NOT a top-level nav entry (the nav decision)", () => {
    expect(NAV.map((e) => e.label)).not.toContain("Templates");
    expect(ADMIN.map((e) => e.label)).toContain("Templates");
    // A templates.view-only user therefore has no top-level entry — the Admin group is the path.
    expect(visibleNav(["templates.view"])).toEqual([]);
  });

  it("top-level nav filters each entry on its own area", () => {
    expect(visibleNav(["orders.view"]).map((e) => e.label)).toEqual(["Orders"]);
    expect(visibleNav(["parts.view", "processes.view"]).map((e) => e.label)).toEqual(["Parts", "Processes"]);
    expect(visibleNav(undefined)).toEqual([]);
  });

  it("the Templates admin entry points at /admin/templates and is gated on the templates area", () => {
    const templates = ADMIN.find((e) => e.label === "Templates");
    expect(templates).toEqual({ label: "Templates", href: "/admin/templates", area: "templates" });
  });

  // Phase 8C: Backups gates on the `manage_backups` special ACTION, not an area — the same
  // silent-dead-end concern the Templates entry above exists to avoid, but for an action instead
  // of an area.
  it("shows Backups to a manage_backups holder who has no admin.view", () => {
    const entries = visibleAdmin(["action.manage_backups"]);
    expect(entries.map((n) => n.href)).toEqual(["/admin/backups"]);
  });

  it("hides Backups from an admin.view user without manage_backups", () => {
    const hrefs = visibleAdmin(["admin.view"]).map((n) => n.href);
    expect(hrefs).not.toContain("/admin/backups");
    expect(hrefs).toContain("/admin/users"); // the rest of the group is unaffected
  });

  it("hides Backups while permissions are still loading", () => {
    expect(visibleAdmin(undefined).map((n) => n.href)).not.toContain("/admin/backups");
  });

  // The Setup entry closes a genuine silent dead-end rather than adding a convenience link.
  // SetupBanner renders the checklist only while `!complete && !dismissed`, and the dismissal is
  // PERMANENT (SetupState.checklistDismissedAt) — so before this entry existed, an admin who
  // dismissed the checklist with setup still incomplete could reach /setup only by typing the URL.
  // That is the same §5.15 rule the Templates and Backups entries above are shaped by, so it is
  // pinned the same way. Gated on the `admin` AREA because that is what the page's own APIs
  // enforce: /api/setup/readiness does mustCan(..., "admin", "view") and /api/setup/state does
  // mustCan(..., "admin", "edit") — the nav must not advertise a page the caller would be 403ed by.
  it("the Setup admin entry points at /setup and is gated on the admin area", () => {
    const setup = ADMIN.find((e) => e.label === "Setup");
    expect(setup).toEqual({ label: "Setup", href: "/setup", area: "admin" });
  });

  it("shows Setup to an admin.view user — /setup is reachable once the checklist is dismissed", () => {
    expect(visibleAdmin(["admin.view"]).map((n) => n.href)).toContain("/setup");
  });

  it("hides Setup from a non-admin, and while permissions are still loading", () => {
    // templates.view reaches the Admin group but must NOT reach /setup — a different area, the
    // same discrimination the Templates/Backups cases above assert in the other direction.
    expect(visibleAdmin(["templates.view"]).map((n) => n.href)).not.toContain("/setup");
    expect(visibleAdmin(["orders.view"]).map((n) => n.href)).not.toContain("/setup");
    expect(visibleAdmin(undefined).map((n) => n.href)).not.toContain("/setup");
  });

  it("Setup is an admin-group entry, NOT a top-level nav entry", () => {
    expect(NAV.map((e) => e.label)).not.toContain("Setup");
  });
});
