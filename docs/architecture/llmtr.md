# LLMTR Gateway

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
