---
name: gates
description: Run the full HeatSynQ quality-gate chain in order — vitest suite, tsc, eslint, build, and (optionally) the Playwright E2E flows — and report one pass/fail table. Use before commits worth trusting, before reviews, and before any merge claim.
---

# Run the quality gates

All commands from `erp/`; `nvm use 26` first. Report a table at the end: gate, result,
timing, and the one-line failure summary for anything red. Stop early only on a failure
that makes later gates meaningless (a failed `generate` or DB down); otherwise run all
and report everything.

## The chain

```bash
cd erp
npm test                 # vitest — full suite against the real erp_test DB (serial; never parallelize)
npx tsc --noEmit
npx eslint src tests e2e scripts prisma   # every directory holding lintable source — keep in step with ci.yml
npm run build            # the standalone build the Docker image ships
```

## E2E (when asked, or before a merge claim)

Needs the dev server and the DEV database (`erp`, not `erp_test`):

```bash
npm run test:e2e         # the whole Playwright flow suite, bundled Chromium
```

If flows fail on selectors, remember the §5a traps: React controlled inputs expose no
`value` attribute, and the Shell's global search box collides with page-level search
placeholders — dump inputs before guessing. E2E fixtures must be cleaned from the dev DB
by the harness; verify no `E2E`-fixture rows remain if a run aborted midway.

## Preconditions worth checking on a cold start

```bash
docker compose up -d db          # both databases
npx prisma generate              # client is gitignored
npx prisma migrate status        # and again with the erp_test DATABASE_URL
```
