# Repo-hygiene pass — 2026-08-06, riding along with `phase-5a-pricing-invoicing`

Owner-approved hygiene work on documentation and Claude Code configuration only. **No application
code, schema, migration, `erp/src/**`, `erp/tests/**`, or `.superpowers/` file was touched** — this
report is the single new file under `.superpowers/`, and it is gitignored by the `*` rule currently
in `.superpowers/sdd/.gitignore`, so it is not committed.

Files changed: `CLAUDE.md`, `docs/HANDOFF.md`, `docs/history/` (new, 4 files),
`.claude/launch.json`, `.claude/settings.json`, and `erp/.claude/` (deleted).

---

## Task 1 — the dev-server launch config

`.claude/launch.json` hardcoded `/home/cojoa13/Desktop/HeatSynQ/erp`. That user does not exist here
(`ls /home/cojoa13` → no such directory); the repo is at `/home/cjones/Desktop/HeatSynQ`. Residue
from the mid-project machine move.

**Fixed** by resolving the repo location instead of naming it:

```
cd "$(git rev-parse --show-toplevel)/erp" && source ~/.nvm/nvm.sh && nvm use 26 >/dev/null 2>&1 && npm run dev
```

`git rev-parse --show-toplevel` is position-independent inside the working tree — it returns the
same root from the repo root or from `erp/` — so the next machine move cannot break it, and there is
no absolute home directory left in the file. The nvm sourcing and `nvm use 26` are kept exactly as
they were (Node 26 is required — CLAUDE.md, `Dockerfile`, CI), and the `&&` chain stays strict on
purpose: if nvm or Node 26 is missing the config should fail loudly rather than start the dev server
on the wrong Node.

**Verified:** `node -e 'JSON.parse(...)'` parses the file; and the exact command chain, run through
`bash -lc` minus `npm run dev`, resolves to `/home/cjones/Desktop/HeatSynQ/erp` (where `package.json`
exists) with `node -v` → `v26.7.0`.

`erp/.claude/` (the previous agent's workaround config — untracked and, confirmed with
`git check-ignore`, **not** gitignored, so a `git add -A` would have swept it in) was deleted
entirely. The root config is now the single launch config.

## Task 2 — counts removed from CLAUDE.md, plus a rule so they don't come back

Confirmed the counts were stale before changing anything: `ls erp/e2e/flows/ | wc -l` → **15**, not
the 10 the file claimed; the suite is well past 1010.

- `CLAUDE.md:37` — `# vitest, 1010 integration tests against the real erp_test DB` →
  `# vitest integration suite against the real erp_test DB`
- `CLAUDE.md:40` — `# 10 Playwright flows against …` → `# Playwright flows against …` (the rest of
  that line, which explains the DEV-vs-test database and the bundled Chromium, is unchanged)
- The block's lead-in said "Quality gates — **all three** must stay green" over a list of four
  commands; that is the same class of rotting count, so it is now "every one of these must stay
  green".

Added to **Working conventions** (two sentences, as briefed):

> **Maintaining this file.** No counts, totals, or version numbers that ordinary commits move (test
> tallies, E2E flow counts, migration counts) — say what a command does, not how much it currently
> runs; the moving numbers belong in `docs/HANDOFF.md`, where they are dated. Keep it curated at
> roughly its current length: new guidance should displace guidance it supersedes, not be appended
> beneath it.

The **Read first** section also now names `docs/history/` (Task 3) and says a history file is read
only when that phase's detail is needed — so a fresh session knows the detail exists, where it is,
and that it should not read all of it.

Nothing else in CLAUDE.md was touched. The Architecture and "Constraints that will bite you"
sections are byte-identical. File length: 119 → 122 lines.

## Task 3 — HANDOFF split (the main event)

### Before / after

| | lines | words |
|---|---|---|
| `docs/HANDOFF.md` before | **844** | 16,295 |
| `docs/HANDOFF.md` after | **416** | 8,967 |
| `docs/history/` (4 files) | 535 | 8,601 |

