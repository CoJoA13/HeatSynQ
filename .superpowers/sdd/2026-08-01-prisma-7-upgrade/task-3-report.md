# Task 3 report: production Docker image under Prisma 7

## Status: DONE_WITH_CONCERNS (a real bug was found and fixed)

The brief predicted the image build would need scrutiny for the generated-client layout.
It did — and it built cleanly. But the **runtime check** (added to this task's scope by
the dispatch, on a reviewer's recommendation) found a genuine break: the container could
not run `prisma migrate deploy` at all under Prisma 7. That was fixed. Details below,
reported honestly per instructions, including the initial failure.

## Step 1 — Build

```
cd erp
docker compose --profile prod build app
```

Succeeded, both with normal cache and with `--no-cache` (ran both). Confirmed via a
`--no-cache` build log that the Dockerfile ordering is intact:

```
#13 [build 5/5] RUN npx prisma generate && npm run build && npm prune --omit=dev
#13 0.919 Loaded Prisma config from prisma.config.ts.
#13 0.958 Prisma schema loaded from prisma/schema.prisma.
#13 1.103 ✔ Generated Prisma Client (7.9.1) to ./prisma/generated/prisma in 100ms
...
#13 1.203 > erp@0.1.0 build
#13 1.203 > next build
...
✓ Generating static pages (25/25)
```

`prisma generate` runs and completes, writing to `./prisma/generated/prisma`, before
`next build` starts — ordering matches the brief's expectation.

## Watch-item 1: generate-then-build ordering — CONFIRMED intact

Dockerfile line 16: `RUN npx prisma generate && npm run build && npm prune --omit=dev`.
Unchanged, and the `--no-cache` log above proves `generate` completes and the client
files exist before `next build` needs them.

## Watch-item 2: `@prisma/adapter-pg` survives `npm prune --omit=dev` — CONFIRMED

Inside the built run image:

```
$ docker run --rm erp-app:latest node -e "console.log(require('./package.json').dependencies['@prisma/adapter-pg'])"
7.9.1
$ docker run --rm erp-app:latest sh -c "test -d node_modules/@prisma/adapter-pg && echo FOUND"
FOUND
```

## Step 3 — Run it (the extended check)

### First attempt — FAILED

```
docker compose --profile prod up -d app
docker compose --profile prod logs app
```

Verbatim log (container was in a restart loop, this repeated on every retry):

```
Prisma schema loaded from prisma/schema.prisma.
Error: The datasource.url property is required in your Prisma config file when using prisma migrate deploy.
npm notice
npm notice New major version of npm available! 10.9.8 -> 12.0.2
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
npm notice To update run: npm install -g npm@12.0.2
npm notice
Prisma schema loaded from prisma/schema.prisma.
Error: The datasource.url property is required in your Prisma config file when using prisma migrate deploy.
```

This is exactly the kind of v7-specific startup break the dispatch flagged as the real
risk. I stopped and diagnosed rather than guessing.

### Root cause (confirmed with evidence, not speculation)

Task 2's Prisma 7 migration moved the datasource URL out of `schema.prisma`'s
`datasource` block (now just `datasource db { provider = "postgresql" }`, no `url`) and
into `prisma.config.ts` (`datasource: { url: env("DATABASE_URL") }`). Under Prisma 7,
`migrate deploy` reads that URL from the config file, not the schema.

The Dockerfile's run stage copies `.next/standalone`, `.next/static`, `public`,
`prisma/` (the directory — migrations, schema, seed, generated client) and
`node_modules`, but **never copied `prisma.config.ts`** (a top-level file, not inside
`prisma/`). So in the run image, `/app/prisma.config.ts` did not exist:

```
$ docker run --rm --network erp_default -e DATABASE_URL=... erp-app:latest sh -c 'ls -la /app/prisma.config.ts'
ls: /app/prisma.config.ts: No such file or directory
```

`DATABASE_URL` itself was present correctly in the container environment (verified) —
the problem was purely that the CLI had no config file telling it where to look for
that variable.

I confirmed the hypothesis by manually writing `prisma.config.ts` into a throwaway
container (same image, same env) and re-running `migrate deploy`: it immediately
succeeded, found the datasource, saw 8 migrations, reported none pending. That
confirmed the fix before touching the Dockerfile.

### Fix applied (Dockerfile change)

Added one `COPY` line plus an explanatory comment to the run stage, right after the
existing `COPY --from=build /app/prisma ./prisma` line:

```dockerfile
COPY --from=build /app/prisma ./prisma
# Prisma 7 moved the datasource URL out of schema.prisma's `datasource` block (no more
# `url = env("DATABASE_URL")` there) and into prisma.config.ts's `datasource.url`. `prisma
# migrate deploy` reads the config file, not the schema, for that URL, so prisma.config.ts
# has to ship in the run image too — without it the CLI fails at container start with
# "The datasource.url property is required in your Prisma config file when using prisma
# migrate deploy," even though DATABASE_URL is set correctly in the environment.
COPY --from=build /app/prisma.config.ts ./
# `prisma migrate deploy` at container start needs the full "prisma" CLI. ...
```

This is a minimal, single-purpose, evidence-backed addition — not an opportunistic
Dockerfile "improvement." I judged it in scope because: (a) the dispatch explicitly
extended this task to include a real runtime check specifically to catch v7 startup
breaks, (b) the task's own brief pattern for the build step is "if it failed, fix and
re-run," and (c) the dispatch's own precedent (the SELinux `:z` mount clause) treats a
genuinely necessary Dockerfile/compose fix discovered during this verification as in
scope, to be made minimally and reported. Leaving the image provably broken would not
have satisfied the task's actual goal ("verify the production Docker image still
builds AND runs").

### Rebuild and re-verify — PASSED

```
docker compose --profile prod build app   # succeeded again
docker compose --profile prod up -d app
docker compose --profile prod ps
```
```
NAME        IMAGE      COMMAND                  SERVICE   STATUS
erp-app-1   erp-app    "docker-entrypoint.s…"   app       Up 5 seconds
erp-db-1    postgres:16 "docker-entrypoint.s…"  db        Up 3 hours (healthy)
```

Verbatim container log after the fix:

```
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "erp", schema "public" at "db:5432"

8 migrations found in prisma/migrations


No pending migrations to apply.
npm notice
npm notice New major version of npm available! 10.9.8 -> 12.0.2
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
npm notice To update run: npm install -g npm@12.0.2
npm notice
   ▲ Next.js 15.5.22
   - Local:        http://8e64ec383444:3000
   - Network:      http://8e64ec383444:3000

 ✓ Starting...
 ✓ Ready in 200ms
```

Exactly matches the expected behavior: schema already up to date, 8 migrations, none
pending, then the standalone server starts and reports Ready.

### HTTP check

**Note on the dispatch's suggested URL:** `docker-compose.yml`'s `app` service publishes
`ports: ["80:3000"]` — host port **80**, not 3000. `curl http://localhost:3000/login` as
literally written in the dispatch fails with connection refused (nothing listens on host
3000); that's a discrepancy in the dispatch instructions, not an app problem. The correct
host port per the compose file is 80:

```
$ curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:80/login
200
$ curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/login
curl: (7) Failed to connect to localhost port 3000 after 0 ms: Could not connect to server
000
```

HTTP 200 on port 80 confirms the standalone server booted with the v7-generated Prisma
client resolved correctly and served the login page.

## Dockerfile's Prisma-6 comment about `@prisma/config`/`effect` — STILL ACCURATE under 7.9.1

Evidence gathered directly from the built run image (after `npm prune --omit=dev`):

```
$ docker run --rm erp-app:latest sh -c "test -d node_modules/@prisma/config && echo FOUND"
FOUND
$ docker run --rm erp-app:latest sh -c "test -d node_modules/effect && echo FOUND"
FOUND
$ docker run --rm erp-app:latest sh -c "test -d node_modules/c12 && echo FOUND"
FOUND
$ docker run --rm erp-app:latest sh -c "test -d node_modules/deepmerge-ts && echo FOUND"
FOUND
$ docker run --rm erp-app:latest sh -c "test -d node_modules/empathic && echo FOUND"
FOUND
$ docker run --rm erp-app:latest sh -c "node -e \"console.log(require('./node_modules/prisma/package.json').version)\""
7.9.1
```

`@prisma/config` still exists as its own package (not folded into `prisma` or
`@prisma/client` in v7) and pulls in `effect`, `c12`, `deepmerge-ts`, and `empathic`,
which npm still hoists to top-level `node_modules` rather than nesting them under
`@prisma/config`. The comment's technical claim is unchanged under 7.9.1. I did not
delete or rewrite it — I did not test the counterfactual (cherry-picking only
`node_modules/prisma` + `node_modules/@prisma`) since that would require a second,
throwaway Dockerfile variant outside this task's minimal-change mandate, and the direct
evidence (packages present, CLI works when the full `node_modules` is copied) is
sufficient to confirm the comment's claim without disproving it by omission.

## Teardown

```
docker compose --profile prod down
docker compose up -d db
docker compose ps
```

No `-v`/`--volumes` flag used. `docker compose down` (even scoped `--profile prod down`)
stops the whole compose project including non-profiled services, so `erp-db-1` stopped
too as a side effect — expected, and it was immediately restarted per the teardown
instructions.

Final state:

```
NAME       IMAGE         SERVICE   STATUS
erp-db-1   postgres:16   db        Up 12 seconds (healthy)
```

```
$ docker exec erp-db-1 psql -U erp -d erp -tAc "SELECT count(*) FROM \"User\";"
1
```

`erp-db-1` is running and healthy; the `erp` database still has its data (at least 1
user); the `erp_dbdata` named volume was not touched.

## Files changed

- `erp/Dockerfile` — added one `COPY --from=build /app/prisma.config.ts ./` line and an
  explanatory comment to the run stage. This was necessary, not opportunistic: without
  it the production image cannot start under Prisma 7.

Committed as `155e796` — "fix: copy prisma.config.ts into the production run image".

No other files were touched. No SELinux `:z` mount issue was encountered (the `db-init`,
`backup.sh`, and `backups` mounts worked fine throughout), so that documented fallback
was not needed.

## Concerns

1. **This is a real functional bug that would have shipped.** Before this fix, the
   Prisma-7-upgraded production image could not start at all — every container restart
   attempted and failed `migrate deploy` in a crash loop. `npm run build` on the host and
   the image *build* both looked completely healthy; only an actual container run
   surfaced it. This validates the dispatch's decision to add the runtime check to this
   task rather than trusting Step 1 (build-only) alone.
2. **The dispatch's suggested curl target (`localhost:3000`) does not match this repo's
   `docker-compose.yml`** (`ports: ["80:3000"]`). Verified against port 80 instead; noted
   above so this doesn't get treated as an app failure in a future run.
3. Did not exhaustively re-verify the full `npm test` / `tsc` / `eslint` gates for this
   task — out of scope per the brief (Docker-image verification only), and those are
   presumably covered by other tasks in this branch.

---

## Addendum — code review follow-up: two more runtime-dependency findings

The reviewer approved the `Dockerfile` fix (spec + quality) but flagged that the same bug
class — something the container needs at runtime that the production dependency graph
doesn't actually guarantee — was visible in evidence I'd already gathered but hadn't
surfaced. I'd checked that `dotenv` was present in the pruned run image and stopped there,
without asking *why* it survived `npm prune --omit=dev` despite being a devDependency.
That "why" was the finding. Scope was widened to include `erp/package.json`.

### Finding 1 — `dotenv` misclassified as a devDependency

`prisma.config.ts:1` runs `import "dotenv/config"` at every container boot (it's loaded
by the Prisma CLI when `migrate deploy` reads the config file). `dotenv` was declared only
in `devDependencies`, which `npm prune --omit=dev` strips from the run image. It was
present in my Task 3 checks purely by accident: `prisma -> @prisma/config -> c12` has its
own `dotenv` dependency (`^17.3.1`), which npm hoists to the same top-level
`node_modules/dotenv` and which happened to satisfy the version range. If a future Prisma
release drops `c12`, or `c12` drops its `dotenv` dependency, the run image reproduces the
exact `migrate deploy` crash loop fixed in commit `155e796`, silently, with no host gate
(`npm test`, `tsc`, `eslint`, `npm run build`) able to catch it.

### Finding 2 — `tsx` misclassified as a devDependency, with no accidental rescue

`prisma.config.ts` declares `migrations.seed: "tsx prisma/seed.ts"`. `tsx` was also
devDependency-only, and unlike `dotenv`, nothing in the production dependency graph pulls
it in transitively — it was verified absent from the pruned run image. This doesn't affect
the container's boot path (`CMD` only runs `migrate deploy && node server.js`, never
`db seed`), so it wasn't a crash-loop risk. But it does break
`docker compose exec app npx prisma db seed` — the natural, documented way to seed the
initial `admin`/`admin` user on a fresh self-hosted install of this ERP — which would fail
with `tsx: not found`.

