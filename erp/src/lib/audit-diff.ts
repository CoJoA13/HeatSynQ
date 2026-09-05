// Client-safe leaf (the permission-constants precedent — no src/server imports): HistoryPanel's
// pure diff logic, extracted so tests/audit-diff.test.ts can pin it without a DOM test env
// (#14 item 2's render half, the Group D extract-and-test pattern).

/**
 * The keys whose values differ between an audit entry's before/after snapshots — what
 * HistoryPanel renders as the entry's diff lines.
 *
 * Comparison is whole-key JSON.stringify, deliberately order-sensitive: snapshot CAPTURE orders
 * every list relation (tests/snapshot-order-sweep.test.ts, #24), so an order difference IS a
 * difference. `updatedAt` is excluded — it moves on every mutation and explains nothing.
 *
 * The raw-FK suppression (#14 item 2): when a `<x>Id` key changed AND its sibling relation key
 * (`<x>` — the same name minus `Id`) changed in the same entry, the raw key is dropped so the
 * diff reads once — `material: {…"Ductile iron"…}`, not that plus `materialId: "cmsb1z…"`. The
 * sibling must itself have CHANGED, not merely exist: frozen pre-include history carries only the
 * cuid (no sibling key on either side — accepted, snapshots are frozen, no backfill), and an
 * entry where only the raw key moved has no readable twin to defer to; both keep the raw key.
 */
export function changedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .filter((k) => k !== "updatedAt");
  const changedSet = new Set(changed);
  return changed.filter((k) => !(k.length > 2 && k.endsWith("Id") && changedSet.has(k.slice(0, -2))));
}

// ---------------------------------------------------------------------------
// The READABILITY half of a diff line.
//
// #170 stopped a SNAPSHOT_INCLUDE relation array from widening the whole page — `break-all` plus a
// capped, scrolling box in HistoryPanel — and its contract is explicit: the rendering is
// CONSTRAINED, never truncated, every byte still reachable. What it left alone was the CONTENT,
// which is minified JSON, so "what changed in process steps" reads as
// `[{"id":"cmtn80x450078sf9526xsy397","code":{…}}]` — contained, and still unreadable.
//
// So the panel now LEADS with a human line and keeps the bytes behind a disclosure. That preserves
// #170's contract exactly (nothing is dropped; it moves one click away) while making the common
// case — a status flip, a renamed relation — legible without opening anything.

/** How one changed field should read: a short human line, and whether the raw JSON is worth
 *  offering underneath it. Scalars are complete on their own line and set `expandable: false`. */
export type ValueSummary = { inline: string; expandable: boolean };

/** A value that says all it has to say inline — no disclosure earns its place under it. */
function isScalar(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== "object";
}

/** `JSON.stringify` renders an ABSENT key as `undefined`, which React then renders as nothing at
 *  all — so a key present on only one side used to read `name:  → "x"`, an invisible half. An em
 *  dash says "not there" in a way a reader can actually see. */
function scalarText(v: unknown): string {
  return v === undefined ? "—" : JSON.stringify(v);
}

/** `n items`, pluralized, with a word for zero — "0 items" reads like a count that failed. */
function itemCount(n: number): string {
  return n === 0 ? "empty" : `${n} item${n === 1 ? "" : "s"}`;
}

/** The human label an object carries for itself, if it carries one. The raw-FK suppression above
 *  exists precisely so a relation reads once and READABLY (`material: {…"Ductile iron"…}`); when
 *  the object names itself, leading with that name is the readable form of the same intent.
 *  `name` before `code` because a name is what a person recognizes; `code` is the fallback for
 *  the reference rows that carry no name. */
function labelBy(v: unknown, keys: readonly string[]): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    // NUMBERS count: `orderNumber` is an integer in this schema, and a document number is exactly
    // the identifier a reader recognizes. Restricting this to strings sent every numeric-keyed
    // relation to the field-count fallback.
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** `name` first because a name is what a person recognizes; `code` is the fallback for the
 *  reference rows that carry no name. */
const LABEL_KEYS = [
  "name", "displayName", "code", "orderNumber", "partNumber", "label", "title",
] as const;
/** Tried only when the preferred labels MATCH — a `code` is unique where a name is not, so it is
 *  what distinguishes two records the label alone cannot (Codex P2 on #272). Deliberately does NOT
 *  include `id`: a cuid tells a reader nothing, and surfacing one is the exact noise the raw-FK
 *  suppression above exists to remove. Where only the id differs, "contents changed" is the honest
 *  answer and the disclosure holds the detail. */
