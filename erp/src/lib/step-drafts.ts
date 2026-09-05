// Shared by ProcessStepsSection (src/app/parts/[id]/) — in src/lib, not next to the component,
// because a client component may not import from src/server/** and this needs to be reachable
// from tests, which run under vitest's "node" environment with no DOM. The next-sort.ts /
// permission-ui.ts precedent.

/** One step's server state: the instruction text plus a value per field-def id. What the editor
 *  shows is this, overlaid with whatever the user has actually typed (see below). */
export type StepDraft = { instruction: string; values: Map<string, string> };

/** The shape `getRevision` returns per step, narrowed to what this reads. */
type DraftableStep = {
  id: string;
  codeId: string;
  instruction: string;
  values: { fieldDefId: string; value: string }[];
};

/** The shape `/api/process/step-code-fields` returns per code, narrowed the same way. */
type DraftableCode = { id: string; fields: { id: string }[] };

/**
 * Builds the per-step snapshot of server state, keyed by step id.
 *
 * Each step's value map is seeded with an "" entry for every field def the step's code currently
 * carries — so a never-set field still renders an input — and then overwritten with whatever
 * values actually came back from the server.
 *
 * `codes` is enrichment, not a precondition: when it is empty or missing the step's code (the
 * step-code-fields fetch failed), the step still gets an entry carrying its instruction and its
 * persisted values, just with no seeds for fields nothing knows about.
 *
 * There is deliberately no "carry the previous drafts forward" parameter here any more. It had
 * one, and it carried CLEAN drafts along with dirty ones — so a step another user had edited
 * came back from the server correct and was immediately overwritten by this user's untouched
 * stale copy, displayed as freshly dirty, ready for a Save that would silently revert the other
 * user's work (Codex, PR #22). The editor now keeps only what the user actually typed, in a
 * separate overlay, and composes the two at render time: an untouched field always shows server
 * truth because there is nothing of the user's to show instead. That makes the whole class of
 * carry-forward staleness unrepresentable rather than guarded against.
 */
export function buildStepOriginals(
  steps: readonly DraftableStep[], codes: readonly DraftableCode[],
): Map<string, StepDraft> {
  const originals = new Map<string, StepDraft>();
  for (const s of steps) {
    const code = codes.find((c) => c.id === s.codeId);
    const values = new Map<string, string>();
    for (const f of code?.fields ?? []) values.set(f.id, "");
    for (const v of s.values) values.set(v.fieldDefId, v.value);
    originals.set(s.id, { instruction: s.instruction, values });
  }
  return originals;
}

/** What the user has typed and not yet saved, per step — ONLY touched fields appear. An absent
 *  `instruction`, or a field-def id absent from `values`, means "untouched, show the server's". */
export type StepEdits = { instruction?: string; values: Map<string, string> };

/** The instruction the editor should show: the user's if they have typed one, else the server's. */
export function shownInstruction(
  original: StepDraft | undefined, edits: StepEdits | undefined,
): string {
  return edits?.instruction ?? original?.instruction ?? "";
}

/** The value the editor should show for one field, on the same rule. */
export function shownValue(
  original: StepDraft | undefined, edits: StepEdits | undefined, fieldDefId: string,
): string {
  return edits?.values.get(fieldDefId) ?? original?.values.get(fieldDefId) ?? "";
}

/**
 * The patch a Save should send: every touched field whose value actually differs from the
 * server's. A field the user typed back to its original value contributes nothing, so a Save
 * button driven by this stays correctly disabled.
 */
export function pendingChanges(
  original: StepDraft | undefined, edits: StepEdits | undefined,
): { instruction?: string; values: { fieldDefId: string; value: string }[] } {
  const out: { instruction?: string; values: { fieldDefId: string; value: string }[] } = { values: [] };
  if (!edits) return out;
  if (edits.instruction !== undefined && edits.instruction !== (original?.instruction ?? "")) {
    out.instruction = edits.instruction;
  }
  for (const [fieldDefId, value] of edits.values) {
    if (value !== (original?.values.get(fieldDefId) ?? "")) out.values.push({ fieldDefId, value });
  }
  return out;
}

/** Whether a step has anything worth saving. */
export function isStepDirty(original: StepDraft | undefined, edits: StepEdits | undefined): boolean {
  const { instruction, values } = pendingChanges(original, edits);
  return instruction !== undefined || values.length > 0;
}