### Fix

Moved both `dotenv` (`^17.4.2`) and `tsx` (`^4.23.1`) from `devDependencies` to
`dependencies` in `erp/package.json`, preserving their exact existing version ranges, and
kept `dependencies` alphabetically sorted per the file's existing convention. Then ran
`npm install` to regenerate `package-lock.json`.

**Lockfile diff stat:**

```
$ git diff --stat package.json package-lock.json
 erp/package-lock.json | 33 ++-------------------------------
 erp/package.json      |  4 ++--
 2 files changed, 4 insertions(+), 33 deletions(-)
```

Confirmed the lockfile change is a pure reclassification: the root manifest's
`dependencies`/`devDependencies` blocks moved the two entries, and the only other diff
hunks are `"dev": true` markers being dropped from `dotenv`, `tsx`, `tsx`'s own `esbuild`
dependency, and `esbuild`'s optional `fsevents` dependency (all now reachable from
production `dependencies`). No `"version"` field changed anywhere in the lockfile — zero
version bumps.

### Rebuild and evidence (step 3 of the review's instructions)

```
$ cd erp && docker compose --profile prod build app
...
 Image erp-app Built
```

```
$ docker run --rm --entrypoint sh erp-app:latest -c "ls -d node_modules/dotenv node_modules/tsx && node_modules/.bin/tsx --version"
node_modules/dotenv
node_modules/tsx
tsx v4.23.1
node v22.23.2
```

