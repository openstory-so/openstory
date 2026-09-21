# CLAUDE.md

AI-powered video sequence platform built with TanStack Start, deployed to Cloudflare Workers.

## Commands

```bash
# Dev
bun dev                            # App: env bootstrap, DB migrate + seed, Vite (Workerd via cf-plugin)
bun dev:all                        # bun dev + the Stripe listener (billing webhooks)
bun storybook                      # Storybook on :6006
bun explorer                       # Open the local CF Explorer (KV/R2/D1/DOs/Workflows)
bun db:studio:local                # Inspect local D1 tables (wrangler d1 execute)
bun tunnel:provision               # Once per laptop: 10 random *.openstory.so names → ports 3000–3009
bun tunnel                         # Print ~/.openstory/dev-tunnels.json + Google OAuth URIs

# Quality
bun lint                           # oxlint (type-aware)
bun lint:fix
bun format                         # oxfmt
bun format:check
bun typecheck                      # tsgo --noEmit (NOT `tsc`)
bun dead-code                      # knip (unused exports)

# Tests
bun run test                       # unit (Vitest) — NOT `bun test` (that invokes Bun's built-in test runner)
bun run test src/path/foo.test.ts  # single file
bun run test:watch
bun run test:coverage
bun test:e2e                       # Playwright (vite dev cf-plugin webServer)
bun test:e2e:ui
bun test:e2e:setup                 # apply D1 migrations + seed for [env.test]
bun test:e2e:full                  # full-pipeline e2e (Cloudflare Workflows + aimock)
bun run build:e2e                  # built-server e2e build (VITE_APP_URL=:3001, devtools off)

# DB (Wrangler local D1 via Miniflare)
bun db:migrate:local               # drizzle-orm migrator against local D1 (default env)
bun db:migrate:test                # drizzle-orm migrator against local D1 ([env.test])
bun db:migrate:prd                 # flatten + wrangler d1 migrations apply DB --env=production --remote
bun db:seed:local                  # seed local D1 via getPlatformProxy
bun db:generate                    # generate migration from schema edits
bun db:studio:d1                   # Drizzle Studio against production D1

# Build / deploy
bun run build                      # Vite production build (NOT `bun build`)
bun cf:dev                         # wrangler dev against built worker (preview)
bun cf:deploy:prd                  # Manual production deploy (build → migrate → deploy)
bun run deploy                     # Deploy-button deploy command (migrate + deploy, default env)
bun deploy:production              # Workers Builds prod deploy command (migrate --env=production + deploy)
```

`bun dev` runs vite dev (cf-plugin → Workerd via Miniflare, port 3000). Its first step (`scripts/ensure-env.ts`) creates `.env.local` with generated secrets if missing, so a fresh clone needs only `bun install && bun dev`. Billing work uses `bun dev:all`, which additionally runs the Stripe listener (skipped without `STRIPE_SECRET_KEY`); it lives outside `bun dev` so a missing/uninstalled Stripe CLI never takes down the app server (e.g. in cloud preview sandboxes). The app runs in **Workerd locally** — same runtime as production — so D1, R2 bindings, **Cloudflare Workflows**, env.\* access, and request lifecycle all match prod. No QStash/Docker needed: workflows execute in-process in Workerd.

**Local Cloudflare services via the Explorer API.** While `bun dev` is running you have access to local Cloudflare services (KV, R2, D1, Durable Objects, and Workflows) for this app via the Explorer API at `http://localhost:3000/cdn-cgi/explorer/api`. Fetch that URL to get the OpenAPI schema and discover available operations, then use those endpoints to list, query, and manage local resources during development. `bun explorer` opens the Explorer UI in a browser.

**Bun-as-launcher pattern:** `bun script.ts` (no `--bun`) keeps Bun as the CLI launcher but executes under **Node**, while still autoloading `.env*`. Use `bun --env-file=<path>` to override the default `.env.local`. No `--bun` flag should appear in package.json scripts.

## Project Structure

```
src/
  routes/           # TanStack file routes (thin: params, loader, which screen)
  ui/               # app shell, providers, cn, cross-cutting hooks
    shadcn/         #   generated shadcn primitives (lint/knip-ignored; managed by the CLI)
  platform/         # DOMAIN-BLIND infrastructure: auth, env, db client + schema,
                    # storage, workflow engine, logger, realtime transport, emails
    server/         #   its server-only half
    ui/             #   its React half (auth forms, realtime client)
  models/           # catalog, vias (fal/BytePlus/xAI/Google adapters), duration/resolution grids
  sequences/        # aggregate: script analysis, pipeline, checkpoint, export
  shots/            # content unit (frame + scene + staleness + prompt versions)
  motion/           # video request/submit/poll + player
  stills/           # image gen, sheets, upscale
  audio/            # music
  cast/             # talent, locations, elements, bibles
  look/             # style
  billing/          # money, estimates, pricing data + refresh, Stripe
  studio/           # playground
e2e/                # Playwright tests
scripts/            # CLI tooling and setup
drizzle/migrations/ # Generated SQL (do NOT hand-edit)
```

Inside a product domain: root files are client-safe (catalogs, pure logic, zod); `server/` is server-only (workflows, `server/db/<table>.ts` scoped-db modules, AI calls, prompts); `*.fn.ts` is a Start server fn (client imports the stub; `.handler()` is stripped); `ui/` is React + hooks. Domains may import each other's roots and `server/` halves; the coupling is real and is not hidden.

