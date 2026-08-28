import { describe, it, expect } from "vitest";
import { adoptServerName } from "@/app/processes/templates/[id]/page";

/**
 * Issue #219 — the process-template name box rendered EMPTY on an existing template.
 *
 * Driven directly rather than through a DOM, the way `printControlTitle`
 * (tests/statements-screen.test.ts) is: this repo has no DOM test environment
 * (`vitest.config.ts` sets `environment: "node"`) and the established answer is to split the
 * DECISION out of the component rather than add one.
 *
 * The defect was a TIMING bug the caller owns — the updater read `lastServerName.current` live,
 * and the ref is written synchronously after dispatch, so by the time React ran the updater
 * during the render pass the "previous" name WAS the incoming one. These cases pin the rule the
 * caller must feed a dispatch-time capture into; the mount case is the one that shipped broken,
 * and it is the reason a live read cannot be reintroduced without reddening this file.
 */
describe("adoptServerName (#219)", () => {
  it("adopts the server name on the first load — the case that shipped blank", () => {
    // Live-ref reading produced exactly this call with prevServerName ALREADY "Carburize",
    // which fell through to the empty draft. Fed the dispatch-time null, it adopts.
    expect(adoptServerName({ prevServerName: null, currentDraft: "", serverName: "Carburize" }))
      .toBe("Carburize");
  });

  it("adopts a renamed-elsewhere name when the draft is untouched since the last load", () => {
    expect(adoptServerName({ prevServerName: "Old", currentDraft: "Old", serverName: "New" }))
      .toBe("New");
  });

  it("keeps an unsaved rename when an unrelated action reloads (Codex PR #22)", () => {
    // Focus-INDEPENDENT: every step action reloads after focus has left the box, which is why
    // use-edit-guard's applyPayload (focused-field only) is NOT the right tool here.
    expect(adoptServerName({ prevServerName: "Old", currentDraft: "My rename", serverName: "Old" }))
      .toBe("My rename");
  });

  it("keeps an unsaved rename even when the server name also moved", () => {
    expect(adoptServerName({ prevServerName: "Old", currentDraft: "Mine", serverName: "Theirs" }))
      .toBe("Mine");
  });

  it("treats a deliberately emptied box as an unsaved edit, not an untouched draft", () => {
    // "" is only adopted-over on the FIRST load (prevServerName null); after that it is a real
    // edit the user made, and the Save button's own min(1) refusal is what answers it.
    expect(adoptServerName({ prevServerName: "Old", currentDraft: "", serverName: "Old" }))
      .toBe("");
  });
});
