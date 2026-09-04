---
title: Deploy to Cloudflare
description: Deploy OpenStory to Cloudflare Workers with D1 and R2
section: Developer Guide
order: 10
---

OpenStory deploys to Cloudflare Workers, using D1 (SQLite) for the database and R2 for media storage.

## One-Click Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/openstory-so/openstory)

The deploy button clones the repo into your GitHub/GitLab account, provisions the resources declared in `wrangler.jsonc`, prompts for the secrets listed in `.dev.vars.example`, and sets up CI for your copy.

The created repo is an independent clone, not a fork — there's no upstream link for GitHub's "Sync fork" button. To pull future OpenStory updates into a button-deployed copy, add the upstream remote manually (`git remote add upstream https://github.com/openstory-so/openstory && git pull upstream main`). If you'd rather start from a real fork, fork on GitHub first, then connect the fork to [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) in the Cloudflare dashboard (or deploy from a local clone with `bun setup --prod`).

AI keys (`FAL_KEY`, `OPENROUTER_KEY`) are deliberately not part of the deploy prompts — every field in that dialog is mandatory, and a placeholder value would be worse than none. Add them after deploy, either per team in the app (Settings → API Keys) or server-wide with `wrangler secret put`.

## Guided Setup

From your own clone, `bun setup --prod` walks through everything interactively: production env vars (`.env.production`), R2 domains + CORS, optional services, pushing secrets to Cloudflare and GitHub, and the first deploy. `bun setup --deploy` re-runs just the secrets-push + deploy phase, and `bun setup --pr-preview` pushes preview secrets to the GitHub `staging` environment used by PR preview deploys.

## Prerequisites

