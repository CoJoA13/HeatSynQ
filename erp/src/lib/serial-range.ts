// Client-safe (no src/server imports): expands a serial-range shorthand like "EC{001-025}" into
// the 25 discrete serial strings it stands for, so order entry can key one range instead of
// pasting every serial by hand (spec §12.6). Order-line validation (a later task) calls this and
// wraps any thrown Error in HttpError(400, …) at the service boundary — this module only ever
// throws a plain Error, with a message already fit to show the user.

// Exactly one `{...}` group, optionally wrapped in a prefix/suffix. The `[^{}]*` prefix/suffix
// groups are what makes this reject nested ("EC{{001-025}}") and multiple ("A{01-02}B{03-04}")
// brace groups: neither can be matched by "zero or more non-brace characters" on either side of
// the single literal `{...}`, so the whole anchored pattern simply fails to match.
const RANGE = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/;
const BOUNDS = /^(\d+)-(\d+)$/;
const MAX_EXPANSION = 10_000;

/**
 * Expands one serial-entry field's text into the list of serials it names.
 *
 * - No `{...}` group: the trimmed input is the one serial.
 * - One `{start-end}` group: every integer from `start` to `end` inclusive, zero-padded to the
 *   width of the FIRST bound as written — "EC{001-25}" pads like "EC{001-025}" (Visual Shop's
 *   convention: the end bound borrows the start's width, not its own).
 * - A prefix and/or suffix around the group carries through to every row unchanged
 *   ("{01-04}-B" → "01-B", "02-B", "03-B", "04-B").
 *
 * Throws a plain `Error` — never `HttpError`; this module has no server import — for anything
 * that isn't one of the above: more than one brace group (including a nested one), a group whose
 * bounds aren't plain digit strings, a start after its end, or an expansion bigger than 10,000
 * rows.
 */
export function expandSerialRange(input: string): string[] {
  const trimmed = input.trim();

  if (!trimmed.includes("{") && !trimmed.includes("}")) {
    return [trimmed];
  }

  const match = RANGE.exec(trimmed);
  if (!match) {
    throw new Error(`"${trimmed}" is not a valid serial range — expected exactly one {start-end} group`);
  }

  const [, prefix, body, suffix] = match;
  const bounds = BOUNDS.exec(body);
  if (!bounds) {
    throw new Error(`"${trimmed}" is not a valid serial range — bounds must be numbers, e.g. "{001-025}"`);
  }

  const [, startStr, endStr] = bounds;
  const start = Number(startStr);
  const end = Number(endStr);
  // Checked BEFORE any arithmetic on `start`/`end` — a bound past Number.MAX_SAFE_INTEGER (e.g.
  // "{99999999999999999999-100000000000000000025}") loses precision in the `Number(...)` above,
  // so both bounds can round to the SAME float, `count` computes to 1, and the loop below's
  // `n <= end` stays true forever because `n++` is a no-op at that magnitude (adding 1 to a
  // float this large doesn't change its value) — not a slow expansion, an unbounded loop that
  // only stops when the `rows` array hits the engine's own max-length limit. Relying on the
  // MAX_EXPANSION check further down to catch this is not enough: it only works when the
  // (already-imprecise) `count` happens to come out huge, which is exactly what this same
  // precision loss can quietly avoid, as the case above demonstrates.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new Error(`"${trimmed}" is not a valid serial range — bounds must be safe integers (≤ ${Number.MAX_SAFE_INTEGER})`);
  }
  if (start > end) {
    throw new Error(`"${trimmed}" is not a valid serial range — start (${startStr}) is after end (${endStr})`);
  }

  const count = end - start + 1;
  if (count > MAX_EXPANSION) {
    throw new Error(`"${trimmed}" would expand to ${count} serials — the maximum is 10,000`);
  }

  const width = startStr.length; // padding = width of the FIRST bound, VS rule
  const rows: string[] = [];
  for (let n = start; n <= end; n++) {
    rows.push(`${prefix}${String(n).padStart(width, "0")}${suffix}`);
  }
  return rows;
}