**`src/platform` is domain-blind.** It may not value-import a product domain (`import type` is free) — enforced by `boundaries/platform-domain-blind` in `.oxlintrc.json` and, for relative imports the alias pattern cannot see, by `src/platform/domain-blind.test.ts`. A platform file that needs a domain belongs to that domain. Platform tests are exempt; the only other exceptions are the **composition roots** listed in the `boundaries/platform-domain-blind` override — the ScopedDb aggregate (`server/db/scoped.ts`, `scoped-workflow.ts`, `scoped/admin.ts`), `server/db/seed-system-templates.ts`, the public API layer `server/api-v1/**`, the MCP tool adapters `server/mcp/tools/**`, the realtime `query-cache-updater`, and the workflow base (`server/workflow/base-workflow.ts`, which bootstraps each run). Keep that list short: a new entry usually means a file that belongs in a domain.

## Architecture

**Stack:** Bun (package manager + script launcher; Node is the runtime) · TanStack Start + Router + Vite (`@cloudflare/vite-plugin`) · Cloudflare D1 + Drizzle · Cloudflare Workflows (durable async) · Cloudflare R2 · Better Auth · Tailwind v4 + shadcn/ui · Vitest.

**Core rules:**

- Database access ONLY in server handlers (never in components).
- **Import boundaries are one lint rule per question** (`scripts/lint/restricted-imports.ts`, plugin `boundaries`). oxlint overrides replace a rule's whole config for the files they match, so concerns sharing one rule key cannot be layered — every override would have to restate the others. Instead each concern is its own rule, on for every file, and each override in `.oxlintrc.json` is exactly "these files may do X":
  - `boundaries/no-server-imports` — **client/server seam (#1445).** `src/**/server/**` is server-only; lifted for server code (`src/**/server/**`, `src/**/*.fn.ts` — the compiler strips `.handler()`, `src/routes/api/**`, the root-level server-only routes, `*.test.ts`, scripts). `*.test.tsx` and stories are NOT lifted: a React test or story only ever needs `import type` from server code. Transitive backstop: `src/platform/client-server-boundary.test.ts` (pre-commit). Do not punch `!` holes in the pattern: a file that needs server code belongs under `server/` or is a `*.fn.ts`; a file that mixes halves is split, not exempted. One deliberate leak shape remains: a `createIsomorphicFn().server(…)` body may value-import server modules under an `oxlint-disable-next-line boundaries/no-server-imports` (`src/billing/billing-observability.ts`, `routes/__root.tsx`), because the compiler strips it.
  - `boundaries/no-sql` — **SQL is written in the db layer only.** `drizzle-orm` query builders are lifted for `src/**/server/db/**` (the scoped-db modules), the schema, the seeds, scripts, `*.test.ts`, and the pricing/cron jobs that still read the raw handle (collapsing into one db-layer module under #1535); `drizzle-orm/zod` validators are fine anywhere. A domain module that needs a query adds a method to its scoped-db module and calls it through `scopedDb` — it does not take a `Database` handle as a parameter.
  - `boundaries/no-raw-db` and `boundaries/no-scoped-factory` — **raw db access is allowlisted twice.** `#db-client` is lifted only for the raw-handle readers (the scoped-db factory, the Better Auth adapter, the pricing/cron jobs, the seeds); `createScopedDb` / `createSystemAdminScopedDb` only for the two request middlewares, the MCP server, and the workflow base. Even the allowlisted files keep table SQL out where they can: the sign-up hook calls `createDefaultTeam`, the same bootstrap `ensureUserAndTeam` uses. `src/platform/server/db/db-access-allowlist.test.ts` pins both lists by resolving every value import, which catches the relative-path form the lint rule cannot see. Everything team-scoped goes through `context.scopedDb`.
  - `boundaries/platform-domain-blind` — on for `src/platform/**` only (see Project Structure).
  - All of them ignore `import type`; the inline `import { type X }` form is banned by `typescript/no-import-type-side-effects` because it leaves a side-effect import that ships the whole graph.

- **Generated media is stored in the step that generated it (#1645).** A via can answer with inline base64 and no URL at all (native Gemini always; BytePlus can), and Workflows checkpoints every `step.do` result at 1 MiB — so a separate upload step would make the image itself ride the checkpoint (#1638). `generateImageSoftening` / `generateImageWithContentRetry` take a `store` callback that runs inside the generate step; direct `generateImageWithProvider` callers do their upload in the same `step.do`. Only the small `{ url, path }` record crosses. Use `uploadResponse` to stream a body into the binding (`FixedLengthStream` when a `Content-Length` is present — `r2.put` rejects an unknown-length stream). Sheets go through `storeGeneratedPng`; shot stills through `uploadImageFromUrl` — both open a `data:` result, which workerd `fetch` cannot.
- Anonymous-first → upgrade to save work.
- Team-based resources (sequences, styles, characters).
- Script-driven generation for consistency.

**Data model:**

```
teams
  ├── users (members)
  ├── sequences (videos)
  │   └── frames (scenes with metadata)
  └── libraries (styles, characters, vfx, audio)
```

## Setup

```bash
bun install
bun dev                            # That's it — env, migrations, seed all happen on first run
bun setup                          # Optional: add FAL_KEY / OPENROUTER_KEY interactively
bun setup --prod                   # Production config + deploy (--deploy, --pr-preview also available)
```

**Branch + commit conventions:** Branches must be named `<issue-number>-feature-name` (e.g. `393-improve-readme`). Lefthook extracts the issue number and tags commits with `#<issue>` automatically. See `CONTRIBUTING.md`. Lefthook also runs quality checks pre-commit.

---

## Server Handler Pattern

All API routes use TanStack Start server handlers. Standard shape:

```typescript
// src/routes/api/example/$id.ts
export const Route = createFileRoute('/api/example/$id')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      POST: async ({ params, request, context }) => {
        try {
          const input = schema.parse(await request.json());
          const { user, teamId } = context;

          const record = await db.insert(table).values({ ...input, teamId });

          // Trigger a durable workflow (see Workflow Pattern below)
          const workflowRunId = await triggerWorkflow('/image', {
            userId: user.id,
            teamId,
            ...input,
          });

          return json({ id: record.id, workflowRunId });
        } catch (error) {
          const handled = handleApiError(error);
          return json(
            { success: false, error: handled.toJSON() },
            { status: handled.statusCode }
          );
        }
      },
    },
  },
});
```

Steps: 1) validate input · 2) auth via `authWithTeamRequestMiddleware` (user/teamId on `context`) · 3) DB writes (only here) · 4) trigger workflow · 5) standardized response.

