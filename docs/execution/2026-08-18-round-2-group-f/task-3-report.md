# Task 3 report — #30 (CI builds and boots the Docker image) + #112 (README practice-seed fix)

Implementer report, Round 2 Group F, branch `group-f-infra`.

## What changed

### `.github/workflows/ci.yml` — new parallel `docker` job (#30)

Added a second job `docker` alongside `ci`, per the recon's job YAML (used verbatim as the base):
checkout → `cp .env.example .env` → `docker compose up -d --wait db` → `docker build -t
heatsynq-app:ci .` → `docker run -d --name app-boot --network erp_default` with
`DATABASE_URL=postgresql://erp:erp_local_dev@db:5432/erp` → a 60×3s curl retry loop against
`/api/health`, with a fail-fast branch that dumps `docker logs` if the container exits before
becoming healthy, and a timed-out branch that also dumps logs. YAML comments state the deliberate
choices briefly:

- **Separate parallel job** — the main job runs 12+ min against its 15-min cap; serial risks the
  timeout, parallel costs no wall clock.
- **No path filter** — the image bakes the whole app; filtering would recreate the #16 blind spot
  in reverse.
- **No caching** — boring first; the buildx + `type=gha` upgrade is noted in the comment for later
  if it proves slow.
- **Why the DB is required at all** — the stock CMD runs `npx prisma migrate deploy` before
  `node server.js`, so a DB-less boot is impossible by design; a 200 from `/api/health`
  (unauthenticated, `SELECT 1`) proves container start + migrations applied + Next standalone
  serving + the pg adapter connecting.

The job carries its own `defaults.run.working-directory: erp` block (redundant with the
workflow-level default, kept because the recon wrote the job self-contained). The existing `ci`
job is untouched. `python3 -c "yaml.safe_load(...)"` confirms the file parses; jobs: `[ci, docker]`.

### `erp/README.md` — two fixes (#112)

