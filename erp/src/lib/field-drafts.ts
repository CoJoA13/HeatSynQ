// Shared by CustomFieldsSection (src/app/parts/[id]/) — in src/lib, not next to the component,
// because a client component may not import from src/server/** and this needs to be reachable
// from tests, which run under vitest's "node" environment with no DOM. The step-drafts.ts
// precedent, adapted to that editor's snapshot-diff shape (#148): where ProcessStepsSection keeps
// a separate overlay of touched fields, CustomFieldsSection holds ONE `rows` array that is both
// the server copy and the draft, diffed against an `original` map on Save.

/** The slice of a custom-field row this merge reads: the identity and the draft value. The
 *  component's full row (name/type/sort/active) rides through untouched — only `value` is ever
 *  the user's. */
export type MergeableFieldRow = { fieldId: string; value: string };

/**
 * The rows the editor should show after a save's follow-up fetch.
 *
 * The inputs stay editable during the PUT by design (the ProcessStepsSection editsAfterSave
 * rule: anything typed after the request left must survive its success handler), so the fetch
 * result cannot simply replace the array — that wiped whatever was typed into another field
 * during the round trip. Instead, per server row: a field whose draft value MOVED between the
 * save leaving (`atSave`) and its success (`current`) was typed during the flight and keeps the
 * draft value; every other field takes the server's. A field typed away and back to its at-save
 * value is no longer the user's — the server's copy shows through, same as editsAfterSave
 * dropping a submitted-and-unchanged entry.
 *
 * The row LIST is always the server's: rows it added since the save appear with server values
 * (they cannot have been typed into), rows it dropped disappear (there is no input left to hold
 * a draft), and non-value metadata (name/active/sort/type) comes from the fresh row even where
 * the draft value is kept. The caller resets `original` from the same server data — an in-flight
 * edit kept here then correctly reads as still-dirty against it.
 */
export function rowsAfterSave<Row extends MergeableFieldRow>(
  server: readonly Row[],
  atSave: readonly MergeableFieldRow[],
  current: readonly MergeableFieldRow[],
): Row[] {
  const atSaveValues = new Map(atSave.map((r) => [r.fieldId, r.value]));
  const currentValues = new Map(current.map((r) => [r.fieldId, r.value]));
  return server.map((r) => {
    const before = atSaveValues.get(r.fieldId);
    const now = currentValues.get(r.fieldId);
    const typedInFlight = before !== undefined && now !== undefined && now !== before;
    return typedInFlight ? { ...r, value: now } : r;
  });
}