## Workflow Pattern

Durable async work runs on **Cloudflare Workflows**. Each workflow is a
`WorkflowEntrypoint` subclass; there is no QStash and no HTTP callback route.
`triggerWorkflow`'s only option besides `enforcement` is `deduplicationId` —
the QStash-era `label` / `retries` / `retryDelay` were no-ops and are gone
(retry policy is per `step.do`; observability is the instance id).

**Triggering workflows — use `triggerWorkflow(path, body)`** from
`@/platform/server/workflow/client`. It resolves the workflow binding for `path` (see
`TRIGGER_TO_BINDING` in `src/platform/server/workflow/trigger-bindings.ts`) and calls
`binding.create()`, returning the workflow instance id (store it as
`workflowRunId`):

```typescript
const workflowRunId = await triggerWorkflow('/image', {
  userId,
  teamId,
  prompt,
  ...params,
});
```

Pass a stable `deduplicationId` in the options to make a trigger idempotent.

**Defining workflows** — each lives in `src/<domain>/server/workflows/<name>-workflow.ts`,
extends `OpenStoryWorkflowEntrypoint` (`src/platform/server/workflow/base-workflow.ts`),
and must be wired in three places (a test in
`src/platform/server/workflow/wiring-consistency.test.ts` enforces this):

1. `wrangler.jsonc` `workflows[]` — declares the binding + `class_name`.
2. `src/server.ts` — re-exports the class so it lands in the Worker bundle.
3. `TRIGGER_TO_BINDING` in `src/platform/server/workflow/trigger-bindings.ts` — maps the
   trigger path to the binding name.

