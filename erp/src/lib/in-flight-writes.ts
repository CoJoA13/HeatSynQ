// How many WRITES this browser tab currently has in flight, as a client-safe leaf with no DOM and
// no fetch of its own (the unsaved-guard.ts / use-latest.ts precedent, so it is unit-testable under
// vitest's `environment: "node"`).
//
// WHY THIS EXISTS (#276). The unsaved-edit guard's prompt was untruthful while a request was open.
// A section's dirty flag means "differs from the server as loaded" — the deliberate definition — so
// it is cleared by `grid.reset()` only AFTER the response lands, which put every save inside a
// window where the section was registered dirty and the write was already committing. Click a nav
// link there and the guard asked "Leave the page and discard them?" over changes that were being
// written either way. Nothing on the client can un-send an accepted request, and aborting would not
// help: `submitWithConflictRetry` sends a `clientRequestId` precisely so a retry lands as the SAME
// write rather than a second one.
//
// #276 proposed a blocking mode instead — refuse the navigation while a save is pending. That was
// not taken (owner ruling, 2026-09-06). `api()` sets no timeout and no abort signal, so a stalled
// request would refuse every nav click, the search and sign-out with no control anywhere to clear
// it, and **a guard the operator cannot clear is worse than no guard**. Telling the truth costs
// nothing and strands nobody: the prompt now says the request will finish regardless, and the
// operator still decides.
//
// COUNTED CENTRALLY, NOT REGISTERED PER SAVE. The alternative was a `useSavePending` hook wired into
// each editor, which is a hand census of the save entry points across fourteen files — the shape
// this repo keeps refiling as a defect (#272's "structural guarantee" that bound only the editors
// using `SaveButton`). A counter incremented by the ONE request helper covers every write that
// exists and every one written later, with nothing to keep in step.
// `tests/unsaved-registration-sweep.test.ts` holds the line that a client write cannot get out of
// `fetcher.ts` untracked.
//
// **THE COUNT IS UNATTRIBUTED, AND THE PROMPT'S WORDING DEPENDS ON THAT.** It answers "is a request
// open", never "is THIS section saving" — there is no link between a write and the dirty sections
// `unsavedLabels()` names. That is why `confirmMessage` had to be written to say BOTH things at
// once: the open request finishes regardless, AND anything not yet saved is discarded. A first draft
// said only the former, which on the order hub — save Containers, leave while Charges is still
// dirty — told the operator that Charges would survive. It would not. Trading a false "this will be
// discarded" (which keeps people on the page) for a false "this will be saved" (which invites them
// off it) is a worse bug than the one being fixed, so do not narrow that sentence without first
// giving the counter a section to belong to.

// WHAT THIS DOES NOT CLOSE, measured rather than assumed. The count is released when the response
// HEADERS arrive — when the server has taken the write. Most editors clear their dirty flag from
// that same response (`grid.reset()` right after the `await`), so the two windows meet. TWO do not:
// `parts/[id]/CustomFieldsSection.tsx` and `processes/templates/[id]/page.tsx` both re-read with a
// follow-up GET and only clear dirty when THAT lands, so each leaves a full extra round trip in
// which the section reads dirty, no write is in flight, and the prompt reverts to the discard
// wording over a write that has already committed. Closing it means clearing the baseline from the
// write's own response — the shape every order-hub and shipment grid already uses — not widening
// this counter, which would have to become per-save to know when a section is finished.

let inFlight = 0;

/**
 * Record that a write has started; call the returned function when it settles.
 *
 * The ender is IDEMPOTENT. `trackedFetch` releases in a `finally` and is the only caller today, so
 * this is defence in depth rather than a live requirement — but it is cheap, and the failure it
 * prevents is silent: a double release drives the count negative, which reads as "nothing in flight"
 * while a write still is, i.e. the guard failing OPEN in exactly the direction this file exists to
 * close. Clamping at zero would hide a double release instead of tolerating it — with two concurrent
 * writes, one double-ended, the count would still under-report.
 */
export function beginWrite(): () => void {
  inFlight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inFlight -= 1;
  };
}

/**
 * How many writes are in flight.
 *
 * A NUMBER rather than a boolean because writes overlap: on the order hub two grids are routinely
 * saved in quick succession, and a boolean would let the first response report "nothing in flight"
 * while the second was still committing — putting the untruthful wording back for the one that
 * matters. (It is NOT about snapshot stability; nothing subscribes to this, and a boolean would be
 * just as stable a snapshot as a number.)
 */
export function writesInFlight(): number {
  return inFlight;
}

/** The HTTP methods that change server state. Compared case-insensitively because `RequestInit`
 *  takes the method as a free string and the fetch spec normalises these four; a caller writing
 *  `"post"` must not slip past the counter. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether an init object describes a write.
 *
 * A MISSING method is a GET and is not counted — that is the fetch default, not a guess.
 *
 * This asks about the METHOD, not about what the route does with it. One route in this app answers a
 * POST without writing anything (`/api/templates/[id]/preview`, whose own docstring says so), and it
 * is still counted: the alternative is a per-route allowlist of "POSTs that are really reads", which
 * is a hand census, and the prompt's wording says "a request", not "a save", precisely so that
 * counting it stays true.
 */
export function isWriteMethod(method: string | undefined): boolean {
  return method !== undefined && WRITE_METHODS.has(method.toUpperCase());
}