The functional problem is solved: at 844 lines / ~41k tokens the file truncated partway through a
single `Read`; at 416 lines / ~9k words it is roughly 13k tokens and reads in one call.

### What moved, and where

All four files were produced by `sed`-extracting exact line ranges and prepending a title plus a
one-line provenance note. **No sentence was edited, reordered, or summarised.** Each file keeps its
original `### 4a.` / `### 4a-prior.` / `### 4b.` heading verbatim, so the many "HANDOFF §4a"
references in the archived specs and plans under `docs/superpowers/` still resolve to the right text.

| New file | Was | Original lines |
|---|---|---|
| `docs/history/2026-08-06-phase-4-certs-shipping.md` | §4a + §9's "Historical — the prompt that started Phase 4" block (as a labelled appendix) | 76–324 and 786–842 |
| `docs/history/2026-08-03-phase-3-orders-and-phase-2c.md` | §4a-prior (Phase 3, all of 2C, the 2B merge, the 2026-08-02 toolchain run) | 328–480 |
| `docs/history/2026-08-01-prisma-7-upgrade.md` | §4b | 482–501 |
| `docs/history/2026-08-01-phases-1-2a-2b-foundation.md` | §4's Phase 1 / 2A / 2B narrative and the "What Phase 1 delivers" list | 50–74 |

Two of these go beyond the three sections named in the brief, deliberately:

- **The Phase 1/2A/2B narrative (lines 50–74)** is a per-phase narrative of the same kind, and §4's
  new shape is "one paragraph per merged phase, pointing at where the full record lives" — leaving
  it in place would have meant either a §4 that contradicts its own rule or a summary that loses
  content. Moving it verbatim loses nothing.
- **§9's "Historical — the prompt that started Phase 4"** (57 lines) was already labelled historical
  in the file itself. It is now an appendix in the Phase 4 history file, with its own provenance line.

### What the new HANDOFF contains

§1–§3 unchanged except two added rows in §2's document map (`docs/history/`, and the per-phase
spec+plan convention). §4 rewritten: the rule first, then the current phase, then one bullet per
merged phase with its merge commit/PR and the history file that holds its full record. §5, §5a, §6,
§6a, §7, §8, §9 and the closing process paragraph all kept.

**The rule is written into the file** at the top of §4, where the next person editing §4 will hit it:

> **The rule that keeps this section readable: when a phase merges, its narrative moves to
> `docs/history/` and §4 keeps one paragraph** — what it delivered, its merge commit/PR, and the
> file its full record now lives in. […] Do not append a new phase narrative here.

It is stated again in §2's `docs/history/` row and in CLAUDE.md's Read-first section.

### Verification that nothing was lost

Two independent checks, both mechanical:

1. **Each history file's body is byte-identical to the block it came from.** For each file,
   `diff <(tail -n +7 <file>) <extracted block>` (and `sed -n '7,255p'` / `tail -n 57` for the
   two-block Phase 4 file) — all five comparisons empty.
2. **The whole original file reconstructs exactly.** Concatenating, in original order, the surviving
   slices of the new HANDOFF (original lines 1–49, 75, 325–327, 481, 502–785, 843–844) with the five
   moved blocks produces a file that `cmp` reports **byte-identical to `git show HEAD:docs/HANDOFF.md`**.
   That is the strong check: it proves both that nothing was dropped and that nothing was silently
   altered in the moved text.

A third check enumerated every edit made to the surviving §5–§9 region —
`diff <(sed -n '/^## 5\. Conventions/,$p' docs/HANDOFF.md) <(original 503–784 + 843–844)` — which
returns exactly the seven intentional changes listed below and nothing else.

### Cross-references repaired (the only edits inside kept sections)

Moving §4a/§4b broke five in-file pointers; all five were repaired, and nothing else in §5–§9 was
touched:

