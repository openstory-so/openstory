---
name: update-model-versions
description: >
  Check whether newer versions of the AI models we already use (fal.ai image,
  video/motion, audio; BytePlus Ark ids; OpenRouter text) have shipped, and
  open a PR bumping any genuine successor. Use when asked to "check for model
  updates", "are our models current", "bump models", or when run by the daily
  model-freshness routine. Only bumps EXISTING models to a newer version of
  the same model — it does not add net-new models. npm dependency bumps
  (including @tanstack/ai*) are out of scope: Dependabot owns those.
---

# Update model versions

Our model registries are the single source of truth:

| Class                   | File                          | Export                   |
| ----------------------- | ----------------------------- | ------------------------ |
| Text (OpenRouter)       | `src/lib/ai/models.config.ts` | `SCRIPT_ANALYSIS_MODELS` |
| Image (fal.ai)          | `src/lib/ai/models.ts`        | `IMAGE_MODELS`           |
| Video / motion (fal.ai) | `src/lib/ai/models.ts`        | `IMAGE_TO_VIDEO_MODELS`  |
| Audio (fal.ai)          | `src/lib/ai/models.ts`        | `AUDIO_MODELS`           |
| BytePlus Ark ids        | `src/lib/ai/models.ts`        | `byteplusId` fields      |

