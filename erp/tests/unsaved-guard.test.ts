import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  markUnsaved, clearUnsaved, unsavedLabels, subscribeUnsaved,
  shouldGuardNavigation, confirmMessage, unsavedCount, leavesCurrentPage,
  unsavedPresentExcluding, type NavIntent,
} from "@/lib/unsaved-guard";
import { confirmDiscard } from "@/lib/use-unsaved-section";
import { beginWrite } from "@/lib/in-flight-writes";

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

describe("unsavedPresentExcluding", () => {
  // The traveler print gate's read. `readTravelerData` builds the sheet from order lines,
  // containers and loads and never touches serials or charges, so a dirty Charges grid was
  // disabling a print it cannot affect (Codex P2 on #272).
  const IGNORED = ["Serials", "Charges"] as const;
  // Its own cleanup: the file-level `beforeEach` clears a hand-listed pair of keys, so these two
  // leaked into the next case and reported a dirty registry as clean-but-for-the-ignored. Scoped
  // here rather than by extending that list, which would just move the trap one test further on.
  beforeEach(() => { clearUnsaved("k1"); clearUnsaved("k2"); });

  it("ignores a section that cannot reach the document", () => {
    markUnsaved("k1", "Charges");
    expect(unsavedPresentExcluding(IGNORED)).toBe(false);
  });

  it("still reports a section that CAN", () => {
    markUnsaved("k1", "Charges");
    markUnsaved("k2", "Containers");
    expect(unsavedPresentExcluding(IGNORED)).toBe(true);
  });

  it("reports an UNRECOGNISED section — the list denies, it does not permit", () => {
    // The direction that matters. An allow list would fail OPEN the day a section is renamed or a
    // new grid is added: the gate would quietly stop covering it and paper would be filed over
    // unsaved work. Denying means the unknown blocks, and the cost of being wrong is a spurious
    // refusal somebody notices.
    markUnsaved("k1", "Some Grid Nobody Told The Gate About");
    expect(unsavedPresentExcluding(IGNORED)).toBe(true);
  });

  it("is false when nothing is dirty at all", () => {
    expect(unsavedPresentExcluding(IGNORED)).toBe(false);
  });
});

