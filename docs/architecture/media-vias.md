# Media vias: fal, Google, xAI, LLMTR

The per-via reference for the vias that are not BytePlus (`byteplus-ark.md`) or ElevenLabs (`elevenlabs.md`). The rules that hold for every via are in `AGENTS.md` → Media vias.

## Prompt length (#1754)

**Prompts are never truncated.** What the user wrote is what goes out, on every via and both media kinds. Everything downstream — the studio DB row's `input` JSON, the `gen_ai.input.messages` on OTel/PostHog, and the compliance `promptSha256` in `src/platform/server/compliance/provenance.ts` — therefore describes the prompt the provider actually received.

`IMAGE_MODELS[m].maxPromptLength` / `IMAGE_TO_VIDEO_MODELS[m].maxPromptLength` is a **recommendation**, not a gate. Over it earns a structured warning (`warnLongPrompt`, event `prompt_over_recommended_length`) and a `length / recommendation` counter next to the prompt in studio and in the sequences prompt panel — amber, never a block.

A **hard** ceiling is declared separately, and only where a via documents and enforces one:

- `enforcesPromptLimit: true` in `src/models/models.ts` — Grok 4096 (xAI answers 400 `Prompt length exceeds the maximum allowed length of 4096`), Kling, Omni Flash, H3 Max (fal's schemas). The flag says the model's `maxPromptLength` is enforced; read it through `videoPromptHardLimit(model)`, which returns the number only for those, never `maxPromptLength` directly.
- a fal endpoint schema's `prompt.maxLength`, asserted inside `motionTransform`. A packed Kling job ships `multi_prompt[]` and its `prompt` is dropped, so `promptForSchema` hands the assert the longest element — the string fal actually length-checks — never the combined text.

Seedance has neither: Ark documents no limit, only a style recommendation ("no more than 500 Chinese characters or 1,000 English words"), and no fal Seedance schema declares `maxLength`. The 4096 we carried was our own number and was quietly cutting prompts. The counter warns above **5,500 characters** — about 1,000 English words — so Seedance uses the same unit as every other model (#1763). `measurePrompt` in `src/models/prompt-length.ts` is the reader, so the counter, the warning and the log all agree. H3 Max's 2500 was invented the same way and is now fal's 50000.

**Native xAI images have no ceiling either.** xAI's docs state none for `grok-imagine-image-2.0`, and fal's schema says 8000 — but `@tanstack/ai-grok`'s `validatePrompt` throws client-side at 4000 with a stale `grok-2-image-1212` message, which is what took every character and location sheet down once the truncation was gone. That check is patched out (`patches/@tanstack%2Fai-grok@0.18.4.patch`, wired through `patchedDependencies`) until upstream drops it. The two Grok image entries carry **no `maxPromptLength` at all** — fal's 8000 is fal's number and Grok never routes through fal — so `maxPromptLength` is optional on `PromptRecommendation`: absent means the counter shows the length alone and nothing warns.

**Audit of the rest (fal `prompt.maxLength`, 2026-09-23):** gpt-image 32000, nano-banana family 50000, krea 5000 are fal's numbers. FLUX.2, HiDream, Hunyuan, Qwen, Seedream (2000) and Phota (8000) have no `maxLength` in fal's schema — those are our own recommendations and only ever turn the counter amber.

Only the hard limit gates clip **packing** (`packedPromptFitsLimit`, which returns true when there is none), so a packed Seedance clip is no longer refused against a limit that does not exist.

**Studio refuses; only sequences shorten.** Studio has no prompt-version history, so a rewrite there would be an edit the user never sees — the thing #1754 removed. Past a ceiling the via enforces, the composer turns the counter red (`12588 / 4096`) and a Generate click opens a dialog naming both numbers; `buildStudioVideoInput` asserts the same limit as the backstop so a bypass reads our wording, not fal's 400.

**When a hard limit really refuses** in sequence generation, the motion workflow recovers rather than cutting: `isPromptTooLongError` classifies our own `PromptTooLongError` and the provider's 422 alike, `shortenOverlongMotionPrompt` rewrites the prompt with an LLM under the real budget, and the result is saved as a `shortened` shot prompt version (selected on a primary render, history-only on a variant). The shortening is therefore a visible, revertable edit in Versions, not something that happened inside a request builder. One rewrite per run; a second refusal fails the clip and names both numbers.

## Fal.ai Integration

**Always check `/llms.txt` before updating models.** Machine-readable, authoritative param specs:

```
https://fal.ai/models/{model-path}/llms.txt
# e.g. https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/llms.txt
```

More reliable than HTML docs; essential for `src/models/models.ts`. **For new motion models, run `bun motion:codegen`** to auto-generate schemas — don't write inline.

Motion status checking: `checkMotionStatus(statusUrl)`, `getMotionResult(responseUrl)`, `cancelMotionGeneration(cancelUrl)` from `@/motion/server/motion-generation`, or `bun scripts/check-motion-status.ts <url>`.

**Pricing is DB-only (#1069).** `model_pricing` in D1 is the **only** pricing record — there is no baked-in seed. The daily cron (and `bun scripts/refresh-fal-pricing.ts` locally, needs `FAL_KEY`) fills it with unit prices for **every priced endpoint in fal's catalog** (~1,350; raw unit strings, batches of ≤50 — the pricing API's cap), plus fal's typical-units estimates for the endpoints we actually use and observed medians from our own generations. `bun dev` never fires `scheduled()`, so until the script runs locally the table is empty: estimates gate on the $0.10 floor and billing records $0 (reported via `reportMissingBillingCost`).

**The pricing API can lie — fal's bill is the ground truth.** fal's `/v1/models/pricing` reported Grok Imagine at "compute seconds" × $0.00017 while fal actually billed "units" × $0.01 (~59× under-charge; audit found 6 more mispriced endpoints, one 33% OVER-charging). Three corrective layers, all needing the ADMIN-scoped `FAL_BILLING_KEY` (`wrangler secret put` in prod; `.env.local` or `FAL_BILLING_KEY_DEV` locally — without it both crons error-log and prices run unverified): (1) the nightly refresh overlays billed rates from `/v1/models/usage` (30d); (2) `model_pricing.rateVerifiedAt` — once bill-verified, an advertised rate can never overwrite a row, only newer billed data; (3) the **hourly reconcile** (`src/billing/server/reconcile-fal-billing.ts`) audits every charge against per-request `/v1/models/billing-events` (joined by the fal `requestId` workflows store in transaction metadata), corrects rates within the hour, and reports drift (`billing_drift` PostHog event) — report-only, no retroactive ledger adjustments. `x-fal-billable-units` is set by each model's own code (denomination is author-defined), so billing stays `unitsBilled × verified unitPrice` and never interprets units client-side.

**Cron jobs need wiring in three places** (like Workflows): `wrangler.jsonc` `triggers.crons` in the **default** block, the same in **`[env.production]`** (non-inheritable), and the constant `scheduled()` string-matches on (e.g. `FAL_PRICING_CRON`). Drift is silent — an unmatched expression falls through to the 5-minute reconcile sweep, which _succeeds_, so the job just never runs. `src/billing/server/refresh-fal-pricing.test.ts` enforces it.

## Native Google (Gemini)

Same shape as native Grok: Gemini chat (`google/gemini-3.1-pro-preview`,
`google/gemini-3-flash-preview`), **Nano Banana** stills (`nano_banana_2`,
`nano_banana_2_lite`, `nano_banana_pro`), and **Gemini Omni Flash** video
(`gemini_omni_flash`) go to Google's own Gemini API via `@tanstack/ai-gemini`
when a Google key resolves (team `google` key → platform `GEMINI_API_KEY` →
neither, which falls back to OpenRouter/fal unchanged). e2e never sets
`GEMINI_API_KEY`, so fixtures keep exercising the fallback;
`GEMINI_BASE_URL` is the aimock hook for the native path.

`src/models/gemini-native.ts` owns registry id → Gemini model name plus the
pricing, transcribed from ai.google.dev — Google reports tokens, never cost,
so those tables ARE the bill (like xAI, native spend is **unaudited** by the
#1069 drift detection). Omni Flash bills video output as tokens (5,792/s of
720p at the $17.50/1M video-output rate ≈ $0.10/s). Nano Banana stills bill
the advertised per-image equivalent (Lite 1K $0.0336; Flash 1K/2K/4K
$0.067/$0.101/$0.151; Pro 1K/2K $0.134, 4K $0.24). Native ids are
`gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`;
without a Google key the same catalog keys stay on fal
(`fal-ai/nano-banana-2`, `google/nano-banana-2-lite`, `fal-ai/nano-banana-pro`).

Omni Flash serves image-to-video, reference-to-video, and text-to-video from
ONE Interactions-API model (`gemini-omni-1.1-flash`): images ride the
generateVideo prompt as content blocks bound in the prompt text by
`<IMAGE_REF_n>` tags (0-based; ≤7 images; 3–10s; 16:9/9:16 only), and
`buildGeminiVideoRequest` pins the task via
`generation_config.video_config.task` rather than letting the model infer it.
Native submit MUST request `response_format.delivery: "uri"` (and must NOT
pass top-level `duration`/`size` to `generateVideo` — the adapter overwrites
`response_format` when those are set) so Google parks the MP4 on the Files
API instead of inlining a multi-MB `data:` URL. Inline bytes miss Cloudflare
Workflows' 1 MiB `step.do` cap; poll/upload download the Files URI with the
Google key. Without a Google key the same model runs on fal's
`fal-ai/gemini-omni-1.1-flash[/image-to-video|/reference-to-video]` endpoints
(the bare id is fal's text-to-video route, used when a reference-only shot
matched nothing).|/reference-to-video]`endpoints.
Data-URI stills must be decomposed to inline base64 on the native path —
Google won't fetch`data:`as a URI. Chat vision (motion prompts) and
native image refs must also inline stored stills: Google's`fileData.fileUri`HTTP fetch (CDN / fal URLs) sits on a separate quota
that 429s while the same bytes as`inlineData`succeed.`toVisionImageSource(..., { inline: true })` is that path.

## Native Grok (xAI)

Grok chat, image, and video go to `api.x.ai` via `@tanstack/ai-grok` instead of
OpenRouter/fal when an xAI key resolves (team `xai` key → platform
`XAI_API_KEY` → neither, which falls back to the old path unchanged). e2e sets
a mock `XAI_API_KEY` and points `XAI_BASE_URL` at a second aimock instance
(:4011), so Grok replays the native path from `fixtures/recorded/xai`.

`src/models/grok-native.ts` owns registry id → xAI model name plus the pricing,
transcribed from docs.x.ai — the adapter reports a cost for video only. Native
spend bypasses `model_pricing` and the hourly fal reconcile, so it is
**unaudited**: the #1069 drift detection covers none of it.

Two traps: xAI speaks the Responses API, so `resolveNativeGrokModel` is what
keeps `llm-client`'s options object and the adapter agreeing on the route; and
media job ids are via-scoped, so `MotionJobSubmission.via` pins polling to
whoever the job was submitted to.

## LLMTR Gateway

LLMTR (llmtr.com) is a Turkey-hosted, OpenAI-compatible LLM gateway. It
serves Chat Completions **and** Responses at `/v1` (plus an
OpenRouter-shaped `/v1/models` catalog). `createAdapter` drives it with
`openaiCompatibleText` from `@tanstack/ai-openai/compatible` — not the
OpenRouter Speakeasy client, whose chunk schema rejects LLMTR's SSE as
"Response validation failed". Every OpenAI model (and Grok) uses
Responses; posting those to Chat Completions 400s. `llmtrCompatibleApi`
picks the endpoint. UI:
**Settings → API Keys → LLMTR**. Team BYOK only — there is no platform
LLMTR key; without a team key, resolution falls through to OpenRouter/fal.
Keep its API key row last, below OpenRouter.

**LLMTR must not block model upgrades.** If its catalog is unreachable or
support or pricing is unverified, put the upgraded id in
`LLMTR_UNMAPPED_MODEL_IDS` and ship using the existing OpenRouter/fal
resolution. Do not delay the upgrade or keep its PR in draft for LLMTR.
Add its mapping and rates later, once verified; never copy OpenRouter
rates as assumed LLMTR prices.

`src/models/llmtr.ts` pins the two silent-break traps:

- **Slug drift.** LLMTR namespaces some vendors differently (`xai/` not
  `x-ai/`, `zai/` not `z-ai/`, `mistral/` not `mistralai/`). A registry id
  absent from `LLMTR_TEXT_MODELS` is not routable — resolution skips the
  LLMTR key rather than guessing a neighbour. `createAdapter` throws if
  `via: 'llmtr'` meets an unmapped model (do not send that key to
  OpenRouter).
- **Unaudited spend.** LLMTR reports token counts but no per-request
  `cost`, so `llmCostFromUsage` **must** get the resolved `via`. Omit it
  and a Grok-on-LLMTR / Gemini-on-LLMTR call is priced from xAI / Google
  rates; any other LLMTR model bills $0. Pass
  `llmCostFromUsage(usage, model, llmKey.via)`. This spend bypasses
  `model_pricing` and the #1069 fal reconcile. Re-read
  https://llmtr.com/v1/models when the registry changes.
- **Native wire names, not OpenRouter plugins.** Do not send
  `openrouter:web_search`, `provider.only` / `requireParameters`, or
  OpenRouter camelCase (`maxTokens`, `streamOptions`) on `via: 'llmtr'`.
  Chat Completions uses `max_tokens` / `reasoning_effort`; Responses uses
  `max_output_tokens` / `reasoning.effort`.

Resolution order (`resolveLlmKey`): native xAI (Grok) → native Google
(Gemini) → **team LLMTR when `llmtrTextModel` maps** → team OpenRouter →
team fal → platform (`OPENROUTER_KEY`, else `FAL_KEY`). A team that adds
an LLMTR key chose that gateway, so it outranks their OpenRouter key. `validateKey` cannot use `/v1/models` — it
is public and answers 200 for a bogus key — so validation is a 1-token
completion on a $0 model and requires `response.ok`.
