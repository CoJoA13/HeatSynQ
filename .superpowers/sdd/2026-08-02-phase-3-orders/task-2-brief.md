### Task 2: Pure utilities — serial ranges, business days, load split

**Files:**
- Create: `src/lib/serial-range.ts`, `src/lib/business-days.ts`, `src/lib/load-split.ts`
- Test: `tests/serial-range.test.ts`, `tests/business-days.test.ts`, `tests/load-split.test.ts`

**Interfaces (Produces — client-safe, no server imports):**
```ts
// serial-range.ts
export function expandSerialRange(input: string): string[];
// no braces → [input.trim()]; "EC{001-025}" → ["EC001", …, "EC025"] (25 rows);
// padding = width of the FIRST bound ("EC{001-25}" ≡ "EC{001-025}", VS rule);
// prefix and suffix both allowed ("{01-04}-B"); throws HttpError-shaped {message} via plain
// Error on: nested/multiple brace groups, non-numeric bounds, start > end, expansion > 10_000.

// business-days.ts
export function parseDateOnly(s: string): Date;      // "yyyy-mm-dd", leap-year rollover guard, throws Error on invalid
export function formatDateOnly(d: Date): string;     // UTC → "yyyy-mm-dd"
export function todayDateOnly(): Date;               // today at UTC midnight (matches @db.Date semantics)
export function addBusinessDays(start: Date, n: number): Date;
// n ≥ 0 integer; each step advances one day, skipping Sat/Sun; addBusinessDays(Thu, 5) = next Thu.

// load-split.ts
export type LoadSplit = { qty: number; weight: number };
export function splitLoads(input: { totalQty: number; totalWeight: number;
  loadQty: number | null; loadWeight: number | null }): LoadSplit[];
```
- `splitLoads` (§5.4): `perLoadQty = min(loadQty ?? Infinity, loadWeight ? Math.max(1, Math.floor(loadWeight / (totalWeight / totalQty))) : Infinity)`; both null → `[{ qty: totalQty, weight: totalWeight }]`. Chunks of `perLoadQty`, last chunk = remainder; per-load weight = `round2(totalWeight * qty / totalQty)`, **last load = totalWeight − Σ(others)** so sums are exact to the cent-of-a-pound.

- [ ] **Step 1: Failing tests** — the §12 matrices in full:
  - serial-range: plain string passthrough; 25-row expansion with padding; `{001-25}` equivalence; suffix form; reject nested `{{`, two groups, `{01-}`, `{9-1}`, `{1-99999}` (cap message names 10,000); trims whitespace.
  - business-days: Thu+5=Thu; Fri+1=Mon; Mon+0=Mon; parse rejects `2025-02-29` (rollover guard) and `2025-13-01`; format round-trips.
  - load-split: `1000/300` → 300/300/300/100; weight-only `loadWeight=700, each≈2.6` (1000 pcs, 2600 lb) → perLoad `floor(700/2.6)=269`; **both caps** (the §3.2 example: 1000 pcs @ 2.6 lb, loadQty 300, loadWeight 700 → 269 not 300); heavy piece (each 900 lb, loadWeight 700) → 1/load; exact multiple 900/300 → three equal loads, no zero-qty tail; no caps → single load; weights sum exactly to totalWeight in every case (assert `Σ === total` with 2-dp arithmetic).
- [ ] **Step 2: Run — expect FAIL** (`npx vitest run tests/serial-range.test.ts tests/business-days.test.ts tests/load-split.test.ts`).
- [ ] **Step 3: Implement the three modules** to the signatures above (plain `Error` with clean messages in `src/lib` — services translate to `HttpError(400, …)` at the boundary).
- [ ] **Step 4: Run — expect PASS.** Gates.
- [ ] **Step 5: Commit** — `feat: serial-range, business-days, and load-split utilities`

