# Phase 5B — Task 4 report: `Terms` + `BillingConfig` columns wired through their admin screens

**Task:** wire the Task 2 schema columns — `Terms.netDays`/`discountPercent`/`discountDays` and
`BillingConfig.financeChargeRate` — through validation, the audited reference/billing-config
services, and their admin screens.

**Status:** DONE. All four gates green (1711 tests, tsc clean, eslint clean, build clean).

---

## 0. Where Terms actually lives

The brief names `src/server/terms.ts`, which doesn't exist. `Terms` is one of the ten
`ReferenceKind`s managed generically by `src/server/reference.ts` (`createReference`/
`updateReference`/`listReference`/`deleteReference`), with kind-specific columns declared in that
file's `EXTRA_SCHEMAS` record and surfaced to the admin grid via `REFERENCE_EXTRA_FIELDS`
(`src/lib/reference-constants.ts`). All Terms-side work landed there instead — the `paymentType`/
`inspectionCode` precedent the brief itself points to.

## 1. The both-or-neither wrinkle — exact approach

`EXTRA_SCHEMAS` is typed `Record<ReferenceKind, z.ZodObject<z.ZodRawShape>>` and every kind's
create/update composes its entry via `.merge()`/`.partial()`:

```ts
// create
const data = BASE.merge(EXTRA_SCHEMAS[kind]).strict().parse(...)
// update
const data = BASE.partial().merge(EXTRA_SCHEMAS[kind].partial()).strict().parse(...)
```

A `.refine()`/`.superRefine()` returns a `ZodEffects`, which has neither `.merge` nor `.partial` —
so the pairing rule cannot live on `EXTRA_SCHEMAS.terms` itself without breaking every other
kind's compose (which reuses the exact same generic lines).

**Approach taken:** apply the refinement to the fully-composed schema, once, right before
`.parse()`, in both `createReference` and `updateReference` — the brief's first suggested option.
`src/server/reference.ts`:

```ts
function requireDiscountPair<S extends z.ZodTypeAny>(schema: S) {
  return schema.superRefine((value, ctx) => {
    const row = value as { discountPercent?: number | null; discountDays?: number | null };
    const hasPercent = row.discountPercent != null;
    const hasDays = row.discountDays != null;
    if (hasPercent !== hasDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasPercent ? "discountDays" : "discountPercent"],
        message: "an early-pay discount needs both a percent and a day count",
      });
    }
  });
}
```

```ts
// createReference
const data = requireDiscountPair(BASE.merge(EXTRA_SCHEMAS[kind]).strict())
  .parse(await resolveLinkNames(kind, input)) as ...;

// updateReference
const data = requireDiscountPair(BASE.partial().merge(EXTRA_SCHEMAS[kind].partial()).strict())
  .parse(await resolveLinkNames(kind, input)) as ...;
```

`EXTRA_SCHEMAS`'s `Record<ReferenceKind, z.ZodObject>` type and the merge/partial shape for every
other kind are untouched — `requireDiscountPair` wraps the already-composed, throwaway local
schema, which nothing downstream calls `.merge`/`.partial` on again. For the other nine kinds,
`discountPercent`/`discountDays` are simply never in the parsed shape, so the check is a
structural no-op (`hasPercent === hasDays === false`).

**Partial-update caveat (documented in code, not a live gap):** `requireDiscountPair` validates
the raw PATCH, not "patch merged onto the existing row." A hypothetical `PUT` that sends only
`{ discountPercent: 3 }` against a row that already has `discountDays: 10` set would 400, even
though the resulting row would still be a valid pair. I did not special-case this.