- A [Cloudflare](https://cloudflare.com) account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency — use `bunx wrangler`)
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` available in your environment

## wrangler.jsonc

Bindings live in [`wrangler.jsonc`](https://github.com/openstory-so/openstory/blob/main/wrangler.jsonc) at the repo root:

- `DB` — D1 database (`openstory-prd`)
- `R2_PUBLIC_ASSETS_BUCKET` — public assets (served via custom domain)
- `R2_STORAGE_BUCKET` — private storage for generated media

The Worker entry point is `src/server.ts` with `nodejs_compat` enabled.

## Build & Deploy

Upstream production (`openstory-so/openstory` → the `openstory` worker) deploys
through [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
— the same mechanism Deploy-to-Cloudflare button clones use, so upstream
dogfoods the exact pipeline users get. Workers Builds is wrangler-authenticated,
so the prod path needs no Cloudflare secrets in GitHub. The dashboard
configuration (the only deploy state not versioned in the repo):

- **Repository / branch**: `openstory-so/openstory`, `main`
- **Build command**: `bun run build`
- **Build env vars**: `CLOUDFLARE_ENV=production` (bakes the
  `[env.production]` block into `dist/server/wrangler.json`),
  `VITE_R2_PUBLIC_ASSETS_DOMAIN`, `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN`,
  `VITE_PUBLIC_POSTHOG_HOST`
- **Deploy command**: `bun run deploy:production` — flatten migrations →
  `wrangler d1 migrations apply DB --env=production --remote` →
  `wrangler deploy`. The plain `wrangler deploy` picks up the flattened
  `dist/server/wrangler.json` via `.wrangler/deploy/config.json`; the
  `--env` flag matters only for the migrate step, which reads the source
  `wrangler.jsonc`.

For a manual deploy from a local checkout:

```bash
# Generate Worker types from wrangler.jsonc
bun cf:typegen

# Deploy to production (typegen, CLOUDFLARE_ENV=production build, migrate, wrangler deploy)
bun cf:deploy:prd
```

## Database Migrations

Remote databases are migrated with `wrangler d1 migrations apply` (tracked in
wrangler's `d1_migrations` table). drizzle-kit only **generates** migrations
(`bun db:generate`); it never touches a remote database.

Because drizzle-kit emits nested `<timestamp>_<name>/migration.sql` files that
wrangler can't read, `scripts/flatten-migrations.ts` renders them to flat
`drizzle/migrations-wrangler/*.sql` (gitignored) first. The relevant scripts
run it automatically:

```bash
bun run deploy             # flatten → wrangler d1 migrations apply DB --remote → wrangler deploy
                           # (what Deploy to Cloudflare button clones run)
bun run deploy:production  # same, but --env=production on the migrate step
                           # (what upstream's Workers Builds runs)
bun db:migrate:prd         # flatten → wrangler d1 migrations apply DB --env=production --remote
```

- **Button deploys**: the `deploy` package script is picked up as the deploy
  command and re-runs on every push, so new migrations apply idempotently. It
  references the binding name `DB` (not the database name) so it works
  whatever the user named their database.
- **Upstream production (Workers Builds)**: `deploy:production` is the
  configured deploy command — identical to `deploy` except the migrate step
  targets the `[env.production]` D1.
- **PR previews**: CI applies migrations with `wrangler d1 migrations apply DB
--remote` after patching the PR's database id into the config.
- **Local dev / e2e**: unchanged — drizzle-orm's migrator applies the nested
  files directly against the Miniflare binding (`bun db:migrate:local`).

Migrations must stay backwards-compatible for the moment between migrate and
deploy, and the D1 table-rebuild CASCADE trap (see CLAUDE.md) applies to every
remote apply path.

## Seeding

There are no CI seed steps: the worker self-seeds system templates on first
request (`src/server.ts` → `src/lib/db/seed-system-templates.ts`). A hash of
the template definitions is stored in `app_metadata`; when it matches, the
check is a single SELECT per isolate, and when it doesn't (fresh database, or
a deploy that changed templates) the idempotent sync runs once. `bun
db:seed:local` / `bun scripts/seed.ts --test` reuse the same module for local
setup.

## Secrets

Secrets are pushed to the Worker via `wrangler secret bulk`. The full list is defined in [`.github/workflows/deploy-cloudflare.yml`](https://github.com/openstory-so/openstory/blob/main/.github/workflows/deploy-cloudflare.yml). Core secrets include:

| Variable                                    | Description                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                        | Better Auth signing secret                                                            |
| `VITE_APP_URL`                              | Public URL of the deployment                                                          |
| `FAL_KEY`                                   | fal.ai API key for image/video generation                                             |
| `OPENROUTER_KEY`                            | OpenRouter API key for LLM script analysis                                            |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials                                                              |
| `EMAIL_FROM`                                | Sender address for transactional email (domain onboarded in Cloudflare Email Service) |

## Prod database cutover (velro-prd → openstory-prd)

One-time runbook for #897: the production D1 predates the project rename (the
account still calls it `velro-prd`) and its migration history lives in
drizzle's `__drizzle_migrations` table, which wrangler doesn't read. D1 has no
rename, so the move is a recreate — which also gives the new database a fully
native `d1_migrations` history with no baselining:

```bash
# 1. Snapshot (also the import source). Quiet window: writes after this are lost.
bunx wrangler d1 export velro-prd --remote --output=backup.sql

# 2. Create the fresh DB and flip wrangler.jsonc to it FIRST:
#    set [env.production].d1_databases[0].database_id to the new DB's id
#    (keep database_name openstory-prd). Unlike `d1 export`/`execute`,
#    `d1 migrations apply` resolves ONLY from wrangler config — it can't
#    look a database up by name, and without the flip `--env=production`
#    would target the old velro id.
bunx wrangler d1 create openstory-prd
# ... edit wrangler.jsonc ...

# 3. Apply all migrations to the empty DB (rebuild-pattern migrations in our
#    history are CASCADE-safe with no rows). Same command prod CI runs:
bun db:migrate:prd

# 4. Data-only import. Three transforms on the raw export:
#    - drop drizzle's tracking rows (that table doesn't exist in the new DB —
#      wrangler's d1_migrations replaces it)
#    - reorder tables parent-first: D1 ingests large files in multiple
#      internal transactions, the dump's single leading
#      `PRAGMA defer_foreign_keys=TRUE` doesn't span them, and the export's
#      alphabetical order (`account` before `user`) fails at a chunk commit
#      with "FOREIGN KEY constraint failed" and rolls the import back.
#      Parent-first order needs no deferral, so chunking can't break it.
bunx wrangler d1 export velro-prd --remote --no-schema --output=data-raw.sql
grep -v '__drizzle_migrations' data-raw.sql > data.sql
bun scripts/reorder-d1-dump.ts data.sql data-ordered.sql
bunx wrangler d1 execute openstory-prd --remote --file=data-ordered.sql

# 5. Commit the wrangler.jsonc flip, merge, deploy. The deploy's
#    `wrangler d1 migrations apply` reports everything already applied.

# 6. Soak, then delete the old DB:
bunx wrangler d1 delete velro-prd
```

**Merge order matters:** run this runbook (through step 4) before merging the
PR that contains the id flip. Merging first isn't destructive — wrangler sees
an empty `d1_migrations` on the old DB, migration #1's `CREATE TABLE` fails
against the existing tables, the file rolls back, and CI fails loudly with
the previous deploy still serving — but it blocks deploys until the cutover
is done.

Existing PR-preview databases also only have drizzle tracking — close and
reopen the PR to get a fresh, wrangler-tracked preview database.

## CI/CD

Production pushes to `main` deploy via Workers Builds (see [Build & Deploy](#build--deploy) above). [`deploy-cloudflare.yml`](https://github.com/openstory-so/openstory/blob/main/.github/workflows/deploy-cloudflare.yml) handles the PR previews, which stay on GitHub Actions because Workers Builds branch previews share production bindings — no per-PR D1 provisioning, no workflow-name namespacing, no teardown on close:

- **PR previews**: each PR gets its own Worker (`pr-<number>`) and D1 database (`openstory-pr-<number>`), with secrets pushed and the preview URL posted as a PR comment. Previews also get namespaced workflows (`*-pr-<number>`) and a video-export container application (`pr-<number>-videoexportcontainer`).
- **Cleanup**: closing a PR deletes the Worker, namespaced workflows, container application, and D1 database. Container apps are account-level and outlive the worker — skipping them blocks reopened-PR redeploys and accrues provisioned instances (see #1052).

## Platform Detection

OpenStory automatically detects the deployment platform:

```typescript
import { getDeploymentPlatform } from '@/shared/utils/environment';

const platform = getDeploymentPlatform();
// Returns: 'cloudflare' | 'local' | 'unknown'
```
