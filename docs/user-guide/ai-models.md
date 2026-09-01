---
title: AI Models
description: Complete reference of all AI models available in OpenStory
section: User Guide
order: 12
---

OpenStory integrates with a wide range of AI models across four categories: script analysis, image generation, motion/video generation, and music/audio generation. All media models are accessed via [Fal.ai](https://fal.ai), while script analysis uses [OpenRouter](https://openrouter.ai).

## Script Analysis Models

These LLM models analyze your script, extract scenes, characters, and locations, and generate prompts. You can select multiple models to generate parallel sequences for comparison. Next to **Generate**, **Turbo** is the default (Luna, Nano Banana 2 Lite, MiniMax H3 Max, ElevenLabs). **Quality** selects the quality-ranked defaults. Both modes show the full catalog, grouped Fast / Quality.

| Model              | Vendor    | Context Window | License                   |
| ------------------ | --------- | -------------- | ------------------------- |
| **GPT-5.6 Luna**   | OpenAI    | 1M tokens      | Proprietary (default)     |
| Claude Fable 5     | Anthropic | 1M tokens      | Proprietary               |
| Claude Opus 5      | Anthropic | 1M tokens      | Proprietary               |
| Claude Opus 5 Fast | Anthropic | 1M tokens      | Proprietary (scene-split) |
| Gemini 3.7 Flash   | Google    | 1M tokens      | Proprietary               |
| Gemini 3.1 Pro     | Google    | 1M tokens      | Proprietary               |
| GPT-5.6 Sol        | OpenAI    | 1M tokens      | Proprietary               |
| GLM-5.3 Flash      | Z.ai      | 1M tokens      | Open Weight (MIT)         |
| GPT-5.6 Terra      | OpenAI    | 1M tokens      | Proprietary               |
| DeepSeek V4 Pro    | DeepSeek  | 1M tokens      | Open Weight (MIT)         |
| Claude Sonnet 5    | Anthropic | 1M tokens      | Proprietary               |
| Grok 4.6           | SpaceXAI  | 500K tokens    | Proprietary               |
| Mistral Small 4    | Mistral   | 262K tokens    | Open Weight (Apache 2.0)  |
| Seed 2.0 Mini      | ByteDance | 262K tokens    | Proprietary               |

## Image Generation Models

These models create the visual images for each scene. You can select multiple models to generate variant images for comparison.

| Model                      | Vendor            | License                  | Notes                                                     |
| -------------------------- | ----------------- | ------------------------ | --------------------------------------------------------- |
| **Nano Banana 2 Lite**     | Google            | Proprietary              | Turbo default — fastest Google tier, references, fixed 1K |
| GPT Image 2                | OpenAI            | Proprietary              | Quality default — text rendering, UI fidelity, up to 4K   |
| Nano Banana 2              | Google            | Proprietary              | Fast generation and editing                               |
| Nano Banana Pro            | Google            | Proprietary              | Enhanced realism and typography                           |
| Grok Imagine Image 2.0     | SpaceXAI          | Proprietary              | Newest Imagine image model, 1K/2K, edit up to 3 refs      |
| Grok Imagine Image Quality | SpaceXAI          | Proprietary              | Quality Mode — higher fidelity, stronger text             |
| FLUX.2 Max                 | Black Forest Labs | Proprietary              | Exceptional realism                                       |
| Phota                      | Phota             | Proprietary              | Character consistency via profiles                        |
| Hunyuan Image v3           | Tencent           | Open Weight              | Strong composition                                        |
| FLUX.2 Dev                 | Black Forest Labs | Open Weight              | 32B open weights with native editing                      |
| Qwen Image 2 Pro           | Alibaba           | Open Weight (Apache 2.0) | Native 2K, text rendering                                 |
| HiDream I1                 | HiDream           | Open Weight (MIT)        | 17B parameters                                            |
| Seedream 5.0 Pro           | ByteDance         | Proprietary              | Flagship generation and editing                           |
| FLUX.2 Flash               | Black Forest Labs | Open Weight              | Cheapest distilled FLUX.2 — sub-second, edit up to 4 refs |
| FLUX.2 Turbo               | Black Forest Labs | Open Weight              | Distilled FLUX.2 — ~2s, edit up to 4 refs                 |

### Edit Endpoints

Most image models support **reference image editing** via dedicated edit endpoints. This allows the AI to use character and location reference images when generating scenes, improving visual consistency.

## Motion/Video Models

These models animate still images into video clips.

| Model                  | Vendor     | Est. Time | License     | Notes                                       |
| ---------------------- | ---------- | --------- | ----------- | ------------------------------------------- |
| **MiniMax H3 Max**     | MiniMax    | ~10s      | Proprietary | Turbo default; native audio                 |
| **Seedance 2.0**       | ByteDance  | ~3.5 min  | Proprietary | Quality default; native audio               |
| Grok Imagine Video 1.5 | SpaceXAI   | ~30s      | Proprietary | Highest quality ranking                     |
| LTX 2.3 Pro            | Lightricks | ~2 min    | Open Weight |                                             |
| Veo 3.1                | Google     | ~2.5 min  | Proprietary | 20K max prompt length                       |
| MiniMax Hailuo 2.3     | MiniMax    | ~3 min    | Proprietary | In the Turbo picker; Seedance-class latency |
| Kling v3 Pro           | Kling      | ~5 min    | Proprietary |                                             |

### Aspect Ratio Compatibility

Not all motion models support all aspect ratios. OpenStory automatically filters to show only compatible models and will switch to a compatible default if your current model doesn't support the selected ratio.

### Audio Support

Some motion models can generate audio alongside video. OpenStory checks each model's capabilities to determine audio support.

## Music & Audio Models

| Model                | Vendor     | Max Duration  | Type  | License               |
| -------------------- | ---------- | ------------- | ----- | --------------------- |
| **ElevenLabs Music** | ElevenLabs | 600s (10 min) | Music | Proprietary (default) |
| ACE-Step 1.5         | ACE Studio | 600s (10 min) | Music | Open Weight           |
| ACE-Step             | ACE Studio | 240s (4 min)  | Music | Open Weight           |

### Music vs. Sound Effects

Music models generate background music tracks from text prompts and optional tags.

### Capabilities

| Feature        | ElevenLabs Music | ACE-Step 1.5 | ACE-Step    |
| -------------- | ---------------- | ------------ | ----------- |
| Prompt-based   | Yes              | Yes          | Yes         |
| Lyrics support | No               | Yes          | Yes         |
| Instrumental   | Yes              | Yes          | Yes         |
| Long-form      | Yes (10 min)     | Yes (10 min) | Yes (4 min) |