**Correction (fix round 1):** the original version of this report claimed this "mirrors the
`surcharges.ts` precedent." That's wrong and has been corrected — `updateSurcharge` does **not**
validate a partial patch at all; it re-parses the same full `SAVE` shape as `createSurcharge` on
every call (`surcharges.ts`'s own comment: "takes the same full SAVE shape as create, not a
partial patch"), which sidesteps this exact problem rather than accepting it. `updateReference`
here genuinely does validate a partial `PATCH` (via `BASE.partial().merge(EXTRA_SCHEMAS[kind]
.partial())`), so `requireDiscountPair` is applied to that partial shape — a materially different,
and strictly weaker, guarantee than surcharges' full-row re-validation. The behavior itself is
still intentional and documented, just not the same pattern as surcharges. It's not reachable
through the UI today: `ReferenceTable.tsx`'s generic grid only lets an admin set a kind's extra
columns from the **Add** row (create); existing rows only ever get a `{ active: boolean }` PUT via
the Active toggle. Flagged as a concern below for the reviewer.

## 2. `src/server/reference.ts` — schema

```ts
terms: z.object({
  netDays: z.number().int().min(0).optional(),
  discountPercent: decimalField(5, 2, { min: "nonnegative" }),
  discountDays: z.number().int().min(1).optional(),
}),
```

`netDays` is **optional at the zod layer**, not `.default(30)`. This was a deliberate deviation
from a literal `.default(30)` reading of the brief, reasoned through in code comments: `.default()`
fires whenever the key is `undefined`, and `EXTRA_SCHEMAS.terms` is reused verbatim (via
`.partial()`) for `updateReference` — a `.default(30)` there would silently reset an existing row's
`netDays` to 30 on *any* unrelated partial update that omits it (e.g. the Active toggle's
`{ active: false }` PUT). Leaving it plain-optional means: omitted on create → Postgres's own
`netDays Int @default(30)` column default applies (verified by test); omitted on update → untouched.
This satisfies "required, default 30" at the column/domain level without a zod-level footgun.

## 3. `src/server/billing-config.ts`

```ts
// BillingConfigRow
financeChargeRate: number | null;

// EMPTY
certChargeDefault: null, billForCertDefault: false, financeChargeRate: null,

// SAVE
financeChargeRate: decimalField(6, 4, { min: "nonnegative" }),

// getBillingConfig mapping
financeChargeRate: row.financeChargeRate?.toNumber() ?? null,
```

`setBillingConfig`/`getBillingConfig` already iterate the registry generically (`{ ...data }` on
create/update, an explicit field-by-field map on read) — confirmed the new field flows through
both directions with no other change needed; `/api/admin/billing`'s route is a pure passthrough
(`getBillingConfig()` / `setBillingConfig(body)`), so no route change was needed either.

## 4. UI — the numeric-input wrinkle, and how it was resolved

**The wrinkle:** `ReferenceTable.tsx`'s generic Add row keeps `draft` as a plain
`Record<string, string>` and does `JSON.stringify(draft)` straight to the API; `paste.ts` likewise
hands every cell to `createReference` as a raw string. Every existing `EXTRA_SCHEMAS` field before
this task was either a string (`description`, `text`) or an id resolved from a name (`ref` kind),
so this was never a problem. `netDays`/`discountDays` are real `z.number().int()` fields (per the
codebase-wide convention for integers — `requestDaysOverride`, `position`, `sort`, etc. are all
plain `z.number().int()`, never coercing), not string-accepting like `decimalField`. A raw string
`"30"` fails `z.number()` outright.

**Resolution — extended the field-mechanism minimally, matched the `requestDaysOverride` UI
precedent (`customers/[id]/page.tsx`, which parses a typed string to a real number client-side
before `save()`):**

1. `src/lib/reference-constants.ts` — widened `REFERENCE_EXTRA_FIELDS`'s `kind` union from
   `"text" | "ref"` to `"text" | "ref" | "number"`, and added an optional `hint?: string` (generic,
   used here for the pairing hint). Declared Terms' three fields:
   ```ts
   terms: [
     { key: "netDays", label: "Net days", kind: "number" },
     { key: "discountPercent", label: "Discount %", kind: "text", hint: "needs Discount days too" },
     { key: "discountDays", label: "Discount days", kind: "number", hint: "needs Discount % too" },
   ],
   ```
   `discountPercent` stays `kind: "text"` — `decimalField` already accepts a decimal string
   directly (`salesTaxRate`/`certChargeDefault`'s own binding convention), no conversion needed.

2. `src/components/ReferenceTable.tsx` (`add()`, ~line 68-94) — added `buildPayload()`, called
   from `add()` in place of the raw `draft`: for every extra field of `kind === "number"`, drops a
   blank draft value entirely (so the field's own `.optional()`/column default applies instead of
   a 400 on `""`), else converts to `Number(raw)`; a value that fails to parse as finite is left as
   the original string so the server's own type-mismatch message explains it, rather than silently
   becoming `null` (`JSON.stringify({ x: NaN })` serializes `NaN` as `null`, which would otherwise
   read as a confusing "expected number, received null").
   The Add-row `<input>` for a `"number"`-kind field also gets `inputMode="numeric"`, and any
   `f.hint` renders as a small `<span>` under the input (used only for `discountPercent`/
   `discountDays`).

3. `src/server/paste.ts` (`pasteReference`, ~line 20-49) — pasted cells are also always raw
   strings; added a `numberColumns` set built from `REFERENCE_EXTRA_FIELDS[kind]` and converted
   any matching cell via `Number(v)` after the existing blank-cell filter, so a Terms row pasted
   from a spreadsheet with a `netDays`/`discountDays` cell works the same as one typed into the
   Add row.

4. `src/app/admin/billing/page.tsx` — `financeChargeRate` needed none of the above: it's a
   `decimalField`, bound directly as a string exactly like `salesTaxRate`/`certChargeDefault`
   already are. Added:
   - `Cfg.financeChargeRate: number | string | null` (type, ~line 18-19)
   - widened `blurDecimal`'s key union to include `"financeChargeRate"` (~line 64)
   - a new labeled row, "Finance charge (monthly %)", between "Certification charge default
     amount" and "Bill for certification by default" (~line 166-179), following the existing
     `salesTaxRate`/`certChargeDefault` input pattern exactly (`inputMode="decimal"`,
     `noteFocus`/`blurDecimal`, `disabled={canEdit.disabled}`).

## 5. TDD — RED / GREEN

**`tests/reference-tables.test.ts`** (new `describe("terms: netDays + early-pay discount", …)`):
- RED (`npx vitest run tests/reference-tables.test.ts`, before any `reference.ts` change): all 4
  new terms tests failed with `ZodError: Unrecognized key(s)` (netDays/discountPercent/discountDays
  not yet in `EXTRA_SCHEMAS.terms`), confirmed alongside the 3 pre-existing tests still passing.
- GREEN (after implementing `EXTRA_SCHEMAS.terms` + `requireDiscountPair`): 20/20 passed, including:
  - `netDays` defaults to 30 when omitted on create
  - rejects a negative `netDays`, rejects a non-integer `netDays`
  - `discountPercent` without `discountDays` (and vice versa) → rejects with
    `/an early-pay discount needs both a percent and a day count/`
  - `2/10 Net 30` round-trips (`netDays: 30, discountPercent: "2.00", discountDays: 10`), and the
    `auditLog` entry's `after` snapshot carries all three values (`entity: "terms"`)

**`tests/billing-config.test.ts`**:
- RED: `saves the plant finance-charge rate and reads it back` failed with
  `ZodError: Unrecognized key: "financeChargeRate"`; the pre-existing "everything unset" `toEqual`
  test also needed updating for the new key (not a RED case, a necessary companion fix — adding a
  field to `BillingConfigRow`/`EMPTY` changes what "everything unset" strictly equals).
- GREEN (after implementing): 12/12 passed, including the new
  `saves the plant finance-charge rate and reads it back` (`"1.5"` in → `1.5` out) and
  `rejects a negative finance-charge rate`.

## 6. Gates (all foreground)

| Gate | Result |
|---|---|
| `npm test` | PASS — **1711 passed**, 109 files (159.21s) |
| `npx tsc --noEmit` | PASS (clean) |
| `npx eslint src tests` | PASS (clean) |
| `npm run build` | PASS (clean) |

`npm test` exceeded the harness's default 120s Bash timeout and was auto-moved to a background
task (not something I requested); I did not poll it — ran `tsc`/`eslint` while it finished, then
picked up its completion notification (exit code 0, full 1711-passed summary) rather than guessing
at a result. `tsc`/`eslint`/`build` all ran genuinely foreground with no timeout issue.

Browser verification of the two admin screens intentionally **not** done — the controller does
that live-browser check after review, per this task's instructions.

## 7. Self-review

- **Scope discipline:** touched `src/server/reference.ts`, `src/server/billing-config.ts`,
  `src/lib/reference-constants.ts`, `src/components/ReferenceTable.tsx`, `src/server/paste.ts`,
  `src/app/admin/billing/page.tsx`, `tests/reference-tables.test.ts`, `tests/billing-config.test.ts`
  — no route files needed changes (both `/api/admin/reference/...` and `/api/admin/billing` are
  generic passthroughs to the services). No Terms admin page/section exists separately from
  `ReferenceTable.tsx` — "the Terms admin page" *is* `admin/reference` with `kind="terms"`
  selected, so extending the shared grid is the correct (and only sane) place, not a scope dodge.
- **Stray unrelated change found and reverted, not committed:** at start of this task's gate run,
  `.superpowers/sdd/.gitignore` was sitting modified in the working tree, clobbered back to a bare
  `*` — exactly the documented hazard in CLAUDE.md ("Committing early" / execution-record loss).
  This predates my edits (I never touched that file) and is unrelated to Task 4. I restored it to
  its tracked HEAD content via `git checkout -- .superpowers/sdd/.gitignore` before committing, and
  did not include it in this task's commit either way.
- **`netDays` optional-not-default:** the one place I deliberately read "default 30" as a
  column-level fact rather than a literal zod `.default(30)` instruction — reasoned through in §2
  above and in the code comment. Verified by a dedicated test that create-without-`netDays`
  produces `30` via the Prisma/Postgres column default, not a zod-injected value.
  I believe this is the *more* correct reading (a zod `.default()` would have been a real,
  silent-data-loss bug on partial updates), but flagging it explicitly since it's a literal
  deviation from the brief's exact phrasing.
- **`discountPercent` read type:** `listReference("terms")` (fully generic, unchanged) returns
  `discountPercent` as a raw Prisma `Decimal`, not a plain `number` — unlike `billing-config.ts`'s
  own `.toNumber()` convention for every decimal field it returns. This is a pre-existing property
  of `listReference` (it has never done per-kind Decimal→number mapping, because no reference kind
  had a Decimal column before Terms), not something Task 4 introduced. It's harmless for both
  current UI paths (`String(decimalInstance)` displays correctly; JSON serializes it as a decimal
  string via `Decimal.prototype.toJSON`), but it is a minor type-consistency gap relative to how
  `billing-config`/`surcharges` handle decimals. Left unchanged as out of scope for this task
  (would mean adding per-kind decimal-column knowledge to a function that is otherwise fully
  generic across all ten kinds) — noting it here rather than silently living with it.
- **Discount-pair rule scope:** confirmed `requireDiscountPair` is a true no-op for the other nine
  kinds (neither key is ever in their parsed shape) by the full suite staying green, including
  every other kind's existing create/update tests in `reference-tables.test.ts`/
  `reference-blockers.test.ts`/`reference-guards.test.ts`.

## 8. Concerns for the reviewer

1. **Both-or-neither is patch-shaped, not row-shaped, on update** (§1 above) — a `PUT` supplying
   exactly one of `discountPercent`/`discountDays` against a row that already has the other set
   will 400, even though the resulting row would be a valid pair. Not reachable through
   `ReferenceTable.tsx` today (extras are Add-row-only). Note this is **not** the `surcharges.ts`
   pattern (corrected in §1 — `updateSurcharge` re-validates the full row every time, sidestepping
   this class of gap entirely); this is a genuinely weaker, partial-patch-shaped guarantee, and a
   real constraint on any future direct API caller or a future inline-edit UI for reference extras.
2. **UI-pattern limitation, per the brief's own ask to flag one:** `REFERENCE_EXTRA_FIELDS`/
   `ReferenceTable.tsx` had no numeric-input concept before this task; I extended it minimally
   (`kind: "number"` + client-side `Number()` conversion in both the grid and paste) rather than
   pushing coercion into the zod schema (`z.coerce.number()`), specifically because
   `z.coerce.number()` silently turns an explicit `null` into `0` (`Number(null) === 0`) before
   `ZodOptional`'s undefined-shortcut ever applies — a real footgun for a non-nullable column that
   the browser/paste paths never actually need (both always send either a real number or omit the
   key). This keeps the server-side integer fields exactly `z.number().int()`, matching the
   codebase-wide integer convention, at the cost of two small client-side conversion sites instead
   of one schema-side one.

---

## Fix round 1 (review: "Needs fixes" — 2 Important, 3 Minor)

### Important #1 — `buildPayload()` only blank-dropped `kind === "number"`

`discountPercent` is `kind: "text"` at the time of the original submission (it's a `decimalField`,
string-accepting), so `buildPayload()`'s `if (f.kind !== "number") continue;` guard skipped it
entirely — a user who typed into the discount-percent box and then cleared it sent
`discountPercent: ""` verbatim, which fails `decimalField`'s digit-pattern regex with "Must be a
decimal with at most 3 digits before and 2 after…" instead of being treated as "no discount."

**Fix (client-side only — this is a UI bug, not a server-schema bug):**

1. `src/lib/reference-constants.ts` — split `kind: "text"` into two kinds: `"text"` (genuine free
   text, where an explicit `""` is a legitimate stored value — `glAccount.description`,
   `commentSnippet`/`specification.text`, untouched) and a new `"decimal"` (a `decimalField`-bound
   value that is a string on the wire but where `""` means "no value," not "store empty string").
   `Terms.discountPercent` is now `kind: "decimal"`.
2. `src/components/ReferenceTable.tsx`'s `buildPayload()` — the blank-drop branch now triggers for
   `f.kind === "number" || f.kind === "decimal"` (previously `"number"` only); for `"decimal"` it
   only blank-drops (no `Number()` conversion — `decimalField` already accepts the raw string).
   The Add-row `<input>`'s `inputMode` also gets a `"decimal"` case (was falling through to
   `undefined`), matching the billing page's own `inputMode="decimal"` convention on its three
   decimal inputs.
3. `"text"` fields are untouched by the blank-drop logic — verified by inspection: the loop's
   guard (`if (f.kind !== "number" && f.kind !== "decimal") continue;`) explicitly skips `"text"`
   and `"ref"`, so `glAccount.description = ""` and `commentSnippet.text = ""` still round-trip
   exactly as before (also covered by the pre-existing, still-green
   `"'glAccount': a re-created name is a new row with default extras"` and
   `"comment snippet and specification carry a text body"` tests).

**Why no new automated test for this specific fix:** the bug and the fix are both in React
component logic (`buildPayload()`), and this repo's test suite (`tests/*.test.ts` via vitest) has
no React component test harness at all (no `@testing-library`, no `.test.tsx` files anywhere) — it
tests services and API routes against the real DB, not rendered components. I first attempted a
service-layer stand-in test (`createReference("terms", { name: ..., discountPercent: "" })`
expecting success) to prove the fix's *intent* at the server boundary, but that test is wrong: the
fix is that the browser now never sends `discountPercent: ""` in the first place, not that the
server now accepts it — `decimalField` still correctly rejects a literal `""` from any caller that
sends one directly (API testing tools, a future non-UI client), which is intended, unchanged
behavior. I ran that test, watched it fail with the exact regex error described above (confirming
it was testing unimplemented/unwanted server behavior, not the actual fix), and removed it rather
than leave a misleading assertion in the suite. This fix is verified by code inspection instead
(§ above) plus the unchanged, still-green existing `"text"`-kind tests proving no regression.

### Important #2 — missing regression test for the no-`.default(30)` decision

Added to `tests/reference-tables.test.ts`:

```ts
it("an update omitting netDays leaves an existing non-default value untouched", async () => {
  const { id } = await createReference("terms", { name: "Net 45", netDays: 45 });
  await updateReference("terms", id, { active: false });
  const row = (await listReference("terms", { includeInactive: true })).find((r) => r.id === id);
  expect(row?.active).toBe(false);
  expect(row?.netDays).toBe(45);
});
```

First run failed — not because the underlying behavior was wrong, but because the test itself
called the default `listReference("terms")`, which (like the admin grid's default view) only
returns *active* rows; the update had just deactivated the row, so `.find(...)` returned
`undefined` and `row?.active` read `undefined` instead of `false`. Fixed by passing
`{ includeInactive: true }`. Re-ran green. This genuinely exercises the guard: reverting
`EXTRA_SCHEMAS.terms.netDays` to `.default(30)` would make `netDays` come back `30` here instead
of `45`, failing the second assertion.

### Minors

- **Paste/importer numeric-cell test** (`tests/reference-tables.test.ts`): added
  `"paste converts numeric netDays/discountDays cells for a terms row"`, pasting
  `"2/10 Net 45\t45\t2.00\t10"` through `pasteReference("terms", …)` and asserting `netDays: 45`,
  `discountDays: 10`, `discountPercent → 2` on the created row — covers `paste.ts`'s
  `numberColumns` conversion path, which had no direct test before.
- **`EMPTY`-fallback test extended** (`tests/billing-config.test.ts`): the
  `"returns the defaults when the row is genuinely absent"` test now also asserts
  `cfg.financeChargeRate` is `null`, alongside the existing `salesTaxRate`/`billForCertDefault`
  checks — catches a typo in the `EMPTY` literal the same way those two already do.
  <br>Also updated the `EMPTY`-fallback assertion pattern check — no schema/service change needed,
  `financeChargeRate` was already correctly `null` in `EMPTY` from the original submission; this
  only closes the test gap.
- **`paste.ts`'s `Number(v)` made consistent with `buildPayload()`'s**: a non-finite parse (e.g. a
  pasted `"abc"` in a `netDays` cell) now leaves the original string rather than passing `NaN`
  through to `createReference`, matching the Add-row grid's behavior and producing the same
  "Expected number, received string" per-row paste error a bad Add-row entry would get.

### Report accuracy fix

Corrected the "mirrors the `surcharges.ts` precedent" claim (§1 above and the code comment on
`requireDiscountPair` in `reference.ts`) — `updateSurcharge` does **not** validate a partial patch;
it re-parses the identical full `SAVE` shape as `createSurcharge` on every call, which sidesteps
this class of problem entirely rather than accepting the same partial-PATCH caveat
`updateReference` does. The underlying behavior here (documented, not a live gap) is unchanged;
only the report's and the code comment's characterization of it relative to surcharges was wrong,
and both are now corrected to state plainly that this is a *weaker* guarantee than surcharges'
full-row approach, not the same pattern.

### Commands run (all foreground, none backgrounded or polled)

```
$ npx vitest run tests/reference-tables.test.ts tests/billing-config.test.ts
  → (interim, before the includeInactive fix) 1 failed | 33 passed (34)
$ npx vitest run tests/reference-tables.test.ts tests/billing-config.test.ts
  → Test Files  2 passed (2)
    Tests  34 passed (34)
$ npx tsc --noEmit
  → (no output — clean)
$ npx eslint src tests
  → (no output — clean)
$ npx vitest run tests/paste.test.ts        # extra sanity check, paste.ts was touched
  → Test Files  1 passed (1)
    Tests  22 passed (22)
```

### Stray unrelated regression, again

`.superpowers/sdd/.gitignore` was found clobbered back to a bare `*` a **second** time at the
start of this fix round (same file, same hazard documented in CLAUDE.md, restored once already in
the original submission — see §7 above). Restored again via `git checkout -- .superpowers/sdd/
.gitignore` before committing; not part of either commit in this task.
