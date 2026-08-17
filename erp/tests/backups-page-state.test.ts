import { describe, it, expect } from "vitest";
import { runControlState } from "@/app/admin/backups/page";

/**
 * Issue #123 — the practice copy rendered an ENABLED "Back up now".
 *
 * Phase 8C made the backup routes production-only, and that works: the page shows an honest refusal
 * and no red staleness bar appears. But the button still rendered enabled over it, and the folder
 * showed a `…` placeholder — a control that can never work, presented as available, which is the
 * §5.16 shape ("a control the user cannot use is disabled and says why").
 *
 * The owner's ruling kept the NAV entry and forbade teaching `nav.ts` about practice mode (§8 — the
 * flag is never read in a client component), so the fix lives entirely in what the page learns from
 * the server: any 403 on the view endpoint means this page's actions cannot work, whatever the
 * cause, and the server's own sentence becomes the tooltip.
 *
 * Driven directly rather than through a DOM, the way `advanceBannerState` is — this repo has no DOM
 * test environment and splits the decision out of the component instead of adding one.
 */

const PRACTICE = "Backups are managed on the production copy only — the practice database is not backed up.";
const NO_PERM = "You do not have permission for that";
const open = { disabled: false, title: undefined };

describe("runControlState — the Back up now gate (#123)", () => {
  it("is enabled with a grant, no refusal, and nothing running", () => {
    expect(runControlState(open, false, null, true)).toEqual({ disabled: false, title: undefined });
  });

  it("disables and explains on the practice copy, using the server's own sentence", () => {
    expect(runControlState(open, false, PRACTICE, true)).toEqual({ disabled: true, title: PRACTICE });
  });

  it("disables and explains on a permission refusal, through the SAME branch", () => {
    // One path for both causes: the page never asks WHICH 403 it got, only that it got one.
    expect(runControlState({ disabled: true, title: "Requires manage_backups" }, false, NO_PERM, true))
      .toEqual({ disabled: true, title: NO_PERM });
  });

  it("lets the refusal win the tooltip even when the permission gate is also closed", () => {
    // The refusal is the more specific fact AND the actionable one — "use the production copy"
    // beats a generic permission line for someone who does hold the grant on the other copy.
    const closed = { disabled: true, title: "Requires manage_backups" };
    expect(runControlState(closed, false, PRACTICE, true).title).toBe(PRACTICE);
  });

  it("keeps the pre-existing gate and in-flight behaviour when nothing has been refused", () => {
    expect(runControlState({ disabled: true, title: "Requires manage_backups" }, false, null, true))
      .toEqual({ disabled: true, title: "Requires manage_backups" });
    expect(runControlState(open, true, null, true)).toEqual({ disabled: true, title: undefined });
  });

  /**
   * Codex, PR #131 — closed while the VIEW is unresolved.
   *
   * `/api/auth/me` and the view request are independent, and on the practice copy the view carries
   * an extra round trip (`assertNotPracticeDatabase`'s database-identity query), so permissions
   * routinely land first — leaving the gate open with both `view` and `refusal` still null. The
   * control flashed ENABLED in that window and would fire a POST refused by construction.
   */
  it("stays disabled while the view is still loading, even with a grant and no refusal yet", () => {
    expect(runControlState(open, false, null, false)).toEqual({ disabled: true, title: "Loading…" });
  });

  it("opens once the view resolves — the loading gate is a window, not a wall", () => {
    expect(runControlState(open, false, null, true).disabled).toBe(false);
  });

  // Bite-proof: the pre-fix behaviour was "enabled regardless of the refusal", so a helper that
  // ignored `refusal` would still pass every case above that does not involve one. This pins that
  // the refusal ALONE — with a wide-open gate and nothing running — is what closes the control.
  it("a refusal alone closes the control, which is the whole bug", () => {
    expect(runControlState(open, false, null, true).disabled).toBe(false);
    expect(runControlState(open, false, PRACTICE, true).disabled).toBe(true);
  });
});