The base class validates `userId`/`teamId` on the payload, builds a
`ScopedDb`, and sanitizes/handles failures. Subclasses implement
`runImpl(event, step, scopedDb)`, run steps via
`step.do('step-name', async () => { ... })` (durable, auto-retried), and write
DB updates directly. For parent→child fan-out (await a child's result), use
`spawnAndAwaitChild` from `src/platform/server/workflow/await-child.ts`.

**Workflows must not read mutable D1 state mid-run.** A run starts minutes to
hours after the click, replays its steps from a durable cache, and races its own
children — so a live re-read can feed a step a value the user never asked for,
and can feed two steps of the same run different values. Snapshot everything
onto the payload in the server fn that triggers the run. This is enforced by
construction: `runImpl` receives a **`WorkflowScopedDb`**
(`src/platform/server/db/scoped-workflow.ts`) — the full write surface with every read
method removed — so a mid-run read is a type error. The few reads that cannot be
snapshotted reach the run through three **named hatches**, so the spelling at
the call site is the justification:

- `scopedDb.credentials.resolveKey('fal')` / `.resolveKey('elevenlabs')` /
  `.resolveLlmKey()` — a secret, not a row. Resolved inside the step that
  spends it. `'elevenlabs'` is platform-only (not on `API_KEY_PROVIDERS`).
- `scopedDb.claims.<domain>.getById…(id)` — an append-only row by an id this run
  already holds (its own claim, or the row that claim retired into). Cannot
  express a selection pointer, which is the point.
- `scopedDb.liveRead.<domain>.<method>()` — genuinely live by design: divergence
  recomputation, sibling-workflow polling, balance and spawn-time billing guards,
  existence guards.

Each surface is enumerated in `scoped-workflow.ts` and pinned by
`src/platform/server/workflow/no-mid-run-reads.test.ts`, which also fails if a read's
category doesn't match the hatch it came through. Full rationale:
`docs/architecture/workflow-snapshots-and-content-hash-staleness.md`.

## Feature docs — read before touching the area

Each feature's rules, traps and rationale live in `docs/architecture/`. The
lines here are only the traps that bite without warning. **Read the doc before
changing the area, and update it in the same PR.**

- **Reference-only motion (no start frames)** —
  `docs/architecture/reference-only-motion.md`. Resolved per shot, never per
  sequence: always go through `usesStartFrame()` / `rendersReferenceOnly()`,
  never read `sequence.generateStartFrames` raw
  (`reference-only-is-per-shot.test.ts`). `usesStartFrame` is required and
  never defaulted (`!undefined` is `true`). Where a team's keys are reachable
  ask `canRenderReferenceOnly(model, credentials)`, not the model-only
  `supportsReferenceOnlyMotion`.
- **Stop-at stages and continue (#1408)** —
  `docs/architecture/stop-at-stages.md`. `stopAt` is the only word on how far a
  run goes (`GENERATION_STAGES` in `src/sequences/pipeline.ts`). The legacy
  `autoGenerateMotion` / `autoGenerateMusic` columns are derived from it — never
  set them on their own, never gate a workflow phase on them.
- **Public API OpenAPI document** — `docs/architecture/public-api-internals.md`.
  Every schema is generated, nothing hand-authored. `.extend()` drops
  `.meta({ id })`, so tag the `_links`-bearing resource schema you return.
- **OAuth authorization server + MCP (#1456, #1457)** —
  `docs/architecture/oauth-server.md`. Bearer JWTs are accepted on `/api/v1`
  and `/mcp` only; `osk_` keys are unscoped; OAuth tables come from
  `bun auth:generate`, never by hand.
- **Server-side export** — `docs/architecture/public-api-internals.md`. No
  in-browser encode; `POST /api/v1/sequences/$id/exports` →
  `SequenceExportWorkflow` → the video-export Container (production-only).
  Plain `bun dev` and e2e have no renderer. The theatre does not use the
  export: it plays an HLS playlist that points straight at the clips (#1623).
  Each clip gets a fragmented copy made once in the worker by copying packets
  — never mediabunny's `Conversion`, which re-encodes to trim AAC priming and
  workerd has no codec. The remux reads ranged R2 bytes and streams the copy
  through `uploadResponse` (#1735); a whole clip must never sit in Worker
  memory. Music plays alongside in its own `<audio>`.

## Frame System

Frames are the core content unit — each represents one scene from script analysis.

**Critical:** `frame.metadata` IS the `Scene` object (no wrapper). Fully typed via Drizzle JSONB.

```typescript
frame.metadata = {
  sceneId,
  sceneNumber,
  originalScript: { extract, dialogue: [{ character, line, tone, shotNumber?, voiceToken? }] },
  metadata: { title, durationSeconds, location, timeOfDay, storyBeat },
  variants: { cameraAngles, movementStyles, moodTreatments }, // A/B/C options
  selectedVariant: { cameraAngle, movementStyle, moodTreatment, rationale },
  prompts: {
    visual: { fullPrompt, negativePrompt, components, parameters },
    motion: { fullPrompt, components, parameters },
  },
  continuity: { characterTags, environmentTag, colorPalette, lightingSetup },
  musicDesign: { presence, style, mood, atmosphere },
};
```

Access via `frameService.getSceneData(frame)`, `getVisualPrompt(frame)`, `getMotionPrompt(frame)`, or directly: `frame.metadata.metadata.title`, `frame.metadata.prompts.visual.fullPrompt`. Storing the full scene lets us regenerate without re-analyzing the script and preserves variants for retries.

## Media vias: fal + BytePlus + xAI + Google + ElevenLabs

fal is the default **via** for every image / video / audio model. Catalog **vendor** is who trained the model (ByteDance, Kling, …). Seedance (video) and Seedream (image) also have a native BytePlus Ark via (#1157), Grok a native xAI via, Gemini (chat, Nano Banana stills, Omni Flash video) a native Google via, and voices/dialogue a native ElevenLabs via. Sequences store the model _key_, never the endpoint.

Rules that hold for every via:

- **Stamp `via` on the job; poll MUST follow the stamp** (a missing stamp means `'fal'`). Job ids are via-scoped.
- **Never fall back between providers.** A job sent to Ark fails as an Ark error — no quiet hop to fal or to a public URL.
- **Native spend is unaudited.** xAI, Google, Ark, ElevenLabs and LLMTR bypass `model_pricing` and the #1069 fal reconcile; their prices are static cards or tables in code.
- **Pass the via when pricing an LLM call:** `llmCostFromUsage(usage, model, llmKey.via)`. Omit it and LLMTR spend bills at the wrong rate or $0.
- **E2E stays on the mocks.** Under `E2E_TEST` a native via is off unless its `*_BASE_URL` is also set, so a laptop key cannot bill replay.

Read the via's doc before touching it, and update it in the same PR:

- **BytePlus Ark** — `docs/architecture/byteplus-ark.md`. Platform key only (no `'byteplus'` on `API_KEY_PROVIDERS`). Ark is not fal-shaped — `bun motion:codegen` does not apply, and Ark rejects frame roles mixed with reference roles. Quotas and the ~50 portrait-asset slots are per ACCOUNT, shared by every team: CreateAsset is paced by the `BytePlusGovernor` DO, leases are per (still, run), and a parent never sweeps its fan-out's leases. Every user upload is classified for a real person first (`classifyUpload` / `requireUploadRights`); `isHuman` never comes from the client.
- **ElevenLabs (character voices, dialogue audio, fitting the section)** — `docs/architecture/elevenlabs.md`. Platform key only. A saved voice is an account-wide slot: free it only through `releaseVoiceIfUnreferenced` (provider delete first, row write second), never a bare delete. Voices are versioned with an explicit `source`; a released version cannot be selected. Dialogue lines live on the SHOT (`shot_dialogue_versions`; speaking order is shot order, then line order). What a shot says is resolved ONLY through `shotDialogueResolver` — never read or write `shot_prompt_versions.dialogue` (unwritten since #1657; the resolver's fallback for old rows), and never treat the motion-prompt LLM's `dialogue` output as lines; `motionPromptFromVersion` takes the resolved dialogue as a required argument. Recordings (`dialogue_recordings`) are whole files, one per call, never joined. A shot's audio is its selected `shot_dialogue_sections` row — a time range of a recording — and `shots.audioClips` mirrors its cut. A scene is recorded ONCE: batch-style triggers send `dialogueRecording` (`snapshotBatchDialogue`) and the batch records before it fans out — never let N children each record a window. A recording lands through a claim (`shot_dialogue_claims`): `appendRecording` promotes pointer + `shots.audioClips` in one transaction guarded by the claim, and user writes demote live claims in their own batch — never write a shot's dialogue clip on its own. Record wide, adopt narrow: the call speaks the whole conversation, but never re-point a shot whose lines did not move. The cut (`cutAudioSection`) must stay ranged + streamed — never `readStorageObject` a whole recording. Voice changes fold into the video manifest (`audioSourceKey`, `audioClipIds`, `referenceKeys`), not the motion-prompt hash, and only when present so no stored digest moves. No time-compression rung when fitting a section. Bytes never cross a `step.do`.
- **Native Grok (xAI)** — `docs/architecture/media-vias.md`. xAI speaks the Responses API; `resolveNativeGrokModel` keeps `llm-client` and the adapter on the same route.
- **Native Google (Gemini)** — `docs/architecture/media-vias.md`. Omni Flash submit must request `response_format.delivery: "uri"` and must NOT pass top-level `duration`/`size`; stills go inline as base64 (`toVisionImageSource(..., { inline: true })`), never as a fetched URI.
- **LLMTR gateway** — `docs/architecture/media-vias.md`. Team BYOK only. A registry id absent from `LLMTR_TEXT_MODELS` is not routable — never guess a neighbour slug, never send the LLMTR key to OpenRouter, and send native wire names, not OpenRouter plugins.
- **fal** — `docs/architecture/media-vias.md`. Check `https://fal.ai/models/{model-path}/llms.txt` before updating a model; new motion models go through `bun motion:codegen`, never inline schemas. Pricing is DB-only (`model_pricing`, empty locally until `bun scripts/refresh-fal-pricing.ts` runs) and fal's bill, not its pricing API, is the ground truth.

**Cron jobs need wiring in three places** (like Workflows): `wrangler.jsonc` `triggers.crons` in the **default** block, the same in **`[env.production]`** (non-inheritable), and the constant `scheduled()` string-matches on (e.g. `FAL_PRICING_CRON`). Drift is silent — an unmatched expression falls through to the 5-minute reconcile sweep, which _succeeds_, so the job just never runs. `src/billing/server/refresh-fal-pricing.test.ts` enforces it.

---

## Database

**Schema management:**

```bash
bun db:generate  # Generate migrations from schema changes
bun db:migrate   # Apply migrations to local.db
```

- Schema in `src/platform/server/db/schema/` (Drizzle auto-infers types).
- **NEVER** hand-write migration SQL. The one exception is a pure data backfill/repair, which has no schema diff so drizzle-kit cannot emit it: generate the empty file with `bun db:generate --custom --name=<name>`, write the SQL into it, and say so in a comment header. It must be a migration and not a script — PR previews and Deploy-button clones only ever run `wrangler d1 migrations apply`.
- **NEVER hand-write Better Auth tables.** Adding/changing a Better Auth plugin → run `bun auth:generate` (Better Auth CLI against the real config via `src/platform/server/auth/cli-config.ts`; emits `auth-schema.ts` at the root), port the new table(s) verbatim into `src/platform/server/db/schema/auth.ts` (same `snakeCase.table` style as the neighbours), then `bun db:generate`. Field names/types must match the plugin exactly or the adapter silently breaks.
- **ULIDs are the ONLY id format in the database.** Every id is an app-generated ULID from `generateId()` — never a UUID, never a slug, never `lower(hex(randomblob(16)))` or any other SQL-minted value. SQL cannot produce a ULID, so a migration that has to insert a row **reuses its parent row's ULID as the new id**. Ids only have to be unique within their own table; the same ULID appearing as a `characters.id` and as that character's `character_sheet_variants.id` is fine, and it makes the migration deterministic and replay-safe. See `20260901073033_backfill_character_sheet_variants`.
- **Typed JSONB:** `frame.metadata` typed as `Scene`.

### wrangler.jsonc env layout — READ BEFORE TOUCHING

**Why the env split exists.** Remote bindings are **opt-in per binding** in current wrangler/`@cloudflare/vite-plugin` (`"remote": true`); local dev simulates everything in Miniflare by default. But the split is not just a remote-bindings guard — each block has its own job (see below), and historically the plugin DID default remote bindings on, which leaked Better Auth verification rows into `openstory-prd` D1 mid-#755. The placeholder-id strategy keeps that incident class impossible even if a plugin default flips again or someone runs a `--remote` command against the dev config.

**The structure.** `wrangler.jsonc` separates dev from prod via env blocks:

- **default** (no env) — triple duty: (1) `bun dev` / `vite dev` / `bun cf:dev` local simulation, (2) the patch base for PR-preview deploys (CI rewrites D1/bucket/workflow names in place), and (3) the provisioning template for Deploy-to-Cloudflare button deploys — its `database_name`/`bucket_name` are what a button user's fresh resources get called, and `tail_consumers` must stay `[]` so button deploys don't reference our log-forwarder Worker. The D1 binding has a **placeholder** `database_id: "dev-local-d1"` so any misrouted remote call (or buggy preview patch, or wrong-env deploy) 404s against Cloudflare rather than silently writing to prod. R2 buckets are **local Miniflare** too — stored media URLs are origin-relative (`/r2/<key>`, #894) and the worker's `/r2/$` route streams them from the binding when `R2_PUBLIC_STORAGE_DOMAIN` is unset (with a CDN domain set, the route redirects to it). Local dev needs no Cloudflare credentials. (Opt back into remote R2 by setting `"remote": true` on the binding + `R2_PUBLIC_STORAGE_DOMAIN` in `.env.local`; revert when done.)
- **`[env.production]`** — real prod D1 (`database_name: openstory-prd`, `database_id: d5981bee-...`; the `#897` cutover recreated it from the old `velro-prd`/`d6a35f64-...`, which is retired). Production builds MUST set `CLOUDFLARE_ENV=production` (so the built `dist/server/wrangler.json` bakes this block) and the migrate step MUST pass `--env=production` (wired in `deploy:production` / `cf:deploy:prd`). This block ALSO declares the **video-export Cloudflare Container** (#968): `containers[]` (built from `containers/video-export/Dockerfile`), the `VIDEO_EXPORT_CONTAINER` Durable Object binding, and migration tag `v2`. It is **production-only** so `bun dev` and e2e stay Docker-free — `wrangler deploy`/Workers Builds builds + pushes the image (Docker required only at deploy, which Workers Builds provides). See `docs/architecture/public-api-internals.md`.
- **`[env.test]`** — Playwright e2e. Local Miniflare D1 (`database_id: "openstory-test-local"`) AND local Miniflare R2 — fully hermetic, no Cloudflare credentials in CI. Activated via `CLOUDFLARE_ENV=test` (set in `playwright.config.ts` envPrefix and CI workflow env block) for `vite dev`, or `wrangler dev --env=test` for the built-server path.

**Rules:**

- Never add `"remote": true` to a D1 binding. The placeholder-id strategy is the safety net.
- Production deploys run on **Workers Builds** (dashboard-connected to `main`, #900): build command `bun run build` with `CLOUDFLARE_ENV=production` as a build env var, deploy command `bun run deploy:production`. Manual fallback: `bun cf:deploy:prd`. Don't deploy a build made without `CLOUDFLARE_ENV=production` — it bakes the default block (placeholder D1) and fails loudly.
- PR-preview deploys patch the default block at runtime in `.github/workflows/deploy-cloudflare.yml` and deploy without `--env`. Each PR gets its own real D1 named `openstory-pr-<n>`.

**Local guardrail:** `bun dev` prints a wrangler-bindings banner on startup showing each binding's `local` / `REMOTE` status. If `DB` ever shows REMOTE, kill the server immediately and fix the config before any write lands in prod.

**Reproducing a prod bug locally:** temporarily set the default D1's `database_id` to the real prod value, restart `bun dev`, and revert when done. **Never commit a real prod D1 id into the default block.**

### D1 table-rebuild trap — READ BEFORE CHANGING SCHEMA

Remote migrations apply via `wrangler d1 migrations apply` (#897/#900: the `deploy` script for button deploys, `deploy:production` for upstream prod on Workers Builds, `db:migrate:prd` inside `cf:deploy:prd` for manual deploys), which sends each migration file as one multi-statement body. D1 wraps multi-statement bodies in an implicit transaction, and SQLite **silently** ignores `PRAGMA foreign_keys = OFF` inside a transaction. So when the standard SQLite "table rebuild" pattern (`CREATE __new_X` → `INSERT SELECT` → `DROP X` → `RENAME`) drops the parent table, every inbound `ON DELETE CASCADE` FK fires and child rows are deleted. (The original #612 incident hit the same trap through drizzle-kit's `d1-http` migrator, which no longer touches remote DBs — drizzle-kit only generates migrations now. Note drizzle-kit emits nested `<dir>/migration.sql` files; `scripts/flatten-migrations.ts` renders the flat gitignored `drizzle/migrations-wrangler/` dir that wrangler reads.)

This destroyed `team_members`, `session`, `account`, and `passkey` in production on 2026-04-29 (issue #612, migration `20260428013041_productive_kabuki`). `PRAGMA defer_foreign_keys = ON` does **not** help — it defers constraint _checks_ but CASCADE still fires.

**Workarounds (in order):**

1. **Avoid table rebuilds.** Prefer `ALTER TABLE … RENAME COLUMN / ADD COLUMN / DROP COLUMN` — SQLite/D1 support these without a rebuild.
2. **Apply destructive migrations manually.** Snapshot first (`wrangler d1 export`), then apply via the D1 dashboard or `wrangler d1 ... --file=…`. Do not let the automated `wrangler d1 migrations apply` paths run it (mark it applied in `d1_migrations` afterwards so they skip it).
3. **Avoid `ON DELETE CASCADE`** on FKs to long-lived parent tables (`user`, `teams`, `sequences`). Use `'restrict'` or `'no action'` and clean up children in app code.

**Local guardrail:** `scripts/check-migrations.ts` runs as a Lefthook pre-commit step on staged `drizzle/migrations/**/*.sql`. It flags `DROP TABLE`, `TRUNCATE`, `DELETE FROM`, `ALTER TABLE … DROP COLUMN`, and annotates each `DROP TABLE` with the count of inbound `ON DELETE CASCADE` FKs. Bypass for a manually-applied migration: `bun scripts/check-migrations.ts --allow-destructive`. Note `--allow-destructive` is an argument to the SCRIPT — the Lefthook step (`lefthook.yml`) invokes it without one, so to land an intentionally destructive migration commit with `LEFTHOOK_EXCLUDE=migration-safety git commit`, NOT `--no-verify` (which also skips typecheck, lint, format and knip). A native `ALTER TABLE … DROP COLUMN` is flagged but is exactly the refactor the check asks for — it rebuilds no table, so #612 does not apply.

**Schema-drift trap (#898):** drizzle-kit only diffs **top-level exported** tables — removing a table's named export from `src/platform/server/db/schema/index.ts` (e.g. in a dead-code sweep) makes the next `db:generate` emit `DROP TABLE` for it. Keep every table individually exported. And never change a column's SQL `.default()` without generating the migration in the same PR — a default change forces a full table rebuild (see trap above); prefer `$defaultFn()` for app-level defaults with no DDL impact.

Refs: [drizzle-orm#3065](https://github.com/drizzle-team/drizzle-orm/issues/3065), [workers-sdk#5438](https://github.com/cloudflare/workers-sdk/issues/5438), [SQLite foreign_keys docs](https://sqlite.org/foreignkeys.html#fk_enable).

---

## React Patterns

**Quick reference** (rules; examples below for the contrarian ones):

- **Server data:** TanStack Query with `suspense: true`. No `isLoading` checks; use `<Suspense fallback={<Skeleton />} />`.
- **Styling:** shadcn/ui base components handle theming; Tailwind ONLY for layout (`flex`, `grid`, `gap`). No hard-coded colors. No `margin` on components — use flex+gap on the parent.
- **Loading:** inline `<Skeleton />` fallbacks that mirror final content (no separate skeleton components).
- **Visibility:** CSS `hidden`/`block` (pre-render) rather than conditional mounting, to avoid layout shift.
- **Forms:** TanStack Query mutations + Zod (`safeParse`) — no controlled-input boilerplate, use `FormData`.
- **Mutation errors:** the global error toast in `src/ui/query-client.ts` is opt-in via `meta: { globalError: true }` (#1571). Default is off because nearly every mutation surfaces its own failure (titled toast, inline state, try/catch). Set it on a hook whose callers do nothing with the error.
- **Routing:** TanStack Router `createFileRoute`, params via `Route.useParams()`. URL reflects state via search params.
- **Files:** `kebab-case.tsx`, named exports, vanilla TS (`.ts`) for logic. `@/` alias. No default exports.

### Data fetching

```tsx
// ❌ useState + useEffect
const [user, setUser] = useState(null);
const [isLoading, setIsLoading] = useState(true);
useEffect(() => { fetch(...).then(r => r.json()).then(d => { setUser(d); setIsLoading(false); }); }, [userId]);
if (isLoading) return <div>Loading...</div>;

// ✅ TanStack Query + Suspense — no isLoading checks
const UserContent: React.FC<{ userId: string }> = ({ userId }) => {
  const { data: user } = useQuery({ queryKey: ['user', userId], queryFn: () => fetchUser(userId), suspense: true });
  return <div>{user.name}</div>;
};

export const UserProfile: React.FC<{ userId: string }> = (props) => (
  <Suspense fallback={<Skeleton className="h-6 w-32" />}><UserContent {...props} /></Suspense>
);
```

### Styling

```tsx
// ❌ Hard-coded colors, dark variants, margin on the component
<div className="w-[300px] m-4 p-6 bg-white dark:bg-slate-900 text-slate-900 dark:text-white rounded-xl shadow-lg border border-slate-200 dark:border-slate-700">
  <h3 className="text-xl font-bold mb-2">{frame.title}</h3>
</div>

// ✅ shadcn base handles theming; Tailwind for layout only; gap on parent (not margin on child)
<Card onClick={onSelect} className="cursor-pointer">
  <CardHeader><CardTitle>{frame.title}</CardTitle><CardDescription>{frame.description}</CardDescription></CardHeader>
</Card>

// Parent owns spacing:
<div className="grid grid-cols-3 gap-4">
  {frames.map(f => <FrameCard key={f.id} frame={f} />)}
</div>
```

### Forms

```tsx
// ❌ Controlled inputs everywhere, manual validation, setState per field

// ✅ Uncontrolled + FormData + Zod + TanStack Query mutation
export const ScriptForm: React.FC = () => {
  const mutation = useMutation({ mutationFn: createScript });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const result = scriptSchema.safeParse(
      Object.fromEntries(new FormData(e.currentTarget))
    );
    if (!result.success) return; // surface errors inline
    mutation.mutate(result.data);
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Input name="title" placeholder="Script title…" required />
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Creating…' : 'Create'}
      </Button>
    </form>
  );
};
```

See `src/ui/` and any domain's `ui/` for the house pattern.

## UI/UX Non-Negotiables

- Keyboard: full keyboard support per [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/); visible `:focus-visible` rings.
- Inputs: hit targets ≥24px (mobile ≥44px), `font-size` ≥16px, never block paste, `autocomplete` + correct `type`/`inputmode`. Enter submits inputs; Ctrl/Cmd+Enter submits textareas.
- State: URL reflects filters/tabs/pagination; back/forward restores scroll. Use TanStack Router `<Link>` (supports Cmd/Ctrl/middle-click).
- Feedback: optimistic UI with rollback or Undo; confirm destructive actions; `aria-live="polite"` for toasts; ellipsis (`…`) for loading states.
- Animation: honor `prefers-reduced-motion`; animate `transform`/`opacity`; interruptible. CSS > WAAPI > JS libs.
- Accessibility: redundant cues (not color-only), `aria-label` for icon-only buttons, tabular numerics for comparisons, prefer native semantics.
- Performance: virtualize long lists (`virtua`); explicit image dimensions; mutations <500ms.

---

## Testing

**Unit-test framework:** Vitest (run via `bun run test`, never `bun test` — that invokes Bun's built-in runner and ignores `vitest.config.ts`).

- Route handlers: test the logic next to where it lives (the domain's `server/` folder, e.g. `platform/server/api-v1/device-routes.test.ts`). Never put a test under `src/routes/` — every file there becomes a route (`boundaries/wrong-place` fails it).
- Services/utils: co-located (`service.test.ts`).
- Focus: business logic, not React components.
- DB: mock `#db-client` via `vi.doMock` (not real connections); ULID primary keys.
- Workflows: mock workflow context + AI calls; pass auth (userId/teamId) through context.
- `vitest.config.ts` is **self-contained** — it does not extend `vite.config.ts`, because the Cloudflare Vite plugin rejects the SSR-externals shape Vitest injects.

**Module-mocking pattern** (preserves the runtime-ordered semantics bun:test's `mock.module` had — `vi.doMock` is NOT hoisted, so dynamic-import the target after mocking):

```typescript
import { describe, expect, it, vi } from 'vitest';
import * as realModule from '@/platform/some-module';

const mockFn = vi.fn();
vi.doMock('@/platform/some-module', () => ({
  ...realModule,
  someExport: mockFn,
}));

// Dynamic import so the mock applies. Static imports are hoisted above
// vi.doMock and would bypass it. Prefer vi.mock + vi.hoisted for top-of-file
// mocks if you need static imports; vi.doMock + await import is the most
// direct port of the bun:test pattern.
const { thingUnderTest } = await import('./thing-under-test');
```

When re-mocking inside an `it()` block to test a different code path, call `vi.resetModules()` first — otherwise the dynamic import returns the cached module from the prior mock.

**Local HTTPS (optional).** Ports 3000–3009 are reserved for `bun dev` worktrees. Each laptop keeps a private hostname map at `~/.openstory/dev-tunnels.json` (not git). `bun tunnel:provision` uses `wrangler login` (no API token) to allocate ten random `*.openstory.so` names on a named tunnel (ingress `127.0.0.1:3000`…`:3009`) and prints Google OAuth redirect URIs to add by hand. DNS may need a one-time `cloudflared tunnel login` (also browser, not an API key). `bun dev` sets `VITE_APP_URL` from that file for the worktree's `PORT`. Press `t + Enter` **once** on the machine to connect the named tunnel. E2E uses port **3020** so it never collides. Details: `docs/developer-guide/local-dev-tunnels.md`.

**E2E:** Playwright drives `vite dev` (cf-plugin → Workerd) on port 3020 with `E2E_TEST=true`. `bun test:e2e:setup` applies D1 migrations against the isolated `[env.test]` block in `wrangler.jsonc` and seeds via `getPlatformProxy()`. Aimock (`:4010`) intercepts LLM/fal calls. R2 is NOT mocked: uploads do real puts into the local Miniflare R2 binding (asset bytes come from durable `assets.openstory.so/e2e/…` URLs that `scripts/mirror-e2e-fixture-media.ts` vendors after every record — provider CDNs like `fal.media` / `imgen.x.ai` expire) and reads are served by the worker's `/r2/$` route. Recording (`E2E_RECORD=1`) hits real LLM/fal then mirrors; locally-served URLs sent to real providers are made fetchable via `fal.storage.upload` / data-URIs (`src/platform/server/storage/external-url.ts`). `src/platform/e2e-recorded-fixture-media.test.ts` fails if a fixture still points at a provider host.

## Platform & Deployment

Production target: **Cloudflare Workers** (the only supported platform). Deployment-context helpers (preview/local detection) live in `src/platform/server/env/environment.ts`. Workers Builds auto-deploys main (same mechanism as Deploy-button clones); PRs get GitHub Actions preview deployments with unique D1 databases. See `.env.example` for required vars (or `bun setup` for local defaults).

<!-- intent-skills:start -->

## Skill Loading

Before editing files for a substantial task:

- Run `bunx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->
