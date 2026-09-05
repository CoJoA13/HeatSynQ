import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  markUnsaved, clearUnsaved, unsavedLabels, subscribeUnsaved,
  shouldGuardNavigation, confirmMessage, unsavedCount, type NavIntent,
} from "@/lib/unsaved-guard";

// The pure half of the unsaved-edit guard. The registry is module-level state (the
// invalidateBackupBanner listener-Set idiom), so every test clears what it marks.
//
// WHY THIS EXISTS. The order hub runs TWO save models side by side and always has: PO number, VS
// order #, Customer job # and Notes save on BLUR (no button, no confirmation), while Containers,
// Serials, Charges and Loads each need an explicit "Save X" click. That split is deliberate — the
// blur-save/mutation-gate discipline is §5.13 and is not up for redesign here — but nothing on
// screen distinguished the two, and `beforeunload` appeared nowhere in src/, so an edited-but-
// unsaved grid was discarded silently the moment anyone clicked a nav link. Making the rail sticky
// (#270) put those links in reach at every scroll position, which makes the loss EASIER to trigger.

const KEY = "test-section";

beforeEach(() => {
  for (const label of unsavedLabels()) void label;
  clearUnsaved(KEY);
  clearUnsaved("other");
});

describe("the unsaved registry", () => {
  it("reports nothing when no section is dirty", () => {
    expect(unsavedLabels()).toEqual([]);
  });

  it("reports a marked section by its human label, not its key", () => {
    markUnsaved(KEY, "Containers");
    expect(unsavedLabels()).toEqual(["Containers"]);
  });

  it("clears a section, and clearing an unmarked key is a no-op rather than a throw", () => {
    markUnsaved(KEY, "Containers");
    clearUnsaved(KEY);
    expect(unsavedLabels()).toEqual([]);
    expect(() => clearUnsaved("never-marked")).not.toThrow();
  });

  it("keys the registry so one section going clean cannot clear another", () => {
    markUnsaved(KEY, "Containers");
    markUnsaved("other", "Loads");
    clearUnsaved(KEY);
    expect(unsavedLabels()).toEqual(["Loads"]);
  });

  it("de-duplicates and sorts labels, so two dirty grids read as a stable list", () => {
    markUnsaved(KEY, "Loads");
    markUnsaved("other", "Containers");
    expect(unsavedLabels()).toEqual(["Containers", "Loads"]);
  });

  it("re-marking the same key replaces its label rather than adding a second entry", () => {
    markUnsaved(KEY, "Containers");
    markUnsaved(KEY, "Containers (2 rows)");
    expect(unsavedLabels()).toEqual(["Containers (2 rows)"]);
  });

  it("notifies subscribers on mark and on clear, and stops after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribeUnsaved(seen);
    markUnsaved(KEY, "Containers");
    expect(seen).toHaveBeenCalledTimes(1);
    clearUnsaved(KEY);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    markUnsaved(KEY, "Containers");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("does not notify when a clear changed nothing — a no-op must not wake the UI", () => {
    const seen = vi.fn();
    const off = subscribeUnsaved(seen);
    clearUnsaved("never-marked");
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

// The navigation predicate. It must fire ONLY for a click that genuinely replaces what is on
// screen — guarding a click that was never going to navigate trains people to dismiss the prompt,
// which is how a guard stops being read at all.
function intent(over: Partial<NavIntent> = {}): NavIntent {
  return {
    href: "/parts", sameOrigin: true, currentPath: "/orders/abc",
    modifierKey: false, newTab: false, download: false, defaultPrevented: false,
    ...over,
  };
}

describe("shouldGuardNavigation", () => {
  it("guards an ordinary in-app link click", () => {
    expect(shouldGuardNavigation(intent())).toBe(true);
  });

  it("ignores a click that was not on a link at all", () => {
    expect(shouldGuardNavigation(intent({ href: null }))).toBe(false);
  });

  it("ignores a cross-origin link — it leaves the app, and beforeunload covers that", () => {
    expect(shouldGuardNavigation(intent({ sameOrigin: false, href: "https://example.com" }))).toBe(false);
  });

  it("ignores a modified click and an explicit new tab — this page is not going anywhere", () => {
    expect(shouldGuardNavigation(intent({ modifierKey: true }))).toBe(false);
    expect(shouldGuardNavigation(intent({ newTab: true }))).toBe(false);
  });

  it("ignores a download link — it triggers a file, not a navigation", () => {
    // The documents/exports surfaces hang real downloads off anchors; prompting there would fire
    // on printing a traveler while a grid happened to be dirty.
    expect(shouldGuardNavigation(intent({ download: true }))).toBe(false);
  });

  it("ignores a click something else already handled", () => {
    expect(shouldGuardNavigation(intent({ defaultPrevented: true }))).toBe(false);
  });

  it("ignores a same-page hash link — an in-page jump loses nothing", () => {
    expect(shouldGuardNavigation(intent({ href: "#lines" }))).toBe(false);
    expect(shouldGuardNavigation(intent({ href: "/orders/abc#lines", currentPath: "/orders/abc" }))).toBe(false);
  });

  it("still guards a hash link that points at a DIFFERENT page", () => {
    expect(shouldGuardNavigation(intent({ href: "/parts#pricing", currentPath: "/orders/abc" }))).toBe(true);
  });

  it("ignores an /api/ link — an export or document, not a page this app navigates to", () => {
    // Codex P2 on #272: BlockerPanel's "Export list to Excel" and the document links elsewhere are
    // plain anchors whose route answers Content-Disposition or opens a viewer. The page STAYS, so
    // prompting there is a false positive — and a prompt that fires when nothing is at stake is the
    // one people learn to dismiss, which costs the prompts that matter.
    expect(shouldGuardNavigation(intent({ href: "/api/orders/export?x=1" }))).toBe(false);
    expect(shouldGuardNavigation(intent({ href: "/api/documents/abc" }))).toBe(false);
  });

  it("still guards a page whose path merely BEGINS like the api prefix", () => {
    // `/apixyz` is a page, not the API. Fails closed rather than on a loose prefix match.
    expect(shouldGuardNavigation(intent({ href: "/apiary" }))).toBe(true);
  });

  it("ignores a link to the page already open — re-entering it discards nothing", () => {
    expect(shouldGuardNavigation(intent({ href: "/orders/abc", currentPath: "/orders/abc" }))).toBe(false);
  });
});

describe("unsavedCount", () => {
  // A NUMBER, not the label array: this is the useSyncExternalStore snapshot behind the Shell's
  // reactive arming, and returning a fresh array each call would make the store see a new snapshot
  // on every render and loop.
  it("counts dirty sections and is referentially stable between reads", () => {
    expect(unsavedCount()).toBe(0);
    markUnsaved(KEY, "Containers");
    expect(unsavedCount()).toBe(1);
    expect(unsavedCount()).toBe(unsavedCount());
    markUnsaved("other", "Loads");
    expect(unsavedCount()).toBe(2);
    clearUnsaved(KEY);
    clearUnsaved("other");
    expect(unsavedCount()).toBe(0);
  });
});

describe("confirmMessage", () => {
  it("names the sections at risk, so the prompt says what is about to be lost", () => {
    // A bare "You have unsaved changes" is the prompt everyone clicks through. Naming the section
    // is the difference between a warning and a speed bump.
    expect(confirmMessage(["Containers"])).toContain("Containers");
    const two = confirmMessage(["Containers", "Loads"]);
    expect(two).toContain("Containers");
    expect(two).toContain("Loads");
  });

  it("reads as a sentence for one section and for several", () => {
    expect(confirmMessage(["Containers"])).toBe(
      "Containers has unsaved changes. Leave the page and discard them?",
    );
    expect(confirmMessage(["Containers", "Loads"])).toBe(
      "Containers and Loads have unsaved changes. Leave the page and discard them?",
    );
    expect(confirmMessage(["Charges", "Containers", "Loads"])).toBe(
      "Charges, Containers and Loads have unsaved changes. Leave the page and discard them?",
    );
  });
});
