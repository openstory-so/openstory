# Native Grok (xAI)

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
