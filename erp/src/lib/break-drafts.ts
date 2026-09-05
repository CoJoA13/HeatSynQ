// Shared by QuoteDetail (src/app/quotes/[id]/) — in src/lib, not next to the component, because a
// client component may not import from src/server/** and this needs to be reachable from tests,
// which run under vitest's "node" environment with no DOM. The step-drafts.ts / field-drafts.ts
// precedent.
//
// WHY THIS EXISTS. A quantity break is typed into a per-price-row "Add break" pair and does not
// reach the quote's `lines` tree until Add break is clicked, so #272 registered a started-but-
// unadded draft with the unsaved-edit guard (`useUnsavedSection`) to stop a navigation discarding
// it silently. The registration scans every RETAINED draft, and nothing pruned the record — so a
// draft whose price row was then removed kept the page registered unsaved with no control able to
// clear it (#278). That is the ProcessStepsSection.dropDrafts shape exactly: an overlay orphaned by
// a deliberate removal, where the fail-closed arm would otherwise report dirty forever.
//
// The pruning DECISIONS live here rather than inline in the component because vitest has no
// component renderer, so an assertion about them can only be mutation-proven from a pure module
// (the precedent's own pruner has no unit test at all). The setState calls stay in the component:
// this file answers questions about values, it holds nothing.
//
// The two pruners answer DIFFERENT questions and are not interchangeable. `dropBreakDrafts` is for
// a caller that knows what it just destroyed (remove this price row, remove this line, discard
// everything); `retainBreakDrafts` is for a caller that replaced the whole tree and can only say
// what SURVIVED. Nothing derivable from the tree alone distinguishes "this price row was deleted"
// from "this price row has not loaded yet", which is why each caller has to declare its own case —
// the argument ProcessStepsSection.dropDrafts makes for the same split.

/** One un-added quantity break as the Add-break inputs hold it. Both fields are free text: they
 *  become numbers only when Add break folds them into the price row's `breaks` array. */
export type BreakDraft = { threshold: string; price: string };

/** Every un-added break draft on the page, keyed by the PRICE ROW key it belongs to — the price's
 *  server id for a loaded row, a minted `new-N` for one added client-side. */
export type BreakDrafts = Readonly<Record<string, BreakDraft>>;

/** The blank draft an untouched price row reads as. Exported so the component's lookup fallback
 *  and this module's own writes cannot drift into two different notions of "empty". */
export const EMPTY_BREAK_DRAFT: BreakDraft = { threshold: "", price: "" };

/**
 * Whether any retained draft holds work a navigation would discard.
 *
 * Content, not key count. A blank entry is a normal resting state — typing into an Add-break input
 * and then clearing it leaves one behind, and nothing collects them — so only a non-blank draft is
 * work. A predicate written as "are there any entries" would report the page unsaved for every
 * price row whose inputs had ever been touched.
 */
export function breakDraftStarted(drafts: BreakDrafts): boolean {
  return Object.values(drafts).some((d) => d.threshold.trim() !== "" || d.price.trim() !== "");
}

/**
 * Drop the drafts for price rows the caller just DESTROYED — a removed operation, a removed line
 * (pass every price key on it), or `"all"` for an explicit discard.
 *
 * Returns the SAME object when nothing matches, so a call that drops nothing is a React state
 * bailout rather than a re-render (the ProcessStepsSection.dropDrafts / LinesSection idiom).
 */
export function dropBreakDrafts(cur: BreakDrafts, priceKeys: readonly string[] | "all"): BreakDrafts {
  if (priceKeys === "all") return Object.keys(cur).length === 0 ? cur : {};
  if (!priceKeys.some((k) => Object.hasOwn(cur, k))) return cur;
  const next: Record<string, BreakDraft> = { ...cur };
  for (const k of priceKeys) delete next[k];
  return next;
}

/**
 * Keep only the drafts whose price row still exists, for a caller that replaced the whole tree and
 * therefore cannot name what it destroyed.
 *
 * An INTERSECTION, never a reset, and that direction is load-bearing. Adopting a fresh detail is
 * how close, reopen and attach-part land, and none of those changes a single price id — while all
 * three stay enabled with a draft typed, because the page's `dirty` deliberately excludes break
 * drafts. Clearing wholesale there would destroy real typed work that exists nowhere else: a draft
 * is never part of a save payload, so nothing would have kept a copy.
 *
 * What it does drop is a draft whose key the server retired under the caller's feet — a row added
 * client-side and promoted from `new-N` to a real id, a row re-minted because its step code
 * changed, or one soft-deleted by the save's own array-replace. That text is already off screen by
 * then (the row re-renders under its new key, showing blank inputs), so this is not preserving it;
 * it is releasing the guard that was holding the page for work no control could reach. Returns the
 * SAME object when every draft is still live, for the bailout reason above.
 */
export function retainBreakDrafts(cur: BreakDrafts, liveKeys: Iterable<string>): BreakDrafts {
  const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys);
  const doomed = Object.keys(cur).filter((k) => !live.has(k));
  if (doomed.length === 0) return cur;
  const next: Record<string, BreakDraft> = { ...cur };
  for (const k of doomed) delete next[k];
  return next;
}

/** Every price-row key in a quote's line tree — the live set `retainBreakDrafts` intersects
 *  against. Typed structurally rather than against `LineForm` so this leaf keeps no dependency on
 *  the quote form module that imports it. */
export function priceKeysOf(
  lines: readonly { readonly prices: readonly { readonly key: string }[] }[],
): string[] {
  return lines.flatMap((l) => l.prices.map((p) => p.key));
}

/**
 * One keystroke into an Add-break input.
 *
 * Here rather than inline in the onChange because the inline version merged into the draft read
 * from the RENDER closure instead of the one the updater is handed — latent rather than live,
 * since each keystroke is its own event with a re-render between, but two writes batched into a
 * single tick would have dropped one of the pair. Taking `cur` as an argument makes that
 * unrepresentable.
 */
export function patchBreakDraft(
  cur: BreakDrafts, priceKey: string, field: keyof BreakDraft, value: string,
): BreakDrafts {
  const draft = cur[priceKey] ?? EMPTY_BREAK_DRAFT;
  return { ...cur, [priceKey]: { ...draft, [field]: value } };
}
