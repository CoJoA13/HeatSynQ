// Shared by ProcessStepsSection (src/app/parts/[id]/) — in src/lib, not next to the component,
// because a client component may not import from src/server/** and this needs to be reachable
// from tests, which run under vitest's "node" environment with no DOM. The next-sort.ts /
// permission-ui.ts precedent.

/** One step's editable state: the instruction text plus a value per field-def id. */
export type StepDraft = { instruction: string; values: Map<string, string> };

/** The shape `getRevision` returns per step, narrowed to what drafting actually reads. */
type DraftableStep = {
  id: string;
  codeId: string;
  instruction: string;
  values: { fieldDefId: string; value: string }[];
};

/** The shape `/api/process/step-code-fields` returns per code, narrowed the same way. */
type DraftableCode = { id: string; fields: { id: string }[] };

/**
 * Builds the per-step `drafts` map and its `originals` snapshot from a revision's steps.
 *
 * Each step's value map is seeded with an "" entry for every field def the step's code currently
 * carries — so a never-set field still renders an input — and then overwritten with whatever
 * values actually came back from the server.
 *
 * `codes` is enrichment, not a precondition: when it is empty or missing the step's code (the
 * step-code-fields fetch failed), the step still gets a draft carrying its instruction and its
 * persisted values, just with no seeds for the fields nothing knows about. The caller used to
 * skip drafting entirely in that case, which left the instruction textarea rendering "" over
 * persisted text and silently discarding keystrokes (Codex, PR #22).
 *
 * `originals` gets its own `Map` per step, so later edits to a draft never mutate the snapshot
 * the dirty check compares against.
 *
 * `previous` carries unsaved work across a rebuild. Adding, removing or reordering a step reloads
 * the whole revision, and none of those requests carry the text or values a user has typed into
 * some other step — so without this, a structural action silently discarded that work (Codex,
 * PR #22). A step whose id survives the reload keeps its draft and, because `originals` is still
 * rebuilt from the server, correctly keeps reading as dirty with Save still there to click. A
 * revision cut renumbers every step, so the new ids find no carried draft and take server values,
 * which is what should happen.
 */
export function buildStepDrafts(
  steps: readonly DraftableStep[], codes: readonly DraftableCode[],
  previous?: ReadonlyMap<string, StepDraft>,
): { drafts: Map<string, StepDraft>; originals: Map<string, StepDraft> } {
  const drafts = new Map<string, StepDraft>();
  const originals = new Map<string, StepDraft>();
  for (const s of steps) {
    const code = codes.find((c) => c.id === s.codeId);
    const values = new Map<string, string>();
    for (const f of code?.fields ?? []) values.set(f.id, "");
    for (const v of s.values) values.set(v.fieldDefId, v.value);
    // `originals` is always server truth — it is the baseline the dirty check compares against,
    // so it must never carry a draft forward.
    originals.set(s.id, { instruction: s.instruction, values: new Map(values) });
    const carried = previous?.get(s.id);
    if (carried) {
      // Merged onto the fresh seeds rather than substituted for them, so a field def added to the
      // step's code since the last build still gets its "" entry and renders.
      for (const [fieldDefId, value] of carried.values) values.set(fieldDefId, value);
      drafts.set(s.id, { instruction: carried.instruction, values });
    } else {
      drafts.set(s.id, { instruction: s.instruction, values });
    }
  }
  return { drafts, originals };
}
