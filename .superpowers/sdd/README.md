# This directory is scratch. The durable execution record lives in `docs/execution/`.

**From Phase 5A (2026-08-06), a phase's task briefs, implementer reports, reviewer verdicts and
progress ledger are written to `docs/execution/<date>-<phase>/`, not here.**

Why: `.superpowers/sdd/.gitignore` is owned and rewritten by the superpowers SDD skill machinery.
It has been clobbered back to a bare `*` repeatedly — observed twice across sessions and once
*within* a single session — and a bare `*` makes every **untracked** file underneath invisible to
`git status` and `git add`. That is how Phase 3's execution record was lost outright, and how
Phase 5A's was nearly lost. Restoring the file by hand does not hold, because the thing that
rewrites it runs again.

Two facts make `docs/execution/` the fix rather than a preference:

- Git applies ignore rules **only to untracked paths**. Once a file is committed it is permanently
  immune to any later `.gitignore` change — so the whole exposure window is "created but not yet
  committed," which is exactly the window a long phase sits in.
- Nothing rewrites `docs/`. A nested `.gitignore` always beats the root one for paths beneath it,
  so the root `.gitignore`'s `!.superpowers/sdd/` cannot rescue files under this directory. Moving
  out from under the skill-owned path is the only durable fix.

**What still belongs here:** the `review-*.diff` packages, which are disposable — each one is a
`git diff` between two commits already in history and regenerates from
`scripts/review-package BASE HEAD`. They stay ignored on purpose.

**Historical phases (Prisma 7 upgrade, Phase 3, Phase 4) remain in this directory** and are already
committed, so they are immune where they sit. They are left alone deliberately: moving them would
break the paths that `docs/history/*.md` cites, for no gain.