const DISAMBIGUATING_KEYS = ["code", "number"] as const;

function objectLabel(v: unknown): string | null {
  return labelBy(v, LABEL_KEYS);
}

/**
 * How a single changed field should read on one line.
 *
 * Scalars keep exactly the shape they have always had (`"OPEN" → "SHIPPED"`). Everything else is
 * summarized — an item count for arrays, a self-label or field count for objects — and flagged
 * `expandable` so the caller can offer `detailJson` underneath.
 *
 * The equal-length array case is called out deliberately: `5 items → 5 items` reads as "nothing
 * happened", which is the exact line that sends a reader into the raw JSON to find out what
 * actually moved.
 */
export function summarizeChange(before: unknown, after: unknown): ValueSummary {
  if (isScalar(before) && isScalar(after)) {
    return { inline: `${scalarText(before)} → ${scalarText(after)}`, expandable: false };
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return {
      inline: before.length === after.length
        ? `${itemCount(before.length)}, contents changed`
        : `${itemCount(before.length)} → ${itemCount(after.length)}`,
      expandable: true,
    };
  }
  const beforeLabel = objectLabel(before);
  const afterLabel = objectLabel(after);
  if (beforeLabel !== null || afterLabel !== null) {
    // An ABSENT or NULL side keeps `scalarText`'s word for it. The ellipsis means "present, but
    // carries no label I recognize" — a different fact, and reading `… → "Ductile iron"` for a
    // relation that was previously null hides the only thing that line had to say (Codex P2 on
    // #272: changedFields suppresses the sibling `materialId`, so this summary IS the story).
    const side = (v: unknown, label: string | null) =>
      label !== null ? JSON.stringify(label) : v === undefined || v === null ? scalarText(v) : "…";
    // EQUAL LABELS ARE NOT NO-OPS. `changedFields` only reaches here because the value genuinely
    // differs, and it has already suppressed the raw FK in favour of this readable relation — so
    // rendering `"Heat Treat" → "Heat Treat"` would report "nothing happened" while hiding the one
    // value that distinguishes the two records (step-code names are not unique and the FK is
    // editable). Try a unique field first; failing that, say the contents moved, exactly as the
    // equal-length array case above does.
    if (beforeLabel !== null && beforeLabel === afterLabel) {
      const beforeId = labelBy(before, DISAMBIGUATING_KEYS);
      const afterId = labelBy(after, DISAMBIGUATING_KEYS);
      if (beforeId !== null && afterId !== null && beforeId !== afterId) {
        return { inline: `${JSON.stringify(beforeId)} → ${JSON.stringify(afterId)}`, expandable: true };
      }
      return { inline: `${JSON.stringify(beforeLabel)}, contents changed`, expandable: true };
    }
    return { inline: `${side(before, beforeLabel)} → ${side(after, afterLabel)}`, expandable: true };
  }
  const fieldWord = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
  const fieldCount = (v: unknown) => {
    if (v === undefined) return "—";
    if (v === null) return "null";
    if (Array.isArray(v)) return itemCount(v.length);
    return fieldWord(Object.keys(v as Record<string, unknown>).length);
  };
  // EQUAL COUNTS ARE NOT NO-OPS, for the same reason equal array lengths and equal labels are not:
  // `changedFields` only reaches here because the value DIFFERS. `1 field → 1 field` reads as
  // nothing having happened, and that is precisely the case an unrecognized identifier lands in —
  // so this is the safety net UNDER `LABEL_KEYS` rather than a substitute for enumerating them
  // (Codex P2 on #272 found `quotedBy: { displayName }` this way).
  if (
    before !== null && after !== null && typeof before === "object" && typeof after === "object"
    && !Array.isArray(before) && !Array.isArray(after)
  ) {
    const n = Object.keys(before as Record<string, unknown>).length;
    if (n === Object.keys(after as Record<string, unknown>).length) {
      return { inline: `${fieldWord(n)}, contents changed`, expandable: true };
    }
  }
  return { inline: `${fieldCount(before)} → ${fieldCount(after)}`, expandable: true };
}

/** The full before/after for the disclosure — INDENTED, which is the whole point: the minified
 *  form is what made the raw value unreadable in the first place. Every byte of both snapshots is
 *  here, which is what keeps #170's "constrains, does not truncate" true. */
export function detailJson(before: unknown, after: unknown): string {
  const side = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v, null, 2));
  return `before: ${side(before)}\n\nafter: ${side(after)}`;
}
