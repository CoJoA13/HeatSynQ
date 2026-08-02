// Pure, client-safe (no src/server imports): the "what sort should the next new row get"
// calculation shared by admin grids with an add-row draft. `rows.length` looks equivalent but
// only IS equivalent when every row's sort is contiguous from 0 — a gap (e.g. sort 0, 2 after a
// row in between was deleted) makes `rows.length` collide with an existing sort instead of
// landing after it (H1, Codex PR #13 round 3 review).
export function nextSort(rows: { sort: number }[]): number {
  return rows.length ? Math.max(...rows.map((r) => r.sort)) + 1 : 0;
}
