# Direct Model Access — Plan (#458 umbrella)

> **As shipped (2026-07-15):** this is the historical plan; the code is the contract. Notable
> divergences: the DB activity enum is `image | video | audio` only (no `chat`); the list fn is
> `listCatalogModelFamiliesFn` (family-grouped, not flat); and completed runs currently charge
> **nothing** (`costMicros` stays null) — the raw queue client cannot provide `usage.unitsBilled`
> metering, and real charging is deferred to a follow-up PR. The `requireCredits` pre-flight gate
> is the only billing control.

## Vision

A new **Models** surface in openstory: browse the full fal.ai catalog (~1,400 models, live from
modelschemas.com), open any model, get an **auto-generated parameter form from its live JSON
Schema**, run it through the existing durable generation engine (credits/BYOK/R2), and keep the
result as an **individual team asset** decoupled from the sequence→scene→shot→frame graph.

## Research conclusions (4 scouts)

- **modelschemas.com** (sibling repo, live Cloudflare service, same author) is the catalog +
  schema backbone: `GET /v1/models?provider=fal&activity=image|video|audio` for the catalog,
  `GET /v1/schemas/fal/{activity}/{endpointId}?kind=input` for a self-contained JSON Schema per
  endpoint ($refs inlined into $defs). **Fetch schemas per-endpoint** — the bulk activity map
  returns empty for fal (too large). fal `pricing`/`modalities` are **null** in modelschemas —
  don't depend on them. Anonymous rate limit 60/h/IP; `MODELSCHEMAS_API_KEY` (optional env)
  lifts to 5k/h.
- **openfield** (`/Users/tom/code/openfield`) already built this feature on Convex/Node. Port the
  _logic_, not the infra: `src/lib/schema-to-spec.ts` (field heuristics),
  `src/lib/output-schema-to-spec.ts` (result/media detection), `src/lib/fal-client.ts`
  ($ref resolver + `z.fromJSONSchema` validation), `src/components/form-fields/index.tsx` +
  `result-fields/index.tsx` (widget registries — restyle to shadcn/ui, drop the `@json-render`
  dependency), `src/lib/model-grouping.ts` (family dedup, pure fns).
- **modelschemas repo `examples/schema-studio/src/components/SchemaForm.tsx`** (~600 lines) is a
  second, dependency-free reference for a recursive JSON-Schema→form renderer
  (enum≤6→chips, bool→toggle, min+max number→slider, oneOf→variant tabs, $ref resolution,
  depth-cap→raw-JSON escape hatch). Its helpers: `src/lib/jsonschema.ts`.