Both directories exist and `tsx --version` runs successfully — they now survive
`npm prune --omit=dev` on their own account (declared production dependencies), not by
accident of a transitive graph that could shift.

### Boot re-check (step 4 — confirm nothing regressed)

```
$ docker compose --profile prod up -d app
$ docker compose --profile prod logs app
```

Verbatim:

```
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "erp", schema "public" at "db:5432"

8 migrations found in prisma/migrations


No pending migrations to apply.
npm notice
npm notice New major version of npm available! 10.9.8 -> 12.0.2
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
npm notice To update run: npm install -g npm@12.0.2
npm notice
   ▲ Next.js 15.5.22
   - Local:        http://7d2ed7f4d35a:3000
   - Network:      http://7d2ed7f4d35a:3000

 ✓ Starting...
 ✓ Ready in 203ms
```

```
$ curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:80/login
200
```

Same "8 migrations found / no pending" and a 200 — no regression from the dependency
reclassification.

### Teardown (step 5)

```
$ docker compose --profile prod down     # never -v / --volumes
$ docker compose up -d db
$ docker compose ps
```

```
NAME       IMAGE         SERVICE   STATUS
erp-db-1   postgres:16   db        Up 3 seconds (health: starting)
```

```
$ docker exec erp-db-1 psql -U erp -d erp -tAc "SELECT count(*) FROM \"User\";"
1
```