1. **Practice copy step 3 (was lines 74–77):** replaced the broken parenthetical ("or run
   `npm run db:seed:demo` inside the `app-practice` container") with the recon's exact replacement
   wording: from-checkout invocation, same-constraint-as-production sentence ("the pruned image
   ships neither `tsx` nor `src/`, so `npm run db:seed:demo` cannot run there").
2. **Production step 3 adjacent stale claim (was lines 53–57):** the old text claimed "`tsx` and
   `dotenv` themselves *are* in the pruned image now, as production dependencies … verified by
   running `npm run db:seed` inside a built image, which gets past module resolution for both".
   Half wrong, and empirically disproven against the image built for this task (evidence below):
   `dotenv` IS a production dep and ships; `tsx` is dev-only, is pruned away, container start
   does not need it, and an in-container `npm run db:seed` dies on `tsx: not found` before it
   would even reach the `src/` import. Reworded accordingly, keeping the "seeding does not work
   in-container" bottom line.

## Watched local verification (the gate for this task — no tests, yaml+docs)

Run on this machine from `erp/`, with the compose db (`erp-db-1`) up on network `erp_default`,
executing the exact command sequence the CI job runs. Every run was watched to completion.

### 1. Image build

```
$ docker build -t heatsynq-app:ci .
...
#12 15.33 ƒ Proxy (Middleware)
#12 15.33 ƒ  (Dynamic)  server-rendered on demand
...
#20 naming to docker.io/library/heatsynq-app:ci done
#20 unpacking to docker.io/library/heatsynq-app:ci 4.4s done
#20 DONE 21.2s
BUILD EXIT: 0
$ docker image ls heatsynq-app:ci --format '{{.Repository}}:{{.Tag}} {{.Size}}'
heatsynq-app:ci 1.51GB
```

### 2. Boot + health check (throwaway container `app-boot-local`)

```
$ docker run -d --name app-boot-local --network erp_default \
    -p 127.0.0.1:3000:3000 \
    -e DATABASE_URL=postgresql://erp:erp_local_dev@db:5432/erp \
    heatsynq-app:ci
58bee8c65ff27d4c260e54bea00eaf3e870d4526b5bde2798501358281d95fba
curl: (56) Recv failure: Connection reset by peer
boot check passed on iteration 2

$ curl -fsS http://127.0.0.1:3000/api/health
{"ok":true,"db":true}

$ docker logs app-boot-local
Loaded Prisma config from prisma.config.ts.
Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "erp", schema "public" at "db:5432"
50 migrations found in prisma/migrations
No pending migrations to apply.
▲ Next.js 16.2.12
- Local:         http://58bee8c65ff2:3000
✓ Ready in 0ms
```

The iteration-1 connection reset is the server not yet listening — exactly what the retry loop
absorbs. **Caution honored, as the brief anticipated:** the boot container's CMD ran
`npx prisma migrate deploy` against the DEV database `erp` (the same DB `npm run dev` setups use);
all migrations were already applied there, so it was a **no-op apply** ("No pending migrations to
apply") — no state was changed. In CI the compose db volume is fresh, so the same step applies all
50 migrations there, which is why the CI loop budget is 60×3s while the local run passed in ~5s.

### 3. tsx-absence evidence (#112, against this exact image)

```
$ docker run --rm --entrypoint sh heatsynq-app:ci -c 'ls node_modules/.bin | grep tsx; true'
(no output — no match)
$ docker run --rm --entrypoint sh heatsynq-app:ci -c 'test -d node_modules/tsx && echo PRESENT || echo ABSENT'
tsx package ABSENT
$ docker run --rm --entrypoint sh heatsynq-app:ci -c 'test -d node_modules/dotenv && echo PRESENT || echo ABSENT'
dotenv package PRESENT
$ docker run --rm --entrypoint sh heatsynq-app:ci -c 'npm run db:seed 2>&1 | head -20; true'
> erp@0.1.0 db:seed
> tsx prisma/seed.ts
sh: tsx: not found
```

The last command is the decisive one for the stale claim: the in-container seed fails on
`tsx: not found` immediately — it never reaches module resolution of the `src/` import the old
text said it "gets past".

### 4. Cleanup

```
$ docker rm -f app-boot-local && docker rmi heatsynq-app:ci
Untagged: heatsynq-app:ci
Deleted: sha256:7bf25d99...
```

`git diff --check` clean (no whitespace damage). The compose db was already running before this
task and was left running.

## Deltas between the local run and the CI yaml (reviewer attention)

1. **Container name:** locally `app-boot-local` (throwaway, to avoid colliding with anything);
   the CI yaml uses `app-boot`. The `docker ps -q -f name=` filter was adjusted to match. No
   other difference — host port 3000 was free locally, so the exact `-p 127.0.0.1:3000:3000`
   mapping and the exact network/DATABASE_URL were used.
2. **Fresh vs migrated DB:** locally the `erp` DB pre-existed fully migrated (no-op apply); in CI
   `db-init/` creates it fresh and all migrations apply during the boot. The 60×3s budget covers
   that; the fail-fast container-exited branch covers a migrate failure with logs.
3. **Migration count:** the container reported **50** migrations found, and
   `ls -d prisma/migrations/*/ | wc -l` = 50 on this branch — the recon's "51" is off by one.
   Nothing in the committed changes states a count (deliberately — CLAUDE.md's no-moving-numbers
   rule), so this is a recon-doc nit only.
4. **`docker compose up -d --wait db` was not re-run locally** — the db was already up with the
   `erp_default` network from normal dev use, which is the state that step produces. The step
   itself is byte-identical to the existing `ci` job's, exercised on every CI run today.

## Not done / out of scope

- No vitest/tsc/eslint runs (other tasks own those surfaces, per the brief's gates).
- No E2E (doc/CI-only change; no UI, function, or flow touched — recon's cross-issue note).
- No `.dockerignore` addition for `e2e-artifacts/` (recon flagged it as optional and irrelevant
  in CI; left alone to keep the diff scoped).
- No compose `app` healthcheck (recon notes it as separate/optional; not part of #30's check).