- **TanStack AI codemode** (`/Users/tom/code/TanStack/ai`, `examples/ts-code-mode-web`)
  confirms the safe generative-UI shape: **closed component registry + typed JSON, never
  LLM-emitted code in the DOM**. For v1 the form is deterministic (schema→widget registry).
  The LLM layers (openfield's `schema-rules.ts` cross-field visibility; intent→model chat) are
  a later phase.
- **openstory today**: generation engine fully reusable (`@tanstack/ai-fal` adapters, Cloudflare
  Workflows, R2 origin-relative URLs #894, `requireCredits` + BYOK via
  `scopedDb.apiKeys.resolveKey('fal')`), but every output row is sequence-anchored. Needs a new
  flat `generated_assets` table. Zod is v4 (`z.fromJSONSchema` available). Nav slot:
  `navLinks` in `src/components/layout/app-sidebar.tsx`.

## Architecture decisions

1. **Catalog source: modelschemas HTTP API at runtime** (self-updating model list; no repo
   change to get new models). Server-side fetch inside server fns; client caches via TanStack
   Query. Read `MODELSCHEMAS_API_KEY` from env when present (optional; also add to
   `.env.example`). Base URL `https://modelschemas.com` behind a const.
2. **Deterministic schema→form** (no LLM, no sandbox, no new deps): recursive renderer over the
   JSON Schema with a shadcn widget registry. LLM enhancement = phase 3, out of v1 scope.
3. **Server-side validation** with `z.fromJSONSchema(inputSchema).safeParse(input)` before any
   credit spend / workflow trigger.
4. **Execution reuses the house pattern**: server fn (auth → validate → `requireCredits` →
   insert `generated_assets` row) → `triggerWorkflow('/asset', …)` → new
   `AssetGenerationWorkflow` runs the fal call via the queue, uploads outputs to R2
   (origin-relative `/r2/<key>`), flips the row to completed/failed. Status via polling server fn
   (realtime channel = follow-up).
5. **Cost preflight**: BYOK fal key ⇒ `requireCredits` self-skips. Platform key ⇒ conservative
   flat estimate per activity (image 10¢, video 100¢, audio 25¢ in micros) since fal pricing
   is unavailable per-model; exact deduction post-gen from `usage.unitsBilled` where the
   adapter reports it (match how image-generation.ts does it).

## Contracts (interfaces every agent builds against)

### DB: `generated_assets` (Agent A owns)

`src/lib/db/schema/generated-assets.ts`, exported from schema `index.ts`. CREATE-only additive
migration via `bun db:generate` (NEVER hand-written SQL). ULID pk. FKs use `'restrict'`/no
action — **no ON DELETE CASCADE** (D1 table-rebuild trap).

Columns: `id`, `teamId`, `userId`, `provider` ('fal'), `endpointId` (e.g. `fal-ai/flux-1/dev`),
`activity` ('image'|'video'|'audio'|'chat'|…), `modelName` (display), `input` (typed JSON —
`Record<string, JsonValue>` with a proper local `JsonValue` type, NOT `unknown`),
`status` ('queued'|'running'|'completed'|'failed'), `outputs` (typed JSON array:
`{ url: string; contentType: string }[]`, url is origin-relative R2), `error` text nullable,
`workflowRunId` text nullable, `costMicros` integer nullable, `createdAt`/`updatedAt`.

### Server fns: `src/functions/model-assets.ts` (Agent A owns)

- `createGeneratedAssetFn({ endpointId, activity, modelName, input, inputSchema })` →
  `{ id, workflowRunId }`. Steps: auth (team member) → `z.fromJSONSchema(inputSchema)`
  safeParse (schema re-fetched server-side via catalog lib — do NOT trust a client-sent schema
  for validation; client may send it only for display) → `requireCredits` → insert row →
  `triggerWorkflow('/asset', payload)` → update row with workflowRunId.
- `listGeneratedAssetsFn({ activity?, endpointId?, limit?, cursor? })` → team-scoped newest-first.
- `getGeneratedAssetFn({ id })` → single row (poll target).

### Workflow (Agent A owns)

`src/lib/workflows/asset-generation-workflow.ts`, class `AssetGenerationWorkflow` extends
`OpenStoryWorkflowEntrypoint`. Payload: `{ userId, teamId, assetId, endpointId, activity,
input }`. Wire in all 3 places (wrangler.jsonc `workflows[]` binding `ASSET_WORKFLOW`,
`src/server.ts` re-export, `TRIGGER_TO_BINDING['/asset']`) — `wiring-consistency.test.ts`
enforces. Follow the existing image/motion workflow structure for fal key resolution, fal queue
call, R2 upload, cost deduction, failure handling. Steps write the row status transitions.

### Catalog lib: `src/lib/models/catalog.ts` + `src/functions/model-catalog.ts` (Agent B owns)

- `listCatalogModels({ activity?, q?, cursor?, limit? })` → modelschemas `/v1/models` (provider
  fal), returns `{ models: CatalogModel[], nextCursor? }`. `CatalogModel`: `endpointId`,
  `displayName`, `activity`, `thumbnailUrl?`, `tags?`, `category?`.
- `getModelDetail(endpointId, activity)` → metadata + **input JSON Schema**
  (`/v1/schemas/fal/{activity}/{endpointId}?kind=input`) + output schema (`kind=output`, nullable).
- Server fns wrap these: `listCatalogModelsFn`, `getModelDetailFn`. Type the modelschemas
  responses properly (no `unknown`).

### UI (Agent B: catalog page + nav; Agent C: SchemaForm + detail page)

- `src/routes/_app/models/index.tsx` — catalog: search box, activity filter pills
  (image/video/audio), card grid (thumbnail, name, activity badge), URL-reflected filters,
  Suspense + Skeletons, virtualized/paginated. Links to detail.
- `src/routes/_app/models/$.tsx` — **splat route** (endpoint ids contain slashes).
  Detail: model header, `<SchemaForm />` from input schema, Run button
  (`createGeneratedAssetFn` mutation), status polling (`getGeneratedAssetFn` via
  `refetchInterval`), result media display, "recent runs" list for this endpoint.
- `src/components/schema-form/` — `<SchemaForm schema value onChange onSubmit />` recursive
  renderer + widget registry (shadcn only, Tailwind layout-only). Heuristics per openfield +
  schema-studio (see research conclusions). Honor `x-fal-order-properties`, `required`-first,
  optional fields behind "+ field" chips, oneOf/anyOf tabs, depth-cap raw-JSON fallback.
- `src/components/schema-form/asset-result.tsx` — output renderer: detect image/video/audio
  fields by name+shape → media components; else JSON view.
- Sidebar: add "Models" to `navLinks` in `app-sidebar.tsx`.

## Phases

1. **Parallel build** — Agent A (backend: table+migration+server fns+workflow+tests) in
   worktree `openstory-458-backend`; Agent B (catalog lib+server fns+catalog page+nav) in
   worktree `openstory-458-catalog`. Regular commits.
2. **Integrate** — merge both branches into `458-direct-model-access`
   (worktree `openstory-458`); Agent C builds SchemaForm + model detail page + run/poll/result
   loop on the merged branch; integration fixes; full gates.
3. **Follow-ups (not v1)**: LLM schema-rules (cross-field visibility via `@tanstack/ai`
   outputSchema), intent→model chat, realtime status channel, model popularity/quality ranking,
   pricing surface, save-asset-into-library flows.

## Repo rules digest (binding for all agents)

- Work ONLY inside your assigned worktree. Never touch /Users/tom/code/openstory (main checkout).
- `bun install` first. Gates: `bun lint`, `bun typecheck`, `bun run test` (NOT `bun test`),
  `bun dead-code` (knip runs pre-commit; every new export needs a consumer or the commit fails —
  wire consumers in the same commit).
- Commit regularly with clear messages; lefthook runs lint/format/typecheck/knip on commit.
  End commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do NOT push.
- No `any`/`unknown`/`Record<string, unknown>`; no non-null assertions; typedEntries/
  typedFromEntries from `@/shared/utils/typed-object` instead of Object.entries/fromEntries.
- DB access only in server handlers/services — never components. ULID pks. Migrations only via
  `bun db:generate`.
- React: TanStack Query + Suspense (no isLoading), shadcn base components, Tailwind layout-only,
  no margins (gap on parent), kebab-case files, named exports, URL-reflected state,
  keyboard/a11y per CLAUDE.md non-negotiables.
- New routes: regenerate `src/routeTree.gen.ts` (run `bun dev` briefly, or the router codegen)
  and commit it.
- Unit tests: Vitest, `vi.doMock` + dynamic import pattern per CLAUDE.md; mock `#db-client`.
