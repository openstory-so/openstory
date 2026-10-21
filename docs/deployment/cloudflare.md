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

The Worker entry point is `src/server.ts`. `nodejs_compat` is listed and, from compatibility date `2026-08-04`, also on by default.

## Compatibility date

`compatibility_date` is `2026-10-08` (#1999). The production and test env blocks inherit it. PR preview deploys patch the default block in place and keep the date. `src/platform/server/compatibility-date.test.ts` fails if the app Worker declares any other date.

That date is the newest `workerd@1.20261001.1` (Wrangler 4.147.0) will start. A later date, including the calendar day of the change, makes local dev and e2e fail with "the newest date supported by this server binary is 2026-10-08". The flag set matches any date through `2026-11-16`: the last behavior change on or before `2026-10-08` is `durable_object_io_tasks_prevent_eviction` on `2026-10-01`. Move the date forward when a Wrangler upgrade ships a workerd that accepts it.

Two later defaults stay off: `cache_option_preserves_cache_control` and `pipe_to_backward_propagation`, both `2026-11-17`. The log-forwarder Worker in `workers/posthog-log-forwarder/wrangler.jsonc` is a separate script and stays on `2025-11-18`.

`enable_request_signal` stays in `compatibility_flags`. It has no default date. Realtime listens on `request.signal` so a disconnected SSE client drops its Durable Object subscription and heartbeat (`docs/developer-guide/workflow.md`). `nodejs_compat` stays in the list too. At this date Wrangler ignores it as redundant, because `2026-08-04` enables `nodejs_compat` and `nodejs_compat_v2` on its own.

No opt-out flag was added. These are the behavior changes between `2025-11-18` and `2026-10-08` that the code was checked against. Source: [Cloudflare's compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/).

- **`enable_fast_jsg_struct` (`2025-12-03`).** Optional fields on runtime structs are present and `undefined`. Value checks (`value !== undefined`) still work. A presence check (`"key" in obj`) does not. `serveFile` used `"suffix" in range` for `Content-Range`, so a video range request answered `bytes NaN-NaN/…` and the browser reported `MEDIA_ELEMENT_ERROR: Format error`. It now reads `suffix` only when it is a number (`content-range.ts`).
- **Node stubs (`2025-12-04` through `2026-03-17`).** `node:cluster`, `node:domain`, `node:punycode`, `node:trace_events`, `node:wasi`, `node:dgram`, `node:inspector`, `node:sqlite`, `node:_stream_wrap`, `node:child_process`, `node:perf_hooks`, `node:readline`, `node:repl`, `node:tty`, `node:v8`, and `node:worker_threads` become importable. Application code does not import them. Global Performance classes come with `node:perf_hooks`.
- **`strip_bom_in_read_all_text` (`2026-01-13`) and `text_decoder_replace_surrogates` / CJK `TextDecoder` (`2026-02-24`, `2026-03-03`).** Text decoding matches the Encoding Standard. No caller depends on a leading BOM or on lone surrogates surviving.
- **`rpc_params_dup_stubs` (`2026-01-20`).** Stubs passed inside an RPC call are duplicated. The app does not pass RPC stubs as call parameters.
- **`require_returns_default_export` (`2026-01-22`).** `require()` of an ES module returns its default export, matching Node. The Worker is a Vite bundle.
- **`fetch_iterable_type_support` (`2026-02-19`).** An array passed as a `fetch` body is streamed. Call sites pass strings, `ReadableStream`s, or `ArrayBuffer`s.
- **`enable_nodejs_global_timers` (`2026-02-10`).** Inside the isolate, `setTimeout` returns a Node `Timeout`. Server code only waits on the promise. Browser timers are the page's, not the isolate's.
- **`delete_all_deletes_alarm` (`2026-02-24`).** `storage.deleteAll()` also deletes a Durable Object alarm. Nothing calls `deleteAll()`.
- **`unhandled_rejection_after_microtask_checkpoint` (`2026-03-03`).** A rejection handled in a later microtask of the same checkpoint is no longer reported as unhandled.
- **`websocket_close_reason_byte_limit` (`2026-03-03`), `websocket_standard_binary_type` (`2026-03-17`), `web_socket_auto_reply_to_close` (`2026-04-07`).** Close reasons over 123 bytes throw. Binary frames default to `Blob`. A server Close frame completes the handshake. Realtime is SSE, and the Worker has no `WebSocket` message handler. A Durable Object hibernation handler would still receive `ArrayBuffer`.
- **`encoder_stream_spec_compliant_backpressure` and `writable_stream_spec_compliant_writer` (`2026-03-24`).** `TextEncoderStream` / `TextDecoderStream` start with backpressure, and `WritableStream` writer locks match the streams spec. Uploads `pipeTo` a `FixedLengthStream`. The `2026-11-17` `pipeTo` error-propagation change is not in this date.
- **`queue_expose_error_codes` (`2026-03-12`).** The app has no Queue binding.
- **`containers_pid_namespace` (`2026-04-01`).** The video-export container's `node dist/server.js` is PID 1 in its own namespace. It does not read the VM process list or assume another PID. See `docs/architecture/public-api-internals.md`.
- **`enhanced_error_serialization` (`2026-04-21`).** Errors that cross a serialization boundary keep their own properties. The original stack still does not survive a workflow step boundary (`src/platform/server/workflow/base-workflow.ts`).
- **`workflows_preserve_non_retryable_error_message` (`2026-05-14`).** A `NonRetryableError` message reaches `onFailure` as thrown. The generic "execution was terminated" replacement is off.
- **`diagnostics_channel_has_subscribers_getter` (`2026-05-19`) and `throw_on_not_implemented_tls_options` (`2026-06-16`).** `hasSubscribers` is a boolean getter. Unsupported `tls.connect` options throw. Application code uses neither.
- **`durable_object_io_tasks_prevent_eviction` (`2026-10-01`).** Pending Durable Object I/O, including `waitUntil`, service bindings, and RPC, keeps the object in memory after the client leaves, until the I/O finishes or 15 minutes pass.
- **Python flags (`python_process_pth_files`, `python_workers_314`).** This Worker is not Python.

`src/platform/server/compatibility-date.test.ts` also checks that `enable_request_signal` is still listed.

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
--remote` after patching the PR's database id into the config, then seeds
  system templates through the D1 HTTP API before deploying the Worker.
- **Local dev / e2e**: unchanged — drizzle-orm's migrator applies the nested
  files directly against the Miniflare binding (`bun db:migrate:local`).

Migrations must stay backwards-compatible for the moment between migrate and
deploy, and the D1 table-rebuild CASCADE trap (see AGENTS.md) applies to every
remote apply path.

## Seeding

The worker self-seeds system templates on first request (`src/server.ts` →
`src/platform/server/db/seed-system-templates.ts`). PR previews run the same
seed before deployment so a fresh database's remote writes do not delay the
first page load. A hash of the template definitions is stored in
`app_metadata`; when it matches, the
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

**Historical. Done once; do not repeat it or use it as a pattern.** Migrations
reach production only through the merge's deploy, never by hand (AGENTS.md,
"D1 table-rebuild trap"). Kept as the record of how the database was moved.

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

- **PR previews**: each PR gets its own Worker (`pr-<number>`) and D1 database (`openstory-pr-<number>`), with secrets pushed and the preview URL posted as a PR comment. Previews also get namespaced workflows (`*-pr-<number>`) and a video-export container application (`pr-<number>-videoexportcontainer`). On its first deploy, an empty PR database is copied from the latest promoted preview base via a full D1 SQL export/import, including migration history. A database that already has tables is recorded at the current base revision and kept as-is, including a retry after a partial import. Later deploys that already have a fork record retain its data and apply only pending migrations. The first PR starts empty. Production D1 is never a source or destination.
- **Preview base and promotion (#1997)**: `openstory-preview-registry` is a tiny D1 control database holding the active base database ID and revision, plus each PR's fork revision. After a merged PR's Worker is stopped, CI promotes its D1 by pointing the registry at that database. The promoted D1 is retained (as are earlier promoted databases for manual recovery); no live database is overwritten. A conditional D1 update atomically compares the fork revision with the current base, even if two PRs merge concurrently. If another PR has advanced the base since a PR forked, promotion fails, comments on the PR, and preserves its D1 for manual reconciliation. To recover, fork a new PR from the current base, explicitly copy the desired rows from the preserved database, and merge that PR; do not force-promote the stale snapshot. There is no automatic row-level merge or promotion to production. A previously opened PR is not implicitly rebased onto a new preview base; close and reopen only if you intend to discard its existing preview data.
- **Cleanup / re-fork**: closing an unmerged PR deletes its Worker, namespaced workflows, container application, and D1 database **and its fork record**. Reopening that PR creates a new D1 from the then-current preview base, discarding its previous preview data. A merged PR cannot be reopened; use a new PR to adopt later base changes. Closing a merged PR keeps its D1 as the new base (or for conflict recovery). Container apps are account-level and outlive the worker — skipping them blocks reopened-PR redeploys and accrues provisioned instances (see #1052). The staging R2 bucket is shared among previews, so copied media URLs remain valid; media is not cloned or cleaned up with the D1.

## Platform Detection

OpenStory automatically detects the deployment platform:

```typescript
import { getDeploymentPlatform } from '@/shared/utils/environment';

const platform = getDeploymentPlatform();
// Returns: 'cloudflare' | 'local' | 'unknown'
```