A model with a native BytePlus route (#1157) carries **two ids under one
key**: the fal endpoint `id` AND a `byteplusId` (Ark model id). A version bump
must move BOTH — bumping only the fal id silently routes Ark traffic to the
older model (and vice versa), and the pricing alias
(`applyBytePlusRouteAliases`) would quote the wrong rate for whichever id was
left behind.

The goal each run: detect newer versions → verify each is a real successor →
open a focused PR that bumps it → leave everything green.

**npm dependencies are out of scope.** Bumping `@tanstack/ai*` (or any other npm
package) is Dependabot's job, not this routine's — the detector no longer checks
the npm registry. Don't open model-freshness PRs or issues for package versions.

## 1. Detect candidates

```bash
bun models:check          # human-readable report
bun models:check --json   # { ok, errorCount, hasUpdates, models[] }
```

`scripts/check-model-updates.ts` reads the registries and queries public,
unauthenticated catalogs (fal.ai `/api/models`, OpenRouter `/api/v1/models`).
BytePlus Ark ids are checked **offline** against the installed
`@tanstack/ai-byteplus` model catalog — Ark publishes no unauthenticated
catalog, so the adapter's lists are the freshness source. Everything else is
HTTP-only so it runs anywhere — no `FAL_KEY` or MCP needed.
Behind a proxy it routes through `curl` (Bun's fetch can't traverse a
TLS-intercepting proxy), so `curl` must be on PATH in that case.

Candidates are **heuristic** (same brand, higher version number, same modality,
not already adopted). Treat them as leads to verify, not facts.

**Check `ok` before trusting the result.** `ok: false` (equivalently, a non-zero
exit code or `errorCount > 0`) means one or more lookups FAILED — the report is
INCOMPLETE, not "all current". Do not treat a failed run as "nothing to do":
fix connectivity and re-run. Only when `ok` is `true` does `hasUpdates: false`
genuinely mean every model is current — in that case, stop.

## 2. Verify each candidate is a genuine successor

Do not bump on the heuristic alone. For each flagged candidate decide: _is this
the same model, one version newer — or a different product line / tier?_

**fal models — prefer the fal tooling (richest signal):**

- **genmedia CLI** (what the fal community skills use; works headless):
  ```bash
  curl https://genmedia.sh/install -fsS | bash   # once, if missing
  genmedia setup --non-interactive --api-key "$FAL_KEY"
  genmedia models --endpoint_id <candidate-id> --json   # confirm it exists
  genmedia schema  <candidate-id> --json                # compare input params
  genmedia pricing <candidate-id> --json                # cost delta
  ```
- **fal-ai MCP** if available in this session: `search_models`,
  `get_model_schema`, `get_pricing` give the same data.
- **Fallback (zero-auth):** the OpenAPI spec — a 200 means the endpoint is real:
  `curl -s -o /dev/null -w "%{http_code}" "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>"`,
  and `https://fal.ai/models/<path>/llms.txt` for param specs (see CLAUDE.md).

**text models:** confirm the candidate id resolves on
`https://openrouter.ai/api/v1/models` and keeps the same tier (don't turn a
`-mini` into a non-mini, or a `pro` into `flash`).

**BytePlus Ark ids:** verify against the live ModelArk docs
(`docs.byteplus.com/en/docs/ModelArk/…`) plus the installed adapter's
`model-meta` (its JSDoc records doc-vs-reality findings, e.g. per-model
resolution tiers). Ark ids end in a `yymmdd` snapshot date; tier suffixes
(`-fast`, `-mini`, `-lite`, `-pro`) are different products, not successors.
Two Ark-specific gotchas: a new model answers **404 ModelNotOpen until
activated in the Ark console** (verify at request time, not startup), and
resolution tiers are per-model AND per-tier priced — the adapter's model-meta
and BytePlus's own pricing page have disagreed about which tiers exist (e.g.
Seedance 2.5's 1080p), so check the official rate table
(`docs.byteplus.com/en/docs/ModelArk/1544106`) for the tier the request
builders ask for, and confirm the rate-card entry matches THAT tier's price.

**Reject a candidate when** it is a different tier/variant (fast/lite/standard
vs pro, lora/trainer/edit gear), a different modality, a preview/experimental
build replacing a stable one, or its schema/pricing changed so much it needs
product judgement. When unsure, skip it and note it in the PR body rather than
guessing.

## 3. Apply the bump (one PR per upgrade)

Work one upgrade at a time so each PR is reviewable and revertible.

**Idempotency — check first:** `gh pr list --state open --search "in:title model"`.
If an open PR or branch already covers this exact bump, skip it. Branch name:
`auto/model-update-<registry-key>-<new-version>` (e.g.
`auto/model-update-minimax_hailuo_02-2.3`).

**Golden rule: change the `id` (and metadata), never the registry KEY.** Keys
are persisted in the DB (a team's selected model) and referenced across selectors
and schemas — renaming one is a breaking migration, out of scope here.

Per class, edit and follow through:

- **Text** (`models.config.ts`): update `id`, `name`, `description`,
  `contextWindow`. If you bump `DEFAULT_ANALYSIS_MODEL`'s model, the constant
  references a key, so it's unaffected.
  **Catalog-lag bridge:** the `@tanstack/ai-openrouter` adapter ships a codegen
  snapshot of OpenRouter's model list that lags new releases, so a freshly
  shipped id may not be in its typed union yet. When a text-model bump adopts an
  id the installed catalog lacks, `bun typecheck` fails at the `createAdapter`
  call sites — add a `createModel` entry for the id to `CATALOG_LAG_MODELS`
  (`src/lib/ai/create-adapter.ts`) with the correct `input` modalities, plus
  `features: ['reasoning', 'structured_outputs']` when the model supports them.
  (The reverse — pruning a bridged id once the adapter package catches up — is
  handled by Dependabot's package bump, guided by `catalog-lag.test.ts`, not by
  this routine.)
- **Image** (`models.ts` `IMAGE_MODELS`): update `id`, `name`, `description`,
  `maxPromptLength`. If the model has an `EDIT_ENDPOINTS` entry, update that
  endpoint id too. Confirm the new endpoint still supports the edit/reference
  flow if it had one.
- **Video / motion** (`models.ts` `IMAGE_TO_VIDEO_MODELS`): update `id` + meta,
  then regenerate the schemas — **`bun motion:codegen`** (writes
  `src/lib/motion/generated/**` and `endpoint-map.ts`). Never hand-write motion
  schemas. Re-check `maxPromptLength` against the new schema.
- **Audio** (`models.ts` `AUDIO_MODELS`): update `id` + `capabilities`
  (durations, formats) from the new schema.
- **BytePlus-routed models** (a `byteplusId` on the entry): bump the
  `byteplusId` in the same PR as the fal id — never one without the other.
  Then follow through:
  - `src/lib/ai/byteplus-pricing.ts` — the rate card is keyed by Ark model id,
    so the old id's entry must be replaced with the new id at the new model's
    advertised rate (BytePlus publishes no pricing API; read the pricing page,
    re-date the header comment, and note the rate is advertised-not-verified).
    A missed rename means Ark generations bill $0 — exactly the #1069 failure
    mode the card exists to prevent.
  - `src/lib/ai/fal-cost.ts` `ENDPOINT_STRATEGY` — if the old fal endpoint ids
    appear there (token-billed Seedance endpoints do), rename them too.
  - The request builders (`build-byteplus-video-request.ts` /
    `build-byteplus-image-request.ts`) read the id from the registry, but
    re-check their baked-in assumptions (resolution tier, watermark default,
    frame-vs-reference roles) against the new model's docs.
  - e2e fixtures live under a fal-endpoint-keyed dir and each fixture's
    `match.model` is the fal endpoint id, which aimock matches on — migrate
    them (rename dir + edit `match.model`) rather than re-recording when the
    prompt is unchanged.
- **fal pricing:** model ids are pricing keys in `src/lib/ai/fal-pricing-data.ts`
  (auto-generated). After any fal id change run **`bun scripts/update-fal-pricing.ts`**
  (needs `FAL_KEY`). If it can't run, add the new id's pricing manually via the
  override path documented in that script and flag it in the PR.

## 4. Quality gates (must pass before opening the PR)

```bash
bun typecheck
bun lint
bun run test src/lib/ai src/lib/motion   # registry + motion suites
bun run test src/lib/billing             # pricing/cost if fal pricing changed
```

Fix anything that breaks. If a bump cascades into non-trivial changes (schema
shape changed, pricing model differs, tests need rework), stop and open an
**issue** describing it instead of forcing a half-working PR.

## 5. Open the PR

```bash
git checkout -b auto/model-update-<key>-<version>
git commit -am "chore(models): bump <name> <old> → <new>"
gh pr create --title "chore(models): bump <name> <old> → <new>" --body "<body>"
```

PR body must include, per change: registry key, old id → new id, why it's a
genuine successor, links (fal model page / OpenRouter), pricing delta, and
which generated files / pricing were regenerated. End with: "🤖 Opened by the
daily model-freshness routine (#792). Verify pricing & quality before merge."

Leave PRs as **draft** only if a quality gate is amber (e.g. pricing couldn't be
auto-fetched); otherwise ready-for-review. Do not merge — a human reviews.