- §5.18's "§4b was the survey" now adds "(§4b is now `docs/history/2026-08-01-prisma-7-upgrade.md`)".
- §6's "owner ping #2 in §4a" → "owner ping #2 in §7 item 5".
- §9's "§4a for where things stand" → "§4 for where things stand".
- §9's "carry §4a's four owner pings" → "carry §7 item 5's four owner pings".
- §9's "§4a lists eleven lessons" → names the Phase 4 history file.

Plus two additions:

- **§7 gained item 5: the four Phase 4 owner pings, copied verbatim** (Page-N-of-M, serial
  re-shipment warning, tear-off overlap, no `User.title`). These are *open owner questions*, i.e.
  current state, and §9 tells the next session to carry them into the PR — so they had to stay in the
  live file rather than only in history. They exist in both places; that duplication is deliberate.
- **§9's lead-in now says the prompt has already been used** — it started Phase 5A, which is in
  flight. The prompt block itself is unedited apart from the pointer fixes above. Without this, a
  fresh session reading "Next up — Phase 5 … paste the block below" could have re-started a phase
  that is already underway.

### Deliberately not done in HANDOFF

- **No Phase 5A status narrative was invented.** §4's current-phase block states only verifiable
  facts: the branch name, and the paths of the 5A spec, plan and execution ledger (all confirmed to
  exist). Describing where the branch stands would have meant assuming — prime directive.
- **§6 (backlog) was kept whole**, at 108 lines the largest remaining section. It contains a lot of
  struck-through, closed material that reads like history, but the brief says keep §6 and several of
  those entries carry the *reasoning* for why something is not done a certain way. Erring toward the
  longer file, as instructed.
- **§6a (the Postgres 18 record) was kept** even though its title reads like a post-mortem — it holds
  the still-unused recipe for upgrading a *production* deployment, which is forward-looking.
- **§5, §7, §8 kept in full.**

This is why the result is 416 lines rather than the ≤250 target: everything still in the file is a
section the brief says to keep, and cutting further would have meant deleting live context rather
than relocating history. The real goal — the file fits in one read — is met with room to spare.

## Task 4 — permission friction

Seven entries added to the existing `allow` array in `.claude/settings.json`; the array's existing
entries, the `hooks` block, and the file's structure are untouched.

```
"Bash(npx prisma migrate status)",   read-only
"Bash(npm run build)",               idempotent, no DB
"Bash(npm run test:e2e)",            runs against the DEV db, as documented
"Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"
```

The four git entries use Claude Code's documented `:*` prefix form so they match the bare command as
well as the argumented one (`git status` and `git status --short`); the file's older ` *` entries
were left exactly as they are. Nothing added writes to a database, pushes to a remote, or deletes:
no `git add`/`commit`/`push`, no `prisma migrate deploy`, no `db:seed`, no `docker compose`.

---

## Final checks

- All three `.claude/*.json` files parse (`JSON.parse` via `node -e`).
- `cd erp && npx eslint src tests` → clean, exit 0 (sanity only; no code was changed).
- The full test suite was **not** run, per the brief.
- Nothing under `.superpowers/` (other than this new, gitignored file), `erp/src/`, `erp/tests/`,
  `prisma/`, or any migration was read-modified. `.superpowers/sdd/.gitignore` shows as modified in
  `git status` — that is another agent's change and was not staged or touched.

## Concerns for the caller

1. **HANDOFF is 416 lines, not ≤250.** Reasoning above. If the owner wants it shorter, the honest
   next cut is §6's closed/struck backlog entries → a `docs/history/` backlog archive, but that is a
   judgment call about live context and was not mine to make unasked.
2. **`docs/HANDOFF.md` does not describe the in-flight Phase 5A work** beyond naming its branch,
   spec, plan and ledger. Whoever finishes 5A should write its one paragraph into §4 at merge — and
   at that point §9's kickoff prompt should be replaced with the next slice's.
3. Archived specs and plans under `docs/superpowers/` still say "HANDOFF §4a/§4b". Those documents
   are historical records and were not rewritten; the history files keep the original headings, so
   the references still land on the right text.
