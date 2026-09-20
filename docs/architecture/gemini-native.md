# Native Google (Gemini)

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
