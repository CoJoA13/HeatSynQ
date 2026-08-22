# Task 1 report — gate infrastructure (#188, part 1)

Branch `gate-infrastructure`. All commands from `erp/`.

## 1. What changed

One file: `erp/tests/audit-children.test.ts`. Plus one clause in `CLAUDE.md`.

`callsInvalidate` — the predicate BOTH invalidation sweeps use to decide "does this file really
call `invalidateHistory()`?" — no longer strips comments with regexes and tests the remainder. It
parses the source with the TypeScript compiler API and walks for a `CallExpression` whose callee is
the bare identifier `invalidateHistory`:

```ts
export function callsInvalidate(src: string): boolean {
  const parsed = ts.createSourceFile(
    "candidate.tsx", src, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TSX,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "invalidateHistory"
    ) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return found;
}
```

`tests/audit-children.test.ts:319`, docblock at `:290`, `import ts from "typescript"` at `:4`.
`typescript` was already a devDependency (5.9.3); nothing was installed. The signature is unchanged
(`(src: string) => boolean`), so both call sites — the entity-keyed sweep at `:203` and the
page-keyed sweep at `:488` — are untouched.

### Why the shipped version was wrong in BOTH directions

It failed **open** on text the comment-strip never touched:

- `const hint = "invalidateHistory()"` read as a call — #188's headline defect. A file could lose
  its real call, keep the literal, and both sweeps stayed green while the mounted panel went stale.
- `x.invalidateHistory()` read as a call too.

And — not in the issue, found while writing the cases — it failed **closed** on punctuation inside
string literals, reporting correctly-wired files as broken:

- `const url = "https://x"; invalidateHistory();` — the `//` inside the URL ended the line for the
  line-comment strip, taking the real call with it. Answered `false`.
- `const a = "/*"; invalidateHistory(); /* note */` — the `/*` inside the string opened a block that
  ran to the next real `*/`, eating the call between. Answered `false`.

Both are live in the shipped detector today (measured, not reasoned — see §3). Neither shape exists
in `src/` right now, which is why nobody has seen them; a guard that reds a correct file teaches
people to work around it, and the workaround is an allowlist entry that then hides a real defect.

### Why a parse and not an eighth regex

Stated in the issue and re-stated in the docblock: four defects were injected into this file's own
guards across two review rounds, every one of them by hand-munging source, every one caught by
running it rather than by reading it (one strip order ate 23,140 characters of a real file). The
parser answers comments, strings, template text, JSX text and regex literals in one mechanism, and
every shape nobody has thought of yet comes for free.

## 2. The decision on property-access calls

**`x.invalidateHistory()` does NOT count. Neither does an uncalled reference
(`onSaved={invalidateHistory}`).** Recorded in a comment at `tests/audit-children.test.ts:609` and
pinned by four assertions.

Reasoning: both sweeps separately assert the file carries
`import { … invalidateHistory … } from "@/components/HistoryPanel"` — a **named** import, whose
binding is used as a bare identifier. A property access is therefore some *other* function that
happens to share the name: a prop, a mock, or a namespace object from an import shape the paired
assertion already rejects. Counting it would let an unrelated method satisfy the census, which is
the same fail-OPEN shape as the string literal.

Both exclusions fail **closed** — a file wired only that way is reported as unwired, loudly, at a
review point — which is the direction the rest of this sweep is built in, and the direction the
regex detector already took (it required the `()` too, so an uncalled reference never counted).

The same closed direction covers an **aliased** import: `import { invalidateHistory as bust }` and
a `bust()` call passes the import regex (the name is inside the braces) but fails the parse, so the
file is named as unwired rather than passing silently.

## 3. RED verification against a genuinely broken tree

### 3a. The new cases, RED on the shipped detector

Added first, run against the old regex before it was replaced. Verbatim, trimmed to the assertions:

```
 FAIL  tests/audit-children.test.ts > … > tells a call from TEXT that spells one — strings, templates, JSX, a regex
AssertionError: a string literal: expected true to be false // Object.is equality
- Expected
+ Received
- false
+ true
 ❯ tests/audit-children.test.ts:567:88

 FAIL  tests/audit-children.test.ts > … > counts the imported BINDING called as a function, and nothing else named alike
AssertionError: a property call: expected true to be false // Object.is equality
- Expected
+ Received
- false
+ true
 ❯ tests/audit-children.test.ts:595:74

 FAIL  tests/audit-children.test.ts > … > is not fooled by punctuation inside a string, which the strip-and-test detector was
AssertionError: a URL, then the call: expected false to be true // Object.is equality
- Expected
+ Received
- true
+ false
 ❯ tests/audit-children.test.ts:613:8

 Test Files  1 failed (1)
      Tests  3 failed | 35 passed (38)
```

Three failures, three distinct defect classes: fail-open on a literal, fail-open on a property
call, fail-closed on a URL. All seven pre-existing detector cases stayed green throughout.

### 3b. The whole-tree proof — a real call replaced by a string literal

`src/app/admin/surcharges/page.tsx` mounts a `surcharge` panel, is named by `INVALIDATION_SITES`
under `customerSurcharge`, and carries three real `invalidateHistory()` calls (`:157`, `:195`,
`:278`). All three were replaced with `const hint = "invalidateHistory()"; void hint;` — the import
line left intact, so the import assertion could not fire in the call's place.

**The shipped regex detector on that broken file:**

```
old regex detector on the BROKEN file: true
```

Green. The panel would go stale on every surcharge write and nothing would say so — exactly the
regression the census exists to prevent.

**The new detector on the same broken file — both sweeps red, naming the file:**

