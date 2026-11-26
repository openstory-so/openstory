# Run your install on one OpenStory key

An install with `OPENSTORY_API_KEY` set runs every provider it has no key for on openstory.so. That organization's credits pay; your install charges nothing and needs no balance of its own.

## Set it up

- **Local:** `bun setup` asks for it first. Pick "Sign in to https://openstory.so" (the same sign-in as `npx @openstory/cli@latest login`, and it reuses a key that command already saved) or paste an `osk_` key from Settings → API keys.
- **Deployed:** `wrangler secret put OPENSTORY_API_KEY`. That is the only AI secret a Deploy-button clone needs for what runs remotely.
- `OPENSTORY_GATEWAY_URL` points at another OpenStory (default `https://openstory.so`).

A provider key you set (`FAL_KEY`, `XAI_API_KEY`, …) still wins for its provider, and an organization key in Settings still wins over both.

## What runs on it today

- Grok stills and sheets with no reference images.
- Video clips (sequence and studio) and Models page runs whose model the hosted card can price (Grok video, the fal Kling and Seedance models in `docs/architecture/model-gateway.md` § Holdable today).
- LLM calls with text and structured output: scene split and shot specs, music prompts, character voices, location matching, auto style, content softening, dialogue fitting, prompt shortening, duration estimates and style suggestions.

## What still needs a key here

- LLM calls that use tools or images: script enhancement (web search), the assistant, upload and element descriptions, talent vision, Studio prompt drafts with references, and watch_clip. They need an OpenRouter or fal key; without one they are refused with that message.
- Voices, dialogue and ElevenLabs music: `ELEVENLABS_API_KEY`.
- fal Flux, Seedream and Nano Banana stills: `FAL_KEY`. Gemini stills: a Google key.

When openstory.so refuses a call (no credits, a model it cannot price, a real person in an input), you see that error. Your install never retries it on another key. The reasons and the plan are in [model-gateway.md § Self-hosted on one key](../architecture/model-gateway.md#self-hosted-on-one-key-2438).
