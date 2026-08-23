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

**Every line cite in this report is against the file as it stands after the LAST fix round below**
— round 2, §14 onward (each round moved them; the drift itself was round 1's Finding 4):
`callsInvalidate` at `tests/audit-children.test.ts:492`, docblock at `:456`,
`import ts from "typescript"` at `:4`. `typescript` was already a devDependency (5.9.3); nothing was
installed. The signature is unchanged (`(src: string) => boolean`), so both call sites — the
entity-keyed sweep at `:203` and the page-keyed sweep at `:783` — are untouched.

(The cite corrected in the fix round: this said the page-keyed call site was `:488`, which was
`expect(unwired).toEqual([])`. In the Task 1 commit it was `:484`.)

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
(`onSaved={invalidateHistory}`).** Recorded in a comment at `tests/audit-children.test.ts:921` and
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

Added first, run against the old regex before it was replaced. Verbatim, trimmed to the
assertions — the `:567` / `:595` / `:613` in this output are vitest's own, from that transient
tree, and are deliberately left as printed rather than re-numbered:

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

**All seven existing detector cases are kept verbatim** (`:760`) — the two comment forms, the
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

- ~~**The wrapper-tracing half of #188 (part 2) is untouched, by instruction.** No wrapper exists —
  all twelve panel-mounting files mount `<HistoryPanel>` directly …~~ **WITHDRAWN in the fix round
  (§8): that claim was false, and repeating it uncritically here was Finding 1.** Six files render a
  panel-mounting component and were invisible to the census. Part 2 is now built; #188 closes whole.
- **`issuesMutatingRequest` / `MUTATING_TOKEN` / `OPAQUE_METHOD` are still regexes**, by
  instruction. They are deliberately broad and fail CLOSED; `MUTATING_TOKEN` in particular is
  *designed* to match prose, and re-cutting it on the AST is a different decision than this one.
  Note for whoever takes it: an AST rewrite of `MUTATING_TOKEN` would be a *narrowing*, so it would
  need its own allowlist reasoning, not just a parse.
- **The `import { … invalidateHistory … } from "@/components/HistoryPanel"` assertion is still a
  regex** at `:201`–`:202` and `:666`. Left alone deliberately: parsing it would be a second, unrelated
  change, and the pair is coherent as it stands — every way the regex can be wrong about the import
  makes the file fail the *call* check, which is loud (see §2, the aliased-import case).
- ~~**`ts.createSourceFile` recovers from syntax errors rather than throwing**, so an unparseable
  file yields a tree in which the call is most likely not found …~~ **REWRITTEN in the fix round
  (§8, Finding 3).** "Most likely" was doing load-bearing work it could not do: error recovery
  generally *finds* a real call in a file with a syntax error elsewhere, so this was neither the
  closed direction nor a claim worth making. The real backstop is that an unparseable `.tsx` under
  `src/` reds `npx tsc --noEmit` and `npx eslint src tests` in the same gate set, loudly and by
  name. The docblock now says that instead, and `parseDiagnostics` stays unreached — not on a
  hypothetical, but because a stronger check already runs.

## 7. Docs

`CLAUDE.md`'s Audit paragraph, one clause added to the sentence describing the page-keyed sweep:
that "calls `invalidateHistory()`" is decided by **parsing** the file, never by pattern-matching its
text (#188), with the reason and a "do not add a regex back" instruction. No other doc changed —
`docs/HANDOFF.md` takes its one-line update at the group close-out (the Group D precedent,
`9090a4d`), and this amends no spec contract, so §15 is untouched.

---

# Task 1 fix round — the four review findings, and #188 part 2

Four findings, one of them carrying a scope decision from the owner: **close the wrapper gap
mechanically rather than re-wording the comment that denied it.**

## 8. Finding 1 (Important) — the census could not see a panel CONSUMER, and said so was hypothetical

### 8.1 The false claim

`tests/audit-children.test.ts` carried, in the mount cross-check, the sentence *"No wrapper exists
today — every one of the twelve mounts the panel directly."* It was **false**, and #188 deferred the
import-graph walk on that exact premise. Six files consume a panel-mounting component and were
invisible to the census:

| panel-mounting component (in the census) | consumer (was invisible to it) |
|---|---|
| `src/components/ReferenceTable.tsx` | `src/app/admin/reference/page.tsx` |
| `src/app/certs/[id]/CertDetail.tsx` | `src/app/certs/[id]/page.tsx` |
| `src/app/invoicing/[id]/InvoiceDetail.tsx` | `src/app/invoicing/[id]/page.tsx` |
| `src/app/quotes/[id]/QuoteDetail.tsx` | `src/app/quotes/[id]/page.tsx` |
| `src/app/receivables/batches/[id]/BatchDetail.tsx` | `src/app/receivables/batches/[id]/page.tsx` |
| `src/app/shipping/[id]/ShipmentDetail.tsx` | `src/app/shipping/[id]/page.tsx` |

Benign only because all six are 13–25 line shells whose whole body is `<XDetail key={id} id={id} />`.
The premise for deferring was that the shape of the real case was unknown; the shape is a thin keyed
route shell, it is the idiom this repo writes every detail route in, and there are already six.

### 8.2 What was built

The smallest correct thing: **a file that imports a panel-mounting file is folded into the same file
set the existing rules already run over.** No rule changed. Mutating still means "import and call
`invalidateHistory()`"; non-mutating still means an allowlist entry with a reason.

- `valueModuleSpecifiers(src)` (`tests/audit-children.test.ts:254`) — exported and self-tested. Every
  module specifier a file imports **for its value**, taken from the same `ts.createSourceFile` parse
  the detector uses, so a path-shaped string literal is not an import here either.
- `resolveToTsx(fromFile, spec)` (`:300`) — resolves `@/` (the repo's `src/` alias) and relative
  specifiers against real files on disk, trying `.tsx`, `.ts`, `index.tsx`, `index.ts`, and dropping
  anything that is not a `.tsx` under `src/`.
- `tsxImportGraph(files)` (`:316`) and `panelConsumers(graph, mounts)` (`:326`).
- The census in the `#158` describe is now `mountFiles ∪ consumerFiles`. The mount cross-check
  (`<HistoryPanel` tag set vs. `HistoryPanel` import set) still runs over `mountFiles` **only** —
  it is a check on the mount detection, not on the census — and its comment now says that plainly
  instead of claiming no wrapper exists.
- `NON_MUTATING_PANEL_PAGES` (`:506`) carries the six entries, each naming the component the writes
  actually live in.
- `allowlistProblems`' membership message became `not a panel page` (was `mounts no panel`), since a
  census member need no longer mount one itself.

### 8.3 TYPE-ONLY imports are excluded, and that is the load-bearing part

**Measured, not assumed.** A graph counting every import edge answers **sixteen** consumers here, not
six. The ten extras are `orders/[id]/{Certifications,Charges,Containers,Documents,Lines,Loads,
Serials}Section.tsx`, `parts/[id]/IdentitySection.tsx`, `certs/[id]/RequirementBlock.tsx` and
`shipping/[id]/ShipmentOrderPanel.tsx` — every one of which does `import type { … } from` its own
panel-mounting **parent**. That edge points the wrong way: those are child sections of the page, not
wrappers of it, and folding them in would have demanded an allowlist entry per section for a
relationship that does not exist. A type import is erased before anything runs and can never render
the component it names, so it is not an edge. Pinned by eleven synthetic assertions at `:838`
(default/namespace/side-effect/value-re-export/dynamic import count; `import type`, an all-`type`
specifier list, and a type re-export do not; `import { type A, B }` still does).

### 8.4 One level vs. the transitive closure — the decision, and its evidence

**One level, plus an assertion that one level is still enough** (`:616`).

Evidence, from the real graph: **no consumer is itself imported by any `.tsx`.** All six are Next
route entry points (`page.tsx`); the router reaches them by file convention, which is not an import
edge. The fixpoint therefore terminates after one round, and computing the transitive closure over
this tree returns **exactly the same six files** — verified by running both:

```
mounts: 12
one-level consumers (6): [ admin/reference/page.tsx, certs/[id]/page.tsx, invoicing/[id]/page.tsx,
                           quotes/[id]/page.tsx, receivables/batches/[id]/page.tsx,
                           shipping/[id]/page.tsx ]
transitive consumers (6): [ …the same six… ]
SAME? true
--- importers of each one-level consumer: (all six) []
```

The sufficiency assertion is the "two independent ways" trick the file already uses on the mount
set: it names any `.tsx` outside the census that renders a consumer, and asks for the closure by
name. So the day the premise stops holding, the suite says so — which is precisely what did *not*
happen the first time.

### 8.5 RED verification

**(a) The gap was real.** A mutating control added to one of the six shells —
`src/app/certs/[id]/page.tsx`, given a `fetch(…, { method: "DELETE" })` button — and the census **as
shipped at `bcef639`** run against it:

```
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/audit-children-OLD.test.ts (38 tests) 2427ms

 Test Files  1 passed (1)
      Tests  38 passed (38)
```

Green. A DELETE on a panel page, with no `invalidateHistory()` anywhere, and nothing said a word.

**(b) The new census, same broken file, allowlist entry still in place** — the entry stops being
valid and the file is named:

```
 FAIL  tests/audit-children.test.ts > #158 — a page with a panel that mutates must invalidate > every allowlisted page really is a panel page and really does not mutate
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/app/certs/[id]/page.tsx: mutates — remove the allowlist entry",
+ ]
```

**(c) …and with the allowlist entry deleted too**, so the loop cannot be closed green from either
side — the main sweep takes it:

```
 FAIL  tests/audit-children.test.ts > #158 — a page with a panel that mutates must invalidate > every panel page that mutates imports and calls invalidateHistory
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/app/certs/[id]/page.tsx must import invalidateHistory",
+ ]
```

**(d) The sufficiency assertion has been seen to fail.** A throwaway
`src/app/certs/[id]/Wrapper.tsx` rendering `<CertDetailPage />` — a consumer of a consumer:

```
 FAIL  tests/audit-children.test.ts > #158 — a page with a panel that mutates must invalidate > proves ONE level of consumer is enough, and says so the day it stops being
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/app/certs/[id]/Wrapper.tsx renders a panel CONSUMER (src/app/certs/[id]/page.tsx) — one level is no longer enough; make panelConsumers() a transitive closure",
+ ]
```

Every injected file was restored from a byte copy taken before the edit and the throwaway deleted;
`git status` under `erp/` shows only `tests/audit-children.test.ts` modified.

### 8.6 The synthetic allowlist test — kept, and its comment says why

The test titled *"…and that check is not vacuous"* was written because `NON_MUTATING_PANEL_PAGES`
was `{}`, so the real check iterated nothing and passed with zero assertions. **That condition is
gone** — the allowlist now holds six real entries — and the comment now records exactly that: the
test is no longer load-bearing for the reason it was written, and stays anyway because it exercises
the **rule**, not the current data. Each of its three failure shapes is a shape no real entry has,
and emptying the allowlist again (perfectly possible: a shell grows a control and gets wired instead
of exempted) must not silently take the evidence with it. Its title lost "while the allowlist is
empty", which was about to become false.

### 8.7 What this still does not see

Stated in the code and here: a re-export **barrel written as `.ts`** that forwards a panel-mounting
`.tsx`. There is no such barrel in this tree (`src/lib/template-contracts/index.ts` is the only
`index.*` under `src/`, and it re-exports types), and the brief's instruction is to ignore anything
not resolving to a `.tsx` under `src/`. Also unchanged: a mutation issued by an imported helper that
carries none of the mutation tokens in the calling file — the standing limit both sweeps already
declare.

## 9. Finding 2 (Minor) — `CLAUDE.md` mis-attributed the string-literal defect

The clause read *"four defects were injected into these guards by hand-munging source across two
review rounds, **the last of them** counting `const hint = "invalidateHistory()"` as a call."* The
string-literal fail-open is **not** one of those four. #188 enumerates the four (a block-first strip
ate 23,140 characters; a `//`-only strip let a docblock pass; the first `method` guard fired on
prose; a read-only panel page dropped silently); the string literal is the **shipped** behavior #188
was filed about, never injected. The test docblock had this right and the summary did not.

The clause now names all four explicitly and states the string literal separately as the shipped
defect — in the file whose own rule is "count them, never from memory". The same sentence also
gained the part-2 facts: consumers folded in through a parsed value-import graph, the type-only
exclusion and why it is load-bearing, and one-level-plus-sufficiency-assertion.

## 10. Finding 3 (Minor) — the parse-error docblock rested on "most likely"

It claimed an unparseable file *"yields a tree in which the call is most likely NOT found"* — the
closed direction. The reviewer measured that error recovery generally **does** find a real call in a
file with a syntax error elsewhere, and could not construct a fail-open in five attempts. So the
sentence was asserting a safety property it does not have, in the direction of comfort.

Replaced with the backstop that actually exists: **a `.tsx` under `src/` that does not parse reds
`npx tsc --noEmit` and `npx eslint src tests`**, loudly and by name, and both run beside this suite
in the same gate set. Nothing here needs to re-detect a syntax error, and reaching for
`parsed.parseDiagnostics` (an internal API) would duplicate a check that already fails harder.

## 11. Finding 4 (Minor) — cite drift in this report

`§1` cited the page-keyed call site as `:488`; at `bcef639` it was `:484` (`:488` was
`expect(unwired).toEqual([])`). Corrected, and **every cite in §1–§6 re-anchored to the file as it
stands after this fix round**, since the fix-round edits moved all of them:

| was | now | what it points at |
|---|---|---|
| `:319` | `:432` | `callsInvalidate` |
| `:290` | `:396` | its docblock |
| `:203` | `:203` | the entity-keyed call site (unmoved) |
| `:488` → `:484` | `:668` | the page-keyed call site |
| `:609` | `:800` | the property-access design-call comment |
| `:570` | `:760` | the seven kept detector cases |
| `:201` / `:482` | `:201`–`:202` / `:666` | the import assertions, still regexes |

The `:567` / `:595` / `:613` inside §3a's pasted output are vitest's own, printed by a transient
tree that no longer exists; they are left verbatim rather than re-numbered, and §3a now says so.

**Round 2 moved them all again**, and §1–§6 are re-anchored a second time rather than left to rot.
The table above is the record of round 1's re-anchoring, not the current positions; today's are
`:492` (`callsInvalidate`), `:456` (its docblock), `:203` (entity-keyed call site, still unmoved),
`:783` (page-keyed call site), `:921` (the property-access design call), `:881` (the seven kept
detector cases) and `:201`–`:202` / `:781` (the import assertions, still regexes).

§6's first bullet — which repeated the "no wrapper exists" claim uncritically, and asked the PR to
decide whether #188 could be closed on part 1 alone — is struck through and withdrawn. Part 2 is
built; #188 closes whole.

## 12. Gate results (fix round)

| Gate | Result |
|---|---|
| `npx vitest run tests/audit-children.test.ts` | **41 passed / 41** (1 file), 2.67s. Was 38 before the three new fix-round `it` blocks. |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx eslint src tests` | clean, exit 0 |
| `npx vitest run` (full) | **3552 passed / 3552**, **208 files passed / 208**, 444.22s |

`npm run test:e2e` was **not** run, by instruction — Task 2 owns the E2E harness this group and a
concurrent run collides on the dev database and port 3100. This change touches no `src/` file.

## 13. Found and not fixed (fix round)

- **The census now reads the whole `.tsx` tree twice**: once for the `<HistoryPanel` tag scan and
  once to parse the import graph. 115 files; the suite went from 2.43s to 2.67s. Not worth a cache.
- **`resolveToTsx` reimplements a slice of module resolution** (alias + relative + four extensions)
  rather than asking `ts.resolveModuleName`. The real resolver would need the parsed `tsconfig` and
  a compiler host, which is a much larger dependency for a graph whose every edge in this tree is
  one of two trivial shapes — and both shapes are pinned against real files at `:588`. Worth
  revisiting only if a specifier form appears that this cannot follow, which would show up as a
  consumer silently missing rather than as a failure. That is the one place this mechanism can still
  go quiet, and it is the honest residual.
- **`issuesMutatingRequest` / `MUTATING_TOKEN` / `OPAQUE_METHOD` are still regexes**, unchanged from
  §6 and still by instruction.

---

# Task 1 fix round 2 — four minor findings from the second review pass

Two of the four are the same defect one level apart: a comment claiming a limit it had not counted,
and a walk reporting a case it could have covered. Line cites are against the file as it stands
after this round.

## 14. Finding 1 — "the one shape this cannot follow" was itself an over-claim

The `resolveToTsx` docblock named ONE specifier shape the resolver drops silently, in the fix round
whose subject was removing an over-claim. The reviewer measured **four**, and each takes a consumer
out of the census with no failure at all:

| # | shape | now |
|---|---|---|
| 1 | a re-export BARREL written as `.ts` forwarding a `.tsx` | **guard (b)** |
| 2 | a SECOND tsconfig path alias — only `@/` is hardcoded, anything else reads as a package | **guard (a), the alias half** |
| 3 | an EXTENSION-CARRYING specifier (`"./CertDetail.js"`), which `moduleResolution: "bundler"` accepts and `tsc` does not red | **guard (a), the resolution half** — and `"./X.tsx"` now RESOLVES rather than dropping |
| 4 | `require()` or `import(variable)` — no string literal to resolve | stated, unguarded, ESM-only tree (`grep -rn "require(" src` is empty) |

The docblock at `tests/audit-children.test.ts:334` now enumerates all four with which guard covers
each, and says plainly that #4 has none.

### 14.1 The two guards

**(a) `resolves every local import in the tree, so a new alias cannot go quiet` (`:710`).** Two
assertions, and the first is what makes the second complete: `tsconfig.json`'s `compilerOptions.paths`
still holds `@/*` and nothing else — because `isLocalSpecifier` (`:305`) calls every other
non-relative specifier a package and never asks where it lives — then every `@/`-prefixed or
relative **value** specifier in every `.ts`/`.tsx` under `src/` resolves to a real file on disk.

**(b) `has no .ts module forwarding a .tsx` (`:733`).** Guard (a) genuinely cannot catch the barrel:
`index.ts` resolves perfectly well and is then dropped by the `.tsx` filter, so the edge disappears
with nothing said. This one asks the question directly, over all 369 `.ts` files under `src/`.

Both are green today. `resolveToTsx` was split into `resolveLocal` (`:315`, resolves, no filter) and
`resolveToTsx` (`:352`, the graph's edge test), so there is exactly one resolution order and the
guards and the graph cannot disagree about it. `resolveLocal` also tries the specifier **as written**
as a final candidate, which is what makes shape 3 resolve for a `.tsx`/`.ts` spelling and keeps an
asset import (`"./x.css"`) from reading as unresolvable.

### 14.2 RED proof, guard (a) — both halves

**The alias half.** A second `paths` entry added to `tsconfig.json`:

```
   × … > resolves every local import in the tree, so a new alias cannot go quiet
     → add the new alias to resolveLocal: expected [ '@/*', '~components/*' ] to deeply equal [ '@/*' ]
```

**The resolution half.** `src/app/certs/[id]/page.tsx`'s `"./CertDetail"` respelled as
`"./CertDetail.js"` — legal under `moduleResolution: "bundler"`, and `tsc` stays green on it:

```
   × … > resolves every local import in the tree, so a new alias cannot go quiet
     → expected [ Array(1) ] to deeply equal []
+   "src/app/certs/[id]/page.tsx → ./CertDetail.js",
   × … > folds a panel component's CONSUMERS into the census, so a wrapper cannot hide one
     → expected [ …(5) ] to deeply equal [ …(6) ]
```

The second failure is the point: **the consumer silently left the census.** It reds three other
checks here only because that particular file happens to be allowlisted; an unresolvable specifier in
a NON-allowlisted consumer would have been completely quiet, which is why guard (a) names the
specifier itself rather than relying on the downstream noise.

Respelled once more as `"./CertDetail.tsx"`, the suite goes **43/43 green** and the consumer stays in
the census — the trailing-candidate fix for shape 3, verified rather than asserted.

### 14.3 RED proof, guard (b)

A throwaway `src/lib/panel-barrel.ts` holding
`export { CertDetail } from "@/app/certs/[id]/CertDetail";`:

```
   × … > has no `.ts` module forwarding a `.tsx`, the shape the graph genuinely cannot follow
     → expected [ Array(1) ] to deeply equal []
+   "src/lib/panel-barrel.ts → src/app/certs/[id]/CertDetail.tsx: a .ts module carrying a .tsx; teach the graph about it",
```

**Guard (a) stayed green throughout that run** — 42 of 43 passing, this one failure — which is the
demonstration that the two guards are not redundant.

## 15. Finding 2 — the walk is now the transitive closure

`panelConsumers` (`:381`) is a five-line fixpoint: seed with the mounts, keep adding any file that
value-imports something already reached, stop when a round adds nothing. It terminates because
`reached` only grows and is bounded by the graph, so an import cycle is fine.

**The six real consumers still come out as six** — pinned by name in the unchanged census test, which
passes. Both walks answer the same set on this tree (nothing imports a `page.tsx`; the router reaches
route entry points by file convention, which is not an import edge), so promoting the walk changed no
census member. That was verified from the other side too: with the one-level walk temporarily
restored, the six-by-name assertion still passed while only the new property test failed.

**The `:616` sufficiency tripwire is gone**, replaced by a positive test that a two-level consumer IS
found (`:676`) — the property pinned rather than believed. Since this tree cannot exercise it, it
runs on a synthetic graph, exactly as the allowlist rule and the detector do:

- a four-file chain, mount → level 1 → level 2 → level 3, plus a file reaching no panel at all;
- a CYCLE that reaches nothing (answers `[]`, does not hang) and the same cycle reaching the panel
  (both files are consumers);
- a mount is never listed as its own consumer, however it is reached.

The vacuity guards are untouched: the six consumers by name, and one edge per resolution branch
(`@/` alias and relative) asserted against the real graph.

**RED proof.** `panelConsumers` reverted to the shipped one-level body, everything else unchanged:

```
   × … > follows a consumer OF a consumer — the walk is a transitive closure, not one level
     → expected [ 'src/x/page.tsx' ] to deeply equal [ 'src/x/Outer.tsx', …(2) ]
-   "src/x/Outer.tsx",
-   "src/x/Wrapper.tsx",
```

Levels 2 and 3 dropped, level 1 kept — the exact gap, named.

## 16. Finding 3 — the allowlist's passing case is now a real entry

`expect(allowlistProblems({}, …)).toEqual([])` was vacuous for the same reason the test it sits in
was written: an empty record iterates nothing. It is now a **valid entry** — `src/app/certs/[id]/page.tsx`,
a real census member that issues no mutating request, with a reason long enough to be one — so all
three checks are exercised in the passing direction (`:822`). If that shell ever grows a control,
this reds beside the real allowlist check with the same message, which is the correct coupling.

## 17. Finding 4 — `CLAUDE.md` gave the mechanism back

The Audit paragraph's fix-round clause ran ~160 words of mechanism (the four injected defects
re-enumerated, the type-only rationale, "one level plus an assertion"). Replaced with ~55 that keep
the **contract** and drop the reasoning the test file states better:

> **Both halves of that census are PARSED, never pattern-matched (#188)**: the consumers come from a
> `.tsx` value-import graph walked to a transitive closure (type-only edges excluded — a child
> section type-imports its panel-mounting parent, so counting those folds the sections in backwards),
> and "calls `invalidateHistory()`" is a `CallExpression` on the bare identifier. Do not add a regex
> back to either.

Net ~-105 words, which puts the paragraph back at roughly its pre-fix-round length. The contract
sentence above it — *"a client file that mounts a `<HistoryPanel>` — or renders a component that
does — and issues a mutating request must import and call `invalidateHistory()`"* — is unchanged and
is now literally true rather than true-to-one-level, which is why it was written once, at the end.

## 18. Found AND fixed, not in the findings: the script kind was assumed

Guard (b) is the first thing to hand a **`.ts`** file to `valueModuleSpecifiers`, which parsed
everything as `candidate.tsx`. That is not neutral: `const id = <T>(x: T) => x;` is a generic arrow in
a `.ts` file and an **unclosed JSX element** in a `.tsx` one, and the TSX reading **swallows every
import below it**. Measured:

```
generic first     | TS: ["./z"]        | TSX: []
generic then two  | TS: ["./a","./b"]  | TSX: []
```

A guard that answers "no specifiers" is a guard that has gone quiet — the failure mode this whole
sweep is about. So `valueModuleSpecifiers(src, fileName?)` now takes the kind from the filename
(`:269`) and every real call site passes the file it read. Pinned by two assertions that differ only
in the extension.

**This fixed no live miss:** all 369 `.ts` files under `src/` parse identically either way today
(zero specifier-list differences, zero parse diagnostics — measured with a throwaway script against
the real tree). It closes the shape at the moment the shape became reachable, rather than documenting
it as a residual, which is Finding 2's lesson applied without being asked.

## 19. Gate results (fix round 2)

| Gate | Result |
|---|---|
| `npx vitest run tests/audit-children.test.ts` | **43 passed / 43** (1 file). Was 41; +3 new `it` blocks, -1 (the sufficiency tripwire). |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx eslint src tests` | clean, exit 0 |

The full vitest suite and `npm run test:e2e` were **not** run, by instruction — another task in this
group needs quiet CPU for E2E timing measurements. This round touches one test file and one doc; no
`src/` file changed. Every injected file (`tsconfig.json`, `src/app/certs/[id]/page.tsx`,
`tests/audit-children.test.ts`) was restored from a byte copy and the throwaway barrel deleted;
`git status` was checked clean after each RED run.

## 20. Found and not fixed (fix round 2)

- **Shape 4 — `require()` / `import(variable)` — has no guard**, stated at `:334` rather than
  covered. There is nothing to resolve: no string literal reaches `resolveLocal`, so the census loses
  the edge with no specifier to name. A `require(` scan would cover the first half and not the
  second, and this is an ESM client tree (`grep -rn "require(" src` is empty). This is now the one
  place the consumer walk can still go quiet, and it is the honest residual — it replaces the
  `resolveToTsx` residual §13 recorded, which the two new guards have closed.
- **`issuesMutatingRequest` / `MUTATING_TOKEN` / `OPAQUE_METHOD` are still regexes**, unchanged from
  §6 and §13, still by instruction.
- **The census now parses the whole `src/` tree, `.ts` files included** (369 more files, for the two
  new guards). The suite went 2.67s → 2.88s. Still not worth a cache.