```
 ❯ tests/audit-children.test.ts (38 tests | 2 failed) 2506ms
   × #153 — a registered child implies invalidation wiring > every named file imports and calls invalidateHistory
     → src/app/admin/surcharges/page.tsx must call invalidateHistory(): expected false to be true
   × #158 — a page with a panel that mutates must invalidate > every panel-mounting file that mutates imports and calls invalidateHistory
     → expected [ Array(1) ] to deeply equal []

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/audit-children.test.ts > #153 — a registered child implies invalidation wiring > every named file imports and calls invalidateHistory
AssertionError: src/app/admin/surcharges/page.tsx must call invalidateHistory(): expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ tests/audit-children.test.ts:203:77

 FAIL  tests/audit-children.test.ts > #158 — a page with a panel that mutates must invalidate > every panel-mounting file that mutates imports and calls invalidateHistory
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/app/admin/surcharges/page.tsx must call invalidateHistory()",
+ ]
```

The file was then restored from a byte copy taken before the edit; `git status` shows only
`tests/audit-children.test.ts` modified under `erp/`.

## 4. The test cases

**All seven existing detector cases are kept verbatim** (`:570`) — the two comment forms, the
docblock, the multi-line docblock, the `/*`-inside-a-`//` ordering trap, and the docblock-plus-real-
call pair. Their leading comment now says why they stay: the parser removes the strip-order trap as
a *mechanism*, but the evidence that those shapes are answered correctly is the point.

Three new `it` blocks, twelve new assertions:

| Case | Answer | Why it is here |
|---|---|---|
| `const hint = "invalidateHistory()";` | false | #188's headline defect |
| `const hint = 'invalidateHistory()';` | false | the parser does not care which quote |
| `` const hint = `invalidateHistory()`; `` | false | template TEXT |
| `const el = <p>invalidateHistory()</p>;` | false | JSX text — free from the parser |
| `const re = /invalidateHistory()/;` | false | a regex literal, likewise |
| `` const s = `${invalidateHistory()}`; `` | **true** | a template SUBSTITUTION is code, not text |
| `x.invalidateHistory();` | false | the §2 decision |
| `this.invalidateHistory();` | false | " |
| `H.invalidateHistory();` | false | a namespace-import shape the import assertion rejects |
| `onSaved={invalidateHistory}` | false | a reference, never called |
| `<button onClick={() => save().then(() => invalidateHistory())} />` | **true** | the walk is a full descent, not top-level |
| `invalidateHistory?.();` | **true** | an optional call is a call |
| `const url = "https://x"; invalidateHistory();` | **true** | the regex's own false NEGATIVE |
| `const a = "/*"; invalidateHistory(); /* note */` | **true** | the second one |

## 5. Gate results

| Gate | Result |
|---|---|
| `npx vitest run tests/audit-children.test.ts` | **38 passed / 38** (1 file). Was 35 before the three new `it` blocks. |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx eslint src tests` | clean, exit 0 |
| `npx vitest run` (full) | **3549 passed / 3549**, **208 files passed / 208**, 465.25s |

`npm run test:e2e` was **not** run — Task 2 owns the E2E harness this group, and a concurrent run
would collide on the dev database and port 3100. This change touches no `src/` file and no UI.

## 6. Found and not fixed

- **The wrapper-tracing half of #188 (part 2) is untouched, by instruction.** No wrapper exists —
  all twelve panel-mounting files mount `<HistoryPanel>` directly — and the comment at
  `tests/audit-children.test.ts:435` saying plainly that a wrapper is NOT covered stays exactly as
  it is. **A reviewer/owner call the PR needs to make: the brief says this group "Closes … #188",
  but only part 1 of that issue is built.** Either the close-out records part 2 as a deliberate
  non-fix (the shape #158 → #188 already took), or part 2 is re-filed before #188 is closed. I did
  not decide this.
- **`issuesMutatingRequest` / `MUTATING_TOKEN` / `OPAQUE_METHOD` are still regexes**, by
  instruction. They are deliberately broad and fail CLOSED; `MUTATING_TOKEN` in particular is
  *designed* to match prose, and re-cutting it on the AST is a different decision than this one.
  Note for whoever takes it: an AST rewrite of `MUTATING_TOKEN` would be a *narrowing*, so it would
  need its own allowlist reasoning, not just a parse.
- **The `import { … invalidateHistory … } from "@/components/HistoryPanel"` assertion is still a
  regex** at `:201` and `:482`. Left alone deliberately: parsing it would be a second, unrelated
  change, and the pair is coherent as it stands — every way the regex can be wrong about the import
  makes the file fail the *call* check, which is loud (see §2, the aliased-import case).
- **`ts.createSourceFile` recovers from syntax errors rather than throwing**, so an unparseable file
  yields a tree in which the call is most likely not found and the sweep names the file as unwired.
  That is the closed direction and it is documented in the docblock, but it is not *asserted* — a
  file that fails to parse is reported as "must call invalidateHistory()", not as "does not parse".
  If that ever bites, the fix is to surface `parsed.parseDiagnostics`, which is an internal API; I
  judged that not worth reaching for on a hypothetical.

## 7. Docs

`CLAUDE.md`'s Audit paragraph, one clause added to the sentence describing the page-keyed sweep:
that "calls `invalidateHistory()`" is decided by **parsing** the file, never by pattern-matching its
text (#188), with the reason and a "do not add a regex back" instruction. No other doc changed —
`docs/HANDOFF.md` takes its one-line update at the group close-out (the Group D precedent,
`9090a4d`), and this amends no spec contract, so §15 is untouched.
