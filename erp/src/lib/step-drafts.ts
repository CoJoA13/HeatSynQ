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