/**
 * The overlay a step should keep after a save, given exactly what that save submitted.
 *
 * Returns `null` when nothing is left to keep. Anything the user typed WHILE the request was in
 * flight survives, because it no longer equals what was sent: clearing the whole overlay on
 * success discarded those newer keystrokes and the reload then displayed the submitted values
 * over them (Codex, PR #22). The controls stay live during a save deliberately — this is a
 * per-step editor and blocking the row for a round trip is worse than reconciling afterwards.
 */
export function editsAfterSave(
  edits: StepEdits | undefined, submitted: { instruction?: string; values: { fieldDefId: string; value: string }[] },
): StepEdits | null {
  if (!edits) return null;
  const values = new Map(edits.values);
  for (const { fieldDefId, value } of submitted.values) {
    if (values.get(fieldDefId) === value) values.delete(fieldDefId);
  }
  const keepInstruction =
    edits.instruction !== undefined && edits.instruction !== submitted.instruction;
  if (!keepInstruction && values.size === 0) return null;
  return { instruction: keepInstruction ? edits.instruction : undefined, values };
}

// --- The overlay's KEYS: what a structural mutation does to the map itself ---------------------
//
// A revision cut copies every step under brand-new ids, so a mutation against a LOCKED revision
// hands back an old->new mapping the overlay has to be carried through, or every unsaved edit on
// every other step is silently replaced by persisted values (Codex, PR #22). A removal is the
// other direction: the destroyed step's overlay has to GO, or the registration's fail-closed arm
// (an edit key with no entry in `originals`) reports the page unsaved forever with nothing on
// screen able to clear it.
//
// Both were inline in ProcessStepsSection and therefore untestable — vitest runs "node" with no
// component renderer — which is how #283 shipped: the two were sequenced the wrong way round under
// a comment asserting the opposite. Here they are values, and the composition that has to be
// ordered correctly is a single function rather than two calls a caller must sequence.

/** What the user has typed, keyed by step id. `Map` rather than `Record` — the component's own
 *  state shape, and the keys are opaque ids that must never meet `Object.prototype`. Taken and
 *  returned as the same type so a caller can hand these straight to `setEdits`; none of them
 *  mutates its argument, they return either a fresh map or the one they were given. */
export type StepEditMap<E> = Map<string, E>;

/**
 * Drop the overlay for steps a mutation DESTROYED — or `"all"` when the whole recipe was replaced.
 *
 * Returns the SAME map when nothing matches, so a drop that finds nothing is a React state bailout
 * rather than a re-render. That bailout also makes a MISSED drop completely silent, which is what
 * let #283 sit unnoticed: the fix is to call this with the right keys, never to notice it failed.
 */
export function dropStepEdits<E>(cur: StepEditMap<E>, stepIds: readonly string[] | "all"): StepEditMap<E> {
  if (stepIds === "all") return cur.size === 0 ? cur : new Map<string, E>();
  if (!stepIds.some((id) => cur.has(id))) return cur;
  const next = new Map(cur);
  for (const id of stepIds) next.delete(id);
  return next;
}

/**
 * Re-key the overlay through a cut's old->new mapping.
 *
 * An UNMAPPED key is kept under its own name, deliberately: that is right for a step the cut did
 * not touch, and it is why this cannot also do the dropping — "renamed" and "destroyed" are
 * indistinguishable from the map alone, so the caller that knows what it destroyed has to say so.
 * An empty mapping means no cut happened and is a no-op.
 */
export function remapStepEdits<E>(cur: StepEditMap<E>, stepIdMap: Record<string, string>): StepEditMap<E> {
  if (Object.keys(stepIdMap).length === 0) return cur;
  const next = new Map<string, E>();
  for (const [stepId, e] of cur) next.set(stepIdMap[stepId] ?? stepId, e);
  return next;
}

/**
 * The overlay after a step REMOVAL: the removed step's own draft goes, and everything else is
 * carried through the cut's mapping.
 *
 * ONE function because the order is the whole defect (#283). Dropping must happen FIRST, against
 * the pre-remap key the overlay is still filed under; remapping first moves the draft to its
 * post-cut id and the drop then deletes a key holding nothing, stranding the page. The call site
 * had them the other way round beneath a comment asserting this exact rationale in reverse.
 *
 * Correct even when the server hands back a mapping for the removed step — which it no longer does
 * (`removeStep` prunes any entry pointing at the row it deleted) — because by then there is
 * nothing left under that key to move.
 */
export function stepEditsAfterRemoval<E>(
  cur: StepEditMap<E>, stepIdMap: Record<string, string>, removedStepId: string,
): StepEditMap<E> {
  return remapStepEdits(dropStepEdits(cur, [removedStepId]), stepIdMap);
}