describe("leavesCurrentPage", () => {
  // Extracted from `shouldGuardNavigation` so Shell's PROGRAMMATIC navigations can ask the same
  // question. Shell's search called `confirmDiscard()` unconditionally, so searching for the order
  // already open prompted even though `router.push` to the same keyed page unmounts nothing and
  // discards nothing — a repeatable false warning on a routine lookup (Codex P2 on #272).
  it("is false for the page already open, so re-entering it prompts about nothing", () => {
    expect(leavesCurrentPage("/orders/abc", "/orders/abc")).toBe(false);
  });

  it("is true for a different page", () => {
    expect(leavesCurrentPage("/orders/def", "/orders/abc")).toBe(true);
  });

  it("is false for an empty path, which names no destination at all", () => {
    expect(leavesCurrentPage("", "/orders/abc")).toBe(false);
  });

  it("is the SAME rule the click guard applies, not a second copy of it", () => {
    // Mutation-proof: if `shouldGuardNavigation` stopped delegating, these two would drift and one
    // of the call sites would go back to prompting on the page it is already on.
    const here = "/orders/abc";
    for (const href of ["/orders/abc", "/orders/def", ""]) {
      expect(shouldGuardNavigation(intent({ href, currentPath: here })))
        .toBe(leavesCurrentPage(href, here));
    }
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

  it("stops offering to discard a save that is already committing (#276)", () => {
    // The window this closes is not rare and is not one page's bug: a section's dirty flag means
    // "differs from the server as loaded", so it stays set for the whole duration of its OWN save —
    // `grid.reset()` runs after the response lands. Every save on all fourteen registered editors
    // was therefore a window in which this prompt offered to discard changes that were being
    // written regardless, and no answer to it could have been honoured.
    const saving = confirmMessage(["Loads"], true);
    expect(saving).toBe(
      "Loads has unsaved changes, and a request is still running — leaving will not cancel it, "
      + "and you will not see the result. Anything not yet saved is discarded. Leave the page?",
    );
    // It must not keep the promise that could not be kept: the OLD sentence offered to discard the
    // very changes that were committing. The new one still says something is discarded — that is the
    // next test's subject, and the two claims are not the same sentence.
    expect(saving).not.toContain("discard them");
  });

  it("keeps the DISCARD warning while a request is running, because the count names no section", () => {
    // THE FINDING THAT NEARLY SHIPPED, and the reason this arm adds a fact rather than replacing
    // one. The counter is app-wide: it knows a request is open, never which section issued it. On
    // the order hub — click "Save containers", then a nav link while Charges is still dirty — both
    // labels appear, one is being written and the other is about to be thrown away. A sentence that
    // said only "it finishes either way" told the operator that Charges would survive, trading a
    // false "this will be discarded" (which keeps people on the page) for a false "this will be
    // saved" (which invites them off it). Strictly worse than the bug being fixed.
    const mixed = confirmMessage(["Charges", "Containers"], true);
    expect(mixed, "the open request finishes").toMatch(/will not cancel it/);
    expect(mixed, "AND unsaved work is still lost").toMatch(/not yet saved is discarded/);
    expect(mixed).toContain("Charges");
    expect(mixed).toContain("Containers");
  });

  it("says \"a request\", not \"a save\", because one counted POST writes nothing", () => {
    // `/api/templates/[id]/preview` answers a POST and its own route docstring says it writes
    // nothing. It is still counted — the alternative is a per-route allowlist of "POSTs that are
    // really reads", which is a hand census — so the noun has to be one that stays true either way.
    const saving = confirmMessage(["Template"], true);
    expect(saving).toContain("a request is still running");
    expect(saving, "calling a preview render a save would be a second small lie")
      .not.toContain("a save is still running");
  });

  it("defaults to the discard wording, so a caller that does not ask still gets the old sentence", () => {
    // The parameter is optional on purpose: `confirmMessage(labels)` is what every caller wrote
    // before #276, and a required argument would have made this a breaking change to a leaf for no
    // behavioural gain. Pinned so the default cannot silently flip to the in-flight wording, which
    // would put the alarming sentence in front of operators who are not saving anything.
    expect(confirmMessage(["Loads"])).toBe(confirmMessage(["Loads"], false));
    expect(confirmMessage(["Loads"])).toContain("discard");
  });
});

describe("confirmDiscard — the seam between the counter and the prompt", () => {
  // THE WIRE NOTHING ELSE COVERED. `confirmMessage` is a pure function and is exercised above; what
  // was untested is that anything ever asks it the in-flight question. A reviewer changed
  // `use-unsaved-section.ts`'s call to the one-argument form — deleting the whole of #276 — and the
  // suite, tsc and eslint were all green.
  //
  // No renderer is needed: `confirmDiscard` is a plain function, not a hook. `window` does not exist
  // under `environment: "node"`, so it is defined and removed here by plain property save/restore,
  // the repo's stubbing idiom (never `vi.spyOn` a shared object — `mockRestore` does not reliably
  // put the original back).
  const KEY = "seam";
  let asked: string[] = [];

  beforeEach(() => {
    asked = [];
    (globalThis as { window?: unknown }).window = {
      confirm: (message: string) => { asked.push(message); return true; },
    };
  });
  afterEach(() => {
    clearUnsaved(KEY);
    delete (globalThis as { window?: unknown }).window;
  });

  it("asks nothing at all when no section is dirty, however many requests are open", () => {
    const end = beginWrite();
    expect(confirmDiscard()).toBe(true);
    expect(asked, "a clean page must not be interrupted by someone else's request").toEqual([]);
    end();
  });

  it("uses the discard wording when nothing is in flight", () => {
    markUnsaved(KEY, "Loads");
    expect(confirmDiscard()).toBe(true);
    expect(asked).toEqual(["Loads has unsaved changes. Leave the page and discard them?"]);
  });

  it("switches to the in-flight wording while a request is open, and back when it settles", () => {
    markUnsaved(KEY, "Loads");
    const end = beginWrite();
    confirmDiscard();
    expect(asked[0]).toContain("a request is still running");
    expect(asked[0], "and it must still warn about what is NOT saved").toContain("is discarded");
    end();
    confirmDiscard();
    expect(asked[1], "the window closes with the request").toBe(
      "Loads has unsaved changes. Leave the page and discard them?",
    );
  });

  it("returns what the operator answered, both ways", () => {
    // The guard's callers act on this boolean — `e.preventDefault()` in the Shell's click guard, an
    // early return before a POST elsewhere. A prompt whose answer is ignored is not a guard.
    markUnsaved(KEY, "Loads");
    (globalThis as { window?: unknown }).window = { confirm: () => false };
    expect(confirmDiscard()).toBe(false);
    (globalThis as { window?: unknown }).window = { confirm: () => true };
    expect(confirmDiscard()).toBe(true);
  });
});
