// Pure, client-safe (no src/server imports — the next-sort.ts leaf shape): the catch-continuation
// of a refused field-def save (backlog #23). When the PUT 400s naming a field still in use, the
// page fetches that def's blockers and paints a panel — but the GET is async, and the user may
// select another code while it is in flight. `fieldBlocked` carries no code id (only defId/label),
// so a `blocked`-style id-compare render guard cannot even be expressed; the ticket idiom guards
// the state write at its source instead.
export type FieldBlockerPanel<B> = { defId: string; label: string; list: B[] };

/**
 * Resolves what the field-blocker panel should show once the blocker fetch settles. The ticket is
 * taken BEFORE the fetch dispatches (the makeLatestGate contract — a ticket taken after the await
 * orders responses by arrival, which is the bug, not the fix), and BOTH landings are gated (F7,
 * customers/page.tsx — a superseded request's rejection must not clobber current state either):
 *  - the panel value: resolved and still current — set it;
 *  - null: the fetch failed but is still current — clear the panel (the save's own error text
 *    already explains the refusal; no blocker list just means no panel this time);
 *  - undefined: superseded mid-flight — touch nothing, the state belongs to the new selection now.
 */
export async function resolveFieldBlockerPanel<B>(
  gate: { next(): number; isCurrent(ticket: number): boolean },
  fetchBlockers: () => Promise<B[]>,
  fieldCtx: { defId: string; label: string },
): Promise<FieldBlockerPanel<B> | null | undefined> {
  const ticket = gate.next();
  try {
    const list = await fetchBlockers();
    if (!gate.isCurrent(ticket)) return undefined;
    return { defId: fieldCtx.defId, label: fieldCtx.label, list };
  } catch {
    if (!gate.isCurrent(ticket)) return undefined;
    return null;
  }
}