`erp-db-1` up and healthy; `erp` database data intact (>= 1 user); `erp_dbdata` volume
untouched.

### Host gates (step 6 — required because `package.json` changed)

All four run from `erp/`, verbatim results:

```
$ npm test
 Test Files  30 passed (30)
      Tests  255 passed (255)
```

```
$ npx tsc --noEmit
(no output — clean)
```

```
$ npx eslint src tests
(no output — clean)
```

```
$ npm run build
   ✓ Compiled successfully
   ✓ Generating static pages (25/25)
(same 25-route build manifest as before, no errors)
```

All four gates green. 255 tests passed, matching the expected count.

### Files changed (this addendum)

- `erp/package.json` — moved `dotenv` and `tsx` from `devDependencies` to
  `dependencies`, exact same version ranges, alphabetically ordered.
- `erp/package-lock.json` — regenerated via `npm install`; pure reclassification, no
  version bumps (verified above).

Committed as `74c0751` — "fix: reclassify dotenv and tsx as production dependencies",
separate from the `155e796` Dockerfile commit, per instructions.

### Lesson applied

Per the coordinator's note: "when you verify that something is present, ask why it is
present." My original Task 3 check for `dotenv` confirmed presence but not guarantee —
those are different claims, and I'm now reporting the distinction explicitly rather than
letting "it was there" stand in for "it will keep being there."
